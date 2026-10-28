---
tab: branching
title: Branching
---

## The problem
New features get tested on small, made-up data because copying production is slow and expensive. So some bugs only show up once real users hit them.

## What
A branch is an instant, copy-on-write copy of a database at any size, with its own compute and an optional expiry, billed only for the data that changes.

## Actions
| Button label | API call | Result line template |
|---|---|---|
| Add column on demo | `POST /api/branching/add-column` | "{only_on_demo} exists on demo only — production is unchanged" |
| Reset demo | `POST /api/branching/reset` | "demo recreated from production in {seconds} s" |

## Go deeper
- Workspace: `lakebase_project`
- Docs: https://docs.databricks.com/aws/en/oltp/projects/branches

## Branch tree
Branch tree

## Schema comparison
Schema comparison

## Production note
protected · always on

## Demo note
copy-on-write · scales to zero

## Identical
Identical — demo is a copy of production

## New
new

## Loading
Loading branches and schemas

## Empty branches
No branches found. Add a column on demo or reset demo to refresh the comparison.

## Empty schema
No columns found for this branch.

## Unavailable
The branch comparison could not load. Try an action below to refresh it.
