// =====================================================================
// 소스별 레이트 리미터 (호출 간격 보장)
//
//  - arXiv:           3.0 sec / req  (정책)
//  - ChemRxiv:        0.2 sec / req  (5 req/sec)
//  - Semantic Scholar (API key 있음): 0.1 sec / req  (10 req/sec)
//  - Semantic Scholar (no key):        1.0 sec / req
//  - OpenAlex (polite pool, mailto 헤더): 0.1 sec / req  (10 req/sec)
//
// 사용:
//   import { withRateLimit } from '../lib/rate-limiter.js';
//   await withRateLimit('arxiv', async () => fetch(...));
// =====================================================================

const lastCallAt = new Map();        // key → epoch ms
const inflight   = new Map();        // key → Promise (직렬화)

const INTERVAL_MS = {
  arxiv:           3_000,
  chemrxiv:          200,
  semantic_scholar:
    process.env.SEMANTIC_SCHOLAR_API_KEY ? 100 : 1_000,
  openalex:          100,
};

/**
 * 키별로 최소 간격을 보장하며 fn 을 실행한다.
 * 같은 키의 호출은 직렬화된다 (한 번에 한 호출).
 *
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withRateLimit(key, fn) {
  // 이미 진행 중인 작업이 있으면 그 뒤에 줄선다.
  const previous = inflight.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    const interval = INTERVAL_MS[key] ?? 200;
    const now      = Date.now();
    const last     = lastCallAt.get(key) ?? 0;
    const wait     = Math.max(0, last + interval - now);
    if (wait > 0) await sleep(wait);
    lastCallAt.set(key, Date.now());
    return fn();
  });
  // 다음 호출이 기다릴 수 있도록 inflight 갱신 (실패해도 흐름은 이어감)
  inflight.set(key, next.catch(() => undefined));
  return next;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
