import { logger } from './logger.js';

const DOCLING_URL = process.env.DOCLING_URL ?? 'http://localhost:8089';
const TIMEOUT_MS  = Number(process.env.DOCLING_TIMEOUT_MS ?? 240_000);  // 4 min

/**
 * PDF Buffer를 docling-svc에 보내 Markdown으로 변환.
 * @returns {{ markdown: string, pages: number, tables: number, figures: number, elapsed_ms: number }}
 */
export async function convertPdf(pdfBuffer) {
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'paper.pdf');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${DOCLING_URL}/convert`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`docling-svc error: ${body?.detail?.error ?? JSON.stringify(body)}`);
  }

  logger.debug({ pages: body.pages, elapsed_ms: body.elapsed_ms }, 'docling convert done');
  return body;
}
