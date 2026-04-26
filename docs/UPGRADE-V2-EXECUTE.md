# 미니PC v1 → v2 5-Layer 업그레이드 실행 가이드

이 문서는 **Claude Code 에게 직접 주는 실행 지시서**다. 사용자는
`docs/UPGRADE-V2-EXECUTE.md 따라서 v1→v2 업그레이드 실행해줘` 한 줄만 보내고,
나머지는 Claude Code 가 이 문서대로 진행한다.

## Mission

미니PC(Ubuntu 24.04)를 v1 → v2 5-Layer 파이프라인으로 업그레이드한다.
GitHub `kjy8850/paper-index` main 브랜치에 v2 8개 커밋이 이미 push 되어 있다.
이 머신에서 git pull → DB 마이그레이션 → npm install → .env 보강 → 컨테이너
재빌드 → smoke test 까지 안전하게 진행하고, 각 단계 끝마다 결과를 한국어로 보고한다.

먼저 `CLAUDE.md` 와 `docs/UPGRADE-V2.md` 를 읽어 v2 파이프라인의 의도와 제약을
파악한다. 모르는 게 있으면 멈춰 묻기 전에 docs 와 코드를 먼저 읽어 자력 해결을
시도하되, 파괴적/비가역적 동작(DB 데이터 삭제, force push, 운영 컨테이너 강제
종료)은 반드시 사전 승인을 요청한다.

## 작업 순서

### 1) 현재 상태 캡처 (롤백 대비)

- `git status` / `git log --oneline -5` 로 현재 HEAD 확인
- `make ps` (또는 `docker compose -f docker-compose.minipc.yml ps`) 로 가동 컨테이너 스냅샷
- `make pipeline-status` 가 동작하지 않으면 (v2 마이그레이션 전이므로 정상) 무시
- `./scripts/nas-psql.sh "SELECT COUNT(*) FROM research_papers"` 로 데이터 baseline 기록

이 정보를 한 블록에 정리해 보고. 이후 단계 실패 시 이 시점으로 되돌릴 기준점이다.

### 2) 코드 fetch + pull

- `git fetch origin && git status` 로 분기 상태 확인
- 워킹트리에 untracked / modified 가 있으면 `git stash -u` 후 pull
- `git pull --ff-only origin main`. fast-forward 안 되면 멈추고 보고 (rebase/merge 결정 필요)
- pull 후 `git log --oneline -10` 결과 보고. 8개 v2 커밋이 들어왔는지 확인:
  - `chore(db): v2 layered pipeline migrations + publisher recovery`
  - `feat(layer1) ... feat(layer2) ... feat(layer3) ... feat(layer4) ...`
  - `feat(layer5) ... feat(mcp) ... chore(infra): docker-compose + n8n + env + docs`

### 3) DB 마이그레이션 (NAS Postgres)

- `make migrate-status` 로 적용 대기 파일 목록 확인 (002, 003 두 개여야 함)
- `make migrate-dry` 로 어떤 SQL 이 실행될지 확인
- 운영 컨테이너 가동 중이면 사전 안내 후 `make migrate` 실행 (idempotent 라 안전)
- 적용 직후 검증:
  - `./scripts/nas-psql.sh "\dt"` 로 papers_staging / papers_history /
    papers_excluded / papers_scored / papers_parsed / composition_data /
    reaction_conditions / system_config / cost_log 테이블 존재 확인
  - `./scripts/nas-psql.sh "SELECT * FROM v_pipeline_status"` 가 에러 없이 실행되는지
  - `./scripts/nas-psql.sh "SELECT * FROM v_publisher_summary"` 도 동일

마이그레이션이 깨지면 즉시 보고 + `git diff sql/migrations/00{2,3}*` 으로 원인 분석.
임의로 003 만 다시 돌리는 식의 부분 적용 금지.

### 4) npm install + 코드 빌드 검증

- `npm install` (anthropic-sdk 신규)
- 모든 진입점 syntax check:

  ```bash
  for f in src/ingest.js src/mcp-server.js src/mcp-http.js src/pdf-worker.js \
           src/deep-parser.js src/publisher.js src/search.js; do
    node --check "$f" && echo "OK: $f"
  done
  ```

- `python3 -m py_compile services/batch-runner/batch_runner/*.py`
- 한 건이라도 실패하면 멈추고 파일/줄/에러 메시지 그대로 보고

### 5) .env 키 보강

`.env` 와 `.env.minipc.example` 을 비교해서 신규 키만 골라 추가한다.
값이 비어 있는 항목은 추측해서 채우지 말고 어떤 키가 필요한지 한 번에 묶어 질문한다.

특히 다음 키는 반드시 확인:

- `ANTHROPIC_API_KEY=sk-ant-...` ← Layer 4 가 동작 안 하면 이게 원인
- `CLAUDE_MODEL=claude-sonnet-4-6` (옵셔널, 기본값 동일)
- `DAILY_PDF_LIMIT=10` ← Layer 4 PDF 비용 가드
- `PHASE1_DAILY_TARGET=300`
- `PHASE1_TIMEOUT_HOURS=20`
- `PHASE1_MIN_BATCH=50`
- `PHASE1_PER_KEYWORD=50`
- `PHASE2_DAYS_WINDOW=14`
- `OPENALEX_EMAIL=...@...` ← OpenAlex polite pool 진입용
- `STAGING_INSERT_CONCURRENCY=8` (옵셔널)

`.env` 직접 출력 금지 (시크릿). 어떤 키가 비어 있는지 키 이름만 보고한다.

### 6) 컨테이너 재빌드 + 가동

기존 v1 컨테이너 (ingest / pdf-worker / batch-runner / docling-svc / scheduler) 는
그대로 유지하되 신규 워커 (claude-parser, publisher) 를 추가하고 v2 코드로 재빌드한다.

```bash
make down                              # 한 번 깔끔히 내림 (n8n 포함)
docker compose -f docker-compose.minipc.yml build --pull
make up                                # ingest/pdf-worker/batch-runner/docling 등 모두 기동
make claude-parser-up                  # Layer 4 워커
make publisher-up                      # Layer 5 워커
```

기동 후 `make ps` 로 모든 컨테이너 `Up` 상태인지 확인. crashloop 있으면
`docker compose -f docker-compose.minipc.yml logs --tail=200 <서비스>` 로 원인 보고.

### 7) Smoke Test (필수)

각 항목이 통과해야 v2 가동 완료로 간주한다. 통과 못 한 항목은 그대로 보고한다.

- **a. 헬스체크**: `curl -sf http://localhost:8787/health | jq` → `{"ok": true, ...}`
- **b. /api/status**: `make phase-status` → phaseState / papers / cost 모두 비지 않음
- **c. 수집 1회 강제**: `make phase2-trigger` → `staged > 0` 또는 `duplicated_db > 0`
- **d. Layer 2 (배치)**: 5분 대기 후 `make pdf-stats` → `papers_scored` count 증가 또는
   batch_jobs 에 새 job_name 등장
- **e. Layer 4**: `make claude-parser-logs` 에서 `daily_pdf_processed` 또는
   `parsed insert` 로그 1건 이상
- **f. Layer 5**: `make publish-pending` → 결과 행 ≥ 0 (에러 없이 SELECT 됨).
   추가로 `make publish-recent` 가 빈 결과여도 OK (아직 publish 안 됐을 뿐)
- **g. MCP 시멘틱 검색** (publisher 가 한 건이라도 처리한 후):
   `node scripts/test-search.js "EUV 포토레지스트"` → 결과 출력

### 8) 비용 / 모니터링 베이스라인

- `make cost-today-v2` 로 v_daily_cost 첫 기록 확인 (Gemini 만 있어도 OK)
- `make layer4-today` 로 Layer 4 처리량 (0 일 수 있음)
- `make excluded-recent` 로 papers_excluded layer2 분기가 작동하는지

### 9) 최종 보고

다음을 한 번에 묶어 보고한다.

- 가동 중인 컨테이너 목록
- 각 smoke test 항목 a~g 의 통과/실패 + 핵심 출력 1줄
- `make pipeline-status` 결과
- 다음 24시간 동안 운영자가 주시해야 할 지표 (예: claude-parser 의
  daily_pdf_processed, batch-runner 의 cost_log 누적, papers_excluded 비율 등)
- 발견한 이상 / 의심 항목 (아무리 사소해도)

## 안전 규칙

- `git push --force` / `git rebase main` / `git reset --hard origin/main` 절대 금지
- DB DROP / TRUNCATE 절대 금지
- `.env` 의 시크릿을 로그/보고에 출력 금지 (키 이름만)
- ANTHROPIC_API_KEY 가 없으면 claude-parser 컨테이너는 의도적으로 기동 실패함
  → 사용자에게 키 요청 후 해당 컨테이너만 재기동
- 빌드/마이그레이션 중 어느 단계든 실패하면 멈추고 (1) 단계의 baseline 으로 돌아갈
  방법을 함께 제시한 뒤 사용자 승인 받아 진행

## 참고 문서

- `CLAUDE.md` (프로젝트 루트) — v2 5-Layer 개요
- `docs/UPGRADE-V2.md` — v1 → v2 업그레이드 절차 상세
- `docs/RUNBOOK.md` — 처음 30분 운영 체크리스트
- `docs/PDF-PIPELINE.md` — PDF + Batch + 비용 가드 설계
- `PAPER_SYSTEM_ARCHITECTURE.md` — 5-Layer 파이프라인 사양
