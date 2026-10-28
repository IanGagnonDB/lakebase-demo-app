"""A triggered Delta→Lakebase CRUD batch, isolated from the scorecard data."""
import asyncio
import json
import random
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Literal

import provision
from db import S, dbsql, pg, uc, w
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

router = APIRouter(prefix="/api/sync")
lock = threading.Lock()
_poll_task = None
_poll_cache = None
_revision = 0
_source_cache = None
SOURCE_CACHE_SECONDS = 30
TABLE = "sync_demo"
TAG = "synced-tab-demo"


class DeltaChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["insert", "update", "delete"]


def _version():
    history = dbsql(f"DESCRIBE HISTORY {uc(TABLE)}")
    return max((int(r["version"]) for r in history
                if r["operation"] in {"WRITE", "MERGE", "UPDATE", "DELETE"}), default=0)


def _base(version):
    pg("INSERT INTO sync_experiment.batch VALUES (1, %(v)s) ON CONFLICT DO NOTHING", {"v": version})
    return int(pg("SELECT base_version FROM sync_experiment.batch WHERE id=1")[0]["base_version"])


def _changes(events):
    """Pair CDF update pre/post images; retain each operation even when a key changes again."""
    changes = {}
    for row in events:
        key = (int(row["_commit_version"]), row["row_id"])
        change = changes.setdefault(key, {"op": "update", "pk": row["row_id"], "before": None,
                                          "after": None, "delta_version": key[0]})
        kind = row["_change_type"]
        if kind in ("delete", "update_preimage"):
            change["before"] = row["demo_value"]
        if kind in ("insert", "update_postimage"):
            change["after"] = row["demo_value"]
        if kind in ("insert", "delete"):
            change["op"] = kind
    return [changes[k] for k in sorted(changes)]


def _source(cached=False):
    """Reuse Delta evidence across GET polls; mutations always prepare from fresh evidence.

    External Delta writes may take up to 30 seconds to appear. Local writes advance
    the revision immediately; Lakebase values and pipeline status are never cached here.
    """
    global _source_cache
    revision = _revision
    if cached and _source_cache is not None:
        created, cached_revision, snapshot = _source_cache
        if cached_revision == revision and time.monotonic() - created < SOURCE_CACHE_SECONDS:
            return snapshot
    version = _version()
    base = _base(version)
    events = []
    if version > base:
        source = f"{S['CATALOG']}.{S['SCHEMA']}.{TABLE}"
        events = dbsql(f"SELECT row_id, demo_value, _change_type, _commit_version FROM "
                       f"table_changes('{source}', :start, :end) WHERE tag = :tag",
                       {"start": base + 1, "end": version, "tag": TAG})
    delta = {r["row_id"]: r["demo_value"] for r in dbsql(
        f"SELECT row_id, demo_value FROM {uc(TABLE)} WHERE tag = :tag", {"tag": TAG})}
    snapshot = (version, events, delta)
    if revision == _revision and not lock.locked():
        _source_cache = (time.monotonic(), revision, snapshot)
    return snapshot


def _pending(cached_source=False):
    version, events, delta = _source(cached_source)
    status = w.postgres.get_synced_table(name=f"synced_tables/{provision.synced_id(TABLE)}").status
    last = getattr(status, "last_sync", None)
    info = getattr(last, "delta_table_sync_info", None)
    synced = getattr(info, "delta_commit_version", None)
    synced = int(synced) if synced is not None else None
    if synced is None:
        raise HTTPException(503, "Initial demo table sync is still provisioning; retry shortly",
                            headers={"Retry-After": "3"})
    lake = {r["row_id"]: r["demo_value"] for r in pg(
        "SELECT row_id, demo_value FROM ref.sync_demo WHERE tag = %(tag)s", {"tag": TAG})}
    pending = [{**c, "delta": delta.get(c["pk"]), "lakebase": lake.get(c["pk"]),
                "status": "in_sync" if delta.get(c["pk"]) == lake.get(c["pk"]) else "stale"}
               for c in _changes(events)]
    end = getattr(last, "sync_end_time", None)
    phase = getattr(getattr(status, "detailed_state", None), "value", "") or ""
    return {"completed_at": end.ToJsonString() if end else None,
            "running": "NO_PENDING_UPDATE" not in phase and any(
                state in phase for state in ("RUNNING", "UPDATING", "PENDING_UPDATE", "PROVISIONING", "STARTING")),
            "table": f"{S['CATALOG']}.{S['SCHEMA']}.{TABLE}", "delta_version": version,
            "synced_version": synced, "sync_complete": synced is not None and synced >= version and
            all(c["status"] == "in_sync" for c in pending), "pending": pending}


@contextmanager
def mutation():
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "Another sync change is running; retry shortly")
    try:
        yield
    finally:
        lock.release()


async def _refresh():
    global _poll_cache
    revision = _revision
    result = await asyncio.to_thread(_pending, cached_source=True)
    if revision == _revision and not lock.locked():
        _poll_cache = (time.monotonic(), result)
    return result


@router.get("/pending")
async def pending(progress: bool = False):
    # Single-flight async polls never occupy FastAPI sync threads waiting on a mutation lock.
    global _poll_task
    # Progress checks reuse the current batch's Delta evidence but read pipeline
    # and Lakebase afresh. Bypass the response cache so completion cannot be hidden.
    if not progress and _poll_cache is not None and time.monotonic() - _poll_cache[0] < 1:
        return _poll_cache[1]
    if _poll_task is None or _poll_task.done():
        _poll_task = asyncio.create_task(_refresh())
    return await asyncio.shield(_poll_task)


@router.post("/delta-change")
def delta_change(body: DeltaChangeIn):
    global _poll_cache, _revision
    if lock.locked():
        raise HTTPException(409, "Another sync change is running; retry shortly")
    revision = _revision
    current = _pending()
    # Prepare candidates without reserving mutation access or blocking polling.
    candidates = dbsql(f"SELECT row_id, demo_value FROM {uc(TABLE)} WHERE tag = :tag "
                       "ORDER BY CASE WHEN row_id LIKE 'seed-%' THEN 0 ELSE 1 END, row_id", {"tag": TAG}) if body.op != "insert" else []
    with mutation():
        if revision != _revision:
            raise HTTPException(409, "Delta changed while preparing this operation; retry")
        # Invalidate preparations even if a write fails after advancing the durable cursor.
        _revision += 1
        _poll_cache = None
        if current["sync_complete"]:
            # Advance only after completed sync; persist the cursor before the Delta commit for crash recovery.
            pg("UPDATE sync_experiment.batch SET base_version=%(v)s WHERE id=1",
               {"v": current["delta_version"]})
        before = None
        pk = str(uuid.uuid4())
        if body.op != "insert":
            # Prefer untouched baseline rows, so Insert→Update→Delete shows three distinct stale keys.
            touched = {r["pk"] for r in current["pending"]} if not current["sync_complete"] else set()
            row = next((r for r in candidates if r["row_id"] not in touched), candidates[0] if candidates else None)
            if row is None:
                # If empty, create a tagged candidate first. An insert+delete can net to absent on both sides.
                dbsql(f"INSERT INTO {uc(TABLE)} VALUES (:pk, 100, :tag)", {"pk": pk, "tag": TAG})
                before = 100
            else:
                pk, before = row["row_id"], row["demo_value"]
        params = {"pk": pk, "tag": TAG}
        if body.op == "insert":
            after = 100
            dbsql(f"INSERT INTO {uc(TABLE)} VALUES (:pk, 100, :tag)", params)
        elif body.op == "update":
            after = before + 10
            dbsql(f"UPDATE {uc(TABLE)} SET demo_value = demo_value + 10 WHERE row_id = :pk AND tag = :tag", params)
        else:
            after = None
            dbsql(f"DELETE FROM {uc(TABLE)} WHERE row_id = :pk AND tag = :tag", params)
    _poll_cache = None
    result = _pending()
    version = max((c["delta_version"] for c in result["pending"] if c["pk"] == pk and c["op"] == body.op),
                  default=result["delta_version"])
    return {**result, "change": {"op": body.op, "pk": pk, "before": before, "after": after,
                                "delta_version": version}}


@router.post("/daily-batch")
def daily_batch():
    """One bounded, atomic Delta commit; only one outstanding daily batch."""
    global _poll_cache, _revision
    if lock.locked():
        raise HTTPException(409, "Another sync change is running; retry shortly")
    revision = _revision
    current = _pending()
    if not current["sync_complete"]:
        raise HTTPException(409, "Sync the current changes before starting a new daily batch")
    candidates = dbsql(f"SELECT row_id, demo_value FROM {uc(TABLE)} WHERE tag = :tag", {"tag": TAG})
    if len(candidates) < 40:
        raise HTTPException(409, "Demo baseline is not ready; restart the app to provision it, then sync")
    inserts, updates, deletes = random.randint(250, 400), random.randint(15, 35), random.randint(1, 5)
    selected = random.sample(candidates, updates + deletes)
    changes = [{"row_id": str(uuid.uuid4()), "demo_value": random.randint(1, 1000), "op": "insert"}
               for _ in range(inserts)]
    changes += [{"row_id": row["row_id"], "demo_value": row["demo_value"] + random.randint(1, 100),
                 "op": "update" if index < updates else "delete"} for index, row in enumerate(selected)]
    with mutation():
        if revision != _revision:
            raise HTTPException(409, "Delta changed while preparing this batch; retry")
        _revision += 1
        _poll_cache = None
        pg("UPDATE sync_experiment.batch SET base_version=%(v)s WHERE id=1", {"v": current["delta_version"]})
        # Disjoint keys make every generated operation one real row change in a single commit.
        dbsql(f"""MERGE INTO {uc(TABLE)} AS target
            USING (SELECT explode(from_json(:changes,
                'ARRAY<STRUCT<row_id:STRING,demo_value:INT,op:STRING>>')) AS change) AS source
            ON target.row_id = source.change.row_id AND target.tag = :tag
            WHEN MATCHED AND source.change.op = 'delete' THEN DELETE
            WHEN MATCHED AND source.change.op = 'update' THEN UPDATE SET demo_value = source.change.demo_value
            WHEN NOT MATCHED AND source.change.op = 'insert' THEN INSERT (row_id, demo_value, tag)
                VALUES (source.change.row_id, source.change.demo_value, :tag)""",
            {"changes": json.dumps(changes), "tag": TAG})
    _poll_cache = None
    return _pending()
