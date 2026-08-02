# Scaling constraints

## Current production shape

- **One** Render web service instance.
- Rate limits live in-process (`api/rate_limit.py`) — they reset on restart and do not share across instances.
- SQLite on a mounted disk — safe for a single writer process.

## Do not scale horizontally yet

Until Redis (or equivalent) backs rate limits and you move off single-file SQLite:

1. Keep Render **instance count = 1**.
2. Prefer sticky / single-region deploys.
3. Use Starter disk for `DB_PATH` / `CACHE_PATH`.

## When you outgrow this

1. Move session DB to hosted Postgres.
2. Put rate limits in Upstash/Redis keyed by user_id + IP.
3. Then raise instance count.
