---
tab: wrap-up
title: Also available
---

## High availability
One primary plus one to three hot standbys across availability zones, promoted automatically if the primary fails. Committed transactions are kept, and standbys can also serve reads. Docs: https://docs.databricks.com/en/oltp/projects/manage-high-availability

## Read replicas
Up to six read-only compute endpoints per branch, sharing the same storage at no extra storage cost. They offload reporting reads from the app's primary and can scale to zero. Docs: https://docs.databricks.com/en/oltp/projects/read-replicas

## Data API
A PostgREST-compatible HTTP API for CRUD on Postgres tables, authenticated with Databricks OAuth. Postgres grants and row-level security still apply. Docs: https://docs.databricks.com/en/oltp/projects/data-api

## pgvector and Lakebase Search
The pgvector extension stores and searches embeddings next to app data. Lakebase Search adds full-text and vector search inside Postgres. Docs: https://docs.databricks.com/en/oltp/projects/extensions
