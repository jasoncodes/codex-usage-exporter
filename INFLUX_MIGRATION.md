# Influx Migration

The Influx output changed from the old mixed `codex_usage` measurement to two purpose-specific measurements:

- `codex_usage_windows` for primary and secondary usage windows.
- `codex_usage_resets` for account-level reset-credit availability, next grant time, and next expiry.

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

Historical rows from the old measurement do not have reset-credit grant or expiry timestamps, so the backfilled `codex_usage_resets` rows only contain `available_count`. New rows will include `next_granted_at`, `next_expires_at`, and `next_expires_after_seconds` when the reset-credit endpoint reports an available expiring credit.
