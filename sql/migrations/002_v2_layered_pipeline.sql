-- =====================================================================
-- v2 스키마 마이그레이션 — 5-Layer Pipeline
--
--   * 안전 원칙
--     - 모든 CREATE 는 IF NOT EXISTS, ADD COLUMN 도 IF NOT EXISTS.
--     - 기존 운영 DB(batch_done 200건 보존)와 신규 환경 모두에서 동작.
--     - 트랜잭션 1개로 묶어 실패 시 전체 롤백.
--
--   * 적용 방법
--       (NAS Postgres) make migrate                       -- 또는
--       psql -h <NAS_IP> -U paperuser -d papers \
--            -f sql/migrations/001_v2_schema.sql
--
--   * Idempotent: 여러 번 실행해도 안전.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 0) 확장
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================================
-- 1) papers_staging — 수집·처리 대기 큐 (이미 미니PC 에 있을 수 있음)
--    fulltext_status 흐름:
--      pending      Layer 1: PDF URL 있음, 대기
--      no_pdf       Layer 1: PDF URL 없음
--      md_ready     Layer 3: Docling 변환 완료
--      queued       Layer 4: 일일 한도 초과, 다음날 이월
--      broken       Layer 4: Markdown 품질 불량 감지
--      failed       Layer 4: PDF 직접 투입 후에도 파싱 실패
--      batch_done   Layer 4: 파싱 완료
--      no_pdf_done  Layer 3: abstract 만 저장 완료
-- =====================================================================
CREATE TABLE IF NOT EXISTS papers_staging (
  id                BIGSERIAL PRIMARY KEY,

  -- 식별자
  doi               TEXT,
  arxiv_id          TEXT,
  source            TEXT        NOT NULL,
  source_id         TEXT,

  -- 메타
  title             TEXT        NOT NULL,
  title_normalized  TEXT,
  authors           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  year              INTEGER,
  abstract          TEXT,
  url               TEXT,
  pdf_url           TEXT,
  venue             TEXT,
  citations         INTEGER     NOT NULL DEFAULT 0,
  category_hint     TEXT,

  -- 상태
  fulltext_status   TEXT        NOT NULL DEFAULT 'pending',
  fulltext_error    TEXT,
  md_text           TEXT,                                  -- Docling 변환 결과 (파싱 후 NULL 처리)
  md_chars          INTEGER,
  md_ready_at       TIMESTAMPTZ,

  -- 운영
  raw_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 누락 컬럼 안전 추가 (기존 미니PC 환경 고려)
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS title_normalized TEXT;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS year             INTEGER;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS arxiv_id         TEXT;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS category_hint    TEXT;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS fulltext_error   TEXT;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS md_text          TEXT;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS md_chars         INTEGER;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS md_ready_at      TIMESTAMPTZ;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS raw_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE papers_staging ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_staging_doi              ON papers_staging (doi);
CREATE INDEX IF NOT EXISTS idx_staging_arxiv_id         ON papers_staging (arxiv_id);
CREATE INDEX IF NOT EXISTS idx_staging_title_norm       ON papers_staging (title_normalized);
CREATE INDEX IF NOT EXISTS idx_staging_status           ON papers_staging (fulltext_status);
CREATE INDEX IF NOT EXISTS idx_staging_status_collected ON papers_staging (fulltext_status, collected_at);

-- =====================================================================
-- 2) papers_history — 처리 완료된 논문의 영구 기록 (중복 제거 시 대조)
-- =====================================================================
CREATE TABLE IF NOT EXISTS papers_history (
  id                BIGSERIAL PRIMARY KEY,
  staging_id        BIGINT,                       -- 참고용. FK 는 걸지 않음 (staging 정리 가능)
  doi               TEXT,
  arxiv_id          TEXT,
  title_normalized  TEXT,
  source            TEXT,
  fulltext_status   TEXT,                         -- batch_done | no_pdf_done | failed
  research_paper_id BIGINT,                       -- research_papers.id 와 동기화 (있을 때)
  finished_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE papers_history ADD COLUMN IF NOT EXISTS arxiv_id          TEXT;
ALTER TABLE papers_history ADD COLUMN IF NOT EXISTS fulltext_status   TEXT;
ALTER TABLE papers_history ADD COLUMN IF NOT EXISTS title_normalized  TEXT;
ALTER TABLE papers_history ADD COLUMN IF NOT EXISTS staging_id        BIGINT;
ALTER TABLE papers_history ADD COLUMN IF NOT EXISTS research_paper_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_history_doi        ON papers_history (doi);
CREATE INDEX IF NOT EXISTS idx_history_arxiv_id   ON papers_history (arxiv_id);
CREATE INDEX IF NOT EXISTS idx_history_title_norm ON papers_history (title_normalized);
CREATE INDEX IF NOT EXISTS idx_history_finished   ON papers_history (finished_at DESC);

-- =====================================================================
-- 3) papers_excluded — Layer 2 에서 제외된 논문 (재수집 차단용)
-- =====================================================================
CREATE TABLE IF NOT EXISTS papers_excluded (
  id                BIGSERIAL PRIMARY KEY,
  doi               TEXT,
  arxiv_id          TEXT,
  title_normalized  TEXT,
  source            TEXT,
  excluded_reason   TEXT NOT NULL,                -- low_relevance | claude_unrelated | parse_failed_unrelated
  excluded_layer    TEXT NOT NULL DEFAULT 'layer2', -- layer2 | layer4
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  excluded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_excluded_doi        ON papers_excluded (doi);
CREATE INDEX IF NOT EXISTS idx_excluded_arxiv_id   ON papers_excluded (arxiv_id);
CREATE INDEX IF NOT EXISTS idx_excluded_title_norm ON papers_excluded (title_normalized);
CREATE INDEX IF NOT EXISTS idx_excluded_at         ON papers_excluded (excluded_at DESC);

-- =====================================================================
-- 4) papers_scored — Gemini 관련성 판단 결과 (Layer 2 출력)
-- =====================================================================
CREATE TABLE IF NOT EXISTS papers_scored (
  id                BIGSERIAL PRIMARY KEY,
  staging_id        BIGINT NOT NULL,
  doi               TEXT,
  arxiv_id          TEXT,
  relevance         TEXT NOT NULL,                -- yes | no | unsure
  paper_type        TEXT,                         -- composition | reaction | process | other | unknown
  scored_by         TEXT NOT NULL DEFAULT 'gemini-flash-batch',
  raw_response      JSONB NOT NULL DEFAULT '{}'::jsonb,
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scored_staging   ON papers_scored (staging_id);
CREATE INDEX IF NOT EXISTS idx_scored_relevance ON papers_scored (relevance);
CREATE INDEX IF NOT EXISTS idx_scored_type      ON papers_scored (paper_type);

-- =====================================================================
-- 5) papers_parsed — Claude Deep Parser 출력 (Layer 4)
-- =====================================================================
CREATE TABLE IF NOT EXISTS papers_parsed (
  id                BIGSERIAL PRIMARY KEY,
  staging_id        BIGINT NOT NULL,
  paper_type        TEXT NOT NULL,                -- composition | reaction | process | abstract_only | other
  parsed_data       JSONB NOT NULL,
  key_findings      TEXT,
  limitations       TEXT,
  source_type       TEXT NOT NULL,                -- fulltext_md | pdf_direct | abstract_only
  model             TEXT,                         -- claude-sonnet-4-6 등
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_usd          NUMERIC(10,6),
  parsed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parsed_staging   ON papers_parsed (staging_id);
CREATE INDEX IF NOT EXISTS idx_parsed_type      ON papers_parsed (paper_type);
CREATE INDEX IF NOT EXISTS idx_parsed_at        ON papers_parsed (parsed_at DESC);
CREATE INDEX IF NOT EXISTS idx_parsed_data_gin  ON papers_parsed USING gin (parsed_data jsonb_path_ops);

-- =====================================================================
-- 6) composition_data — composition 타입 정규화 추출
-- =====================================================================
CREATE TABLE IF NOT EXISTS composition_data (
  id            BIGSERIAL PRIMARY KEY,
  staging_id    BIGINT NOT NULL,
  parsed_id     BIGINT,
  resin_type    TEXT,
  resin_mw      JSONB,                            -- {Mn, Mw, PDI}
  resin_ratio   TEXT,
  pag_type      TEXT,
  pag_ratio     TEXT,
  solvent       TEXT,
  quencher      TEXT,
  additives     JSONB,
  sensitivity   DOUBLE PRECISION,                 -- mJ/cm²
  resolution    DOUBLE PRECISION,                 -- nm
  ler           DOUBLE PRECISION,                 -- nm
  euv_dose      DOUBLE PRECISION,
  optimal_flag  BOOLEAN NOT NULL DEFAULT FALSE,
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compdata_staging   ON composition_data (staging_id);
CREATE INDEX IF NOT EXISTS idx_compdata_resin     ON composition_data (resin_type);
CREATE INDEX IF NOT EXISTS idx_compdata_pag       ON composition_data (pag_type);
CREATE INDEX IF NOT EXISTS idx_compdata_optimal   ON composition_data (optimal_flag) WHERE optimal_flag;

-- =====================================================================
-- 7) reaction_conditions — reaction 타입 정규화 추출
-- =====================================================================
CREATE TABLE IF NOT EXISTS reaction_conditions (
  id                  BIGSERIAL PRIMARY KEY,
  staging_id          BIGINT NOT NULL,
  parsed_id           BIGINT,

  monomers            JSONB,
  initiator_type      TEXT,
  initiator_content   TEXT,
  initiator_method    TEXT,

  temperature         DOUBLE PRECISION,
  dropping_time       DOUBLE PRECISION,
  aging_time          DOUBLE PRECISION,

  solvent             TEXT,
  solvent_ratio       TEXT,
  atmosphere          TEXT,
  monomer_conc        DOUBLE PRECISION,

  polymerization_type TEXT,
  cta_type            TEXT,
  cta_content         TEXT,

  methanolysis        BOOLEAN,
  methanolysis_temp   DOUBLE PRECISION,
  precipitation       JSONB,
  filtration          TEXT,
  drying              TEXT,

  yield_pct           DOUBLE PRECISION,
  mw_result           JSONB,
  composition_result  JSONB,

  deprotection_temp   DOUBLE PRECISION,
  activation_energy   DOUBLE PRECISION,

  litho_sensitivity   DOUBLE PRECISION,
  litho_resolution    DOUBLE PRECISION,
  litho_ler           DOUBLE PRECISION,
  litho_euv_dose      DOUBLE PRECISION,

  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_react_staging  ON reaction_conditions (staging_id);
CREATE INDEX IF NOT EXISTS idx_react_polytype ON reaction_conditions (polymerization_type);

-- =====================================================================
-- 8) system_config — 운영 상태 KV
-- =====================================================================
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sysconfig_touch() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sysconfig_touch ON system_config;
CREATE TRIGGER trg_sysconfig_touch
BEFORE UPDATE ON system_config
FOR EACH ROW EXECUTE FUNCTION sysconfig_touch();

INSERT INTO system_config (key, value) VALUES
  ('phase1_completed',        'false'),
  ('phase1_last_cursor',      '{}'),                 -- JSON: { openalex: '...', s2: 0, arxiv: 0, chemrxiv: 0 }
  ('phase1_collected_today',  '0'),
  ('phase1_start_time',       ''),
  ('phase1_total_collected',  '0'),
  ('daily_pdf_limit',         '10'),
  ('daily_pdf_processed',     '0'),
  ('daily_pdf_reset_at',      ''),                   -- ISO8601 KST
  ('backfill_enabled',        'false'),              -- Phase 1 완료 후 자동 true
  ('claude_model',            'claude-sonnet-4-6'),
  ('gemini_relevance_prompt_version', '1')
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 9) cost_log — 일일 API 비용 추적 (cost_gate 와 연동)
-- =====================================================================
CREATE TABLE IF NOT EXISTS cost_log (
  id              BIGSERIAL PRIMARY KEY,
  day             DATE        NOT NULL,             -- KST 기준
  service         TEXT        NOT NULL,             -- gemini_flash | gemini_batch | claude_sonnet
  operation       TEXT        NOT NULL,             -- relevance_score | md_parse | pdf_direct
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  staging_id      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costlog_day_service ON cost_log (day, service);

CREATE OR REPLACE VIEW v_daily_cost AS
SELECT day,
       SUM(cost_usd) FILTER (WHERE service LIKE 'gemini%') AS gemini_usd,
       SUM(cost_usd) FILTER (WHERE service = 'claude_sonnet') AS claude_usd,
       SUM(cost_usd) AS total_usd
FROM cost_log
GROUP BY day
ORDER BY day DESC;

-- =====================================================================
-- 10) ingestion_log — 신규 컬럼 (Phase 정보)
-- =====================================================================
CREATE TABLE IF NOT EXISTS ingestion_log (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID        NOT NULL DEFAULT uuid_generate_v4(),
  source          TEXT        NOT NULL,
  query           TEXT,
  requested       INTEGER     NOT NULL DEFAULT 0,
  fetched         INTEGER     NOT NULL DEFAULT 0,
  deduped         INTEGER     NOT NULL DEFAULT 0,
  ingested        INTEGER     NOT NULL DEFAULT 0,
  failed          INTEGER     NOT NULL DEFAULT 0,
  error_samples   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

ALTER TABLE ingestion_log ADD COLUMN IF NOT EXISTS phase            TEXT;     -- 'phase1' | 'phase2'
ALTER TABLE ingestion_log ADD COLUMN IF NOT EXISTS staged           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_log ADD COLUMN IF NOT EXISTS excluded_dedup   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ingestion_phase  ON ingestion_log (phase, started_at DESC);

-- =====================================================================
-- 11) 편의 뷰 — 파이프라인 현황
-- =====================================================================
CREATE OR REPLACE VIEW v_pipeline_status AS
SELECT fulltext_status, COUNT(*) AS n
FROM papers_staging
GROUP BY fulltext_status
ORDER BY n DESC;

CREATE OR REPLACE VIEW v_layer4_today AS
SELECT
  date_trunc('day', parsed_at AT TIME ZONE 'Asia/Seoul') AS day_kst,
  source_type,
  COUNT(*)                  AS parsed,
  SUM(cost_usd)             AS cost_usd,
  AVG(input_tokens)::INT    AS avg_in_tokens,
  AVG(output_tokens)::INT   AS avg_out_tokens
FROM papers_parsed
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMIT;

-- =====================================================================
-- 후속 안내 (수동 실행 권장)
--
-- 1) 기존 batch_done 200건이 papers_history 에 있는데 staging_id 가 비어있는 경우:
--    아래 스크립트를 실행해 backfill 큐에 등록하세요 (Phase 1 완료 후 실행).
--      node scripts/backfill-parse.js --enqueue
--
-- 2) HNSW 인덱스(research_papers.embedding) 가 이미 있다면 건드리지 않습니다.
--    벡터 차원·모델을 바꿀 때만 REINDEX 필요.
-- =====================================================================
