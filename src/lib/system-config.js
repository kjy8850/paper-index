// =====================================================================
// system_config — 운영 상태 KV 헬퍼
//
// 키 일람 (sql/migrations/002_v2_layered_pipeline.sql 참고):
//   phase1_completed         'false' | 'true'
//   phase1_last_cursor       JSON 문자열. 소스별 cursor/오프셋 보관
//   phase1_collected_today   숫자 (오늘 누적 수집 건수)
//   phase1_start_time        ISO8601. 오늘 Phase 1 루프 시작 시각
//   phase1_total_collected   숫자 (Phase 1 누적)
//   daily_pdf_limit          숫자 (일일 Claude PDF 처리 한도)
//   daily_pdf_processed      숫자 (오늘 처리한 PDF 수)
//   daily_pdf_reset_at       ISO8601 KST. 마지막 리셋 시각
//   claude_model             모델 이름 (claude-sonnet-4-6 등)
// =====================================================================

import { query } from './db.js';

/**
 * 단일 키 조회.
 * @param {string} key
 * @param {string=} fallback - 행이 없거나 NULL 일 때 반환
 * @returns {Promise<string|undefined>}
 */
export async function getConfig(key, fallback) {
  const { rows } = await query(
    `SELECT value FROM system_config WHERE key = $1 LIMIT 1`,
    [key],
  );
  if (rows.length === 0) return fallback;
  const v = rows[0].value;
  return v == null ? fallback : v;
}

/**
 * 여러 키를 한 번에. 누락된 키는 결과 객체에 포함되지 않음.
 * @param {string[]} keys
 * @returns {Promise<Record<string,string>>}
 */
export async function getConfigMany(keys) {
  if (!Array.isArray(keys) || !keys.length) return {};
  const { rows } = await query(
    `SELECT key, value FROM system_config WHERE key = ANY($1::text[])`,
    [keys],
  );
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * 단일 키 저장 (UPSERT).
 * @param {string} key
 * @param {string|number|boolean|null} value
 */
export async function setConfig(key, value) {
  const v = value == null ? null : String(value);
  await query(
    `INSERT INTO system_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, v],
  );
}

/**
 * 여러 키를 한 번에 (트랜잭션 X — 단순 luope).
 * @param {Record<string, string|number|boolean|null>} obj
 */
export async function setConfigMany(obj) {
  for (const [k, v] of Object.entries(obj)) {
    await setConfig(k, v);
  }
}

// ---------------------------------------------------------------------
// 타입 헬퍼
// ---------------------------------------------------------------------
export async function getBool(key, fallback = false) {
  const v = await getConfig(key);
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

export async function getInt(key, fallback = 0) {
  const v = await getConfig(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function getJson(key, fallback = null) {
  const v = await getConfig(key);
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export async function setJson(key, obj) {
  await setConfig(key, JSON.stringify(obj ?? {}));
}

// ---------------------------------------------------------------------
// daily_pdf_* 카운터 — Layer 4 deep parser 가 사용
// ---------------------------------------------------------------------
const KST = 'Asia/Seoul';

/**
 * 한국시간 기준 자정에 카운터를 초기화.
 * 매 호출마다 reset_at 과 오늘 날짜를 비교해서 다른 날이면 0 으로.
 * @returns {Promise<{limit:number, processed:number}>}
 */
export async function ensureDailyPdfCounter() {
  const cfg = await getConfigMany(['daily_pdf_limit', 'daily_pdf_processed', 'daily_pdf_reset_at']);
  const limit = Number(cfg.daily_pdf_limit ?? 10);
  const todayKst = new Date().toLocaleDateString('ko-KR', { timeZone: KST });
  const lastDay = cfg.daily_pdf_reset_at
    ? new Date(cfg.daily_pdf_reset_at).toLocaleDateString('ko-KR', { timeZone: KST })
    : '';
  if (lastDay !== todayKst) {
    await setConfigMany({
      daily_pdf_processed: '0',
      daily_pdf_reset_at:  new Date().toISOString(),
    });
    return { limit, processed: 0 };
  }
  return { limit, processed: Number(cfg.daily_pdf_processed ?? 0) };
}

/**
 * processed 카운터 +1. limit 초과 여부 함께 반환.
 * @returns {Promise<{processed:number, limit:number, exceeded:boolean}>}
 */
export async function incrementPdfProcessed(by = 1) {
  const { limit } = await ensureDailyPdfCounter();
  const { rows } = await query(
    `UPDATE system_config
        SET value = ((COALESCE(NULLIF(value,'')::int, 0) + $1)::text),
            updated_at = now()
      WHERE key = 'daily_pdf_processed'
      RETURNING value`,
    [by],
  );
  const processed = Number(rows[0]?.value ?? 0);
  return { processed, limit, exceeded: processed >= limit };
}

// ---------------------------------------------------------------------
// phase1 헬퍼
// ---------------------------------------------------------------------
export async function getPhase1State() {
  const cfg = await getConfigMany([
    'phase1_completed',
    'phase1_last_cursor',
    'phase1_collected_today',
    'phase1_start_time',
    'phase1_total_collected',
  ]);
  let cursor = {};
  try { cursor = cfg.phase1_last_cursor ? JSON.parse(cfg.phase1_last_cursor) : {}; }
  catch { cursor = {}; }
  return {
    completed:        String(cfg.phase1_completed ?? 'false').toLowerCase() === 'true',
    cursor,
    collectedToday:   Number(cfg.phase1_collected_today ?? 0),
    startTime:        cfg.phase1_start_time || '',
    totalCollected:   Number(cfg.phase1_total_collected ?? 0),
  };
}

export async function setPhase1State(patch = {}) {
  const map = {};
  if ('completed' in patch)        map.phase1_completed        = patch.completed ? 'true' : 'false';
  if ('cursor' in patch)           map.phase1_last_cursor      = JSON.stringify(patch.cursor ?? {});
  if ('collectedToday' in patch)   map.phase1_collected_today  = String(patch.collectedToday);
  if ('startTime' in patch)        map.phase1_start_time       = patch.startTime ?? '';
  if ('totalCollected' in patch)   map.phase1_total_collected  = String(patch.totalCollected);
  await setConfigMany(map);
}

/**
 * 한국시간 자정 기준으로 phase1_collected_today 와 phase1_start_time 을 초기화.
 * 이미 오늘이면 아무 것도 하지 않는다.
 */
export async function ensureTodayPhase1Window() {
  const st = await getPhase1State();
  const todayKst = new Date().toLocaleDateString('ko-KR', { timeZone: KST });
  const startedKst = st.startTime
    ? new Date(st.startTime).toLocaleDateString('ko-KR', { timeZone: KST })
    : '';
  if (startedKst !== todayKst) {
    await setPhase1State({
      collectedToday: 0,
      startTime: new Date().toISOString(),
    });
    return { reset: true, startTime: new Date().toISOString() };
  }
  return { reset: false, startTime: st.startTime };
}
