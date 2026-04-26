import json
from pathlib import Path


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
    return json.dumps(req, ensure_ascii=False)


def write_jsonl(path: Path, lines: list[str]):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
