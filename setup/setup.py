"""Setup job: grant the app SP catalog access, then write the synthetic sales scorecard to Delta.

Deterministic (seed 42). Skips data generation if the tables already exist (pass --force to rebuild).
"""
import argparse
import random
from datetime import date, datetime, timedelta
from decimal import Decimal

from faker import Faker
from pyspark.sql import SparkSession

REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West"]
SEGMENTS = {
    "Healthcare": ["Regional Hospital", "Medical Center", "Senior Living"],
    "Education": ["High School", "University", "School District"],
    "Industrial": ["Plant", "Distribution Center", "Warehouse"],
    "Commercial": ["Office Tower", "Shopping Centre", "Hotel"],
    "Government": ["County Courthouse", "City Hall", "Fire Hall"],
}
SERVICE_LINES = {"Inspection": (2_000, 25_000), "Service": (5_000, 60_000),
                 "Install": (40_000, 450_000), "Monitoring": (3_000, 40_000)}
STAGES = ["Prospect", "Qualified", "Proposal", "Negotiation", "Closed Won", "Closed Lost"]
ACTIVITY_TYPES = ["Call", "Site visit", "Quote sent", "Meeting"]
N_REPS, N_ACCOUNTS, N_OPPS, N_ACTIVITIES = 50, 2_000, 10_000, 100_000

DDL = {
    "reps": "rep_id INT, rep_name STRING, region STRING, branch STRING",
    "accounts": "account_id BIGINT, account_name STRING, segment STRING, region STRING, owner_rep_id INT",
    "targets": "rep_id INT, quarter STRING, visits_target INT, pipeline_target DECIMAL(12,2)",
    "opportunities": "opportunity_id BIGINT, account_id BIGINT, rep_id INT, name STRING, service_line STRING, "
                     "stage STRING, amount DECIMAL(12,2), close_date DATE, updated_at TIMESTAMP",
    "activities": "activity_id BIGINT, rep_id INT, account_id BIGINT, activity_type STRING, "
                  "activity_ts TIMESTAMP, notes STRING",
}


def last_quarters(today: date, n: int = 4) -> list[str]:
    out, d = [], today
    for _ in range(n):
        q = (d.month - 1) // 3 + 1
        out.append(f"{d.year}-Q{q}")
        d = date(d.year, 3 * (q - 1) + 1, 1) - timedelta(days=1)
    return out


def generate(today: date) -> dict[str, list[tuple]]:
    rng, fake = random.Random(42), Faker("en_CA")
    fake.seed_instance(42)
    now = datetime.combine(today, datetime.min.time()) + timedelta(hours=17)
    reps = [(i, fake.name(), REGIONS[(i - 1) % 5], f"{REGIONS[(i - 1) % 5]} — {fake.city()}")
            for i in range(1, N_REPS + 1)]
    accounts = []
    for i in range(1, N_ACCOUNTS + 1):
        rep, segment = rng.choice(reps), rng.choice(list(SEGMENTS))
        accounts.append((i, f"{fake.city()} {rng.choice(SEGMENTS[segment])}", segment, rep[2], rep[0]))
    targets = [(r[0], q, rng.randrange(40, 90, 5), Decimal(rng.randrange(400_000, 1_500_000, 50_000)))
               for r in reps for q in last_quarters(today)]
    opps = []
    for i in range(1, N_OPPS + 1):
        acct, line = rng.choice(accounts), rng.choice(list(SERVICE_LINES))
        stage = rng.choices(STAGES, weights=[25, 20, 18, 12, 15, 10])[0]
        days = rng.randint(1, 120) if not stage.startswith("Closed") else -rng.randint(1, 270)
        opps.append((i, acct[0], acct[4], f"{acct[1]} — {line}", line, stage,
                     Decimal(rng.randint(*SERVICE_LINES[line])), today + timedelta(days=days),
                     now - timedelta(days=rng.randint(0, 60), minutes=rng.randint(0, 1440))))
    acts = []
    for i in range(1, N_ACTIVITIES + 1):
        acct = rng.choice(accounts)
        days_ago = int(rng.triangular(0, 180, 0))  # skewed recent, so the current quarter is well populated
        acts.append((i, acct[4], acct[0], rng.choice(ACTIVITY_TYPES),
                     now - timedelta(days=days_ago, minutes=rng.randint(0, 600)), None))
    return {"reps": reps, "accounts": accounts, "targets": targets, "opportunities": opps, "activities": acts}


def main() -> None:
    p = argparse.ArgumentParser()
    for arg in ("--catalog", "--schema", "--lakebase-catalog", "--principal"):
        p.add_argument(arg, required=True)
    p.add_argument("--force", action="store_true")
    p.add_argument("--history-max-rows", type=int, choices=(100_000, 1_000_000, 2_000_000, 5_000_000),
                   default=5_000_000)
    a = p.parse_args()
    spark = SparkSession.builder.getOrCreate()

    # Catalog-level grants can't be declared on catalogs the bundle doesn't own.
    spark.sql(f"GRANT USE CATALOG ON CATALOG `{a.catalog}` TO `{a.principal}`")
    # Lakebase catalogs reject CREATE TABLE / MODIFY; ALL PRIVILEGES is the grant that applies.
    spark.sql(f"GRANT ALL PRIVILEGES ON CATALOG `{a.lakebase_catalog}` TO `{a.principal}`")

    fq = lambda t: f"`{a.catalog}`.`{a.schema}`.{t}"
    # Independent physical tiers avoid selective predicates and index-only scans in either engine.
    # Additive only: existing operational tables remain untouched on the default setup run.
    for n in (100_000, 1_000_000, 2_000_000, 5_000_000):
        table = f"activities_history_{n}"
        if n > a.history_max_rows or spark.catalog.tableExists(f"{a.catalog}.{a.schema}.{table}"):
            continue
        spark.range(n).selectExpr(
            "id AS history_id", "cast((id * 7919) % 200000 + 1 AS BIGINT) AS account_id",
            "element_at(array('Northeast','Southeast','Midwest','Southwest','West'), cast(id % 5 + 1 AS INT)) AS region",
            "concat('2025-Q', cast(cast(floor(id / 5) % 4 + 1 AS INT) AS STRING)) AS quarter",
            "element_at(array('Call','Site visit','Quote sent','Meeting'), cast(floor(id / 20) % 4 + 1 AS INT)) AS activity_type",
            "cast((id * 13) % 100000 / 100 AS DECIMAL(12,2)) AS amount"
        ).write.mode("error").saveAsTable(fq(table))
        print(f"wrote history tier {n} -> {fq(table)}")

    # Dedicated CRUD demo: additive and deliberately independent from scorecard targets.
    if not spark.catalog.tableExists(f"{a.catalog}.{a.schema}.sync_demo"):
        spark.sql(f"CREATE TABLE {fq('sync_demo')} (row_id STRING, demo_value INT, tag STRING) "
                  "USING DELTA TBLPROPERTIES (delta.enableChangeDataFeed = true)")
        spark.sql(f"INSERT INTO {fq('sync_demo')} VALUES "
                  "('seed-delete', 100, 'synced-tab-demo'), ('seed-update', 200, 'synced-tab-demo')")

    if not a.force and all(spark.catalog.tableExists(f"{a.catalog}.{a.schema}.{t}") for t in DDL):
        print("Tables exist — skipping data generation (pass --force to rebuild).")
        return
    for table, rows in generate(date.today()).items():
        spark.createDataFrame(rows, DDL[table]).write.mode("overwrite") \
            .option("overwriteSchema", "true").saveAsTable(fq(table))
        print(f"wrote {len(rows):>7} rows -> {fq(table)}")
    for table in ("reps", "accounts", "targets"):
        spark.sql(f"ALTER TABLE {fq(table)} SET TBLPROPERTIES (delta.enableChangeDataFeed = true)")


if __name__ == "__main__":
    main()
