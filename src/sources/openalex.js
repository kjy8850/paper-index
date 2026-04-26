// =====================================================================
// OpenAlex 어댑터
// https://api.openalex.org/works
// - mailto 파라미터로 polite pool 사용 (Rate limit 10 req/sec)
// - cursor 기반 페이지네이션 (max 페이지 limit)
// - abstract 는 inverted_index 형태로 옴 → 평문 복원 필요
// =====================================================================

import { request } from 'undici';
import { logger } from '../lib/logger.js';
import { withRateLimit } from '../lib/rate-limiter.js';
import { finalizePaperRef } from '../lib/normalize.js';

const BASE = 'https://api.openalex.org/works';

/**
 * @param {Object} opts
 * @param {string} opts.query         - keyword / phrase
 * @param {number} [opts.max=30]      - 결과 최대 개수 (cursor 로 합산)
 * @param {number} [opts.daysWindow]  - 최근 N 일 내만 (from_publication_date)
 * @param {string} [opts.categoryHint]
 */
export async function searchOpenAlex({ query, max = 30, daysWindow, categoryHint }) {
  const mailto = process.env.OPENALEX_EMAIL || 'almexf88@gmail.com';
  const perPage = Math.min(50, Math.max(10, max));
  const wantTotal = Math.max(1, Math.min(200, max));

  // 필터: search=query (제목+초록+full_text), from_publication_date
  const filters = [];
  if (daysWindow && daysWindow > 0) {
    const cutoff = new Date(Date.now() - daysWindow * 86_400_000);
    filters.push(`from_publication_date:${cutoff.toISOString().slice(0, 10)}`);
  }
  // 너무 오래된 출판물 제외 (기본: 최근 5년)
  if (filters.every((f) => !f.startsWith('from_publication_date'))) {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 5);
    filters.push(`from_publication_date:${cutoff.toISOString().slice(0, 10)}`);
  }

  const baseParams = new URLSearchParams({
    search: query,
    'per-page': String(perPage),
    sort: 'publication_date:desc',
    mailto,
  });
  if (filters.length) baseParams.set('filter', filters.join(','));

  const out = [];
  let cursor = '*';
  let pages  = 0;

  try {
    while (out.length < wantTotal && cursor && pages < 6) {
      const params = new URLSearchParams(baseParams);
      params.set('cursor', cursor);
      const url = `${BASE}?${params.toString()}`;

      const json = await withRateLimit('openalex', async () => {
        const { statusCode, body } = await request(url, {
          headers: { accept: 'application/json' },
          headersTimeout: 15_000, bodyTimeout: 30_000,
        });
        if (statusCode === 429) {
          logger.warn('OpenAlex 429 — rate limited');
          return null;
        }
        if (statusCode !== 200) {
          logger.warn({ statusCode }, 'OpenAlex: non-200');
          return null;
        }
        return body.json();
      });
      if (!json) break;

      const works = Array.isArray(json.results) ? json.results : [];
      for (const w of works) {
        const ref = normalize(w, categoryHint);
        if (ref) out.push(ref);
        if (out.length >= wantTotal) break;
      }
      cursor = json?.meta?.next_cursor ?? null;
      pages++;
      if (works.length === 0) break;
    }
  } catch (err) {
    logger.error({ err, query }, 'OpenAlex 검색 실패');
  }

  return out;
}

/**
 * OpenAlex Work → PaperRef
 */
function normalize(w, categoryHint) {
  try {
    if (!w?.id) return null;
    // id: https://openalex.org/W123456789  →  W123456789
    const oaId = String(w.id).replace(/^https?:\/\/openalex\.org\//i, '');

    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : undefined;
    const arxivId = extractArxivId(w);

    // OpenAlex 의 abstract 는 inverted_index 형태 → 평문 복원
    const abstract = invertedIndexToText(w.abstract_inverted_index) ?? '';

    const authors = Array.isArray(w.authorships)
      ? w.authorships.map((a) => a?.author?.display_name).filter(Boolean)
      : [];

    const oaPdf = w.best_oa_location?.pdf_url || w.primary_location?.pdf_url || w.open_access?.oa_url;

    const ref = {
      source: 'openalex',
      source_id: oaId,
      doi,
      arxiv_id: arxivId,
      title: (w.title ?? w.display_name ?? '').trim(),
      abstract,
      authors,
      published_at: w.publication_date ?? (w.publication_year ? `${w.publication_year}-01-01` : undefined),
      venue: w.primary_location?.source?.display_name ?? w.host_venue?.display_name ?? undefined,
      url: w.id,
      pdf_url: oaPdf || undefined,
      citations: Number.isFinite(w.cited_by_count) ? w.cited_by_count : 0,
      category_hint: categoryHint,
    };
    return finalizePaperRef(ref);
  } catch (err) {
    logger.warn({ err }, 'OpenAlex normalize 실패');
    return null;
  }
}

/**
 * inverted_index { word: [pos1, pos2, ...] } → 평문 문자열.
 */
function invertedIndexToText(idx) {
  if (!idx || typeof idx !== 'object') return undefined;
  /** @type {Array<[number, string]>} */
  const tokens = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (Number.isFinite(p)) tokens.push([p, word]);
    }
  }
  if (!tokens.length) return undefined;
  tokens.sort((a, b) => a[0] - b[0]);
  return tokens.map(([, w]) => w).join(' ').trim();
}

function extractArxivId(w) {
  // OpenAlex 의 ids.arxiv 또는 primary_location.landing_page_url 에 가끔 들어있음.
  if (w.ids?.arxiv) {
    const s = String(w.ids.arxiv);
    const m = /(?:arxiv\.org\/abs\/|arXiv:)([^\s]+?)(?:v\d+)?$/i.exec(s);
    if (m) return m[1];
  }
  const lp = w.primary_location?.landing_page_url ?? '';
  const m  = /arxiv\.org\/abs\/([^?#\s]+?)(?:v\d+)?$/i.exec(lp);
  if (m) return m[1];
  return undefined;
}
