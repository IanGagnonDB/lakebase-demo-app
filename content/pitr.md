---
tab: pitr
title: Point-in-time restore
---

## The problem
A rep runs a bulk clean-up and deletes 50 live Q3 opportunities by mistake. Without point-in-time recovery, that pipeline is gone until someone finds a backup and restores the whole database.

## What
Point-in-time restore creates a new branch from the database as it was at any moment in the restore window (7 days by default, configurable from 2 to 30).

## Actions
| Button label | API call | Result line template |
|---|---|---|
| Bulk-delete 50 opps | `POST /api/pitr/delete` | "Deleted {ids.length} opportunities at {before_ts}" |
| Restore to before delete | `POST /api/pitr/restore` | "Branch restore as of {before_ts}: {found} of the deleted opportunities are there ({seconds} s)" |
| Copy rows back to production | `POST /api/pitr/copy-back` | "Copied {copied} opportunities back to production" |

## Go deeper
- Workspace: `lakebase_project`
- Docs: https://docs.databricks.com/aws/en/oltp/projects/point-in-time-restore

## Timeline title
Recover deleted opportunities without rewinding production

## Production label
Production opportunities · now

## Baseline label
Before delete

## Deleted marker
{count} deleted

## Restore marker
restore branch: {found} of {count} found

## Copied marker
copied back

## Resting hint
Start with a bulk delete, then recover the missing rows from a separate restore branch.

## Session note
Recovery details live only in this tab. Reloading or leaving the tab restarts at step 1; the deleted rows are not automatically recovered.

## Previous restore note
A previous restore branch exists — start at step 1.

## Start over
Start over

## Refresh label
Retry loading production count

## Unknown count
Unavailable

## Empty count
No opportunities remain in production.

## Empty delete
No opportunities were deleted. Start again when production has eligible rows.

## Steps label
Recovery steps
