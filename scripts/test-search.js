// =====================================================================
// 검색 스모크 테스트
// 사용법: node scripts/test-search.js "EUV 레지스트에서 LER 낮추는 방법"
// =====================================================================

import 'dotenv/config';
import { searchPapers } from '../src/search.js';

const q = process.argv.slice(2).join(' ').trim() || 'EUV 레지스트에서 LER 낮추는 방법';
const res = await searchPapers({ question: q, top_k: 5 });
console.log(JSON.stringify(res, null, 2));
process.exit(0);
