import 'dotenv/config';
import { query, close } from './lib/db.js';
import { logger } from './lib/logger.js';
import { fetchPdf } from './lib/pdf-fetch.js';
import { convertPdf } from './lib/docling-client.js';

const BATCH     = Number(process.env.PDF_WORKER_BATCH   ?? 5);
const POLL_MS   = Number(process.env.PDF_WORKER_POLL_MS ?? 10_000);
const MIN_MD    = Number(process.env.PDF_MIN_MD_BYTES   ?? 2_048);

async function lockPending(limit) {
  const { rows } = await query(`
    SELECT id, pdf_url, title
    FROM research_papers
    WHERE fulltext_status = 'pending'
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  `, [limit]);
  return rows;
}

async function markStatus(id, status, error = null) {
  await query(`
    UPDATE research_papers
       SET fulltext_status = $1,
           fulltext_error  = $2,
           fulltext_attempts = fulltext_attempts + 1
     WHERE id = $3
  `, [status, error, id]);
}

async function processOne(paper) {
  const { id, pdf_url, title } = paper;

  if (!pdf_url || !/^https?:\/\/.+/.test(pdf_url)) {
    await markStatus(id, 'no_pdf');
    logger.info({ id }, 'pdf-worker: no_pdf');
    return;
  }

  await query(`UPDATE research_papers SET fulltext_status='running' WHERE id=$1`, [id]);

  try {
    const pdfBuf = await fetchPdf(pdf_url);
    const { markdown } = await convertPdf(pdfBuf);

    if (markdown.length < MIN_MD) {
      throw new Error(`md too small: ${markdown.length} bytes`);
    }

    await query(`
      UPDATE research_papers
         SET fulltext_md          = $1,
             fulltext_status      = 'md_ready',
             fulltext_source      = 'docling',
             fulltext_processed_at = now(),
             fulltext_error       = NULL
       WHERE id = $2
    `, [markdown, id]);

    logger.info({ id, title: title?.slice(0, 60), md_len: markdown.length }, 'pdf-worker: md_ready');
  } catch (err) {
    const { rows } = await query(
      `SELECT fulltext_attempts FROM research_papers WHERE id=$1`, [id]
    );
    const attempts = (rows[0]?.fulltext_attempts ?? 0) + 1;
    const nextStatus = attempts >= 3 ? 'failed' : 'pending';
    await query(`
      UPDATE research_papers
         SET fulltext_status    = $1,
             fulltext_error     = $2,
             fulltext_attempts  = $3
       WHERE id = $4
    `, [nextStatus, err.message, attempts, id]);
    logger.warn({ id, attempts, nextStatus, err: err.message }, 'pdf-worker: error');
  }
}

async function runLoop() {
  logger.info({ batch: BATCH, poll_ms: POLL_MS }, 'pdf-worker starting');

  while (true) {
    let rows;
    try {
      rows = await lockPending(BATCH);
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
  await close();
  process.exit(0);
});

runLoop().catch((err) => {
  logger.error({ err }, 'pdf-worker fatal');
  process.exit(1);
});
