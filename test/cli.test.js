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
  const events = [];
  const spawned = [];
  const stdout = buffer();
  const code = await main({
    env: { CODEX_HOME: "/data/codex" },
    stdin: { isTTY: true },
    stdout,
    stderr: buffer(),
    nowMs: 1000000,
    spawnSync: (cmd, args) => {
      events.push("spawn");
      spawned.push([cmd, args]);
      return { status: 0 };
    },
    mkdirSync: (directory, options) => {
      events.push(["mkdir", directory, options]);
    },
    loadAuth: () => {
      loadCount += 1;
      if (loadCount === 1) {
        return { ok: false, reason: "missing_auth", path: "/data/codex/auth.json" };
      }
      return auth();
    },
    fetch: async (url) => routedResponse(url)
  });

  assert.equal(code, 0);
  assert.deepEqual(events, [["mkdir", "/data/codex", { recursive: true }], "spawn"]);
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
    },
    rate_limit_reset_credits: {
      available_count: 1,
      credits: [
        {
          id: "RateLimitResetCredit_1",
          reset_type: "codex_rate_limits",
          status: "available",
          title: "One free rate limit reset",
          granted_at: 500,
          expires_at: 1800,
          expires_after_seconds: 800
        }
      ],
      next_granted_at: 500,
      next_expires_at: 1800,
      next_expires_after_seconds: 800
    }
  });
});

test("raw output passes backend payload through", async () => {
  const stdout = buffer();
  const payload = {
    hello: "world",
    rate_limit: sampleRateLimit(),
    additional_rate_limits: sampleAdditionalRateLimits()
  };
  const resetPayload = sampleResetCredits();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "raw" },
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    fetch: async (url) => jsonResponse(url.includes("rate-limit-reset-credits") ? resetPayload : payload)
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.value), {
    usage: payload,
    rate_limit_reset_credits: resetPayload
  });
});

test("json and pretty output include normalized additional rate limits", async () => {
  for (const output of ["json", "pretty"]) {
    const stdout = buffer();
    const code = await main({
      env: output === "json" ? {} : { CODEX_USAGE_OUTPUT: output },
      stdin: { isTTY: false },
      stdout,
      stderr: buffer(),
      nowMs: 1000000,
      loadAuth: () => auth(),
      fetch: async (url) => {
        if (String(url).includes("rate-limit-reset-credits")) {
          return resetCreditsResponse();
        }
        return jsonResponse({
          rate_limit: sampleRateLimit(),
          additional_rate_limits: sampleAdditionalRateLimits()
        });
      }
    });

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.value);
    assert.deepEqual(parsed.additional_rate_limits, [
      {
        limit_name: "gpt-reserve",
        metered_feature: "base_model_inference",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 604800,
            reset_after_seconds: 604800,
            reset_at: 1780727181
          },
          secondary_window: null
        }
      }
    ]);
  }
});

test("absent PhotonMark Boost token does not fetch boost status", async () => {
  const stdout = buffer();
  const fetchedUrls = [];
  const code = await main({
    env: {},
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: false, reason: "missing_token" }),
    fetch: async (url) => {
      fetchedUrls.push(String(url));
      return routedResponse(url);
    }
  });

  assert.equal(code, 0);
  assert.equal(fetchedUrls.some((url) => url.includes("photonmark")), false);
  assert.equal(JSON.parse(stdout.value).photonmark_boost, undefined);
});

test("raw output includes PhotonMark Boost payload when token exists", async () => {
  const stdout = buffer();
  const payload = { hello: "world", rate_limit: sampleRateLimit() };
  const resetPayload = sampleResetCredits();
  const boostPayload = samplePhotonMarkBoost();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "raw" },
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: true, token: "boost-token" }),
    fetch: async (url, options) => {
      if (String(url).includes("photonmark")) {
        assert.equal(options.headers.Authorization, "Bearer boost-token");
        return jsonResponse(boostPayload);
      }
      return jsonResponse(String(url).includes("rate-limit-reset-credits") ? resetPayload : payload);
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.value), {
    usage: payload,
    rate_limit_reset_credits: resetPayload,
    photonmark_boost: boostPayload
  });
});

test("json output includes normalized PhotonMark Boost data when token exists", async () => {
  const stdout = buffer();
  const code = await main({
    env: {},
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    nowMs: 1000000,
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: true, token: "boost-token" }),
    fetch: async (url) => routedResponse(url)
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.value).photonmark_boost, {
    service: "boost",
    service_name: "Codex Boost",
    status: "active",
    raw_status: "active",
    active: true,
    entitlement_id: 130,
    email: "photonmark@example.com",
    balance_usd: 30,
    balance_usd_micros: 30000000,
    prepaid_usd: 30,
    prepaid_usd_micros: 30000000,
    spent_usd: 0,
    spent_usd_micros: 0,
    expires_at: 1785458000,
    seconds_remaining: 2589259,
    as_of: 1782868740
  });
});

test("CODEX_USAGE_OUTPUT selects output without CLI flags", async () => {
  const stdout = buffer();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "influx" },
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    fetch: async (url) => routedResponse(url)
  });

  assert.equal(code, 0);
  assert.match(
    stdout.value,
    /^codex_usage_windows,email=person@example.com,window=primary used_percent=2,limit_window_seconds=18000i,reset_after_seconds=10i,reset_at=1010i 1000000000000/m
  );
  assert.match(
    stdout.value,
    /^codex_usage_resets,email=person@example.com available_count=1i,next_granted_at=500i,next_expires_at=1800i,next_expires_after_seconds=800i 1000000000000/m
  );
});

test("influx output includes PhotonMark Boost measurement when token exists", async () => {
  const stdout = buffer();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "influx" },
    stdin: { isTTY: false },
    stdout,
    stderr: buffer(),
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: true, token: "boost-token" }),
    fetch: async (url) => routedResponse(url)
  });

  assert.equal(code, 0);
  assert.match(
    stdout.value,
    /^codex_usage_photonmark_boost,email=person@example.com proxy_user="photonmark@example.com",active=1i,entitlement_id=130i,balance_usd=30,prepaid_usd=30,spent_usd=0,expires_at=1785458000i,seconds_remaining=2589259i 1000000000000/m
  );
});

test("influx output keeps successful measurements when a request fails", async () => {
  const stdout = buffer();
  const stderr = buffer();
  const fetchedUrls = [];
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "influx" },
    stdin: { isTTY: false },
    stdout,
    stderr,
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: true, token: "boost-token" }),
    fetch: async (url) => {
      fetchedUrls.push(String(url));
      if (String(url).includes("rate-limit-reset-credits")) {
        return errorResponse(429);
      }
      if (String(url).includes("photonmark")) {
        return photonMarkBoostResponse();
      }
      return jsonResponse({ rate_limit: sampleRateLimit() });
    }
  });

  assert.equal(code, 1);
  assert.equal(fetchedUrls.length, 3);
  assert.match(stdout.value, /^codex_usage_windows,/m);
  assert.match(stdout.value, /^codex_usage_photonmark_boost,/m);
  assert.doesNotMatch(stdout.value, /^codex_usage_resets,/m);
  assert.equal(stderr.value, "Reset credits: Reset credits request failed with HTTP 429.\n");
});

test("influx output emits reset credits when usage fails", async () => {
  const stdout = buffer();
  const stderr = buffer();
  const code = await main({
    env: { CODEX_USAGE_OUTPUT: "influx" },
    stdin: { isTTY: false },
    stdout,
    stderr,
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: false, reason: "missing_token" }),
    fetch: async (url) => String(url).includes("rate-limit-reset-credits")
      ? resetCreditsResponse()
      : errorResponse(503)
  });

  assert.equal(code, 1);
  assert.match(stdout.value, /^codex_usage_resets,email=person@example.com /m);
  assert.equal(stderr.value, "Usage: Usage request failed with HTTP 503.\n");
});

test("PhotonMark Boost fetch failure fails the poll when token exists", async () => {
  const stderr = buffer();
  const code = await main({
    env: {},
    stdin: { isTTY: false },
    stdout: buffer(),
    stderr,
    loadAuth: () => auth(),
    loadPhotonMarkBoostToken: () => ({ ok: true, token: "boost-token" }),
    fetch: async (url) => {
      if (String(url).includes("photonmark")) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return routedResponse(url);
    }
  });

  assert.equal(code, 1);
  assert.equal(stderr.value, "PhotonMark Boost request failed with HTTP 503.\n");
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
      return routedResponse(_url);
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
    fetch: async (url) => routedResponse(url)
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
  return jsonResponse({
    rate_limit: sampleRateLimit(),
    rate_limit_reset_credits: { available_count: 1 }
  });
}

function resetCreditsResponse() {
  return jsonResponse(sampleResetCredits());
}

function photonMarkBoostResponse() {
  return jsonResponse(samplePhotonMarkBoost());
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ date: "Thu, 01 Jan 1970 00:16:40 GMT" }),
    json: async () => payload
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    headers: new Headers()
  };
}

function routedResponse(url) {
  if (String(url).includes("photonmark")) {
    return photonMarkBoostResponse();
  }
  return String(url).includes("rate-limit-reset-credits") ? resetCreditsResponse() : response();
}

function sampleResetCredits() {
  return {
    credits: [
      {
        id: "RateLimitResetCredit_1",
        reset_type: "codex_rate_limits",
        status: "available",
        granted_at: "1970-01-01T00:08:20Z",
        expires_at: "1970-01-01T00:30:00Z",
        redeemed_at: null,
        title: "One free rate limit reset"
      }
    ],
    available_count: 1
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

function sampleAdditionalRateLimits() {
  return [
    {
      limit_name: "gpt-reserve",
      metered_feature: "base_model_inference",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_after_seconds: 604800,
          reset_at: 1780727181
        },
        secondary_window: null
      }
    }
  ];
}

function samplePhotonMarkBoost() {
  return {
    service: "boost",
    service_name: "Codex Boost",
    status: "active",
    raw_status: "active",
    active: true,
    entitlement_id: 130,
    proxy_user: "photonmark@example.com",
    balance_usd: "30.0000",
    balance_usd_micros: 30000000,
    prepaid_usd: "30.0000",
    prepaid_usd_micros: 30000000,
    spent_usd: "0.0000",
    spent_usd_micros: 0,
    expires_at: "2026-07-31T00:33:20+00:00",
    seconds_remaining: 2589259,
    as_of: "2026-07-01T01:19:00+00:00"
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
