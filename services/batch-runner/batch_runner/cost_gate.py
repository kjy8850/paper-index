import json
from contextlib import contextmanager
from .db import conn
from . import config


class CostLimitExceeded(RuntimeError):
    pass


def _calc(model: str, in_tok: int, out_tok: int, cac_tok: int, is_batch: bool) -> float:
    p = config.PRICING["models"].get(model, config.PRICING["models"]["gemini-2.5-flash-lite"])
    cost = (in_tok - cac_tok) / 1e6 * p["input_per_1m"] \
         + cac_tok / 1e6 * p["input_per_1m"] * config.PRICING["cached_input_ratio"] \
         + out_tok / 1e6 * p["output_per_1m"]
    if is_batch:
        cost *= config.PRICING["batch_discount"]
    return cost


def check():
    with conn().cursor() as cur:
        cur.execute("""
            SELECT (SELECT spent_usd FROM v_today_cost),
                   (SELECT daily_limit_usd FROM cost_settings WHERE id=1)
        """)
        row = cur.fetchone()
        spent = float(row["spent_usd"] or 0)
        lim   = float(row["daily_limit_usd"] or 1.0)
        if spent >= lim:
            raise CostLimitExceeded(f"daily ${lim:.4f} reached (${spent:.4f})")


@contextmanager
def cost_gate(caller: str, model: str, endpoint: str,
              is_batch: bool = False, paper_id=None, batch_job_id=None, meta=None):
    check()
    rec = type("Rec", (), {"in_tok": 0, "out_tok": 0, "cac_tok": 0})()

    def set_tokens(um: dict):
        rec.in_tok  = um.get("promptTokenCount", 0)
        rec.out_tok = um.get("candidatesTokenCount", 0)
        rec.cac_tok = um.get("cachedContentTokenCount", 0)

    rec.set_tokens = set_tokens
    try:
        yield rec
    finally:
        cost = _calc(model, rec.in_tok, rec.out_tok, rec.cac_tok, is_batch)
        with conn().cursor() as cur:
            cur.execute("""
                INSERT INTO api_usage
                  (model, endpoint, is_batch, input_tokens, output_tokens, cached_tokens,
                   cost_usd, caller, paper_id, batch_job_id, meta)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (model, endpoint, is_batch, rec.in_tok, rec.out_tok, rec.cac_tok,
                  round(cost, 6), caller, paper_id, batch_job_id, json.dumps(meta or {})))
        conn().commit()
