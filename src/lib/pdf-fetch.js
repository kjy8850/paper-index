import { logger } from './logger.js';

const DEFAULT_MAX_BYTES = Number(process.env.PDF_MAX_BYTES ?? 52_428_800);      // 50 MB
const DEFAULT_TIMEOUT_MS = Number(process.env.PDF_FETCH_TIMEOUT_MS ?? 60_000);  // 60 s

/**
 * PDF URL에서 바이너리를 받아 Buffer로 반환.
 * 크기·타임아웃 초과 시 오류.
 */
export async function fetchPdf(url, {
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'paper-index-pdf-worker/1.0' },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching PDF: ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    logger.warn({ url, contentType }, 'pdf-fetch: unexpected content-type');
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) {
      throw new Error(`PDF exceeds ${maxBytes} bytes: ${url}`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}
