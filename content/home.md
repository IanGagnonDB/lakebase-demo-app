---
tab: home
title: The right engine for each job
---

## Headline
Power the scorecard with Lakebase. Keep the analytics in the lakehouse.

## Comparison title
OLAP vs. OLTP

## OLAP vs. OLTP
Column-oriented scale vs  Row-oriented speed

## OLTP heading
Transactional — fast point writes

## OLAP heading
Analytical — bulk column scans

## Comparison table
| id | name | city | amount |
| --- | --- | --- | --- |
| 1 | Ann | NYC | $42 |
| 2 | Bo | LA | $17 |
| 3 | Cy | SF | $88 |

## OLTP caption
Row-oriented — a whole record lives together; one row reads or writes in a single fast operation.

## OLAP caption
Column-oriented — one column's values sit together; a query scans just that column and skips the rest.

## OLTP bullets
- **Storage** — row-by-row on disk; fast to read/update a complete record.
- **Priority** — concurrency, low latency (ms), strict ACID.
- **Queries** — INSERT / UPDATE / targeted SELECT on a few rows.
- **Analogy** — the cashier's checkout till.

## OLAP bullets
- **Storage** — grouped by column; reads only the columns it needs.
- **Priority** — throughput, bulk scans (GB→PB); writes batch via ETL.
- **Queries** — aggregations (SUM, AVG, COUNT) with GROUP BY.
- **Analogy** — the annual finance report.

## OLTP footer
**Lakebase**

Serverless Postgres for high-concurrency transactional apps.

## OLAP footer
**DBSQL**

Columnar engine for large-scale analytical workloads.

## OLTP highlight
Row 2 highlighted: one complete record read or written together.

## OLAP highlight
Amount column highlighted: scan the values of one column.

## Footer
Synced both ways and governed in Unity Catalog: synced tables bring Delta into Lakebase, and Lakebase CDF brings every app change back to Delta.

## CTA
See the head-to-head →

## Round trip
Delta → Synced tables → Lakebase → App → CDF → Delta (bronze)
