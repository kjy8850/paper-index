// =====================================================================
// 제목 정규화 + 공통 정규화 유틸
// 메모리 dedupe 와 DB title_normalized 컬럼 양쪽에서 동일 사용.
// =====================================================================

/**
 * 제목 정규화
 *  1) lowercase
 *  2) 모든 비-ASCII 알파누메릭 문자를 공백 처리
 *  3) 다중 공백 → 단일 공백
 *  4) trim
 *  5) 너무 짧으면 (<10자) 빈 문자열로 처리 → 매칭에서 제외
 *
 * @param {string|null|undefined} title
 * @returns {string} 정규화된 제목 ('' 면 매칭에서 제외)
 */
export function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  const cleaned = title
    .toLowerCase()
    .normalize('NFKD')
    // diacritic 제거
    .replace(/[\u0300-\u036f]/g, '')
    // 모든 비-알파누메릭 → 공백
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 10) return '';
  return cleaned;
}

/**
 * DOI 정규화: lowercase + 앞 'https://doi.org/' / 'doi:' 제거.
 * @param {string|null|undefined} doi
 * @returns {string|undefined}
 */
export function normalizeDoi(doi) {
  if (!doi || typeof doi !== 'string') return undefined;
  let d = doi.trim().toLowerCase();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  d = d.replace(/^doi:\s*/, '');
  return d || undefined;
}

/**
 * arxiv_id 정규화: 'arxiv:1234.5678v2' → '1234.5678'
 * @param {string|null|undefined} aid
 * @returns {string|undefined}
 */
export function normalizeArxivId(aid) {
  if (!aid || typeof aid !== 'string') return undefined;
  let s = aid.trim();
  s = s.replace(/^arxiv:\s*/i, '');
  s = s.replace(/^https?:\/\/arxiv\.org\/abs\//i, '');
  s = s.replace(/v\d+$/i, '');
  return s || undefined;
}

/**
 * 출판일 정규화: 'YYYY-MM-DD' 만 반환 (없으면 undefined).
 * @param {string|null|undefined} d
 * @returns {string|undefined}
 */
export function normalizeDate(d) {
  if (!d) return undefined;
  if (typeof d !== 'string') return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(d);
  if (!m) return undefined;
  const yyyy = m[1];
  const mm   = m[2] ?? '01';
  const dd   = m[3] ?? '01';
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * PaperRef 후처리: title_normalized, doi/arxiv_id/published_at 정리.
 * 기존 source 어댑터들의 출력에 일괄 적용.
 *
 * @param {Object} ref
 * @returns {Object} 같은 키를 갖되 정규화된 PaperRef
 */
export function finalizePaperRef(ref) {
  if (!ref) return null;
  const doi      = normalizeDoi(ref.doi);
  const arxiv_id = normalizeArxivId(ref.arxiv_id);
  const title    = (ref.title ?? '').replace(/\s+/g, ' ').trim();
  const title_normalized = normalizeTitle(title);
  return {
    ...ref,
    title,
    title_normalized,
    doi,
    arxiv_id,
    published_at: normalizeDate(ref.published_at),
  };
}
