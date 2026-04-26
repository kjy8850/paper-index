# config/prompts/

운영 중에 코드 재배포 없이 프롬프트를 바꾸기 위한 외부 파일.

| 파일 | 사용처 | 모델 | 트리거 |
|---|---|---|---|
| `gemini-relevance.txt`     | Layer 2 1차 스크리닝               | Gemini Flash Batch | abstract 만 |
| `claude-md-quality.txt`    | Layer 4 Markdown 품질 검증         | Claude Sonnet      | 모든 fulltext 파싱 진입 시 |
| `claude-unsure-recheck.txt`| Layer 4 unsure 최종 판단           | Claude Sonnet      | papers_scored.relevance='unsure' |
| `claude-composition.txt`   | Layer 4 composition 타입 파싱      | Claude Sonnet      | paper_type='composition' |
| `claude-reaction.txt`      | Layer 4 reaction 타입 파싱         | Claude Sonnet      | paper_type='reaction' |
| `claude-process.txt`       | Layer 4 process 타입 파싱          | Claude Sonnet      | paper_type='process' |

## 운영 규칙

1. **수정 후에는 system_config 의 `gemini_relevance_prompt_version`(또는 해당 키) 을 1 증가**시키면 워커가 자동 재로딩하도록 했습니다.
2. JSON 출력 스키마는 함부로 바꾸지 마세요. DB 컬럼 매핑이 깨집니다. 키 추가는 OK, 키 삭제는 NG.
3. 한국어/영어 섞어쓰기 OK. 단, JSON 의 키는 영문만.
4. 변경 시에는 반드시 git commit 으로 변경 이력 남기기.

## 추가 가이드라인

- 토큰 길이는 가능한 한 짧게. 1KB 넘기면 비용·지연이 누적됩니다.
- "JSON 만 출력하세요" 류 지시는 마지막 줄에 둬야 모델이 잊지 않습니다.
- 한국어 결론은 3문장 이내로 강제. 더 길면 후속 검색 답변 합성에서 중복됩니다.
