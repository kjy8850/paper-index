// =====================================================================
// Gemini Flash 래퍼.
// - 구조화 출력(JSON) 기본.
// - 재시도(지수 백오프) + 동시성 제한.
// - 입력이 매우 길면 abstract 기반 모드로 자동 폴백.
// =====================================================================

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import pLimit from 'p-limit';
import { logger } from './logger.js';

const API_KEY    = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_GEN_MODEL ?? 'gemini-2.5-flash';

if (!API_KEY) {
  logger.warn('GEMINI_API_KEY 가 비어있습니다. 이 상태로는 Gemini 호출이 실패합니다.');
}

const genAI = new GoogleGenerativeAI(API_KEY ?? 'MISSING');

// 동시 호출 수 제한 (429 방지)
const concurrency = Number(process.env.GEMINI_CONCURRENCY ?? 3);
const limit       = pLimit(concurrency);

// 최소 호출 간격
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 400);
let lastCallAt = 0;

async function throttleGate() {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// =====================================================================
// 논문 분석 결과 스키마
//  - Gemini responseSchema 로 구조화된 JSON 강제.
//  - 스코어는 0-10 정수, 분류는 taxonomy 의 major id 중에서만 고르게 유도.
// =====================================================================
const paperAnalysisSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary_ko:      { type: SchemaType.STRING, description: '한글 3-4줄 요약' },
    key_findings:    { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: '핵심 발견/기여 리스트' },
    materials:       { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: '언급된 주요 소재/화합물' },
    techniques:      { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: '분석·공정·측정 기법' },
    major_category:  { type: SchemaType.STRING, description: "['resin','pr','develop_etch','litho','metrology','misc_semi','novel_idea'] 중 하나" },
    mid_category:    { type: SchemaType.STRING, description: '중분류 (제시된 예시 중 우선 선택, 없으면 신규)' },
    sub_category:    { type: SchemaType.STRING, description: '소분류 (제시된 예시 중 우선 선택, 없으면 신규)' },
    tags:            { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, description: '자유 태그 3-6개' },
    novelty_score:   { type: SchemaType.INTEGER, description: '신선도/독창성 0-10' },
    relevance_score: { type: SchemaType.INTEGER, description: '반도체 소재 관련성 0-10' },
  },
  required: [
    'summary_ko', 'key_findings', 'major_category',
    'mid_category', 'novelty_score', 'relevance_score',
  ],
};

const ALLOWED_MAJORS = new Set([
  'resin', 'pr', 'develop_etch', 'litho', 'metrology', 'misc_semi', 'novel_idea',
]);

function sanitizeAnalysis(obj) {
  const clean = { ...obj };
  if (!ALLOWED_MAJORS.has(clean.major_category)) clean.major_category = 'misc_semi';
  clean.novelty_score   = clampInt(clean.novelty_score, 0, 10);
  clean.relevance_score = clampInt(clean.relevance_score, 0, 10);
  clean.key_findings = Array.isArray(clean.key_findings) ? clean.key_findings.slice(0, 10) : [];
  clean.materials    = Array.isArray(clean.materials)    ? clean.materials.slice(0, 20)    : [];
  clean.techniques   = Array.isArray(clean.techniques)   ? clean.techniques.slice(0, 20)   : [];
  clean.tags         = Array.isArray(clean.tags)         ? clean.tags.slice(0, 10)         : [];
  return clean;
}

function clampInt(v, lo, hi) {
  const n = Number.isFinite(+v) ? Math.round(+v) : 0;
  return Math.max(lo, Math.min(hi, n));
}

// =====================================================================
// 재시도
// =====================================================================
async function withRetry(fn, { retries = 4, label = 'gemini' } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      await throttleGate();
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      // 429/503 같은 일시 오류만 재시도
      const transient = /429|rate|quota|503|UNAVAILABLE|network|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!transient || attempt === retries) break;
      const backoff = 500 * Math.pow(2, attempt) + Math.random() * 200;
      logger.warn({ attempt, backoff, err: msg, label }, 'Gemini 호출 일시 실패, 재시도');
      await new Promise((r) => setTimeout(r, backoff));
      attempt += 1;
    }
  }
  throw lastErr;
}

// =====================================================================
// 공개 API
// =====================================================================

/**
 * 논문 메타 + 초록(+옵션 PDF 본문 텍스트)으로 분석 JSON 생성.
 *
 * @param {Object} paper
 * @param {string} paper.title
 * @param {string} paper.abstract
 * @param {string} [paper.fullText]   pdf-parse 등으로 추출된 본문. 있으면 더 풍부.
 * @param {Object} taxonomy           config/taxonomy.json 로드된 객체
 * @returns {Promise<Object>} sanitized analysis
 */
export async function analyzePaper(paper, taxonomy) {
  return limit(() => withRetry(async () => {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: paperAnalysisSchema,
      },
    });

    const taxonomyHint = JSON.stringify(
      {
        major_categories: taxonomy.major_categories.map((m) => ({
          id: m.id, label_en: m.label_en, label_ko: m.label_ko,
        })),
        mid_sub_examples: taxonomy.example_mid_sub_categories,
      },
      null, 2,
    );

    const body =
      paper.fullText && paper.fullText.length > 200
        ? paper.fullText.slice(0, 40_000)   // 안전하게 약 40k 문자 제한
        : paper.abstract ?? '';

    const prompt = `당신은 반도체 소재(특히 포토레지스트) 분야 논문을 분류·요약하는 전문 큐레이터입니다.

[분류 체계] (major_category 는 반드시 아래 id 중 하나):
${taxonomyHint}

[요구사항]
- 요약은 한국어 3-4줄. 결론과 실용적 의미 포함.
- key_findings 는 구체적인 수치/비교를 포함.
- mid/sub 라벨은 예시 중 최대한 고르고, 명확히 없으면 새 라벨 제안 (영문 명사구).
- 반드시 포토레지스트·리소·에칭·반도체 소재 관점으로 해석.
- novelty_score 는 '방법론적 신선함', relevance_score 는 '우리 관심 키워드 적합도'.

[논문 정보]
제목: ${paper.title}
초록/본문(일부):
${body}
`;

    const result = await model.generateContent(prompt);
    const text   = result.response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error({ err, snippet: text.slice(0, 200) }, 'Gemini 응답 JSON 파싱 실패');
      throw new Error('Gemini JSON parse failed');
    }
    return sanitizeAnalysis(parsed);
  }, { label: 'analyzePaper' }));
}

/**
 * 사용자 질문을 받아 '검색용 쿼리 문장'과 'major 필터 후보' 추출.
 * - 검색 품질을 위해 질문을 재작성(동의어 확장).
 */
export async function rewriteQueryForSearch(userQuestion, taxonomy) {
  return limit(() => withRetry(async () => {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            rewritten: { type: SchemaType.STRING },
            majors:    { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          },
          required: ['rewritten', 'majors'],
        },
      },
    });
    const majorHints = taxonomy.major_categories.map((m) => `${m.id}: ${m.label_en}`).join('\n');
    const prompt = `다음 사용자 질문을 '반도체 소재 논문 검색용 영문 쿼리'로 재작성하세요.
관련 대분류(majors) id 도 0-3개 골라주세요. 확실하지 않으면 빈 배열.

[대분류 id 후보]
${majorHints}

[사용자 질문]
${userQuestion}
`;
    const res = await model.generateContent(prompt);
    const out = JSON.parse(res.response.text());
    return {
      rewritten: String(out.rewritten ?? userQuestion),
      majors: Array.isArray(out.majors) ? out.majors.filter((m) => ALLOWED_MAJORS.has(m)) : [],
    };
  }, { label: 'rewriteQueryForSearch' }));
}

/**
 * 검색 결과(논문 조각들)를 바탕으로 최종 답변 생성.
 */
export async function synthesizeAnswer(userQuestion, snippets) {
  return limit(() => withRetry(async () => {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { temperature: 0.3 },
    });
    const context = snippets.map((s, i) =>
      `[${i + 1}] ${s.title}\n요약: ${s.summary_ko ?? ''}\nkey_findings: ${(s.key_findings ?? []).join(' | ')}\nurl: ${s.url ?? ''}`
    ).join('\n\n');

    const prompt = `아래 논문 스니펫들을 근거로 사용자의 질문에 한국어로 답하세요.
각 주장 뒤에 [1], [2] 형태로 출처 번호를 붙입니다. 확실치 않으면 모른다고 답합니다.

[질문]
${userQuestion}

[스니펫]
${context}
`;
    const res = await model.generateContent(prompt);
    return res.response.text();
  }, { label: 'synthesizeAnswer' }));
}
