// =====================================================================
// Gemini 호출 스모크 테스트
// 사용법: node scripts/test-gemini.js
// =====================================================================

import 'dotenv/config';
import { analyzePaper } from '../src/lib/gemini.js';
import { embedText } from '../src/lib/embedding.js';
import { loadTaxonomy } from '../src/lib/config.js';

const sample = {
  title: 'A novel EUV photoresist based on metal-oxide nanoparticles with improved LER',
  abstract:
    'In this work, we report a new metal-oxide photoresist platform for extreme ultraviolet (EUV) ' +
    'lithography. By tuning the ligand chemistry of hafnium and zirconium oxoclusters, we achieve ' +
    'sub-12 nm line/space patterns with line edge roughness (LER) below 2 nm while maintaining ' +
    'sensitivity of 25 mJ/cm2. Outgassing and thermal stability are also characterized.',
};

const taxonomy = await loadTaxonomy();

console.log('🔬 analyzePaper 테스트...');
const analysis = await analyzePaper(sample, taxonomy);
console.log(JSON.stringify(analysis, null, 2));

console.log('\n🔬 embedText 테스트...');
const vec = await embedText(sample.title + '\n' + sample.abstract, 'RETRIEVAL_DOCUMENT');
console.log(`임베딩 차원: ${vec.length}, 첫 5개: [${vec.slice(0, 5).map((n) => n.toFixed(4)).join(', ')}]`);

process.exit(0);
