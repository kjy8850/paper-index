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
import { analyzePaper } from './lib/gemini.js';
import { embedText } from './lib/embedding.js';
import { loadTaxonomy, loadKeywords } from './lib/config.js';
import { searchAll, dedupeKey } from './sources/index.js';

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
      summary_ko      = EXCLUDED.summary_ko,
      key_findings    = EXCLUDED.key_findings,
      materials       = EXCLUDED.materials,
      techniques      = EXCLUDED.techniques,
      novelty_score   = EXCLUDED.novelty_score,
      relevance_score = EXCLUDED.relevance_score,
      major_category  = EXCLUDED.major_category,
      mid_category    = EXCLUDED.mid_category,
      sub_category    = EXCLUDED.sub_category,
      tags            = EXCLUDED.tags,
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

/**
 * 단일 논문 처리: 분석 -> 임베딩 -> upsert.
 */
async function ingestOne(ref, taxonomy, log) {
  try {
    const analysis  = await analyzePaper(
      { title: ref.title, abstract: ref.abstract, fullText: ref.fullText },
      taxonomy,
    );
    const embedText_ = [
      ref.title,
      analysis.summary_ko,
      (analysis.key_findings ?? []).join(' '),
      (analysis.materials ?? []).join(' '),
      (analysis.techniques ?? []).join(' '),
      ref.abstract ?? '',
    ].filter(Boolean).join('\n');

    const embedding = await embedText(embedText_, 'RETRIEVAL_DOCUMENT');
    const id = await upsertPaper(ref, analysis, embedding);
    await updateCategoryMaster(analysis);
    log.info({ id, title: ref.title.slice(0, 60), major: analysis.major_category }, 'ingested');
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
  const taxonomy = await loadTaxonomy();
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
      const res = await ingestOne(parsed.data, taxonomy, log);
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
  const taxonomy = await loadTaxonomy();
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

  // 간단한 API key 인증
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const expected = process.env.INGEST_API_KEY;
    if (!expected) return next(); // 키 미설정 시 패스 (로컬)
    if (req.header('x-api-key') === expected) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/health', async (_req, res) => {
    try {
      const ok = await ping();
      res.json({ ok, gemini_model: process.env.GEMINI_GEN_MODEL ?? 'gemini-2.5-flash' });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
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
