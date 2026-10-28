"""Head-to-head: the same logical query on Lakebase (Postgres) and DBSQL (Delta)."""
import logging
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date
from typing import Literal

from db import _ms, dbsql_query, pg_query, prod, summary, uc
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/h2h")
Action = Literal["rep_scorecard", "pipeline_list", "log_activity", "region_leaderboard"]
REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West"]
OPEN_STAGES = ["Prospect", "Qualified", "Proposal", "Negotiation"]
_users = ThreadPoolExecutor(max_workers=60)
_experiment = threading.Lock()
TIERS = (100_000, 1_000_000, 2_000_000, 5_000_000)


@contextmanager
def experiment():
    if not _experiment.acquire(timeout=10):
        raise HTTPException(409, "Another benchmark is running")
    try:
        yield
    finally:
        _experiment.release()

SQL = {  # action -> (lakebase, dbsql); Postgres uses %(name)s params, DBSQL uses :name
    "rep_scorecard": ("""
SELECT r.rep_id, r.rep_name, r.region, t.visits_target, t.pipeline_target,
  (SELECT count(*) FROM app.activities a WHERE a.rep_id = r.rep_id AND a.activity_ts >= %(q_start)s) AS visits,
  (SELECT coalesce(sum(o.amount), 0) FROM app.opportunities o
     WHERE o.rep_id = r.rep_id AND o.stage NOT LIKE 'Closed%%') AS open_pipeline
FROM ref.reps r LEFT JOIN ref.targets t ON t.rep_id = r.rep_id AND t.quarter = %(quarter)s
WHERE r.rep_id = %(rep_id)s""", f"""
SELECT r.rep_id, r.rep_name, r.region, t.visits_target, t.pipeline_target,
  (SELECT count(*) FROM {uc('activities')} a WHERE a.rep_id = r.rep_id AND a.activity_ts >= :q_start) AS visits,
  (SELECT coalesce(sum(o.amount), 0) FROM {uc('opportunities')} o
     WHERE o.rep_id = r.rep_id AND o.stage NOT LIKE 'Closed%') AS open_pipeline
FROM {uc('reps')} r LEFT JOIN {uc('targets')} t ON t.rep_id = r.rep_id AND t.quarter = :quarter
WHERE r.rep_id = :rep_id"""),
    "pipeline_list": ("""
SELECT o.opportunity_id, o.name, a.account_name, o.stage, o.amount, o.close_date
FROM app.opportunities o JOIN ref.accounts a ON a.account_id = o.account_id
WHERE a.region = %(region)s AND o.stage = %(stage)s ORDER BY o.amount DESC LIMIT 50""", f"""
SELECT o.opportunity_id, o.name, a.account_name, o.stage, o.amount, o.close_date
FROM {uc('opportunities')} o JOIN {uc('accounts')} a ON a.account_id = o.account_id
WHERE a.region = :region AND o.stage = :stage ORDER BY o.amount DESC LIMIT 50"""),
    "log_activity": ("""
INSERT INTO app.activities (rep_id, account_id, activity_type, notes)
VALUES (%(rep_id)s, %(account_id)s, 'Call', 'logged from head-to-head') RETURNING activity_id""", f"""
INSERT INTO {uc('activities')} (activity_id, rep_id, account_id, activity_type, activity_ts, notes)
VALUES (:activity_id, :rep_id, :account_id, 'Call', current_timestamp(), 'logged from head-to-head')"""),
    "region_leaderboard": ("""
SELECT r.rep_id, r.rep_name, count(a.activity_id) AS visits
FROM ref.reps r LEFT JOIN app.activities a ON a.rep_id = r.rep_id AND a.activity_ts >= %(q_start)s
WHERE r.region = %(region)s GROUP BY r.rep_id, r.rep_name ORDER BY visits DESC LIMIT 10""", f"""
SELECT r.rep_id, r.rep_name, count(a.activity_id) AS visits
FROM {uc('reps')} r LEFT JOIN {uc('activities')} a ON a.rep_id = r.rep_id AND a.activity_ts >= :q_start
WHERE r.region = :region GROUP BY r.rep_id, r.rep_name ORDER BY visits DESC LIMIT 10"""),
}


def params(action: str) -> dict:
    today = date.today()
    q = (today.month - 1) // 3 + 1
    p = {"rep_id": random.randint(1, 50), "account_id": random.randint(1, 2000), "region": random.choice(REGIONS),
         "stage": random.choice(OPEN_STAGES), "quarter": f"{today.year}-Q{q}",
         "q_start": date(today.year, 3 * (q - 1) + 1, 1), "activity_id": time.time_ns()}
    needed = {"rep_scorecard": ("rep_id", "quarter", "q_start"), "pipeline_list": ("region", "stage"),
              "log_activity": ("rep_id", "account_id", "activity_id"), "region_leaderboard": ("region", "q_start")}
    return {k: p[k] for k in needed[action]}


def run_once(engine: str, action: str, query_params: dict | None = None) -> tuple[list[dict], float]:
    lakebase_sql, dbsql_sql = SQL[action]
    p = dict(query_params) if query_params is not None else params(action)
    if engine == "lakebase":
        p.pop("activity_id", None)  # Postgres generates it
        return pg_query(prod, lakebase_sql, p)
    return dbsql_query(dbsql_sql, p)


class BatchIn(BaseModel):
    action: Action
    n: int = Field(20, ge=1, le=50)


class ConcurrentIn(BaseModel):
    action: Action
    users: int = Field(10, ge=1, le=50)
    per_user: int = Field(5, ge=1, le=10)


@router.post("/warmup")
def warmup():
    return {"lakebase_ms": pg_query(prod, "SELECT 1")[1], "dbsql_ms": dbsql_query("SELECT 1")[1]}


class RunIn(BaseModel):
    rep_id: int | None = Field(None, ge=1, le=50, strict=True)


@router.post("/{engine}/{action}")
def run(engine: Literal["lakebase", "dbsql"], action: Action, body: RunIn | None = None):
    """Optional shared rep for the read/write pair; validation is outside query timing."""
    p = params(action)
    if body is not None and body.rep_id is not None:
        existing, _ = pg_query(prod, "SELECT rep_id FROM ref.reps WHERE rep_id = %(rep_id)s",
                               {"rep_id": body.rep_id})
        if not existing:
            raise HTTPException(422, "rep_id must identify an existing seeded rep")
        if "rep_id" in p:
            p["rep_id"] = body.rep_id
    rows, ms = run_once(engine, action, p)
    return {"engine": engine, "action": action, "rep_id": p.get("rep_id"), "server_ms": ms, "rows": rows[:50]}


def _warm(action: str) -> None:
    """Untimed: wake the warehouse, open this thread's connection/session, and warm caches with one real run."""
    run_once("lakebase", action)
    run_once("dbsql", action)


@router.post("/batch")
def batch(body: BatchIn):
    _warm(body.action)  # "warehouse warmed up first" holds even if the UI didn't call /warmup
    out = {e: [run_once(e, body.action)[1] for _ in range(body.n)] for e in ("lakebase", "dbsql")}
    lb, db = summary(out["lakebase"]), summary(out["dbsql"])
    return {"action": body.action, "lakebase": lb, "dbsql": db,
            "speedup": round(db["p50"] / lb["p50"], 1), "samples": out}


@router.post("/concurrent")
def concurrent(body: ConcurrentIn):
    """One pinned, warmed connection/session per user; barriers align both engine phases."""
    with experiment():
        started = time.perf_counter()
        barrier = threading.Barrier(body.users, timeout=60)
        phase_start = {}
        phase_end = {}

        def worker(_):
            out = {}
            try:
                with prod.connection() as conn:
                    # Holding connections until every worker arrives guarantees distinct warm connections.
                    warm_params = params(body.action)
                    conn.execute(SQL[body.action][0], {k: v for k, v in warm_params.items() if k != "activity_id"}).fetchall()
                    try:
                        dbsql_query("SELECT 1", {})
                    except Exception:  # noqa: BLE001 — dbsql_query invalidates expired sessions; retry the probe before the DBSQL warm-up write
                        dbsql_query("SELECT 1", {})
                    dbsql_query(SQL[body.action][1], warm_params)
                    workload = [params(body.action) for _ in range(body.per_user)]
                    for engine in ("lakebase", "dbsql"):
                        barrier.wait()
                        phase_start.setdefault(engine, time.perf_counter())
                        samples, errors = [], []
                        for query_params in workload:
                            try:
                                if engine == "lakebase":
                                    p = {k: v for k, v in query_params.items() if k != "activity_id"}
                                    t0 = time.perf_counter()
                                    cur = conn.execute(SQL[body.action][0], p)
                                    if cur.description:
                                        cur.fetchall()
                                    samples.append(_ms(t0))
                                else:
                                    samples.append(dbsql_query(SQL[body.action][1], query_params)[1])
                            except Exception as exc:  # noqa: BLE001 — return measured query failures in the experiment
                                errors.append(f"{type(exc).__name__}: {exc}")
                        out[engine] = (samples, errors)
                        barrier.wait()
                        phase_end[engine] = time.perf_counter()
                return out
            except Exception:
                barrier.abort()
                raise

        results = list(_users.map(worker, range(body.users)))
        result = {"action": body.action, "users": body.users, "per_user": body.per_user}
        for engine in ("lakebase", "dbsql"):
            samples = [ms for r in results for ms in r[engine][0]]
            errors = [err for r in results for err in r[engine][1]]
            wall = phase_end[engine] - phase_start[engine]
            result[engine] = {**(summary(samples) if samples else {}), "errors": errors,
                              "wall_ms": round(wall * 1000, 2), "qps": round(len(samples) / wall, 1)}
        result["wall_ms"] = _ms(started)
        if result["lakebase"].get("p50") and result["dbsql"].get("p50"):
            result["speedup"] = round(result["dbsql"]["p50"] / result["lakebase"]["p50"], 1)
        return result


class AnalyticsIn(BaseModel):
    rows: Literal[100000, 1000000, 2000000, 5000000]
    repetitions: int = Field(1, ge=1, le=1)
    timeout_seconds: int | None = Field(None, ge=1, le=60)

    @model_validator(mode="after")
    def override_requires_single_scan(self):
        if self.timeout_seconds is not None and self.repetitions != 1:
            raise ValueError("Timeout overrides require repetitions=1")
        return self


def analytics_sql(table: str) -> str:
    # Separate physical tables: full scan, no tier predicate or covering index.
    return f"""SELECT region, quarter, activity_type, count(*) AS visits,
      sum(amount) AS amount, count(DISTINCT account_id) AS accounts
      FROM {table} GROUP BY region, quarter, activity_type
      ORDER BY region, quarter, activity_type"""


@router.post("/analytics")
def analytics(body: AnalyticsIn):
    with experiment():
        started = time.perf_counter()
        table = f"activities_history_{body.rows}"
        timeout_seconds = body.timeout_seconds or (60 if body.rows == 5_000_000 else 12)
        request_budget = 75 if timeout_seconds > 12 else 28
        result = {"rows": body.rows, "repetitions": body.repetitions, "timeout_seconds": timeout_seconds}
        outputs = {}
        # Warm connections, not full scans: repetitions expose the buffer-cache effects.
        pg_query(prod, "SELECT 1")
        dbsql_query("SELECT 1")
        def history_pg(q):
            t0 = time.perf_counter()
            with prod.connection() as conn, conn.transaction():
                conn.execute("SELECT set_config('statement_timeout', %s, true)", (f"{timeout_seconds}s",))
                return conn.execute(q).fetchall(), _ms(t0)

        try:
            dbsql_query(f"SET STATEMENT_TIMEOUT = {timeout_seconds}")
            engines = [("lakebase", history_pg, f"ref.{table}"), ("dbsql", dbsql_query, uc(table))]
            if timeout_seconds > 12:
                # Measure DBSQL first, leaving a full override window for Postgres only if it fits.
                # Reserve room for the DBSQL scan and warm-up before the 60s Postgres scan.
                engines.reverse()
            for engine, query, name in engines:
                samples, errors = [], []
                for _ in range(body.repetitions):
                    if time.perf_counter() - started + timeout_seconds > request_budget:
                        errors.append(f"Not started: full timeout window would exceed the {request_budget}s request budget; retry warmed")
                        break
                    try:
                        rows, ms = query(analytics_sql(name))
                        samples.append(ms)
                        outputs[engine] = rows
                    except Exception as exc:  # noqa: BLE001 — return measured query failures in the experiment
                        errors.append(f"{type(exc).__name__}: {exc}")
                        break
                result[engine] = {**(summary(samples) if samples else {}), "samples": samples, "errors": errors}
        finally:
            try:
                dbsql_query("RESET STATEMENT_TIMEOUT")
            except Exception:
                log.exception("Failed to reset statement timeout; DBSQL session discarded")
        result["results_equal"] = outputs.get("lakebase") == outputs.get("dbsql") if len(outputs) == 2 else False
        result["scanned_rows"] = {e: sum(r["visits"] for r in rows) for e, rows in outputs.items()}
        result["wall_ms"] = _ms(started)
        return result


@router.get("/diagnostics")
def diagnostics():
    rows, _ = pg_query(prod, """SELECT current_setting('max_connections') AS max_connections,
        pg_database_size(current_database()) AS database_bytes""")
    tables, _ = pg_query(prod, """SELECT relname,
        CASE WHEN c.relkind='p' THEN (SELECT sum(pg_total_relation_size(t.relid))
            FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
            ELSE pg_total_relation_size(c.oid) END AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='ref' AND relname LIKE 'activities_history_%' AND relkind IN ('r', 'p')""")
    return {**rows[0], "history_tables": tables, "pool_max": prod.max_size}
