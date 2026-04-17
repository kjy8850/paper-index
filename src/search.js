// =====================================================================
// 검색 엔진
// 1) 사용자 질문을 재작성(영문 쿼리 + major 후보) — Gemini.
// 2) 질문 임베딩 (RETRIEVAL_QUERY).
// 3) major/mid 필터 (선택) + HNSW 코사인 거리 상위 K.
// 4) Gemini 로 최종 답변 합성.
// =====================================================================

import 'dotenv/config';
import { z } from 'zod';
import { logger, childLogger } from './lib/logger.js';
import { query, toVectorLiteral } from './lib/db.js';
import { embedText } from './lib/embedding.js';
import { rewriteQueryForSearch, synthesizeAnswer } from './lib/gemini.js';
import { loadTaxonomy } from './lib/config.js';

// HNSW 검색 품질 파라미터
const DEFAULT_EF = 100;

export const SearchOptsSchema = z.object({
  question: z.string().min(2),
  top_k:    z.number().int().positive().max(50).default(8),
  majors:   z.array(z.string()).optional(),  // 사용자가 명시하면 우선.
  min_relevance: z.number().int().min(0).max(10).default(0),
  with_answer: z.boolean().default(true),    // false 면 스니펫만 반환.
});

/**
 * @param {z.infer<typeof SearchOptsSchema>} opts
 */
export async function searchPapers(opts) {
  const o = SearchOptsSchema.parse(opts);
  const log = childLogger({ mod: 'search' });
  const t0 = Date.now();

  const taxonomy = await loadTaxonomy();

  // 1) 쿼리 재작성
  let rewritten = o.question;
  let majorsAuto = [];
  try {
    const rq = await rewriteQueryForSearch(o.question, taxonomy);
    rewritten  = rq.rewritten;
    majorsAuto = rq.majors;
  } catch (err) {
    log.warn({ err: err.message }, '쿼리 재작성 실패, 원문 사용');
  }
  const majors = (o.majors?.length ? o.majors : majorsAuto) ?? [];

  // 2) 임베딩
  const vec = await embedText(rewritten, 'RETRIEVAL_QUERY');
  const vecLit = toVectorLiteral(vec);

  // 3) 벡터 검색 (B-Tree 필터 + HNSW)
  await query('SET LOCAL hnsw.ef_search = $1', [DEFAULT_EF]).catch(() => {});
  // ↑ 트랜잭션 밖에서는 LOCAL 이 무시됨. 풀 커넥션별로 다르므로 실패해도 무시.

  const filters = [];
  const params = [vecLit];
  let idx = 2;
  if (majors.length) {
    filters.push(`major_category = ANY($${idx}::text[])`);
    params.push(majors);
    idx += 1;
  }
  if (o.min_relevance > 0) {
    filters.push(`relevance_score >= $${idx}`);
    params.push(o.min_relevance);
    idx += 1;
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const sql = `
    SELECT id, doi, arxiv_id, source, url, pdf_url,
           title, abstract, authors, published_at, venue, citations,
           summary_ko, key_findings, materials, techniques, tags,
           major_category, mid_category, sub_category,
           novelty_score, relevance_score,
           (embedding <=> $1::vector) AS distance
    FROM research_papers
    ${where}
    ORDER BY embedding <=> $1::vector
    LIMIT ${o.top_k};
  `;

  const { rows } = await query(sql, params);
  const snippets = rows.map((r) => ({
    id: r.id,
    doi: r.doi,
    arxiv_id: r.arxiv_id,
    source: r.source,
    url: r.url,
    pdf_url: r.pdf_url,
    title: r.title,
    summary_ko: r.summary_ko,
    key_findings: r.key_findings,
    materials: r.materials,
    techniques: r.techniques,
    tags: r.tags,
    major: r.major_category,
    mid: r.mid_category,
    sub: r.sub_category,
    published_at: r.published_at,
    venue: r.venue,
    citations: r.citations,
    novelty_score: r.novelty_score,
    relevance_score: r.relevance_score,
    similarity: 1 - Number(r.distance),
  }));

  // 4) 답변 합성 (옵션)
  let answer = null;
  if (o.with_answer && snippets.length) {
    try {
      answer = await synthesizeAnswer(o.question, snippets);
    } catch (err) {
      log.warn({ err: err.message }, '답변 합성 실패');
    }
  }

  const latency_ms = Date.now() - t0;
  // 검색 로그
  try {
    await query(
      `INSERT INTO search_log (question, filter_major, top_k, latency_ms, result_ids)
       VALUES ($1, $2, $3, $4, $5)`,
      [o.question, majors.join(',') || null, o.top_k, latency_ms, snippets.map((s) => s.id)],
    );
  } catch { /* ignore */ }

  return {
    question: o.question,
    rewritten,
    majors,
    latency_ms,
    count: snippets.length,
    answer,
    snippets,
  };
}

// =====================================================================
// CLI 단독 실행: node src/search.js "질문"
// =====================================================================
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const q = process.argv.slice(2).join(' ').trim();
  if (!q) {
    console.error('사용법: node src/search.js "검색할 질문"');
    process.exit(2);
  }
  searchPapers({ question: q })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((err) => { logger.error({ err }, '검색 실패'); process.exit(1); });
}
