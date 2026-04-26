// =====================================================================
// 모든 소스를 한꺼번에 돌려서 1차 메모리 dedupe 후 PaperRef[] 반환.
//  - 메모리 dedupe 키: doi > arxiv_id > title_normalized > source+source_id
//  - DB 대조 dedupe 는 src/lib/dedupe.js 의 dedupeAgainstDb() 가 별도 수행.
// =====================================================================

import { searchArxiv }           from './arxiv.js';
import { searchSemanticScholar } from './semantic-scholar.js';
import { searchChemRxiv }        from './chemrxiv.js';
import { searchOpenAlex }        from './openalex.js';
import { logger }                from '../lib/logger.js';
import { finalizePaperRef }      from '../lib/normalize.js';

export { searchArxiv, searchSemanticScholar, searchChemRxiv, searchOpenAlex };

const ALL_FNS = {
  openalex:         searchOpenAlex,
  semantic_scholar: searchSemanticScholar,
  arxiv:            searchArxiv,
  chemrxiv:         searchChemRxiv,
};

/**
 * 하나의 키워드 세트로 N 개 소스 동시 검색.
 *
 * @param {Object} opts
 * @param {string}   opts.query
 * @param {number}   [opts.perSource=30]
 * @param {number}   [opts.daysWindow]
 * @param {string}   [opts.categoryHint]
 * @param {string[]} [opts.sources]   - 사용할 소스 이름. 기본: 모두.
 */
export async function searchAll({
  query, perSource = 30, daysWindow, categoryHint,
  sources = ['openalex', 'semantic_scholar', 'arxiv', 'chemrxiv'],
}) {
  const opts = { query, max: perSource, daysWindow, categoryHint };
  const tasks = sources
    .map((s) => ALL_FNS[s])
    .filter(Boolean)
    .map((fn) => fn(opts));

  const settled = await Promise.allSettled(tasks);
  const all = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      // arxiv/s2/chemrxiv 는 finalize 안 한 경우가 있으니 한 번 더 보정
      for (const ref of r.value) {
        const fin = ref?.title_normalized !== undefined ? ref : finalizePaperRef(ref);
        if (fin) all.push(fin);
      }
    } else {
      logger.warn({ source: sources[i], reason: r.reason?.message }, 'source 하나 실패');
    }
  }
  return dedupe(all);
}

/**
 * 메모리 dedupe (1 차).
 *  - doi 우선
 *  - 없으면 arxiv_id
 *  - 둘 다 없으면 title_normalized
 *  - 그것도 없으면 source+source_id
 */
export function dedupe(list) {
  const seenDoi   = new Set();
  const seenArxiv = new Set();
  const seenTitle = new Set();
  const seenSrc   = new Set();
  const out = [];

  for (const p of list) {
    if (p.doi) {
      const k = p.doi;
      if (seenDoi.has(k)) continue;
      seenDoi.add(k);
      out.push(p);
      continue;
    }
    if (p.arxiv_id) {
      const k = p.arxiv_id;
      if (seenArxiv.has(k)) continue;
      seenArxiv.add(k);
      out.push(p);
      continue;
    }
    if (p.title_normalized && p.title_normalized.length >= 10) {
      const k = p.title_normalized;
      if (seenTitle.has(k)) continue;
      seenTitle.add(k);
      out.push(p);
      continue;
    }
    const k = `${p.source}:${p.source_id}`;
    if (seenSrc.has(k)) continue;
    seenSrc.add(k);
    out.push(p);
  }
  return out;
}

export function dedupeKey(p) {
  if (p.doi)               return `doi:${p.doi}`;
  if (p.arxiv_id)          return `arxiv:${p.arxiv_id}`;
  if (p.title_normalized)  return `title:${p.title_normalized}`;
  return `${p.source}:${p.source_id}`;
}
