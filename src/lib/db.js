// =====================================================================
// PostgreSQL 연결 풀 + pgvector 친화적 헬퍼.
// - vector 타입 직렬화는 pg 가 직접 지원하지 않으므로 문자열 변환 함수를 둠.
// - 트랜잭션 헬퍼 withTx 제공.
// =====================================================================

import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5433),
  database: process.env.PGDATABASE ?? 'papers',
  user:     process.env.PGUSER     ?? 'paperuser',
  password: process.env.PGPASSWORD ?? 'paperpass',
  max:      Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL idle client error');
});

/**
 * Float32 배열을 pgvector 리터럴 문자열로 변환.
 * 예: [0.1, 0.2] -> '[0.1,0.2]'
 */
export function toVectorLiteral(arr) {
  if (!Array.isArray(arr)) throw new TypeError('vector must be an array');
  // 비정상 값 방어
  const safe = arr.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return v;
  });
  return `[${safe.join(',')}]`;
}

/**
 * 일반 쿼리 실행.
 */
export async function query(sql, params = []) {
  const start = Date.now();
  try {
    const res = await pool.query(sql, params);
    const ms = Date.now() - start;
    if (ms > 500) {
      logger.warn({ ms, sql: sql.slice(0, 120) }, 'slow query');
    }
    return res;
  } catch (err) {
    logger.error({ err, sql: sql.slice(0, 200) }, 'db query failed');
    throw err;
  }
}

/**
 * 트랜잭션 헬퍼.
 */
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 헬스체크.
 */
export async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function close() {
  await pool.end();
}

export { pool };
