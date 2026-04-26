import json
import uuid
import sys
from pathlib import Path
from datetime import datetime, timezone

from .db import conn
from .cost_gate import cost_gate, CostLimitExceeded
from .jsonl import build_line, write_jsonl
from .gemini_batch import create_batch, get_batch, download_output
from .gcs import upload as gcs_upload, delete as gcs_delete
from . import config

ALLOWED_MAJORS = {
    "resin", "pr", "develop_etch", "litho",
    "metrology", "misc_semi", "novel_idea",
}

_prompt_path = Path(__file__).parent.parent / "prompts" / "analyze.txt"
SYSTEM_PROMPT = _prompt_path.read_text(encoding="utf-8") if _prompt_path.exists() else (
    "당신은 반도체 소재·리소그래피 전문 연구 분석가입니다. "
    "주어진 논문 Markdown 전문을 분석해 JSON 스키마에 맞게 응답하세요."
)


def _clamp(v, lo, hi):
    try:
        n = round(float(v))
        return max(lo, min(hi, n))
    except Exception:
        return lo


def _sanitize(obj: dict) -> dict:
    clean = dict(obj)
    if clean.get("major_category") not in ALLOWED_MAJORS:
        clean["major_category"] = "misc_semi"
    clean["novelty_score"]   = _clamp(clean.get("novelty_score", 0), 0, 10)
    clean["relevance_score"] = _clamp(clean.get("relevance_score", 0), 0, 10)
    for k in ("key_findings", "materials", "techniques", "tags"):
        v = clean.get(k)
        clean[k] = v[:20] if isinstance(v, list) else []
    return clean


def enqueue() -> Path | None:
    """md_ready(전문) + no_pdf(초록) 논문을 JSONL로 묶어 /tmp에 저장. 파일 경로 반환."""
    with conn().cursor() as cur:
        # md_ready: PDF 전문으로 분석
        cur.execute("""
            SELECT id, fulltext_md AS content, 'fulltext' AS kind
            FROM research_papers
            WHERE fulltext_status = 'md_ready'
            ORDER BY id
            LIMIT %s
        """, (config.BATCH_MAX,))
        fulltext_rows = cur.fetchall()

        # no_pdf: 초록으로만 분석 (PDF 없는 논문)
        remaining = max(0, config.BATCH_MAX - len(fulltext_rows))
        if remaining > 0:
            cur.execute("""
                SELECT id,
                       ('제목: ' || COALESCE(title, '') || E'\n\n초록:\n' || COALESCE(abstract, '')) AS content,
                       'abstract' AS kind
                FROM research_papers
                WHERE fulltext_status = 'no_pdf'
                  AND summary_ko IS NULL
                ORDER BY id
                LIMIT %s
            """, (remaining,))
            abstract_rows = cur.fetchall()
        else:
            abstract_rows = []

    rows = fulltext_rows + abstract_rows

    if len(rows) < config.BATCH_MIN:
        print(f"[enqueue] {len(rows)}건 < 최소 {config.BATCH_MIN}건 — 대기")
        return None

    lines = [
        build_line(r["id"], SYSTEM_PROMPT, r["content"],
                   config.ANALYSIS_SCHEMA, config.BATCH_MODEL)
        for r in rows
    ]
    batch_uuid = uuid.uuid4().hex[:8]
    out = Path(f"/tmp/batch-INPUT_{batch_uuid}.jsonl")
    write_jsonl(out, lines)
    ft = sum(1 for r in rows if r["kind"] == "fulltext")
    ab = sum(1 for r in rows if r["kind"] == "abstract")
    print(f"[enqueue] {len(rows)}건 (전문 {ft} + 초록 {ab}) → {out}")
    return out


def submit(jsonl_path: Path | None = None):
    """enqueue가 만든 JSONL을 Gemini에 업로드하고 batch_jobs 에 등록."""
    if jsonl_path is None:
        # glob latest
        candidates = sorted(Path("/tmp").glob("batch-INPUT_*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            print("[submit] JSONL 파일 없음 — enqueue 먼저 실행하세요")
            return
        jsonl_path = candidates[0]

    # paper_ids 추출
    paper_ids = []
    for line in jsonl_path.read_text(encoding="utf-8").strip().splitlines():
        rec = json.loads(line)
        pid = int(rec["key"].removeprefix("paper_"))
        paper_ids.append(pid)

    cost_gate.__doc__  # trigger import check
    try:
        config.check if False else None
    except Exception:
        pass

    blob_name = f"batch-input/{jsonl_path.name}"
    print(f"[submit] GCS 업로드 {jsonl_path} → gs://{config.GCS_BUCKET}/{blob_name}")
    gcs_uri = gcs_upload(str(jsonl_path), blob_name)

    display  = f"paper-batch-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}"
    job_name = create_batch(gcs_uri, display, config.BATCH_MODEL)

    with conn().cursor() as cur:
        cur.execute("""
            INSERT INTO batch_jobs
              (job_name, input_file_id, state, paper_ids, request_count)
            VALUES (%s, %s, 'PENDING', %s, %s)
            RETURNING id
        """, (job_name, gcs_uri, paper_ids, len(paper_ids)))
        job_id = cur.fetchone()["id"]

        cur.execute("""
            UPDATE research_papers
               SET fulltext_status = 'batch_submitted'
             WHERE id = ANY(%s)
        """, (paper_ids,))
    conn().commit()

    jsonl_path.unlink(missing_ok=True)
    # GCS 파일은 Vertex AI가 배치 처리 중 읽어야 하므로 여기서 삭제 금지 → apply()에서 정리
    print(f"[submit] job_name={job_name}  batch_jobs.id={job_id}  input={gcs_uri}")


def poll():
    """PENDING/RUNNING 배치 잡 상태를 Gemini에서 조회해 갱신."""
    with conn().cursor() as cur:
        cur.execute("""
            SELECT id, job_name FROM batch_jobs
            WHERE state IN ('PENDING', 'RUNNING', 'JOB_STATE_PENDING', 'JOB_STATE_RUNNING', 'JOB_STATE_QUEUED')
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
                   SET state = %s,
                       output_file_id = COALESCE(%s, output_file_id),
                       completed_at   = CASE WHEN %s IN ('SUCCEEDED', 'JOB_STATE_SUCCEEDED') THEN now() ELSE completed_at END
                 WHERE id = %s
            """, (state, output_gcs_uri, state, job["id"]))
        conn().commit()
        print(f"[poll] job_id={job['id']} state={state}")


def apply():
    """SUCCEEDED 배치 결과를 다운로드해 DB에 반영."""
    with conn().cursor() as cur:
        cur.execute("""
            SELECT id, job_name, output_file_id, paper_ids
            FROM batch_jobs
            WHERE state IN ('SUCCEEDED', 'JOB_STATE_SUCCEEDED') AND applied_at IS NULL
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

        success_ids, failed_ids = [], []
        for line in open(local, encoding="utf-8"):
            rec = json.loads(line)
            paper_id = int(rec["key"].removeprefix("paper_"))

            if rec.get("error"):
                failed_ids.append(paper_id)
                with conn().cursor() as cur:
                    cur.execute("""
                        UPDATE research_papers
                           SET fulltext_status = 'failed',
                               fulltext_error  = %s
                         WHERE id = %s
                    """, (rec["error"].get("message", "batch error"), paper_id))
                continue

            try:
                text = rec["response"]["candidates"][0]["content"]["parts"][0]["text"]
                analysis = _sanitize(json.loads(text))
                usage = rec["response"].get("usageMetadata", {})
            except Exception as e:
                failed_ids.append(paper_id)
                with conn().cursor() as cur:
                    cur.execute("""
                        UPDATE research_papers SET fulltext_status='failed', fulltext_error=%s WHERE id=%s
                    """, (str(e), paper_id))
                continue

            with conn().cursor() as cur:
                cur.execute("""
                    UPDATE research_papers SET
                      summary_ko      = %s,
                      key_findings    = %s,
                      materials       = %s,
                      techniques      = %s,
                      major_category  = %s,
                      mid_category    = %s,
                      sub_category    = %s,
                      tags            = %s,
                      novelty_score   = %s,
                      relevance_score = %s,
                      embedding_v     = 'md',
                      fulltext_status = 'batch_done'
                    WHERE id = %s
                """, (
                    analysis.get("summary_ko"),
                    json.dumps(analysis.get("key_findings", []), ensure_ascii=False),
                    json.dumps(analysis.get("materials", []),    ensure_ascii=False),
                    json.dumps(analysis.get("techniques", []),   ensure_ascii=False),
                    analysis.get("major_category", "misc_semi"),
                    analysis.get("mid_category"),
                    analysis.get("sub_category"),
                    json.dumps(analysis.get("tags", []),         ensure_ascii=False),
                    analysis.get("novelty_score", 0),
                    analysis.get("relevance_score", 0),
                    paper_id,
                ))
            success_ids.append(paper_id)

            with cost_gate("batch-runner", config.BATCH_MODEL, "batch_generate",
                           is_batch=True, paper_id=paper_id, batch_job_id=job["id"]) as rec_gate:
                rec_gate.set_tokens(usage)

        with conn().cursor() as cur:
            cur.execute("""
                UPDATE batch_jobs SET
                  applied_at    = now(),
                  success_count = %s,
                  fail_count    = %s
                WHERE id = %s
            """, (len(success_ids), len(failed_ids), job["id"]))
        conn().commit()

        Path(local).unlink(missing_ok=True)
        # 제출 시 남겨뒀던 GCS 입력 파일 정리
        if job.get("input_file_id", "").startswith("gs://"):
            try:
                gcs_parts = job["input_file_id"].removeprefix(f"gs://{config.GCS_BUCKET}/")
                gcs_delete(gcs_parts)
            except Exception as e:
                print(f"[apply] GCS 정리 실패 (무시): {e}")
        print(f"[apply] job_id={job['id']} success={len(success_ids)} failed={len(failed_ids)}")


def status():
    """현재 상태 요약 출력."""
    with conn().cursor() as cur:
        cur.execute("""
            SELECT fulltext_status, COUNT(*) AS cnt
            FROM research_papers GROUP BY 1 ORDER BY 2 DESC
        """)
        print("\n=== research_papers fulltext_status ===")
        for row in cur.fetchall():
            print(f"  {row['fulltext_status']:<20} {row['cnt']}")

        cur.execute("""
            SELECT id, job_name, state, request_count, success_count, fail_count, submitted_at
            FROM batch_jobs ORDER BY id DESC LIMIT 5
        """)
        rows = cur.fetchall()
        print("\n=== batch_jobs (최근 5건) ===")
        for row in rows:
            print(f"  id={row['id']} state={row['state']} "
                  f"req={row['request_count']} ok={row['success_count']} "
                  f"fail={row['fail_count']} submitted={row['submitted_at']}")

        cur.execute("SELECT * FROM v_today_cost")
        row = cur.fetchone()
        print(f"\n=== 오늘 비용 ===")
        print(f"  spent=${row['spent_usd']} "
              f"in_tok={row['input_tokens']} out_tok={row['output_tokens']} "
              f"calls={row['calls']}")
