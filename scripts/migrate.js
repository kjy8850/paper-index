// =====================================================================
// scripts/migrate.js — sql/migrations/*.sql 순차 적용
//
//   - 적용 이력은 schema_migrations 테이블에 기록.
//   - 파일명 사전순 정렬. 001_, 002_ ... 처럼 prefix 사용 권장.
//   - 한 파일 = 한 트랜잭션 (파일 자체에 BEGIN/COMMIT 이 있으면 그것을 따름).
//
//   * 사용법
//       node scripts/migrate.js          # 미적용 파일 모두 실행
//       node scripts/migrate.js --status # 적용 상태만 표시
//       node scripts/migrate.js --dry    # 실제 실행 없이 어떤 파일이 적용될지 표시
//       node scripts/migrate.js --redo <basename>   # 강제 재실행 (위험)
// =====================================================================

import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pool, close } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const MIG_DIR      = resolve(__dirname, '..', 'sql', 'migrations');

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const redoIdx = process.argv.indexOf('--redo');
const redoTarget = redoIdx > 0 ? process.argv[redoIdx + 1] : null;

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename     TEXT PRIMARY KEY,
      checksum     TEXT NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by   TEXT
    );
  `);
}

async function listFiles() {
  const entries = await readdir(MIG_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function checksum(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function loadApplied(client) {
  const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
  const map = new Map();
  for (const r of rows) map.set(r.filename, r.checksum);
  return map;
}

async function applyOne(client, filename, sql) {
  logger.info({ filename }, '▶ migration apply');
  await client.query(sql);
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum, applied_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now(), applied_by = EXCLUDED.applied_by`,
    [filename, checksum(sql), process.env.USER || 'unknown'],
  );
  logger.info({ filename }, '✅ applied');
}

(async () => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const files   = await listFiles();
    const applied = await loadApplied(client);

    if (flags.has('--status')) {
      console.log('# migration status');
      for (const f of files) {
        const a = applied.get(f);
        console.log(`  ${a ? '✓' : ' '}  ${f}${a ? '   sha=' + a : ''}`);
      }
      return;
    }

    for (const f of files) {
      const full = resolve(MIG_DIR, f);
      const sql  = await readFile(full, 'utf8');
      const sum  = checksum(sql);
      const prev = applied.get(f);

      const force = redoTarget && (redoTarget === f || redoTarget === f.replace(/\.sql$/, ''));
      if (prev && !force) {
        if (prev !== sum) {
          logger.warn({ f, prev, sum }, '⚠️  파일 내용이 바뀌었습니다 (이미 적용됨). 무시합니다. 변경 적용은 새 마이그레이션 파일을 추가하세요.');
        }
        continue;
      }

      if (flags.has('--dry')) {
        console.log(`[dry-run] would apply: ${f}`);
        continue;
      }

      await applyOne(client, f, sql);
    }
    logger.info('🎉 migrations done');
  } finally {
    client.release();
    await close();
  }
})().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
