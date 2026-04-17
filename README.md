# 📚 반도체 소재 논문 지능형 색인 & RAG 검색 시스템

Gemini (멀티모달/임베딩) + PostgreSQL + pgvector + n8n 으로 매일 300 편 규모의 논문을 자동 수집·요약·분류·색인하고, Claude Desktop 에서 자연어로 검색하는 개인용 리서치 파이프라인입니다.

```
                 ┌────────────┐
                 │   n8n      │  (매일 06:00 cron, Split in Batches + Wait)
                 └─────┬──────┘
                       │ keywords × 3 sources (arXiv / Semantic Scholar / ChemRxiv)
                       ▼
               ┌─────────────────┐
               │  ingest API     │ ─▶ Gemini Flash 분석(JSON)
               │  (Express 8787) │ ─▶ text-embedding-004 (768 dim)
               └────────┬────────┘ ─▶ UPSERT (DOI 중복 방지)
                        │
                        ▼
             ┌──────────────────────┐
             │  PostgreSQL +         │   B-Tree(카테고리) + HNSW(cosine) 인덱스
             │  pgvector             │
             └───────────┬──────────┘
                         │
                         ▼
               ┌─────────────────┐
               │   MCP server    │  stdio
               └────────┬────────┘
                        │  (search_papers / get_paper / list_categories / recent_papers)
                        ▼
                Claude Desktop / Claude Web
```

---

## 🚀 빠른 시작

### 0. 필요한 것
- Docker Desktop (PostgreSQL 띄우기 용)
- Node.js 22 이상
- Gemini API 키 — https://aistudio.google.com/apikey
- (선택) Semantic Scholar API key — rate limit 여유 있게 받으려면

### 1. 환경 변수 세팅
```bash
cp .env.example .env
# .env 를 열어 GEMINI_API_KEY, INGEST_API_KEY 등을 채웁니다.
```

### 2. DB 기동
```bash
# 프로젝트 루트에서
docker compose up -d postgres
# → 5433 포트에 pgvector 확장이 활성화된 Postgres 16 이 뜹니다.
#   sql/init.sql 이 자동 실행되어 스키마가 만들어집니다.
```

확인:
```bash
docker compose exec postgres psql -U paperuser -d papers -c "\\dt"
```

### 3. Node 의존성 설치
```bash
npm install
```

### 4. Gemini 연결 테스트
```bash
npm run test:gemini
# 정상이면 JSON 분석 결과 + 768 차원 임베딩이 찍힙니다.
```

### 5. 소량 수집 테스트 (n8n 없이)
```bash
node scripts/collect-once.js "EUV photoresist resin" 10
```
→ 10 건이 DB 에 들어가면 OK.

### 6. Ingest API 서버 기동
```bash
npm run start:ingest
# http://localhost:8787/health 확인
```

### 7. 검색 테스트
```bash
node scripts/test-search.js "EUV 레지스트의 LER 를 낮추는 최근 접근법"
```

### 8. n8n 워크플로우 연결
- `n8n/workflow.json` 임포트.
- `Ingest API 호출` 노드의 URL, `INGEST_API_KEY` 확인.
- 수동으로 1회 실행(▶) 해서 확인 → Active 토글 on.
- 자세한 내용은 `n8n/README.md` 참조.

### 9. Claude Desktop 에 MCP 연결
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
또는 `%APPDATA%\Claude\claude_desktop_config.json` (Windows) 에 추가:

```json
{
  "mcpServers": {
    "paper-index": {
      "command": "node",
      "args": ["/절대/경로/논문색인/src/mcp-server.js"],
      "env": {
        "GEMINI_API_KEY": "sk-...",
        "PGHOST": "localhost",
        "PGPORT": "5433",
        "PGDATABASE": "papers",
        "PGUSER": "paperuser",
        "PGPASSWORD": "paperpass"
      }
    }
  }
}
```

Claude Desktop 재시작 → 입력창 좌측 플러그 아이콘에 `paper-index` 가 보이면 성공.

사용 예:
- “내 DB 에서 EUV 메탈옥사이드 레지스트의 LER 낮추는 논문 찾아줘.”
- “최근 7일 수집분에서 novelty 8점 이상인 레진 관련 논문 5개만 요약해줘.”

---

## 📂 폴더 구조
```
논문색인/
├─ docker-compose.yml          # pgvector 포함 Postgres
├─ package.json                # Node.js 22+
├─ .env.example                # 환경변수 템플릿
├─ sql/
│   └─ init.sql                # 테이블 + HNSW 인덱스
├─ config/
│   ├─ taxonomy.json           # 대분류 고정 + 중/소분류 예시
│   └─ keywords.json           # 수집 키워드 세트
├─ src/
│   ├─ lib/
│   │   ├─ db.js               # pg pool + vector 리터럴 변환
│   │   ├─ gemini.js           # Flash 분석(JSON) + 쿼리 재작성 + 답변 합성
│   │   ├─ embedding.js        # text-embedding-004 래퍼
│   │   ├─ config.js           # JSON 로더
│   │   └─ logger.js           # pino
│   ├─ sources/
│   │   ├─ arxiv.js
│   │   ├─ semantic-scholar.js
│   │   ├─ chemrxiv.js
│   │   └─ index.js            # 3 소스 통합 검색 + 중복 제거
│   ├─ ingest.js               # /ingest/batch, /ingest/run-daily (Express)
│   ├─ search.js               # 시멘틱 검색 + 답변 합성
│   └─ mcp-server.js           # Claude 용 MCP 서버
├─ n8n/
│   ├─ workflow.json           # Split in Batches + Wait 포함
│   └─ README.md
└─ scripts/
    ├─ db-init.js              # init.sql 수동 실행
    ├─ test-gemini.js
    ├─ test-search.js
    └─ collect-once.js         # n8n 없이 단일 실행
```

---

## 🧠 설계 메모

### 분류 전략 — 하이브리드
- **대분류(major)** 는 `config/taxonomy.json` 에 고정: `resin / pr / develop_etch / litho / metrology / misc_semi / novel_idea`.
- **중/소분류(mid/sub)** 는 Gemini 가 우선 taxonomy 내 예시에서 선택하되, 분명히 맞지 않으면 새 라벨 제안.
- `categories` 테이블에 사용 횟수 누적. 주기적으로 유사 라벨 머지 스크립트 실행 예정 (추후 확장).

### 수집 전략 — 하이브리드
- **primary 키워드(고정, 가중치 10~6)**: photoresist resin, EUV photoresist, chemically amplified resist, …
- **secondary 키워드(가중치 5~3)**: dry etch selectivity, molecular glass resist, DSA lithography, …
- **fresh_probe**: 최근 14 일 내 ‘novel photoresist’ 등 광각 쿼리 → novelty_score 로 필터.
- DB 에서 `(doi / arxiv_id / source+source_id)` 순으로 중복 제거.

### 비용/속도 — Flash 단독
- `gemini-2.5-flash` + `text-embedding-004` 기본.
- 300 편/일 기준 API 비용 월 약 $10~20 수준 (토큰 사용량에 따라).
- 동시성 `GEMINI_CONCURRENCY=3`, 최소 간격 400ms → 429 회피.

### 검색 성능
- HNSW 코사인 인덱스 (`m=16, ef_construction=64`).
- 질의 시 `ef_search=100` 로 정확도 ↑.
- 대분류 B-Tree 필터 → 벡터 검색 공간 대폭 축소.

### 에러 핸들링
- Gemini 호출: 429/503/네트워크 오류만 지수 백오프 재시도 (최대 4 회).
- JSON 파싱 실패 시 해당 논문만 실패 처리, 다음 논문은 계속.
- 모든 수집 run 은 `ingestion_log` 테이블에 `error_samples` (최대 5 건) 로 남김.

---

## 🔧 자주 쓰는 명령
```bash
npm run start:ingest      # Express API 기동
npm run start:search      # (단독 실행 필요 시)
npm run start:mcp         # MCP 서버 (보통은 Claude 가 대신 실행)
npm run db:init           # init.sql 수동 실행
npm run test:gemini       # Gemini 스모크 테스트
npm run test:search       # 검색 스모크 테스트

node scripts/collect-once.js "photoresist LER" 20
```

---

## 🛠 트러블슈팅

| 증상 | 원인/해결 |
|---|---|
| `extension "vector" is not available` | `pgvector/pgvector:pg16` 이미지 쓰는지 확인. 일반 `postgres` 이미지엔 pgvector 없음. |
| Gemini 429 | `GEMINI_CONCURRENCY=2`, `GEMINI_MIN_INTERVAL_MS=800` 으로 내려보세요. |
| Claude Desktop 에서 MCP 가 안 보임 | `claude_desktop_config.json` 의 절대경로 확인 → Claude 완전 종료 후 재시작. |
| 검색은 되는데 답변이 비어 있음 | snippets 는 있는데 `synthesizeAnswer` 가 실패한 경우. 로그 확인. |
| “논문이 없습니다”만 나옴 | `scripts/collect-once.js` 로 먼저 DB 에 데이터가 들어갔는지 확인. |

---

## 🗺 다음 단계(선택)
- PDF 본문 인제스트 (현재는 메타+초록만, `pdf-parse` + Gemini 멀티모달로 확장 가능).
- 카테고리 머지 크론 (`categories.usage_count` 낮은 라벨 병합).
- 주간 리포트 (MCP 에 `weekly_digest` 툴 추가).
- Claude 가 새 키워드를 제안하도록 feedback loop.
