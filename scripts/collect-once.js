// =====================================================================
// n8n 없이 한 번만 수집 + 색인 테스트
// 사용법: node scripts/collect-once.js [쿼리] [건수]
// =====================================================================

import 'dotenv/config';
import { searchAll } from '../src/sources/index.js';
import { handleBatch } from '../src/ingest.js';
import { close } from '../src/lib/db.js';

const q     = process.argv[2] ?? 'EUV photoresist resin';
const count = Number(process.argv[3] ?? 10);

console.log(`🔎 "${q}" 로 ${count} 건 수집 중...`);
const refs = await searchAll({ query: q, perSource: Math.ceil(count / 2) });
const slice = refs.slice(0, count);
console.log(`→ 중복 제거 후 ${slice.length} 건. Gemini 분석 시작...`);
const res = await handleBatch(slice);
console.log(JSON.stringify(res, null, 2));
await close();
