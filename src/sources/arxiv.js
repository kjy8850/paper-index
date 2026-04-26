// =====================================================================
// arXiv API 어댑터
// http://export.arxiv.org/api/query
// 정책: 3 sec / req
// =====================================================================

import { request } from 'undici';
import { parseStringPromise } from 'xml2js';
import { logger } from '../lib/logger.js';
import { withRateLimit } from '../lib/rate-limiter.js';
import { finalizePaperRef } from '../lib/normalize.js';

const BASE = 'https://export.arxiv.org/api/query';

/**
 * @typedef {Object} PaperRef
 * @property {string} source             'arxiv' | 'semantic_scholar' | 'chemrxiv' | 'openalex'
 * @property {string} source_id
 * @property {string=} doi
 * @property {string=} arxiv_id
 * @property {string} title
 * @property {string=} title_normalized   normalize.js 로 정규화된 제목 (dedupe 키)
 * @property {string=} abstract
 * @property {string[]} authors
 * @property {string=} published_at       'YYYY-MM-DD'
 * @property {string=} venue
 * @property {string=} url
 * @property {string=} pdf_url
 * @property {number=} citations
 * @property {string=} category_hint
 */

/**
 * arXiv 에서 키워드로 검색.
 * @param {Object} opts
 * @param {string} opts.query
 * @param {number} [opts.max=50]
 * @param {number} [opts.daysWindow]
 * @param {string} [opts.categoryHint]
 * @returns {Promise<PaperRef[]>}
 */
export async function searchArxiv({ query, max = 50, daysWindow, categoryHint }) {
  // 단어별 AND 검색 (exact phrase는 결과가 너무 적음)
  // arXiv API 는 `+AND+` 를 그대로 받으므로 encodeURIComponent 처리하지 않는다.
  const terms = query.replace(/"/g, '').trim().split(/\s+/);
  const q = terms.map(t => `all:${t}`).join('+AND+');
  const url = `${BASE}?search_query=${q}&start=0&max_results=${max}&sortBy=submittedDate&sortOrder=descending`;

  try {
    const xml = await withRateLimit('arxiv', async () => {
      const { statusCode, body } = await request(url, { headersTimeout: 15_000, bodyTimeout: 30_000 });
      if (statusCode !== 200) {
        logger.warn({ statusCode, url }, 'arXiv: non-200');
        return null;
      }
      return body.text();
    });
    if (!xml) return [];

    const parsed  = await parseStringPromise(xml, { explicitArray: false });
    const entries = parsed?.feed?.entry;
    if (!entries) return [];
    const list = Array.isArray(entries) ? entries : [entries];
    const now  = Date.now();

    const results = list.map((e) => normalize(e, categoryHint)).filter(Boolean);
    if (daysWindow && daysWindow > 0) {
      const cutoff = now - daysWindow * 86_400_000;
      return results.filter((r) => !r.published_at || new Date(r.published_at).getTime() >= cutoff);
    }
    return results;
  } catch (err) {
    logger.error({ err, query }, 'arXiv 검색 실패');
    return [];
  }
}

function normalize(entry, categoryHint) {
  try {
    const idUrl    = entry.id;
    const m        = /arxiv\.org\/abs\/([^\s]+?)(v\d+)?$/i.exec(idUrl ?? '');
    const arxivId  = m ? m[1] : null;
    if (!arxivId) return null;

    const links = Array.isArray(entry.link) ? entry.link : [entry.link];
    const pdf   = links.find((l) => l?.$?.type === 'application/pdf')?.$.href;
    const html  = links.find((l) => l?.$?.rel === 'alternate')?.$.href ?? idUrl;

    const authors = []
      .concat(entry.author ?? [])
      .map((a) => (typeof a === 'string' ? a : a?.name))
      .filter(Boolean);

    const ref = {
      source: 'arxiv',
      source_id: arxivId,
      arxiv_id: arxivId,
      doi: entry['arxiv:doi']?._ ?? entry['arxiv:doi'] ?? undefined,
      title: (entry.title ?? '').replace(/\s+/g, ' ').trim(),
      abstract: (entry.summary ?? '').trim(),
      authors,
      published_at: entry.published ? entry.published.slice(0, 10) : undefined,
      venue: 'arXiv',
      url: html,
      pdf_url: pdf,
      citations: 0,
      category_hint: categoryHint,
    };
    return finalizePaperRef(ref);
  } catch (err) {
    logger.warn({ err }, 'arXiv normalize 실패');
    return null;
  }
}
