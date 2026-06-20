# Influx Migration

The Influx output changed from the old mixed `codex_usage` measurement to two purpose-specific measurements:

- `codex_usage_windows` for primary and secondary usage windows.
- `codex_usage_resets` for account-level reset-credit availability.

To backfill existing data in InfluxDB 1.x or InfluxQL-compatible stores:

```sql
SELECT
  "used_percent" AS "used_percent",
  "limit_window_seconds" AS "limit_window_seconds",
  "reset_after_seconds" AS "reset_after_seconds",
  "reset_at" AS "reset_at"
INTO "codex_usage_windows"
FROM "codex_usage"
WHERE "window" =~ /.+/
GROUP BY "host", "email", "window";

SELECT
  "rate_limit_reset_credits_available_count" AS "available_count"
INTO "codex_usage_resets"
FROM "codex_usage"
WHERE "rate_limit_reset_credits_available_count" >= 0
GROUP BY "host", "email";
```

The backfilled `codex_usage_resets` rows contain `available_count`, matching the reset-credit field that existed in the old mixed measurement.
