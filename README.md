# Lakebase Demo App

A self-contained Databricks Asset Bundle: one shared app that shows why Lakebase is the right
backend for a sales scorecard app, side by side with DBSQL.

## Prerequisites
1. An **AWS workspace** in a region that offers Lakebase Postgres Autoscaling, Lakebase CDF and
   Lakebase Observability in System Tables, with **serverless SQL warehouses**, **Databricks Apps**
   and **serverless jobs** enabled.
   - **Lakebase Postgres (Autoscaling projects)** must be available in the workspace. The bundle
     creates an autoscaling project; without it, `bundle deploy` fails.
   - A workspace admin enables these previews (Settings → Previews):
     - **Lakebase CDF** (`lakebase_cdf`), for the CDF tab.
     - **Lakebase Observability in System Tables** (`lakebase_system_table_o11y`), which populates
       `system.lakebase.compute_gauges` for the Scaling tab.
2. A Unity Catalog **catalog on external storage**, not default storage, because Lakebase CDF rejects
   default-storage catalogs. The bundle creates its schemas inside it. If you don't have one, set it up
   once, in the **same region as the workspace**:
   1. **S3 bucket** (public access blocked).
   2. **IAM role** with read/write on that bucket. It must trust the Unity Catalog master role and
      itself, locked to the storage credential's external ID
      ([guide](https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/storage-credentials)).
   3. **Storage credential** for that role (Catalog → External data → Credentials), then update the
      role's trust policy with the external ID it shows.
   4. **External location** on the bucket, using that credential.
   5. **Catalog** whose storage root is a path in that external location, for example
      `CREATE CATALOG lakebase_demo MANAGED LOCATION 's3://<bucket>/lakebase_demo'`.

   These five live outside the bundle, so `bundle destroy` leaves them in place (see Teardown).
3. The deployer has **`CREATE CATALOG` on the metastore** (the bundle registers the Lakebase
   database as a UC catalog, `lakebase_demo_pg` by default), `MANAGE` / `CREATE SCHEMA` on the catalog
   from step 2, and can create Lakebase projects, SQL warehouses, apps and jobs.
   The deployer must also be able to grant `SELECT` on `system.lakebase.compute_gauges` to the app
   (usually a metastore admin); otherwise a metastore admin grants it once.
4. Databricks CLI ≥ v1.21, authenticated to the workspace.
5. Optional, for local work only: Python 3.10+ (`requirements-dev.txt`), bash and curl for
   `scripts/smoke.sh`, and Node 20.19+ only to rebuild the UI (`app/static` ships prebuilt).

## Deploy (once, ~15 min)
Replace `<catalog>`, then run the four commands as written (the flags are repeated on
purpose, so they work in both bash and zsh):

```bash
databricks bundle deploy -t workshop --var="catalog=<catalog>"
databricks bundle run setup -t workshop --var="catalog=<catalog>"
databricks bundle run lakebase_demo_app -t workshop --var="catalog=<catalog>"
databricks apps get lakebase-demo-app    # prints the app URL
```

- `setup` writes the synthetic sales scorecard to Delta and grants the app catalog access.
- When the app starts, it provisions the rest itself: Postgres tables, synced tables, the CDF
  feed, and the `demo` branch. Open `<app URL>/api/meta` → `provisioning`. Every step should read
  `ok` (or `already …`) within a few minutes. The synced tables' first sync takes ~5–10 minutes
  more; the Lakebase side of the head-to-head needs it.

Optional: add `--var="warehouse_size=Medium"` to give the DBSQL side a bigger warehouse (about +$17).

## Cost (list price, AWS us-east-1)
About $23 per workshop with the default Small warehouse (about $40 with Medium); the warehouse is
~70% of it. Resources are tagged `workshop=lakebase`.

## Teardown (same day)
```bash
databricks bundle destroy -t workshop --var="catalog=<catalog>"
```
This deletes the app, warehouse, job, schemas, the Lakebase project (all branches) and its UC
catalog. It leaves the storage from prerequisite 2 in place. If you created that storage only for
this workshop, delete it by hand in reverse order: the catalog, the external location, the storage
credential, then the IAM role and the S3 bucket.

## Presenter notes
- Before the session, open the app once so the warehouse is warm, and run
  `OPTIMIZE <catalog>.scorecard.activities` in the SQL editor. Each DBSQL "Log activity" click is a
  single-row Delta commit, and hundreds of them slowly slow later DBSQL scans — real behavior and a
  good talking point, but start each workshop clean.
- Let `demo` sit idle for 60 s before showing the Scaling tab's cold start.

## Unit tests
```bash
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests
```

## Smoke test
```bash
PROFILE=<cli-profile> scripts/smoke.sh
```

## Clear results and reset the workshop

Each interactive tab has **Clear results** beside **Try it**. It clears presentation results,
without undoing database writes. Pending sync batches, branch changes, and the scaling endpoint's
actual state remain visible. Clear is disabled during operations and while PITR recovery is pending.

**Reset demo** in the header restores the workshop for all viewers, after confirmation:

1. Restore Lakebase opportunities from the canonical Delta workshop table and remove tagged demo activity writes.
2. Remove tagged activity writes from the Delta side of the head-to-head comparison.
3. Restore the tagged `sync_demo` baseline, trigger its pipeline, and verify Lakebase catches up.
4. Recreate the `demo` branch and remove the `restore` branch.
5. Clear this browser's tab results and saved sync/CDF histories. Other connected viewers clear their results when they observe completion.

Reset progress is stored in `workshop_control.reset_state` in production Lakebase. A failed or
interrupted reset blocks further demo requests until **Retry reset** completes the remaining steps.
PITR deletion also saves its timestamp and IDs atomically in `workshop_control.pitr_recovery`, so
switching tabs or reloading retains the information needed for recovery. Full reset restores the
canonical synthetic opportunities even if a PITR restore branch has expired. CDF history is retained.
Scaling shows the real endpoint state after reset; wait for suspension before demonstrating a cold start.

The reset coordinator uses the bundle's single Uvicorn worker. Run the app with one worker;
a multi-worker deployment would require a distributed admission lock around demo requests.

### Scaling allocation telemetry

The Scaling marker reads `system.lakebase.compute_gauges` through the existing
SQL warehouse, cached for 10 seconds across viewers. Enable Lakebase Observability
in System Tables Beta in the workspace. The bundle declares the table as an app
resource with SELECT permission; deploy the bundle to apply this binding.

Samples arrive about every 30 seconds. The marker shows approximate CU, inferred
from guest-visible provisioned memory at roughly 2 GiB per CU, rounded to the
nearest 0.5 CU. It is an estimate, not a billing measurement. Samples older than
90 seconds or captured before a local cold wake are hidden. Suspended endpoints
show 0 CU and no allocation marker. Warehouse availability and permissions affect
telemetry independently from endpoint state; telemetry failures do not disable
the demo. Polling the warehouse does not keep Lakebase awake, but does incur SQL
warehouse usage. Local mock mode simulates the allocation feed.

Lakebase console links use `GET /api/meta` → `links.lakebase_project`. The app resolves
the configured project’s immutable UID through the SDK once per process; if resolution
fails, it logs the error and links to the workspace’s Lakebase projects list.
