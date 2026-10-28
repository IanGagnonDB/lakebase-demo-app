"""Bounded readiness checks using metadata and small, read-only compute probes."""
import logging
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, wait
from dataclasses import dataclass
from datetime import datetime, timezone

from databricks.sdk.errors import NotFound, PermissionDenied

from readiness_reads import ReadFailure, Reads

log = logging.getLogger(__name__)


@dataclass
class Check:
    id: str
    group: str
    label: str
    source: str
    action: str
    run: object
    missing_is_unknown: bool = False
    timeout: float = 5


def verdict(status, detail, state_note=None):
    return (status, detail, state_note) if state_note else (status, detail)


def state(value):
    return getattr(value, "value", value)


def evaluate(check):
    state_note = None
    try:
        result = check.run()
        status, detail = result[:2]
        state_note = result[2] if len(result) > 2 else None
    except ReadFailure as exc:
        log.exception("Readiness query failed: %s", check.id)
        status, detail = exc.status, exc.detail
    except PermissionDenied:
        log.exception("Readiness permission denied: %s", check.id)
        status, detail = "unable_to_verify", "The app identity cannot read this metadata; an administrator may need to verify it."
    except NotFound as exc:
        log.exception("Readiness metadata not found: %s", check.id)
        unknown = check.missing_is_unknown or getattr(exc, "error_code", None) in {"ENDPOINT_NOT_FOUND", "API_NOT_FOUND"}
        status = "unable_to_verify" if unknown else "not_ready"
        detail = "The settings API or setting is unavailable." if unknown else "The required resource was not found."
    except Exception:
        log.exception("Readiness check failed: %s", check.id)
        status, detail = "unable_to_verify", "The metadata request failed or timed out; retry or ask an administrator to verify access."
    row = {"id": check.id, "group": check.group, "label": check.label, "status": status,
            "detail": detail, "action": check.action if status != "ready" else "", "source": check.source}
    if state_note:
        row["state_note"] = state_note
    return row


def checks(w, settings, reads=None):
    s = settings
    project = f"projects/{s['LAKEBASE_PROJECT']}"
    production = f"{project}/branches/production"
    result = []
    reads = reads or Reads(w, s)

    def add(id, label, source, action, run, group="resource", unknown=False, timeout=5):
        result.append(Check(id, group, label, source, action, run, unknown, timeout))

    def warehouse():
        status = state(w.warehouses.get(s["DATABRICKS_WAREHOUSE_ID"]).state)
        if status is None:
            return verdict("unable_to_verify", "Warehouse state was not returned.")
        if status == "STOPPED":
            return verdict("ready", "Stopped — starts automatically on the next query.", "Stopped")
        return verdict("ready" if status == "RUNNING" else "not_ready", f"Warehouse is {status.lower()}. This check does not start it.")
    add("warehouse", "SQL warehouse", "warehouses.get (GET)", "Start the configured SQL warehouse in Databricks when you are ready to run the workshop.", warehouse)

    def project_check():
        w.postgres.get_project(name=project)
        return verdict("ready", "Lakebase project is accessible.")
    add("project", "Lakebase project", "postgres.get_project (GET)", "Verify the configured project exists and grant the app access to it.", project_check)

    for branch in ("production", "demo"):
        def branch_check(branch=branch):
            b = w.postgres.get_branch(name=f"{project}/branches/{branch}")
            current = state(getattr(b.status, "current_state", None))
            if current is None:
                return verdict("unable_to_verify", "Branch state was not returned.")
            return verdict("ready" if current == "READY" else "not_ready", f"Branch state is {current.lower()}.")
        add(f"branch_{branch}", f"{branch.title()} branch", "postgres.get_branch (GET)", "Review branch provisioning and project permissions; recreate the demo branch with the workshop setup if missing.", branch_check)

        def endpoint_check(branch=branch):
            endpoints = list(w.postgres.list_endpoints(parent=f"{project}/branches/{branch}"))
            if branch == "production":
                endpoints = [e for e in endpoints if e.name == s["LAKEBASE_ENDPOINT"]]
            if not endpoints:
                return verdict("not_ready", "No configured endpoint was found.")
            ep = endpoints[0].status
            current = state(getattr(ep, "current_state", None))
            if getattr(ep, "disabled", False):
                return verdict("not_ready", "Endpoint is disabled.")
            if current == "IDLE":
                return verdict("ready", "Suspended — wakes on the next query.", "Suspended")
            if current is None:
                return verdict("unable_to_verify", "Endpoint state was not returned.")
            return verdict("ready" if current == "ACTIVE" else "not_ready", f"Endpoint state is {current.lower()}.")
        add(f"endpoint_{branch}", f"{branch.title()} endpoint", "postgres.list_endpoints (GET)", "Review the branch endpoint in Databricks. Suspension is expected for the cold-start demo; run a workshop query only when ready.", endpoint_check)

    def pitr():
        p = w.postgres.get_project(name=project)
        duration = getattr(p.status, "history_retention_duration", None)
        if duration is None:
            return verdict("unable_to_verify", "History retention was not returned.")
        if duration.seconds <= 0:
            return verdict("not_ready", "Project history retention is disabled.")
        branch = w.postgres.get_branch(name=production)
        created = getattr(branch, "create_time", None)
        if created is None:
            return verdict("unable_to_verify", "Branch creation time was not returned.")
        from datetime import timedelta
        created_at = created.ToDatetime(tzinfo=timezone.utc)
        try:
            row = reads.pg("SELECT CURRENT_TIMESTAMP AS now, before_ts, cardinality(ids) AS saved_ids "
                           "FROM (SELECT 1) anchor LEFT JOIN workshop_control.pitr_recovery ON id=1")[0]
        except ReadFailure as exc:
            if exc.status == "not_ready":
                log.exception("PITR recovery table is missing")
                return verdict("not_ready", f"{duration.seconds // 86400}-day retention is configured, but the PITR recovery table is missing. The exact restore boundary cannot be confirmed.")
            raise
        lower = max(created_at, row["now"] - timedelta(seconds=duration.seconds))
        if row["before_ts"] is not None:
            if not lower <= row["before_ts"] <= row["now"]:
                return verdict("not_ready", "The saved recovery timestamp is outside the configured retention bounds.")
            if not row["saved_ids"]:
                return verdict("not_ready", "The pending restore has no saved recovery row IDs.")
            return verdict("warning", "Saved recovery timestamp and row IDs are readable and within configured retention bounds. The exact provider restore boundary is not exposed by this API.")
        return verdict("ready", f"{duration.seconds // 86400}-day history retention and recovery-table read access verified; no pending restore. Exact provider restore boundary is not exposed by this API.")
    add("pitr", "PITR retention and recovery", "postgres project/branch GET + PostgreSQL SELECT (may wake compute)", "Complete the app control-metadata provisioning step and keep history retention enabled. If a saved timestamp has expired, start a new PITR demonstration; branch creation remains the final restore test.", pitr, timeout=10)

    def schemas():
        w.catalogs.get(s["CATALOG"])
        for name in (s["SCHEMA"], s["BRONZE_SCHEMA"]):
            w.schemas.get(f"{s['CATALOG']}.{name}")
        w.catalogs.get(s["LAKEBASE_CATALOG"])
        return verdict("ready", "Source and history schemas and the Lakebase catalog are accessible.")
    add("schemas", "Unity Catalog schemas", "catalogs.get / schemas.get (GET)", "Run workshop setup and grant the app USE CATALOG, USE SCHEMA and the required table privileges.", schemas)

    for table in ("reps", "accounts", "targets", "opportunities", "activities", "sync_demo"):
        def table_check(table=table):
            info = w.tables.get(f"{s['CATALOG']}.{s['SCHEMA']}.{table}")
            if table in ("reps", "accounts", "targets", "sync_demo"):
                prop = (info.properties or {}).get("delta.enableChangeDataFeed")
                if prop is None:
                    return verdict("unable_to_verify", "Table exists, but Delta CDF configuration was not returned.")
                if prop.lower() != "true":
                    return verdict("not_ready", "Source table exists, but Delta CDF is disabled.")
            return verdict("ready", "Source table metadata is accessible; row counts were not queried.")
        add(f"source_{table}", f"Source table: {table}", "tables.get (GET)", "Run the workshop setup job and enable Delta change data feed on synced source tables; verify SELECT and MODIFY grants.", table_check)

    for table in ("reps", "accounts", "targets", "sync_demo"):
        def synced(table=table):
            st = w.postgres.get_synced_table(name=f"synced_tables/{s['LAKEBASE_CATALOG']}.ref.{table}")
            status = st.status
            pipeline = getattr(status, "pipeline_id", None)
            if not pipeline:
                return verdict("not_ready", "Synced table has no pipeline yet.")
            p = w.pipelines.get(pipeline_id=pipeline)
            detail = state(getattr(status, "detailed_state", None))
            if detail is None:
                return verdict("unable_to_verify", "Pipeline exists, but sync state was not returned.")
            if any(x in detail for x in ("FAIL", "ERROR", "DELET")):
                return verdict("not_ready", "Synced table reports a failed or deleting state.")
            if "OFFLINE" in detail:
                return verdict("not_ready", "Synced table is offline.")
            if detail != "SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE":
                return verdict("warning", "Sync is provisioning or in progress; data freshness is not confirmed.")
            if state(getattr(p, "state", None)) == "FAILED":
                return verdict("not_ready", "The sync pipeline reports failure.")
            return verdict("ready", "Synced table reports synced; its pipeline is accessible. Triggered pipelines may be idle.")
        add(f"sync_{table}", f"Synced table + pipeline: {table}", "postgres.get_synced_table / pipelines.get (GET)", "Review the sync pipeline and app pipeline permissions; complete provisioning or trigger a sync from the workshop when ready.", synced)

    def cdf():
        dbs = list(w.postgres.list_databases(parent=production))
        db = next((d for d in dbs if getattr(d.status, "postgres_database", None) == s["PGDATABASE"]), None)
        if db is None:
            return verdict("not_ready", "The configured PostgreSQL database was not found.")
        configs = list(w.postgres.list_cdf_configs(parent=db.name))
        found = any(c.postgres_schema == "app" and c.catalog == s["CATALOG"] and c.schema == s["BRONZE_SCHEMA"] for c in configs)
        return verdict("ready" if found else "not_ready", "Application CDF export is configured." if found else "No matching application CDF export was found.")
    add("cdf_feed", "Lakebase CDF feed", "postgres.list_databases / list_cdf_configs (GET)", "Enable Lakebase CDF and complete the app CDF provisioning step for the application schema and history destination.", cdf)

    for table in ("activities", "opportunities"):
        def history(table=table):
            w.tables.get(f"{s['CATALOG']}.{s['BRONZE_SCHEMA']}.lb_{table}_history")
            return verdict("ready", "CDF history table exists; ingestion freshness was not queried.")
        add(f"history_{table}", f"CDF history: {table}", "tables.get (GET)", "Verify the CDF feed, destination permissions and ingestion health; history tables appear after CDF initialization.", history)

    for n in (100_000, 1_000_000, 2_000_000, 5_000_000):
        def tier(n=n):
            table = f"activities_history_{n}"
            w.tables.get(f"{s['CATALOG']}.{s['SCHEMA']}.{table}")
            st = w.postgres.get_synced_table(name=f"synced_tables/{s['LAKEBASE_CATALOG']}.ref.{table}")
            detail = state(getattr(st.status, "detailed_state", None))
            if detail is None:
                return verdict("unable_to_verify", "Benchmark snapshot sync state was not returned.")
            if any(x in detail for x in ("FAIL", "ERROR", "OFFLINE")):
                return verdict("not_ready", "Benchmark snapshot is offline or failed.")
            pipeline = getattr(st.status, "pipeline_id", None)
            if not pipeline:
                return verdict("not_ready", "Benchmark snapshot has no pipeline yet.")
            if state(getattr(w.pipelines.get(pipeline_id=pipeline), "state", None)) == "FAILED":
                return verdict("not_ready", "Benchmark snapshot pipeline reports failure.")
            if detail != "SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE":
                return verdict("warning", "Benchmark snapshot is updating or provisioning.")
            if not reads.pg(f"SELECT EXISTS (SELECT 1 FROM ref.{table} LIMIT 1) AS populated")[0]["populated"]:
                return verdict("not_ready", "Benchmark snapshot has no rows.")
            return verdict("ready", "Source metadata, snapshot pipeline and PostgreSQL sample read verified; snapshot contains rows.")
        add(f"history_tier_{n}", f"Benchmark snapshot: {n:,} rows", "tables/synced table/pipeline GET + PostgreSQL SELECT (may wake compute)", "Run setup for this history tier and complete its snapshot sync; verify app SELECT access.", tier, timeout=10)

    def seed():
        row = reads.pg("SELECT EXISTS (SELECT 1 FROM app.activities LIMIT 1) AS activities, "
                       "EXISTS (SELECT 1 FROM app.opportunities LIMIT 1) AS opportunities")[0]
        if not row["activities"] or not row["opportunities"]:
            return verdict("not_ready", "Application activities or opportunities have no seeded rows.")
        return verdict("ready", "Activities and opportunities contain seeded rows; PostgreSQL SELECT access verified.")
    add("seed", "Seeded application data", "PostgreSQL SELECT (may wake compute)", "Complete application schema/seed provisioning and verify the app database SELECT privileges.", seed, timeout=10)

    def controls():
        tables = ("branch_control.reset_recovery", "sync_experiment.batch", "workshop_control.reset_state", "workshop_control.pitr_recovery")
        row = reads.pg("SELECT " + ", ".join(f"to_regclass('{table}') IS NOT NULL AS t{i}" for i, table in enumerate(tables)))[0]
        missing = [table for i, table in enumerate(tables) if not row[f"t{i}"]]
        if missing:
            return verdict("not_ready", "Control tables missing: " + ", ".join(missing) + ".")
        row = reads.pg("SELECT " + ", ".join(f"EXISTS (SELECT 1 FROM {table} LIMIT 1) AS t{i}" for i, table in enumerate(tables)))[0]
        if not row["t2"]:
            return verdict("ready", "Control tables readable · no reset has run yet")
        return verdict("ready", "All four control tables are readable and reset state exists.")
    add("controls", "Workshop control tables", "PostgreSQL SELECT / to_regclass (may wake compute)", "Restart the app so provisioning recreates the control tables, then verify database SELECT access.", controls, timeout=10)

    def autoscaling():
        w.postgres.get_project(name=project)
        return verdict("ready", "An Autoscaling Lakebase project is accessible. No separate Autoscaling preview key was published in workspace metadata.")
    add("preview_autoscaling", "Lakebase Postgres Autoscaling", "postgres.get_project (GET), capability probe", "Ask an administrator to verify Lakebase Autoscaling availability and project access; no separate setting identifier was confirmed.", autoscaling, "preview", True)

    for id, label, key in (("preview_cdf", "Lakebase CDF", "lakebase_cdf"), ("preview_observability", "Lakebase Observability in System Tables", "lakebase_system_table_o11y")):
        def preview(key=key):
            setting = w.workspace_settings_v2.get_public_workspace_setting(name=key)
            value = getattr(getattr(setting, "effective_boolean_val", None), "value", None)
            if value is None:
                return verdict("unable_to_verify", "The settings API did not return an effective preview value.")
            return verdict("ready" if value else "not_ready", "Preview is enabled for this workspace." if value else "Preview is disabled for this workspace.")
        add(id, label, f"workspace_settings_v2.get_public_workspace_setting (GET): {key}", "Ask a workspace administrator to verify this preview in Settings > Previews and the app identity’s permission to read settings.", preview, "preview", True)

    def observability_table():
        w.tables.get("system.lakebase.compute_gauges")
        ep = w.postgres.get_endpoint(name=s["LAKEBASE_ENDPOINT"])
        uid = getattr(ep, "uid", None)
        if not uid:
            return verdict("unable_to_verify", "The endpoint identifier needed for telemetry was not returned.")
        uid = uid.replace("'", "''")
        rows = reads.sql("SELECT max(ts) AS latest FROM system.lakebase.compute_gauges "
                         f"WHERE endpoint_id = '{uid}' AND ts >= current_timestamp() - INTERVAL 30 MINUTES")
        if not rows or not rows[0]["latest"]:
            return verdict("warning", "Telemetry SELECT access verified; no endpoint sample in the last 30 minutes. Collection may lag or compute may have been idle.")
        return verdict("ready", "Telemetry SELECT access verified with an endpoint sample from the last 30 minutes.")
    add("telemetry", "Scaling telemetry access and freshness", "Warehouse SELECT: system.lakebase.compute_gauges (may wake compute)", "Verify observability capture and app SELECT/USE grants; allow time for ingestion after waking the endpoint.", observability_table, timeout=10)
    return result


class ReadinessService:
    """Single flight, 15-second cache; bounded daemon workers survive SDK retries safely."""
    def __init__(self, ttl=15, timeout=12, capacity=32):
        self.ttl, self.timeout = ttl, timeout
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(capacity)
        self._cache = None
        self._at = 0
        self._flight = None

    def get(self, checks):
        with self._lock:
            if self._cache and time.monotonic() - self._at < self.ttl:
                return self._cache
            if self._flight is None:
                self._flight = threading.Event()
                owner = True
            else:
                owner = False
            flight = self._flight
        if not owner:
            if flight.wait(self.timeout + 1):
                with self._lock:
                    return self._cache
            return self._result([self._timeout(c) for c in checks])
        try:
            futures = []
            started = time.monotonic()
            for check in checks:
                f = Future()
                if self._slots.acquire(blocking=False):
                    def run(check=check, f=f):
                        try:
                            f.set_result((evaluate(check), time.monotonic() - started))
                        finally:
                            self._slots.release()
                    threading.Thread(target=run, daemon=True).start()
                else:
                    f.set_result((self._timeout(check), 0))
                futures.append(f)
            pending = set(futures)
            while pending:
                elapsed = time.monotonic() - started
                pending = {f for c, f in zip(checks, futures) if f in pending and not f.done() and elapsed < min(c.timeout, self.timeout)}
                if pending:
                    remaining = min(min(c.timeout, self.timeout) - elapsed for c, f in zip(checks, futures) if f in pending)
                    wait(pending, timeout=max(0, remaining), return_when=FIRST_COMPLETED)
            result = self._result([f.result()[0] if f.done() and f.result()[1] <= min(c.timeout, self.timeout) else self._timeout(c) for c, f in zip(checks, futures)])
            with self._lock:
                self._cache, self._at = result, time.monotonic()
            return result
        finally:
            with self._lock:
                self._flight = None
                flight.set()

    @staticmethod
    def _timeout(c):
        log.warning("Readiness deadline exceeded or worker capacity exhausted: %s", c.id)
        return {"id": c.id, "group": c.group, "label": c.label, "status": "unable_to_verify",
                "detail": "The metadata check exceeded its time budget or is still busy. Retry shortly.",
                "action": c.action, "source": c.source}

    @staticmethod
    def _result(rows):
        return {"checked_at": datetime.now(timezone.utc).isoformat(), "checks": rows}


service = ReadinessService()
