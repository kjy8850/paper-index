// =====================================================================
// 모든 소스를 한꺼번에 돌려서 중복 제거된 PaperRef[] 반환.
// 중복 키 우선순위: doi > arxiv_id > source+source_id
// =====================================================================

import { searchArxiv }           from './arxiv.js';
import { searchSemanticScholar } from './semantic-scholar.js';
import { searchChemRxiv }        from './chemrxiv.js';
import { logger }                from '../lib/logger.js';

export { searchArxiv, searchSemanticScholar, searchChemRxiv };

/**
 * 하나의 키워드 세트로 세 소스 동시 검색.
 */
export async function searchAll({ query, perSource = 30, daysWindow, categoryHint }) {
  const opts = { query, max: perSource, daysWindow, categoryHint };
  const settled = await Promise.allSettled([
    searchArxiv(opts),
    searchSemanticScholar(opts),
    searchChemRxiv(opts),
  ]);
  const all = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else logger.warn({ reason: r.reason?.message }, 'source 하나 실패');
  }
  return dedupe(all);
}

export function dedupe(list) {
  const seen = new Set();
  const out  = [];
  for (const p of list) {
    const key = dedupeKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function dedupeKey(p) {
  if (p.doi)      return `doi:${p.doi.toLowerCase()}`;
  if (p.arxiv_id) return `arxiv:${p.arxiv_id}`;
  return `${p.source}:${p.source_id}`;
}
