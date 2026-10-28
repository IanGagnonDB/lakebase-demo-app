"""Lakebase project operations via the SDK (branches, endpoints) and per-branch connection pools."""
from datetime import UTC, datetime

from databricks.sdk.common.types.fieldmask import FieldMask
from databricks.sdk.service import postgres as pg
from db import S, lakebase_pool, pg_query, w
from google.protobuf.duration_pb2 import Duration
from google.protobuf.timestamp_pb2 import Timestamp

PROJECT = f"projects/{S['LAKEBASE_PROJECT']}"
_pools: dict = {}


def branch_path(branch_id: str) -> str:
    return f"{PROJECT}/branches/{branch_id}"


def list_branches() -> list[str]:
    return [b.name.rsplit("/", 1)[-1] for b in w.postgres.list_branches(parent=PROJECT)]


def recreate_branch(branch_id: str, *, source_time: datetime | None = None, ttl_s: int | None = None) -> None:
    """Create (or replace) `branch_id` from production — now, or as of `source_time` (point-in-time restore)."""
    if branch_id == "production":
        raise ValueError("Cannot recreate production")
    spec = pg.BranchSpec(source_branch=branch_path("production"))
    if ttl_s:
        spec.ttl = Duration(seconds=ttl_s)
    else:
        spec.no_expiry = True
    if source_time is not None:
        spec.source_branch_time = Timestamp()
        spec.source_branch_time.FromDatetime(source_time.astimezone(UTC).replace(tzinfo=None))
    drop_pool(branch_id)
    if branch_id in list_branches():
        # replace_existing only updates the spec in place; a real reset means delete (purged, so the id
        # can be reused) and create again.
        w.postgres.delete_branch(name=branch_path(branch_id), purge=True).wait()
    w.postgres.create_branch(parent=PROJECT, branch=pg.Branch(spec=spec), branch_id=branch_id).wait()


def endpoint(branch_id: str):
    """The branch's read-write endpoint; created with the project defaults if branching didn't create one."""
    eps = list(w.postgres.list_endpoints(parent=branch_path(branch_id)))
    if eps:
        return eps[0]
    spec = pg.EndpointSpec(endpoint_type=pg.EndpointType.ENDPOINT_TYPE_READ_WRITE)
    return w.postgres.create_endpoint(parent=branch_path(branch_id), endpoint=pg.Endpoint(spec=spec),
                                      endpoint_id="primary").wait()


def set_endpoint(branch_id: str, *, min_cu: float, max_cu: float, always_on: bool) -> None:
    ep = endpoint(branch_id)
    spec = pg.EndpointSpec(endpoint_type=pg.EndpointType.ENDPOINT_TYPE_READ_WRITE,
                           autoscaling_limit_min_cu=min_cu, autoscaling_limit_max_cu=max_cu, no_suspension=always_on)
    w.postgres.update_endpoint(name=ep.name, endpoint=pg.Endpoint(spec=spec), update_mask=FieldMask(
        ["spec.autoscaling_limit_min_cu", "spec.autoscaling_limit_max_cu", "spec.no_suspension"])).wait()


def branch_pool(branch_id: str):
    if branch_id not in _pools:
        ep = endpoint(branch_id)
        pool = lakebase_pool(ep.status.hosts.host, ep.name, max_size=16)
        # Concurrent first use (e.g. the burst's 16 workers) can race here: keep one pool, close the rest.
        if _pools.setdefault(branch_id, pool) is not pool:
            pool.close()
    return _pools[branch_id]


def drop_pool(branch_id: str) -> None:
    pool = _pools.pop(branch_id, None)
    if pool is not None:
        pool.close()


def pg_on(branch_id: str, sql: str, params: dict | None = None) -> list[dict]:
    """Run a query on a non-production branch (demo / restore)."""
    return pg_query(branch_pool(branch_id), sql, params)[0]
