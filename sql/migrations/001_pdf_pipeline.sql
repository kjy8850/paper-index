-- Phase 2: PDF 파이프라인 스키마 마이그레이션
-- 적용: psql -U paperuser -d papers -f 001_pdf_pipeline.sql

-- ─── 1. research_papers 컬럼 추가 ───────────────────────────────────────────

ALTER TABLE research_papers
  ADD COLUMN IF NOT EXISTS fulltext_md            TEXT,
  ADD COLUMN IF NOT EXISTS fulltext_status        TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS fulltext_source        TEXT,
  ADD COLUMN IF NOT EXISTS fulltext_processed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulltext_attempts      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulltext_error         TEXT,
  ADD COLUMN IF NOT EXISTS embedding_v            TEXT NOT NULL DEFAULT 'abs';

-- fulltext_status 값:
--   'none'            : 초기 / pdf 없음
--   'pending'         : ingest 가 'pdf 있음' 으로 표시
--   'running'         : pdf-worker 처리 중
--   'md_ready'        : markdown 확보, batch 제출 대기
--   'batch_submitted' : batch-runner 가 Gemini 에 제출
--   'batch_done'      : 결과 반영 완료 (최종)
--   'failed'          : 재시도 3회 초과
--   'no_pdf'          : pdf_url 없음 또는 HEAD 실패

CREATE INDEX IF NOT EXISTS idx_papers_fulltext_status
  ON research_papers (fulltext_status)
  WHERE fulltext_status IN ('pending', 'running', 'md_ready', 'batch_submitted', 'failed');

-- ─── 2. api_usage (토큰·비용 추적) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_usage (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider        TEXT NOT NULL DEFAULT 'gemini',
  model           TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  is_batch        BOOLEAN NOT NULL DEFAULT false,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  caller          TEXT,
  paper_id        BIGINT,
  batch_job_id    BIGINT,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_api_usage_ts     ON api_usage (ts DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_caller ON api_usage (caller, ts DESC);

CREATE OR REPLACE VIEW v_today_cost AS
SELECT
  COALESCE(SUM(cost_usd), 0)::NUMERIC(12,6) AS spent_usd,
  COALESCE(SUM(input_tokens), 0)             AS input_tokens,
  COALESCE(SUM(output_tokens), 0)            AS output_tokens,
  COUNT(*)                                   AS calls
FROM api_usage
WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

CREATE OR REPLACE VIEW v_daily_api_cost AS
SELECT
  date_trunc('day', ts)::date AS day,
  caller,
  model,
  SUM(input_tokens)  AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cost_usd)      AS cost_usd,
  COUNT(*)           AS calls
FROM api_usage
WHERE ts > now() - INTERVAL '30 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 5 DESC;

-- ─── 3. cost_settings (일일 하드 리밋) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1,
  daily_limit_usd         NUMERIC(10,4) NOT NULL DEFAULT 1.00,
  alert_threshold_ratio   NUMERIC(4,3)  NOT NULL DEFAULT 0.80,
  hard_stop_enabled       BOOLEAN       NOT NULL DEFAULT true,
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO cost_settings (id, daily_limit_usd)
VALUES (1, 1.00)
ON CONFLICT (id) DO NOTHING;

-- ─── 4. batch_jobs ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS batch_jobs (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT UNIQUE NOT NULL,
  input_file_id   TEXT NOT NULL,
  output_file_id  TEXT,
  state           TEXT NOT NULL,
  paper_ids       BIGINT[] NOT NULL,
  request_count   INTEGER NOT NULL,
  success_count   INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  error_samples   JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_state
  ON batch_jobs (state)
  WHERE state IN ('PENDING', 'RUNNING');
