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
// 포매터 (사람이 읽기 좋게)
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

// =====================================================================
// 기동
// =====================================================================
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('MCP server (paper-index) ready on stdio');
