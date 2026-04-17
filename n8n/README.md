# n8n 워크플로우 사용법

## 1. 임포트
1. n8n 에서 **Import from File** → `workflow.json` 선택.
2. 환경변수 `INGEST_API_KEY` 를 n8n 컨테이너에 주입 (혹은 Settings → Variables).
3. `Ingest API 호출` 노드의 URL 을 실제 ingest 서버 주소로 교체:
   - 같은 호스트: `http://localhost:8787/ingest/batch`
   - 도커 네트워크: `http://host.docker.internal:8787/ingest/batch`

## 2. 동작 방식
```
[Cron 06:00]
    │
    ▼
[키워드 세트] ── (12개 쿼리를 fan-out)
    │
    ├─► [arXiv]           ──┐
    ├─► [Semantic Scholar]──┼─► [정규화 & 중복 제거] (PaperRef[], ≤300)
    └─► [ChemRxiv]         ─┘        │
                                     ▼
                          [Split in Batches (10)]
                                     │
                                     ▼
                          [Ingest API 호출  POST /ingest/batch]
                                     │
                                     ▼
                          [배치 간 대기 5초]  → 다음 배치 반복 → [요약]
```

- Split in Batches 와 Wait 노드로 **Gemini Rate limit** 에 맞춰 10건씩 5초 간격.
- ingest.js 내부에서도 p-limit 으로 동시 3개까지만 Gemini 호출.
- 중복은 DB (DOI/arxiv_id) 에서도 다시 한 번 걸러짐.

## 3. 실패 대응
- `Ingest API 호출` 노드에 **Retry on Fail** 설정 권장 (3회, 30초 간격).
- 노드 설정 → Continue on Fail 로 일부 배치 실패해도 다음 배치 진행.

## 4. 팁
- 특정 키워드만 돌리고 싶으면 `키워드 세트` Code 노드 수정.
- 특정 논문 id 를 빠르게 재분석하려면 ingest 서버에 `/ingest/batch` 로 직접 POST.
