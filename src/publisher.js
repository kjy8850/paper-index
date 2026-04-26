// =====================================================================
// Layer 5 — Publisher
// papers_parsed (+ papers_staging) 의 결과물을 검색 가능한 research_papers
// 로 publish 하고, embedding(768) 까지 채운다.
//
// 매칭 키 (UPSERT 우선순위):
//   1. research_papers.staging_id == papers_parsed.staging_id  (003 마이그레이션 후)
//   2. doi (UNIQUE)
//   3. arxiv_id (UNIQUE)
//
// 실행 흐름:
//   - v_publish_pending 뷰에서 publish_state IN ('new','update') 인 행 N개 픽업
//   - papers_parsed.parsed_data + composition_data + reaction_conditions 까지 합쳐
//     summary_ko / key_findings / materials / techniques / major_category 매핑
//   - embedding 텍스트:  title + " " + key_findings + " " + abstract
//   - UPSERT (staging_id 매칭 우선)
//   - publisher_total_published / publisher_last_run 갱신
//
// 안전장치:
//   - 한 건 실패가 전체 중단을 일으키지 않도록 try/catch 개별 처리
//   - embedText 실패 시 publish skip (다음 폴링에서 재시도)
//   - papers_excluded 또는 'no' 로 마감된 건은 publish 대상이 아님
// =====================================================================

import 'dotenv/config';
import { logger } from './lib/logger.js';
import { query, withTx, toVectorLiteral, close } from './lib/db.js';
import { embedText } from './lib/embedding.js';
import { getInt, setConfig } from './lib/system-config.js';

const POLL_MS = Number(process.env.PUBLISHER_POLL_MS ?? 20_000);

// =====================================================================
// 후보 픽업
// v_publish_pending 뷰는 003 마이그레이션이 만든다.
// =====================================================================
async function fetchCandidates(batch) {
  const { rows } = await query(
    `SELECT vp.parsed_id, vp.staging_id, vp.publish_state, vp.research_paper_id
       FROM v_publish_pending vp
      WHERE vp.publish_state IN ('new','update')
      ORDER BY vp.parsed_at ASC
      LIMIT $1`,
    [batch],
  );
  return rows;
}

// 한 staging_id 의 모든 컨텍스트 (parsed + composition + reaction + staging meta)
async function fetchContext(stagingId) {
  const [{ rows: stagingRows }, { rows: parsedRows }, { rows: compRows }, { rows: rxRows }, { rows: scoredRows }] =
    await Promise.all([
      query(
        `SELECT id, doi, arxiv_id, source, source_id, url, pdf_url,
                title, abstract, authors, year, venue, citations,
                category_hint, title_normalized
           FROM papers_staging WHERE id = $1`, [stagingId],
      ),
      query(
        `SELECT id, paper_type, parsed_data, key_findings, limitations, model
           FROM papers_parsed WHERE staging_id = $1
           ORDER BY parsed_at DESC LIMIT 1`, [stagingId],
      ),
      query(`SELECT * FROM composition_data WHERE staging_id = $1
              ORDER BY created_at DESC`, [stagingId]),
      query(`SELECT * FROM reaction_conditions WHERE staging_id = $1
              ORDER BY created_at DESC`, [stagingId]),
      query(`SELECT relevance, paper_type FROM papers_scored
              WHERE staging_id = $1 ORDER BY scored_at DESC LIMIT 1`, [stagingId]),
    ]);
  const staging = stagingRows[0];
  if (!staging) return null;
  const parsed  = parsedRows[0];
  return { staging, parsed, comp: compRows, rx: rxRows, scored: scoredRows[0] };
}

// =====================================================================
// 매핑: parsed_data + 보조 테이블 → research_papers 컬럼
// =====================================================================
function mapMajor(paperType) {
  switch (paperType) {
    case 'composition': return 'pr';
    case 'reaction':    return 'resin';
    case 'process':     return 'develop_etch';
    case 'other':       return 'misc_semi';
    case 'abstract_only':
    case 'unknown':
    default:            return 'novel_idea';
  }
}

function pickMaterials(comp, rx, parsed) {
  const out = new Set();
  for (const c of comp) {
    if (c.resin_type)  out.add(`resin:${c.resin_type}`);
    if (c.pag_type)    out.add(`PAG:${c.pag_type}`);
    if (c.solvent)     out.add(`solvent:${c.solvent}`);
    if (c.quencher)    out.add(`quencher:${c.quencher}`);
  }
  for (const r of rx) {
    const monos = Array.isArray(r.monomers) ? r.monomers : [];
    for (const m of monos) if (m?.name) out.add(`monomer:${m.name}`);
    if (r.initiator_type) out.add(`initiator:${r.initiator_type}`);
    if (r.solvent)        out.add(`rxn_solvent:${r.solvent}`);
  }
  // parsed_data 안의 free-form materials 도 반영
  if (Array.isArray(parsed?.parsed_data?.materials)) {
    for (const m of parsed.parsed_data.materials) if (m) out.add(String(m));
  }
  return Array.from(out);
}

function pickTechniques(parsed, comp, rx) {
  const out = new Set();
  if (parsed?.paper_type) out.add(`type:${parsed.paper_type}`);
  for (const c of comp) {
    if (Number.isFinite(Number(c.sensitivity))) out.add('sensitivity_measured');
    if (Number.isFinite(Number(c.resolution)))  out.add('resolution_measured');
    if (Number.isFinite(Number(c.ler)))         out.add('ler_measured');
  }
  for (const r of rx) {
    if (r.polymerization_type) out.add(`poly:${r.polymerization_type}`);
    if (r.methanolysis === true) out.add('methanolysis');
  }
  // parsed_data.equipment_methods
  if (Array.isArray(parsed?.parsed_data?.equipment_methods)) {
    for (const e of parsed.parsed_data.equipment_methods) if (e) out.add(String(e));
  }
  return Array.from(out);
}

function buildSummaryKo(parsed) {
  const d = parsed?.parsed_data ?? {};
  return d.key_findings_ko ?? parsed?.key_findings ?? d.key_findings ?? '';
}

function buildKeyFindingsArray(parsed) {
  const d = parsed?.parsed_data ?? {};
  // 가능한 한 배열로 정규화
  if (Array.isArray(d.key_findings)) return d.key_findings;
  if (typeof d.key_findings === 'string') {
    return d.key_findings.split(/[\n.•·]\s*/).filter(Boolean).slice(0, 8);
  }
  if (typeof parsed?.key_findings === 'string') {
    return parsed.key_findings.split(/[\n.•·]\s*/).filter(Boolean).slice(0, 8);
  }
  return [];
}

function buildEmbeddingText({ staging, parsed, comp, rx }) {
  const parts = [
    staging.title ?? '',
    parsed?.key_findings ?? parsed?.parsed_data?.key_findings ?? '',
    staging.abstract ?? '',
  ];
  // composition / reaction 의 핵심 수치도 임베딩에 살짝 흘림
  if (comp.length) {
    const c = comp[0];
    parts.push([
      c.resin_type, c.pag_type, c.solvent,
      c.sensitivity ? `sens=${c.sensitivity}mJ` : null,
      c.resolution  ? `res=${c.resolution}nm` : null,
    ].filter(Boolean).join(' '));
  }
  if (rx.length) {
    const r = rx[0];
    parts.push([
      r.polymerization_type,
      r.temperature ? `${r.temperature}C` : null,
      r.yield_pct   ? `yield=${r.yield_pct}%` : null,
    ].filter(Boolean).join(' '));
  }
  return parts.filter(Boolean).join('\n').trim().slice(0, 7800);
}

// =====================================================================
// UPSERT (staging_id 매칭 우선, 없으면 doi/arxiv_id)
// =====================================================================
async function upsertResearchPaper(c, ctx, embedding) {
  const { staging, parsed, comp, rx } = ctx;
  const major   = mapMajor(parsed?.paper_type ?? 'unknown');
  const summary = buildSummaryKo(parsed);
  const findings = buildKeyFindingsArray(parsed);
  const materials = pickMaterials(comp, rx, parsed);
  const techniques = pickTechniques(parsed, comp, rx);
  const tags = parsed?.parsed_data?.tags ?? [];
  const novelty   = Number.isFinite(parsed?.parsed_data?.novelty_score)   ? parsed.parsed_data.novelty_score   : null;
  const relevance = Number.isFinite(parsed?.parsed_data?.relevance_score) ? parsed.parsed_data.relevance_score : 8;

  const vecLit = embedding ? toVectorLiteral(embedding) : null;
  const publishedDate = staging.year ? `${staging.year}-01-01` : null;

  // 1. staging_id 로 매칭되는 행이 있나?
  const { rows: existsByStaging } = await c.query(
    `SELECT id FROM research_papers WHERE staging_id = $1 LIMIT 1`,
    [staging.id],
  );
  // 2. doi / arxiv_id
  const { rows: existsByExt } = await c.query(
    `SELECT id FROM research_papers
      WHERE ($1::text IS NOT NULL AND doi = $1)
         OR ($2::text IS NOT NULL AND arxiv_id = $2)
      LIMIT 1`,
    [staging.doi, staging.arxiv_id],
  );

  const targetId = existsByStaging[0]?.id ?? existsByExt[0]?.id ?? null;

  if (targetId) {
    // UPDATE
    await c.query(
      `UPDATE research_papers SET
         doi              = COALESCE(doi, $1),
         arxiv_id         = COALESCE(arxiv_id, $2),
         source           = COALESCE($3, source),
         source_id        = COALESCE($4, source_id),
         url              = COALESCE($5, url),
         pdf_url          = COALESCE($6, pdf_url),
         title            = $7,
         abstract         = COALESCE($8, abstract),
         authors          = $9::jsonb,
         published_at     = COALESCE($10::date, published_at),
         venue            = COALESCE($11, venue),
         citations        = GREATEST(citations, $12),
         summary_ko       = $13,
         key_findings     = $14::jsonb,
         materials        = $15::jsonb,
         techniques       = $16::jsonb,
         tags             = $17::jsonb,
         major_category   = $18,
         novelty_score    = COALESCE($19, novelty_score),
         relevance_score  = COALESCE($20, relevance_score),
         embedding        = COALESCE($21::vector, embedding),
         staging_id       = $22,
         published_v2_at  = now(),
         updated_at       = now()
       WHERE id = $23`,
      [
        staging.doi, staging.arxiv_id, staging.source, staging.source_id,
        staging.url, staging.pdf_url, staging.title, staging.abstract,
        JSON.stringify(staging.authors ?? []),
        publishedDate, staging.venue, staging.citations ?? 0,
        summary,
        JSON.stringify(findings),
        JSON.stringify(materials),
        JSON.stringify(techniques),
        JSON.stringify(tags),
        major, novelty, relevance,
        vecLit, staging.id, targetId,
      ],
    );
    return { id: targetId, op: 'update' };
  }

  // INSERT
  const { rows } = await c.query(
    `INSERT INTO research_papers
      (doi, arxiv_id, source, source_id, url, pdf_url,
       title, abstract, authors, published_at, venue, citations,
       summary_ko, key_findings, materials, techniques, tags,
       major_category, novelty_score, relevance_score,
       embedding, staging_id, published_v2_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,
       $7,$8,$9::jsonb,$10::date,$11,$12,
       $13,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,
       $18,$19,$20,
       $21::vector,$22, now())
     RETURNING id`,
    [
      staging.doi, staging.arxiv_id, staging.source, staging.source_id,
      staging.url, staging.pdf_url,
      staging.title, staging.abstract,
      JSON.stringify(staging.authors ?? []),
      publishedDate, staging.venue, staging.citations ?? 0,
      summary,
      JSON.stringify(findings),
      JSON.stringify(materials),
      JSON.stringify(techniques),
      JSON.stringify(tags),
      major, novelty, relevance,
      vecLit, staging.id,
    ],
  );
  return { id: rows[0].id, op: 'insert' };
}

// =====================================================================
// 한 건 publish
// =====================================================================
async function publishOne(stagingId) {
  const log = logger.child({ stagingId, mod: 'publisher' });
  const ctx = await fetchContext(stagingId);
  if (!ctx) { log.warn('staging row 사라짐'); return { skip: 'missing_staging' }; }
  if (!ctx.parsed) { log.warn('parsed 행 없음 — 아직 publish 불가'); return { skip: 'no_parsed' }; }
  if (ctx.scored?.relevance === 'no') {
    log.info('scored=no — publish 대상 아님');
    return { skip: 'not_relevant' };
  }

  // 임베딩
  let embedding;
  try {
    const text = buildEmbeddingText(ctx);
    embedding = text ? await embedText(text, 'RETRIEVAL_DOCUMENT') : null;
  } catch (err) {
    log.warn({ err: err.message }, 'embedding 실패 — 텍스트만 publish');
    embedding = null;
  }

  const result = await withTx((c) => upsertResearchPaper(c, ctx, embedding));
  log.info({ id: result.id, op: result.op, has_embedding: !!embedding }, 'published');
  return result;
}

// =====================================================================
// 메인 루프
// =====================================================================
async function runLoop() {
  const batch = await getInt('publisher_batch_size', 20);
  logger.info({ batch, poll_ms: POLL_MS }, 'publisher starting');

  while (true) {
    let cands;
    try {
      cands = await fetchCandidates(batch);
    } catch (err) {
      logger.error({ err }, 'publisher: fetchCandidates 실패');
      await sleep(POLL_MS);
      continue;
    }

    if (cands.length === 0) {
      await sleep(POLL_MS);
      continue;
    }

    logger.info({ count: cands.length }, 'publisher: batch 처리');
    let okCount = 0;
    const results = await Promise.allSettled(cands.map((c) => publishOne(c.staging_id)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.id) okCount += 1;
      if (r.status === 'rejected') logger.error({ reason: r.reason?.message }, 'publishOne rejected');
    }

    if (okCount > 0) {
      const prev = await getInt('publisher_total_published', 0);
      await setConfig('publisher_total_published', prev + okCount);
      await setConfig('publisher_last_run', new Date().toISOString());
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

process.on('SIGTERM', async () => {
  logger.info('publisher: SIGTERM, shutting down');
  await close().catch(() => {});
  process.exit(0);
});

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runLoop().catch((err) => {
    logger.error({ err }, 'publisher fatal');
    process.exit(1);
  });
}

export { publishOne, fetchCandidates, fetchContext };
