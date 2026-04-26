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

# =====================================================================
# Layer 2 — relevance + paper_type 만 묻는 가벼운 스키마.
#   (옛 ANALYSIS_SCHEMA 는 deep parser(Layer 4) 가 책임지도록 분리됨)
# =====================================================================
_schema_path = Path(__file__).parent.parent.parent.parent / "config" / "paper-relevance-schema.json"
if _schema_path.exists():
    RELEVANCE_SCHEMA = json.loads(_schema_path.read_text())
else:
    RELEVANCE_SCHEMA = {
        "type": "OBJECT",
        "properties": {
            "relevance": {
                "type": "STRING",
                "description": "yes | no | unsure",
                "enum": ["yes", "no", "unsure"],
            },
            "paper_type": {
                "type": "STRING",
                "description": "composition | reaction | process | other | unknown",
                "enum": ["composition", "reaction", "process", "other", "unknown"],
            },
            "reason": {
                "type": "STRING",
                "description": "간단한 판단 근거(20자 내외)",
            },
        },
        "required": ["relevance", "paper_type"],
    }

# 옛 이름 호환 (혹시 외부 스크립트에서 참조).
# v1 의 무거운 ANALYSIS_SCHEMA(summary_ko/key_findings/materials/...) 는
# Layer 4 (Claude deep parser) 로 이관되었음. 외부에서 import 시 깨지지 않게 alias 만 유지.
ANALYSIS_SCHEMA = RELEVANCE_SCHEMA
