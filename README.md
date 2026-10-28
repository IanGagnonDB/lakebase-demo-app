# Lakebase Demo App

An interactive demo app for understanding Lakebase: each tab runs one key feature live (synced
tables, CDF, branching, point-in-time restore, autoscaling) and compares it with DBSQL.

## Prerequisites


| #   | Prerequisite                                                                          | Needed for                                                         | Who sets it up                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Databricks workspace on AWS or Azure** with serverless compute, Apps and Lakebase Autoscaling              | Every tab                                                          | Workspace admin                                                                                                                                         |
| 2   | **Catalog on external storage** (S3 on AWS or ADLS Gen2 on Azure, same region), with `CREATE CATALOG` on the metastore | CDF (rejects default storage)                                      | Deployer, via [Terraform](terraform/README.md) or by hand ([AWS](https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/storage-credentials), [Azure](https://learn.microsoft.com/en-us/azure/databricks/connect/unity-catalog/cloud-storage/storage-credentials)) |
| 3   | **Lakebase CDF** preview (`lakebase_cdf`)                                             | **CDF** tab                                                        | Workspace admin                                                                                                                                         |
| 4   | **Lakebase Observability in System Tables** preview (`lakebase_system_table_o11y`)    | **Scaling** tab                                                    | Workspace admin                                                                                                                                         |
| 5   | Permissions to create Lakebase projects, SQL warehouses, apps and jobs                | `bundle deploy`                                                    | Workspace admin                                                                                                                                         |
| 6   | Right to grant `SELECT` on `system.lakebase.compute_gauges`                           | `bundle deploy` grants it to the app                               | Metastore admin                                                                                                                                         |
| 7   | **Databricks CLI** ≥ v1.21, authenticated to the workspace                            | Deploy and cleanup                                                 | Deployer                                                                                                                                                |
| 8   | *Optional:* Python 3.10+ (`requirements-dev.txt`), bash, curl, Node 20.19+            | Tests, smoke test, rebuilding the UI (`app/static` ships prebuilt) | Developer                                                                                                                                               |


## Deploy (once, ~15 min)

Use a workspace/region with all the required features and previews enabled on your
chosen cloud. In-app documentation links follow the workspace cloud. Terraform provisions external storage and the data catalog in an
**existing workspace**; it does not create the workspace. Choose
[`terraform/aws`](terraform/aws/README.md) or [`terraform/azure`](terraform/azure/README.md).

Authenticate to the intended workspace first (use a separate profile per workspace):

```bash
databricks auth login --host <workspace-url> --profile <workspace-profile>
```

For a fresh Azure deployment, use the Azure Terraform configuration with that same
workspace profile, then run the bundle commands below. Resource names must be unused
in the destination workspace/metastore; the existing AWS deployment is independent.

Replace `<catalog>` and `<workspace-profile>`, then run the four commands as written (the flags are repeated on
purpose, so they work in both bash and zsh):

```bash
databricks bundle deploy --profile <workspace-profile> -t workshop --var="catalog=<catalog>"
databricks bundle run setup --profile <workspace-profile> -t workshop --var="catalog=<catalog>"
databricks bundle run lakebase_demo_app --profile <workspace-profile> -t workshop --var="catalog=<catalog>"
databricks apps get lakebase-demo-app --profile <workspace-profile>    # prints the app URL
```

- `setup` writes the synthetic sales scorecard to Delta and grants the app catalog access.
- When the app starts, it provisions the rest itself: Postgres tables, synced tables, the CDF
feed, and the `demo` branch. Open `<app URL>/api/meta` → `provisioning`. Within a few minutes,
steps should finish with `ok`, `seeded`, `already …`, or `sync submitted …`, with no `running`
or `error: …` entries. `sync submitted …` confirms submission, not completed sync. The synced
tables' first sync can take ~5–10 minutes more; wait for the Readiness page's synced-table and
benchmark-snapshot checks to be Ready before running the head-to-head benchmarks.
- The **Readiness** page (header button) checks every resource and preview.

Optional: add `--var="warehouse_size=<size>"` to change the SQL warehouse size (default: Small).

## Cleanup

```bash
databricks bundle destroy --profile <workspace-profile> -t workshop --var="catalog=<catalog>"
terraform -chdir=terraform/<aws-or-azure> destroy    # optional: use the cloud folder that created prerequisite 2
```

## Presenter notes

- Before the session, open the app once so the warehouse is warm, and run
`OPTIMIZE <catalog>.scorecard.activities` in the SQL editor. Each DBSQL "Log activity" click is a
single-row Delta commit, and hundreds of them slowly slow later DBSQL scans — real behavior and a
good talking point, but start each workshop clean.
- Run **Run all benchmarks** once after each deploy; the first 50-user run on a cold app is the slowest.
- Let `demo` sit idle for 60 s before showing the Scaling tab's cold start.

## Clear results and reset

- **Clear results** (on each tab) clears what that tab shows. Data stays as it is.
- **Reset demo** (in the header) puts the whole demo back to its starting state for every viewer:
data, sync baseline and the `demo` branch. If a reset is interrupted, click **Retry reset**.

## Unit tests

```bash
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests
```

## Smoke test

```bash
PROFILE=<cli-profile> scripts/smoke.sh
```

