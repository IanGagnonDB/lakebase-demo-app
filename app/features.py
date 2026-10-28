"""Routes for the five feature tabs. Each is a plain request/response; the UI polls where needed."""
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import date, datetime
from typing import Literal

import ops
import provision
import psycopg
from databricks.sdk.errors import DatabricksError, ResourceConflict
from db import S, bronze, dbsql, pg, uc, w
from fastapi import APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger(__name__)
_reset_cleanup_pending = False
router = APIRouter(prefix="/api")
_burst = ThreadPoolExecutor(max_workers=16)


def _quarter() -> str:
    t = date.today()
    return f"{t.year}-Q{(t.month - 1) // 3 + 1}"


# ── Synced tables (Delta → Postgres) ────────────────────────────────────────
class EditTargetIn(BaseModel):
    rep_id: int = Field(..., ge=1, le=50)
    visits_target: int = Field(..., ge=0, le=500)


@router.get("/sync/status")
def sync_status():
    out = []
    for table in provision.SYNCED:
        try:
            st = w.postgres.get_synced_table(name=f"synced_tables/{provision.synced_id(table)}").status
            end = getattr(getattr(st, "last_sync", None), "sync_end_time", None)
            out.append({"table": provision.synced_id(table), "state": getattr(getattr(st, "detailed_state", None), "value", None),
                        "last_sync_time": end.ToJsonString() if end else None})
        except Exception as e:  # noqa: BLE001 — report provisioning availability per table; missing or still provisioning: say so for this table only
            out.append({"table": provision.synced_id(table), "state": "UNAVAILABLE", "last_sync_time": None, "message": str(e)})
    return out


@router.get("/sync/compare")
def sync_compare(rep_id: int = 1):
    p = {"rep_id": rep_id, "quarter": _quarter()}
    delta = dbsql(f"SELECT visits_target FROM {uc('targets')} WHERE rep_id = :rep_id AND quarter = :quarter", p)
    lake = pg("SELECT visits_target FROM ref.targets WHERE rep_id = %(rep_id)s AND quarter = %(quarter)s", p)
    return {**p, "delta": delta[0]["visits_target"] if delta else None,
            "lakebase": lake[0]["visits_target"] if lake else None}


@router.post("/sync/edit-target")
def sync_edit_target(body: EditTargetIn):
    dbsql(f"UPDATE {uc('targets')} SET visits_target = :v WHERE rep_id = :rep_id AND quarter = :quarter",
          {"v": body.visits_target, "rep_id": body.rep_id, "quarter": _quarter()})
    return sync_compare(body.rep_id)


@router.post("/sync/trigger")
def sync_trigger():
    updates = {}
    for table in ("targets", "sync_demo"):
        try:
            st = w.postgres.get_synced_table(name=f"synced_tables/{provision.synced_id(table)}").status
            pipeline_id = getattr(st, "pipeline_id", None)
            if not pipeline_id:
                raise ValueError("Synced table is still provisioning; no pipeline_id")
            updates[table] = {"update_id": w.pipelines.start_update(pipeline_id=pipeline_id).update_id}
        except ResourceConflict:
            updates[table] = {"update_id": None, "already_running": True}
        except (DatabricksError, ValueError) as exc:
            if table == "targets":
                raise
            updates[table] = {"update_id": None, "error": str(exc)}
    return {**updates["targets"], "updates": updates}


# ── CDF (Postgres → Delta) ──────────────────────────────────────────────────
class ChangeIn(BaseModel):
    op: Literal["insert", "update", "delete"]
    table: Literal["activities", "opportunities"]


TAG = "logged from CDF tab"
CHANGE_SQL = {
    ("insert", "activities"): f"""
INSERT INTO app.activities (rep_id, account_id, activity_type, notes)
SELECT owner_rep_id, account_id, 'Site visit', '{TAG}' FROM ref.accounts ORDER BY random() LIMIT 1
RETURNING activity_id AS pk, clock_timestamp() AS committed_at""",
    ("update", "activities"): """
UPDATE app.activities SET notes = 'edited from CDF tab at ' || clock_timestamp()::text
WHERE activity_id = (SELECT max(activity_id) FROM app.activities)
RETURNING activity_id AS pk, clock_timestamp() AS committed_at""",
    ("update", "opportunities"): """
UPDATE app.opportunities SET stage = 'Negotiation', updated_at = now()
WHERE opportunity_id = (SELECT opportunity_id FROM app.opportunities ORDER BY random() LIMIT 1)
RETURNING opportunity_id AS pk, clock_timestamp() AS committed_at""",
    # Deletes only ever remove a row this tab inserted.
    ("delete", "activities"): f"""
DELETE FROM app.activities WHERE activity_id = (SELECT max(activity_id) FROM app.activities WHERE notes = '{TAG}')
RETURNING activity_id AS pk, clock_timestamp() AS committed_at""",
}
PK = {"activities": "activity_id", "opportunities": "opportunity_id"}


@router.post("/cdf/change")
def cdf_change(body: ChangeIn):
    sql = CHANGE_SQL.get((body.op, body.table))
    if sql is None:
        raise HTTPException(400, f"{body.op} on {body.table} isn't part of this demo")
    rows = pg(sql)
    if not rows:
        raise HTTPException(400, "Nothing to delete — insert a row first.")
    return jsonable_encoder({"op": body.op, "table": body.table, **rows[0]})


@router.get("/cdf/history")
def cdf_history(table: Literal["activities", "opportunities"], pk: int):
    try:
        rows = dbsql(f"SELECT _pg_change_type, _timestamp, _pg_lsn FROM {bronze(f'lb_{table}_history')} "
                     f"WHERE {PK[table]} = :pk ORDER BY _pg_lsn", {"pk": pk})
    except Exception as e:  # noqa: BLE001 — return preview availability; CDF preview off, or the history table doesn't exist yet
        return {"status": "cdf_unavailable", "message": str(e), "rows": []}
    return jsonable_encoder({"status": "ok", "rows": rows})


# ── Branching ───────────────────────────────────────────────────────────────
COLUMNS = ("SELECT column_name FROM information_schema.columns "
           "WHERE table_schema = 'app' AND table_name = 'opportunities' ORDER BY ordinal_position")


@router.get("/branching/state")
def branching_state():
    recovery = _recovery()
    if recovery:
        return _recoverable(recovery)["state"]
    return _branching_state()


def _branching_branches(branches):
    """Keep PITR and unrelated project branches out of the dev experiment graph."""
    allowed = {S["LAKEBASE_PRODUCTION_BRANCH"], S["LAKEBASE_DEMO_BRANCH"]}
    return [branch for branch in branches if branch in allowed]


def _branching_state():
    prod_cols = [r["column_name"] for r in pg(COLUMNS)]
    demo_cols = [r["column_name"] for r in ops.pg_on("demo", COLUMNS)]
    return {"branches": _branching_branches(ops.list_branches()), "production": prod_cols, "demo": demo_cols,
            "only_on_demo": [c for c in demo_cols if c not in prod_cols]}


# All branching mutations are serialized with reset in this single-process app.
_branching_lock = threading.Lock()


@contextmanager
def _branching_operation():
    if not _branching_lock.acquire(blocking=False):
        raise HTTPException(409, "Another branching operation is running; retry shortly")
    try:
        yield
    finally:
        _branching_lock.release()


def _finish_recovery():
    global _reset_cleanup_pending
    _reset_cleanup_pending = True
    try:
        # Persist completion before deletion so a restart can also retry cleanup.
        pg("UPDATE branch_control.reset_recovery SET snapshot = "
           """snapshot || '{"_reset_complete": true}'::jsonb WHERE id=1""")
        pg("DELETE FROM branch_control.reset_recovery WHERE id=1")
        _reset_cleanup_pending = False
    except Exception:
        log.exception("Reset succeeded; recovery metadata cleanup will be retried")


def _recovery():
    rows = pg("SELECT snapshot FROM branch_control.reset_recovery WHERE id=1")
    snapshot = rows[0]["snapshot"] if rows else None
    if _reset_cleanup_pending or (snapshot and snapshot.get("_reset_complete")):
        _finish_recovery()
        return None
    return snapshot


def _recoverable(snapshot, message="Demo recreation is incomplete; retry Reset to recover"):
    return {**snapshot, "state": {**snapshot["state"],
                                  "branches": _branching_branches(snapshot["state"].get("branches", [])), "demo": [], "only_on_demo": [],
                                  "recoverable": True, "message": message}}

BRANCH_STEPS = ("add_win_probability", "halve_sample_amounts", "drop_service_line")
SAMPLES = "SELECT opportunity_id, amount FROM app.opportunities ORDER BY opportunity_id LIMIT 3"


def _demo_pool(branch="demo"):
    # Defense in depth: never permit the production pool in a branching mutation.
    if branch != "demo":
        raise ValueError("Branching experiments may only mutate demo")
    return ops.branch_pool(branch)


def _steps(conn):
    conn.execute("CREATE SCHEMA IF NOT EXISTS branch_experiment")
    conn.execute("CREATE TABLE IF NOT EXISTS branch_experiment.applied_steps "
                 "(step text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
    return [r["step"] for r in conn.execute(
        "SELECT step FROM branch_experiment.applied_steps ORDER BY applied_at, step").fetchall()]


def _apply_step(step):
    if _recovery():
        raise HTTPException(409, "Demo recreation is incomplete; retry Reset to recover")
    samples = []
    affected = 0
    with _demo_pool().connection() as conn, conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(72461022)")
        applied = _steps(conn)
        if step in applied:
            if step == "add_win_probability":
                return affected, samples  # Preserve the existing idempotent add-column contract.
            raise HTTPException(409, "Step already applied; reset the demo to repeat")
        if list(BRANCH_STEPS[:BRANCH_STEPS.index(step)]) != applied:
            raise HTTPException(409, "Apply the experiment steps in order")
        if step == "add_win_probability":
            conn.execute("ALTER TABLE app.opportunities ADD COLUMN IF NOT EXISTS "
                         "win_probability numeric(5,2) DEFAULT 0.50")
        elif step == "halve_sample_amounts":
            before = {r["opportunity_id"]: r["amount"] for r in conn.execute(SAMPLES).fetchall()}
            rows = conn.execute("""WITH sample AS (
                SELECT opportunity_id FROM app.opportunities ORDER BY opportunity_id LIMIT 3)
                UPDATE app.opportunities SET amount = amount * 0.5
                WHERE opportunity_id IN (SELECT opportunity_id FROM sample)
                RETURNING opportunity_id, amount""").fetchall()
            samples = [{**r, "before_amount": before[r["opportunity_id"]]} for r in
                       sorted(rows, key=lambda r: r["opportunity_id"])]
            affected = len(samples)
        else:
            conn.execute("ALTER TABLE app.opportunities DROP COLUMN IF EXISTS service_line")
        conn.execute("INSERT INTO branch_experiment.applied_steps (step) VALUES (%s)", (step,))
    return affected, samples


@router.post("/branching/add-column")
def branching_add_column():
    with _branching_operation():
        _apply_step("add_win_probability")
        return branching_state()


class BranchTestChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step: Literal["halve_sample_amounts", "drop_service_line"]
    branch: Literal["demo"]


@router.post("/branching/test-change")
def branching_test_change(body: BranchTestChangeIn):
    started = time.perf_counter()
    with _branching_operation():
        affected, samples = _apply_step(body.step)
        return jsonable_encoder({"state": branching_state(), "applied_step": body.step,
                                 "affected_rows": affected, "sample_rows": samples,
                                 "seconds": round(time.perf_counter() - started, 3)})


def _read_experiment():
    with _demo_pool().connection() as conn, conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(72461022)")
        applied = _steps(conn)
        samples = conn.execute(SAMPLES).fetchall()
    return jsonable_encoder({"state": _branching_state(), "applied_steps": applied,
                             "production_samples": pg(SAMPLES), "demo_samples": samples})


@router.get("/branching/experiment")
def branching_experiment():
    recovery = _recovery()
    if recovery:
        return _recoverable(recovery)
    return _read_experiment()


@router.post("/branching/reset")
def branching_reset():
    t0 = time.perf_counter()
    with _branching_operation():
        snapshot = _recovery()
        if not snapshot:
            try:
                if "demo" not in ops.list_branches():
                    raise ValueError("Demo branch is missing")
                snapshot = _read_experiment()
            except Exception:
                log.exception("Demo unreadable; resetting with minimal recovery metadata")
                columns = [r["column_name"] for r in pg(COLUMNS)]
                snapshot = jsonable_encoder({
                    "state": {"branches": _branching_branches(ops.list_branches()), "production": columns,
                              "demo": [], "only_on_demo": []},
                    "applied_steps": [], "production_samples": pg(SAMPLES), "demo_samples": []})
        # Keep recovery metadata outside demo until recreation AND schema verification succeed.
        pg("INSERT INTO branch_control.reset_recovery VALUES (1, %(snapshot)s::jsonb) "
           "ON CONFLICT (id) DO UPDATE SET snapshot=EXCLUDED.snapshot", {"snapshot": json.dumps(snapshot)})
        try:
            ops.recreate_branch("demo")
            state = _branching_state()
        except Exception as exc:  # noqa: BLE001 — persist recovery evidence across SDK/connection failures
            return {**_recoverable(snapshot, f"Reset failed: {exc}. Retry Reset to recover")["state"],
                    "seconds": round(time.perf_counter() - t0, 1)}
        _finish_recovery()
        return {**state, "seconds": round(time.perf_counter() - t0, 1)}


# ── Point-in-time restore ───────────────────────────────────────────────────
class RestoreIn(BaseModel):
    before_ts: datetime
    ids: list[int]


class CopyBackIn(BaseModel):
    ids: list[int]


OPP_COLS = provision.OPP_COLS


@router.get("/pitr/state")
def pitr_state():
    recovery = pg("SELECT before_ts, ids FROM workshop_control.pitr_recovery WHERE id=1")
    return jsonable_encoder({"opportunities": pg("SELECT count(*) AS n FROM app.opportunities")[0]["n"],
            "restore_branch": "restore" in ops.list_branches(), "recovery": recovery[0] if recovery else None})


@router.post("/pitr/delete")
def pitr_delete():
    # Persist the recovery timestamp and IDs atomically with the delete, across reloads/restarts.
    rows = pg("""WITH selected AS MATERIALIZED (
        SELECT opportunity_id FROM app.opportunities WHERE stage NOT LIKE 'Closed%%'
        ORDER BY random() LIMIT 50 FOR UPDATE),
        recovery AS (INSERT INTO workshop_control.pitr_recovery (id, before_ts, ids)
            SELECT 1, clock_timestamp(), array_agg(opportunity_id) FROM selected HAVING count(*) > 0
            ON CONFLICT DO NOTHING RETURNING before_ts, ids),
        removed AS (DELETE FROM app.opportunities USING recovery
            WHERE opportunity_id = ANY(recovery.ids) RETURNING opportunity_id)
        SELECT opportunity_id, before_ts FROM removed CROSS JOIN recovery""")
    if not rows:
        if pg("SELECT id FROM workshop_control.pitr_recovery WHERE id=1"):
            raise HTTPException(409, "Finish the pending recovery or use Reset demo before deleting again")
        return {"before_ts": pg("SELECT clock_timestamp() AS ts")[0]["ts"], "ids": []}
    return jsonable_encoder({"before_ts": rows[0]["before_ts"], "ids": [r["opportunity_id"] for r in rows]})


@router.post("/pitr/restore")
def pitr_restore(body: RestoreIn):
    t0 = time.perf_counter()
    ops.recreate_branch("restore", source_time=body.before_ts, ttl_s=7200)
    found = ops.pg_on("restore", "SELECT count(*) AS n FROM app.opportunities WHERE opportunity_id = ANY(%(ids)s)",
                      {"ids": body.ids})[0]["n"]
    return {"restore_branch": "restore", "found": found, "seconds": round(time.perf_counter() - t0, 1)}


@router.post("/pitr/copy-back")
def pitr_copy_back(body: CopyBackIn):
    rows = ops.pg_on("restore", f"SELECT {OPP_COLS} FROM app.opportunities WHERE opportunity_id = ANY(%(ids)s)",
                     {"ids": body.ids})
    if {row["opportunity_id"] for row in rows} != set(body.ids):
        raise HTTPException(409, "Some deleted rows are missing from the restore branch. Recovery remains pending; retry restore or use Reset demo.")
    values = ", ".join(f"%({c.strip()})s" for c in OPP_COLS.split(","))
    for r in rows:
        pg(f"INSERT INTO app.opportunities ({OPP_COLS}) VALUES ({values}) ON CONFLICT (opportunity_id) DO NOTHING", r)
    pg("DELETE FROM workshop_control.pitr_recovery AS recovery WHERE NOT EXISTS "
       "(SELECT 1 FROM unnest(recovery.ids) AS missing(id) WHERE NOT EXISTS "
       "(SELECT 1 FROM app.opportunities WHERE opportunity_id=missing.id))")
    return {"copied": len(rows)}


# ── Scale to zero / autoscaling (demo branch) ───────────────────────────────
class BurstIn(BaseModel):
    seconds: int = Field(30, ge=5, le=60)


# A full scan + aggregate: CPU-bound enough to load the endpoint, fast enough to show throughput.
BURST_SQL = "SELECT activity_type, count(*), max(activity_ts) FROM app.activities GROUP BY activity_type"


def _endpoint_state() -> dict:
    s = ops.endpoint("demo").status
    return {"state": getattr(s.current_state, "value", None), "min_cu": s.autoscaling_limit_min_cu, "max_cu": s.autoscaling_limit_max_cu,
            "suspend_timeout_s": s.suspend_timeout_duration.seconds if s.suspend_timeout_duration else None}


@router.get("/scaling/state")
def scaling_state():
    return _endpoint_state()


@router.get("/scaling/allocation")
def scaling_allocation():
    from scaling_telemetry import allocation
    try:
        return allocation(ops.endpoint("demo").uid, dbsql)
    except Exception:
        log.exception("Allocation telemetry unavailable")
        raise HTTPException(503, "Allocation telemetry unavailable. Check system.lakebase.compute_gauges access.")


@router.post("/scaling/wake")
def scaling_wake():
    """A brand-new connection + SELECT 1: on a suspended endpoint this measures the wake-up."""
    before = _endpoint_state()["state"]
    ep = ops.endpoint("demo")
    token = w.postgres.generate_database_credential(endpoint=ep.name).token  # not part of the wake time
    t0 = time.perf_counter()
    with psycopg.connect(host=ep.status.hosts.host, dbname=S["PGDATABASE"], user=S["PGUSER"], sslmode="require",
                         password=token) as conn:
        conn.execute("SELECT 1")
    return {"state_before": before, "connect_ms": round((time.perf_counter() - t0) * 1000, 1)}


@router.post("/scaling/burst")
def scaling_burst(body: BurstIn):
    deadline = time.perf_counter() + body.seconds

    def worker(_):
        n = 0
        while time.perf_counter() < deadline:
            ops.pg_on("demo", BURST_SQL)
            n += 1
        return n

    queries = sum(_burst.map(worker, range(16)))
    return {"queries": queries, "qps": round(queries / body.seconds, 1), **_endpoint_state()}
