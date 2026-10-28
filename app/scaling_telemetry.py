"""Allocation observations from system tables; never connects to Lakebase."""
import math
import threading
import time
from datetime import datetime, timezone

_lock = threading.Lock()
_cache = {}


def allocation(endpoint_uid, query):
    # Share warehouse reads across viewers; failures retry on the next poll.
    with _lock:
        cached = _cache.get(endpoint_uid)
        if cached and time.monotonic() - cached[0] < 10:
            return cached[1]
        rows = query("""SELECT ts, host_memory_total_bytes
            FROM system.lakebase.compute_gauges
            WHERE endpoint_id = :endpoint_id
              AND ts >= current_timestamp() - INTERVAL 30 MINUTES
              AND compute_mode = 'primary'
            ORDER BY ts DESC LIMIT 1""", {"endpoint_id": endpoint_uid})
        result = {"sample_at": None, "memory_bytes": None, "estimated_cu": None}
        if rows:
            row = rows[0]
            memory = float(row["host_memory_total_bytes"] or 0)
            ts = row["ts"]
            if isinstance(ts, datetime):
                ts = ts.replace(tzinfo=ts.tzinfo or timezone.utc).isoformat()
            if math.isfinite(memory) and memory > 0:
                # Approximation: 1 CU provides ~2 GiB; guest-visible memory excludes overhead.
                result = {"sample_at": ts, "memory_bytes": memory,
                          "estimated_cu": round(memory / (2 * 1024**3) * 2) / 2}
        _cache[endpoint_uid] = (time.monotonic(), result)
        return result
