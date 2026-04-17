// =====================================================================
// Semantic Scholar Graph API
// https://api.semanticscholar.org/graph/v1/paper/search
// API key 없어도 호출 가능하나 Rate limit 낮음.
// =====================================================================

import { request } from 'undici';
import { logger } from '../lib/logger.js';

const BASE = 'https://api.semanticscholar.org/graph/v1/paper/search';
const FIELDS = [
  'title', 'abstract', 'authors', 'year', 'publicationDate',
  'venue', 'externalIds', 'url', 'openAccessPdf', 'citationCount',
].join(',');

/**
 * @param {Object} opts
 * @param {string} opts.query
 * @param {number} [opts.max=30]
 * @param {number} [opts.daysWindow]
 * @param {string} [opts.categoryHint]
 */
export async function searchSemanticScholar({ query, max = 30, daysWindow, categoryHint }) {
  const limit = Math.min(100, max);
  const url   = `${BASE}?query=${encodeURIComponent(query)}&limit=${limit}&fields=${encodeURIComponent(FIELDS)}`;
  const headers = { 'accept': 'application/json' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  try {
    const { statusCode, body } = await request(url, {
      headers, headersTimeout: 15_000, bodyTimeout: 30_000,
    });
    if (statusCode === 429) {
      logger.warn('Semantic Scholar 429 — rate limited');
      return [];
    }
    if (statusCode !== 200) {
      logger.warn({ statusCode }, 'Semantic Scholar: non-200');
      return [];
    }
    const json = await body.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    const now = Date.now();
    const results = data.map((p) => normalize(p, categoryHint)).filter(Boolean);
    if (daysWindow && daysWindow > 0) {
      const cutoff = now - daysWindow * 86_400_000;
      return results.filter((r) => !r.published_at || new Date(r.published_at).getTime() >= cutoff);
    }
    return results;
  } catch (err) {
    logger.error({ err, query }, 'Semantic Scholar 검색 실패');
    return [];
  }
}

function normalize(p, categoryHint) {
  try {
    const doi    = p.externalIds?.DOI;
    const arxiv  = p.externalIds?.ArXiv;
    const id     = p.paperId;
    if (!id) return null;
    const authors = Array.isArray(p.authors) ? p.authors.map((a) => a?.name).filter(Boolean) : [];
    return {
      source: 'semantic_scholar',
      source_id: id,
      doi: doi ? doi.toLowerCase() : undefined,
      arxiv_id: arxiv ?? undefined,
      title: (p.title ?? '').trim(),
      abstract: (p.abstract ?? '').trim(),
      authors,
      published_at: p.publicationDate ?? (p.year ? `${p.year}-01-01` : undefined),
      venue: p.venue ?? undefined,
      url: p.url,
      pdf_url: p.openAccessPdf?.url,
      citations: Number.isFinite(p.citationCount) ? p.citationCount : 0,
      category_hint: categoryHint,
    };
  } catch (err) {
    logger.warn({ err }, 'Semantic Scholar normalize 실패');
    return null;
  }
}
