// =====================================================================
// Ingestion 엔진
// - 단독 실행: node src/ingest.js (Express API)
// - n8n 에서 호출할 엔드포인트:
//     POST /ingest/batch     : PaperRef[] 받아 분석·저장
//     POST /ingest/run-daily : 수집부터 저장까지 한 번에 수행
//     GET  /health
// - 모든 단계에 try/catch + ingestion_log 기록.
// =====================================================================

import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import pLimit from 'p-limit';

import { logger, childLogger } from './lib/logger.js';
import { query, toVectorLiteral, ping, close } from './lib/db.js';
import { embedText } from './lib/embedding.js';
import { loadKeywords } from './lib/config.js';
import { searchAll, dedupeKey } from './sources/index.js';

// =====================================================================
// 대시보드 HTML
// =====================================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper Index 대시보드</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 16px; }
  h1 { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
  .subtitle { font-size: 0.75rem; color: #64748b; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
  .card { background: #1e293b; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
  .card h2 { font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
             letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 12px; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
           border-radius: 99px; font-size: 0.75rem; font-weight: 600; margin: 3px; }
  .badge-green  { background: #14532d; color: #86efac; }
  .badge-blue   { background: #1e3a5f; color: #93c5fd; }
  .badge-yellow { background: #713f12; color: #fde68a; }
  .badge-red    { background: #7f1d1d; color: #fca5a5; }
  .badge-gray   { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
  .cost-big { font-size: 2rem; font-weight: 700; color: #34d399; }
  .cost-sub { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
  .batch-row { padding: 8px 0; border-bottom: 1px solid #1e293b; font-size: 0.78rem; }
  .batch-row:last-child { border-bottom: none; }
  .batch-state { font-weight: 600; font-size: 0.7rem; }
  .state-succeeded { color: #34d399; }
  .state-pending   { color: #fbbf24; }
  .state-queued    { color: #60a5fa; }
  .state-running   { color: #a78bfa; }
  .state-failed    { color: #f87171; }
  .error-box { background: #450a0a; border: 1px solid #7f1d1d; border-radius: 8px;
               padding: 10px; font-size: 0.72rem; color: #fca5a5; margin-top: 8px;
               word-break: break-all; }
  .ts { font-size: 0.65rem; color: #475569; margin-top: 16px; text-align: right; }
  .refresh-btn { background: #334155; border: none; color: #94a3b8; padding: 6px 14px;
                 border-radius: 8px; font-size: 0.75rem; cursor: pointer; float: right; }
  .refresh-btn:hover { background: #475569; color: #e2e8f0; }
  .alert-banner { background: #450a0a; border: 1px solid #991b1b; border-radius: 10px;
                  padding: 12px 16px; margin-bottom: 16px; color: #fca5a5;
                  font-size: 0.8rem; display: none; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
  <h1>📄 Paper Index</h1>
  <button class="refresh-btn" onclick="load()">↻ 새로고침</button>
</div>
<div class="subtitle" id="ts">로딩 중...</div>
<div class="alert-banner" id="alert"></div>
<div class="grid" id="grid"></div>

<script>
const STATE_CLASS = {
  JOB_STATE_SUCCEEDED: 'state-succeeded',
  JOB_STATE_FAILED:    'state-failed',
  JOB_STATE_PENDING:   'state-pending',
  JOB_STATE_QUEUED:    'state-queued',
  JOB_STATE_RUNNING:   'state-running',
  PENDING: 'state-pending', RUNNING: 'state-running',
};
const STATUS_BADGE = {
  batch_done:       'badge-green',
  md_ready:         'badge-blue',
  pending:          'badge-blue',
  batch_submitted:  'badge-yellow',
  none:             'badge-gray',
  failed:           'badge-red',
  no_pdf:           'badge-gray',
};
function fmt(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul',
    month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function elapsed(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.round(s/60) + '분 전';
  return Math.round(s/3600) + '시간 전';
}

async function load() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    render(d);
  } catch(e) {
    document.getElementById('ts').textContent = '로드 실패: ' + e.message;
  }
}

function render(d) {
  document.getElementById('ts').textContent = '마지막 갱신: ' + fmt(d.ts);

  // 실패 배너
  const failed = d.batches.filter(b => b.state === 'JOB_STATE_FAILED');
  const alert = document.getElementById('alert');
  if (failed.length) {
    alert.style.display = 'block';
    alert.innerHTML = '⚠️ 실패한 배치 ' + failed.length + '건 — Claude Code에서 확인 필요';
  } else { alert.style.display = 'none'; }

  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  // 논문 상태 카드
  const paperCard = document.createElement('div');
  paperCard.className = 'card';
  const total = d.papers.reduce((s, r) => s + r.cnt, 0);
  paperCard.innerHTML = '<h2>논문 현황 (총 ' + total + '건)</h2>' +
    d.papers.map(r =>
      '<span class="badge ' + (STATUS_BADGE[r.fulltext_status] || 'badge-gray') + '">' +
      r.fulltext_status + ' ' + r.cnt + '</span>'
    ).join('');
  grid.appendChild(paperCard);

  // 비용 카드
  const cost = d.cost || {};
  const costCard = document.createElement('div');
  costCard.className = 'card';
  costCard.innerHTML = '<h2>오늘 API 비용 (UTC)</h2>' +
    '<div class="cost-big">$' + Number(cost.spent_usd || 0).toFixed(4) + '</div>' +
    '<div class="cost-sub">입력 ' + (cost.input_tokens || 0).toLocaleString() +
    ' tok / 출력 ' + (cost.output_tokens || 0).toLocaleString() + ' tok / ' +
    (cost.calls || 0) + '회 호출</div>';
  grid.appendChild(costCard);

  // 배치 잡 카드
  const batchCard = document.createElement('div');
  batchCard.className = 'card';
  batchCard.innerHTML = '<h2>배치 잡 (최근 10건)</h2>' +
    (d.batches.length === 0 ? '<div style="color:#475569;font-size:.8rem">없음</div>' :
    d.batches.map(b => {
      const sc = STATE_CLASS[b.state] || 'state-pending';
      const errs = Array.isArray(b.error_samples) ? b.error_samples : [];
      return '<div class="batch-row">' +
        '<div style="display:flex;justify-content:space-between">' +
        '<span class="batch-state ' + sc + '">' + b.state.replace('JOB_STATE_','') + '</span>' +
        '<span style="color:#64748b;font-size:.65rem">' + elapsed(b.submitted_at) + '</span></div>' +
        '<div style="color:#94a3b8;margin-top:2px">논문 ' + b.request_count + '건' +
        (b.success_count ? ' ✓' + b.success_count : '') +
        (b.fail_count ? ' ✗' + b.fail_count : '') + '</div>' +
        (errs.length ? '<div class="error-box">' + JSON.stringify(errs[0]).slice(0,120) + '</div>' : '') +
        '</div>';
    }).join(''));
  grid.appendChild(batchCard);

  // 실패 논문 카드
  if (d.failedPapers && d.failedPapers.length) {
    const errCard = document.createElement('div');
    errCard.className = 'card';
    errCard.innerHTML = '<h2>최근 실패 논문</h2>' +
      d.failedPapers.map(p =>
        '<div class="batch-row"><div style="font-size:.75rem;color:#cbd5e1">' +
        (p.title || '').slice(0, 60) + '</div>' +
        '<div class="error-box">' + (p.fulltext_error || 'unknown').slice(0,100) + '</div></div>'
      ).join('');
    grid.appendChild(errCard);
  }
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;

// =====================================================================
// 공통 유틸
// =====================================================================
const PaperRefSchema = z.object({
  source:       z.enum(['arxiv', 'semantic_scholar', 'chemrxiv', 'manual']),
  source_id:    z.string().min(1),
  doi:          z.string().optional(),
  arxiv_id:     z.string().optional(),
  title:        z.string().min(1),
  abstract:     z.string().optional().default(''),
  authors:      z.array(z.string()).optional().default([]),
  published_at: z.string().optional(),
  venue:        z.string().optional(),
  url:          z.string().optional(),
  pdf_url:      z.string().optional(),
  citations:    z.number().optional().default(0),
  category_hint:z.string().optional(),
  fullText:     z.string().optional(),   // 선택: 본문 텍스트
});

async function upsertPaper(ref, analysis, embedding) {
  const vec = toVectorLiteral(embedding);
  const params = [
    ref.doi ?? null,
    ref.arxiv_id ?? null,
    ref.source,
    ref.source_id,
    ref.url ?? null,
    ref.pdf_url ?? null,
    ref.title,
    ref.abstract ?? null,
    JSON.stringify(ref.authors ?? []),
    ref.published_at ?? null,
    ref.venue ?? null,
    ref.citations ?? 0,
    analysis.summary_ko ?? null,
    JSON.stringify(analysis.key_findings ?? []),
    JSON.stringify(analysis.materials ?? []),
    JSON.stringify(analysis.techniques ?? []),
    analysis.novelty_score ?? null,
    analysis.relevance_score ?? null,
    analysis.major_category,
    analysis.mid_category ?? null,
    analysis.sub_category ?? null,
    JSON.stringify(analysis.tags ?? []),
    vec,
    JSON.stringify({ source_raw: ref.source }),
    /^https?:\/\/.+/.test(ref.pdf_url ?? '') ? 'pending' : 'no_pdf',
  ];
  // DOI 기준 우선 충돌, 없으면 arxiv_id, 없으면 source+source_id 로.
  const sql = `
    INSERT INTO research_papers
      (doi, arxiv_id, source, source_id, url, pdf_url, title, abstract,
       authors, published_at, venue, citations,
       summary_ko, key_findings, materials, techniques,
       novelty_score, relevance_score,
       major_category, mid_category, sub_category, tags,
       embedding, raw_metadata, fulltext_status)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::vector,$24::jsonb,$25)
    ON CONFLICT (doi) DO UPDATE SET
      title           = EXCLUDED.title,
      abstract        = EXCLUDED.abstract,
      authors         = EXCLUDED.authors,
      venue           = EXCLUDED.venue,
      citations       = EXCLUDED.citations,
      -- 분석 필드: 이미 채워진 값은 보존 (batch 결과가 ingest 재수집으로 지워지는 것 방지)
      summary_ko      = COALESCE(research_papers.summary_ko,      EXCLUDED.summary_ko),
      key_findings    = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.key_findings    ELSE EXCLUDED.key_findings    END,
      materials       = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.materials       ELSE EXCLUDED.materials       END,
      techniques      = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.techniques      ELSE EXCLUDED.techniques      END,
      novelty_score   = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.novelty_score   ELSE EXCLUDED.novelty_score   END,
      relevance_score = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.relevance_score ELSE EXCLUDED.relevance_score END,
      major_category  = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.major_category  ELSE EXCLUDED.major_category  END,
      mid_category    = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.mid_category    ELSE EXCLUDED.mid_category    END,
      sub_category    = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.sub_category    ELSE EXCLUDED.sub_category    END,
      tags            = CASE WHEN research_papers.summary_ko IS NOT NULL THEN research_papers.tags            ELSE EXCLUDED.tags            END,
      embedding       = EXCLUDED.embedding,
      updated_at      = now()
    RETURNING id;
  `;
  const { rows } = await query(sql, params);
  return rows[0]?.id;
}

async function updateCategoryMaster(analysis) {
  const sql = `
    INSERT INTO categories (major_id, mid_label, sub_label, usage_count, last_seen_at)
    VALUES ($1, $2, $3, 1, now())
    ON CONFLICT (major_id, mid_label, sub_label)
    DO UPDATE SET usage_count = categories.usage_count + 1, last_seen_at = now();
  `;
  await query(sql, [
    analysis.major_category,
    analysis.mid_category ?? null,
    analysis.sub_category ?? null,
  ]);
}

// 분석 없이 저장할 때 쓰는 빈 분석 객체 (Batch API가 나중에 채움)
const EMPTY_ANALYSIS = {
  summary_ko: null,
  key_findings: [],
  materials: [],
  techniques: [],
  novelty_score: 0,
  relevance_score: 0,
  major_category: 'misc_semi',
  mid_category: null,
  sub_category: null,
  tags: [],
};

/**
 * DB에 이미 존재하는지 식별자(DOI, Arxiv ID, Source+ID)로 체크.
 */
async function checkExists(ref) {
  const conditions = [];
  const params = [];

  if (ref.doi) {
    params.push(ref.doi);
    conditions.push(`doi = $${params.length}`);
  }
  if (ref.arxiv_id) {
    params.push(ref.arxiv_id);
    conditions.push(`arxiv_id = $${params.length}`);
  }
  // Source + ID 조합도 체크
  params.push(ref.source, ref.source_id);
  conditions.push(`(source = $${params.length - 1} AND source_id = $${params.length})`);

  const sql = `SELECT id FROM research_papers WHERE ${conditions.join(' OR ')} LIMIT 1`;
  const { rows } = await query(sql, params);
  return rows[0]?.id || null;
}

/**
 * 단일 논문 처리: 중복 체크 -> 임베딩(title+abstract) → upsert. 분석은 Batch API에서 비동기 수행.
 */
async function ingestOne(ref, _taxonomy, log) {
  try {
    // 1) DB 존재 여부 먼저 체크 (토큰 아끼기)
    const existingId = await checkExists(ref);
    if (existingId) {
      log.info({ id: existingId, title: ref.title.slice(0, 60) }, 'already exists, skipping embedding');
      return { ok: true, id: existingId, skipped: true };
    }

    // 2) 존재하지 않을 때만 임베딩 API 호출
    const textToEmbed = [ref.title, ref.abstract ?? ''].filter(Boolean).join('\n');
    const embedding = await embedText(textToEmbed, 'RETRIEVAL_DOCUMENT');
    const id = await upsertPaper(ref, EMPTY_ANALYSIS, embedding);
    log.info({ id, title: ref.title.slice(0, 60) }, 'ingested (analysis queued for batch)');
    return { ok: true, id };
  } catch (err) {
    log.error({ err: err?.message, title: ref.title?.slice(0, 60) }, 'ingest 실패');
    return { ok: false, error: err?.message };
  }
}

// =====================================================================
// /ingest/batch : PaperRef 배열 받아 처리
// =====================================================================
async function handleBatch(paperRefs) {
  const log = childLogger({ mod: 'batch' });

  const limit = pLimit(Number(process.env.GEMINI_CONCURRENCY ?? 3));
  const errorSamples = [];

  let ingested = 0;
  let failed   = 0;
  const results = await Promise.all(paperRefs.map((r) =>
    limit(async () => {
      const parsed = PaperRefSchema.safeParse(r);
      if (!parsed.success) {
        failed += 1;
        errorSamples.push({ title: r?.title, error: parsed.error.errors[0]?.message });
        return { ok: false, error: 'validation' };
      }
      const res = await ingestOne(parsed.data, null, log);
      if (res.ok) ingested += 1;
      else { failed += 1; if (errorSamples.length < 5) errorSamples.push({ title: r.title, error: res.error }); }
      return res;
    })
  ));

  return { ingested, failed, total: paperRefs.length, errorSamples, results };
}

// =====================================================================
// /ingest/run-daily : 수집 + 처리까지
// =====================================================================
async function runDaily() {
  const log = childLogger({ mod: 'run-daily' });
  const keywords = await loadKeywords();

  const target = Number(process.env.DAILY_TARGET ?? 300);
  const perSource = Number(process.env.MAX_PER_SOURCE ?? 50);

  // 1) 수집
  const collected = new Map(); // dedupeKey -> ref
  const queries = [...keywords.primary, ...keywords.secondary]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  for (const k of queries) {
    if (collected.size >= target * 1.5) break; // 충분히 모으면 중단
    const refs = await searchAll({ query: k.q, perSource, categoryHint: k.category_hint });
    for (const r of refs) {
      const key = dedupeKey(r);
      if (!collected.has(key)) collected.set(key, r);
      if (collected.size >= target * 1.5) break;
    }
    log.info({ query: k.q, gotNow: refs.length, totalUniq: collected.size }, '수집 중');
  }

  // fresh_probe
  const fresh = keywords.fresh_probe;
  if (fresh?.queries?.length) {
    for (const q of fresh.queries) {
      if (collected.size >= target * 2) break;
      const refs = await searchAll({
        query: q, perSource: fresh.max_results_per_query ?? 20,
        daysWindow: fresh.days_window ?? 14,
      });
      for (const r of refs) {
        const key = dedupeKey(r);
        if (!collected.has(key)) collected.set(key, r);
      }
    }
  }

  // 2) target 개로 컷
  const refs = Array.from(collected.values()).slice(0, target);
  log.info({ count: refs.length }, '수집 완료 -> 분석 시작');

  // 3) ingestion_log 시작 행
  const { rows: [logRow] } = await query(
    `INSERT INTO ingestion_log (source, query, requested, fetched, deduped)
     VALUES ('combined', 'run_daily', $1, $2, $3) RETURNING id, run_id`,
    [target, refs.length, refs.length],
  );

  // 4) 배치 처리
  const batchRes = await handleBatch(refs);

  await query(
    `UPDATE ingestion_log SET ingested=$1, failed=$2, error_samples=$3::jsonb, finished_at=now()
     WHERE id=$4`,
    [batchRes.ingested, batchRes.failed, JSON.stringify(batchRes.errorSamples), logRow.id],
  );

  log.info({ ingested: batchRes.ingested, failed: batchRes.failed }, 'run-daily 완료');
  return { run_id: logRow.run_id, ...batchRes };
}

// =====================================================================
// Express 앱
// =====================================================================
export function buildApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // 간단한 API key 인증 (대시보드·헬스체크는 공개)
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/dashboard' || req.path === '/api/status') return next();
    const expected = process.env.INGEST_API_KEY;
    if (!expected) return next();
    if (req.header('x-api-key') === expected) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/health', async (_req, res) => {
    try {
      const ok = await ping();
      res.json({ ok, gemini_model: process.env.GEMINI_GEN_MODEL ?? 'gemini-2.5-flash-lite' });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/status', async (_req, res) => {
    try {
      const [papers, batches, cost] = await Promise.all([
        query(`SELECT fulltext_status, COUNT(*)::int AS cnt
               FROM research_papers GROUP BY 1 ORDER BY 2 DESC`),
        query(`SELECT id, job_name, state, request_count, success_count, fail_count,
                      error_samples, submitted_at, completed_at, applied_at
               FROM batch_jobs ORDER BY id DESC LIMIT 10`),
        query(`SELECT spent_usd, input_tokens, output_tokens, calls FROM v_today_cost`),
      ]);
      const failedPapers = await query(
        `SELECT id, title, fulltext_error, fulltext_attempts
         FROM research_papers WHERE fulltext_status='failed'
         ORDER BY id DESC LIMIT 5`
      );
      res.json({
        papers: papers.rows,
        batches: batches.rows,
        cost: cost.rows[0],
        failedPapers: failedPapers.rows,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/dashboard', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(DASHBOARD_HTML);
  });

  app.post('/ingest/batch', async (req, res) => {
    try {
      const refs = Array.isArray(req.body?.papers) ? req.body.papers : [];
      if (!refs.length) return res.status(400).json({ error: 'papers array required' });
      const result = await handleBatch(refs);
      res.json(result);
    } catch (err) {
      logger.error({ err }, '/ingest/batch 실패');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/ingest/run-daily', async (_req, res) => {
    try {
      const result = await runDaily();
      res.json(result);
    } catch (err) {
      logger.error({ err }, '/ingest/run-daily 실패');
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// =====================================================================
// 단독 실행
// =====================================================================
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.INGEST_PORT ?? 8787);
  const app = buildApp();
  const server = app.listen(port, () => logger.info({ port }, 'ingest API listening'));

  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    server.close();
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export { handleBatch, runDaily };
