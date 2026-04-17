// =====================================================================
// HTTP 기반 MCP 서버 (선택)
// - Claude Web 의 "Custom Connectors" 에 붙이려면 HTTP/SSE 트랜스포트 필요.
// - 검색/조회만 공개 (쓰기 없음). 공유 토큰으로 보호.
//
// 엔드포인트:
//   POST /mcp      : JSON-RPC 2.0 (tools/list, tools/call)
//   GET  /health   : 상태 확인
//
// 환경변수:
//   MCP_HTTP_PORT  (default 8788)
//   MCP_HTTP_TOKEN (required)   Authorization: Bearer <token>
// =====================================================================

import 'dotenv/config';
import express from 'express';
import { logger } from './lib/logger.js';
import { query } from './lib/db.js';
import { searchPapers } from './search.js';

const PORT  = Number(process.env.MCP_HTTP_PORT ?? 8788);
const TOKEN = process.env.MCP_HTTP_TOKEN;

if (!TOKEN) {
  logger.error('MCP_HTTP_TOKEN 이 설정되어 있지 않습니다. 보안상 기동을 중단합니다.');
  process.exit(1);
}

// --- 툴 정의 (mcp-server.js 와 동일 의미) ---
const tools = [
  {
    name: 'search_papers',
    description: '내 논문 DB (반도체 소재/포토레지스트) 에서 자연어 시멘틱 검색.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        top_k:    { type: 'number', default: 8 },
        majors:   { type: 'array', items: { type: 'string' } },
        min_relevance: { type: 'number', default: 0 },
        with_answer:   { type: 'boolean', default: true },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_paper',
    description: '논문 상세 조회 (id, doi, arxiv_id 중 하나).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' }, doi: { type: 'string' }, arxiv_id: { type: 'string' },
      },
    },
  },
  {
    name: 'list_categories',
    description: '카테고리별 논문 건수.',
    inputSchema: { type: 'object', properties: { major: { type: 'string' } } },
  },
  {
    name: 'recent_papers',
    description: '최근 N 일 수집분.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7 },
        limit: { type: 'number', default: 20 },
        major: { type: 'string' },
      },
    },
  },
];

async function callTool(name, args) {
  if (name === 'search_papers') {
    const res = await searchPapers(args ?? {});
    return res;
  }
  if (name === 'get_paper') {
    const { id, doi, arxiv_id } = args ?? {};
    const params = []; let where = '';
    if (id) { where = 'id=$1'; params.push(id); }
    else if (doi) { where = 'doi=$1'; params.push(doi); }
    else if (arxiv_id) { where = 'arxiv_id=$1'; params.push(arxiv_id); }
    else return { error: 'id|doi|arxiv_id 중 하나 필요' };
    const { rows } = await query(`SELECT * FROM research_papers WHERE ${where} LIMIT 1`, params);
    return rows[0] ?? null;
  }
  if (name === 'list_categories') {
    const major = args?.major;
    const where = major ? 'WHERE major_category=$1' : '';
    const params = major ? [major] : [];
    const { rows } = await query(
      `SELECT major_category, mid_category, sub_category, COUNT(*)::int AS n
       FROM research_papers ${where}
       GROUP BY 1,2,3 ORDER BY n DESC LIMIT 100`, params);
    return rows;
  }
  if (name === 'recent_papers') {
    const days = Number(args?.days ?? 7);
    const limit = Number(args?.limit ?? 20);
    const major = args?.major;
    const filters = [`(published_at >= now() - interval '${days} days'
                       OR created_at  >= now() - interval '${days} days')`];
    const params = [];
    if (major) { params.push(major); filters.push(`major_category=$${params.length}`); }
    params.push(limit);
    const { rows } = await query(
      `SELECT id, title, url, major_category, mid_category, novelty_score,
              relevance_score, published_at, summary_ko
       FROM research_papers WHERE ${filters.join(' AND ')}
       ORDER BY COALESCE(published_at, created_at::date) DESC
       LIMIT $${params.length}`, params);
    return rows;
  }
  return { error: `unknown tool: ${name}` };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// 공유 토큰 인증
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const h = req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || m[1] !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// JSON-RPC 2.0 스타일
app.post('/mcp', async (req, res) => {
  const { jsonrpc = '2.0', id = null, method, params = {} } = req.body ?? {};
  try {
    if (method === 'tools/list') {
      return res.json({ jsonrpc, id, result: { tools } });
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const result = await callTool(name, args);
      return res.json({
        jsonrpc, id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    }
    return res.json({ jsonrpc, id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    logger.error({ err }, 'mcp-http error');
    return res.json({ jsonrpc, id, error: { code: -32000, message: err.message } });
  }
});

app.listen(PORT, () => logger.info({ PORT }, 'MCP HTTP 서버 기동'));
