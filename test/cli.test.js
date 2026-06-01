"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { LOGIN_HINT, main, outputFromEnv } = require("../src/cli");

test("missing auth without TTY exits with login hint", async () => {
  const stderr = buffer();
  const code = await main({
    env: {},
    stdin: { isTTY: false },
    stdout: buffer(),
    stderr,
    loadAuth: () => ({ ok: false, reason: "missing_auth", path: "/data/codex/auth.json" })
  });

  assert.equal(code, 1);
  assert.match(stderr.value, new RegExp(escapeRegExp(LOGIN_HINT)));
});

test("missing auth with TTY runs device auth and fetches", async () => {
  let loadCount = 0;
  const spawned = [];
  const stdout = buffer();
  const code = await main({
    env: {},
    stdin: { isTTY: true },
    stdout,
    stderr: buffer(),
    nowMs: 1000000,
    spawnSync: (cmd, args) => {
      spawned.push([cmd, args]);
      return { status: 0 };
    },
    loadAuth: () => {
      loadCount += 1;
      if (loadCount === 1) {
        return { ok: false, reason: "missing_auth", path: "/data/codex/auth.json" };
      }
      return auth();
    },
    fetch: async () => response()
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [["codex", ["login", "--device-auth"]]]);
  assert.deepEqual(JSON.parse(stdout.value), {
    timestamp: 1000,
    email: "person@example.com",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 2,
        limit_window_seconds: 18000,
        reset_after_seconds: 10,
        reset_at: 1010
      },
      secondary_window: {
        used_percent: 27,
        limit_window_seconds: 604800,
        reset_after_seconds: 20,
        reset_at: 1020
      }
    }
  });
});

test("raw output passes backend payload through", async () => {
  const stdout = buffer();
  const payload = { hello: "world", rate_limit: sampleRateLimit() };
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "raw" },
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ date: "Thu, 01 Jan 1970 00:16:40 GMT" }),
      json: async () => payload
    })
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.value), payload);
});

test("CODEX_USAGE_OUTPUT selects output without CLI flags", async () => {
  const stdout = buffer();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "influx" },
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    fetch: async () => response()
  });

  assert.equal(code, 0);
  assert.match(
    stdout.value,
    /^codex_usage,email=person@example.com,window=primary used_percent=2,limit_window_seconds=18000i,reset_after_seconds=10i,reset_at=1010i 1000000000000/m
  );
});

test("authentication failure refreshes Codex auth and retries once", async () => {
  let fetchCount = 0;
  let refreshCount = 0;
  let loadCount = 0;
  const stdout = buffer();
  const stderr = buffer();

  const code = await main({
    env: {},
    stdin: { isTTY: false },
    stdout,
    stderr,
    nowMs: 1000000,
    loadAuth: () => {
      loadCount += 1;
      return loadCount === 1
        ? auth({ accessToken: "stale", email: "stale@example.com" })
        : auth({ accessToken: "fresh", email: "fresh@example.com" });
    },
    refreshAuth: async () => {
      refreshCount += 1;
    },
    fetch: async (_url, options) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        assert.equal(options.headers.Authorization, "Bearer stale");
        return { ok: false, status: 401, json: async () => ({}) };
      }

      assert.equal(options.headers.Authorization, "Bearer fresh");
      return response();
    }
  });

  assert.equal(code, 0);
  assert.equal(refreshCount, 1);
  assert.match(stderr.value, /refreshing Codex auth/);
  assert.equal(JSON.parse(stdout.value).email, "fresh@example.com");
});

test("outputFromEnv rejects invalid values", () => {
  assert.throws(() => outputFromEnv({ CODEX_USAGE_OUTPUT: "xml" }), /Invalid CODEX_USAGE_OUTPUT/);
});

test("invalid CODEX_USAGE_OUTPUT is reported without a stack trace", async () => {
  const stderr = buffer();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "xml" },
    stdin: { isTTY: false },
    stdout: buffer(),
    stderr,
    loadAuth: () => auth(),
    fetch: async () => response()
  });

  assert.equal(code, 1);
  assert.equal(stderr.value, "Invalid CODEX_USAGE_OUTPUT: xml\n");
});

function auth(overrides = {}) {
  return {
    ok: true,
    path: "/data/codex/auth.json",
    accessToken: "token",
    email: "person@example.com",
    ...overrides
  };
}

function response() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ date: "Thu, 01 Jan 1970 00:16:40 GMT" }),
    json: async () => ({ rate_limit: sampleRateLimit() })
  };
}

function sampleRateLimit() {
  return {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 2, limit_window_seconds: 18000, reset_after_seconds: 10 },
    secondary_window: { used_percent: 27, limit_window_seconds: 604800, reset_after_seconds: 20 }
  };
}

function buffer() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    }
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
