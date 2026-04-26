// =====================================================================
// DB 2차 중복 제거.
// papers_history(완료) + papers_excluded(제외 처리) + papers_staging(처리 대기)
// 3 개 테이블에 동일 식별자가 있으면 신규 수집에서 제외.
//
// 식별자 우선순위는 메모리 dedupe(src/sources/index.js)와 일치:
//   doi > arxiv_id > title_normalized
// (source+source_id 는 staging 만 의미가 있어 별도로 다루지 않음.)
//
// 한 번의 쿼리로 묶어 보내 DB 라운드트립을 줄인다.
// =====================================================================

import { query } from './db.js';

/**
 * @typedef {Object} StageRef
 *  - PaperRef 의 핵심 dedupe 키만 남긴 형태.
 * @property {string=} doi
 * @property {string=} arxiv_id
 * @property {string=} title_normalized
 */

/**
 * 후보 PaperRef[] 에서 DB 에 이미 존재하는 것을 골라낸다.
 *
 * 반환:
 *   - kept     : DB 에 없어 staging 으로 보내도 되는 ref 들
 *   - excluded : 3-테이블 중 어딘가에 있어 제외된 ref 들 (디버깅용)
 *
 * @param {Array<Object>} refs   - finalizePaperRef 가 적용된 PaperRef[]
 */
export async function dedupeAgainstDb(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { kept: [], excluded: [] };
  }

  const dois     = collectDistinct(refs, 'doi');
  const arxivIds = collectDistinct(refs, 'arxiv_id');
  const titles   = collectDistinct(refs, 'title_normalized', 10); // 너무 짧은 정규화 제목은 매칭 위험

  // 어느 키든 존재하면 즉시 제외.
  // UNION ALL 로 3 개 테이블 / 3 개 키 9 조합을 한꺼번에 가져오고
  // JS 측에서 Set 으로 빠르게 비교한다.
  const seen = await fetchSeenSets({ dois, arxivIds, titles });

  const kept = [];
  const excluded = [];
  for (const r of refs) {
    if (r.doi && seen.dois.has(r.doi)) {
      excluded.push({ ref: r, by: 'doi' });
      continue;
    }
    if (r.arxiv_id && seen.arxivIds.has(r.arxiv_id)) {
      excluded.push({ ref: r, by: 'arxiv_id' });
      continue;
    }
    if (r.title_normalized && r.title_normalized.length >= 10
        && seen.titles.has(r.title_normalized)) {
      excluded.push({ ref: r, by: 'title' });
      continue;
    }
    kept.push(r);
  }
  return { kept, excluded };
}

function collectDistinct(refs, key, minLen = 1) {
  const set = new Set();
  for (const r of refs) {
    const v = r[key];
    if (typeof v === 'string' && v.length >= minLen) set.add(v);
  }
  return Array.from(set);
}

/**
 * 3 개 테이블에서 매칭되는 식별자만 모아 Set 으로 반환.
 * 빈 배열 입력은 알아서 SQL 에서 빠진다.
 */
async function fetchSeenSets({ dois, arxivIds, titles }) {
  const out = {
    dois:     new Set(),
    arxivIds: new Set(),
    titles:   new Set(),
  };

  if (!dois.length && !arxivIds.length && !titles.length) return out;

  const tables = ['papers_history', 'papers_excluded', 'papers_staging'];
  const subqueries = [];
  const params = [];
  let p = 1;

  // doi
  if (dois.length) {
    const idx = p; p += 1;
    params.push(dois);
    for (const t of tables) {
      subqueries.push(`SELECT 'doi' AS kind, doi AS val FROM ${t} WHERE doi = ANY($${idx}::text[])`);
    }
  }
  // arxiv_id
  if (arxivIds.length) {
    const idx = p; p += 1;
    params.push(arxivIds);
    for (const t of tables) {
      subqueries.push(`SELECT 'arxiv_id' AS kind, arxiv_id AS val FROM ${t} WHERE arxiv_id = ANY($${idx}::text[])`);
    }
  }
  // title_normalized
  if (titles.length) {
    const idx = p; p += 1;
    params.push(titles);
    for (const t of tables) {
      subqueries.push(`SELECT 'title' AS kind, title_normalized AS val FROM ${t} WHERE title_normalized = ANY($${idx}::text[])`);
    }
  }

  const sql = subqueries.join(' UNION ALL ');
  const { rows } = await query(sql, params);

  for (const row of rows) {
    if (!row.val) continue;
    if (row.kind === 'doi')      out.dois.add(row.val);
    else if (row.kind === 'arxiv_id') out.arxivIds.add(row.val);
    else if (row.kind === 'title')    out.titles.add(row.val);
  }
  return out;
}
