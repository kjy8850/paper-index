# 📄 PDF → Markdown → Batch 분석 파이프라인 — 기획서 v2

> 이 문서는 **Claude Code 가 그대로 수행**하도록 Phase 별 작업 지시 수준으로 정리했습니다.
> 각 Phase 끝에 ✅ 검증 명령이 있고, 그게 통과해야 다음 Phase 로 넘어갑니다.
>
> v2 변경점: Gemini **Batch API** 를 1급 경로로 채택 (비용 50% 추가 절감).

---

## 0. 한 문단 요약

현재는 논문의 abstract 를 Gemini 스트리밍 API 로 분석합니다. 이걸 **두 단계 파이프라인**으로 쪼갭니다.

1. **Docling** 으로 PDF → Markdown 변환 (LXC 내부 Python 컨테이너)
2. **Gemini Batch API** 로 Markdown 묶음을 하루 1~2회 일괄 분석 (스트리밍 대비 비용 50%↓)

기존 수집 파이프라인(n8n → ingest) 과 NAS Postgres 는 **손대지 않습니다**. 대신 LXC 안에 새 docker 서비스 **3개**만 추가:

- `docling-svc` (Python/FastAPI) — PDF → Markdown 변환
- `pdf-worker` (Node) — pending 논문 폴링하여 docling-svc 호출하고 결과 저장
- `batch-runner` (Python) — md_ready 논문을 JSONL 로 묶어 Gemini Batch API 제출/폴링/적용

DB 는 컬럼 6 개 + 테이블 1 개 추가. 롤백은 서비스 내리고 상태 컬럼만 비우면 됨.

---

## 1. 왜 텍스트 + 왜 배치인가

### 1-1. PDF 이미지 vs Markdown (토큰)

| 방식 | 페이지당 토큰 | 20p 논문 1 편 | 120 편 |
|---|---:|---:|---:|
| PDF → 이미지 직접 입력 | 1,000 ~ 2,000 | 200K | **24M** (≈ $120) |
| PDF → Markdown 변환 후 텍스트 | 200 ~ 500 | 20K ~ 30K | 2.4M ~ 3.6M (≈ $3 ~ 8) |
| 위 + **Batch API 50% 할인** | " | " | **$1.5 ~ 4** |

120 편 단위 배치면 **거의 1 달러 미만**. 일 120 편 × 30 일 = 3,600 편 기준으로 월 30~80 달러 수준.

### 1-2. Batch API 트레이드오프

- **장점**: 스트리밍 대비 가격 50%, rate limit 사실상 무제한, 재시도 불필요(구글이 처리).
- **단점**: 지연 0 ~ 24 시간. "방금 수집한 논문을 즉시 요약" 에는 부적합.

우리 시스템은 **하루 배치 중심** 이므로 지연이 문제되지 않음. 다만 즉시 조회 가능성이 필요하면 현재 abstract 기반 1 차 분석은 **유지** (ingest 시점).

### 1-3. Docling 을 고른 이유

- 표·수식(LaTeX) 추출 품질이 Marker 보다 앞섬. 학술 PDF 레이아웃 모델 공개.
- CPU 모드로도 페이지당 2~5 초. GPU 가 LXC 에 전달되면 4~8 배 빨라짐.

---

## 2. 최종 아키텍처

```
                    ┌──────────────────────────────────────────────┐
                    │                 미니PC LXC                   │
                    │                                              │
[ n8n workflow ]    │  ┌────────────┐                              │
      │    ───────────► │   ingest   │  abstract 1차 분석 & 저장  │
      │ POST /ingest   │  (Node)    │  pdf_url 있으면             │
                    │  └────┬───────┘  fulltext_status='pending'  │
                    │       │                                      │
                    │       │ (async, DB 폴링)                     │
                    │       ▼                                      │
                    │  ┌────────────┐                              │
                    │  │ pdf-worker │─── HTTP ──► ┌─────────────┐  │
                    │  │   (Node)   │              │ docling-svc │  │
                    │  └────┬───────┘  ◄── MD ──── │ (Python)    │  │
                    │       │ UPDATE fulltext_md                ───┤
                    │       │ fulltext_status='md_ready'           │
                    │       ▼                                      │
                    │  (DB 에 md_ready 논문 쌓임)                  │
                    │       │                                      │
                    │       │ cron 02:00 / 14:00                   │
                    │       ▼                                      │
                    │  ┌─────────────────┐                         │
                    │  │  batch-runner   │─── upload JSONL        ─┼─► Gemini Batch API
                    │  │   (Python)      │◄── download result  ────┼── 
                    │  └────┬────────────┘                         │
                    │       │ UPDATE 분석 결과·임베딩               │
                    │       │ fulltext_status='batch_done'          │
                    │       ▼                                      │
                    │  (검색 가능 상태)                             │
                    └──────────────────────────────────────────────┘
                                   │
                                   ▼
                         NAS · paper-postgres (기존)
```

**중요 포인트**

- n8n 워크플로, 소스 어댑터, ingest API 본문은 **수정 최소** (ingest 는 상태 플래그만 추가).
- abstract 기반 1 차 분석은 그대로 유지 → 워커·배치 지연돼도 "무응답 논문 없음".
- batch-runner 가 업데이트하면 1 차 분석값이 **덮어씌워짐**. 단, 임베딩·summary 는 md 기반이 항상 우위.

---

## 3. DB 스키마 변경

### 3-1. `research_papers` 에 컬럼 추가

```sql
ALTER TABLE research_papers
  ADD COLUMN IF NOT EXISTS fulltext_md            TEXT,
  ADD COLUMN IF NOT EXISTS fulltext_status        TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS fulltext_source        TEXT,
  ADD COLUMN IF NOT EXISTS fulltext_processed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulltext_attempts      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulltext_error         TEXT,
  ADD COLUMN IF NOT EXISTS embedding_v            TEXT NOT NULL DEFAULT 'abs';

-- 상태값:
--   'none'            : 초기 / pdf 없음
--   'pending'         : ingest 가 'pdf 있음' 으로 표시
--   'running'         : pdf-worker 처리 중
--   'md_ready'        : markdown 확보, batch 제출 대기
--   'batch_submitted' : batch-runner 가 Gemini 에 제출함
--   'batch_done'      : 결과 반영 완료 (최종)
--   'failed'          : 재시도 3회 초과
--   'no_pdf'          : pdf_url 없음 또는 HEAD 실패

CREATE INDEX IF NOT EXISTS idx_papers_fulltext_status
  ON research_papers (fulltext_status)
  WHERE fulltext_status IN ('pending', 'running', 'md_ready', 'batch_submitted', 'failed');
```

### 3-2. `api_usage` (신규 테이블 — 토큰·비용 추적)

모든 Gemini 호출이 **이 테이블에 한 줄씩 기록**됩니다. 일일 누적 비용을 여기서 집계하고, 한도 초과 시 모든 워커·배치가 즉시 중단됩니다(§13).

```sql
CREATE TABLE IF NOT EXISTS api_usage (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider        TEXT NOT NULL DEFAULT 'gemini',
  model           TEXT NOT NULL,             -- 'gemini-2.5-flash-lite' 등
  endpoint        TEXT NOT NULL,             -- 'generate_content'|'embed_content'|'batch_generate'|'batch_embed'
  is_batch        BOOLEAN NOT NULL DEFAULT false,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  caller          TEXT,                      -- 'ingest'|'pdf-worker'|'batch-runner'|'search'|'mcp'
  paper_id        BIGINT,                    -- 논문별 추적 (가능한 경우)
  batch_job_id    BIGINT,                    -- batch_jobs 참조
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_api_usage_ts     ON api_usage (ts DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_today  ON api_usage ((ts::date));
CREATE INDEX IF NOT EXISTS idx_api_usage_caller ON api_usage (caller, ts DESC);

-- 오늘 누적 비용 뷰
CREATE OR REPLACE VIEW v_today_cost AS
SELECT
  COALESCE(SUM(cost_usd), 0)::NUMERIC(12,6) AS spent_usd,
  COALESCE(SUM(input_tokens), 0)             AS input_tokens,
  COALESCE(SUM(output_tokens), 0)            AS output_tokens,
  COUNT(*)                                   AS calls
FROM api_usage
WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

-- 30일 일자별 뷰
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
```

### 3-3. `cost_settings` (신규 테이블 — 하드 리밋 설정)

```sql
CREATE TABLE IF NOT EXISTS cost_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1,
  daily_limit_usd         NUMERIC(10,4) NOT NULL DEFAULT 1.00,
  alert_threshold_ratio   NUMERIC(4,3)  NOT NULL DEFAULT 0.80,  -- 80% 에서 경고 로그
  hard_stop_enabled       BOOLEAN       NOT NULL DEFAULT true,
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO cost_settings (id, daily_limit_usd)
VALUES (1, 1.00)
ON CONFLICT (id) DO NOTHING;
```

### 3-4. `batch_jobs` (신규 테이블)

```sql
CREATE TABLE IF NOT EXISTS batch_jobs (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT UNIQUE NOT NULL,   -- Gemini 가 리턴하는 batch name (예: batches/abc123)
  input_file_id   TEXT NOT NULL,          -- 업로드한 파일 ID
  output_file_id  TEXT,                   -- 완료 시 결과 파일 ID
  state           TEXT NOT NULL,          -- 'PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','EXPIRED'
  paper_ids       BIGINT[] NOT NULL,      -- 포함된 research_papers.id 목록
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
```

`sql/init.sql` 에도 동일 내용 반영. 운영 중인 DB 엔 `sql/migrations/001_pdf_pipeline.sql` 로 적용.

---

## 4. 컴포넌트 명세

### 4.0 `cost_gate` — 모든 Gemini 호출 공통 게이트 (⚠️ 필수)

**모든 API 호출은 이 게이트를 통과해야 합니다.** 스트리밍 분석, 임베딩, Batch 제출, 검색 시 쿼리 재작성까지 **예외 없이**. 자세한 구현 규약은 §13.

호출 측 입장에서 보는 규약:

```js
// Node 예시
import { costGate } from './lib/cost-gate.js';
const result = await costGate.run({
  caller: 'pdf-worker', model: 'gemini-2.5-flash-lite',
  endpoint: 'generate_content', paperId: p.id, isBatch: false,
}, async () => {
  return await geminiModel.generateContent(prompt);
  // 내부에서 result.response.usageMetadata 뽑아서 자동 기록
});
```

```python
# Python 예시
from batch_runner.cost_gate import cost_gate

with cost_gate(caller='batch-runner', model=MODEL, endpoint='batch_generate',
               is_batch=True, batch_job_id=job.id) as rec:
    resp = client.batches.create(...)
    rec.set_tokens(usage_metadata)  # 제출 시점엔 0, apply 에서 실제 토큰 업데이트
```

게이트 동작:
1. **pre-check**: `SELECT spent_usd, daily_limit_usd FROM v_today_cost, cost_settings WHERE cost_settings.id=1;` 조회해 `spent >= limit` 면 예외 `CostLimitExceeded` 던짐 → 호출자는 `process.exit(1)` / `sys.exit(1)`.
4. **post-record**: API 호출 성공 시 `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount}` 기반으로 비용 계산해 `api_usage` INSERT. 실패해도 소비한 토큰만큼은 기록 (Gemini 는 실패 호출에 과금하지 않지만, 안전 측 기록).
5. **자동 리셋**: UTC 자정이 지나면 `v_today_cost` 의 WHERE 절이 자연히 새 날짜로 바뀌어 누적이 0 으로 시작.

### 4.1 `docling-svc` — Python / FastAPI

**위치**: `services/docling-svc/`

**파일 3개**:

`Dockerfile`
```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# 첫 요청에서 모델을 받지 않도록 빌드타임에 워밍업 (선택)
RUN python -c "from docling.document_converter import DocumentConverter; DocumentConverter()"
COPY main.py .
EXPOSE 8089
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8089", "--timeout-keep-alive", "300"]
```

`requirements.txt`
```
fastapi==0.115.*
uvicorn[standard]==0.30.*
docling==2.*
python-multipart==0.0.*
```

`main.py` 스펙:
- `POST /convert` : multipart PDF → `{ markdown, pages, tables, figures, elapsed_ms }`
- `GET /healthz` : `{ ok: true, version }`
- 에러 시 HTTP 422 + `{ error: "..." }`

**리소스**: 2 vCPU / 4 GB 권장.

### 4.2 `pdf-worker` — Node

**위치**: `src/pdf-worker.js` + helper 2개 (`src/lib/pdf-fetch.js`, `src/lib/docling-client.js`)

**v2 변경점**: Gemini 호출 제거. Markdown 확보만 하고 **거기서 멈춤** (`fulltext_status='md_ready'`).

```js
// 의사 코드
while (true) {
  const rows = await lockPending(BATCH);   // FOR UPDATE SKIP LOCKED
  if (rows.length === 0) { await sleep(POLL_MS); continue; }

  await Promise.allSettled(rows.map(async (p) => {
    try {
      if (!p.pdf_url) return markStatus(p.id, 'no_pdf');
      const pdf = await fetchPdf(p.pdf_url, { maxBytes, timeoutMs });
      const { markdown, pages } = await doclingConvert(pdf);
      if (markdown.length < MIN_MD_BYTES) throw new Error('md too small');
      await db.query(
        `UPDATE research_papers
            SET fulltext_md=$1, fulltext_status='md_ready',
                fulltext_source='docling', fulltext_processed_at=now()
          WHERE id=$2`, [markdown, p.id]);
    } catch (e) {
      await db.query(
        `UPDATE research_papers
            SET fulltext_status = CASE WHEN fulltext_attempts>=3 THEN 'failed' ELSE 'pending' END,
                fulltext_error=$1
          WHERE id=$2`, [e.message, p.id]);
    }
  }));
}
```

### 4.3 `batch-runner` — Python (신규)

**위치**: `services/batch-runner/`

**핵심 구조**: 하나의 이미지에 3 개의 sub-command 를 둠. Docker 에서는 `command` 를 바꿔 같은 이미지로 cron 형태로 돌림.

`Dockerfile`
```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENTRYPOINT ["python", "-m", "batch_runner"]
```

`requirements.txt`
```
google-genai==0.8.*
psycopg[binary]==3.2.*
python-dotenv==1.0.*
```

**파일 구성**:
```
services/batch-runner/
  batch_runner/
    __init__.py
    __main__.py       # argparse: enqueue / submit / poll / apply / status
    config.py         # 환경변수 로딩
    db.py             # psycopg3 pool
    jsonl.py          # JSONL 빌더 (escape 처리)
    gemini_batch.py   # google-genai 래퍼 (upload, create batch, get, download)
    pipeline.py       # 각 서브커맨드 구현
  requirements.txt
  Dockerfile
  prompts/
    analyze.txt       # 시스템 프롬프트 (taxonomy 힌트 포함)
```

**서브커맨드 상세**

```
python -m batch_runner enqueue
  → md_ready 논문 최대 N건을 DB 에서 가져와 /tmp/batch-INPUT_<UUID>.jsonl 생성
  → 각 라인은 한 논문의 요청. custom_id 에 research_papers.id 넣기.

python -m batch_runner submit
  → 방금 생성된 JSONL 업로드, batches.create 호출
  → batch_jobs INSERT (state='PENDING'), 해당 논문들 fulltext_status='batch_submitted'

python -m batch_runner poll
  → batch_jobs 에서 state IN ('PENDING','RUNNING') 조회
  → 각 job 마다 batches.get 으로 최신 state 확인, UPDATE
  → SUCCEEDED 면 output_file_id 저장하고 apply 로 넘어감

python -m batch_runner apply
  → SUCCEEDED 상태인데 applied_at IS NULL 인 job 처리
  → output 파일 다운로드, 라인별로 custom_id → paper.id 매핑
  → analyzePaper 스키마 검증 후 UPDATE research_papers
  → 임베딩은 Batch API 의 embedContent 결과가 같이 오도록 JSONL 에 끼워넣거나,
    별도 embedContent 배치 작업으로 분리 (§5-4 참조)
  → 성공 논문은 fulltext_status='batch_done'
  → 실패 논문은 fulltext_status='failed', error 저장

python -m batch_runner status
  → 현재 상태 요약 출력 (디버깅용)
```

**cron 스케줄 (docker-compose)**: `docling-svc` / `pdf-worker` 는 항상 실행, `batch-runner` 는 외부 cron 이나 ofelia/scheduler 로 주기 실행. 예시 (아래 §4.5):

### 4.4 JSONL 요청 포맷

Gemini Batch API 의 `google-genai` 공식 JSONL 형식 예시:

```json
{"key":"paper_1234","request":{"contents":[{"role":"user","parts":[{"text":"...프롬프트+Markdown..."}]}],"generationConfig":{"temperature":0.2,"responseMimeType":"application/json","responseSchema":{...}},"systemInstruction":{"parts":[{"text":"...시스템 프롬프트..."}]}}}
```

> ⚠️ **JSON escape 주의** — Markdown 안의 큰따옴표·백슬래시·개행은 `json.dumps()` 가 자동 처리하지만, 수작업 문자열 접합 금지.

- `key` 에 `"paper_{research_papers.id}"` 를 넣으면 결과 파일의 `key` 로 역매핑 가능.
- `responseSchema` 는 현재 `src/lib/gemini.js` 의 `paperAnalysisSchema` 와 **1:1 동일**. Python 쪽에도 같은 스키마를 dict 로 복제해 두고 단일 소스로 관리하기 위해 `config/paper-analysis-schema.json` 을 만들어 공유.

**모델**: `gemini-2.5-flash-lite` (Batch 가 제공하는 가장 저렴한 옵션). 기본값은 `.env` 로 변경 가능.

### 4.5 compose 추가 (`docker-compose.minipc.yml`)

```yaml
services:
  # 기존 ingest, n8n 생략

  docling-svc:
    build: ./services/docling-svc
    restart: unless-stopped
    networks: [paperai]

  pdf-worker:
    build: .
    command: ["node", "src/pdf-worker.js"]
    env_file: .env
    environment:
      - DOCLING_URL=http://docling-svc:8089
      - PDF_WORKER_BATCH=5
      - PDF_WORKER_POLL_MS=10000
      - PDF_MAX_BYTES=52428800
    restart: unless-stopped
    depends_on:
      docling-svc:
        condition: service_started
    networks: [paperai]

  batch-runner:
    build: ./services/batch-runner
    env_file: .env
    environment:
      - BATCH_MAX_PAPERS=200
      - BATCH_MODEL=gemini-2.5-flash-lite
    # 주기 실행 은 ofelia 로 (아래)
    restart: "no"
    networks: [paperai]
    profiles: ["cron"]   # 기본 compose up 으로는 안 뜨게

  scheduler:
    image: mcuadros/ofelia:latest
    restart: unless-stopped
    depends_on: [batch-runner]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./services/batch-runner/ofelia.ini:/etc/ofelia/config.ini:ro
    command: daemon --config=/etc/ofelia/config.ini
    networks: [paperai]
```

`services/batch-runner/ofelia.ini` :
```ini
[job-exec "batch-enqueue-submit"]
schedule = 0 0 2 * * *        # 매일 새벽 2시
container = batch-runner
command = python -m batch_runner enqueue && python -m batch_runner submit

[job-exec "batch-poll-apply"]
schedule = 0 */15 * * * *     # 15분마다
container = batch-runner
command = python -m batch_runner poll && python -m batch_runner apply
```

> batch-runner 를 `profiles: ["cron"]` 로 숨기고, ofelia 가 `docker run` 이 아니라 이미 떠있는 컨테이너에 `exec` 하는 방식으로 호출. 그래서 batch-runner 는 `command: sleep infinity` 로 붙박이 두고 ofelia 가 exec 하는 구조 필요. 실제 구현 시 `command: ["sleep", "infinity"]` + `ENTRYPOINT []` 오버라이드.

---

## 5. 데이터 플로우

| 단계 | 담당 | 평균 소요 | 상태 변화 |
|---|---|---:|---|
| 1. 메타 수집 | n8n | ~1 s | - |
| 2. ingest 저장 + 1차 분석(abstract) | ingest | ~5 s | `'none' → 'pending'` (pdf_url 있으면) |
| 3. PDF → Markdown | pdf-worker → docling-svc | 10 ~ 60 s | `'pending' → 'running' → 'md_ready'` |
| 4. Batch 제출 (야간) | batch-runner enqueue+submit | ~10 s | `'md_ready' → 'batch_submitted'` |
| 5. Gemini 처리 | Google | 5 min ~ 6 h | (DB 변화 없음) |
| 6. 결과 적용 | batch-runner poll+apply | ~30 s | `'batch_submitted' → 'batch_done'` |

**즉시성**: 수집 직후부터 abstract 기반 검색 가능. md 기반 고급 분석은 하루 안에.

---

## 6. Phase 계획

### Phase 0 — 준비 (작업 없음)
- [ ] `make nas-psql "\d research_papers"` 로 현재 스키마 확인
- [ ] `.env` 에 `GEMINI_API_KEY` 있음 확인
- [ ] Gemini Batch API 가 현재 리전에서 활성화돼 있는지 (`google-genai` SDK 0.8+ 로 확인)

### Phase 1 — Docling 서비스
**생성**: `services/docling-svc/{Dockerfile,requirements.txt,main.py,README.md}`
**검증**:
```bash
docker compose -f docker-compose.minipc.yml build docling-svc
docker compose -f docker-compose.minipc.yml up -d docling-svc
curl -sf http://localhost:8089/healthz
curl -s -F "file=@sample.pdf" http://localhost:8089/convert | jq '.pages, (.markdown|length)'
```

### Phase 2 — 스키마 마이그레이션
**생성**: `sql/migrations/001_pdf_pipeline.sql` + `sql/init.sql` 반영
**검증**:
```bash
make nas-psql < sql/migrations/001_pdf_pipeline.sql
make nas-psql "\d research_papers" | grep -c fulltext   # 6
make nas-psql "\d batch_jobs"
```

### Phase 3 — ingest 플래그
**수정**: `src/ingest.js` — INSERT 시 `fulltext_status` 계산 (`pdf_url` 정상 http(s) → `'pending'`, 아니면 `'no_pdf'`)
**검증**: `make collect-once N=3` 후 `SELECT fulltext_status, COUNT(*) FROM research_papers GROUP BY 1;`

### Phase 4 — pdf-worker (Markdown 전용)
**생성**:
- `src/pdf-worker.js`
- `src/lib/pdf-fetch.js`
- `src/lib/docling-client.js`
- `scripts/test-pdf-worker.js` (1건 드라이런)

**수정**: `docker-compose.minipc.yml` (docling-svc + pdf-worker 추가)

**검증**:
```bash
node scripts/test-pdf-worker.js --id $(make nas-psql -s "SELECT MIN(id) FROM research_papers WHERE fulltext_status='pending';")
# 성공 후 풀가동
make up
docker logs -f pdf-worker
make nas-psql "SELECT fulltext_status, COUNT(*) FROM research_papers GROUP BY 1;"
```

### Phase 5 — batch-runner 기초 (enqueue/submit)
**생성**:
- `services/batch-runner/` 전체 (위 §4.3 파일 구성)
- `config/paper-analysis-schema.json` (Node/Python 공통)
- `services/batch-runner/prompts/analyze.txt`
- `services/batch-runner/ofelia.ini`

**수정**: `docker-compose.minipc.yml` (batch-runner + scheduler)

**검증**:
```bash
# 수동 1회 실행
docker compose -f docker-compose.minipc.yml --profile cron up -d batch-runner scheduler
docker exec batch-runner python -m batch_runner enqueue
docker exec batch-runner python -m batch_runner submit
make nas-psql "SELECT job_name, state, request_count FROM batch_jobs ORDER BY id DESC LIMIT 3;"
```

### Phase 6 — batch-runner poll/apply
**추가 구현**: `pipeline.py` 의 `poll()`, `apply()`
**검증**:
```bash
docker exec batch-runner python -m batch_runner status
# SUCCEEDED 상태 확인 후
docker exec batch-runner python -m batch_runner apply
make nas-psql "SELECT fulltext_status, COUNT(*) FROM research_papers GROUP BY 1;"
# batch_done 증가 확인
```

### Phase 7 — Makefile / 문서 / 운영 자동화
**Makefile 추가 타깃**:
- `make pdf-stats` — 상태별 카운트 (research_papers + batch_jobs)
- `make pdf-retry-failed` — 실패 건 `pending` 으로 돌리기
- `make batch-now` — enqueue + submit 즉시 실행
- `make batch-poll` — poll + apply 즉시 실행

**RUNBOOK §9** 에 실패 패턴 추가:
- JSONL escape 실패 → `\"` 혼재 확인
- batch state=FAILED → `error_samples` 확인
- 파일 업로드 2xx 이후 `batches.create` 실패 → API 버전 확인

### Phase 8 — 검색 품질 검증
- `make test-search Q="EUV PR resin LER 1.5 nm"` — batch_done 논문이 상단에 뜨는지
- abs vs md 임베딩 분포 비교:
  ```
  SELECT embedding_v, COUNT(*), AVG(novelty_score) FROM research_papers GROUP BY 1;
  ```

---

## 7. 환경변수 (`.env.minipc.example` 추가)

```bash
# ---- PDF 파이프라인 (pdf-worker) ----
DOCLING_URL=http://docling-svc:8089
PDF_WORKER_BATCH=5
PDF_WORKER_POLL_MS=10000
PDF_MAX_BYTES=52428800          # 50 MB
PDF_FETCH_TIMEOUT_MS=60000
DOCLING_TIMEOUT_MS=240000       # 4분
PDF_MIN_MD_BYTES=2048

# ---- Batch API (batch-runner) ----
GEMINI_API_KEY=...              # 기존과 공유
BATCH_MODEL=gemini-2.5-flash-lite
BATCH_EMBED_MODEL=text-embedding-004
BATCH_MAX_PAPERS=200            # 1회 배치에 담을 최대 논문 수
BATCH_MIN_PAPERS=20             # 이 미만이면 대기 (비용 효율)
BATCH_POLL_INTERVAL_MIN=15
BATCH_MAX_AGE_HOURS=6           # 이 시간 지나면 상태 무관 abandon
PDF_ALLOW_SOURCES=arxiv,chemrxiv  # 소스 필터 (안전 모드)
```

---

## 8. 비용 / 공간 / 운영

### 비용 (월 추정, 하루 120편 기준)
| 항목 | 계산 | 월 비용 |
|---|---|---:|
| Gemini 1차 분석 (스트리밍, abstract) | 120 × 1K in + 0.5K out × 30 | ~$0.3 |
| Gemini Batch 재분석 (md) | 120 × 25K in + 1K out × 30 × 0.5 | ~$3 |
| 임베딩 (batch) | 120 × 20K × 30 × 0.5 × ($0.15/M) | ~$0.05 |
| Docling CPU | 자체 호스트 | $0 |
| **합계** | | **≈ $3.5/월** |

> 일일 **하드 리밋 $1** 이 기본 설정 (§13). 정상 운영 시 하루 $0.15 정도 사용이 예상되므로 6 배 여유. 소스 추가·재색인 같은 이벤트 시 일시적으로 `make cost-limit-set LIMIT=3.00` 으로 상향 가능.

참고: 만약 모든 분석을 이미지 기반 스트리밍으로 했다면 월 $3,000 수준. **1,000 배 차이**.

### 디스크
- Markdown 평균 30 KB × 120 편 × 365 일 = **1.3 GB/년**. TOAST 압축 후 0.5 GB 수준.
- JSONL 임시 파일은 작업 완료 후 삭제.

### Gemini API 할당량
- Batch API 는 파일 총 크기 2 GB / job 제한. 하나의 배치에 논문 200 편 기준 ~6 MB. 여유 충분.

### 재시도
- pdf-worker: `fulltext_attempts < 3`. 초과 시 `'failed'` 고정.
- batch-runner: 한 job 이 FAILED 면 해당 논문들을 `'md_ready'` 로 되돌리고 다음 cron 에서 재시도. 단 `applied_at` 은 기록해 무한 루프 방지.

---

## 9. 롤백 전략

### 부분 롤백 (일시 중단)
```bash
# pdf-worker + docling 멈춤 (abstract 기반 수집은 계속)
docker compose -f docker-compose.minipc.yml stop pdf-worker docling-svc scheduler
# batch-runner 는 자동 정지 (ofelia 가 없으므로)
```

### 완전 롤백 (모든 MD 파이프라인 원복)
```sql
UPDATE research_papers SET
  fulltext_status='none', fulltext_md=NULL, fulltext_source=NULL,
  fulltext_processed_at=NULL, fulltext_error=NULL,
  fulltext_attempts=0, embedding_v='abs'
WHERE fulltext_status IN ('pending','running','md_ready','batch_submitted','batch_done','failed');

DELETE FROM batch_jobs;  -- 작업 이력 유지하려면 생략
```

ALTER 로 추가한 컬럼은 DROP 하지 않아도 됨 (비우면 충분).

---

## 10. 오픈 이슈

| # | 이슈 | 기본 판단 | 결정 시점 |
|---|---|---|---|
| 1 | OA PDF 소스별 다운로드 허용 | `PDF_ALLOW_SOURCES=arxiv,chemrxiv` 기본, Semantic Scholar OFF | Phase 4 |
| 2 | Docling 모델 빌드타임 warmup | Dockerfile 에 `RUN python -c 'DocumentConverter()'` | Phase 1 |
| 3 | Markdown 멀티 벡터 (섹션 단위) | Phase 8 이후 과제. 지금은 단일 벡터 유지 | — |
| 4 | Batch 임베딩 분리 | 분석 Batch + 별도 임베딩 Batch 2개로 분리 가능. 단 복잡도 ↑ → Phase 5 에서 결정 | Phase 5 |
| 5 | Batch 결과 품질 모니터링 | abs 기반 vs md 기반 summary 길이·key_findings 개수 비교 대시보드 (Phase 8) | Phase 8 |
| 6 | GPU 사용 | LXC 에 nvidia-container-toolkit 전달 가능하면 `runtime: nvidia` + `DOCLING_DEVICE=cuda` | 성능 부족 시 |

---

## 11. Claude Code 에 넘길 때 쓸 프롬프트 (복사용)

> 다음 문서를 읽고 Phase 1 부터 순서대로 수행해줘. 각 Phase 종료 시 검증 명령을 실제로 돌려 결과를 보여주고, 통과하면 다음 Phase 로 진행해. 막히면 중단하고 질문해.
>
> 문서: `docs/PDF-PIPELINE.md`
>
> 전제:
> - 현재 저장소 구조·관례는 `CLAUDE.md` 기준을 지켜.
> - Node 쪽은 ES 모듈, `"type": "module"` 유지.
> - Python 쪽은 `services/<name>/` 하위에 자체 Dockerfile.
> - 시크릿은 `.env` 에서만 읽기.
> - 각 Phase 종료 시 단일 커밋: `feat(pdf): phase N — <요약>`

---

## 12. Python Batch API 스켈레톤 — Claude Code 참고용

batch-runner 구현 시 핵심 의사코드 한눈 정리:

```python
# services/batch-runner/batch_runner/gemini_batch.py
from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

def upload_input(jsonl_path: str) -> str:
    f = client.files.upload(
        file=jsonl_path,
        config=types.UploadFileConfig(display_name="paper-batch"),
    )
    return f.name

def create_batch(file_name: str, display_name: str, model: str) -> str:
    job = client.batches.create(
        model=model,
        src=file_name,
        config=types.CreateBatchJobConfig(display_name=display_name),
    )
    return job.name

def get_state(job_name: str):
    return client.batches.get(name=job_name)

def download_output(output_file_id: str, dst: str):
    data = client.files.download(name=output_file_id)
    with open(dst, "wb") as f:
        f.write(data)
```

```python
# services/batch-runner/batch_runner/jsonl.py
import json
def build_line(paper_id: int, system_prompt: str, markdown: str,
               schema: dict, model: str) -> str:
    req = {
        "key": f"paper_{paper_id}",
        "request": {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": markdown}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseSchema": schema,
            },
        },
    }
    return json.dumps(req, ensure_ascii=False)  # escape 자동 처리
```

```python
# services/batch-runner/batch_runner/pipeline.py (apply 발췌)
def apply():
    jobs = db.query("SELECT * FROM batch_jobs WHERE state='SUCCEEDED' AND applied_at IS NULL")
    for job in jobs:
        local = f"/tmp/batch-out-{job.id}.jsonl"
        download_output(job.output_file_id, local)
        for line in open(local):
            rec = json.loads(line)
            paper_id = int(rec["key"].removeprefix("paper_"))
            if rec.get("error"):
                db.execute("UPDATE research_papers SET fulltext_status='failed', fulltext_error=%s WHERE id=%s",
                           (rec["error"]["message"], paper_id))
                continue
            analysis = json.loads(rec["response"]["candidates"][0]["content"]["parts"][0]["text"])
            sanitized = sanitize_analysis(analysis)
            db.execute("""UPDATE research_papers SET
                  summary_ko=%s, key_findings=%s, materials=%s, techniques=%s,
                  major_category=%s, mid_category=%s, sub_category=%s, tags=%s,
                  novelty_score=%s, relevance_score=%s,
                  fulltext_status='batch_done'
                WHERE id=%s""", (... sanitized ..., paper_id))
        db.execute("UPDATE batch_jobs SET applied_at=now() WHERE id=%s", (job.id,))
```

임베딩은 `client.batches.create` 를 `model="text-embedding-004"` 로 한 번 더 제출 (§10 이슈 4 참조).

---

## 13. 토큰·비용 하드 리밋 안전장치 (⚠️ 필수 구현)

> "API 호출할 때마다 토큰 수를 로컬 DB 에 저장하고, 일일 한도(기본 $1) 넘으면 즉시 스크립트 종료" 요건의 완전한 설계.

### 13-1. 동작 규칙

1. **모든** Gemini 호출 (ingest 1차분석, pdf-worker 폴백, batch-runner 제출·apply, search 의 rewrite/synthesize, MCP 의 서버 툴) 은 `cost_gate` 를 거친다. 우회로 호출하는 코드는 **CI 에서 금지** (grep 룰, §13-6).
2. 호출 **전**: 오늘 누적 비용이 `cost_settings.daily_limit_usd` 이상이면 즉시 `CostLimitExceeded` 예외. 호출자는 로그 남기고 `exit(1)`.
3. 호출 **후**: `usageMetadata` 로부터 비용 계산해 `api_usage` INSERT.
4. 80% (기본값) 도달 시 `logger.warn` 으로 경고 — n8n/Grafana 연동 여지.
5. Batch API 제출 시점엔 실제 토큰이 없음 → **apply 시점에** `api_usage` INSERT (Batch 는 응답 JSONL 에 `usageMetadata` 포함). 제출 시점엔 0-row placeholder 만 남겨두면 추적은 되지만 비용은 0.
6. 하드 리밋은 UTC 자정 기준. `TZ` 환경변수 로 변경 가능.

### 13-2. 가격표 (`config/gemini-pricing.json`)

```json
{
  "models": {
    "gemini-2.5-flash-lite":  { "input_per_1m": 0.10, "output_per_1m": 0.40 },
    "gemini-2.5-flash":       { "input_per_1m": 0.30, "output_per_1m": 2.50 },
    "text-embedding-004":     { "input_per_1m": 0.15, "output_per_1m": 0.00 }
  },
  "batch_discount": 0.5,
  "cached_input_ratio": 0.25
}
```

실제 가격은 구글 공식 페이지 기준으로 갱신 (`scripts/update-gemini-pricing.js` 로 문서 fetch 후 수동 확인). Claude Code 가 구현할 때 이 파일이 없으면 위 기본값을 그대로 써라.

비용 계산 공식:
```
cost = (input_tokens - cached_tokens) / 1e6 * in_price
     + cached_tokens                   / 1e6 * in_price * cached_input_ratio
     + output_tokens                   / 1e6 * out_price
     * (batch_discount if is_batch else 1.0)
```

### 13-3. Node 구현 — `src/lib/cost-gate.js`

```js
import { db } from './db.js';
import { logger } from './logger.js';
import pricing from '../../config/gemini-pricing.json' assert { type: 'json' };

export class CostLimitExceeded extends Error {}

export const costGate = {
  async check() {
    const { rows } = await db.query(`
      SELECT (SELECT spent_usd FROM v_today_cost)   AS spent,
             (SELECT daily_limit_usd FROM cost_settings WHERE id=1) AS lim,
             (SELECT alert_threshold_ratio FROM cost_settings WHERE id=1) AS warn`);
    const { spent, lim, warn } = rows[0];
    if (Number(spent) >= Number(lim)) {
      throw new CostLimitExceeded(`daily $${lim} reached ($${spent})`);
    }
    if (Number(spent) >= Number(lim) * Number(warn)) {
      logger.warn({ spent, lim }, 'cost 80% threshold');
    }
  },

  async record({ model, endpoint, caller, paperId = null, batchJobId = null,
                 isBatch = false, usageMetadata, meta = {} }) {
    const inTok  = usageMetadata?.promptTokenCount        ?? 0;
    const outTok = usageMetadata?.candidatesTokenCount    ?? 0;
    const cacTok = usageMetadata?.cachedContentTokenCount ?? 0;
    const p = pricing.models[model] ?? pricing.models['gemini-2.5-flash-lite'];
    let cost = ((inTok - cacTok)/1e6)*p.input_per_1m
             + (cacTok/1e6)*p.input_per_1m*pricing.cached_input_ratio
             + (outTok/1e6)*p.output_per_1m;
    if (isBatch) cost *= pricing.batch_discount;

    await db.query(`INSERT INTO api_usage
      (model,endpoint,is_batch,input_tokens,output_tokens,cached_tokens,
       cost_usd,caller,paper_id,batch_job_id,meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [model, endpoint, isBatch, inTok, outTok, cacTok, cost.toFixed(6),
       caller, paperId, batchJobId, meta]);
    return cost;
  },

  async run(ctx, fn) {
    await this.check();
    const result = await fn();
    const um = result?.response?.usageMetadata ?? result?.usageMetadata ?? ctx.usageMetadata;
    if (!um) logger.warn({ ctx }, 'usageMetadata missing — 비용 추적 누락 가능');
    await this.record({ ...ctx, usageMetadata: um });
    return result;
  },
};

export function installPanicHandler() {
  process.on('unhandledRejection', (err) => {
    if (err instanceof CostLimitExceeded) {
      logger.error({ err: err.message }, '🛑 COST LIMIT — exiting');
      process.exit(1);
    }
  });
}
```

`src/lib/gemini.js` 의 `analyzePaper`, `rewriteQueryForSearch`, `synthesizeAnswer` 3 곳과 `src/lib/embedding.js` 의 `embedText` 를 모두 `costGate.run(...)` 으로 감싸야 한다.

### 13-4. Python 구현 — `services/batch-runner/batch_runner/cost_gate.py`

```python
import json, os
from contextlib import contextmanager
from .db import conn
from .config import PRICING

class CostLimitExceeded(RuntimeError): ...

def _calc(model, in_tok, out_tok, cac_tok, is_batch):
    p = PRICING["models"].get(model, PRICING["models"]["gemini-2.5-flash-lite"])
    cost = (in_tok-cac_tok)/1e6*p["input_per_1m"] \
         + cac_tok/1e6*p["input_per_1m"]*PRICING["cached_input_ratio"] \
         + out_tok/1e6*p["output_per_1m"]
    if is_batch: cost *= PRICING["batch_discount"]
    return cost

def check():
    with conn().cursor() as cur:
        cur.execute("SELECT (SELECT spent_usd FROM v_today_cost),"
                    "(SELECT daily_limit_usd FROM cost_settings WHERE id=1)")
        spent, lim = cur.fetchone()
        if spent >= lim:
            raise CostLimitExceeded(f"daily ${lim} reached (${spent})")

@contextmanager
def cost_gate(caller, model, endpoint, is_batch=False,
              paper_id=None, batch_job_id=None, meta=None):
    check()
    rec = type("Rec", (), {"in_tok":0,"out_tok":0,"cac_tok":0})()
    def set_tokens(um):
        rec.in_tok  = um.get("promptTokenCount",0)
        rec.out_tok = um.get("candidatesTokenCount",0)
        rec.cac_tok = um.get("cachedContentTokenCount",0)
    rec.set_tokens = set_tokens
    try:
        yield rec
    finally:
        cost = _calc(model, rec.in_tok, rec.out_tok, rec.cac_tok, is_batch)
        with conn().cursor() as cur:
            cur.execute("""INSERT INTO api_usage
              (model,endpoint,is_batch,input_tokens,output_tokens,cached_tokens,
               cost_usd,caller,paper_id,batch_job_id,meta)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
              (model, endpoint, is_batch, rec.in_tok, rec.out_tok, rec.cac_tok,
               round(cost,6), caller, paper_id, batch_job_id, json.dumps(meta or {})))
```

### 13-5. 호출자 측 종료 훅

- **pdf-worker** (`src/pdf-worker.js`) : 루프 상단에서 `await costGate.check()`. 예외 catch 시 `process.exit(1)` — Docker `restart: unless-stopped` 때문에 즉시 재기동되므로, **재기동 후 또 check 하고 또 죽음** = 사실상 자정까지 dormant.
- **batch-runner** (`services/batch-runner/batch_runner/__main__.py`) : 각 서브커맨드 진입 시 `cost_gate.check()`. 넘으면 `sys.exit(1)`.
- **ingest** (`src/ingest.js`) : 1차 분석 전 check. 넘으면 abstract 저장은 하되 분석 필드는 비우고 `fulltext_status='pending'` 만 남긴다 (수집 자체는 막지 않음 — 재기동 후 재시도).
- **search / MCP** : 넘으면 "예산 한도 도달 — 내일 다시 시도하세요" 메시지 반환. 프로세스는 유지.

### 13-6. Makefile 타깃

```makefile
cost-today: ## 오늘 누적 비용·토큰
	./scripts/nas-psql.sh "SELECT * FROM v_today_cost;"

cost-day: ## 일자별 (caller·model) 30일 롤업
	./scripts/nas-psql.sh "SELECT * FROM v_daily_api_cost;"

cost-limit-set: ## 한도 변경 (예: make cost-limit-set LIMIT=2.00)
	./scripts/nas-psql.sh "UPDATE cost_settings SET daily_limit_usd=$(LIMIT), updated_at=now() WHERE id=1;"

cost-limit-show: ## 현재 한도
	./scripts/nas-psql.sh "SELECT daily_limit_usd, alert_threshold_ratio, hard_stop_enabled FROM cost_settings WHERE id=1;"

cost-panic-reset: ## 한도 도달로 멈춘 서비스 수동 재개 (하루 한도 임시 증액)
	./scripts/nas-psql.sh "UPDATE cost_settings SET daily_limit_usd = daily_limit_usd + 1.0 WHERE id=1;"
```

**CI/린트 룰** (선택): `.github/workflows/lint.yml` 또는 pre-commit 에서
```bash
# costGate 미경유 Gemini 호출 탐지 (거친 휴리스틱)
git grep -nE "generateContent|embedContent|batches\.create" -- src/ services/ \
  | grep -v 'cost-gate\|cost_gate' \
  && { echo "❌ Gemini 호출이 costGate 를 우회했습니다."; exit 1; } || true
```

### 13-7. 검증 시나리오

1. **정상 한도 내**: `make cost-today` → spent < limit. pdf-worker·batch-runner 정상 가동.
2. **한도 근접**: `UPDATE cost_settings SET daily_limit_usd=0.0001;` 로 한도 0.01 센트로 설정 → 다음 호출에서 즉시 예외 → 컨테이너 exit 확인.
3. **자동 재개**: UTC 자정 지나면 `v_today_cost` 가 0 으로 리셋되어 재기동된 컨테이너가 다시 정상 가동 시작.
4. **Batch 비용 적용**: apply 실행 후 `api_usage` 에 `is_batch=true, cost_usd = <streaming 의 0.5>` 로 기록됐는지 확인.

### 13-8. Phase 계획에 끼워넣기

| Phase | 작업 | 추가 사항 |
|---|---|---|
| **2 (스키마)** | `001_pdf_pipeline.sql` | §3-2 (api_usage), §3-3 (cost_settings) 포함 |
| **3 (ingest)** | ingest 의 Gemini 호출 | `costGate.run()` 로 감싸기 |
| **4 (pdf-worker)** | 워커 메인 루프 | 루프 상단 `check()`, 예외 시 exit |
| **5 (batch-runner)** | 서브커맨드 전부 | `with cost_gate(...)` 래핑, apply 에서 실제 usage 기록 |
| **7 (Makefile)** | cost-* 타깃 | 위 §13-6 추가 |

---

## 14. 환경변수 보강 (`.env.minipc.example`)

```bash
# ---- Cost guardrail ----
DAILY_COST_LIMIT_USD=1.00       # 실제 한도는 DB 가 권위. 부팅 시 DB 에 반영.
COST_ALERT_THRESHOLD_RATIO=0.80
TZ=UTC                          # 하드 리밋 기준 타임존
```

---

**끝.** 이 기획대로 Claude Code 에 넘기면 Phase 1 부터 실행 가능하며, 모든 Gemini 호출이 토큰 단위로 추적되고 일일 $1 초과 시 모든 관련 프로세스가 즉시 종료됩니다.
