---
tab: cdf
title: Lakebase → Lakehouse: change data feed
---

## The problem
Every visit a rep logs and every stage change happens in the app. Analytics needs those changes in the lakehouse, with their full history, without someone writing and running a CDC pipeline.

## What
Lakebase CDF (Public Preview) streams every insert, update and delete from a Postgres schema into a Unity Catalog Delta history table, `lb_<table>_history`, about every 15 seconds (measured here: ~4 s from commit to visible in Delta).

## Actions
| Button label | API call | Result line template |
|---|---|---|
| Insert an activity | `POST /api/cdf/change` | "Committed activity {pk} at {committed_at} — visible in bronze after {visible_s} s" |
| Update an opportunity | `POST /api/cdf/change` | "Updated opportunity {pk} — `update_postimage` visible in bronze after {visible_s} s" |
| Delete the activity | `POST /api/cdf/change` | "Deleted activity {pk} — `delete` visible in bronze after {visible_s} s" |

## Go deeper
- Workspace: `bronze_history`
- Workspace: `sql_editor`
- Docs: https://docs.databricks.com/aws/en/oltp/projects/lakebase-cdf

## Flow stages
App write
Postgres commit
Lakebase CDF
Delta bronze

## Resting hint
Click a button to send a change through.

## Board title
Arrival board

## Board columns
Operation
Table
Primary key
Committed at
Visible after

## Empty hint
No changes in this session. Insert an activity or update an opportunity to start tracking arrivals.

## Pending label
Waiting for Delta

## Timeout label
Timed out after 60 s

## Unavailable label
CDF unavailable

## Docs label
Lakebase CDF documentation

## Timing note
Times are relative to the button click. Delta visibility is measured when polling first finds the matching change, not from `_timestamp`. Capture and visibility are observed together by the history query; capture time is not measured separately. Polls run every second for up to 60 seconds.

## Commit pending
Waiting for Postgres commit
