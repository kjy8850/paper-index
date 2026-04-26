// =====================================================================
// ChemRxiv 어댑터
// 공식 REST API: https://chemrxiv.org/engage/chemrxiv/public-api/v1/items
// 키워드 검색 + 페이지네이션.
// =====================================================================

import { request } from 'undici';
import { logger } from '../lib/logger.js';

const BASE = 'https://chemrxiv.org/engage/chemrxiv/public-api/v1/items';

/**
 * @param {Object} opts
 * @param {string} opts.query
 * @param {number} [opts.max=30]
 * @param {number} [opts.daysWindow]
 * @param {string} [opts.categoryHint]
 */
export async function searchChemRxiv({ query, max = 30, daysWindow, categoryHint }) {
  const limit = Math.min(50, max);
  const url   = `${BASE}?term=${encodeURIComponent(query)}&limit=${limit}&sort=PUBLISHED_DATE_DESC`;

  try {
    const { statusCode, body } = await request(url, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; paper-index/1.0)' },
      headersTimeout: 15_000, bodyTimeout: 30_000,
    });
    if (statusCode !== 200) {
      logger.warn({ statusCode }, 'ChemRxiv: non-200');
      return [];
    }
    const json = await body.json();
    const items = json?.itemHits ?? json?.items ?? [];
    const now = Date.now();
    const results = items.map((h) => normalize(h, categoryHint)).filter(Boolean);
    if (daysWindow && daysWindow > 0) {
      const cutoff = now - daysWindow * 86_400_000;
      return results.filter((r) => !r.published_at || new Date(r.published_at).getTime() >= cutoff);
    }
    return results;
  } catch (err) {
    logger.error({ err, query }, 'ChemRxiv 검색 실패');
    return [];
  }
}

function normalize(hit, categoryHint) {
  try {
    const item = hit?.item ?? hit;
    if (!item?.id) return null;
    const authors = Array.isArray(item.authors)
      ? item.authors.map((a) => [a.firstName, a.lastName].filter(Boolean).join(' '))
      : [];
    const doi     = item.doi ? String(item.doi).toLowerCase() : undefined;
    const pdf_url = item.asset?.original?.url ?? item.mainManuscript?.asset?.original?.url;
    return {
      source: 'chemrxiv',
      source_id: String(item.id),
      doi,
      title: (item.title ?? '').trim(),
      abstract: (item.abstract ?? '').trim(),
      authors,
      published_at: item.publishedDate ? item.publishedDate.slice(0, 10) : undefined,
      venue: 'ChemRxiv',
      url: `https://chemrxiv.org/engage/chemrxiv/article-details/${item.id}`,
      pdf_url,
      citations: 0,
      category_hint: categoryHint,
    };
  } catch (err) {
    logger.warn({ err }, 'ChemRxiv normalize 실패');
    return null;
  }
}
