"""Optional, idempotent telemetry grants. Safe to rerun after system tables appear."""
import argparse

TABLE = "system.lakebase.compute_gauges"
MISSING = {"TABLE_OR_VIEW_NOT_FOUND", "SCHEMA_NOT_FOUND", "SCHEMA_DOES_NOT_EXIST"}
DENIED = {"INSUFFICIENT_PERMISSIONS", "INSUFFICIENT_PRIVILEGES", "PERMISSION_DENIED", "UNAUTHORIZED_ACCESS"}


def grant_telemetry(spark, principal):
    principal = "`" + principal.replace("`", "``") + "`"
    try:
        # A real metadata lookup distinguishes absent tables from unexpected failures.
        spark.sql(f"DESCRIBE TABLE {TABLE}")
        for grant in ("USE CATALOG ON CATALOG system", "USE SCHEMA ON SCHEMA system.lakebase",
                      f"SELECT ON TABLE {TABLE}"):
            spark.sql(f"GRANT {grant} TO {principal}")
    except Exception as exc:
        condition = getattr(exc, "getCondition", lambda: None)()
        if condition is None:
            condition = getattr(exc, "getErrorClass", lambda: None)()
        condition = (condition or "").split(".")[0]
        sqlstate = getattr(exc, "getSqlState", lambda: None)()
        if condition in MISSING:
            print("WARNING: Optional CU telemetry table is not available yet. "
                  "The app works without it. Rerun setup_telemetry after it appears.")
            return "missing_table"
        if condition in DENIED or sqlstate == "42501":
            print("WARNING: Optional telemetry access could not be granted. "
                  "Rerun setup_telemetry as an administrator with grant privileges.")
            return "permission_denied"
        raise
    print("Optional CU telemetry access granted. The app will detect it automatically.")
    return "ready"


def main():
    from pyspark.sql import SparkSession
    p = argparse.ArgumentParser()
    p.add_argument("--principal", required=True)
    args = p.parse_args()
    grant_telemetry(SparkSession.builder.getOrCreate(), args.principal)


if __name__ == "__main__":
    main()
