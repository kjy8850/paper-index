// =====================================================================
// Anthropic Claude (Sonnet) 호출 래퍼.
// - Layer 4 deep parser 가 사용.
// - JSON 모드: tool_use 강제로 구조화된 응답을 받음.
// - PDF 직접 투입 (input_pdf base64) 모드도 지원.
// - 비용 카운팅은 호출자가 cost_log 에 직접 기록 (system_config 와 분리).
//
// 환경변수:
//   ANTHROPIC_API_KEY        : 필수
//   CLAUDE_MODEL             : 기본 'claude-sonnet-4-6' (system_config.claude_model 가 우선)
//   CLAUDE_MAX_OUTPUT_TOKENS : 기본 4096
// =====================================================================

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import { getConfig } from './system-config.js';

let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 가 설정되지 않았습니다');
  _client = new Anthropic({ apiKey });
  return _client;
}

export async function getClaudeModel() {
  return (await getConfig('claude_model')) || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
}

/**
 * tool_use 를 강제해서 schema 에 맞는 JSON 객체를 받아온다.
 *
 * @param {Object} opts
 * @param {string|Array<Object>} opts.system  - system 메시지(또는 블록 배열)
 * @param {Array<Object>} opts.userBlocks     - user content blocks (text / document)
 * @param {Object} opts.schema                - JSON Schema (tool input_schema 로 사용)
 * @param {string} [opts.toolName='emit_result']
 * @param {string} [opts.model]               - override
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{ data: Object, usage: { input_tokens: number, output_tokens: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }, model: string }>}
 */
export async function callClaudeJson({
  system, userBlocks, schema, toolName = 'emit_result',
  model, maxTokens,
}) {
  const m = model || (await getClaudeModel());
  const max = Number(maxTokens ?? process.env.CLAUDE_MAX_OUTPUT_TOKENS ?? 4096);

  const tools = [{
    name: toolName,
    description: '구조화된 결과를 그대로 emit',
    input_schema: schema,
  }];

  const msg = await client().messages.create({
    model: m,
    max_tokens: max,
    system,
    tools,
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: userBlocks }],
  });

  const blk = (msg.content || []).find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!blk) {
    logger.warn({ msg: msg.content }, 'Claude tool_use 응답 없음');
    throw new Error('claude: tool_use 응답을 찾지 못했습니다');
  }

  return {
    data:  blk.input ?? {},
    usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
    model: m,
  };
}

/**
 * 가장 단순한 free-form 호출 (JSON 강제 X). 품질 검사 등 yes/no 질의에 사용.
 */
export async function callClaudeText({ system, user, model, maxTokens = 256 }) {
  const m = model || (await getClaudeModel());
  const msg = await client().messages.create({
    model: m,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  });
  const text = (msg.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return { text, usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 }, model: m };
}

/**
 * Markdown 품질 휴리스틱 — 토큰 비용 없이 빠르게.
 * Claude 호출 전에 1차 필터로 사용. 실패시 PDF fallback 트리거.
 */
export function isMarkdownBroken(md, { minChars = 1500, minWords = 200 } = {}) {
  if (typeof md !== 'string') return true;
  const s = md.trim();
  if (s.length < minChars) return true;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return true;
  // 표/수식/그림이 모두 비어있으면 의심
  const hasTable   = /\|\s*-+\s*\|/.test(s);
  const hasMath    = /\$\$|\\\(|\\\[/.test(s);
  const hasFigure  = /!\[/.test(s) || /Figure\s*\d/i.test(s) || /Fig\.\s*\d/i.test(s);
  if (!hasTable && !hasMath && !hasFigure && s.length < 6000) return true;
  return false;
}

// ---------------------------------------------------------------------
// 비용 계산 (Claude Sonnet 4.x 기준 — 기본 가격, 운영 시 config/claude-pricing.json 으로 외부화 가능)
//   input  $3 / 1M   →  $0.000003 / token
//   output $15 / 1M  →  $0.000015 / token
//   cache_creation : input * 1.25
//   cache_read     : input * 0.10
// ---------------------------------------------------------------------
const SONNET_PRICING = {
  input_per_token:           3 / 1_000_000,
  output_per_token:         15 / 1_000_000,
  cache_creation_per_token: (3 * 1.25) / 1_000_000,
  cache_read_per_token:     (3 * 0.10) / 1_000_000,
};

export function estimateCostUsd(usage, pricing = SONNET_PRICING) {
  const u = usage || {};
  return (
    (u.input_tokens               || 0) * pricing.input_per_token +
    (u.output_tokens              || 0) * pricing.output_per_token +
    (u.cache_creation_input_tokens|| 0) * pricing.cache_creation_per_token +
    (u.cache_read_input_tokens    || 0) * pricing.cache_read_per_token
  );
}
