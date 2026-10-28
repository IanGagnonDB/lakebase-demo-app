"""Restartable workshop reset. Canonical Delta opportunities are never modified here."""
import json
import logging
import threading
import time
import uuid
from contextlib import contextmanager

import ops
import provision
import sync_demo
from db import dbsql, pg, prod, uc, w
from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/demo/reset")
_guard = threading.Lock()
_active = 0
_ready = False
_state = {"id": "", "status": "idle", "steps": []}
STEP_LABELS = ["Restore opportunities and clean Lakebase activities", "Clean Delta activity writes",
               "Restore the synced-table baseline", "Sync the baseline to Lakebase",
               "Recreate the demo branch", "Remove the restore branch"]


def _save(state):
    global _state
    pg("INSERT INTO workshop_control.reset_state VALUES (1, %(state)s::jsonb) "
       "ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state", {"state": json.dumps(state)})
    _state = state


def initialize():
    global _ready, _state
    rows = pg("SELECT state FROM workshop_control.reset_state WHERE id=1")
    if rows:
        _state = rows[0]["state"]
        if _state["status"] == "running":
            state = {**_state, "status": "failed", "error": "Reset interrupted by app restart. Retry to continue."}
            state["steps"] = [{**step, "status": "failed" if step["status"] == "running" else step["status"]}
                              for step in state["steps"]]
            _save(state)
    _ready = True


@contextmanager
def request_access():
    """All normal API requests finish before a reset can begin, including branch reads."""
    global _active
    with _guard:
        if not _ready:
            raise HTTPException(503, "Demo controls are still provisioning")
        if _state["status"] in {"running", "failed"}:
            raise HTTPException(409, "Demo reset is unfinished. Open Reset demo to retry.")
        _active += 1
    try:
        yield
    finally:
        with _guard:
            _active -= 1


def _restore_app():
    rows = dbsql(f"SELECT {provision.OPP_COLS} FROM {uc('opportunities')}")
    if not rows:
        raise ValueError("Delta opportunity baseline is empty; nothing was reset")
    # CDF's legacy activity edit can change a seed row's notes; restore only those seed records.
    edited = pg("SELECT activity_id FROM app.activities WHERE notes LIKE 'edited from CDF tab at %%'")
    originals = []
    if edited:
        originals = dbsql(f"SELECT {provision.ACT_COLS} FROM {uc('activities')} WHERE activity_id IN "
                          "(SELECT explode(from_json(:ids, 'ARRAY<BIGINT>'))) "
                          "AND (notes IS NULL OR notes NOT IN ('logged from head-to-head', 'logged from CDF tab'))",
                          {"ids": json.dumps([r['activity_id'] for r in edited])})
    with prod.connection() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute("CREATE TEMP TABLE reset_opportunities (LIKE app.opportunities INCLUDING DEFAULTS) ON COMMIT DROP")
        with cur.copy(f"COPY reset_opportunities ({provision.OPP_COLS}) FROM STDIN") as copy:
            for row in rows:
                copy.write_row([row[col.strip()] for col in provision.OPP_COLS.split(',')])
        assignments = ', '.join(f"{col.strip()}=EXCLUDED.{col.strip()}" for col in provision.OPP_COLS.split(',')[1:])
        cur.execute(f"INSERT INTO app.opportunities ({provision.OPP_COLS}) SELECT {provision.OPP_COLS} "
                    f"FROM reset_opportunities WHERE true ON CONFLICT (opportunity_id) DO UPDATE SET {assignments}")
        cur.execute("DELETE FROM app.activities WHERE notes IN ('logged from head-to-head', 'logged from CDF tab') "
                    "OR notes LIKE 'edited from CDF tab at %%'")
        values = ', '.join(f'%({col.strip()})s' for col in provision.ACT_COLS.split(','))
        for row in originals:
            cur.execute(f"INSERT INTO app.activities ({provision.ACT_COLS}) VALUES ({values}) "
                        "ON CONFLICT (activity_id) DO NOTHING", row)
        # Recovery markers are removed atomically with successful data restoration.
        cur.execute("DELETE FROM workshop_control.pitr_recovery")


def _clean_delta():
    dbsql(f"DELETE FROM {uc('activities')} WHERE notes IN ('logged from head-to-head', 'logged from CDF tab')")


def _restore_delta():
    with sync_demo.mutation():
        sync_demo._revision += 1
        sync_demo._poll_cache = None
        dbsql(f"""MERGE INTO {uc('sync_demo')} AS target
            USING (SELECT concat('baseline-', CAST(id AS STRING)) AS row_id, CAST(id + 100 AS INT) AS demo_value
                   FROM range(100)) AS source
            ON target.row_id=source.row_id AND target.tag=:tag
            WHEN MATCHED THEN UPDATE SET demo_value=source.demo_value
            WHEN NOT MATCHED THEN INSERT (row_id, demo_value, tag) VALUES (source.row_id, source.demo_value, :tag)
            WHEN NOT MATCHED BY SOURCE AND target.tag=:tag THEN DELETE""", {"tag": sync_demo.TAG})


def _sync_baseline():
    deadline = time.monotonic() + 600
    # A pre-existing pipeline may be finishing an older version; retrigger after it finishes.
    while time.monotonic() < deadline:
        current = sync_demo._pending()
        if current["sync_complete"]:
            pg("UPDATE sync_experiment.batch SET base_version=%(v)s WHERE id=1", {"v": current["delta_version"]})
            sync_demo._poll_cache = None
            return
        status = w.postgres.get_synced_table(name=f"synced_tables/{provision.synced_id('sync_demo')}").status
        if not status.pipeline_id:
            raise ValueError("Synced demo pipeline is not ready")
        from databricks.sdk.errors import ResourceConflict
        try:
            w.pipelines.start_update(pipeline_id=status.pipeline_id)
        except ResourceConflict:
            pass
        time.sleep(3)
    raise TimeoutError("Baseline sync exceeded 10 minutes. Retry to check it again.")


def _recreate_demo():
    ops.recreate_branch("demo")
    ops.endpoint("demo")
    # Remove branch recovery metadata only after recreation has succeeded.
    pg("DELETE FROM branch_control.reset_recovery WHERE id=1")


def _remove_restore():
    if "restore" in ops.list_branches():
        ops.drop_pool("restore")
        w.postgres.delete_branch(name=ops.branch_path("restore"), purge=True).wait()


ACTIONS = [_restore_app, _clean_delta, _restore_delta, _sync_baseline, _recreate_demo, _remove_restore]


def _run():
    global _state
    state = {**_state, "steps": [dict(step) for step in _state["steps"]]}
    try:
        for index, action in enumerate(ACTIONS):
            if state["steps"][index]["status"] == "done":
                continue
            state["steps"][index] = {"label": STEP_LABELS[index], "status": "running"}
            _save({**state, "steps": [dict(s) for s in state["steps"]]})
            action()
            state["steps"][index]["status"] = "done"
            _save({**state, "steps": [dict(s) for s in state["steps"]]})
        _save({**state, "status": "succeeded", "error": None})
    except Exception:
        failed = next((s["label"] for s in state["steps"] if s["status"] == "running"), "unknown")
        # Exception text can name catalogs or infrastructure; keep it in the app logs only.
        log.exception("Demo reset failed on step %r", failed)
        error = f"Reset failed on step \"{failed}\". Check the app logs and retry."
        for step in state["steps"]:
            if step["status"] == "running":
                step.update(status="failed", error=error)
        try:
            _save({**state, "status": "failed", "error": error})
        except Exception:
            # Retain the local failure; durable running state is recovered on restart.
            _state = {**state, "status": "failed", "error": error}


@router.get("")
def status():
    if not _ready:
        raise HTTPException(503, "Reset controls are still provisioning")
    return _state


@router.post("")
def start():
    with _guard:
        if not _ready:
            raise HTTPException(503, "Reset controls are still provisioning")
        if _state["status"] == "running":
            return _state
        if _active:
            raise HTTPException(409, "A demo request is still running. Wait for it to finish, then retry.")
        state = {**_state, "status": "running", "error": None} if _state["status"] == "failed" else {
            "id": str(uuid.uuid4()), "status": "running", "steps": [{"label": label, "status": "pending"} for label in STEP_LABELS]}
        _save(state)
        threading.Thread(target=_run, daemon=True).start()
        return state
