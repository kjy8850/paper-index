# UPGRADE-V2 — v1 → v2 (5-Layer Pipeline) 마이그레이션 가이드

## 1. 변경 요약
| 영역 | v1 | v2 |
|---|---|---|
| 분석 흐름 | Gemini Flash 단일 호출이 모든 분석·요약 | Gemini Flash 는 **abstract 만 보고 yes/no/unsure + 타입** 분류, 본문 추출은 **Claude Sonnet 4.6** 가 담당 |
| 수집 | 3 소스 (S2, arXiv, ChemRxiv) | **+ OpenAlex** (총 4 소스, polite-pool mailto) |
| 중복제거 | doi/arxiv_id/source key 메모리 set | **메모리(doi > arxiv_id > title_normalized) + DB 3-table (history+excluded+staging) 동시 조회** |
| 적재 | research_papers 에 직접 INSERT | **papers_staging** 큐 → Layer 2/3/4 가 단계적으로 진행 |
| 운영 상태 | env / 코드 상수 | **system_config (KV 테이블)** + `getConfig/setConfig` 헬퍼 |
| 일일 한도 | 없음 | `daily_pdf_limit` (기본 10) — Claude PDF 직접 모드 비용 가드 |
| n8n | 키워드 하드코딩 + XML 정규식 파서 | **단순 Cron → POST /ingest/run-phase** (모든 분기 ingest 가 처리) |

자세한 사양은 `PAPER_SYSTEM_ARCHITECTURE.md` 참고.

## 2. 사전 준비 (10 분)
1. `.env.minipc` 또는 `.env` 에 다음 신규 키 설정:
   ```env
   ANTHROPIC_API_KEY=...
   CLAUDE_MODEL=claude-sonnet-4-6
   OPENALEX_EMAIL=almexf88@gmail.com
   DAILY_PDF_LIMIT=10
   PHASE1_DAILY_TARGET=300
   PHASE1_TIMEOUT_HOURS=20
   PHASE1_MIN_BATCH=50
   PHASE2_DAYS_WINDOW=14
   TZ=Asia/Seoul
   ```
2. `make deps` — package.json 신규 의존성(`@anthropic-ai/sdk`) 동기화.
3. `make nas-sync` — NAS 마운트로 SQL/스크립트 반영.

## 3. DB 마이그레이션
```bash
# 어떤 마이그레이션이 적용될지 미리보기
make migrate-dry

# 실제 적용 (idempotent — 여러 번 실행해도 안전)
make migrate

# 적용 현황
make migrate-status
```
- 신규 테이블: `papers_staging`, `papers_history`, `papers_excluded`, `papers_scored`, `papers_parsed`, `composition_data`, `reaction_conditions`, `system_config`, `cost_log`.
- 신규 뷰: `v_daily_cost`, `v_pipeline_status`, `v_layer4_today`.
- `ingestion_log` 에 `phase`, `staged`, `excluded_dedup` 컬럼 추가.
- 기존 `research_papers` / `api_usage` / `batch_jobs` 는 **건드리지 않음**.

## 4. 컨테이너 기동
```bash
make up                # n8n + ingest + pdf-worker + claude-parser + publisher + batch-runner + docling-svc + scheduler
make ps                # 상태 확인
make health            # ingest /health
make publisher-up      # publisher 단독 기동(다른 워커는 그대로)
```

> Layer 5 publisher 가 안 돌면 `papers_parsed` 가 채워져도 `research_papers` 로 publish 되지 않아 시멘틱 검색에서 새 논문이 보이지 않음. 반드시 함께 기동.

## 5. n8n 워크플로 교체
1. n8n UI → Workflows → 기존 “Paper Daily Collect & Ingest” 비활성화
2. 우상단 ⋯ → Import → `n8n/workflow.json` 선택
3. 새 워크플로 “Paper Index v2” 활성화
4. `INGEST_BASE_URL`, `INGEST_API_KEY` 환경변수가 컨테이너에 들어있는지 확인

## 6. Phase 1 시작
```bash
# 한 번 강제 호출 (정상 동작 확인용)
make phase1-trigger

# 진행 상황
make phase-status
make pipeline-status
```
- 30 분마다 n8n 이 자동 호출. ingest 가 자체적으로 cursor 와 collectedToday 를 system_config 에 보존.
- 누적 300 건 도달 또는 20 시간 경과 + 마지막 sweep < 50 건이면 자동 `phase1_completed=true`.

## 7. Phase 1 완료 후 — 200 건 backfill
```bash
make backfill-status  # 큐잉 후보 카운트
make backfill-dry     # 샘플 보기
make backfill         # 실제로 'queued' 로 전환 → claude-parser 가 픽업
make backfill-status  # 진행률
```
- 큐잉된 행은 `papers_staging.fulltext_status='queued'`, `fulltext_error LIKE 'backfill%'`.
- 잘못 큐잉했으면 `make backfill-reset` 으로 원복.

## 8. 운영 모니터링
- `http://<미니PC IP>:8787/dashboard` — 대시보드 (실패 배너 + 비용 + 배치 잡)
- `make pipeline-status` — `papers_staging.fulltext_status` 분포
- `make layer4-today` — Claude Sonnet 일일 처리량 + 비용
- `make cost-today-v2` — Gemini + Claude 합산 비용
- `make excluded-recent` — 최근 24h 제외된 논문 샘플
- `make claude-parser-logs` / `make publisher-logs` — 워커 로그
- `make publish-pending` — Layer 5 publish 대기 분포 (new/update/up_to_date)
- `make publish-recent` — 최근 publish 된 research_papers 샘플
- `make recover-stuck` — parsing/pdf_running 으로 30분+ 갇힌 행 자동 복구 (n8n 시간단위로 호출 권장)

## 9. 롤백 절차
1. n8n: v1 워크플로 다시 활성화, v2 비활성화
2. claude-parser 컨테이너 중지: `docker compose -f docker-compose.minipc.yml stop claude-parser`
3. ingest 컨테이너는 그대로 두되, n8n 이 호출하는 엔드포인트만 `/ingest/run-daily` (호환 유지) 로 돌려놓기
4. **DB 는 건드리지 않음.** 신규 테이블은 그대로 둬도 v1 동작에 영향 없음.

## 10. 자주 묻는 질문
**Q. Claude API 키 없이 돌릴 수 있나?**
A. Layer 1/2/3 까지는 가능. claude-parser 컨테이너만 끄세요. `papers_staging` 이 `md_ready` 에서 누적되면 키 등록 후 다시 띄울 때 자연 처리됨.

**Q. PDF 직접 모드는 정말 비싼가?**
A. 1건당 약 $0.05 ~ $0.12. `DAILY_PDF_LIMIT=10` 이면 일 최대 ~$1.2.

**Q. Gemini 가 unsure 라고 한 건 어떻게 처리되나?**
A. `papers_scored.relevance='unsure'` 로 남고 Layer 4 가 full text 보고 yes/no 재판정. 결과가 'no' 면 `papers_excluded` 에 layer4 표시로 들어감.

**Q. 동일 논문이 여러 소스에서 잡히면?**
A. 메모리 dedupe 단계에서 doi/arxiv_id/title_normalized 우선순위로 1건만 살아남음. 그 후 DB 3-테이블 조회로 한 번 더 차단.

**Q. Phase 1 도중 미니PC 가 재부팅되면?**
A. 안전합니다. cursor 와 collectedToday 가 `system_config` 에 영속화되어 있어 다음 호출에서 그대로 이어짐.
