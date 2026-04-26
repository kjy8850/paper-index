// =====================================================================
// Gemini text-embedding-004 래퍼 (768-dim).
// 재시도 + 동시성 제한 공유.
// =====================================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import pLimit from 'p-limit';
import { logger } from './logger.js';
import { query } from './db.js';

// gemini-embedding-001 단가: $0.15 / 1M tokens
const PRICE_PER_1M = 0.15;

async function recordUsage(inputTokens, model) {
  const cost = (inputTokens / 1_000_000) * PRICE_PER_1M;
  try {
    await query(
      `INSERT INTO api_usage (model, endpoint, is_batch, input_tokens, cost_usd, caller)
       VALUES ($1, 'embedContent', false, $2, $3, 'embedding')`,
      [model, inputTokens, cost],
    );
  } catch (_) {
    // 비용 기록 실패는 무시 (주 기능에 영향 없어야 함)
  }
}

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
 * 비정상 유니코드 문자 제거 (ByteString 에러 방지)
 */
function sanitizeText(text) {
  if (!text) return '';
  // 1) null 문자 제거
  // 2) 유효하지 않은 대리 쌍(surrogate pairs) 제거
  // 3) 비정상 문자(U+FFFD) 제거
  return text
    .replace(/\0/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '')
    .replace(/\uFFFD/g, '');
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
  const cleanText = sanitizeText(text).slice(0, 8000);
  if (!cleanText) return new Array(768).fill(0); // 빈 텍스트 방어

  return limit(() => withRetry(async () => {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.embedContent({
      content: { role: 'user', parts: [{ text: cleanText }] },
      taskType,
      outputDimensionality: 768,
    });
    const vec = result?.embedding?.values;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('empty embedding');
    }
    const inputTokens = result?.embedding?.metadata?.billableCharacterCount
      ? Math.ceil(result.embedding.metadata.billableCharacterCount / 4)
      : Math.ceil(text.length / 4);
    recordUsage(inputTokens, MODEL_NAME);
    return vec;
  }));
}

/**
 * 배치 임베딩. 내부적으로 한 건씩 처리(SDK 의 batchEmbedContents 는 개별 파싱 필요).
 */
export async function embedBatch(texts, taskType) {
  return Promise.all(texts.map((t) => embedText(t, taskType)));
}
