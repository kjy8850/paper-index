// =====================================================================
// Layer 4 — Claude Sonnet Deep Parser
//
// papers_staging.fulltext_status IN ('md_ready', 'queued') 인 행을 잡아 처리.
// 우선순위: queued (전날 이월) → md_ready
//
// 처리 분기
//   1) papers_scored 에서 paper_type / relevance 조회 (없으면 처리 보류)
//   2) staging.md_text 길이/품질 검사
//        OK    → markdown 본문을 Claude 에 전달 (PDF 카운트 0)
//        BROKEN→ pdf_url 로 PDF 다운로드 → base64 attach (PDF 카운트 +1)
//                일일 한도 초과면 fulltext_status='queued' (이월)
//   3) Claude 호출 → JSON tool_use 결과 파싱
//   4) papers_parsed INSERT (+ composition_data / reaction_conditions)
//   5) papers_history INSERT, fulltext_status='batch_done'
//      relevance='no' 로 재판정되면 papers_excluded(layer4) 로 이동
// =====================================================================

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { logger } from './lib/logger.js';
import { query, withTx, close } from './lib/db.js';
import { fetchPdf } from './lib/pdf-fetch.js';
import {
  callClaudeJson, isMarkdownBroken, getClaudeModel, estimateCostUsd,
} from './lib/claude-client.js';
import { getSchemaForType } from './lib/parse-schemas.js';
import {
  ensureDailyPdfCounter, incrementPdfProcessed,
} from './lib/system-config.js';

const BATCH      = Number(process.env.DEEP_PARSER_BATCH    ?? 4);
const POLL_MS    = Number(process.env.DEEP_PARSER_POLL_MS  ?? 15_000);
const MD_MAX_LEN = Number(process.env.DEEP_PARSER_MD_MAX   ?? 200_000);   // Claude 입력 상한 (대략 50k tokens)
const SYSTEM_PROMPT_PATH = new URL('../prompts/deep-parser-system.txt', import.meta.url);

// 한 번만 읽고 캐시
let _systemPrompt = null;
async function systemPrompt() {
  if (_systemPrompt) return _systemPrompt;
  try {
    _systemPrompt = await readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    _systemPrompt = '당신은 반도체 소재(EUV/DUV Photoresist) 베테랑 R&D 분석가입니다. JSON tool 로만 답하세요.';
  }
  return _systemPrompt;
}

// =====================================================================
// 잠금: queued 우선, 그 다음 md_ready. p_scored 와 join.
// =====================================================================
async function lockBatch(limit) {
  const sql = `
    WITH pick AS (
      SELECT s.id
        FROM papers_staging s
        JOIN papers_scored sc ON sc.staging_id = s.id
       WHERE s.fulltext_status IN ('queued','md_ready')
         AND sc.relevance IN ('yes','unsure')
       ORDER BY (s.fulltext_status = 'queued') DESC, sc.scored_at ASC
       FOR UPDATE OF s SKIP LOCKED
       LIMIT $1
    )
    UPDATE papers_staging s
       SET fulltext_status = 'parsing'
      FROM pick
     WHERE s.id = pick.id
    RETURNING s.id, s.doi, s.arxiv_id, s.title, s.abstract,
              s.pdf_url, s.md_text, s.md_chars, s.title_normalized, s.source
  `;
  const { rows } = await query(sql, [limit]);
  return rows;
}

async function fetchScored(stagingId) {
  const { rows } = await query(
    `SELECT relevance, paper_type, raw_response
       FROM papers_scored
      WHERE staging_id = $1
      ORDER BY scored_at DESC LIMIT 1`,
    [stagingId],
  );
  return rows[0] ?? null;
}

// =====================================================================
// Claude 호출 — markdown 또는 PDF 모드
// =====================================================================
async function parseWithMarkdown({ paper, scored, mdText, model }) {
  const schema = getSchemaForType(scored.paper_type);
  const sys    = await systemPrompt();
  const truncated = mdText.length > MD_MAX_LEN ? mdText.slice(0, MD_MAX_LEN) : mdText;

  const userBlocks = [
    { type: 'text', text:
      `[원본 메타]\n제목: ${paper.title}\n` +
      `DOI: ${paper.doi ?? '-'} / arXiv: ${paper.arxiv_id ?? '-'}\n` +
      `Layer 2 판정: relevance=${scored.relevance}, paper_type=${scored.paper_type}\n\n` +
      `[Markdown 본문]\n${truncated}\n\n` +
      `위 정보를 근거로 ${scored.paper_type} 스키마에 맞는 결과를 emit_result 로 반환하세요. ` +
      `Layer 2 가 unsure 였다면 이 단계에서 yes/no 를 확정해 주세요.`,
    },
  ];

  const t0 = Date.now();
  const out = await callClaudeJson({
    system: sys, userBlocks, schema, toolName: 'emit_result', model,
  });
  return { ...out, source_type: 'fulltext_md', latency_ms: Date.now() - t0 };
}

async function parseWithPdf({ paper, scored, model }) {
  if (!paper.pdf_url) throw new Error('pdf_url 없음 — PDF 모드 불가');
  const buf = await fetchPdf(paper.pdf_url);
  const b64 = buf.toString('base64');
  const schema = getSchemaForType(scored.paper_type);
  const sys = await systemPrompt();

  const userBlocks = [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64 },
    },
    { type: 'text', text:
      `[원본 메타]\n제목: ${paper.title}\n` +
      `DOI: ${paper.doi ?? '-'} / arXiv: ${paper.arxiv_id ?? '-'}\n` +
      `Layer 2 판정: relevance=${scored.relevance}, paper_type=${scored.paper_type}\n\n` +
      `첨부된 PDF 를 직접 읽고 ${scored.paper_type} 스키마로 emit_result 를 호출하세요.`,
    },
  ];

  const t0 = Date.now();
  const out = await callClaudeJson({
    system: sys, userBlocks, schema, toolName: 'emit_result', model,
  });
  return { ...out, source_type: 'pdf_direct', latency_ms: Date.now() - t0 };
}

// =====================================================================
// 결과 적용 (한 트랜잭션 안에서 papers_parsed/composition_data/...
//          papers_history/papers_excluded + cost_log 까지 묶어 기록)
// =====================================================================
async function applyParseResult({ paper, scored, parse }) {
  const data = parse.data ?? {};
  const finalRelevance = (data.relevance === 'no') ? 'no' : 'yes';
  const finalType = data.paper_type || scored.paper_type || 'unknown';
  const usage = parse.usage ?? {};
  const costUsd = estimateCostUsd(usage);

  await withTx(async (c) => {
    if (finalRelevance === 'no') {
      // Claude 가 layer4 단계에서 unrelated 로 재판정한 경우
      await c.query(
        `INSERT INTO papers_excluded
           (doi, arxiv_id, title_normalized, source,
            excluded_reason, excluded_layer, detail)
         VALUES ($1,$2,$3,$4,'claude_unrelated','layer4',$5::jsonb)`,
        [
          paper.doi, paper.arxiv_id, paper.title_normalized, paper.source,
          JSON.stringify({ raw: data, staging_id: paper.id, model: parse.model }),
        ],
      );
      await c.query(
        `UPDATE papers_staging
            SET fulltext_status='excluded',
                fulltext_error='layer4: not relevant',
                md_text = NULL
          WHERE id=$1`,
        [paper.id],
      );
      await c.query(
        `INSERT INTO papers_history
           (staging_id, doi, arxiv_id, title_normalized, source, fulltext_status)
         VALUES ($1,$2,$3,$4,$5,'excluded')`,
        [paper.id, paper.doi, paper.arxiv_id, paper.title_normalized, paper.source],
      );
    } else {
      // YES → papers_parsed + 타입별 정규화 테이블
      const { rows: [parsedRow] } = await c.query(
        `INSERT INTO papers_parsed
           (staging_id, paper_type, parsed_data, key_findings, limitations,
            source_type, model, input_tokens, output_tokens, cost_usd)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          paper.id, finalType, JSON.stringify(data),
          data.key_findings ?? null,
          data.limitations ?? null,
          parse.source_type, parse.model,
          usage.input_tokens ?? 0, usage.output_tokens ?? 0,
          costUsd,
        ],
      );
      const parsedId = parsedRow.id;

      if (finalType === 'composition') {
        await c.query(
          `INSERT INTO composition_data
             (staging_id, parsed_id, resin_type, resin_mw, resin_ratio,
              pag_type, pag_ratio, solvent, quencher, additives,
              sensitivity, resolution, ler, euv_dose, optimal_flag, raw)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,
                   $11,$12,$13,$14,COALESCE($15,FALSE),$16::jsonb)`,
          [
            paper.id, parsedId,
            data.resin_type ?? null,
            JSON.stringify(data.resin_mw ?? {}),
            data.resin_ratio ?? null,
            data.pag_type ?? null, data.pag_ratio ?? null,
            data.solvent ?? null,  data.quencher ?? null,
            JSON.stringify(data.additives ?? []),
            data.sensitivity ?? null, data.resolution ?? null,
            data.ler ?? null, data.euv_dose ?? null,
            data.optimal_flag ?? null,
            JSON.stringify(data),
          ],
        );
      } else if (finalType === 'reaction') {
        await c.query(
          `INSERT INTO reaction_conditions
             (staging_id, parsed_id, monomers, initiator_type, initiator_content, initiator_method,
              temperature, dropping_time, aging_time,
              solvent, solvent_ratio, atmosphere, monomer_conc,
              polymerization_type, cta_type, cta_content,
              methanolysis, methanolysis_temp, precipitation, filtration, drying,
              yield_pct, mw_result, composition_result,
              deprotection_temp, activation_energy,
              litho_sensitivity, litho_resolution, litho_ler, litho_euv_dose,
              raw)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,
                   $7,$8,$9,
                   $10,$11,$12,$13,
                   $14,$15,$16,
                   $17,$18,$19::jsonb,$20,$21,
                   $22,$23::jsonb,$24,
                   $25,$26,
                   $27,$28,$29,$30,
                   $31::jsonb)`,
          [
            paper.id, parsedId,
            JSON.stringify(data.monomers ?? []),
            data.initiator_type ?? null, data.initiator_content ?? null, data.initiator_method ?? null,
            data.temperature ?? null, data.dropping_time ?? null, data.aging_time ?? null,
            data.solvent ?? null, data.solvent_ratio ?? null, data.atmosphere ?? null, data.monomer_conc ?? null,
            data.polymerization_type ?? null, data.cta_type ?? null, data.cta_content ?? null,
            data.methanolysis ?? null, data.methanolysis_temp ?? null,
            JSON.stringify(data.precipitation ?? {}),
            data.filtration ?? null, data.drying ?? null,
            data.yield_pct ?? null,
            JSON.stringify(data.mw_result ?? {}),
            data.composition_result ?? null,
            data.deprotection_temp ?? null, data.activation_energy ?? null,
            data.litho_sensitivity ?? null, data.litho_resolution ?? null,
            data.litho_ler ?? null, data.litho_euv_dose ?? null,
            JSON.stringify(data),
          ],
        );
      }

      // staging 청소 + history 기록
      await c.query(
        `UPDATE papers_staging
            SET fulltext_status='batch_done',
                md_text = NULL
          WHERE id=$1`,
        [paper.id],
      );
      await c.query(
        `INSERT INTO papers_history
           (staging_id, doi, arxiv_id, title_normalized, source, fulltext_status)
         VALUES ($1,$2,$3,$4,$5,'batch_done')`,
        [paper.id, paper.doi, paper.arxiv_id, paper.title_normalized, paper.source],
      );
    }

    // cost_log
    await c.query(
      `INSERT INTO cost_log
         (day, service, operation, input_tokens, output_tokens, cost_usd, staging_id)
       VALUES (
         (now() AT TIME ZONE 'Asia/Seoul')::date,
         'claude_sonnet',
         $1,$2,$3,$4,$5
       )`,
      [
        parse.source_type === 'pdf_direct' ? 'pdf_direct' : 'md_parse',
        usage.input_tokens ?? 0, usage.output_tokens ?? 0,
        costUsd, paper.id,
      ],
    );
  });
}

// =====================================================================
// 한 건 처리
// =====================================================================
async function processOne(paper) {
  const log = logger.child({ id: paper.id });
  const scored = await fetchScored(paper.id);
  if (!scored) {
    log.warn('papers_scored 누락 — md_ready 로 되돌림');
    await query(`UPDATE papers_staging SET fulltext_status='md_ready' WHERE id=$1`, [paper.id]);
    return { id: paper.id, status: 'no_scored' };
  }

  const model = await getClaudeModel();
  let parse;

  // 1) Markdown 길이/품질 검사
  const md = paper.md_text ?? '';
  const mdBroken = isMarkdownBroken(md);

  if (!mdBroken) {
    try {
      parse = await parseWithMarkdown({ paper, scored, mdText: md, model });
      log.info({ src: 'md', model, ms: parse.latency_ms }, 'parse OK (md)');
    } catch (err) {
      log.warn({ err: err.message }, 'md 파싱 실패 → PDF fallback 검토');
      parse = null;
    }
  } else {
    log.info({ md_chars: paper.md_chars }, 'md broken → PDF fallback 검토');
  }

  if (!parse) {
    // PDF fallback — 일일 한도 체크
    const counter = await ensureDailyPdfCounter();
    if (counter.processed >= counter.limit) {
      log.warn({ counter }, 'daily_pdf_limit 초과 → queued');
      await query(
        `UPDATE papers_staging
            SET fulltext_status='queued', fulltext_error='daily_pdf_limit'
          WHERE id=$1`,
        [paper.id],
      );
      return { id: paper.id, status: 'queued' };
    }
    if (!paper.pdf_url) {
      // PDF 도 없고 md 도 깨졌고 abstract 만 있음. 최선의 fallback 으로 abstract 만 보내본다.
      try {
        parse = await parseWithMarkdown({
          paper, scored,
          mdText: `(Markdown 미확보 / abstract 만 사용)\n\n제목: ${paper.title}\n초록:\n${paper.abstract ?? ''}`,
          model,
        });
        parse.source_type = 'abstract_only';
        log.info('abstract_only 파싱 OK');
      } catch (err) {
        log.error({ err: err.message }, 'abstract_only 파싱 실패 → failed');
        await query(
          `UPDATE papers_staging
              SET fulltext_status='failed', fulltext_error=$1
            WHERE id=$2`,
          [err.message?.slice(0, 200) ?? 'parse failed', paper.id],
        );
        return { id: paper.id, status: 'failed' };
      }
    } else {
      try {
        parse = await parseWithPdf({ paper, scored, model });
        await incrementPdfProcessed(1);
        log.info({ src: 'pdf', ms: parse.latency_ms }, 'parse OK (pdf)');
      } catch (err) {
        log.error({ err: err.message }, 'pdf 파싱도 실패 → failed');
        await query(
          `UPDATE papers_staging
              SET fulltext_status='failed', fulltext_error=$1
            WHERE id=$2`,
          [err.message?.slice(0, 200) ?? 'pdf parse failed', paper.id],
        );
        return { id: paper.id, status: 'failed' };
      }
    }
  }

  await applyParseResult({ paper, scored, parse });
  return { id: paper.id, status: 'parsed', source_type: parse.source_type };
}

// =====================================================================
// 메인 루프
// =====================================================================
async function runLoop() {
  logger.info({ batch: BATCH, poll_ms: POLL_MS }, 'deep-parser starting');

  while (true) {
    let rows;
    try {
      rows = await lockBatch(BATCH);
    } catch (err) {
      logger.error({ err }, 'deep-parser: db error in poll');
      await sleep(POLL_MS);
      continue;
    }

    if (rows.length === 0) {
      await sleep(POLL_MS);
      continue;
    }

    logger.info({ count: rows.length }, 'deep-parser: processing batch');
    const results = await Promise.allSettled(rows.map(processOne));
    for (const r of results) {
      if (r.status === 'rejected') logger.error({ reason: r.reason?.message }, 'processOne rejected');
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

process.on('SIGTERM', async () => {
  logger.info('deep-parser: SIGTERM, shutting down');
  await close().catch(() => {});
  process.exit(0);
});

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runLoop().catch((err) => {
    logger.error({ err }, 'deep-parser fatal');
    process.exit(1);
  });
}

export { processOne, lockBatch };
