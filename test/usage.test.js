"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  USAGE_URL,
  fetchUsage,
  normalizeUsage,
  requestHeaders,
  responseTimestampSeconds
} = require("../src/usage");

test("requestHeaders includes auth headers", () => {
  assert.deepEqual(requestHeaders({ accessToken: "token", accountId: "acct" }), {
    Accept: "application/json",
    Authorization: "Bearer token",
    "ChatGPT-Account-ID": "acct"
  });
});

test("fetchUsage returns JSON and response Date timestamp on success", async () => {
  const calls = [];
  const payload = { rate_limit: sampleRateLimit() };
  const result = await fetchUsage(
    { accessToken: "token" },
    {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ date: "Sun, 31 May 2026 03:59:41 GMT" }),
          json: async () => payload
        };
      }
    }
  );

  assert.equal(calls[0].url, USAGE_URL);
  assert.deepEqual(result, { payload, timestamp: 1780199981 });
});

test("responseTimestampSeconds falls back to local time", () => {
  assert.equal(responseTimestampSeconds({ headers: new Headers() }, 1780122381000), 1780122381);
});

test("fetchUsage treats 401 and 403 as auth failures", async () => {
  await assert.rejects(
    fetchUsage(
      { accessToken: "token" },
      { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) }
    ),
    /Authentication failed/
  );
});

test("fetchUsage rejects malformed JSON", async () => {
  await assert.rejects(
    fetchUsage(
      { accessToken: "token" },
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bad json");
          }
        })
      }
    ),
    /not valid JSON/
  );
});

test("normalizeUsage emits normalized windows and derives reset_after_seconds", () => {
  const normalized = normalizeUsage(
    {
      rate_limit_reset_credits: {
        available_count: 1
      },
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 2,
          limit_window_seconds: 18000,
          reset_at: 1780140337
        },
        secondary_window: {
          used_percent: 27,
          window_minutes: 10080,
          reset_after_seconds: 245230
        }
      }
    },
    { email: "person@example.com", nowMs: 1780122381000 }
  );

  assert.deepEqual(normalized, {
    timestamp: 1780122381,
    email: "person@example.com",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 2,
        limit_window_seconds: 18000,
        reset_after_seconds: 17956,
        reset_at: 1780140337
      },
      secondary_window: {
        used_percent: 27,
        limit_window_seconds: 604800,
        reset_after_seconds: 245230,
        reset_at: 1780367611
      }
    },
    rate_limit_reset_credits: {
      available_count: 1
    }
  });
});

test("normalizeUsage accepts explicit timestamp", () => {
  const normalized = normalizeUsage(
    { rate_limit: sampleRateLimit() },
    { email: "person@example.com", timestamp: 1780199981 }
  );

  assert.equal(normalized.timestamp, 1780199981);
  assert.equal(normalized.rate_limit.primary_window.reset_at, 1780199982);
});

test("normalizeUsage ignores null numeric aliases instead of treating them as zero", () => {
  const normalized = normalizeUsage(
    {
      rate_limit: {
        primary_window: {
          used_percent: 2,
          limit_window_seconds: null,
          window_seconds: 18000,
          reset_at: null,
          reset_after_seconds: 10
        },
        secondary_window: {
          used_percent: 27,
          limit_window_seconds: 604800,
          reset_after_seconds: 20
        }
      }
    },
    { timestamp: 1000 }
  );

  assert.equal(normalized.rate_limit.primary_window.limit_window_seconds, 18000);
  assert.equal(normalized.rate_limit.primary_window.reset_at, 1010);
});

test("normalizeUsage accepts rate_limits array shape", () => {
  const normalized = normalizeUsage(
    {
      rate_limits: [
        {
          has_credits: true,
          rate_limit_reached: false,
          primary: { used_percent: 1, window_minutes: 300, resets_at: 2000 },
          secondary: { used_percent: 9, window_seconds: 604800, reset_after_seconds: 100 }
        }
      ]
    },
    { nowMs: 1000000 }
  );

  assert.equal(normalized.rate_limit.primary_window.limit_window_seconds, 18000);
  assert.equal(normalized.rate_limit.primary_window.reset_after_seconds, 1000);
  assert.equal(normalized.rate_limit.secondary_window.limit_window_seconds, 604800);
});

function sampleRateLimit() {
  return {
    primary_window: { used_percent: 2, limit_window_seconds: 18000, reset_after_seconds: 1 },
    secondary_window: { used_percent: 27, limit_window_seconds: 604800, reset_after_seconds: 2 }
  };
}
