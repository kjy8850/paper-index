// =====================================================================
// Layer 3 — PDF → Markdown 변환 워커 (papers_staging 기반)
//
// 입력  : papers_staging.fulltext_status IN ('pending', 'no_pdf')
// 동작  :
//   - pending  : pdf_url 다운로드 → docling-svc 변환
//                  성공 → fulltext_status='md_ready', md_text/md_chars/md_ready_at 갱신
//                  반복 실패 (≥3회) → 'failed'
//   - no_pdf   : 이미 Layer 2 가 abstract 만으로 다 했으므로
//                즉시 papers_history INSERT + fulltext_status='no_pdf_done'
//
// papers_staging.fulltext_attempts 컬럼이 없으면 raw_metadata.attempts 로 폴백.
// 이 워커는 md_text 를 staging 에 저장만 한다 — Markdown 자체의 영구 저장은 안 함.
//   (Layer 4 deep parser 가 사용 후 NULL 처리)
// =====================================================================

import 'dotenv/config';
import { query, close } from './lib/db.js';
import { logger } from './lib/logger.js';
import { fetchPdf } from './lib/pdf-fetch.js';
import { convertPdf } from './lib/docling-client.js';

const BATCH    = Number(process.env.PDF_WORKER_BATCH   ?? 5);
const POLL_MS  = Number(process.env.PDF_WORKER_POLL_MS ?? 10_000);
const MIN_MD   = Number(process.env.PDF_MIN_MD_BYTES   ?? 2_048);
const MAX_TRY  = Number(process.env.PDF_MAX_ATTEMPTS   ?? 3);

// =====================================================================
// 잠금: pending(우선), no_pdf 일부도 같이.
// papers_scored 가 있고 relevance != 'no' 인 행만 처리한다 (불필요한 PDF 다운 방지).
// =====================================================================
async function lockBatch(limit) {
  const { rows } = await query(
    `
    WITH pick AS (
      SELECT s.id
        FROM papers_staging s
        LEFT JOIN papers_scored sc ON sc.staging_id = s.id
       WHERE s.fulltext_status IN ('pending','no_pdf')
         AND (sc.id IS NULL OR sc.relevance IN ('yes','unsure'))
       ORDER BY (s.fulltext_status = 'pending') DESC, s.id ASC
       FOR UPDATE OF s SKIP LOCKED
       LIMIT $1
    )
    UPDATE papers_staging s
       SET fulltext_status = CASE
                                WHEN s.fulltext_status = 'pending' THEN 'pdf_running'
                                ELSE s.fulltext_status
                             END,
           updated_at = now()
      FROM pick
     WHERE s.id = pick.id
    RETURNING s.id, s.doi, s.arxiv_id, s.title, s.title_normalized,
              s.source, s.pdf_url, s.fulltext_status, s.raw_metadata
    `,
    [limit],
  );
  return rows;
}

function getAttempts(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object') return 0;
  const a = Number(rawMeta.attempts);
  return Number.isFinite(a) ? a : 0;
}

async function bumpAttempts(id, current) {
  const next = current + 1;
  await query(
    `UPDATE papers_staging
        SET raw_metadata = jsonb_set(
              COALESCE(raw_metadata,'{}'::jsonb), '{attempts}', to_jsonb($1::int), TRUE
            ),
            updated_at = now()
      WHERE id = $2`,
    [next, id],
  );
  return next;
}

async function markStatus(id, status, error = null) {
  await query(
    `UPDATE papers_staging
        SET fulltext_status = $1,
            fulltext_error  = $2,
            updated_at      = now()
      WHERE id = $3`,
    [status, error, id],
  );
}

// =====================================================================
// no_pdf 처리: papers_history 에 finalize 후 staging 정리
// =====================================================================
async function finalizeNoPdf(paper) {
  await query(
    `INSERT INTO papers_history
       (staging_id, doi, arxiv_id, title_normalized, source, fulltext_status)
     VALUES ($1,$2,$3,$4,$5,'no_pdf_done')`,
    [paper.id, paper.doi, paper.arxiv_id, paper.title_normalized, paper.source],
  );
  await markStatus(paper.id, 'no_pdf_done');
  logger.info({ id: paper.id }, 'pdf-worker: no_pdf_done');
}

// =====================================================================
// pending 처리: PDF 다운 + Docling
// =====================================================================
async function processPending(paper) {
  const log = logger.child({ id: paper.id });

  if (!paper.pdf_url || !/^https?:\/\/.+/.test(paper.pdf_url)) {
    // pending 인데 url 이 깨졌다면 no_pdf 로 강등 후 finalize 분기로
    log.warn('pending 인데 pdf_url 깨짐 → no_pdf 로 강등');
    await markStatus(paper.id, 'no_pdf', 'invalid pdf_url');
    return finalizeNoPdf({ ...paper, fulltext_status: 'no_pdf' });
  }

  try {
    const pdfBuf = await fetchPdf(paper.pdf_url);
    const { markdown } = await convertPdf(pdfBuf);

    if (!markdown || markdown.length < MIN_MD) {
      throw new Error(`markdown too small: ${markdown?.length ?? 0} bytes`);
    }

    await query(
      `UPDATE papers_staging
          SET md_text         = $1,
              md_chars        = $2,
              md_ready_at     = now(),
              fulltext_status = 'md_ready',
              fulltext_error  = NULL,
              updated_at      = now()
        WHERE id = $3`,
      [markdown, markdown.length, paper.id],
    );
    log.info({ md_len: markdown.length, title: paper.title?.slice(0, 60) },
             'pdf-worker: md_ready');
  } catch (err) {
    const attempts = await bumpAttempts(paper.id, getAttempts(paper.raw_metadata));
    const next = attempts >= MAX_TRY ? 'failed' : 'pending';
    await markStatus(paper.id, next, err.message?.slice(0, 200));
    log.warn({ attempts, next, err: err.message }, 'pdf-worker: error');
  }
}

// =====================================================================
// 한 건 디스패치
// =====================================================================
async function processOne(paper) {
  // lockBatch 가 pending → pdf_running 으로 바꿔놨거나, no_pdf 그대로다.
  if (paper.fulltext_status === 'no_pdf') {
    return finalizeNoPdf(paper);
  }
  return processPending(paper);
}

// =====================================================================
// 메인 루프
// =====================================================================
async function runLoop() {
  logger.info({ batch: BATCH, poll_ms: POLL_MS }, 'pdf-worker starting (v2)');

  while (true) {
    let rows;
    try {
      rows = await lockBatch(BATCH);
    } catch (err) {
      logger.error({ err }, 'pdf-worker: db error in poll');
      await sleep(POLL_MS);
      continue;
    }

    if (rows.length === 0) {
      await sleep(POLL_MS);
      continue;
    }

    logger.info({ count: rows.length }, 'pdf-worker: processing batch');
    await Promise.allSettled(rows.map(processOne));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('SIGTERM', async () => {
  logger.info('pdf-worker: SIGTERM, shutting down');
  await close().catch(() => {});
  process.exit(0);
});

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runLoop().catch((err) => {
    logger.error({ err }, 'pdf-worker fatal');
    process.exit(1);
  });
}

export { processOne, lockBatch, finalizeNoPdf, processPending };
