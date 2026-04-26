// =====================================================================
// HTTP 기반 MCP 서버 (선택)
// - Claude Web "Custom Connectors" 용 HTTP/SSE 트랜스포트.
// - 검색/조회만 공개 (쓰기 없음). 공유 토큰으로 보호.
//
// 엔드포인트:
//   POST /mcp      : JSON-RPC 2.0 (tools/list, tools/call)
//   GET  /health   : 상태 확인
//
// 환경변수:
//   MCP_HTTP_PORT  (default 8788)
//   MCP_HTTP_TOKEN (required)   Authorization: Bearer <token>
//
// **mcp-server.js (stdio) 와 동일 도구 시그니처를 노출.** 한쪽만 수정 금지.
// =====================================================================

import 'dotenv/config';
import express from 'express';
import { logger } from './lib/logger.js';
import { query } from './lib/db.js';
import { searchPapers } from './search.js';

const PORT  = Number(process.env.MCP_HTTP_PORT ?? 8788);
const TOKEN = process.env.MCP_HTTP_TOKEN;

if (!TOKEN) {
  logger.error('MCP_HTTP_TOKEN 이 비어있습니다. 보안상 기동을 중단합니다.');
  process.exit(1);
}

const tools = [
  { name: 'search_papers',
    description: '내 논문 DB (반도체 소재/포토레지스트) 자연어 시멘틱 검색.',
    inputSchema: { type: 'object',
      properties: {
        question: { type: 'string' },
        top_k:    { type: 'number', default: 8 },
        majors:   { type: 'array', items: { type: 'string' } },
        min_relevance: { type: 'number', default: 0 },
        with_answer:   { type: 'boolean', default: true },
      },
      required: ['question'] } },
  { name: 'get_paper',
    description: '논문 상세 조회 (id, doi, arxiv_id 중 하나).',
    inputSchema: { type: 'object',
      properties: { id: { type: 'number' }, doi: { type: 'string' }, arxiv_id: { type: 'string' } } } },
  { name: 'list_categories',
    description: '카테고리별 논문 건수.',
    inputSchema: { type: 'object', properties: { major: { type: 'string' } } } },
  { name: 'recent_papers',
    description: '최근 N 일 수집분.',
    inputSchema: { type: 'object',
      properties: { days: { type: 'number', default: 7 }, limit: { type: 'number', default: 20 }, major: { type: 'string' } } } },
  { name: 'search_compositions',
    description: 'Layer 4 결과 composition_data 필터 검색 (resin/PAG/quencher, 감도/해상도/LER).',
    inputSchema: { type: 'object',
      properties: {
        resin_type: { type: 'string' }, pag_type: { type: 'string' }, quencher: { type: 'string' },
        sensitivity_max: { type: 'number' }, resolution_max: { type: 'number' }, ler_max: { type: 'number' },
        optimal_only: { type: 'boolean' }, limit: { type: 'number', default: 20 },
      } } },
  { name: 'search_reactions',
    description: 'Layer 4 결과 reaction_conditions 필터 검색 (중합 방식, 온도/시간, 수율).',
    inputSchema: { type: 'object',
      properties: {
        polymerization_type: { type: 'string' }, monomer: { type: 'string' },
        temperature_min: { type: 'number' }, temperature_max: { type: 'number' },
        yield_min: { type: 'number' }, limit: { type: 'number', default: 20 },
      } } },
  { name: 'get_parsed_paper',
    description: 'staging_id 로 papers_parsed + composition_data + reaction_conditions 통합 조회.',
    inputSchema: { type: 'object', properties: { staging_id: { type: 'number' } }, required: ['staging_id'] } },
  { name: 'pipeline_status',
    description: '5-layer 파이프라인 현황 (staging 분포, parsed/excluded/publisher, 오늘 비용).',
    inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name, args) {
  if (name === 'search_papers')   return await searchPapers(args ?? {});
  if (name === 'get_paper')       return await getPaper(args ?? {});
  if (name === 'list_categories') return await listCategories(args ?? {});
  if (name === 'recent_papers')   return await recentPapers(args ?? {});
  if (name === 'search_compositions') return await searchCompositions(args ?? {});
  if (name === 'search_reactions')    return await searchReactions(args ?? {});
  if (name === 'get_parsed_paper')    return await fetchParsed(Number(args?.staging_id));
  if (name === 'pipeline_status')     return await fetchPipelineStatus();
  return { error: `unknown tool: ${name}` };
}

async function getPaper({ id, doi, arxiv_id }) {
  const params = []; let where = '';
  if (id)            { where = 'id=$1';       params.push(id); }
  else if (doi)      { where = 'doi=$1';      params.push(doi); }
  else if (arxiv_id) { where = 'arxiv_id=$1'; params.push(arxiv_id); }
  else return { error: 'id|doi|arxiv_id 중 하나 필요' };
  const { rows } = await query(`SELECT * FROM research_papers WHERE ${where} LIMIT 1`, params);
  return rows[0] ?? null;
}

async function listCategories({ major }) {
  const where = major ? 'WHERE major_category=$1' : '';
  const params = major ? [major] : [];
  const { rows } = await query(
    `SELECT major_category, mid_category, sub_category, COUNT(*)::int AS n
       FROM research_papers ${where} GROUP BY 1,2,3 ORDER BY n DESC LIMIT 100`, params);
  return rows;
}

async function recentPapers({ days = 7, limit = 20, major }) {
  const d = Number(days), n = Number(limit);
  const filters = [`(published_at >= now() - interval '${d} days' OR created_at >= now() - interval '${d} days')`];
  const params = [];
  if (major) { params.push(major); filters.push(`major_category=$${params.length}`); }
  params.push(n);
  const { rows } = await query(
    `SELECT id, title, url, major_category, mid_category, novelty_score, relevance_score, published_at, summary_ko
       FROM research_papers WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(published_at, created_at::date) DESC LIMIT $${params.length}`, params);
  return rows;
}

async function searchCompositions(a) {
  const filters = []; const params = []; let p = 1;
  const add = (clause, v) => { filters.push(clause.replace('$$', `$${p}`)); params.push(v); p += 1; };
  if (a.resin_type) add(`cd.resin_type ILIKE $$`, `%${a.resin_type}%`);
  if (a.pag_type)   add(`cd.pag_type ILIKE $$`,   `%${a.pag_type}%`);
  if (a.quencher)   add(`cd.quencher ILIKE $$`,   `%${a.quencher}%`);
  if (Number.isFinite(a.sensitivity_max)) add(`cd.sensitivity <= $$`, Number(a.sensitivity_max));
  if (Number.isFinite(a.resolution_max))  add(`cd.resolution  <= $$`, Number(a.resolution_max));
  if (Number.isFinite(a.ler_max))         add(`cd.ler         <= $$`, Number(a.ler_max));
  if (a.optimal_only) filters.push(`cd.optimal_flag = TRUE`);
  const limit = Math.min(Number(a.limit ?? 20), 100);
  params.push(limit);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT cd.staging_id, cd.resin_type, cd.resin_mw, cd.resin_ratio,
            cd.pag_type, cd.pag_ratio, cd.solvent, cd.quencher,
            cd.sensitivity, cd.resolution, cd.ler, cd.euv_dose, cd.optimal_flag,
            s.title, s.doi, s.arxiv_id, s.url, s.year, s.venue
       FROM composition_data cd
       JOIN papers_staging s ON s.id = cd.staging_id
       ${where}
      ORDER BY cd.optimal_flag DESC, cd.sensitivity NULLS LAST, cd.created_at DESC
      LIMIT $${p}`, params);
  return rows;
}

async function searchReactions(a) {
  const filters = []; const params = []; let p = 1;
  const add = (clause, v) => { filters.push(clause.replace('$$', `$${p}`)); params.push(v); p += 1; };
  if (a.polymerization_type) add(`rc.polymerization_type ILIKE $$`, `%${a.polymerization_type}%`);
  if (a.monomer)             add(`rc.monomers::text ILIKE $$`,      `%${a.monomer}%`);
  if (Number.isFinite(a.temperature_min)) add(`rc.temperature >= $$`, Number(a.temperature_min));
  if (Number.isFinite(a.temperature_max)) add(`rc.temperature <= $$`, Number(a.temperature_max));
  if (Number.isFinite(a.yield_min))       add(`rc.yield_pct   >= $$`, Number(a.yield_min));
  const limit = Math.min(Number(a.limit ?? 20), 100);
  params.push(limit);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT rc.staging_id, rc.polymerization_type, rc.monomers,
            rc.initiator_type, rc.temperature, rc.dropping_time, rc.aging_time,
            rc.solvent, rc.atmosphere, rc.yield_pct, rc.mw_result,
            rc.litho_sensitivity, rc.litho_resolution,
            s.title, s.doi, s.arxiv_id, s.url, s.year, s.venue
       FROM reaction_conditions rc
       JOIN papers_staging s ON s.id = rc.staging_id
       ${where}
      ORDER BY rc.created_at DESC
      LIMIT $${p}`, params);
  return rows;
}

async function fetchParsed(stagingId) {
  if (!Number.isFinite(stagingId)) return { error: 'staging_id 필요' };
  const { rows: parsedRows } = await query(
    `SELECT pp.id, pp.paper_type, pp.parsed_data, pp.key_findings, pp.limitations,
            pp.source_type, pp.model, pp.input_tokens, pp.output_tokens,
            pp.cost_usd, pp.parsed_at,
            s.title, s.doi, s.arxiv_id, s.url, s.year, s.venue
       FROM papers_parsed pp
       JOIN papers_staging s ON s.id = pp.staging_id
      WHERE pp.staging_id = $1
      ORDER BY pp.parsed_at DESC LIMIT 1`, [stagingId]);
  if (!parsedRows.length) return null;
  const [{ rows: cd }, { rows: rc }] = await Promise.all([
    query(`SELECT * FROM composition_data WHERE staging_id = $1 ORDER BY created_at DESC`, [stagingId]),
    query(`SELECT * FROM reaction_conditions WHERE staging_id = $1 ORDER BY created_at DESC`, [stagingId]),
  ]);
  return { parsed: parsedRows[0], composition: cd, reaction: rc };
}

async function fetchPipelineStatus() {
  const [staging, scored, excluded, parsed, cost, sysCfg, publish] = await Promise.all([
    query(`SELECT fulltext_status, COUNT(*)::int AS n FROM papers_staging GROUP BY 1 ORDER BY 2 DESC`),
    query(`SELECT relevance, COUNT(*)::int AS n FROM papers_scored GROUP BY 1`),
    query(`SELECT excluded_layer, COUNT(*)::int AS n FROM papers_excluded GROUP BY 1`),
    query(`SELECT paper_type, COUNT(*)::int AS n FROM papers_parsed GROUP BY 1 ORDER BY 2 DESC`),
    query(`SELECT day, total_usd, gemini_usd, claude_usd FROM v_daily_cost ORDER BY day DESC LIMIT 1`).catch(() => ({ rows: [] })),
    query(`SELECT key, value FROM system_config
            WHERE key IN ('phase1_completed','phase1_collected_today','phase1_total_collected',
                          'daily_pdf_limit','daily_pdf_processed','claude_model',
                          'publisher_total_published','publisher_last_run')`).catch(() => ({ rows: [] })),
    query(`SELECT publish_state, n FROM v_publisher_summary`).catch(() => ({ rows: [] })),
  ]);
  return {
    staging:   staging.rows,
    scored:    scored.rows,
    excluded:  excluded.rows,
    parsed:    parsed.rows,
    cost:      cost.rows[0] ?? null,
    config:    Object.fromEntries((sysCfg.rows ?? []).map((r) => [r.key, r.value])),
    publisher: publish.rows,
  };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const h = req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || m[1] !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/mcp', async (req, res) => {
  const { jsonrpc = '2.0', id = null, method, params = {} } = req.body ?? {};
  try {
    if (method === 'tools/list') {
      return res.json({ jsonrpc, id, result: { tools } });
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const result = await callTool(name, args);
      return res.json({ jsonrpc, id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }
    return res.json({ jsonrpc, id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    logger.error({ err }, 'mcp-http error');
    return res.json({ jsonrpc, id, error: { code: -32000, message: err.message } });
  }
});

app.listen(PORT, () => logger.info({ PORT }, 'MCP HTTP 서버 기동'));
