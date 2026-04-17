// =====================================================================
// sql/init.sql 을 수동으로 실행 (docker-compose 외부에서 init 가 필요할 때)
// 사용법: node scripts/db-init.js
// =====================================================================

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool, close } from '../src/lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  const sql = await readFile(resolve(__dirname, '..', 'sql', 'init.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('✅ DB 스키마 초기화 완료');
  } finally {
    client.release();
    await close();
  }
})().catch((err) => {
  console.error('❌ DB 초기화 실패', err);
  process.exit(1);
});
