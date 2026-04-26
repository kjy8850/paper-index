# CLAUDE.md — 이 저장소의 컨텍스트 (v2 — 5-Layer Pipeline)

이 파일은 Claude Code 가 프로젝트에 들어오자마자 읽는 안내문입니다. 구조·관례·자주 하는 실수를 요약합니다.

## 프로젝트 한 줄 요약
반도체 소재(특히 포토레지스트) 논문을 매일 최대 300편 수집 → **5-Layer 파이프라인**(Gemini Flash 1차 분류 + Claude Sonnet Deep Parsing) → PostgreSQL+pgvector 에 768-dim 임베딩 저장 → MCP 서버로 Claude 에서 자연어 검색.

## 5-Layer 파이프라인 개요
```
 Layer 1  수집     OpenAlex / S2 / arXiv / ChemRxiv (메모리·DB 3-table dedupe) → papers_staging
 Layer 2  관련성   Gemini Flash Batch (abstract 만)     → papers_scored / papers_excluded
 Layer 3  변환     PDF → Markdown (Docling)             → md_text in papers_staging
 Layer 4  딥파싱   Claude Sonnet 4.6 (md 또는 PDF 직접) → papers_parsed (+ composition_data / reaction_conditions)
 Layer 5  서비스   research_papers + 임베딩 + MCP 검색
```
요청별 자세한 사항은 `PAPER_SYSTEM_ARCHITECTURE.md` 와 `docs/UPGRADE-V2.md` 참고.

## 배포 구성
- **미니PC (Ubuntu 24.04, N150)** : n8n + Node ingest API + pdf-worker + claude-parser + (Python) batch-runner / docling-svc + (선택) MCP HTTP. **Claude Code 는 여기서 실행됨.**
- **NAS (Synology DS918+)** : PostgreSQL 16 + pgvector 만. `/volume1/docker/papers-pg` 가 NFS 로 미니PC `/mnt/nas-papers-pg` 에 마운트됨.
- **동기화**: 필요한 파일만 rsync (`make nas-sync`).

## 폴더 구조
```
src/
  lib/              공통 라이브러리 (db, gemini, embedding, logger, config,
                    normalize, rate-limiter, dedupe, system-config,
                    claude-client, parse-schemas, pdf-fetch, docling-client)
  sources/          논문 소스 어댑터 (openalex, semantic-scholar, arxiv, chemrxiv)
  ingest.js         수집·중복제거·staging API (Phase 1/2 분기 + 대시보드)
  pdf-worker.js     Layer 3 — papers_staging.pending → md_ready
  deep-parser.js    Layer 4 — papers_staging.md_ready/queued → papers_parsed
  publisher.js      Layer 5 — papers_parsed → research_papers + embedding
  search.js         시멘틱 검색 핵심
  mcp-server.js     Claude Desktop 용 stdio MCP
  mcp-http.js       Claude Web Custom Connector 용 HTTP MCP

services/
  batch-runner/     Python — Layer 2 Gemini Flash Batch (enqueue/submit/poll/apply)
  docling-svc/      Python — Layer 3 PDF → Markdown 변환 HTTP 서비스

config/
  taxonomy.json
  keywords.json                v2 (primary 8 + secondary 11 + phase params)
  prompts/                     운영 중 수정 가능한 프롬프트 모음
    gemini-relevance.txt
    claude-md-quality.txt
    claude-unsure-recheck.txt
    claude-composition.txt
    claude-reaction.txt
    claude-process.txt
  paper-analysis-schema.json   (이전, 단일 호출용 — 호환만 유지)
  gemini-pricing.json
prompts/
  deep-parser-system.txt       Layer 4 system prompt

sql/
  init.sql                     legacy schema (research_papers / categories / ingestion_log)
  migrations/
    001_pdf_pipeline.sql       PDF 파이프라인 컬럼 추가 (이미 운영 중)
    002_v2_layered_pipeline.sql  v2 — papers_staging/scored/parsed/... + system_config
    003_v2_publisher_and_recovery.sql  Layer 5 publisher 컬럼 + 잠금 복구 함수 + v_publisher_summary

scripts/
  migrate.js                   sql/migrations/*.sql idempotent runner
  backfill-parse.js            Phase 1 종료 후 200건 큐잉
  collect-once.js, test-*.js, ...

n8n/
  workflow.json                v2 — 30분마다 /ingest/run-phase + 15분 batch + 일일 리포트

Dockerfile                     Node 앱
docker-compose.minipc.yml      n8n + ingest + pdf-worker + claude-parser + batch-runner + docling + scheduler
docker-compose.nas.yml         NAS 전용 Postgres+pgvector
docker-compose.yml             단일 머신 테스트용 (하이브리드에선 안 씀)
Makefile                       자주 쓰는 명령
```

## 중요 관례

### 1. ES 모듈
- `package.json` 에 `"type": "module"`. **CommonJS `require` 금지.** 모두 `import`.

### 2. 환경변수
- **`.env` 를 절대 커밋 금지.** `.env.nas.example`, `.env.minipc.example` 만 저장소 포함.
- 코드는 `process.env.X` 로만 읽음. 하드코딩된 시크릿 금지.
- v2 신규 키: `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `OPENALEX_EMAIL`, `DAILY_PDF_LIMIT`, `PHASE1_*`, `PHASE2_DAYS_WINDOW`.

### 3. pgvector / 임베딩
- 벡터는 `vector(768)` 컬럼. JS → SQL 삽입 시 `toVectorLiteral()` 로 `[0.1,0.2,...]` 문자열 만들고 `$N::vector` 캐스팅.
- 임베딩 모델: `text-embedding-004` (Gemini). 차원 바꾸면 DDL 과 인덱스까지 재생성 필요.

### 4. Layer 2 (Gemini Flash) — 관련성·타입 판단만
- abstract 만 보냄. 본문 분석은 Layer 4 가 수행.
- 결과: `papers_scored` (yes/unsure → Layer 3/4) 또는 `papers_excluded` (no, layer2).
- 호출 진입점: `services/batch-runner/batch_runner/pipeline.py`.

### 5. Layer 4 (Claude Sonnet) — Deep Parsing
- `src/deep-parser.js` 가 워커. 우선순위: `queued` → `md_ready`.
- markdown 품질이 ok 면 md 본문, broken 이면 PDF base64 직접 투입.
- PDF 직접 모드는 `daily_pdf_limit`(기본 10) 으로 비용 가드. 초과 시 `queued` 로 이월.
- 모델: `system_config.claude_model` (기본 `claude-sonnet-4-6`) → fallback `process.env.CLAUDE_MODEL`.
- JSON Schema 는 `src/lib/parse-schemas.js`. tool_use 강제로 구조화 응답.

### 5-bis. Layer 5 (Publisher) — research_papers 동기화
- `src/publisher.js` 가 워커. `v_publish_pending` 뷰에서 new/update 만 픽업.
- 매칭 키 우선순위: `staging_id` → `doi` → `arxiv_id` (UPSERT).
- summary_ko / key_findings / materials / techniques / major_category 매핑 후 `embedText()` 로 768-dim 임베딩 생성.
- search.js / MCP 의 시멘틱 검색은 **publish 된 행만** 본다. publisher 가 안 돌면 새 논문 검색 불가.

### 6. system_config (운영 상태 KV)
- `phase1_completed`, `phase1_last_cursor`, `phase1_collected_today`, `daily_pdf_limit`, `daily_pdf_processed`, `claude_model`, `gemini_relevance_prompt_version` …
- 헬퍼: `src/lib/system-config.js` — `getConfig/setConfig/getJson/setJson/ensureDailyPdfCounter/getPhase1State`.

### 7. dedup (3-table)
- 메모리 1차: `src/sources/index.js#dedupe` — doi > arxiv_id > title_normalized > source:source_id.
- DB 2차: `src/lib/dedupe.js#dedupeAgainstDb` — papers_staging + papers_history + papers_excluded 동시 조회.
- title_normalized 는 `src/lib/normalize.js#normalizeTitle` 로 일관 생성. **모든 소스 어댑터는 finalizePaperRef 통과 필수.**

### 8. 에러 핸들링
- 대량 루프(수집·분석)에서 **한 건 실패로 전체 중단 금지.** `Promise.allSettled` 또는 try/catch 개별 처리.
- 실패 내용은 `ingestion_log.error_samples` 에 최대 5건 저장.

### 9. 로그
- `src/lib/logger.js` 의 pino 사용. `console.log` 지양.
- 민감 정보(API 키, password) 로그에 남기지 않기.

## 자주 쓰는 명령
- `make help` — 전체 타깃 목록
- `make migrate` / `make migrate-status` — sql/migrations 적용
- `make up` — 미니PC 컨테이너 전체 기동
- `make claude-parser-up` — Layer 4 워커만 따로 기동
- `make publisher-up` / `make publish-pending` / `make publish-recent` — Layer 5 publisher 운영
- `make recover-stuck` — parsing/pdf_running 으로 갇힌 행 30분 기준 복구
- `make phase-status` — 현재 phase + papers fulltext_status 분포
- `make phase1-trigger` / `make phase2-trigger` — 강제 호출
- `make backfill-dry` / `make backfill` — 200건 우선순위 큐잉 (Phase 1 끝난 후)
- `make pipeline-status` — `v_pipeline_status` 뷰 보기
- `make layer4-today` / `make cost-today-v2` — Layer 4 처리량 + Gemini/Claude 비용
- `make nas-sync` — NAS 동기화
- `make logs-ingest` / `make claude-parser-logs` / `make logs-batch`

## 변경 시 체크리스트
1. **DB 스키마?** → `sql/migrations/NNN_*.sql` 새 파일로 추가 (기존 파일 수정 X). `make migrate` 가 idempotent 적용.
2. **새 소스?** → `src/sources/<name>.js` (rate-limiter + finalizePaperRef 사용) + `src/sources/index.js` 의 ALL_FNS 등록.
3. **분석 스키마 바꿈?** → `src/lib/parse-schemas.js` + `src/deep-parser.js` 의 INSERT 매핑 + DB 컬럼까지 함께.
4. **새 MCP 툴?** → `src/mcp-server.js` 와 `src/mcp-http.js` **양쪽**에 등록.
5. **비용·레이트 문제?** → `.env` 의 `GEMINI_CONCURRENCY`, `DAILY_PDF_LIMIT`, `PHASE1_PER_KEYWORD` 부터 조정.
6. **프롬프트 변경?** → `config/prompts/*.txt` 수정 + `system_config.gemini_relevance_prompt_version` +1.

## 하지 말 것
- 단일머신용 `docker-compose.yml` 을 하이브리드 환경에서 up 하지 말 것. 충돌 원인.
- NAS 쪽 `.env` 를 예시값 그대로 두지 말 것. `PGPASSWORD` 는 반드시 강한 랜덤값.
- Postgres 5432 포트를 외부 인터넷에 노출하지 말 것. LAN 서브넷에만.
- stdio MCP 서버 (`src/mcp-server.js`) 를 도커 컨테이너 안에서 실행하려 하지 말 것.
- pdf-worker / deep-parser 가 직접 `research_papers` 에 쓰게 하지 말 것. 모든 신규 작업은 `papers_staging` 경유 후 Layer 4 가 마감.
- `md_text` 를 history/parsed 에 영구 저장하지 말 것 (Layer 4 후 NULL 처리).

## 참고 문서
- `README.md` — 개괄
- `PAPER_SYSTEM_ARCHITECTURE.md` — 5-Layer 파이프라인 사양
- `docs/UPGRADE-V2.md` — v1→v2 마이그레이션 절차 (이 저장소를 처음 v2 로 올릴 때)
- `docs/UPGRADE-V2-EXECUTE.md` — **미니PC 에서 v1→v2 업그레이드를 Claude Code 가 그대로 실행하는 지시서** (사용자는 이 파일을 가리키는 한 줄 프롬프트만 주면 됨)
- `docs/DEPLOY-HYBRID.md` — 하이브리드 배포 상세
- `docs/RUNBOOK.md` — 처음 30분 체크리스트
- `docs/PDF-PIPELINE.md` — Docling + Gemini Batch + 일일 비용 가드
- `n8n/README.md` — 워크플로 임포트·수정법
- `config/prompts/README.md` — 프롬프트 파일 운영 규칙
