---
tab: synced-tables
title: Lakehouse → Lakebase: synced tables
---

## The problem
Reps, accounts and quarterly targets are owned in the lakehouse, where planning sets them. The scorecard needs to read them in milliseconds, and nobody wants to build or maintain an ETL job to copy them.

## What
A synced table is a managed pipeline that keeps a read-only copy of a Unity Catalog table in Lakebase, refreshed on a Snapshot, Triggered, or Continuous schedule.

## Actions
| Button label | API call | Result line template |
|---|---|---|
| New daily batch | `POST /api/sync/daily-batch` | "Delta updated · Lakebase is stale" |
| Trigger sync | `POST /api/sync/trigger` | "Sync complete — all batch changes are in Lakebase" |

Each daily batch simulates 250–400 inserts, 15–35 updates, and 1–5 deletes in one Delta commit.
The summary reports actual changes by operation. Trigger sync to copy them to Lakebase before starting the next batch.
Expand **Individual changes** to demonstrate one insert, update, or delete at a time.
“Daily” describes the simulated workload; batches are generated manually, with no scheduled job.

## Go deeper
- Workspace: `synced_targets`
- Workspace: `delta_targets`
- Docs: https://docs.databricks.com/en/oltp/projects/sync-tables

## UI
rep: Rep
newTarget: New visits target
context: Rep {rep} · {quarter}
delta: Delta table
pipeline: Sync pipeline
lakebase: Lakebase (Postgres)
visits: visits
stale: stale
inSync: In sync
lastSync: Last sync {time}
unknown: Not available
noTarget: No target available for this rep. Edit a target or check the source table.
noPipeline: No targets pipeline returned. Trigger sync or open Synced targets below.
syncing: Syncing · {seconds} s
secondsAgo: {n} s ago
minutesAgo: {n} min ago
hoursAgo: {n} h ago
daysAgo: {n} d ago
invalid: Enter a non-negative whole number of visits.
timeout: Still syncing after 5 min — check the pipeline
syncedTargets: Synced targets
