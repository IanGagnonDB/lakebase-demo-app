"""Connections for both sides of the comparison, timed the same way: connection acquisition + execute + fetch (including pool/session wait)."""
import math
import os
import threading
import time

import psycopg
from databricks import sql as databricks_sql
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

w = WorkspaceClient()
S = {k: os.environ[k] for k in ("CATALOG", "SCHEMA", "BRONZE_SCHEMA", "LAKEBASE_PROJECT", "LAKEBASE_CATALOG",
                                "DATABRICKS_WAREHOUSE_ID", "LAKEBASE_ENDPOINT", "PGHOST", "PGDATABASE", "PGUSER")}

# Branching graph scope; production follows the configured endpoint resource.
S["LAKEBASE_PRODUCTION_BRANCH"] = S["LAKEBASE_ENDPOINT"].split("/branches/", 1)[1].split("/", 1)[0]
S["LAKEBASE_DEMO_BRANCH"] = os.environ.get("LAKEBASE_DEMO_BRANCH", "demo")


def uc(table: str) -> str:
    return f"`{S['CATALOG']}`.`{S['SCHEMA']}`.{table}"


def bronze(table: str) -> str:
    return f"`{S['CATALOG']}`.`{S['BRONZE_SCHEMA']}`.{table}"


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 2)


# ── Lakebase ────────────────────────────────────────────────────────────────
def lakebase_pool(host: str, endpoint: str, max_size: int = 10) -> ConnectionPool:
    """The SDK mints the Lakebase password (a 1-hour OAuth token) but doesn't hand it to psycopg,
    so each new pooled connection asks for a fresh one. Connections are recycled before the hour,
    and `check` drops connections that a scale-to-zero suspend closed."""
    class TokenConnection(psycopg.Connection):
        @classmethod
        def connect(cls, conninfo: str = "", **kwargs):
            kwargs["password"] = w.postgres.generate_database_credential(endpoint=endpoint).token
            return super().connect(conninfo, **kwargs)

    return ConnectionPool(
        make_conninfo(host=host, dbname=S["PGDATABASE"], user=S["PGUSER"], sslmode="require"),
        connection_class=TokenConnection, kwargs={"autocommit": True, "row_factory": dict_row},
        min_size=1, max_size=max_size, max_lifetime=45 * 60, check=ConnectionPool.check_connection, open=True,
    )


prod = lakebase_pool(S["PGHOST"], S["LAKEBASE_ENDPOINT"], max_size=60)


def pg_query(pool: ConnectionPool, sql: str, params: dict | None = None) -> tuple[list[dict], float]:
    t0 = time.perf_counter()
    with pool.connection() as conn:
        cur = conn.execute(sql, params)
        rows = cur.fetchall() if cur.description else []
        return rows, _ms(t0)


def pg(sql: str, params: dict | None = None) -> list[dict]:
    return pg_query(prod, sql, params)[0]


# ── DBSQL ───────────────────────────────────────────────────────────────────
_local = threading.local()  # one warehouse session per worker thread (sessions aren't thread-safe)


def _dbsql_conn():
    if getattr(_local, "conn", None) is None:
        cfg = Config()
        _local.conn = databricks_sql.connect(
            server_hostname=cfg.host.removeprefix("https://"),
            http_path=f"/sql/1.0/warehouses/{S['DATABRICKS_WAREHOUSE_ID']}",
            credentials_provider=lambda: cfg.authenticate,
            session_configuration={"use_cached_result": "false"},  # no result cache: measure real work
        )
    return _local.conn


def dbsql_query(sql: str, params: dict | None = None) -> tuple[list[dict], float]:
    t0 = time.perf_counter()
    conn = _dbsql_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params or {})
            rows = [r.asDict() for r in cur.fetchall()] if cur.description else []
            return rows, _ms(t0)
    except Exception:
        _local.conn = None  # drop a broken session; the next call reconnects
        raise


def dbsql(sql: str, params: dict | None = None) -> list[dict]:
    return dbsql_query(sql, params)[0]


# ── stats ───────────────────────────────────────────────────────────────────
def pct(samples: list[float], p: float) -> float:
    s = sorted(samples)
    return s[max(1, math.ceil(p / 100 * len(s))) - 1]


def summary(samples: list[float]) -> dict:
    return {"n": len(samples), "p50": pct(samples, 50), "p95": pct(samples, 95),
            "min": min(samples), "max": max(samples)}
