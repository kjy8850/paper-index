-- =====================================================================
-- 논문 색인 시스템 DB 스키마
-- PostgreSQL 16 + pgvector
-- 임베딩 차원: 768 (Gemini text-embedding-004)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- 제목/초록 trigram 보조 검색
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================================
-- 1) 카테고리 마스터
--    대분류(major)는 config/taxonomy.json 과 동기화.
--    중/소분류는 Gemini 가 생성한 라벨을 그대로 저장하고, 주기적으로 merge.
-- =====================================================================
CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  major_id      TEXT        NOT NULL,   -- ex) 'resin', 'pr'
  mid_label     TEXT,                   -- ex) 'EUV polymer resin'
  sub_label     TEXT,                   -- ex) 'Low LER resin'
  usage_count   INTEGER     NOT NULL DEFAULT 0,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (major_id, mid_label, sub_label)
);

CREATE INDEX IF NOT EXISTS idx_categories_major ON categories (major_id);

-- =====================================================================
-- 2) 논문 본체
-- =====================================================================
CREATE TABLE IF NOT EXISTS research_papers (
  id                BIGSERIAL PRIMARY KEY,

  -- 식별자 (중복 제거 키)
  doi               TEXT UNIQUE,
  arxiv_id          TEXT UNIQUE,
  source            TEXT        NOT NULL,        -- 'arxiv'|'semantic_scholar'|'chemrxiv'|'manual'
  source_id         TEXT        NOT NULL,        -- 원 소스의 ID
  url               TEXT,
  pdf_url           TEXT,

  -- 기본 메타
  title             TEXT        NOT NULL,
  abstract          TEXT,
  authors           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  published_at      DATE,
  venue             TEXT,
  citations         INTEGER     NOT NULL DEFAULT 0,

  -- Gemini 분석 결과
  summary_ko        TEXT,                        -- 한글 3-4줄 요약
  key_findings      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- string[]
  materials         JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 언급된 소재 리스트
  techniques        JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 분석/공정 기법
  novelty_score     SMALLINT,                    -- 0-10 (Gemini 가 채점)
  relevance_score   SMALLINT,                    -- 0-10 (우리 키워드 대비)

  -- 분류 (하이브리드)
  major_category    TEXT        NOT NULL,        -- 고정 taxonomy 의 id
  mid_category      TEXT,                        -- Gemini 제안 or 기존 선택
  sub_category      TEXT,                        -- 동상
  tags              JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- 임베딩 (768 dim)
  embedding         vector(768),

  -- 운영용
  raw_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT papers_identifier_chk CHECK (
    doi IS NOT NULL OR arxiv_id IS NOT NULL OR source_id IS NOT NULL
  )
);

-- B-Tree 인덱스: 카테고리 1차 필터링
CREATE INDEX IF NOT EXISTS idx_papers_major    ON research_papers (major_category);
CREATE INDEX IF NOT EXISTS idx_papers_mid      ON research_papers (mid_category);
CREATE INDEX IF NOT EXISTS idx_papers_sub      ON research_papers (sub_category);
CREATE INDEX IF NOT EXISTS idx_papers_pubdate  ON research_papers (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_source   ON research_papers (source, source_id);
CREATE INDEX IF NOT EXISTS idx_papers_novelty  ON research_papers (novelty_score DESC);

-- Trigram 보조 검색 (제목)
CREATE INDEX IF NOT EXISTS idx_papers_title_trgm
  ON research_papers USING gin (title gin_trgm_ops);

-- HNSW 벡터 인덱스 (코사인 거리)
-- 수만 건 규모에서 초고속 근사 최근접 검색.
CREATE INDEX IF NOT EXISTS idx_papers_embedding_hnsw
  ON research_papers
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_papers_updated_at ON research_papers;
CREATE TRIGGER trg_papers_updated_at
BEFORE UPDATE ON research_papers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 3) Ingestion 로그
--    어느 소스에서 몇 건, 실패 몇 건이 있었는지 추적.
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

CREATE INDEX IF NOT EXISTS idx_ingestion_run    ON ingestion_log (run_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_source ON ingestion_log (source, started_at DESC);

-- =====================================================================
-- 4) 검색 로그 (선택: 사용자 질문·결과 추적해서 품질 개선)
-- =====================================================================
CREATE TABLE IF NOT EXISTS search_log (
  id            BIGSERIAL PRIMARY KEY,
  question      TEXT        NOT NULL,
  filter_major  TEXT,
  top_k         INTEGER     NOT NULL DEFAULT 0,
  latency_ms    INTEGER     NOT NULL DEFAULT 0,
  result_ids    BIGINT[]    NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log (created_at DESC);

-- =====================================================================
-- 5) 편의 뷰: 최근 수집 현황
-- =====================================================================
CREATE OR REPLACE VIEW v_daily_ingestion AS
SELECT
  date_trunc('day', started_at) AS day,
  source,
  SUM(ingested) AS ingested,
  SUM(failed)   AS failed
FROM ingestion_log
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
