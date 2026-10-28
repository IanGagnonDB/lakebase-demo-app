import type { ContentSlug } from "./load";

export interface RecipeStep {
  title: string;
  instruction: string;
  snippet?: { context: string; language: string; code: string };
}
export interface Recipe { title: string; steps: RecipeStep[] }
const code = (context: string, language: string, source: string) => ({ context, language, code: source.trim() });

const createBranch = `databricks postgres create-branch projects/<project> dev --profile <profile> \\
  --json '{"spec":{"source_branch":"projects/<project>/branches/production","ttl":"604800s"}}'`;
const createCompute = `databricks postgres create-endpoint projects/<project>/branches/dev primary \\
  --profile <profile> --json '{"spec":{"endpoint_type":"ENDPOINT_TYPE_READ_WRITE"}}'`;
const historicalBranch = `databricks postgres create-branch projects/<project> recovery --profile <profile> \\
  --json '{"spec":{
    "source_branch":"projects/<project>/branches/production",
    "source_branch_time":"<UTC-timestamp-before-incident>","ttl":"7200s"
  }}'`;
const historyQuery = `SELECT opportunity_id, stage, amount, _pg_change_type, _pg_lsn
FROM <catalog>.<bronze_schema>.lb_opportunities_history
WHERE opportunity_id = 42
ORDER BY _pg_lsn;`;

export const RECIPES: Partial<Record<ContentSlug, Recipe[]>> = {
  branching: [
    { title: "Connect your dev app to a branch", steps: [
      { title: "Create an expiring development branch", instruction: "In an authenticated terminal with a current Databricks CLI, replace the placeholders with your profile and an existing project you can manage. This creates a seven-day copy of production; choose a fresh branch ID if dev already exists.", snippet: code("Terminal · Databricks CLI", "bash", createBranch) },
      { title: "Create compute for the branch", instruction: "Create a read-write endpoint if the branch has none. In the Lakebase connection dialog, select dev and copy its host, database name, and OAuth connection instructions for local tools.", snippet: code("Terminal · Databricks CLI", "bash", createCompute) },
      { title: "Bind your development app using DAB", instruction: "Merge this fragment into your existing bundle. Supply the dev branch and its database resource path as bundle variables; discover the database ID with list-databases. Keep production bindings in the production target. The app must load the connection settings provided by its postgres resource.", snippet: code("databricks.yml · existing app resource", "yaml", `variables:
  lakebase_branch:
    description: Full dev branch resource path
  lakebase_database:
    description: Full database resource path on dev
targets:
  dev:
    variables:
      lakebase_branch: projects/<project>/branches/dev
      lakebase_database: projects/<project>/branches/dev/databases/<database-id>
resources:
  apps:
    scorecard:
      resources:
        - name: postgres
          postgres:
            branch: \${var.lakebase_branch}
            database: \${var.lakebase_database}
            permission: CAN_CONNECT_AND_CREATE`) },
      { title: "Deploy the dev app", instruction: "Replace the dev target’s resource placeholders, then validate, deploy, and start your existing app resource. Use the actual bundle app key in place of scorecard.", snippet: code("Terminal · bundle root", "bash", `databricks bundle validate -t dev --profile <profile>
databricks bundle deploy -t dev --profile <profile>
databricks bundle run scorecard -t dev --profile <profile>`) },
      { title: "Test a migration and verify isolation", instruction: "Run the ALTER only on dev, as the table owner or a role allowed to alter it. Then run the SELECT on both dev and production: expect one row on dev and none on production.", snippet: code("Lakebase · PostgreSQL", "sql", `ALTER TABLE app.opportunities ADD COLUMN win_probability numeric(5,2);

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'opportunities'
  AND column_name = 'win_probability';`) },
    ] },
    { title: "Test a migration in CI", steps: [
      { title: "Create a branch for this CI run", instruction: "Authenticate your CI runner with a service principal that can manage the project. Set PROFILE and PROJECT, and supply a unique numeric CI_RUN_ID. Give every run its own branch and a four-hour expiry.", snippet: code("CI runner · Bash", "bash", `BRANCH="ci-\${CI_RUN_ID}"
databricks postgres create-branch "projects/$PROJECT" "$BRANCH" \\
  --profile "$PROFILE" --json "{\\"spec\\":{\\"source_branch\\":\\"projects/$PROJECT/branches/production\\",\\"ttl\\":\\"14400s\\"}}"`) },
      { title: "Create compute and connect the runner", instruction: "Create an endpoint, resolve its host, and generate a short-lived database credential. Replace the placeholders with the current OAuth principal as PGUSER and the database name copied from the branch’s connection dialog as PGDATABASE. Keep credentials masked in CI logs.", snippet: code("CI runner · Bash", "bash", `PARENT="projects/$PROJECT/branches/$BRANCH"
databricks postgres create-endpoint "$PARENT" primary --profile "$PROFILE" \\
  --json '{"spec":{"endpoint_type":"ENDPOINT_TYPE_READ_WRITE"}}'
EP="$PARENT/endpoints/primary"
export PGHOST=$(databricks postgres get-endpoint "$EP" --profile "$PROFILE" -o json | jq -r '.status.hosts.host')
export PGPASSWORD=$(databricks postgres generate-database-credential "$EP" --profile "$PROFILE" -o json | jq -r '.token')
export PGUSER="<oauth-principal>"
export PGDATABASE="<database-name>"
export PGSSLMODE=require`) },
      { title: "Run your migrations and integration tests", instruction: "Use your repository’s migration command and integration suite against this branch. For SQL migrations, this example stops immediately on an error. Assert the migrated behavior and verify that the test connection targets the CI branch.", snippet: code("CI runner · PostgreSQL client", "bash", `psql -v ON_ERROR_STOP=1 -f migrations/001_add_win_probability.sql
# Run your integration suite using the same PG* settings.`) },
      { title: "Clean up even when tests fail", instruction: "Put branch deletion in the CI system’s always/finally cleanup stage, using the branch ID created by this run. The TTL provides a fallback if cleanup cannot run.", snippet: code("CI cleanup · Bash", "bash", `databricks postgres delete-branch "projects/$PROJECT/branches/$BRANCH" \\
  --profile "$PROFILE"`) },
    ] },
  ],
  pitr: [
    { title: "Recover accidentally deleted records", steps: [
      { title: "Choose the recovery timestamp and record IDs", instruction: "Identify a UTC timestamp before the incident within the project’s available restore window. Record the missing primary keys. Use an authenticated CLI profile with project management access, plus PostgreSQL read access to recovery data and insert access to production." },
      { title: "Create a historical recovery branch", instruction: "Replace the timestamp with an RFC 3339 UTC value, such as 2026-10-26T13:00:00Z. Use a fresh recovery branch ID; this branch expires after two hours.", snippet: code("Terminal · Databricks CLI", "bash", historicalBranch) },
      { title: "Create compute and inspect the missing records", instruction: "Create a read-write endpoint on recovery, then obtain its connection settings from the Lakebase connection dialog. In PostgreSQL, inspect the requested records before copying them. Replace 42 and 43 with the missing IDs.", snippet: code("Terminal · then recovery PostgreSQL", "bash", `databricks postgres create-endpoint projects/<project>/branches/recovery primary \\
  --profile <profile> --json '{"spec":{"endpoint_type":"ENDPOINT_TYPE_READ_WRITE"}}'
# In a PostgreSQL client connected to recovery:
# SELECT * FROM app.opportunities WHERE opportunity_id IN (42, 43);`) },
      { title: "Copy only the reviewed records back", instruction: "With psycopg installed, set RECOVERY_DSN and PRODUCTION_DSN to SSL-enabled PostgreSQL connections using fresh OAuth credentials. Match the column list to your schema. This transaction inserts missing IDs and preserves any existing production rows; inspect skipped IDs separately.", snippet: code("Local script · Python + psycopg", "python", `import os, psycopg
ids = [42, 43]
cols = "opportunity_id, account_id, rep_id, name, service_line, stage, amount, close_date, updated_at"
with psycopg.connect(os.environ["RECOVERY_DSN"]) as src:
    rows = src.execute(f"SELECT {cols} FROM app.opportunities WHERE opportunity_id = ANY(%s)", (ids,)).fetchall()
if {row[0] for row in rows} != set(ids):
    raise ValueError("Some requested records are missing from recovery")
with psycopg.connect(os.environ["PRODUCTION_DSN"]) as dst:
    inserted = []
    for row in rows:
        result = dst.execute(f"INSERT INTO app.opportunities ({cols}) VALUES ({', '.join(['%s'] * 9)}) ON CONFLICT (opportunity_id) DO NOTHING RETURNING opportunity_id", row).fetchone()
        if result:
            inserted.append(result[0])
print({"requested": ids, "found": len(rows), "inserted": inserted,
       "skipped_existing": sorted(set(ids) - set(inserted))})`) },
      { title: "Verify recovery and remove the temporary branch", instruction: "Query the recovered IDs in production and compare their values with the reviewed records. Check application behavior, then delete only the temporary recovery branch or let its TTL expire.", snippet: code("Production · PostgreSQL", "sql", `SELECT opportunity_id, stage, amount
FROM app.opportunities WHERE opportunity_id IN (42, 43);`) },
    ] },
    { title: "Investigate a past database state", steps: [
      { title: "Choose the moment to investigate", instruction: "Select a UTC timestamp within the available restore window, for example just before a deployment. You need project management access and permission to read the copied tables." },
      { title: "Create an isolated historical branch", instruction: "Use a fresh recovery branch ID. Creating this branch leaves the current production state intact.", snippet: code("Terminal · Databricks CLI", "bash", historicalBranch) },
      { title: "Connect to recovery compute", instruction: "Create an endpoint if needed. Select recovery in the Lakebase connection dialog and connect with a PostgreSQL client using SSL and an OAuth credential.", snippet: code("Terminal · Databricks CLI", "bash", `databricks postgres create-endpoint projects/<project>/branches/recovery primary \\
  --profile <profile> --json '{"spec":{"endpoint_type":"ENDPOINT_TYPE_READ_WRITE"}}'`) },
      { title: "Compare historical and current values", instruction: "Run this query separately on recovery and production, using the same ID. Compare the results with deployment logs or the incident timeline; a historical snapshot shows state at that moment, not a complete audit trail. Remove the temporary branch when finished or let it expire.", snippet: code("Recovery and production · PostgreSQL", "sql", `SELECT opportunity_id, stage, amount, updated_at
FROM app.opportunities WHERE opportunity_id = 42;`) },
    ] },
  ],
  "synced-tables": [
    { title: "Serve lakehouse data in your app", steps: [
      { title: "Prepare a curated Delta source", instruction: "Use a source table with a stable, unique key; this example serves quarterly targets keyed by rep_id and quarter. You need source read access, permission to enable CDF, a Lakebase branch registered as a UC catalog, and a regular UC storage schema for pipeline state.", snippet: code("SQL warehouse · Databricks SQL", "sql", `ALTER TABLE <catalog>.<schema>.targets
SET TBLPROPERTIES (delta.enableChangeDataFeed = true);`) },
      { title: "Create the synced table and choose a refresh mode", instruction: "With an authenticated CLI profile, replace every placeholder. TRIGGERED refreshes on demand or after a scheduled batch; CONTINUOUS keeps data incrementally refreshed. Use a regular UC catalog for pipeline storage, separate from the Lakebase catalog.", snippet: code("Terminal · Databricks CLI", "bash", `databricks postgres create-synced-table <lakebase_catalog>.public.targets \\
  --profile <profile> --json '{"spec":{
    "source_table_full_name":"<catalog>.<schema>.targets",
    "primary_key_columns":["rep_id","quarter"],
    "branch":"projects/<project>/branches/<branch>",
    "postgres_database":"databricks_postgres",
    "scheduling_policy":"TRIGGERED","create_database_objects_if_missing":true,
    "new_pipeline_spec":{"storage_catalog":"<catalog>","storage_schema":"<schema>"}
  }}'`) },
      { title: "Refresh after your upstream batch", instruction: "For Triggered mode, run this after the upstream job succeeds. Install the Databricks SDK and use the same authenticated profile. Wait for the returned pipeline update to complete in the pipeline UI before serving the refreshed batch; a submitted update alone does not mean data is ready.", snippet: code("Batch job · Python", "python", `from databricks.sdk import WorkspaceClient
w = WorkspaceClient(profile="<profile>")
table = w.postgres.get_synced_table(
    name="synced_tables/<lakebase_catalog>.public.targets")
update = w.pipelines.start_update(pipeline_id=table.status.pipeline_id)
print(update.update_id)`) },
      { title: "Grant the app read access", instruction: "Once the sync is ready, run these grants as the destination table owner or an authorized administrator. Find the app service principal client ID in its app details. The app also needs a binding to this Lakebase branch and database.", snippet: code("Lakebase · PostgreSQL", "sql", `GRANT USAGE ON SCHEMA public TO "<app-sp-client-id>";
GRANT SELECT ON public.targets TO "<app-sp-client-id>";`) },
      { title: "Query from your app and verify freshness", instruction: "Use your app’s PostgreSQL connection to read the target for a known rep and quarter. Change that target in Delta, refresh (or wait for Continuous sync), then query again and compare the value. Make all source edits in Delta; the synced PostgreSQL table is read-only.", snippet: code("App connection · PostgreSQL", "sql", `SELECT * FROM public.targets
WHERE rep_id = 1 AND quarter = '2026-Q3';`) },
    ] },
  ],
  cdf: [
    { title: "Use application changes in analytics", steps: [
      { title: "Prepare your PostgreSQL tables", instruction: "Use a supported Lakebase project and source database, with permission to manage sync and create destination UC tables. As the source table owner, enable full replica identity on the tables you want to capture.", snippet: code("Lakebase · PostgreSQL", "sql", `ALTER TABLE app.opportunities REPLICA IDENTITY FULL;
ALTER TABLE app.activities REPLICA IDENTITY FULL;`) },
      { title: "Enable Lakebase-to-lakehouse sync", instruction: "Open your Lakebase project, select the source branch, and open its CDF / Lakehouse Sync settings. Select the PostgreSQL database and app schema, then choose the destination Unity Catalog catalog and bronze schema. Start sync and wait for the initial data to be available. If this workshop already has sync configured, use its existing destination." },
      { title: "Make an application change", instruction: "Use the application normally or update a known opportunity in PostgreSQL. Replace 42 with an existing ID and inspect the returned row. This change will also appear in the history table.", snippet: code("Lakebase · PostgreSQL", "sql", `UPDATE app.opportunities
SET stage = 'Proposal', updated_at = now()
WHERE opportunity_id = 42
RETURNING opportunity_id, stage, updated_at;`) },
      { title: "Inspect the record’s change history", instruction: "Query the destination using a SQL warehouse. Wait for the new event and inspect its change type and values. Updates can have preimage and postimage events; deletes remain visible in history. Capture is asynchronous.", snippet: code("SQL warehouse · Databricks SQL", "sql", historyQuery) },
      { title: "Query the latest state for analytics", instruction: "Select the latest insert, update postimage, or delete per primary key, then exclude records whose latest event is a deletion. Check that the changed opportunity appears with the new stage. This query uses the history feed’s ordering key; run it against your configured destination.", snippet: code("SQL warehouse · Databricks SQL", "sql", `WITH latest AS (
  SELECT *, row_number() OVER (
    PARTITION BY opportunity_id ORDER BY _sort_by DESC
  ) AS rn
  FROM <catalog>.<bronze_schema>.lb_opportunities_history
  WHERE _pg_change_type IN ('insert', 'update_postimage', 'delete')
)
SELECT opportunity_id, rep_id, stage, amount
FROM latest
WHERE rn = 1 AND _pg_change_type <> 'delete';`) },
    ] },
  ],
};
