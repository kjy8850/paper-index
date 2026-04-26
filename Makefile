# =====================================================================
# 자주 쓰는 명령 모음. Claude Code 에서 `make <타깃>` 또는 직접 실행.
# 기본 목표: make help
# =====================================================================

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# --------- 변수 (환경에 맞게 .env 에서 override 가능) ---------
NAS_IP       ?= 192.168.100.253
NAS_REMOTE   ?= /volume1/docker/papers-pg
NAS_MOUNT    ?= /mnt/nas-papers-pg
NAS_SSH_HOST ?= nas-papers
NAS_BASE     ?= /volume1/docker/papers-pg
MINIPC_COMPOSE := docker-compose.minipc.yml

# 사용자 파라미터 (예: make collect-once Q="EUV PR" N=10)
Q ?= EUV photoresist resin
N ?= 10

# 색상
C_G := \033[0;32m
C_Y := \033[0;33m
C_0 := \033[0m

help: ## 사용 가능한 타깃 표시
	@echo "사용법: make <타깃>  [Q=\"쿼리\"] [N=건수]"
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  $(C_G)%-22s$(C_0) %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# =====================================================================
# 미니PC 초기 셋업
# =====================================================================
bootstrap: ## 미니PC 부트스트랩 (Docker/Node/Claude Code/NFS)
	./scripts/bootstrap-minipc.sh

env: ## .env 템플릿 복사 (없으면 생성)
	@test -f .env || (cp .env.minipc.example .env && echo "$(C_Y)[!] .env 생성됨. 값 채워주세요.$(C_0)")
	@test -f .env.nas || (cp .env.nas.example .env.nas && echo "$(C_Y)[!] .env.nas 생성됨. 값 채워주세요.$(C_0)")

install: deps ## npm 의존성 설치 (alias of deps)

deps: ## npm 의존성 설치
	npm install --no-audit --no-fund

# =====================================================================
# NAS — 최초 부트스트랩 & 동기화
# =====================================================================
nas-check: ## NFS/SSH 연결 상태 점검
	@echo "▶ SSH ($(NAS_SSH_HOST))"
	@ssh -o BatchMode=yes -o ConnectTimeout=5 $(NAS_SSH_HOST) "echo '  [OK] ssh'" \
	   || echo "$(C_Y)  [X] ssh 실패. ~/.ssh/config 확인.$(C_0)"
	@echo "▶ NFS exports ($(NAS_IP))"
	@showmount -e $(NAS_IP) 2>/dev/null || echo "$(C_Y)  [X] NFS 조회 실패. showmount 설치 혹은 NFS 서비스 확인.$(C_0)"
	@echo "▶ NFS mount ($(NAS_MOUNT))"
	@mountpoint -q $(NAS_MOUNT) && echo "  [OK] mounted" || echo "$(C_Y)  [i] 마운트 안 됨. 'make nas-mount' 혹은 SSH 경로 사용.$(C_0)"

nas-bootstrap: ## SSH 경유 NAS 최초 셋업 (Postgres 컨테이너 기동까지)
	./scripts/nas-bootstrap.sh

nas-mount: ## NAS NFS 공유폴더 마운트 (일회성)
	./scripts/mount-nas.sh $(NAS_IP) $(NAS_REMOTE) $(NAS_MOUNT)

nas-mount-persist: ## NAS NFS 마운트 + /etc/fstab 등록
	./scripts/mount-nas.sh $(NAS_IP) $(NAS_REMOTE) $(NAS_MOUNT) --persist

nas-umount: ## NAS 마운트 해제
	sudo umount $(NAS_MOUNT)

nas-sync: ## NAS 로 필요한 파일만 rsync (NFS 우선)
	NAS_MOUNT=$(NAS_MOUNT) ./scripts/sync-to-nas.sh

nas-sync-dry: ## NAS 동기화 시뮬레이션 (dry-run)
	DRY_RUN=1 NAS_MOUNT=$(NAS_MOUNT) ./scripts/sync-to-nas.sh

# =====================================================================
# NAS — 컨테이너/DB 운영 (모두 SSH 경유)
# =====================================================================
nas-up: ## NAS Postgres 기동
	ssh $(NAS_SSH_HOST) "cd $(NAS_BASE) && sudo docker compose up -d"

nas-down: ## NAS Postgres 정지
	ssh $(NAS_SSH_HOST) "cd $(NAS_BASE) && sudo docker compose down"

nas-restart: ## NAS Postgres 재기동
	ssh $(NAS_SSH_HOST) "cd $(NAS_BASE) && sudo docker compose restart"

nas-ps: ## NAS 컨테이너 상태
	ssh $(NAS_SSH_HOST) "sudo docker ps --filter name=paper-postgres --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

nas-logs: ## NAS Postgres 로그 (마지막 200줄)
	ssh $(NAS_SSH_HOST) "sudo docker logs --tail=200 -f paper-postgres"

nas-psql: ## NAS Postgres 로 psql 접속
	./scripts/nas-psql.sh

nas-count: ## DB 논문 수 확인
	./scripts/nas-psql.sh "SELECT COUNT(*) AS total FROM research_papers;"

nas-reindex: ## HNSW 벡터 인덱스 REINDEX (월간 유지보수)
	./scripts/nas-psql.sh "REINDEX INDEX CONCURRENTLY idx_research_papers_embedding;"

# =====================================================================
# 미니PC 컨테이너 운영
# =====================================================================
up: ## 미니PC 컨테이너 전체 기동 (n8n + ingest + pdf-worker + batch-runner + scheduler)
	docker compose -f $(MINIPC_COMPOSE) up -d --build

up-mcp: ## + MCP HTTP 컨테이너까지 기동
	docker compose -f $(MINIPC_COMPOSE) --profile mcp-http up -d --build

down: ## 미니PC 컨테이너 정지
	docker compose -f $(MINIPC_COMPOSE) down

restart: ## 미니PC 컨테이너 재기동
	docker compose -f $(MINIPC_COMPOSE) restart

logs: ## 실시간 로그 (모든 서비스)
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=200

logs-ingest: ## ingest 로그만
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=200 ingest

logs-n8n: ## n8n 로그만
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=200 n8n

ps: ## 컨테이너 상태
	docker compose -f $(MINIPC_COMPOSE) ps

health: ## ingest 헬스체크
	@curl -sf http://localhost:8787/health && echo "" || echo "$(C_Y)[!] ingest 안 붙음$(C_0)"

# =====================================================================
# 테스트·디버깅
# =====================================================================
test-gemini: ## Gemini 스모크 테스트 (로컬 node 로 실행)
	node scripts/test-gemini.js

test-search: ## 검색 스모크 테스트 — Q="질문" 로 덮어쓰기 가능
	node scripts/test-search.js "$(Q)"

collect-once: ## Q 쿼리로 N건 수집·색인 (기본: EUV photoresist resin, 10)
	node scripts/collect-once.js "$(Q)" $(N)

test-pdf-worker: ## pdf-worker 드라이런 단건 테스트 (ID=<paper_id>)
	node --env-file=.env scripts/test-pdf-worker.js --id $(ID)

# =====================================================================
# 운영 관찰 (DB 상태)
# =====================================================================
stats: ## 일자별 수집 통계
	./scripts/nas-psql.sh "SELECT day, source, ingested, failed FROM v_daily_ingestion ORDER BY day DESC LIMIT 14;"

errors: ## 최근 수집 실패 샘플 10건
	./scripts/nas-psql.sh "SELECT ts, source, query, jsonb_pretty(error_samples) FROM ingestion_log WHERE failed > 0 ORDER BY ts DESC LIMIT 10;"

recent: ## 최근 24시간 수집된 논문
	./scripts/nas-psql.sh "SELECT LEFT(title,70) AS title, source, published_at, created_at FROM research_papers WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 30;"

# =====================================================================
# 일일/주간 운영
# =====================================================================
daily-trigger: ## 수동으로 하루치 수집 트리거
	@curl -sf -X POST http://localhost:8787/ingest/run-daily \
	  -H "x-api-key: $$(grep INGEST_API_KEY .env | cut -d= -f2)" | jq .

# =====================================================================
# PDF 파이프라인 운영 (Phase 4-7)
# =====================================================================
pdf-stats: ## fulltext_status 분포 + 배치 잡 현황
	docker exec batch-runner python -m batch_runner status

pdf-retry-failed: ## failed 상태 papers_staging 을 pending으로 되돌려 재시도
	./scripts/nas-psql.sh "UPDATE papers_staging SET fulltext_status='pending', fulltext_error=NULL WHERE fulltext_status='failed';"

batch-now: ## 즉시 enqueue + submit (배치 수동 제출)
	docker exec batch-runner python -m batch_runner enqueue && \
	docker exec batch-runner python -m batch_runner submit

batch-poll: ## 배치 상태 폴링 + 완료분 DB 반영
	docker exec batch-runner python -m batch_runner poll && \
	docker exec batch-runner python -m batch_runner apply

cost-today: ## 오늘 Gemini 비용 조회
	./scripts/nas-psql.sh "SELECT * FROM v_today_cost;"

cost-history: ## 최근 14일 일별 비용
	./scripts/nas-psql.sh "SELECT DATE(ts) AS day, model, SUM(cost_usd) AS cost_usd, SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok, COUNT(*) AS calls FROM api_usage GROUP BY 1,2 ORDER BY 1 DESC LIMIT 28;"

logs-batch: ## batch-runner 로그
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=100 batch-runner

logs-scheduler: ## ofelia 스케줄러 로그
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=100 scheduler

# =====================================================================
# v2 — 5-Layer Pipeline 운영
# =====================================================================
migrate: ## sql/migrations/*.sql 적용 (idempotent)
	node scripts/migrate.js

migrate-status: ## 마이그레이션 적용 현황
	node scripts/migrate.js --status

migrate-dry: ## 마이그레이션 dry-run (어떤 파일이 적용될지)
	node scripts/migrate.js --dry

phase-status: ## ingest /api/status 한 번 호출 + 정리
	@curl -sf http://localhost:8787/api/status | jq '{phase:.phaseState,papers:.papers,cost:.cost.spent_usd}'

phase1-trigger: ## 한 번 강제로 Phase 1 호출 (디버깅용)
	@curl -sf -X POST http://localhost:8787/ingest/run-phase \
	  -H "x-api-key: $$(grep INGEST_API_KEY .env | cut -d= -f2)" \
	  -H "Content-Type: application/json" \
	  -d '{"phase":"phase1","maxBudgetMs":60000,"maxIterations":12}' | jq .

phase2-trigger: ## 한 번 강제로 Phase 2 호출
	@curl -sf -X POST http://localhost:8787/ingest/run-phase \
	  -H "x-api-key: $$(grep INGEST_API_KEY .env | cut -d= -f2)" \
	  -H "Content-Type: application/json" \
	  -d '{"phase":"phase2"}' | jq .

phase1-complete: ## Phase 1 종료 강제 (수동)
	@curl -sf -X POST http://localhost:8787/ingest/phase1/complete \
	  -H "x-api-key: $$(grep INGEST_API_KEY .env | cut -d= -f2)" | jq .

backfill-dry: ## 200건 backfill 후보 카운트만
	node scripts/backfill-parse.js --dry

backfill: ## 200건 backfill 큐잉 (Phase 1 완료 후 사용)
	node scripts/backfill-parse.js --enqueue

backfill-status: ## backfill 진행률
	node scripts/backfill-parse.js --status

backfill-reset: ## 큐잉했던 backfill 원복 (실수 복구)
	node scripts/backfill-parse.js --reset

claude-parser-up: ## claude-parser 단독 기동
	docker compose -f $(MINIPC_COMPOSE) up -d --build claude-parser

claude-parser-logs: ## claude-parser 로그
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=200 claude-parser

claude-parser-restart: ## claude-parser 재기동
	docker compose -f $(MINIPC_COMPOSE) restart claude-parser

pipeline-status: ## v_pipeline_status 보기
	./scripts/nas-psql.sh "SELECT * FROM v_pipeline_status;"

layer4-today: ## Layer 4 오늘 처리량/비용
	./scripts/nas-psql.sh "SELECT * FROM v_layer4_today;"

cost-today-v2: ## v_daily_cost (Gemini + Claude)
	./scripts/nas-psql.sh "SELECT * FROM v_daily_cost ORDER BY day DESC LIMIT 7;"

excluded-recent: ## 최근 24h 내 papers_excluded 샘플
	./scripts/nas-psql.sh "SELECT excluded_at, excluded_layer, excluded_reason, LEFT(COALESCE(title_normalized,'-'),60) AS title FROM papers_excluded WHERE excluded_at > now() - interval '24 hours' ORDER BY excluded_at DESC LIMIT 20;"

# =====================================================================
# Layer 5 — Publisher (papers_parsed → research_papers + embedding)
# =====================================================================
publisher-up: ## publisher 단독 기동
	docker compose -f $(MINIPC_COMPOSE) up -d --build publisher

publisher-logs: ## publisher 로그
	docker compose -f $(MINIPC_COMPOSE) logs -f --tail=200 publisher

publisher-restart: ## publisher 재기동
	docker compose -f $(MINIPC_COMPOSE) restart publisher

publish-pending: ## publish 대기/완료 분포
	./scripts/nas-psql.sh "SELECT * FROM v_publisher_summary;"

publish-recent: ## 최근 publish 된 research_papers 10건
	./scripts/nas-psql.sh "SELECT id, staging_id, LEFT(title,70) AS title, major_category, published_v2_at FROM research_papers WHERE published_v2_at IS NOT NULL ORDER BY published_v2_at DESC LIMIT 10;"

# =====================================================================
# 운영 보강 — 잠금 자동 복구
# =====================================================================
recover-stuck: ## parsing/pdf_running 으로 30분 이상 갇힌 행을 원위치
	./scripts/nas-psql.sh "SELECT * FROM recover_stuck_staging(30);"

.PHONY: help bootstrap env install deps \
        nas-check nas-bootstrap nas-mount nas-mount-persist nas-umount nas-sync nas-sync-dry \
        nas-up nas-down nas-restart nas-ps nas-logs nas-psql nas-count nas-reindex \
        up up-mcp down restart logs logs-ingest logs-n8n ps health \
        test-gemini test-search collect-once stats errors recent daily-trigger \
        pdf-stats pdf-retry-failed batch-now batch-poll cost-today cost-history \
        logs-batch logs-scheduler \
        migrate migrate-status migrate-dry phase-status \
        phase1-trigger phase2-trigger phase1-complete \
        backfill-dry backfill backfill-status backfill-reset \
        claude-parser-up claude-parser-logs claude-parser-restart \
        pipeline-status layer4-today cost-today-v2 excluded-recent \
        publisher-up publisher-logs publisher-restart publish-pending publish-recent \
        recover-stuck
