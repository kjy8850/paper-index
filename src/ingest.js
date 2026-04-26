// =====================================================================
// Ingestion 엔진 — Layer 1 (수집·중복제거·staging)
//
//  변경 (PAPER_SYSTEM_ARCHITECTURE.md 기준)
//   - 더 이상 research_papers 에 직접 INSERT 하지 않는다.
//   - 모든 신규 논문은 papers_staging 으로 들어가고, 분석·임베딩은
//     Layer 2 (Gemini Flash batch) 와 Layer 4 (Claude Deep Parser) 가 담당한다.
//   - 메모리 dedupe 후, papers_history + papers_excluded + papers_staging
//     3 테이블에 대조해 한 번이라도 본 논문은 자동 차단한다.
//
//  엔드포인트 (n8n / 운영자 호출)
//     POST /ingest/batch       : PaperRef[] 를 직접 받아 staging 에 넣음
//     POST /ingest/run-phase   : Phase 1/2 분기를 서버 안에서 수행 (Task 2 에서 채워짐)
//     POST /ingest/run-daily   : 호환용 (run-phase 를 호출)
//     GET  /health, /dashboard, /api/status
// =====================================================================

import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import pLimit from 'p-limit';

import { logger, childLogger } from './lib/logger.js';
import { query, ping, close } from './lib/db.js';
import { loadKeywords } from './lib/config.js';
import { searchAll, dedupeKey } from './sources/index.js';
import { finalizePaperRef } from './lib/normalize.js';
import { dedupeAgainstDb } from './lib/dedupe.js';
import {
  getPhase1State, setPhase1State, ensureTodayPhase1Window,
  getConfig, setConfig,
} from './lib/system-config.js';

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
// PaperRef 스키마 — 4 개 소스 + manual 입력 허용
// =====================================================================
const PaperRefSchema = z.object({
  source:           z.enum(['arxiv', 'semantic_scholar', 'chemrxiv', 'openalex', 'manual']),
  source_id:        z.string().min(1),
  doi:              z.string().optional(),
  arxiv_id:         z.string().optional(),
  title:            z.string().min(1),
  title_normalized: z.string().optional(),
  abstract:         z.string().optional().default(''),
  authors:          z.array(z.string()).optional().default([]),
  published_at:     z.string().optional(),
  year:             z.number().int().optional(),
  venue:            z.string().optional(),
  url:              z.string().optional(),
  pdf_url:          z.string().optional(),
  citations:        z.number().optional().default(0),
  category_hint:    z.string().optional(),
});

// =====================================================================
// papers_staging INSERT
//   - 분석/임베딩은 하지 않는다 (Layer 2/4 가 처리).
//   - PDF URL 유무에 따라 fulltext_status 만 결정.
//   - 같은 batch 내에서도 중복 INSERT 가 발생할 수 있어 ON CONFLICT 가드.
// =====================================================================
async function insertStaging(ref) {
  const status = /^https?:\/\/.+/.test(ref.pdf_url ?? '') ? 'pending' : 'no_pdf';
  const year = Number.isFinite(ref.year)
    ? ref.year
    : (ref.published_at ? Number(ref.published_at.slice(0, 4)) : null);

  const sql = `
    INSERT INTO papers_staging (
      doi, arxiv_id, source, source_id,
      title, title_normalized, authors, year, abstract,
      url, pdf_url, venue, citations, category_hint,
      fulltext_status, raw_metadata
    ) VALUES (
      $1,$2,$3,$4,
      $5,$6,$7::jsonb,$8,$9,
      $10,$11,$12,$13,$14,
      $15,$16::jsonb
    )
    RETURNING id
  `;
  const params = [
    ref.doi ?? null,
    ref.arxiv_id ?? null,
    ref.source,
    ref.source_id,
    ref.title,
    ref.title_normalized ?? null,
    JSON.stringify(ref.authors ?? []),
    Number.isFinite(year) ? year : null,
    ref.abstract ?? null,
    ref.url ?? null,
    ref.pdf_url ?? null,
    ref.venue ?? null,
    ref.citations ?? 0,
    ref.category_hint ?? null,
    status,
    JSON.stringify({ source_raw: ref.source }),
  ];
  const { rows } = await query(sql, params);
  return { id: rows[0]?.id, status };
}

/**
 * 한 묶음 (PaperRef[]) 을 papers_staging 에 적재.
 *  1. zod 검증 + finalizePaperRef (혹시 누락된 정규화 필드 보정)
 *  2. 메모리 내부 dedupe (sources/index.js 의 dedupe 와 동일 키 정책)
 *  3. dedupeAgainstDb 로 papers_history / excluded / staging 3 테이블 조회
 *  4. 살아남은 ref 만 INSERT
 *
 *  반환:
 *    { staged, duplicated_db, duplicated_inflight, invalid, samples }
 */
export async function stageRefs(paperRefs, { phase = 'phase2', logChild } = {}) {
  const log = logChild ?? childLogger({ mod: 'stage' });
  const limitDb = pLimit(Number(process.env.STAGING_INSERT_CONCURRENCY ?? 8));
  const errorSamples = [];

  // 1) 검증 + 정규화
  const validated = [];
  let invalid = 0;
  for (const r of paperRefs) {
    const parsed = PaperRefSchema.safeParse(r);
    if (!parsed.success) {
      invalid += 1;
      if (errorSamples.length < 5) {
        errorSamples.push({ title: r?.title, error: parsed.error.errors[0]?.message ?? 'validation' });
      }
      continue;
    }
    const fin = finalizePaperRef(parsed.data) ?? parsed.data;
    validated.push(fin);
  }

  // 2) 메모리 내 dedupe (한 batch 안에서 중복 들어오는 경우)
  const seenKeys = new Set();
  const memUnique = [];
  let duplicatedInflight = 0;
  for (const r of validated) {
    const key = dedupeKey(r);
    if (seenKeys.has(key)) {
      duplicatedInflight += 1;
      continue;
    }
    seenKeys.add(key);
    memUnique.push(r);
  }

  // 3) DB 3-테이블 dedup
  const { kept, excluded } = await dedupeAgainstDb(memUnique);
  const duplicatedDb = excluded.length;

  // 4) staging INSERT (병렬 약간 제한)
  let staged = 0;
  let stageFail = 0;
  const insertResults = await Promise.all(kept.map((r) => limitDb(async () => {
    try {
      const res = await insertStaging(r);
      staged += 1;
      return { ok: true, id: res.id, status: res.status };
    } catch (err) {
      stageFail += 1;
      if (errorSamples.length < 5) {
        errorSamples.push({ title: r.title?.slice(0, 60), error: err?.message });
      }
      return { ok: false, error: err?.message };
    }
  })));

  log.info({
    phase, total: paperRefs.length, validated: validated.length,
    duplicated_inflight: duplicatedInflight,
    duplicated_db: duplicatedDb,
    staged, stage_failed: stageFail, invalid,
  }, 'stageRefs 완료');

  return {
    phase,
    total: paperRefs.length,
    validated: validated.length,
    duplicated_inflight: duplicatedInflight,
    duplicated_db: duplicatedDb,
    staged,
    stage_failed: stageFail,
    invalid,
    error_samples: errorSamples,
    results: insertResults,
  };
}

// 호환성을 위해 옛 이름도 노출
export const handleBatch = stageRefs;

// =====================================================================
// 키워드 기반 다중 소스 수집 → stageRefs
//
// 이 함수는 Phase 1/2 분기 로직(Task 2)에서 호출되는 빌딩 블록.
// 단순 한 패스 수집/적재만 한다 (커서·종료조건은 호출자가 관리).
// =====================================================================
export async function collectAndStage({
  queries,
  perSource = Number(process.env.MAX_PER_SOURCE ?? 50),
  sources,
  daysWindow,
  phase = 'phase2',
} = {}) {
  const log = childLogger({ mod: 'collect' });
  const keywords = await loadKeywords();

  // queries 가 비어있으면 keywords.json 의 primary+secondary 를 weight 순으로
  const planned = (queries && queries.length)
    ? queries
    : [...(keywords.primary ?? []), ...(keywords.secondary ?? [])]
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  // 1) 수집 (메모리 dedupe 까지는 sources/index.js 가 처리)
  const collectedMap = new Map();
  for (const k of planned) {
    const q = typeof k === 'string' ? k : k.q;
    const cat = typeof k === 'string' ? undefined : k.category_hint;
    if (!q) continue;

    let refs = [];
    try {
      refs = await searchAll({ query: q, perSource, sources, daysWindow, categoryHint: cat });
    } catch (err) {
      log.warn({ q, err: err.message }, 'searchAll 실패');
    }
    for (const r of refs) {
      const key = dedupeKey(r);
      if (!collectedMap.has(key)) collectedMap.set(key, r);
    }
    log.info({ q, gotNow: refs.length, totalUniq: collectedMap.size }, '수집 진행');
  }

  const refs = Array.from(collectedMap.values());

  // 2) ingestion_log 행 + stageRefs
  const { rows: [logRow] } = await query(
    `INSERT INTO ingestion_log (source, query, requested, fetched, deduped, phase)
     VALUES ('combined', $1, $2, $3, $4, $5)
     RETURNING id, run_id`,
    ['collectAndStage', refs.length, refs.length, refs.length, phase],
  );

  const stage = await stageRefs(refs, { phase, logChild: log });

  await query(
    `UPDATE ingestion_log
        SET ingested = $1,
            staged   = $1,
            failed   = $2,
            excluded_dedup = $3,
            error_samples  = $4::jsonb,
            finished_at    = now()
      WHERE id = $5`,
    [stage.staged, stage.stage_failed + stage.invalid, stage.duplicated_db,
     JSON.stringify(stage.error_samples), logRow.id],
  );

  return { run_id: logRow.run_id, fetched: refs.length, ...stage };
}

// =====================================================================
// Phase 1 / Phase 2 분기 (PAPER_SYSTEM_ARCHITECTURE.md §5)
//
//  - Phase 1 : system_config.phase1_completed = false 인 동안. 키워드를 회전
//              하며 cursor 를 전진시켜 과거 논문 대량 수집.
//              한 호출당 처리량은 maxBudgetMs / maxIterations 로 묶는다
//              (HTTP 응답 시간 폭주 방지).
//              종료 조건은 동일 호출 안에서뿐 아니라 system_config 에 누적되어
//              n8n 이 같은 엔드포인트를 다시 호출해도 자연스럽게 이어진다.
//  - Phase 2 : 일 1회. 최근 윈도우(daysWindow) 내 신규만 수집.
// =====================================================================

const PHASE1_DAILY_TARGET   = Number(process.env.PHASE1_DAILY_TARGET   ?? 300);
const PHASE1_TIMEOUT_HOURS  = Number(process.env.PHASE1_TIMEOUT_HOURS  ?? 20);
const PHASE1_MIN_BATCH      = Number(process.env.PHASE1_MIN_BATCH      ?? 50);
const PHASE1_PER_KEYWORD    = Number(process.env.PHASE1_PER_KEYWORD    ?? 50);
const PHASE2_DAYS_WINDOW    = Number(process.env.PHASE2_DAYS_WINDOW    ?? 14);

/**
 * 한 키워드(질의어) 에 대해 4 소스를 한 번 훑어서 staging 까지 진행.
 * Phase 1 루프가 반복 호출하는 단위.
 */
async function sweepOneKeyword({ keyword, perSource, sources, daysWindow, phase, log }) {
  const q = typeof keyword === 'string' ? keyword : keyword.q;
  const cat = typeof keyword === 'string' ? undefined : keyword.category_hint;
  if (!q) return { staged: 0, fetched: 0, duplicated_db: 0, duplicated_inflight: 0 };

  let refs = [];
  try {
    refs = await searchAll({ query: q, perSource, sources, daysWindow, categoryHint: cat });
  } catch (err) {
    log.warn({ q, err: err.message }, 'searchAll 실패');
    return { staged: 0, fetched: 0, duplicated_db: 0, duplicated_inflight: 0, error: err.message };
  }

  const stage = await stageRefs(refs, { phase, logChild: log });
  return { fetched: refs.length, ...stage, query: q };
}

/**
 * Phase 1 단일 호출분. n8n 이 매일 새벽 호출하면 충분하지만, 같은 날
 * 다시 호출돼도 안전 (cursor + collectedToday 를 system_config 에 보존).
 *
 *  옵션:
 *   - maxBudgetMs       : 이번 호출의 처리 시간 상한 (default 60s)
 *   - maxIterations     : 이번 호출의 키워드 sweep 횟수 상한 (default 12)
 *   - perSource         : 키워드당 / 소스당 가져올 건수 (default PHASE1_PER_KEYWORD)
 *   - sources           : ['openalex', 'semantic_scholar', 'arxiv', 'chemrxiv']
 */
export async function runPhase1Once({
  maxBudgetMs   = Number(process.env.PHASE1_CALL_BUDGET_MS ?? 60_000),
  maxIterations = Number(process.env.PHASE1_CALL_MAX_ITER  ?? 12),
  perSource     = PHASE1_PER_KEYWORD,
  sources,
} = {}) {
  const log = childLogger({ mod: 'phase1' });
  const startedAt = Date.now();

  await ensureTodayPhase1Window();
  const stateBefore = await getPhase1State();
  if (stateBefore.completed) {
    log.info('phase1 이미 완료. phase2 로 위임.');
    return { phase: 'phase2', delegated: true, ...(await runPhase2Once()) };
  }

  const keywords = await loadKeywords();
  const planned = [
    ...(keywords.primary   ?? []),
    ...(keywords.secondary ?? []),
  ].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  if (!planned.length) {
    log.warn('keywords.json 비어있음 → Phase 1 종료 처리');
    await setPhase1State({ completed: true });
    return { phase: 'phase1', completed: true, reason: 'no_keywords' };
  }

  // cursor.kwIdx 가 다음 sweep 할 키워드 인덱스
  let cursor = stateBefore.cursor && typeof stateBefore.cursor === 'object'
    ? { ...stateBefore.cursor }
    : {};
  if (typeof cursor.kwIdx !== 'number') cursor.kwIdx = 0;

  let collectedToday = stateBefore.collectedToday;
  let totalCollected = stateBefore.totalCollected;
  let stagedThisCall = 0;
  let lastSweepStaged = 0;
  const sweeps = [];

  // ingestion_log
  const { rows: [logRow] } = await query(
    `INSERT INTO ingestion_log (source, query, requested, fetched, deduped, phase)
     VALUES ('combined', 'phase1_loop', 0, 0, 0, 'phase1')
     RETURNING id, run_id`,
  );

  let i = 0;
  let terminator = null;
  while (i < maxIterations) {
    if (Date.now() - startedAt > maxBudgetMs) { terminator = 'budget'; break; }
    if (collectedToday >= PHASE1_DAILY_TARGET) { terminator = 'daily_target'; break; }

    const kwIdx = cursor.kwIdx % planned.length;
    const kw    = planned[kwIdx];
    cursor.kwIdx = (cursor.kwIdx + 1) % planned.length;

    const result = await sweepOneKeyword({
      keyword: kw, perSource, sources, phase: 'phase1', log,
    });
    sweeps.push({ kw: typeof kw === 'string' ? kw : kw.q, ...result });
    lastSweepStaged = result.staged ?? 0;
    collectedToday += lastSweepStaged;
    totalCollected += lastSweepStaged;
    stagedThisCall += lastSweepStaged;
    i += 1;
  }

  // 20시간 + 50건 미만 → Phase 1 완료 처리.
  // 호출 안에서가 아니라 누적 startTime 기준으로 평가하므로
  // n8n 이 같은 엔드포인트를 다음 날 다시 호출해도 자연스럽게 이어진다.
  const startTimeIso = stateBefore.startTime || new Date(startedAt).toISOString();
  const elapsedMs = Date.now() - new Date(startTimeIso).getTime();
  const elapsedHours = elapsedMs / 3_600_000;
  let completed = false;
  if (collectedToday >= PHASE1_DAILY_TARGET) {
    terminator = terminator ?? 'daily_target';
  } else if (elapsedHours >= PHASE1_TIMEOUT_HOURS) {
    if (lastSweepStaged < PHASE1_MIN_BATCH) {
      completed = true;
      terminator = 'phase1_done';
    } else {
      terminator = terminator ?? 'timeout_keep_going';
    }
  } else if (!terminator) {
    terminator = 'iter_limit';
  }

  await setPhase1State({
    completed,
    cursor,
    collectedToday,
    totalCollected,
  });

  await query(
    `UPDATE ingestion_log
        SET ingested = $1, staged = $1, fetched = $2,
            error_samples = $3::jsonb,
            finished_at = now()
      WHERE id = $4`,
    [
      stagedThisCall,
      sweeps.reduce((a, s) => a + (s.fetched || 0), 0),
      JSON.stringify(sweeps.slice(-5).map((s) => ({ q: s.kw, staged: s.staged, error: s.error }))),
      logRow.id,
    ],
  );

  log.info({
    iterations: i,
    elapsed_hours: Number(elapsedHours.toFixed(2)),
    collectedToday, stagedThisCall, lastSweepStaged,
    terminator, completed,
  }, 'phase1 호출 종료');

  return {
    phase: 'phase1',
    iterations: i,
    sweeps_summary: sweeps.map((s) => ({ q: s.kw, staged: s.staged, fetched: s.fetched })),
    staged_this_call: stagedThisCall,
    collected_today: collectedToday,
    total_collected: totalCollected,
    last_sweep_staged: lastSweepStaged,
    elapsed_hours: Number(elapsedHours.toFixed(2)),
    terminator,
    completed,
    cursor,
  };
}

/**
 * Phase 2 단일 호출분. 최근 N 일 신규 논문만 수집.
 */
export async function runPhase2Once({
  daysWindow = PHASE2_DAYS_WINDOW,
  perSource  = Number(process.env.MAX_PER_SOURCE ?? 50),
  sources,
} = {}) {
  return collectAndStage({ phase: 'phase2', daysWindow, perSource, sources });
}

/**
 * 운영 진입점. system_config.phase1_completed 를 보고 자동 분기.
 */
export async function runIngestPhase(opts = {}) {
  const completed = String(await getConfig('phase1_completed', 'false')).toLowerCase() === 'true';
  if (completed) {
    return { phase: 'phase2', ...(await runPhase2Once(opts)) };
  }
  return await runPhase1Once(opts);
}

// 옛 이름 호환 (n8n 등 외부 호출자)
export async function runDaily() {
  return runIngestPhase();
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
      const papersQ = query(
        `SELECT fulltext_status, COUNT(*)::int AS cnt
           FROM papers_staging GROUP BY 1
        UNION ALL
         SELECT fulltext_status, COUNT(*)::int AS cnt
           FROM papers_history GROUP BY 1`,
      );
      const batchesQ = query(
        `SELECT id, job_name, state, request_count, success_count, fail_count,
                error_samples, submitted_at, completed_at, applied_at
           FROM batch_jobs ORDER BY id DESC LIMIT 10`,
      ).catch(() => ({ rows: [] }));
      const costQ = query(
        `SELECT day, total_usd AS spent_usd FROM v_daily_cost ORDER BY day DESC LIMIT 1`,
      ).catch(() => ({ rows: [] }));
      const failedQ = query(
        `SELECT id, title, fulltext_error
           FROM papers_staging
          WHERE fulltext_status IN ('failed', 'broken')
          ORDER BY id DESC LIMIT 5`,
      );
      const phaseStateQ = query(
        `SELECT key, value FROM system_config
          WHERE key IN ('phase1_completed','phase1_collected_today','phase1_total_collected','phase1_start_time')`,
      ).catch(() => ({ rows: [] }));

      const [papers, batches, cost, failedPapers, phaseRows] = await Promise.all([
        papersQ, batchesQ, costQ, failedQ, phaseStateQ,
      ]);

      const merged = new Map();
      for (const r of papers.rows) {
        merged.set(r.fulltext_status, (merged.get(r.fulltext_status) ?? 0) + Number(r.cnt));
      }
      const papersAgg = Array.from(merged.entries())
        .map(([fulltext_status, cnt]) => ({ fulltext_status, cnt }))
        .sort((a, b) => b.cnt - a.cnt);

      const phaseState = Object.fromEntries((phaseRows.rows ?? []).map((r) => [r.key, r.value]));

      res.json({
        papers: papersAgg,
        batches: batches.rows,
        cost: cost.rows[0] ?? { spent_usd: 0 },
        failedPapers: failedPapers.rows,
        phaseState,
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
      const result = await stageRefs(refs, { phase: req.body?.phase ?? 'phase2' });
      res.json(result);
    } catch (err) {
      logger.error({ err }, '/ingest/batch 실패');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/ingest/run-phase', async (req, res) => {
    try {
      const opts = {};
      if (Number.isFinite(req.body?.maxBudgetMs))   opts.maxBudgetMs   = Number(req.body.maxBudgetMs);
      if (Number.isFinite(req.body?.maxIterations)) opts.maxIterations = Number(req.body.maxIterations);
      if (Number.isFinite(req.body?.perSource))     opts.perSource     = Number(req.body.perSource);
      if (Array.isArray(req.body?.sources))         opts.sources       = req.body.sources;
      if (Number.isFinite(req.body?.daysWindow))    opts.daysWindow    = Number(req.body.daysWindow);

      let result;
      if (req.body?.phase === 'phase1')      result = await runPhase1Once(opts);
      else if (req.body?.phase === 'phase2') result = await runPhase2Once(opts);
      else                                   result = await runIngestPhase(opts);
      res.json(result);
    } catch (err) {
      logger.error({ err }, '/ingest/run-phase 실패');
      res.status(500).json({ error: err.message });
    }
  });

  // 호환: 기존 n8n 워크플로가 /run-daily 로 호출하는 경우 → 자동 분기
  app.post('/ingest/run-daily', async (_req, res) => {
    try {
      const result = await runIngestPhase();
      res.json(result);
    } catch (err) {
      logger.error({ err }, '/ingest/run-daily 실패');
      res.status(500).json({ error: err.message });
    }
  });

  // 운영자가 phase1 을 강제로 닫고 싶을 때 (50 건 임계 튜닝 중)
  app.post('/ingest/phase1/complete', async (_req, res) => {
    try {
      await setConfig('phase1_completed', 'true');
      res.json({ ok: true, phase1_completed: true });
    } catch (err) {
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
