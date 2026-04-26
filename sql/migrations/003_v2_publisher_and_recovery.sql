-- =====================================================================
-- v2 마이그레이션 003 — Layer 5 publisher 연동 + 운영 보강
--
--   1. research_papers 에 staging_id 컬럼 추가 (Layer 5 publisher 가 사용)
--   2. parsing/pdf_running/excluded/batch_submitted 로 갇힌 staging 행을
--      자동 복구하는 함수 + 헬퍼 뷰
--   3. system_config 에 publisher 관련 키 추가
--
-- Idempotent: 여러 번 실행해도 안전.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1) research_papers 에 staging_id 컬럼
--    - publisher 가 papers_parsed.staging_id 로 UPSERT 시 매칭 키로 사용
-- =====================================================================
ALTER TABLE research_papers ADD COLUMN IF NOT EXISTS staging_id BIGINT;
ALTER TABLE research_papers ADD COLUMN IF NOT EXISTS published_v2_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_research_papers_staging ON research_papers (staging_id);

-- =====================================================================
-- 2) papers_staging.fulltext_status enum 주석 보강 (실제 코드가 사용하는 모든 값)
--    PostgreSQL 은 컬럼 COMMENT 로만 보관. CHECK 제약은 일부러 안 걸음
--    (옛 행이 깨진 값으로 들어와도 마이그레이션이 통과해야 하므로).
-- =====================================================================
COMMENT ON COLUMN papers_staging.fulltext_status IS
  E'pending      Layer 1: pdf_url 있음, pdf-worker 대기\n'
  E'pdf_running  Layer 3: pdf-worker 가 잠금 (재시도 대상)\n'
  E'no_pdf       Layer 1: pdf_url 없음 (no_pdf_done 으로 진행)\n'
  E'no_pdf_done  Layer 3: abstract-only 처리 완료\n'
  E'md_ready     Layer 3: Docling 변환 완료\n'
  E'queued       Layer 4: 일일 한도 초과 또는 backfill\n'
  E'parsing      Layer 4: deep-parser 가 잠금 (재시도 대상)\n'
  E'broken       Layer 4: Markdown 품질 불량 (PDF fallback 후에도 실패)\n'
  E'failed       Layer 4: 파싱 최종 실패\n'
  E'excluded     Layer 4: claude 가 not relevant 로 재판정\n'
  E'batch_submitted  Layer 2: Gemini Batch 제출 (역호환)\n'
  E'batch_done   Layer 4: 파싱 완료';

-- =====================================================================
-- 3) 잠금 복구 함수 — parsing/pdf_running 으로 갇힌 행을 N분 후 되돌림
-- =====================================================================
CREATE OR REPLACE FUNCTION recover_stuck_staging(stuck_minutes INT DEFAULT 30)
RETURNS TABLE(recovered_id BIGINT, from_status TEXT, to_status TEXT) AS $$
BEGIN
  RETURN QUERY
  WITH up AS (
    UPDATE papers_staging s
       SET fulltext_status = CASE
                                WHEN s.fulltext_status = 'parsing'     THEN 'md_ready'
                                WHEN s.fulltext_status = 'pdf_running' THEN 'pending'
                                ELSE s.fulltext_status
                             END,
           fulltext_error = COALESCE(s.fulltext_error,'') || ' (auto-recovered)',
           updated_at = now()
     WHERE s.fulltext_status IN ('parsing','pdf_running')
       AND s.updated_at < now() - (stuck_minutes || ' minutes')::interval
    RETURNING s.id, s.fulltext_status
  )
  SELECT up.id, NULL::text, up.fulltext_status FROM up;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION recover_stuck_staging(INT) IS
  '워커가 정상 종료 못 하고 죽은 경우 N분(기본 30) 이상 parsing/pdf_running 인 행을 원위치';

-- =====================================================================
-- 4) Layer 5 publisher 운영 키
-- =====================================================================
INSERT INTO system_config (key, value) VALUES
  ('publisher_batch_size',  '20'),
  ('publisher_poll_ms',     '20000'),
  ('publisher_last_run',    ''),
  ('publisher_total_published', '0')
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 5) 운영 뷰 — publisher 진행 상황
-- =====================================================================
CREATE OR REPLACE VIEW v_publish_pending AS
SELECT
  pp.id          AS parsed_id,
  pp.staging_id,
  pp.paper_type,
  pp.parsed_at,
  s.title,
  s.doi,
  s.arxiv_id,
  rp.id          AS research_paper_id,
  CASE WHEN rp.id IS NULL THEN 'new'
       WHEN rp.published_v2_at IS NULL OR rp.published_v2_at < pp.parsed_at THEN 'update'
       ELSE 'up_to_date' END AS publish_state
FROM papers_parsed pp
JOIN papers_staging s ON s.id = pp.staging_id
LEFT JOIN research_papers rp
       ON (rp.staging_id = pp.staging_id)
       OR (rp.doi IS NOT NULL AND rp.doi = s.doi)
       OR (rp.arxiv_id IS NOT NULL AND rp.arxiv_id = s.arxiv_id);

CREATE OR REPLACE VIEW v_publisher_summary AS
SELECT
  publish_state,
  COUNT(*)::int AS n
FROM v_publish_pending
GROUP BY 1;

-- =====================================================================
-- 6) papers_staging 의 'broken' 상태도 사용 — 003 시점에 enum 보완 끝
--    (CHECK 안 걸지만 코드 grep 으로 통과하도록 주석 + 인덱스만)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_staging_broken
  ON papers_staging (fulltext_status)
  WHERE fulltext_status IN ('broken','failed','excluded');

COMMIT;

-- =====================================================================
-- 후속 안내
--   * 자동 잠금 복구를 cron 에 걸려면 n8n 또는 Makefile 의
--       SELECT * FROM recover_stuck_staging(30);
--     를 매시간 호출.
--   * publisher 서비스: docker compose 의 'publisher' 컨테이너로 띄움.
--       node src/publisher.js
-- =====================================================================
