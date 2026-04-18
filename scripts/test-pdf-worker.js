// 단일 논문 pdf-worker 드라이런 (검증용)
// 사용법: node scripts/test-pdf-worker.js --id <paper_id>

import 'dotenv/config';
import { query, close } from '../src/lib/db.js';
import { fetchPdf } from '../src/lib/pdf-fetch.js';
import { convertPdf } from '../src/lib/docling-client.js';
import { logger } from '../src/lib/logger.js';

const args = process.argv.slice(2);
const idIdx = args.indexOf('--id');
const paperId = idIdx >= 0 ? Number(args[idIdx + 1]) : null;

if (!paperId) {
  console.error('Usage: node scripts/test-pdf-worker.js --id <paper_id>');
  process.exit(1);
}

async function run() {
  const { rows } = await query(
    `SELECT id, title, pdf_url, fulltext_status FROM research_papers WHERE id=$1`,
    [paperId]
  );
  if (!rows[0]) {
    console.error(`Paper ${paperId} not found`);
    process.exit(1);
  }

  const paper = rows[0];
  console.log(`\n📄 Paper ${paper.id}: ${paper.title?.slice(0, 80)}`);
  console.log(`   pdf_url: ${paper.pdf_url ?? '(none)'}`);
  console.log(`   status:  ${paper.fulltext_status}\n`);

  if (!paper.pdf_url) {
    console.error('No pdf_url — cannot test');
    process.exit(1);
  }

  console.log('1. Fetching PDF...');
  const buf = await fetchPdf(paper.pdf_url);
  console.log(`   ✅ ${(buf.length / 1024).toFixed(0)} KB`);

  console.log('2. Converting with docling-svc...');
  const result = await convertPdf(buf);
  console.log(`   ✅ pages=${result.pages} tables=${result.tables} figures=${result.figures} elapsed=${result.elapsed_ms}ms md_len=${result.markdown.length}`);

  console.log('\n✅ 드라이런 완료 — DB 는 변경하지 않음\n');
  await close();
}

run().catch((err) => {
  logger.error({ err }, 'test-pdf-worker failed');
  process.exit(1);
});
