# 반도체 소재 논문 지능형 시스템 — 전체 아키텍처 기획서

> **목적**: 이 문서는 Claude Cowork에 전달하기 위한 시스템 설계 기획서입니다.
> 기존 시스템을 기반으로 수정/추가할 내용을 포함합니다.
> 코드 작성 전 반드시 이 문서를 전체 숙지하세요.

---

## 1. 시스템 개요

반도체 소재(EUV/DUV Photoresist, Resin 등) 관련 논문을 자동 수집·분류·파싱하여
연구자가 세부 내용을 질문했을 때 **DB 기반으로 명확하게 답변**할 수 있는 수준의
구조화된 데이터베이스를 구축하는 시스템입니다.

### 핵심 철학
- AI가 필요 없는 작업(수집, 중복제거, 전처리)은 프로그램으로 처리
- Gemini Flash Batch = 저비용 대량 필터링
- Claude Sonnet = 고품질 Deep Parsing
- PDF는 절대 저장하지 않음 (메모리/임시 처리 후 폐기)

---

## 2. 기존 시스템 현황

### 현재 구축된 것
- `docling-svc`: IBM Docling 기반 PDF → Markdown 변환 서버 (Python)
- `pdf-worker`: DB 폴링 → PDF 다운로드 → docling-svc 전달 (Node.js)
- `batch-runner`: Gemini Batch API 연동 분석 워커 (Python)
- `ingest API`: 논문 수집 Express 서버 (Node.js)
- PostgreSQL 16 (pgvector, JSONB 포함)
- n8n 스케줄러

### 현재 데이터 상태
- batch_done: 200건 (상세 분석 완료)
- no_pdf: 127건 (초록만 분석)
- failed: 7건 (전처리 오류)

### 현재 인프라
- MiniPC (Ubuntu 24.04): 모든 API 서버 및 워커 (Docker 컨테이너)
- NAS (Synology): PostgreSQL 전용 서버 (NFS 마운트)
- 일일 API 비용 한도: $1.00 (cost_gate 적용 중)

---

## 3. 수정/추가 사항 요약

| 영역 | 기존 | 변경 |
|------|------|------|
| 수집 소스 | arXiv / Semantic Scholar / ChemRxiv | **OpenAlex 추가** |
| 중복 제거 | DOI 기준만 | DOI + 제목 정규화 + **3개 테이블 대조** |
| 수집 방식 | 단순 스케줄 | **Phase 1/2 분기 + 300건 루프** |
| 관련성 필터 | 없음 | **Gemini Flash 1차 판단 추가** |
| 제외 논문 관리 | 없음 | **papers_excluded 테이블 추가** |
| PDF 전처리 | Docling 유지 | 동일 유지 |
| Gemini 역할 | 전문 상세 분석 | **관련성 판단 + 분류만** |
| Claude 역할 | MCP 검색 답변 | **Deep Parser 추가** |
| Full text 분석 | Gemini Batch | **Claude Sonnet으로 변경** |
| DB 테이블 | 기존 유지 | **테이블 추가** (아래 명세 참고) |

---

## 4. 전체 레이어 구조

```
[LAYER 1] 수집 계층        → n8n + ingest API (Node.js)
[LAYER 2] 관련성 판단 계층  → Gemini Flash Batch
[LAYER 3] 전처리 계층      → Docling Pipeline (기존 유지)
[LAYER 4] Deep Parsing    → Claude Sonnet (신규)
[LAYER 5] 저장 & 서비스    → PostgreSQL + MCP + 대시보드
```

---

## 5. LAYER 1 — 수집 계층

### 담당
- n8n 스케줄러
- ingest API (Node.js, 기존 수정)

### 실행 주기
매일 00:00 자동 실행

### Phase 1 / Phase 2 분기

**오늘 날짜를 기준**으로 두 가지 모드로 동작합니다.
하나의 워크플로우 안에서 분기 처리합니다.

#### Phase 1 — 과거 논문 대량 수집
```
조건: system_config.phase1_completed = false
대상: 오늘 날짜 이전 논문 전체

[루프 시작]
  병렬 수집 (OpenAlex / Semantic Scholar / arXiv / ChemRxiv)
  날짜 필터: 오늘 이전
  cursor 기반 페이지네이션
        ↓
  필드 정규화
        ↓
  1차 중복 제거 (메모리)
        ↓
  2차 중복 제거 (DB 3개 테이블)
        ↓
  papers_staging INSERT
        ↓
  [체크 1] 오늘 누적 300건 달성?
    YES → 루프 종료 → Layer 2 트리거
        ↓ NO
  [체크 2] 20시간 경과?
    NO  → 루프 계속
        ↓ YES
  [체크 3] 신규 수집량 50건 미만?
    YES → phase1_completed = true → Layer 2 트리거
    NO  → 루프 종료 (내일 재시도)
[루프 종료]
```

- **하루 목표**: 300건
- **종료 조건**: 20시간 경과 후 신규 수집이 50건 미만이면 Phase 1 완료로 간주
- **50건 기준**은 실제 운영 후 튜닝 가능

#### Phase 2 — 신규 논문 수집
```
조건: system_config.phase1_completed = true
대상: 마지막 수집일 이후 신규 논문만

매일 1회 실행
신규 논문 수집 → 중복 제거 → papers_staging INSERT
→ Layer 2 트리거
```

### 수집 소스 (4개)

| 소스 | 방식 | 인증 | 특징 |
|------|------|------|------|
| OpenAlex | HTTP Request | 불필요 (email 파라미터 권장) | 가장 넓은 커버리지 |
| Semantic Scholar | HTTP Request | API key 권장 (무료) | 인용 정보 풍부 |
| arXiv | HTTP Request | 불필요 | 프리프린트, 최신 |
| ChemRxiv | HTTP Request | 불필요 | 화학 분야 특화 |

#### 검색 키워드 (공통 적용)
```
"photoresist resin EUV"
"photoresist composition semiconductor"
"EUV lithography material"
"photoresist development process"
"etching semiconductor pattern"
"EUV photoresist sensitivity"
"polymer resin photoresist synthesis"
"PAG photoacid generator resist"
```

#### API별 Rate Limit
- OpenAlex: 초당 10건 (email 파라미터 추가 시 우선순위 향상)
- Semantic Scholar: 초당 1건 (API key 없음) / 초당 10건 (API key 있음)
- arXiv: 3초당 1건 권장 (초과 시 일시 차단 가능)
- ChemRxiv: 초당 5건

### 필드 정규화

소스마다 필드명이 달라 아래 스키마로 통일:

```javascript
{
  doi: "10.xxxx/xxxxx" | null,
  arxiv_id: "2401.xxxxx" | null,  // arXiv 전용
  title: "원문 제목",
  title_normalized: "소문자+특수문자제거+공백정리",
  authors: ["저자1", "저자2"],
  year: 2024,
  abstract: "초록 텍스트",
  source: "openalex" | "semantic_scholar" | "arxiv" | "chemrxiv"
}
```

### 중복 제거 (2단계)

#### 1차 중복 제거 (메모리, DB 조회 전)
```
수집된 결과 내에서 제거:
  DOI가 있는 논문: DOI exact match → 첫 번째만 남김
  DOI가 없는 논문: title_normalized 100% 일치 → 제거

※ 유사도 비교(Levenshtein) 사용 안 함
  (반도체 논문은 제목 비슷해도 다른 논문인 경우 많음)
```

#### 2차 중복 제거 (PostgreSQL 3개 테이블 동시 IN 쿼리)
```
papers_history   → 파싱 완료된 논문
papers_excluded  → 관련 없음 판정된 논문
papers_staging   → 현재 처리 대기 중인 논문

세 테이블 모두 대조 후 신규만 통과
```

### papers_staging INSERT

```
PDF URL 있음 → fulltext_status = 'pending'
PDF URL 없음 → fulltext_status = 'no_pdf'
```

> **중요**: Layer 1에서는 PDF를 다운로드하거나 저장하지 않습니다.
> PDF URL 확인만 하고 상태값만 저장합니다.
> 실제 PDF 처리는 Layer 3 (Docling Pipeline)이 담당합니다.

---

## 6. LAYER 2 — 관련성 판단 계층

### 담당
- batch-runner (Python, 기존 수정)
- Gemini Flash Batch API

### 역할
- **abstract만** 입력으로 사용 (full text 불필요)
- 관련 있는 논문인지 1차 판단
- 논문 타입 분류
- **저비용 대량 처리** 목적

### 처리 흐름
```
papers_staging 전체 조회
abstract만 추출 (doi + abstract)
        ↓
Gemini Flash Batch API 전송
        ↓
Polling 5~10분 간격으로 완료 확인
        ↓
결과 처리
```

### Gemini 판단 기준 (프롬프트에 명시)

#### 관련 있음 (YES)
- EUV / DUV Photoresist 소재 연구
- Resin / Polymer 합성 및 조성
- PAG (광산발생제, Photoacid Generator) 관련
- PR 현상 (Development) 공정
- 에칭 (Etching) 공정
- PR 조성물 성능 연구 (감도/해상도/LER)
- 반도체 소재 합성 및 특성 연구

#### 관련 없음 (NO)
- 장비 설계 / 광학계
- 시뮬레이션 / 모델링만 다루는 논문
- PR과 무관한 반도체 공정
- 바이오 / 의료 분야 리소그래피
- 디스플레이용 PR

#### 모르겠음 (UNSURE)
- abstract만으로 판단하기 애매한 경우
- Layer 4에서 Claude가 full text 보고 최종 판단

### Gemini 출력 스키마
```json
{
  "doi": "10.xxxx/xxxxx",
  "relevance": "yes" | "no" | "unsure",
  "paper_type": "composition" | "reaction" | "process" | "other" | "unknown"
}
```

### 결과 처리
```
NO     → papers_excluded INSERT (excluded_reason: 'low_relevance')
         papers_staging DELETE
         종료

YES /  → papers_scored INSERT
UNSURE   papers_staging DELETE
         Layer 3 트리거
```

> **주의**: 관련성 기준은 운영 중 필요에 따라 변경될 수 있습니다.
> 프롬프트를 별도 설정 파일로 관리하여 코드 수정 없이 변경 가능하게 구성하세요.

---

## 7. LAYER 3 — 전처리 계층 (기존 유지)

### 담당
- pdf-worker (Node.js, 기존 유지)
- docling-svc (Python, 기존 유지)

### 역할
- PDF → Markdown 변환 (표, 수식, 그림 포함)
- **기존 코드 그대로 유지**, 상태값 체계만 통합

### 처리 흐름
```
papers_scored 조회
        ↓
fulltext_status 기준 분기

no_pdf →
  abstract만 메타데이터 저장
  fulltext_status = 'no_pdf_done'
  papers_history INSERT
  Layer 4 스킵 → 종료

pending →
  pdf-worker: Unpaywall API로 PDF URL 확인 → PDF 다운로드
        ↓
  docling-svc: PDF → Markdown 변환
        ↓
  fulltext_status = 'md_ready'
  → Layer 4 트리거
```

### 상태값 흐름 (전체)
```
pending      Layer 1: PDF URL 있음, 대기
no_pdf       Layer 1: PDF URL 없음
md_ready     Layer 3: Docling 변환 완료
queued       Layer 4: 일일 한도 초과, 다음날 이월
broken       Layer 4: Markdown 품질 불량 감지
failed       Layer 4: PDF 직접 투입 후에도 파싱 실패
batch_done   Layer 4: 파싱 완료
no_pdf_done  Layer 3: abstract만 저장 완료
```

---

## 8. LAYER 4 — Deep Parsing 계층 (신규)

### 담당
- Claude Sonnet API (신규 추가)
- 별도 워커 또는 batch-runner 확장

### 역할
- Markdown full text 기반 구조화 파싱
- 논문 타입별 세부 데이터 추출
- UNSURE 논문 관련성 최종 판단
- Markdown 품질 불량 시 PDF 직접 투입

### 일일 처리 한도

```
Markdown 파싱    → 0 카운트 (비용 미미)
PDF 직접 투입    → 1 카운트

daily_pdf_limit = 10건/일
(Claude Sonnet 기준 PDF 직접 투입 1건 ≈ $0.09)
(하루 $1.00 예산 기준 안전 마진 포함)

한도 초과 시 → fulltext_status = 'queued' (다음날 이월)
```

### 처리 우선순위
```
매일 00:00 시작 시:
  1순위: queued (전날 이월된 논문)
  2순위: md_ready (신규 논문)
```

### 처리 흐름

```
md_ready / queued 논문 조회
        ↓
[일일 한도 체크]
  초과분 → fulltext_status = 'queued' (내일로 이월)
  한도 내 논문만 진행
        ↓
Markdown full text → Claude에 전달
        ↓
[STEP 1: Markdown 품질 검증]

  OK →
    파싱 진행 (0 카운트)

  BROKEN →
    Unpaywall에서 PDF 재다운로드
    PDF 자체를 Claude에 직접 투입 (Markdown 없이)
    daily_pdf_processed += 1
        ↓
    파싱 성공 → 파싱 진행
    파싱 실패 → fulltext_status = 'failed'
                abstract만 메타데이터 저장
                papers_history INSERT
                종료
        ↓
[STEP 2: UNSURE 논문 최종 판단]

  relevance = 'unsure' 인 경우:
    Claude가 full text 보고 관련성 최종 판단
    NO  → papers_excluded INSERT → 종료
    YES → 아래 파싱 진행

        ↓
[STEP 3: 논문 타입별 구조화 파싱]
```

### 파싱 항목 상세

#### composition 논문 (PR 조성물)
```
수지 (Resin)
  - 종류 (monomer 구조)
  - 분자량 (Mn / Mw / PDI)
  - 함량 (mol% / wt%)

PAG (광산발생제, Photoacid Generator)
  - 종류
  - 함량 (wt%)
  - 투입 방법

용매 (Solvent)
  - 종류
  - 비율

첨가제
  - Quencher 종류 / 함량
  - 기타 첨가제

조성별 성능 테이블
  - 감도 (Sensitivity, mJ/cm²)
  - 해상도 (Resolution, nm)
  - LER / LWR (nm)
  - EUV dose

최적 조성 & 저자 결론
```

#### reaction 논문 (수지 합성 반응)
```
모노머 (Monomer)
  - 종류
  - 함량 (mol%)
  - 투입 순서

개시제 (Initiator)
  - 종류
  - 함량
  - 투입 방법

반응 조건
  - 온도 (°C)
  - 적하 시간 (h)
  - 숙성 시간 (h)

반응 용매
  - 종류
  - 함량 / 비율

반응 분위기
  - 질소 / 아르곤 / 진공 여부

농도
  - 단량체 농도 (mol/L)

중합 방식
  - 라디칼 / RAFT / ATRP / 음이온 등

체인 트랜스퍼 에이전트 (CTA)
  - 종류 / 함량 (RAFT 등 제어 중합 시)

정제 방법
  - Methanolysis 유무
  - Methanolysis 온도 (°C)
  - 침전 방법 (침전 용매 종류 / 비율)
  - 여과 / 건조 조건

결과물 특성
  - 분자량 (Mn / Mw / PDI)
  - 수율 (%)
  - 조성 분석 결과 (NMR 등)

산 탈보호 특성 (있는 경우)
  - 탈보호 온도
  - 활성화 에너지

리소그래피 적용 결과 (있는 경우)
  - 감도 / 해상도 / LER
  - EUV dose
```

#### 공통 파싱 항목
```
사용 장비 & 측정 방법
비교 대상 (reference 물질/공정)
저자 결론 요약
한계점 & 향후 연구 방향
```

### 파싱 완료 후 처리
```
파싱 완료 → Markdown / PDF 즉시 폐기 (저장 안 함)
        ↓
papers_parsed INSERT (JSONB)
composition_data INSERT (composition 타입인 경우)
reaction_conditions INSERT (reaction 타입인 경우)
fulltext_status = 'batch_done'
papers_history INSERT
```

---

## 9. LAYER 5 — 저장 & 서비스 계층 (기존 확장)

### 담당
- PostgreSQL 16 (기존 유지)
- MCP 서버 (기존 유지)
- 대시보드 (기존 유지)

### 처리 흐름
```
임베딩 생성
  text-embedding-004 → pgvector 저장
        ↓
Notion 브리핑 자동 발행
        ↓
서비스:
  시멘틱 검색 (search API): 의미 기반 검색 + RAG 답변
  MCP 서버: Claude Desktop 연동, DB 직접 조회 → 근거 기반 답변
  대시보드: 수집 통계 / API 비용 / 시스템 상태 모니터링
```

---

## 10. PostgreSQL 테이블 명세

### 신규 추가 테이블

#### system_config
```sql
CREATE TABLE system_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 초기 데이터
INSERT INTO system_config VALUES
  ('phase1_completed',       'false'),
  ('phase1_last_cursor',     ''),
  ('phase1_collected_today', '0'),
  ('phase1_start_time',      ''),
  ('daily_pdf_limit',        '10'),
  ('daily_pdf_processed',    '0'),
  ('daily_pdf_reset_at',     '');
```

#### papers_excluded
```sql
CREATE TABLE papers_excluded (
  id               SERIAL PRIMARY KEY,
  doi              TEXT,
  arxiv_id         TEXT,
  title_normalized TEXT,
  excluded_reason  TEXT,  -- 'low_relevance' 등
  excluded_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_excluded_doi      ON papers_excluded (doi);
CREATE INDEX idx_excluded_arxiv_id ON papers_excluded (arxiv_id);
CREATE INDEX idx_excluded_title    ON papers_excluded (title_normalized);
```

#### papers_scored
```sql
CREATE TABLE papers_scored (
  id         SERIAL PRIMARY KEY,
  doi        TEXT,
  arxiv_id   TEXT,
  relevance  TEXT,  -- 'yes' | 'no' | 'unsure'
  paper_type TEXT,  -- 'composition' | 'reaction' | 'process' | 'other' | 'unknown'
  scored_at  TIMESTAMPTZ DEFAULT NOW()
);
```

#### papers_parsed
```sql
CREATE TABLE papers_parsed (
  id          SERIAL PRIMARY KEY,
  paper_id    INTEGER REFERENCES papers_staging(id),
  paper_type  TEXT,
  parsed_data JSONB,       -- 타입별 구조화 데이터 전체
  key_findings TEXT,       -- Claude가 추출한 핵심 결론
  parsed_at   TIMESTAMPTZ DEFAULT NOW(),
  source_type TEXT         -- 'fulltext' | 'pdf_direct' | 'abstract_only'
);
```

#### composition_data
```sql
CREATE TABLE composition_data (
  id           SERIAL PRIMARY KEY,
  paper_id     INTEGER REFERENCES papers_staging(id),
  resin_type   TEXT,
  resin_mw     JSONB,   -- {Mn: 값, Mw: 값, PDI: 값}
  resin_ratio  TEXT,    -- mol% 또는 wt%
  pag_type     TEXT,
  pag_ratio    TEXT,
  solvent      TEXT,
  quencher     TEXT,
  additives    JSONB,   -- 기타 첨가제
  sensitivity  FLOAT,  -- mJ/cm²
  resolution   FLOAT,  -- nm
  ler          FLOAT,  -- nm
  euv_dose     FLOAT,
  optimal_flag BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

#### reaction_conditions
```sql
CREATE TABLE reaction_conditions (
  id                  SERIAL PRIMARY KEY,
  paper_id            INTEGER REFERENCES papers_staging(id),

  -- 모노머
  monomers            JSONB,   -- [{type, content_mol_pct, order}]

  -- 개시제
  initiator_type      TEXT,
  initiator_content   TEXT,
  initiator_method    TEXT,

  -- 반응 조건
  temperature         FLOAT,   -- °C
  dropping_time       FLOAT,   -- h
  aging_time          FLOAT,   -- h

  -- 용매 / 분위기 / 농도
  solvent             TEXT,
  solvent_ratio       TEXT,
  atmosphere          TEXT,    -- 'N2' | 'Ar' | 'vacuum'
  monomer_conc        FLOAT,   -- mol/L

  -- 중합 방식 / CTA
  polymerization_type TEXT,    -- 'radical' | 'RAFT' | 'ATRP' | 'anionic'
  cta_type            TEXT,
  cta_content         TEXT,

  -- 정제
  methanolysis        BOOLEAN,
  methanolysis_temp   FLOAT,   -- °C
  precipitation       JSONB,   -- {solvent, ratio, method}
  filtration          TEXT,
  drying              TEXT,

  -- 결과
  yield_pct           FLOAT,
  mw_result           JSONB,   -- {Mn, Mw, PDI}
  composition_result  JSONB,   -- NMR 등 분석 결과

  -- 산 탈보호
  deprotection_temp   FLOAT,
  activation_energy   FLOAT,

  -- 리소그래피 결과 (있는 경우)
  litho_sensitivity   FLOAT,
  litho_resolution    FLOAT,
  litho_ler           FLOAT,
  litho_euv_dose      FLOAT,

  created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### 기존 테이블 수정

#### papers_staging — fulltext_status 컬럼 상태값 확장
```sql
-- 기존 상태값에 아래 추가
-- 'queued'    : Layer 4 일일 한도 초과, 다음날 이월
-- 'broken'    : Markdown 품질 불량 감지
-- 'failed'    : PDF 직접 투입 후에도 파싱 실패
-- 'batch_done': Layer 4 파싱 완료
```

#### papers_history — arxiv_id 컬럼 추가
```sql
ALTER TABLE papers_history
  ADD COLUMN IF NOT EXISTS arxiv_id TEXT,
  ADD COLUMN IF NOT EXISTS fulltext_status TEXT;

CREATE INDEX IF NOT EXISTS idx_history_arxiv_id
  ON papers_history (arxiv_id);
```

---

## 11. 구현 우선순위

### 1순위 — 수집 품질 개선 (ingest API 수정)
- OpenAlex 어댑터 추가
- 중복 제거 로직 강화 (3테이블 대조)
- papers_excluded 테이블 추가 및 연동
- arxiv_id 별도 키 관리

### 2순위 — n8n 워크플로우 수정
- Phase 1 / Phase 2 분기 로직
- 300건 루프 + 20시간 + 50건 미만 종료 조건
- system_config 테이블 연동

### 3순위 — batch-runner 수정 (Gemini 역할 변경)
- 기존 전문 분석 코드 제거
- 관련성 판단 + 분류만 수행하도록 변경
- UNSURE 결과 처리 추가
- papers_scored, papers_excluded 테이블 연동

### 4순위 — Claude Deep Parser 신규 구현
- 별도 워커 또는 batch-runner 확장
- Markdown 품질 검증 로직
- PDF 직접 투입 fallback
- daily_pdf_limit 카운트 관리
- 논문 타입별 파싱 프롬프트
- papers_parsed, composition_data, reaction_conditions 저장

---

## 12. Claude API 연동 가이드

### 모델
```
claude-sonnet-4-5  (최신 Sonnet 사용)
```

### Markdown 파싱 호출
```javascript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    system: PARSING_SYSTEM_PROMPT,  // 논문 타입별 프롬프트
    messages: [
      {
        role: "user",
        content: markdownText  // Docling 변환 결과
      }
    ]
  })
});
```

### PDF 직접 투입 호출
```javascript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    system: PARSING_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64PdfData  // PDF를 base64로 인코딩
            }
          },
          {
            type: "text",
            text: "위 논문을 분석하여 지정된 형식으로 파싱해주세요."
          }
        ]
      }
    ]
  })
});
```

### 파싱 프롬프트 (composition 타입 예시)
```
당신은 반도체 소재 논문 분석 전문가입니다.
아래 논문에서 다음 항목을 JSON 형식으로 추출하세요.

추출 항목:
- resin_type: 수지 종류
- resin_mw: 분자량 {Mn, Mw, PDI}
- resin_ratio: 함량 (mol% 또는 wt%)
- pag_type: PAG 종류
- pag_ratio: PAG 함량 (wt%)
- solvent: 용매 종류
- quencher: Quencher 종류 및 함량
- additives: 기타 첨가제
- performance_table: 조성별 성능 [{sensitivity, resolution, ler, euv_dose}]
- optimal_composition: 최적 조성 설명
- key_findings: 핵심 결론 (한국어, 3문장 이내)
- limitations: 한계점

데이터가 없는 항목은 null로 표시하세요.
반드시 JSON만 출력하세요.
```

---

## 13. 주의사항 및 제약

1. **PDF 저장 금지**: PDF는 절대 디스크에 저장하지 않습니다. 메모리에서 처리 후 즉시 폐기.

2. **일일 비용 한도**: 기존 cost_gate ($1.00/일) 유지. Claude PDF 직접 투입은 10건/일 한도 준수.

3. **Markdown 저장 금지**: Docling 변환 결과도 Claude 파싱 완료 후 즉시 폐기. DB에는 파싱 결과(JSONB)만 저장.

4. **arXiv DOI 처리**: arXiv 논문은 저널 게재 전 DOI 없음. arxiv_id를 별도 키로 관리하여 나중에 저널 게재 후 중복 방지.

5. **Phase 1 커서 관리**: system_config.phase1_last_cursor에 마지막 수집 위치 저장. 중단 후 재시작 시 이어서 수집 가능하도록 구현.

6. **Gemini 관련성 기준 변경 가능**: 프롬프트를 별도 설정 파일(config/gemini_prompt.txt 등)로 관리하여 코드 수정 없이 변경 가능하게 구성.

7. **papers_excluded 중요성**: Layer 1에서 반드시 papers_excluded도 조회하여 한번 걸러진 논문이 다시 수집되지 않도록 할 것.

---

## 14. 데이터 흐름 요약

```
[수집]
n8n → ingest API
  OpenAlex / Semantic Scholar / arXiv / ChemRxiv
  → 필드 정규화
  → 중복 제거 (3테이블)
  → papers_staging (pending / no_pdf)

[관련성 판단]
batch-runner → Gemini Flash Batch
  abstract만 입력
  → YES/UNSURE → papers_scored
  → NO         → papers_excluded

[전처리]
pdf-worker → docling-svc
  pending → PDF 다운로드 → Markdown 변환
  → md_ready
  no_pdf → no_pdf_done → papers_history

[파싱]
Claude Sonnet 워커
  md_ready → Markdown 품질 검증
    OK     → 파싱 (0카운트)
    BROKEN → PDF 직접 투입 (1카운트)
  UNSURE → 관련성 최종 판단
  → composition_data / reaction_conditions
  → papers_parsed (JSONB)
  → batch_done → papers_history

[서비스]
pgvector 임베딩 → 시멘틱 검색
MCP 서버 → Claude Desktop 연동
대시보드 → 모니터링
```

---

*이 문서는 Claude와의 기획 대화를 기반으로 작성되었습니다.*
*구현 중 불명확한 부분은 이 문서의 의도를 최우선으로 해석하여 진행하세요.*
