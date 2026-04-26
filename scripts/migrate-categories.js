import 'dotenv/config';
import { query, close } from '../src/lib/db.js';
import { analyzePaper } from '../src/lib/gemini.js';
import { loadTaxonomy } from '../src/lib/config.js';
import pLimit from 'p-limit';

async function migrate() {
  const taxonomy = await loadTaxonomy();
  const limit = pLimit(2); // 속도 제한 (429 방지)

  // 최신 수집된 논문부터 50건만 시범 재분류
  const { rows: papers } = await query(
    `SELECT id, title, abstract FROM research_papers 
     ORDER BY id DESC `
  );

  console.log(`🚀 ${papers.length}건의 논문 재분류 시작...`);

  const tasks = papers.map((p) => limit(async () => {
    try {
      const analysis = await analyzePaper({ title: p.title, abstract: p.abstract }, taxonomy);
      
      await query(
        `UPDATE research_papers SET 
          major_category = $1, 
          mid_category   = $2, 
          sub_category   = $3,
          summary_ko     = COALESCE(summary_ko, $4),
          updated_at     = now()
         WHERE id = $5`,
        [
          analysis.major_category,
          analysis.mid_category,
          analysis.sub_category,
          analysis.summary_ko,
          p.id
        ]
      );
      console.log(`✅ [ID ${p.id}] 분류 완료: ${analysis.major_category} > ${analysis.mid_category}`);
    } catch (err) {
      console.error(`❌ [ID ${p.id}] 실패:`, err.message);
    }
  }));

  await Promise.all(tasks);
  console.log('✨ 시범 재분류 완료.');
}

migrate().catch(console.error).finally(() => close());
