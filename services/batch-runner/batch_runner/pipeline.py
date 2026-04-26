# =====================================================================
# Layer 2 — 관련성 + 논문타입 판단 (Gemini Flash Batch API)
#
# 입력 : papers_staging.abstract (PDF/markdown 사용 X)
# 출력 : { relevance: yes|no|unsure,
#          paper_type: composition|reaction|process|other|unknown }
#
# 결과 적용
#   relevance == 'no'  → papers_excluded INSERT,
#                        papers_staging.fulltext_status='excluded'
#   relevance != 'no'  → papers_scored INSERT (Layer 3/4 가 트리거)
#                        staging 행은 Layer 4 까지 살려둠
#
# 옛 v1 스크립트(전문/초록 기반 full analysis) 는 Layer 4 (Claude Deep Parser)
# 가 대체했으므로 이 파일에서 제거.
# 단, v1 의 batch 인프라(batch_jobs / GCS / Gemini Batch API) 는 그대로 재활용.
# =====================================================================

import json
import uuid
from pathlib import Path
from datetime import datetime, timezone

from .db import conn
from .cost_gate import cost_gate
from .jsonl import build_line, write_jsonl
from .gemini_batch import create_batch, get_batch, download_output
from .gcs import upload as gcs_upload, delete as gcs_delete
from . import config


# ---------------------------------------------------------------------
# 프롬프트 / 스키마
# ---------------------------------------------------------------------
_prompt_path = Path(__file__).parent.parent / "prompts" / "relevance.txt"
SYSTEM_PROMPT = _prompt_path.read_text(encoding="utf-8") if _prompt_path.exists() else (
    "당신은 반도체 소재(EUV/DUV Photoresist) 분야 큐레이터입니다. "
    "주어진 제목과 초록만 보고 색인 적합성과 paper_type 을 판단하세요. "
    "JSON 으로만 답하고, 자연어 설명은 금지합니다."
)

ALLOWED_RELEVANCE = {"yes", "no", "unsure"}
ALLOWED_TYPES     = {"composition", "reaction", "process", "other", "unknown"}


def _normalize(obj: dict) -> dict:
    """모델 출력을 안전하게 정리. 잘못된 enum 값은 unsure / unknown 으로 강등."""
    rel = str(obj.get("relevance", "unsure")).strip().lower()
    typ = str(obj.get("paper_type", "unknown")).strip().lower()
    if rel not in ALLOWED_RELEVANCE: rel = "unsure"
    if typ not in ALLOWED_TYPES:     typ = "unknown"
    reason = obj.get("reason", "")
    if not isinstance(reason, str): reason = ""
    return {"relevance": rel, "paper_type": typ, "reason": reason[:200]}


def _build_user_text(title: str, abstract):
    body = abstract.strip() if isinstance(abstract, str) and abstract.strip() else "(초록 없음)"
    return (
        f"[제목]\n{title}\n\n"
        f"[초록]\n{body}\n\n"
        "위 정보만 근거로 판단해 JSON 으로 답하세요."
    )


# ---------------------------------------------------------------------
# enqueue : papers_staging 에서 아직 점수가 없는 논문을 골라 JSONL 빌드
# ---------------------------------------------------------------------
def enqueue():
    """
    papers_staging 중 papers_scored / papers_excluded 양쪽에 없는 행만 골라
    Gemini Batch 입력 JSONL 을 만든다. abstract 가 없는 행도 제목만 보내본다
    (제목으로도 obvious NO 는 잡힘 → 노이즈 절감).
    """
    with conn().cursor() as cur:
        cur.execute("""
            SELECT s.id, s.doi, s.arxiv_id, s.title, s.abstract
              FROM papers_staging s
              LEFT JOIN papers_scored   sc ON sc.staging_id = s.id
              LEFT JOIN papers_excluded ex
                     ON (s.doi IS NOT NULL AND ex.doi = s.doi)
                     OR (s.arxiv_id IS NOT NULL AND ex.arxiv_id = s.arxiv_id)
                     OR (s.title_normalized IS NOT NULL
                         AND ex.title_normalized = s.title_normalized)
             WHERE sc.id IS NULL
               AND ex.id IS NULL
               AND s.fulltext_status NOT IN ('excluded')
             ORDER BY s.id
             LIMIT %s
        """, (config.BATCH_MAX,))
        rows = cur.fetchall()

    if len(rows) < config.BATCH_MIN:
        print(f"[enqueue] {len(rows)}건 < 최소 {config.BATCH_MIN}건 — 대기")
        return None

    lines = [
        build_line(
            r["id"],
            SYSTEM_PROMPT,
            _build_user_text(r["title"], r["abstract"]),
            config.RELEVANCE_SCHEMA,
            config.BATCH_MODEL,
        )
        for r in rows
    ]
    batch_uuid = uuid.uuid4().hex[:8]
    out = Path(f"/tmp/batch-INPUT_{batch_uuid}.jsonl")
    write_jsonl(out, lines)
    print(f"[enqueue] {len(rows)}건 → {out}")
    return out


# ---------------------------------------------------------------------
# submit : JSONL 을 GCS 에 올리고 Gemini Batch 등록
# ---------------------------------------------------------------------
def submit(jsonl_path=None):
    if jsonl_path is None:
        candidates = sorted(
            Path("/tmp").glob("batch-INPUT_*.jsonl"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            print("[submit] JSONL 파일 없음 — enqueue 먼저 실행하세요")
            return
        jsonl_path = candidates[0]

    paper_ids = []
    for line in jsonl_path.read_text(encoding="utf-8").strip().splitlines():
        rec = json.loads(line)
        pid = int(rec["key"].removeprefix("paper_"))
        paper_ids.append(pid)

    blob_name = f"batch-input/{jsonl_path.name}"
    print(f"[submit] GCS 업로드 {jsonl_path} → gs://{config.GCS_BUCKET}/{blob_name}")
    gcs_uri = gcs_upload(str(jsonl_path), blob_name)

    display  = f"relevance-batch-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}"
    job_name = create_batch(gcs_uri, display, config.BATCH_MODEL)

    with conn().cursor() as cur:
        cur.execute("""
            INSERT INTO batch_jobs
              (job_name, input_file_id, state, paper_ids, request_count)
            VALUES (%s, %s, 'PENDING', %s, %s)
            RETURNING id
        """, (job_name, gcs_uri, paper_ids, len(paper_ids)))
        job_id = cur.fetchone()["id"]

        # staging 측 상태값을 표시용으로 갱신 (배치 진행중 표시).
        # 정식 상태 전이는 apply() 에서 일어남.
        cur.execute("""
            UPDATE papers_staging
               SET fulltext_status = 'batch_submitted'
             WHERE id = ANY(%s)
               AND fulltext_status IN ('pending', 'no_pdf', 'md_ready')
        """, (paper_ids,))
    conn().commit()

    jsonl_path.unlink(missing_ok=True)
    print(f"[submit] job_name={job_name}  batch_jobs.id={job_id}  input={gcs_uri}")


# ---------------------------------------------------------------------
# poll : 진행 중인 배치 상태 동기화
# ---------------------------------------------------------------------
def poll():
    with conn().cursor() as cur:
        cur.execute("""
            SELECT id, job_name FROM batch_jobs
            WHERE state IN ('PENDING','RUNNING',
                            'JOB_STATE_PENDING','JOB_STATE_RUNNING','JOB_STATE_QUEUED')
        """)
        jobs = cur.fetchall()

    if not jobs:
        print("[poll] 진행 중인 배치 없음")
        return

    for job in jobs:
        batch = get_batch(job["job_name"])
        state = batch.state.name if hasattr(batch.state, "name") else str(batch.state)

        output_gcs_uri = None
        if state in ("SUCCEEDED", "JOB_STATE_SUCCEEDED"):
            if hasattr(batch, "dest") and batch.dest:
                output_gcs_uri = batch.dest.gcs_uri

        with conn().cursor() as cur:
            cur.execute("""
                UPDATE batch_jobs
                   SET state          = %s,
                       output_file_id = COALESCE(%s, output_file_id),
                       completed_at   = CASE WHEN %s IN ('SUCCEEDED','JOB_STATE_SUCCEEDED')
                                              THEN now() ELSE completed_at END
                 WHERE id = %s
            """, (state, output_gcs_uri, state, job["id"]))
        conn().commit()
        print(f"[poll] job_id={job['id']} state={state}")


# ---------------------------------------------------------------------
# apply : SUCCEEDED 결과를 받아 papers_scored / papers_excluded 에 분기
# ---------------------------------------------------------------------
def apply():
    with conn().cursor() as cur:
        cur.execute("""
            SELECT id, job_name, output_file_id, paper_ids, input_file_id
              FROM batch_jobs
             WHERE state IN ('SUCCEEDED','JOB_STATE_SUCCEEDED')
               AND applied_at IS NULL
        """)
        jobs = cur.fetchall()

    if not jobs:
        print("[apply] 적용 대기 배치 없음")
        return

    for job in jobs:
        if not job["output_file_id"]:
            print(f"[apply] job_id={job['id']} output_file_id 없음 — skip")
            continue

        local = f"/tmp/batch-out-{job['id']}.jsonl"
        print(f"[apply] job_id={job['id']} downloading → {local}")
        download_output(job["output_file_id"], local)

        scored_ids, excluded_ids, failed_ids = [], [], []
        for line in open(local, encoding="utf-8"):
            rec = json.loads(line)
            paper_id = int(rec["key"].removeprefix("paper_"))

            if rec.get("error"):
                failed_ids.append(paper_id)
                with conn().cursor() as cur:
                    cur.execute("""
                        UPDATE papers_staging
                           SET fulltext_status = 'failed',
                               fulltext_error  = %s
                         WHERE id = %s
                    """, (rec["error"].get("message", "batch error"), paper_id))
                continue

            try:
                text  = rec["response"]["candidates"][0]["content"]["parts"][0]["text"]
                obj   = _normalize(json.loads(text))
                usage = rec["response"].get("usageMetadata", {})
            except Exception as e:
                failed_ids.append(paper_id)
                with conn().cursor() as cur:
                    cur.execute("""
                        UPDATE papers_staging
                           SET fulltext_status='failed', fulltext_error=%s
                         WHERE id=%s
                    """, (f"parse: {e}", paper_id))
                continue

            # staging 의 식별자 가져오기 (excluded INSERT 에 활용)
            with conn().cursor() as cur:
                cur.execute("""
                    SELECT doi, arxiv_id, title_normalized, source
                      FROM papers_staging WHERE id = %s
                """, (paper_id,))
                meta = cur.fetchone() or {}

            if obj["relevance"] == "no":
                # → papers_excluded
                with conn().cursor() as cur:
                    cur.execute("""
                        INSERT INTO papers_excluded
                          (doi, arxiv_id, title_normalized, source,
                           excluded_reason, excluded_layer, detail)
                        VALUES (%s, %s, %s, %s,
                                'low_relevance', 'layer2', %s::jsonb)
                    """, (
                        meta.get("doi"), meta.get("arxiv_id"),
                        meta.get("title_normalized"), meta.get("source"),
                        json.dumps({"raw": obj, "staging_id": paper_id}, ensure_ascii=False),
                    ))
                    cur.execute("""
                        UPDATE papers_staging
                           SET fulltext_status='excluded',
                               fulltext_error=%s
                         WHERE id=%s
                    """, (f"layer2:{obj.get('reason','')[:120]}", paper_id))
                excluded_ids.append(paper_id)
            else:
                # YES / UNSURE → papers_scored, staging 은 다음 layer 가 진행
                with conn().cursor() as cur:
                    cur.execute("""
                        INSERT INTO papers_scored
                          (staging_id, doi, arxiv_id, relevance, paper_type,
                           scored_by, raw_response)
                        VALUES (%s, %s, %s, %s, %s,
                                %s, %s::jsonb)
                    """, (
                        paper_id, meta.get("doi"), meta.get("arxiv_id"),
                        obj["relevance"], obj["paper_type"],
                        f"gemini-batch:{config.BATCH_MODEL}",
                        json.dumps(obj, ensure_ascii=False),
                    ))
                    # batch_submitted 였던 행을 원위치로 (PDF 처리 가능 상태)
                    cur.execute("""
                        UPDATE papers_staging
                           SET fulltext_status =
                               CASE
                                 WHEN pdf_url IS NULL OR pdf_url = '' THEN 'no_pdf'
                                 WHEN fulltext_status IN ('md_ready','queued') THEN fulltext_status
                                 ELSE 'pending'
                               END
                         WHERE id = %s
                    """, (paper_id,))
                scored_ids.append(paper_id)

            # 비용 기록 (배치 50% 할인은 cost_gate 측에서 처리)
            with cost_gate(
                "batch-runner", config.BATCH_MODEL, "relevance_batch",
                is_batch=True, paper_id=paper_id, batch_job_id=job["id"],
            ) as rec_gate:
                rec_gate.set_tokens(usage)

        # batch_jobs 마무리
        with conn().cursor() as cur:
            cur.execute("""
                UPDATE batch_jobs SET
                  applied_at    = now(),
                  success_count = %s,
                  fail_count    = %s
                WHERE id = %s
            """, (len(scored_ids) + len(excluded_ids), len(failed_ids), job["id"]))
        conn().commit()

        Path(local).unlink(missing_ok=True)
        if (job.get("input_file_id") or "").startswith("gs://"):
            try:
                gcs_parts = job["input_file_id"].removeprefix(f"gs://{config.GCS_BUCKET}/")
                gcs_delete(gcs_parts)
            except Exception as e:
                print(f"[apply] GCS 정리 실패 (무시): {e}")

        print(
            f"[apply] job_id={job['id']} "
            f"scored={len(scored_ids)} excluded={len(excluded_ids)} failed={len(failed_ids)}"
        )


# ---------------------------------------------------------------------
# status : 운영 대시보드용 요약
# ---------------------------------------------------------------------
def status():
    with conn().cursor() as cur:
        cur.execute("""
            SELECT fulltext_status, COUNT(*) AS cnt
              FROM papers_staging GROUP BY 1 ORDER BY 2 DESC
        """)
        print("\n=== papers_staging fulltext_status ===")
        for row in cur.fetchall():
            print(f"  {row['fulltext_status']:<20} {row['cnt']}")

        cur.execute("SELECT COUNT(*)::int AS n FROM papers_scored")
        print(f"  papers_scored        {cur.fetchone()['n']}")

        cur.execute("SELECT COUNT(*)::int AS n FROM papers_excluded WHERE excluded_layer='layer2'")
        print(f"  papers_excluded(L2)  {cur.fetchone()['n']}")

        cur.execute("""
            SELECT id, job_name, state, request_count, success_count, fail_count, submitted_at
              FROM batch_jobs ORDER BY id DESC LIMIT 5
        """)
        rows = cur.fetchall()
        print("\n=== batch_jobs (최근 5건) ===")
        for row in rows:
            print(
                f"  id={row['id']} state={row['state']} "
                f"req={row['request_count']} ok={row['success_count']} "
                f"fail={row['fail_count']} submitted={row['submitted_at']}"
            )

        try:
            cur.execute("SELECT * FROM v_today_cost")
            row = cur.fetchone()
            if row:
                print(f"\n=== 오늘 비용 ===")
                print(
                    f"  spent=${row.get('spent_usd', 0)} "
                    f"in_tok={row.get('input_tokens', 0)} "
                    f"out_tok={row.get('output_tokens', 0)} "
                    f"calls={row.get('calls', 0)}"
                )
        except Exception:
            pass
