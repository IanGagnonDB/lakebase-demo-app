"""One-time setup, run as the app service principal when the app starts. Safe to re-run:
every step checks whether its object already exists. Results show up in /api/meta."""
import logging
import time
from pathlib import Path

import ops
from databricks.sdk.errors import NotFound
from databricks.sdk.service import postgres as pg
from db import S, dbsql, prod, uc, w
from db import pg as pg_sql

log = logging.getLogger("provision")
STATUS: dict[str, str] = {}
OPP_COLS = "opportunity_id, account_id, rep_id, name, service_line, stage, amount, close_date, updated_at"
ACT_COLS = "activity_id, rep_id, account_id, activity_type, activity_ts, notes"
SYNCED = {"reps": ["rep_id"], "accounts": ["account_id"], "targets": ["rep_id", "quarter"], "sync_demo": ["row_id"]}


def synced_id(table: str) -> str:
    return f"{S['LAKEBASE_CATALOG']}.ref.{table}"


def _schema():
    with prod.connection() as conn:
        conn.execute((Path(__file__).parent / "schema.sql").read_text())


def _control_metadata():
    # Singleton control records, separate from the workshop's application data.
    pg_sql("CREATE SCHEMA IF NOT EXISTS branch_control")
    pg_sql("CREATE TABLE IF NOT EXISTS branch_control.reset_recovery "
           "(id int PRIMARY KEY CHECK (id=1), snapshot jsonb NOT NULL)")
    pg_sql("CREATE SCHEMA IF NOT EXISTS sync_experiment")
    pg_sql("CREATE TABLE IF NOT EXISTS sync_experiment.batch "
           "(id int PRIMARY KEY CHECK (id=1), base_version bigint NOT NULL)")

    pg_sql("CREATE SCHEMA IF NOT EXISTS workshop_control")
    pg_sql("CREATE TABLE IF NOT EXISTS workshop_control.reset_state "
           "(id int PRIMARY KEY CHECK (id=1), state jsonb NOT NULL)")
    pg_sql("CREATE TABLE IF NOT EXISTS workshop_control.pitr_recovery "
           "(id int PRIMARY KEY CHECK (id=1), before_ts timestamptz NOT NULL, ids bigint[] NOT NULL)")


def _reset_control():
    import demo_reset
    demo_reset.initialize()


def _seed():
    if pg_sql("SELECT count(*) AS n FROM app.activities")[0]["n"]:
        return "already seeded"
    with prod.connection() as conn, conn.transaction(), conn.cursor() as cur:
        for table, cols in (("opportunities", OPP_COLS), ("activities", ACT_COLS)):
            rows = dbsql(f"SELECT {cols} FROM {uc(table)}")
            with cur.copy(f"COPY app.{table} ({cols}) FROM STDIN") as copy:
                for r in rows:
                    copy.write_row(list(r.values()))
        cur.execute("SELECT setval(pg_get_serial_sequence('app.activities', 'activity_id'), "
                    "(SELECT max(activity_id) FROM app.activities))")
    return "seeded"


def _production_size():
    ops.set_endpoint("production", min_cu=1, max_cu=4, always_on=True)


def _sync_demo_source():
    available = {r["tableName"] for r in dbsql(f"SHOW TABLES IN `{S['CATALOG']}`.`{S['SCHEMA']}`")}
    if "sync_demo" not in available:
        dbsql(f"CREATE TABLE IF NOT EXISTS {uc('sync_demo')} "
              "(row_id STRING, demo_value INT, tag STRING) USING DELTA "
              "TBLPROPERTIES (delta.enableChangeDataFeed = true)")
        dbsql(f"INSERT INTO {uc('sync_demo')} VALUES "
              "('seed-delete', 100, 'synced-tab-demo'), ('seed-update', 200, 'synced-tab-demo')")

    # Upgrade existing two-row demos as well as fresh installs. Avoid touching normal scorecard data.
    count = dbsql(f"SELECT count(*) AS n FROM {uc('sync_demo')} WHERE tag = :tag", {"tag": "synced-tab-demo"})
    if int(count[0]["n"]) < 40:
        dbsql(f"INSERT INTO {uc('sync_demo')} SELECT concat('baseline-', uuid()), CAST(id + 100 AS INT), "
              "'synced-tab-demo' FROM range(100)")


def _sync_table(table, pk):
    try:
        w.postgres.get_synced_table(name=f"synced_tables/{synced_id(table)}")
    except NotFound:
        spec = pg.SyncedTableSyncedTableSpec(
            branch=ops.branch_path("production"), postgres_database=S["PGDATABASE"],
            source_table_full_name=f"{S['CATALOG']}.{S['SCHEMA']}.{table}", primary_key_columns=pk,
            scheduling_policy=pg.SyncedTableSyncedTableSpecSyncedTableSchedulingPolicy.TRIGGERED,
            create_database_objects_if_missing=True,
            # Pipeline state must live on real storage: the Lakebase catalog has none, and the
            # metastore may have no root, so pin it to the workshop's own (external) schema.
            new_pipeline_spec=pg.NewPipelineSpec(storage_catalog=S["CATALOG"], storage_schema=S["SCHEMA"]))
        w.postgres.create_synced_table(synced_table=pg.SyncedTable(spec=spec), synced_table_id=synced_id(table)).wait()


def _synced_tables():
    for table, pk in SYNCED.items():
        if table != "sync_demo":
            _sync_table(table, pk)
    try:
        _sync_demo_source()
        _sync_table("sync_demo", SYNCED["sync_demo"])
    except Exception as exc:
        STATUS["sync_demo"] = f"error: {exc}"
        log.exception("sync_demo provisioning failed")


def _history_tables():
    # Snapshot history is immutable. Do not let analytics sync failure block existing features.
    available = {r["tableName"] for r in dbsql(f"SHOW TABLES IN `{S['CATALOG']}`.`{S['SCHEMA']}`")}
    for n in (100_000, 1_000_000, 2_000_000, 5_000_000):
        table = f"activities_history_{n}"
        if table not in available:
            continue
        try:
            w.postgres.get_synced_table(name=f"synced_tables/{synced_id(table)}")
        except NotFound:
            started = time.perf_counter()
            STATUS[table] = "syncing"
            spec = pg.SyncedTableSyncedTableSpec(
                branch=ops.branch_path("production"), postgres_database=S["PGDATABASE"],
                source_table_full_name=f"{S['CATALOG']}.{S['SCHEMA']}.{table}", primary_key_columns=["history_id"],
                scheduling_policy=pg.SyncedTableSyncedTableSpecSyncedTableSchedulingPolicy.SNAPSHOT,
                create_database_objects_if_missing=True,
                new_pipeline_spec=pg.NewPipelineSpec(storage_catalog=S["CATALOG"], storage_schema=S["SCHEMA"]))
            w.postgres.create_synced_table(synced_table=pg.SyncedTable(spec=spec),
                                          synced_table_id=synced_id(table)).wait()
            STATUS[table] = f"sync submitted in {time.perf_counter() - started:.1f}s; check synced-table status for readiness"


def database_path() -> str:
    for d in w.postgres.list_databases(parent=ops.branch_path("production")):
        if d.status.postgres_database == S["PGDATABASE"]:
            return d.name
    raise NotFound(S["PGDATABASE"])


def _cdf():
    db_path = database_path()
    if any(c.postgres_schema == "app" for c in w.postgres.list_cdf_configs(parent=db_path)):
        return "already configured"
    w.postgres.create_cdf_config(parent=db_path, cdf_config_id="workshop_app", cdf_config=pg.CdfConfig(
        catalog=S["CATALOG"], schema=S["BRONZE_SCHEMA"], postgres_schema="app")).wait()


def _demo_branch():
    if "demo" in ops.list_branches():
        return "already exists"
    ops.recreate_branch("demo")
    ops.endpoint("demo")


STEPS = [("schema", _schema), ("control_metadata", _control_metadata), ("seed", _seed), ("production_size", _production_size),
         ("synced_tables", _synced_tables), ("cdf", _cdf), ("demo_branch", _demo_branch), ("reset_control", _reset_control), ("history_tables", _history_tables)]


def run() -> None:
    for name, step in STEPS:
        STATUS[name] = "running"
        try:
            STATUS[name] = step() or "ok"
        except Exception as e:  # keep going: one failed feature shouldn't block the others
            log.exception("provision step %s failed", name)
            STATUS[name] = f"error: {type(e).__name__}: {e}"
