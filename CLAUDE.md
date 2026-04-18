# CLAUDE.md — 이 저장소의 컨텍스트

이 파일은 Claude Code 가 프로젝트에 들어오자마자 읽는 안내문입니다. 구조·관례·자주 하는 실수를 요약합니다.

## 프로젝트 한 줄 요약
반도체 소재(특히 포토레지스트) 논문을 매일 300편 수집 → Gemini Flash 로 분석·요약·분류 → PostgreSQL+pgvector 에 768-dim 임베딩 저장 → MCP 서버로 Claude 에서 자연어 검색.

## 배포 구성 (중요)
이 저장소는 **하이브리드 배포**가 기본입니다.

- **미니PC (Ubuntu 24.04, N150)** : n8n + Node ingest API + (선택) MCP HTTP 컨테이너. **Claude Code 는 여기서 실행됨.**
- **NAS (Synology DS918+)** : PostgreSQL 16 + pgvector 만. `/volume1/docker/papers-pg` 가 NFS 로 미니PC `/mnt/nas-papers-pg` 에 마운트됨.
- **동기화**: 필요한 파일만 rsync 로 NAS 쪽 마운트포인트에 밀어넣음 (`make nas-sync`). NAS 에는 Node 코드·node_modules 를 보내지 않음.

## 폴더 구조
```
src/
  lib/       공통 라이브러리 (db, gemini, embedding, logger, config)
  sources/   논문 소스 어댑터 (arxiv, semantic-scholar, chemrxiv)
  ingest.js  Express 수집·분석·저장 API (포트 8787)
  search.js  시멘틱 검색 핵심 (CLI 단독 실행 가능)
  mcp-server.js  Claude Desktop 용 stdio MCP
  mcp-http.js    Claude Web Custom Connector 용 HTTP MCP (선택)

sql/init.sql        스키마 + HNSW 인덱스 (NAS 에 배포됨)
config/             taxonomy.json, keywords.json
n8n/workflow.json   Split in Batches + Wait 포함
scripts/            부트스트랩·동기화·테스트 스크립트
docs/               배포 가이드
Dockerfile          Node 앱 (미니PC 전용)
docker-compose.nas.yml       NAS 전용
docker-compose.minipc.yml    미니PC 전용 (n8n + ingest [+ mcp-http])
docker-compose.yml           단일 머신 테스트용 (하이브리드에선 안 씀)
Makefile            자주 쓰는 명령 모음
```

## 중요 관례

### 1. ES 모듈
- `package.json` 에 `"type": "module"`. **CommonJS `require` 금지.** 모두 `import`.

### 2. 환경변수
- **`.env` 를 절대 커밋 금지.** `.env.nas.example`, `.env.minipc.example` 만 저장소 포함.
- 코드는 `process.env.X` 로만 읽음. 하드코딩된 시크릿 금지.

### 3. pgvector 저장
- 벡터는 `vector(768)` 컬럼. JS → SQL 삽입 시 `toVectorLiteral()` 로 `[0.1,0.2,...]` 문자열 만들고 `$N::vector` 캐스팅.
- 임베딩 모델: `text-embedding-004` (Gemini). 차원 바꾸면 DDL 과 인덱스까지 재생성 필요.

### 4. Gemini 호출
- 분석은 반드시 `responseSchema` 가 설정된 `src/lib/gemini.js` 의 `analyzePaper()` 경유. JSON 파싱 실패를 막기 위해서.
- 동시성은 `p-limit` + 최소 간격으로 제어. 새 호출 지점이 생기면 같은 `limit` 공유.

### 5. 에러 핸들링
- 대량 루프(수집·분석)에서 **한 건 실패로 전체 중단 금지.** `Promise.allSettled` 또는 try/catch 개별 처리.
- 실패 내용은 `ingestion_log.error_samples` 에 최대 5건 저장.

### 6. 로그
- `src/lib/logger.js` 의 pino 사용. `console.log` 지양.
- 민감 정보(API 키, password) 로그에 남기지 않기.

## 자주 쓰는 명령
- `make help` — 전체 타깃 목록
- `make nas-sync` — NAS 에 최신 파일 반영
- `make up` — 미니PC 컨테이너 기동
- `make logs-ingest` — ingest 로그 추적
- `make test-gemini` — Gemini 키·모델 동작 확인
- `make collect-once` — 10건만 빠르게 색인 (파이프라인 smoke test)
- `make nas-psql` — NAS Postgres 에 바로 psql

## 변경 시 체크리스트
1. **스키마 변경?** → `sql/init.sql` 수정 + migration 스크립트 추가 + `make nas-sync` 로 NAS 반영 (운영 중이면 수동 ALTER).
2. **새 소스 추가?** → `src/sources/<name>.js` + `src/sources/index.js` 의 `searchAll` 에 합류.
3. **분석 스키마 바꿨음?** → `src/lib/gemini.js` `paperAnalysisSchema` + `sanitizeAnalysis` + DB 컬럼까지 함께.
4. **새 MCP 툴 추가?** → `mcp-server.js` 와 `mcp-http.js` **양쪽**에 등록 (stdio/HTTP 둘 다 쓰는 중).
5. **비용·레이트 문제?** → `.env` 의 `GEMINI_CONCURRENCY`, `GEMINI_MIN_INTERVAL_MS` 부터 조정. 코드 고치기 전.

## 하지 말 것
- `docker-compose.yml` (루트의 단일머신 버전)을 하이브리드 환경에서 up 하지 말 것. 충돌 원인.
- NAS 쪽 `.env` 를 예시값 그대로 두지 말 것. `PGPASSWORD` 는 반드시 강한 랜덤값.
- Postgres 5432 포트를 외부 인터넷에 노출하지 말 것. LAN 서브넷에만.
- stdio MCP 서버 (`src/mcp-server.js`) 를 도커 컨테이너 안에서 실행하려 하지 말 것. Claude Desktop 이 직접 자식프로세스로 띄우는 구조라 의미 없음.

## 참고 문서
- `README.md` — 개괄 + 단일머신 옵션
- `docs/DEPLOY-HYBRID.md` — 상세 하이브리드 가이드 (여러 옵션)
- `docs/RUNBOOK.md` — Ubuntu + NFS + 린 NAS 에 특화된 "처음 30분" 체크리스트
- `docs/PDF-PIPELINE.md` — Docling + Gemini Batch API + 일일 $1 비용 가드 (Phase 1~8 실행 가이드)
- `n8n/README.md` — 워크플로 임포트·수정법
