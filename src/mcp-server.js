// =====================================================================
// MCP 서버 (Model Context Protocol)
// Claude Desktop 에서 "Settings -> Developer -> Edit Config" 로 등록하면
// 자연어로 내 DB 를 검색할 수 있음.
//
// 노출 툴:
//  - search_papers        : 시멘틱 검색 + 답변 합성
//  - get_paper            : id 로 개별 논문 조회
//  - list_categories      : 대/중/소분류 통계
//  - recent_papers        : 최근 N 일 수집분
// =====================================================================

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './lib/logger.js';
import { query } from './lib/db.js';
import { searchPapers } from './search.js';

const server = new Server(
  { name: 'paper-index', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// =====================================================================
// 툴 목록
// =====================================================================
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_papers',
      description:
        '내 논문 DB (반도체 소재, 포토레지스트 중심) 에서 자연어 질문으로 시멘틱 검색. ' +
        '질문은 한국어/영어 모두 가능. 답변과 함께 상위 스니펫을 반환.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '검색할 질문 또는 키워드' },
          top_k:    { type: 'number', description: '상위 몇 건 가져올지 (기본 8)', default: 8 },
          majors:   {
            type: 'array',
            items: { type: 'string', enum: ['resin','pr','develop_etch','litho','metrology','misc_semi','novel_idea'] },
            description: '특정 대분류로 제한 (선택)',
          },
          min_relevance: { type: 'number', description: '최소 relevance_score (0-10)', default: 0 },
          with_answer:   { type: 'boolean', description: '답변 합성 포함 여부', default: true },
        },
        required: ['question'],
      },
    },
    {
      name: 'get_paper',
      description: '특정 논문의 상세 정보 조회 (id, doi 또는 arxiv_id 중 하나)',
      inputSchema: {
        type: 'object',
        properties: {
          id:       { type: 'number' },
          doi:      { type: 'string' },
          arxiv_id: { type: 'string' },
        },
      },
    },
    {
      name: 'list_categories',
      description: '저장된 논문의 카테고리 분포. 대/중/소분류별 건수.',
      inputSchema: {
        type: 'object',
        properties: {
          major: { type: 'string', description: '특정 대분류로 제한' },
        },
      },
    },
    {
      name: 'recent_papers',
      description: '최근 수집된 논문 상위 N 건 (published_at 또는 created_at 기준).',
      inputSchema: {
        type: 'object',
        properties: {
          days:  { type: 'number', description: '최근 N 일', default: 7 },
          limit: { type: 'number', default: 20 },
          major: { type: 'string' },
        },
      },
    },
    {
      name: 'read_code_file',
      description: '시스템의 소스 코드 파일을 직접 읽어옵니다.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '읽을 파일의 경로 (예: src/pdf-worker.js, services/batch-runner/batch_runner/pipeline.py)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_compositions',
      description:
        'Layer 4 deep parser 결과 중 composition_data 를 필터/정렬 검색. ' +
        'PR 조성(resin/pag/quencher 종류, 감도/해상도/LER 등)으로 좁힐 때 사용.',
      inputSchema: {
        type: 'object',
        properties: {
          resin_type:        { type: 'string', description: '수지 키워드 (ILIKE)' },
          pag_type:          { type: 'string', description: 'PAG 키워드 (ILIKE)' },
          quencher:          { type: 'string', description: 'quencher 키워드 (ILIKE)' },
          sensitivity_max:   { type: 'number', description: '감도 상한 (mJ/cm^2)' },
          resolution_max:    { type: 'number', description: '해상도 상한 (nm)' },
          ler_max:           { type: 'number', description: 'LER 상한 (nm)' },
          optimal_only:      { type: 'boolean', description: 'optimal_flag=true 만' },
          limit:             { type: 'number', default: 20 },
        },
      },
    },
    {
      name: 'search_reactions',
      description:
        'Layer 4 deep parser 결과 중 reaction_conditions 를 필터 검색. ' +
        '중합 방식, 온도/시간, 수율 등으로 좁힐 때 사용.',
      inputSchema: {
        type: 'object',
        properties: {
          polymerization_type: { type: 'string', description: 'RAFT/ATRP/Radical 등 (ILIKE)' },
          monomer:             { type: 'string', description: 'monomers JSONB 안 키워드 (ILIKE)' },
          temperature_min:     { type: 'number' },
          temperature_max:     { type: 'number' },
          yield_min:           { type: 'number' },
          limit:               { type: 'number', default: 20 },
        },
      },
    },
    {
      name: 'get_parsed_paper',
      description:
        'staging_id 로 papers_parsed + 연결된 composition_data / reaction_conditions 까지 한 번에 조회.',
      inputSchema: {
        type: 'object',
        properties: {
          staging_id: { type: 'number' },
        },
        required: ['staging_id'],
      },
    },
    {
      name: 'pipeline_status',
      description: '5-layer 파이프라인 현재 상태 (papers_staging 상태별 건수, parsed/excluded 수, 오늘 비용).',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));
// =====================================================================
// 툴 실행
// =====================================================================
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'search_papers': {
        const res = await searchPapers(args ?? {});
        return { content: [{ type: 'text', text: formatSearch(res) }] };
      }

      case 'get_paper': {
        const paper = await fetchOne(args ?? {});
        if (!paper) return { content: [{ type: 'text', text: '논문을 찾지 못했습니다.' }] };
        return { content: [{ type: 'text', text: formatPaper(paper) }] };
      }

      case 'list_categories': {
        const rows = await fetchCategories(args?.major);
        return { content: [{ type: 'text', text: formatCategories(rows) }] };
      }

      case 'recent_papers': {
        const rows = await fetchRecent(args ?? {});
        return { content: [{ type: 'text', text: formatRecent(rows) }] };
      }

      case 'search_compositions': {
        const rows = await searchCompositions(args ?? {});
        return { content: [{ type: 'text', text: formatCompositions(rows) }] };
      }

      case 'search_reactions': {
        const rows = await searchReactions(args ?? {});
        return { content: [{ type: 'text', text: formatReactions(rows) }] };
      }

      case 'get_parsed_paper': {
        const paper = await fetchParsed(args?.staging_id);
        if (!paper) return { content: [{ type: 'text', text: 'parsed 행 없음.' }] };
        return { content: [{ type: 'text', text: formatParsed(paper) }] };
      }

      case 'pipeline_status': {
        const status = await fetchPipelineStatus();
        return { content: [{ type: 'text', text: formatPipelineStatus(status) }] };
      }

      case 'read_code_file': {
        const fs = await import('fs/promises');
        const path = await import('path');
        const safePath = path.normalize(args.path).replace(/^(\.\.(\/|\\|$))+/, '');
        const fullPath = path.join(process.cwd(), safePath);
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          return { content: [{ type: 'text', text: content }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `파일 읽기 실패: ${err.message}` }], isError: true };
        }
      }

      default:
        return { content: [{ type: 'text', text: `알 수 없는 툴: ${name}` }], isError: true };
    }
  } catch (err) {
    logger.error({ err, name, args }, 'MCP 툴 실행 실패');
    return { content: [{ type: 'text', text: `에러: ${err.message}` }], isError: true };
  }
});

// =====================================================================
// DB 헬퍼
// =====================================================================
async function fetchOne({ id, doi, arxiv_id }) {
  const params = [];
  let where = '';
  if (id) { where = 'id = $1'; params.push(id); }
  else if (doi) { where = 'doi = $1'; params.push(doi); }
  else if (arxiv_id) { where = 'arxiv_id = $1'; params.push(arxiv_id); }
  else return null;
  const { rows } = await query(
    `SELECT id, doi, arxiv_id, source, url, pdf_url, title, abstract,
            authors, published_at, venue, citations,
            summary_ko, key_findings, materials, techniques, tags,
            major_category, mid_category, sub_category,
            novelty_score, relevance_score, created_at
     FROM research_papers WHERE ${where} LIMIT 1`,
    params,
  );
  return rows[0];
}

async function fetchCategories(major) {
  const where = major ? `WHERE major_category = $1` : '';
  const params = major ? [major] : [];
  const { rows } = await query(
    `SELECT major_category, mid_category, sub_category, COUNT(*)::int AS n
     FROM research_papers ${where}
     GROUP BY 1,2,3 ORDER BY n DESC LIMIT 100`,
    params,
  );
  return rows;
}


async function fetchRecent({ days = 7, limit = 20, major }) {
  const filters = [`(published_at >= now() - interval '${Number(days)} days'
                     OR created_at  >= now() - interval '${Number(days)} days')`];
  const params = [];
  if (major) { params.push(major); filters.push(`major_category = $${params.length}`); }
  params.push(Number(limit));
  const { rows } = await query(
    `SELECT id, title, url, major_category, mid_category, novelty_score,
            relevance_score, published_at, summary_ko
     FROM research_papers
     WHERE ${filters.join(' AND ')}
     ORDER BY COALESCE(published_at, created_at::date) DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// =====================================================================
// v2 헬퍼 — papers_parsed / composition_data / reaction_conditions
// =====================================================================
async function searchCompositions(a) {
  const filters = [];
  const params = [];
  let p = 1;
  const add = (clause, value) => { filters.push(clause.replace('$$', `$${p}`)); params.push(value); p += 1; };

  if (a.resin_type)       add(`cd.resin_type ILIKE $$`, `%${a.resin_type}%`);
  if (a.pag_type)         add(`cd.pag_type ILIKE $$`, `%${a.pag_type}%`);
  if (a.quencher)         add(`cd.quencher ILIKE $$`, `%${a.quencher}%`);
  if (Number.isFinite(a.sensitivity_max)) add(`cd.sensitivity <= $$`, Number(a.sensitivity_max));
  if (Number.isFinite(a.resolution_max))  add(`cd.resolution  <= $$`, Number(a.resolution_max));
  if (Number.isFinite(a.ler_max))         add(`cd.ler         <= $$`, Number(a.ler_max));
  if (a.optimal_only)     filters.push(`cd.optimal_flag = TRUE`);

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
      LIMIT $${p}`,
    params,
  );
  return rows;
}

async function searchReactions(a) {
  const filters = [];
  const params = [];
  let p = 1;
  const add = (clause, value) => { filters.push(clause.replace('$$', `$${p}`)); params.push(value); p += 1; };

  if (a.polymerization_type) add(`rc.polymerization_type ILIKE $$`, `%${a.polymerization_type}%`);
  if (a.monomer)             add(`rc.monomers::text ILIKE $$`, `%${a.monomer}%`);
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
      LIMIT $${p}`,
    params,
  );
  return rows;
}

async function fetchParsed(stagingId) {
  if (!Number.isFinite(stagingId)) return null;
  const { rows: parsedRows } = await query(
    `SELECT pp.id, pp.paper_type, pp.parsed_data, pp.key_findings, pp.limitations,
            pp.source_type, pp.model, pp.input_tokens, pp.output_tokens,
            pp.cost_usd, pp.parsed_at,
            s.title, s.doi, s.arxiv_id, s.url, s.year, s.venue
       FROM papers_parsed pp
       JOIN papers_staging s ON s.id = pp.staging_id
      WHERE pp.staging_id = $1
      ORDER BY pp.parsed_at DESC
      LIMIT 1`,
    [stagingId],
  );
  if (!parsedRows.length) return null;
  const parsed = parsedRows[0];

  const [{ rows: cd }, { rows: rc }] = await Promise.all([
    query(`SELECT * FROM composition_data WHERE staging_id = $1 ORDER BY created_at DESC`, [stagingId]),
    query(`SELECT * FROM reaction_conditions WHERE staging_id = $1 ORDER BY created_at DESC`, [stagingId]),
  ]);
  return { parsed, composition: cd, reaction: rc };
}

async function fetchPipelineStatus() {
  const [staging, scored, excluded, parsed, cost, sysCfg] = await Promise.all([
    query(`SELECT fulltext_status, COUNT(*)::int AS n FROM papers_staging GROUP BY 1 ORDER BY 2 DESC`),
    query(`SELECT relevance, COUNT(*)::int AS n FROM papers_scored GROUP BY 1`),
    query(`SELECT excluded_layer, COUNT(*)::int AS n FROM papers_excluded GROUP BY 1`),
    query(`SELECT paper_type, COUNT(*)::int AS n FROM papers_parsed GROUP BY 1 ORDER BY 2 DESC`),
    query(`SELECT day, total_usd, gemini_usd, claude_usd FROM v_daily_cost ORDER BY day DESC LIMIT 1`).catch(() => ({ rows: [] })),
    query(`SELECT key, value FROM system_config
            WHERE key IN ('phase1_completed','phase1_collected_today','phase1_total_collected',
                          'daily_pdf_limit','daily_pdf_processed','claude_model')`).catch(() => ({ rows: [] })),
  ]);
  return {
    staging:  staging.rows,
    scored:   scored.rows,
    excluded: excluded.rows,
    parsed:   parsed.rows,
    cost:     cost.rows[0] ?? null,
    config:   Object.fromEntries((sysCfg.rows ?? []).map((r) => [r.key, r.value])),
  };
}

// =====================================================================
// 포매터
// =====================================================================
function formatSearch(res) {
  const head = [
    `질문: ${res.question}`,
    `재작성: ${res.rewritten}`,
    `대분류 필터: ${res.majors.join(', ') || '없음'}`,
    `매칭: ${res.count}건 (${res.latency_ms}ms)`,
    '',
    res.answer ? `### 답변\n${res.answer}\n` : '',
    '### 상위 논문',
  ].join('\n');

  const items = res.snippets.map((s, i) => (
`[${i + 1}] (${s.major}/${s.mid ?? '-'}) similarity=${s.similarity?.toFixed(3)}
제목: ${s.title}
요약: ${s.summary_ko ?? ''}
key_findings: ${(s.key_findings ?? []).join(' | ')}
url: ${s.url ?? ''}
doi: ${s.doi ?? ''}
id: ${s.id}
`
  )).join('\n');

  return `${head}\n${items}`;
}

function formatPaper(p) {
  return [
    `# ${p.title}`,
    `id=${p.id} doi=${p.doi ?? '-'} arxiv=${p.arxiv_id ?? '-'} source=${p.source}`,
    `published=${p.published_at ?? '-'} venue=${p.venue ?? '-'} citations=${p.citations}`,
    `분류: ${p.major_category} / ${p.mid_category ?? '-'} / ${p.sub_category ?? '-'}`,
    `novelty=${p.novelty_score} relevance=${p.relevance_score}`,
    `url: ${p.url ?? ''}`,
    `pdf: ${p.pdf_url ?? ''}`,
    '',
    '## 요약',
    p.summary_ko ?? '',
    '',
    '## Key findings',
    (p.key_findings ?? []).map((k) => `- ${k}`).join('\n'),
    '',
    '## Materials',
    (p.materials ?? []).join(', '),
    '',
    '## Techniques',
    (p.techniques ?? []).join(', '),
    '',
    '## Abstract',
    p.abstract ?? '',
  ].join('\n');
}

function formatCategories(rows) {
  if (!rows.length) return '카테고리 통계 없음.';
  const lines = rows.map((r) =>
    `- ${r.major_category} / ${r.mid_category ?? '-'} / ${r.sub_category ?? '-'}: ${r.n}`);
  return `카테고리별 건수 (상위 ${rows.length})\n${lines.join('\n')}`;
}

function formatRecent(rows) {
  if (!rows.length) return '최근 논문 없음.';
  return rows.map((r, i) =>
`[${i + 1}] (${r.major_category}/${r.mid_category ?? '-'}) novelty=${r.novelty_score}
제목: ${r.title}
요약: ${r.summary_ko ?? ''}
url: ${r.url ?? ''}
id: ${r.id} published=${r.published_at ?? '-'}`,
  ).join('\n\n');
}

function formatCompositions(rows) {
  if (!rows.length) return 'composition 결과 없음.';
  return rows.map((r, i) =>
`[${i + 1}] staging_id=${r.staging_id} ${r.optimal_flag ? '⭐' : ''}
제목: ${r.title}
DOI: ${r.doi ?? '-'} / arXiv: ${r.arxiv_id ?? '-'} / ${r.year ?? '-'} ${r.venue ?? ''}
resin: ${r.resin_type ?? '-'} ${r.resin_ratio ?? ''} (Mw: ${JSON.stringify(r.resin_mw ?? {})})
PAG: ${r.pag_type ?? '-'} ${r.pag_ratio ?? ''}
solvent: ${r.solvent ?? '-'} / quencher: ${r.quencher ?? '-'}
sensitivity=${r.sensitivity ?? '-'} mJ/cm² / resolution=${r.resolution ?? '-'} nm / LER=${r.ler ?? '-'} nm / EUV dose=${r.euv_dose ?? '-'}
url: ${r.url ?? ''}`).join('\n\n');
}

function formatReactions(rows) {
  if (!rows.length) return 'reaction 결과 없음.';
  return rows.map((r, i) =>
`[${i + 1}] staging_id=${r.staging_id}
제목: ${r.title}
DOI: ${r.doi ?? '-'} / arXiv: ${r.arxiv_id ?? '-'} / ${r.year ?? '-'} ${r.venue ?? ''}
poly_type=${r.polymerization_type ?? '-'} initiator=${r.initiator_type ?? '-'}
T=${r.temperature ?? '-'}°C drop=${r.dropping_time ?? '-'}h aging=${r.aging_time ?? '-'}h yield=${r.yield_pct ?? '-'}%
solvent=${r.solvent ?? '-'} atmosphere=${r.atmosphere ?? '-'}
mw_result: ${JSON.stringify(r.mw_result ?? {})}
litho: sens=${r.litho_sensitivity ?? '-'} res=${r.litho_resolution ?? '-'}
monomers: ${JSON.stringify(r.monomers ?? [])}
url: ${r.url ?? ''}`).join('\n\n');
}

function formatParsed(out) {
  const p = out.parsed;
  const head = [
    `# ${p.title}`,
    `staging_id=${p.staging_id ?? '-'} doi=${p.doi ?? '-'} arxiv=${p.arxiv_id ?? '-'} ${p.year ?? '-'} ${p.venue ?? ''}`,
    `paper_type=${p.paper_type} source_type=${p.source_type} model=${p.model}`,
    `tokens in=${p.input_tokens} out=${p.output_tokens} cost=$${Number(p.cost_usd ?? 0).toFixed(6)}`,
    '',
    '## key_findings',
    p.key_findings ?? '',
    '',
    '## limitations',
    p.limitations ?? '',
    '',
    '## parsed_data (raw)',
    '```json',
    JSON.stringify(p.parsed_data, null, 2),
    '```',
  ];
  if (out.composition?.length) {
    head.push('', '## composition_data');
    head.push(JSON.stringify(out.composition, null, 2));
  }
  if (out.reaction?.length) {
    head.push('', '## reaction_conditions');
    head.push(JSON.stringify(out.reaction, null, 2));
  }
  return head.join('\n');
}

function formatPipelineStatus(s) {
  const lines = [];
  lines.push('## papers_staging (fulltext_status)');
  for (const r of s.staging) lines.push(`- ${r.fulltext_status}: ${r.n}`);
  lines.push('', '## papers_scored (relevance)');
  for (const r of s.scored)  lines.push(`- ${r.relevance}: ${r.n}`);
  lines.push('', '## papers_excluded');
  for (const r of s.excluded) lines.push(`- ${r.excluded_layer}: ${r.n}`);
  lines.push('', '## papers_parsed (paper_type)');
  for (const r of s.parsed)   lines.push(`- ${r.paper_type}: ${r.n}`);
  if (s.cost) {
    lines.push('', '## 오늘 비용 (KST)');
    lines.push(`- gemini=$${Number(s.cost.gemini_usd ?? 0).toFixed(4)} / claude=$${Number(s.cost.claude_usd ?? 0).toFixed(4)} / total=$${Number(s.cost.total_usd ?? 0).toFixed(4)}`);
  }
  if (s.config) {
    lines.push('', '## system_config');
    for (const [k, v] of Object.entries(s.config)) lines.push(`- ${k}: ${v}`);
  }
  return lines.join('\n');
}

// =====================================================================
// 기동
// =====================================================================
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('MCP server (paper-index) ready on stdio');
