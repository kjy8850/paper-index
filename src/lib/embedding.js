// =====================================================================
// Gemini text-embedding-004 래퍼 (768-dim).
// 재시도 + 동시성 제한 공유.
// =====================================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import pLimit from 'p-limit';
import { logger } from './logger.js';

const API_KEY    = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_EMBED_MODEL ?? 'text-embedding-004';
const genAI      = new GoogleGenerativeAI(API_KEY ?? 'MISSING');

const limit = pLimit(Number(process.env.GEMINI_CONCURRENCY ?? 3));

async function withRetry(fn, retries = 4) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message ?? err);
      const transient = /429|rate|quota|503|UNAVAILABLE|network|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!transient || attempt >= retries) throw err;
      const backoff = 400 * Math.pow(2, attempt) + Math.random() * 200;
      logger.warn({ attempt, backoff, err: msg }, 'embedding 일시 실패, 재시도');
      await new Promise((r) => setTimeout(r, backoff));
      attempt += 1;
    }
  }
}

/**
 * 텍스트 1건 임베딩.
 * @param {string} text
 * @param {'RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY'|'SEMANTIC_SIMILARITY'} [taskType]
 * @returns {Promise<number[]>} 768 dim
 */
export async function embedText(text, taskType = 'RETRIEVAL_DOCUMENT') {
  if (!text || typeof text !== 'string') {
    throw new Error('embedText: invalid text');
  }
  return limit(() => withRetry(async () => {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.embedContent({
      content: { role: 'user', parts: [{ text: text.slice(0, 8000) }] },
      taskType,
    });
    const vec = result?.embedding?.values;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('empty embedding');
    }
    return vec;
  }));
}

/**
 * 배치 임베딩. 내부적으로 한 건씩 처리(SDK 의 batchEmbedContents 는 개별 파싱 필요).
 */
export async function embedBatch(texts, taskType) {
  return Promise.all(texts.map((t) => embedText(t, taskType)));
}
