---
tab: scaling
title: Scale to zero and autoscaling
---

## The problem
The scorecard is busy during business hours and idle every night and weekend. An always-on database bills for all of those idle hours.

## What
Lakebase compute suspends after a configurable idle period (60 seconds to 7 days), wakes on the next connection, and autoscales between a minimum and maximum size (0.5–32 CU, with at most 16 CU between them).

## Actions
| Button label | API call | Result line template |
|---|---|---|
| Query demo branch | `POST /api/scaling/wake` | "Endpoint was {state_before}; first connection + query took {connect_ms} ms" |
| Burst load | `POST /api/scaling/burst` | "{queries} queries in {seconds} s ({qps} queries/s) on a {min_cu}–{max_cu} CU endpoint" |

## Go deeper
- Workspace: `lakebase_project`
- Docs: https://docs.databricks.com/en/oltp/projects/scale-to-zero
- Docs: https://docs.databricks.com/en/oltp/projects/autoscaling

## Endpoint
demo

## Suspended
Suspended (scaled to zero)

## Active
Active

## Unknown
State unavailable

## Range
autoscaling {min_cu}–{max_cu} CU

## Suspend timeout
Suspends after {suspend_timeout_s} s idle

## No timeout
Automatic suspension is not configured.

## Idle countdown
Idle for {seconds} s — suspends at {suspend_timeout_s} s

## History title
Connection + query time

## History empty
No queries yet. Query the demo branch twice to compare a cold start with a warm connection.

## Cold
cold

## Warm
warm

## Unclassified
unknown

## Wake label
Query {number} · {kind}

## Burst countdown
Burst running — {seconds} s remaining

## Burst finishing
Burst running — waiting for the result…

## Refresh note
Endpoint state refreshes every 5 s. Allocation samples arrive about every 30 s. The marker estimates CU from reported provisioned memory.

## State error
Endpoint state could not refresh. Previous results are still shown; retrying automatically.

## Loading
Loading endpoint state

## Idle suspending
Idle timeout reached ({suspend_timeout_s} s) — waiting for suspension…
