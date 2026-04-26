import psycopg
from psycopg.rows import dict_row
from . import config

_conn: psycopg.Connection | None = None


def conn() -> psycopg.Connection:
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(
            host=config.PGHOST,
            port=config.PGPORT,
            dbname=config.PGDATABASE,
            user=config.PGUSER,
            password=config.PGPASSWORD,
            row_factory=dict_row,
            autocommit=False,
        )
    return _conn


def close():
    global _conn
    if _conn and not _conn.closed:
        _conn.close()
    _conn = None
