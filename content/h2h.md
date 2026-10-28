---
tab: h2h
title: Lakebase vs. DBSQL, head to head
---

## The problem
Apps need OLTP: quick lookups and single-row writes. Warehouses are built for OLAP: big scans and aggregates. Same queries, same data, two engines.

## What
The same logical query runs on Lakebase (Postgres) and on a serverless SQL warehouse (Delta), and each side reports the time it measured.

## Actions
| Button label | API call | Result line template |
|---|---|---|
| Rep scorecard | `POST /api/h2h/{engine}/rep_scorecard` | "Scorecard for {rep_name}: {server_ms}" |
| Pipeline list | `POST /api/h2h/{engine}/pipeline_list` | "50 open opportunities in {server_ms}" |
| Log activity | `POST /api/h2h/{engine}/log_activity` | "Visit saved in {server_ms}" |
| Region leaderboard | `POST /api/h2h/{engine}/region_leaderboard` | "Top 10 reps in {server_ms}" |
| Run ×20 | `POST /api/h2h/batch` | "p50 {lakebase.p50} vs {dbsql.p50} — {speedup}× faster" |
| 10 concurrent users | `POST /api/h2h/concurrent` | "10 users: p95 {lakebase.p95} vs {dbsql.p95}, {lakebase.qps} vs {dbsql.qps} queries/s" |

## Fairness rules
- Compute: Lakebase autoscales 1–4 CU; DBSQL runs a Small serverless warehouse (1–2 clusters).
- Same logical query on both engines, against the same synthetic data.
- The warehouse is warmed up before the first measured run, so cold start isn't counted.
- The DBSQL result cache is off (`use_cached_result = false`), so every run does real work.
- Results are percentiles over many runs, never a single run. Both sides are timed the same way: execute + fetch on an open connection.

## UI labels
problem = The problem
lakebase = Lakebase (Postgres)
dbsql = DBSQL (serverless SQL warehouse)
warming = Warming up the warehouse…
warm = Warehouse warm (Lakebase {lakebase_ms} · DBSQL {dbsql_ms})
warmTimeout = Warm-up timed out after 30 s; cold-start time may be included.
warmError = Warehouse warm-up failed: {error}. Actions remain available.
rest = Choose an action above to run the same query on both engines.
loading = Running {action}…
previous = Previous result shown while this run completes.
empty = No rows returned. Choose an action to run again.
server = server
roundtrip = round trip {time}
visits = Visits
pipeline = Open pipeline
versus = {actual} / {target}
name = Name
stage = Stage
amount = Amount (CAD)
rep = Rep
more = +{count} more
saved = Saved · activity_id {activity_id}
inserted = {count} row inserted
stats = Repeated runs
statsRest = Run a benchmark to compare percentiles on a shared linear scale.
chart = p50 server time (ms) · {action} · {benchmark}
measured = Latest completed benchmark · {action} · {benchmark}
fairness = Fairness rules
