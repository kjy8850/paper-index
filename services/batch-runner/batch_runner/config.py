import json
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY  = os.environ["GEMINI_API_KEY"]
BATCH_MODEL     = os.getenv("BATCH_MODEL", "gemini-2.5-flash-lite")
BATCH_MAX       = int(os.getenv("BATCH_MAX_PAPERS", "200"))
BATCH_MIN       = int(os.getenv("BATCH_MIN_PAPERS", "1"))

GCS_BUCKET   = os.environ["GCS_BUCKET"]
GCP_PROJECT  = os.environ["GCP_PROJECT"]
GCP_LOCATION = os.getenv("GCP_LOCATION", "us-central1")

PGHOST     = os.environ["PGHOST"]
PGPORT     = int(os.getenv("PGPORT", "5432"))
PGDATABASE = os.getenv("PGDATABASE", "papers")
PGUSER     = os.getenv("PGUSER", "paperuser")
PGPASSWORD = os.environ["PGPASSWORD"]

_pricing_path = Path(__file__).parent.parent.parent.parent / "config" / "gemini-pricing.json"
if _pricing_path.exists():
    PRICING = json.loads(_pricing_path.read_text())
else:
    PRICING = {
        "models": {
            "gemini-2.5-flash-lite": {"input_per_1m": 0.10, "output_per_1m": 0.40},
            "gemini-2.5-flash":      {"input_per_1m": 0.30, "output_per_1m": 2.50},
            "gemini-embedding-001":  {"input_per_1m": 0.15, "output_per_1m": 0.00},
        },
        "batch_discount": 0.5,
        "cached_input_ratio": 0.25,
    }

_schema_path = Path(__file__).parent.parent.parent.parent / "config" / "paper-analysis-schema.json"
if _schema_path.exists():
    ANALYSIS_SCHEMA = json.loads(_schema_path.read_text())
else:
    ANALYSIS_SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "summary_ko":      {"type": "STRING",  "description": "한글 3-4줄 요약"},
            "key_findings":    {"type": "ARRAY",   "items": {"type": "STRING"}, "description": "핵심 발견/기여 리스트"},
            "materials":       {"type": "ARRAY",   "items": {"type": "STRING"}, "description": "언급된 주요 소재/화합물"},
            "techniques":      {"type": "ARRAY",   "items": {"type": "STRING"}, "description": "분석·공정·측정 기법"},
            "major_category":  {"type": "STRING",  "description": "resin|pr|develop_etch|litho|metrology|misc_semi|novel_idea 중 하나"},
            "mid_category":    {"type": "STRING",  "description": "중분류"},
            "sub_category":    {"type": "STRING",  "description": "소분류"},
            "tags":            {"type": "ARRAY",   "items": {"type": "STRING"}, "description": "자유 태그 3-6개"},
            "novelty_score":   {"type": "INTEGER", "description": "신선도/독창성 0-10"},
            "relevance_score": {"type": "INTEGER", "description": "반도체 소재 관련성 0-10"},
        },
        "required": ["summary_ko", "key_findings", "major_category", "mid_category", "novelty_score", "relevance_score"],
    }
