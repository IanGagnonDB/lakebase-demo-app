"""Optional allocation observations from system tables; never connects to Lakebase."""
import math
import threading
import time
from datetime import datetime, timezone

_lock = threading.Lock()
_cache = {}


def error_status(exc):
    """Classify known SQL errors without treating every failure as a missing table."""
    code = str(getattr(exc, "error_code", ""))
    state = str(getattr(exc, "sqlstate", "") or getattr(exc, "sql_state", ""))
    message = str(exc)
    if state in {"42P01", "3F000"} or any(c in code or f"[{c}]" in message for c in (
            "TABLE_OR_VIEW_NOT_FOUND", "SCHEMA_NOT_FOUND", "SCHEMA_DOES_NOT_EXIST", "TABLE_DOES_NOT_EXIST")):
        return "missing_table"
    if state == "42501" or any(c in code or f"[{c}]" in message for c in (
            "PERMISSION_DENIED", "INSUFFICIENT_PERMISSIONS", "INSUFFICIENT_PRIVILEGES", "UNAUTHORIZED_ACCESS")):
        return "permission_denied"
    return "temporarily_unavailable"


def unavailable(status):
    return {"status": status, "sample_at": None, "memory_bytes": None, "estimated_cu": None}


def allocation(endpoint_uid, query):
    # Share successful reads and back off failed reads across all viewers.
    with _lock:
        cached = _cache.get(endpoint_uid)
        if cached and time.monotonic() < cached[0]:
            return cached[1]
        try:
            rows = query("""SELECT ts, host_memory_total_bytes
                FROM system.lakebase.compute_gauges
                WHERE endpoint_id = :endpoint_id
                  AND ts >= current_timestamp() - INTERVAL 30 MINUTES
                  AND compute_mode = 'primary'
                ORDER BY ts DESC LIMIT 1""", {"endpoint_id": endpoint_uid})
        except Exception as exc:
            result = unavailable(error_status(exc))
            _cache[endpoint_uid] = (time.monotonic() + 30, result)
            return result
        result = unavailable("no_samples")
        if rows:
            row = rows[0]
            memory = float(row["host_memory_total_bytes"] or 0)
            ts = row["ts"]
            if isinstance(ts, datetime):
                ts = ts.replace(tzinfo=ts.tzinfo or timezone.utc).isoformat()
            if ts and math.isfinite(memory) and memory > 0:
                # Approximation: 1 CU provides ~2 GiB; guest-visible memory excludes overhead.
                result = {"status": "ready", "sample_at": ts, "memory_bytes": memory,
                          "estimated_cu": round(memory / (2 * 1024**3) * 2) / 2}
        _cache[endpoint_uid] = (time.monotonic() + 10, result)
        return result
