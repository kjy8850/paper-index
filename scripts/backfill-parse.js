// =====================================================================
// scripts/backfill-parse.js
// Phase 1 완료 후 우선순위 큐 처리:
//   기존에 batch_done 으로 마감된 papers_history(또는 papers_staging) 행 중
//   papers_parsed 가 없는 200~ 건을 다시 'queued' 로 바꿔
//   Layer 4 (Claude Deep Parser) 가 다시 잡아 처리하도록 한다.
//
// 사용:
//   node scripts/backfill-parse.js --dry             # 카운트만
//   node scripts/backfill-parse.js --enqueue         # 실제 fulltext_status='queued'
//   node scripts/backfill-parse.js --enqueue --limit 50
//   node scripts/backfill-parse.js --status          # backfill 진행률
//   node scripts/backfill-parse.js --reset           # 'queued' → 'batch_done' 으로 되돌림 (실수 복구용)
//
// 안전장치:
//   - phase1_completed != 'true' 면 거부 (--force 로 무시 가능)
//   - 한 번 큐잉할 때 staging.fulltext_status 가 'batch_done' 이거나
//     papers_history.fulltext_status='batch_done' 인 것만 대상.
//   - papers_scored.relevance != 'no' 인 행만 대상 (이미 NO 인 건 큐잉 의미 없음)
// =====================================================================

import 'dotenv/config';
import { query, withTx, close } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';
import { getConfig, setConfig } from '../src/lib/system-config.js';

function parseArgs(argv) {
  const out = { mode: 'status', limit: 1000, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--dry')      out.mode = 'dry';
    else if (a === '--enqueue')  out.mode = 'enqueue';
    else if (a === '--status')   out.mode = 'status';
    else if (a === '--reset')    out.mode = 'reset';
    else if (a === '--force')    out.force = true;
    else if (a === '--limit')    out.limit = Number(argv[++i] ?? 1000);
  }
  return out;
}

async function ensurePhase1Complete(force) {
  const completed = String(await getConfig('phase1_completed', 'false')).toLowerCase() === 'true';
  if (!completed && !force) {
    throw new Error(
      'phase1_completed != true. 강제로 진행하려면 --force 를 붙여 다시 실행하세요.\n' +
      '권장: Phase 1 종료 후에만 backfill 큐잉.'
    );
  }
  return completed;
}

// =====================================================================
// 후보 카운트 / SELECT
// staging 안에 살아있는 batch_done 이 1순위, history 만 있고 staging 이 정리된
// 케이스가 2순위.
// =====================================================================
async function countCandidates() {
  const sql = `
    WITH base AS (
      SELECT s.id AS staging_id
        FROM papers_staging s
        LEFT JOIN papers_parsed p ON p.staging_id = s.id
        LEFT JOIN papers_scored sc ON sc.staging_id = s.id
       WHERE s.fulltext_status = 'batch_done'
         AND p.id IS NULL
         AND (sc.id IS NULL OR sc.relevance <> 'no')
    )
    SELECT COUNT(*)::int AS n FROM base
  `;
  const { rows } = await query(sql);
  return rows[0]?.n ?? 0;
}

async function selectCandidates(limit) {
  const sql = `
    SELECT s.id, s.title, s.fulltext_status, s.md_chars, s.pdf_url IS NOT NULL AS has_pdf
      FROM papers_staging s
      LEFT JOIN papers_parsed p ON p.staging_id = s.id
      LEFT JOIN papers_scored sc ON sc.staging_id = s.id
     WHERE s.fulltext_status = 'batch_done'
       AND p.id IS NULL
       AND (sc.id IS NULL OR sc.relevance <> 'no')
     ORDER BY s.id ASC
     LIMIT $1
  `;
  const { rows } = await query(sql, [limit]);
  return rows;
}

async function enqueue(limit) {
  return withTx(async (c) => {
    const sql = `
      WITH pick AS (
        SELECT s.id
          FROM papers_staging s
          LEFT JOIN papers_parsed p ON p.staging_id = s.id
          LEFT JOIN papers_scored sc ON sc.staging_id = s.id
         WHERE s.fulltext_status = 'batch_done'
           AND p.id IS NULL
           AND (sc.id IS NULL OR sc.relevance <> 'no')
         ORDER BY s.id ASC
         FOR UPDATE OF s SKIP LOCKED
         LIMIT $1
      )
      UPDATE papers_staging s
         SET fulltext_status = 'queued',
             fulltext_error  = 'backfill: enqueue for layer4 reparse',
             updated_at      = now()
        FROM pick
       WHERE s.id = pick.id
      RETURNING s.id
    `;
    const { rows } = await c.query(sql, [limit]);
    return rows.map((r) => r.id);
  });
}

async function reset() {
  // 실수 복구용 : queued + fulltext_error LIKE 'backfill%' 만 다시 batch_done 으로
  const { rows } = await query(
    `UPDATE papers_staging
        SET fulltext_status='batch_done',
            fulltext_error = NULL,
            updated_at = now()
      WHERE fulltext_status='queued'
        AND fulltext_error LIKE 'backfill%'
      RETURNING id`,
  );
  return rows.map((r) => r.id);
}

async function statusReport() {
  const { rows } = await query(`
    SELECT 'batch_done_no_parsed' AS bucket, COUNT(*)::int AS n
      FROM papers_staging s
      LEFT JOIN papers_parsed p ON p.staging_id = s.id
     WHERE s.fulltext_status='batch_done' AND p.id IS NULL
    UNION ALL
    SELECT 'queued_backfill', COUNT(*)::int
      FROM papers_staging
     WHERE fulltext_status='queued' AND fulltext_error LIKE 'backfill%'
    UNION ALL
    SELECT 'parsed_total', COUNT(*)::int FROM papers_parsed
  `);
  return rows;
}

// =====================================================================
// CLI
// =====================================================================
async function main() {
  const args = parseArgs(process.argv);
  const log = logger.child({ mod: 'backfill' });

  if (args.mode === 'status') {
    const rep = await statusReport();
    console.log('--- Backfill Status ---');
    for (const r of rep) console.log(`  ${r.bucket.padEnd(22)} ${r.n}`);
    return;
  }

  if (args.mode === 'reset') {
    const ids = await reset();
    log.info({ reset: ids.length }, 'backfill: reset done');
    console.log(`reset: ${ids.length} 건을 batch_done 으로 되돌림`);
    return;
  }

  await ensurePhase1Complete(args.force);

  if (args.mode === 'dry') {
    const total = await countCandidates();
    const sample = await selectCandidates(Math.min(args.limit, 10));
    console.log(`총 후보: ${total}건`);
    console.log('샘플 10건:');
    for (const r of sample) {
      console.log(`  #${r.id} pdf=${r.has_pdf} md=${r.md_chars ?? '-'} ${String(r.title).slice(0, 80)}`);
    }
    return;
  }

  if (args.mode === 'enqueue') {
    const ids = await enqueue(args.limit);
    log.info({ enqueued: ids.length }, 'backfill: enqueued');
    await setConfig('backfill_enabled', 'true');
    console.log(`enqueued: ${ids.length}건이 'queued' 로 전환됨. deep-parser 가 곧 처리합니다.`);
    return;
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfill 실패');
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => close().catch(() => {}));
