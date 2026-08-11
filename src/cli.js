#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { loadAuth } = require("./auth");
const {
  fetchPhotonMarkBoost,
  loadPhotonMarkBoostToken,
  normalizePhotonMarkBoost
} = require("./photonmark");
const { refreshAuth } = require("./refresh");
const {
  fetchResetCredits,
  fetchUsage,
  normalizeResetCredits,
  normalizeUsage,
  UsageError
} = require("./usage");
const { toInflux } = require("./influx");

const LOGIN_HINT =
  "No Codex auth found. Run once with: docker compose run --rm -t codex-usage-exporter";

async function main(deps = {}) {
  const env = deps.env || process.env;
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const spawnSyncFn = deps.spawnSync || spawnSync;
  const spawnAsync = deps.spawn || spawn;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const nowMs = deps.nowMs;
  const loadAuthFn = deps.loadAuth || loadAuth;
  const loadPhotonMarkBoostTokenFn = deps.loadPhotonMarkBoostToken || loadPhotonMarkBoostToken;

  try {
    const output = outputFromEnv(env);
    const auth = ensureAuth({ env, stdin, stderr, spawn: spawnSyncFn, loadAuthFn });
    await printUsage({
      auth,
      output,
      stdout,
      stderr,
      fetchImpl,
      nowMs,
      env,
      loadAuthFn,
      loadPhotonMarkBoostTokenFn,
      refreshAuthFn: deps.refreshAuth || refreshAuth,
      spawnAsync,
      allowPartial: output === "influx"
    });
    return 0;
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function outputFromEnv(env) {
  const value = env.CODEX_USAGE_OUTPUT || env.CODEX_USAGE_FORMAT;
  if (!value) {
    return "json";
  }
  if (["json", "pretty", "raw", "influx"].includes(value)) {
    return value;
  }
  throw new Error(`Invalid CODEX_USAGE_OUTPUT: ${value}`);
}

function ensureAuth(deps) {
  const auth = deps.loadAuthFn(deps.env);
  if (auth.ok) {
    return auth;
  }

  if (!deps.stdin.isTTY) {
    throw new Error(LOGIN_HINT);
  }

  deps.stderr.write("No Codex auth found; starting device login.\n");
  return runLogin(deps);
}

function runLogin({ env, stdin, stderr, spawn, loadAuthFn }) {
  if (!stdin.isTTY) {
    throw new Error(LOGIN_HINT);
  }

  const result = spawn("codex", ["login", "--device-auth"], {
    stdio: "inherit",
    env
  });

  if (result.error) {
    throw new Error(`Failed to run codex login --device-auth: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`codex login --device-auth exited with status ${result.status}.`);
  }

  const auth = loadAuthFn(env);
  if (!auth.ok) {
    throw new Error(`codex login completed, but no access token was found in ${auth.path}.`);
  }

  stderr.write("Codex device login completed.\n");
  return auth;
}

async function printUsage({
  auth,
  output,
  stdout,
  stderr,
  fetchImpl,
  nowMs,
  env,
  loadAuthFn,
  loadPhotonMarkBoostTokenFn,
  refreshAuthFn,
  spawnAsync,
  allowPartial
}) {
  const { auth: currentAuth, resetCredits, usage, photonmarkBoost, errors = [] } = await fetchUsageWithRefresh(auth, {
    env,
    stderr,
    fetchImpl,
    nowMs,
    loadAuthFn,
    loadPhotonMarkBoostTokenFn,
    refreshAuthFn,
    spawnAsync,
    allowPartial
  });

  if (output === "raw") {
    const raw = {
      usage: usage.payload,
      rate_limit_reset_credits: resetCredits.payload
    };
    if (usage.photonmarkBoost) {
      raw.photonmark_boost = usage.photonmarkBoost.payload;
    }
    stdout.write(`${JSON.stringify(raw)}\n`);
    return;
  }

  if (output === "influx") {
    const normalized = normalizePartialInfluxData(currentAuth, { usage, resetCredits, photonmarkBoost }, nowMs);
    if (normalized) {
      stdout.write(`${toInflux(normalized)}\n`);
    }
    if (errors.length > 0) {
      throw new Error(formatPartialErrors(errors));
    }
    return;
  }

  const normalized = normalizeUsage(usage.payload, {
    email: currentAuth.email,
    resetCreditsPayload: resetCredits.payload,
    timestamp: usage.timestamp
  });
  const boost = photonmarkBoost || usage?.photonmarkBoost;
  if (boost) {
    const normalizedPhotonmarkBoost = normalizePhotonMarkBoost(boost.payload);
    if (normalizedPhotonmarkBoost) {
      normalized.photonmark_boost = normalizedPhotonmarkBoost;
    }
  }

  if (output === "pretty") {
    stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(normalized)}\n`);
}

async function fetchUsageWithRefresh(auth, deps) {
  if (deps.allowPartial) {
    return fetchPartialUsageWithRefresh(auth, deps);
  }

  try {
    return {
      auth,
      ...(await fetchBackendData(auth, deps))
    };
  } catch (error) {
    if (!(error instanceof UsageError) || error.code !== "auth_failed") {
      throw error;
    }

    deps.stderr.write("Authentication failed; refreshing Codex auth with Codex CLI.\n");
    await deps.refreshAuthFn({
      env: deps.env,
      spawn: deps.spawnAsync,
      stderr: deps.stderr
    });

    const refreshedAuth = deps.loadAuthFn(deps.env);
    if (!refreshedAuth.ok) {
      throw new Error(`Codex auth refresh completed, but no access token was found in ${refreshedAuth.path}.`);
    }

    return {
      auth: refreshedAuth,
      ...(await fetchBackendData(refreshedAuth, deps))
    };
  }
}

async function fetchPartialUsageWithRefresh(auth, deps) {
  const result = await fetchBackendDataPartial(auth, deps);
  if (!result.errors.some(({ error }) => isAuthFailure(error))) {
    return { auth, ...result };
  }

  deps.stderr.write("Authentication failed; refreshing Codex auth with Codex CLI.\n");

  let refreshedAuth;
  try {
    await deps.refreshAuthFn({
      env: deps.env,
      spawn: deps.spawnAsync,
      stderr: deps.stderr
    });

    refreshedAuth = deps.loadAuthFn(deps.env);
    if (!refreshedAuth.ok) {
      throw new Error(`Codex auth refresh completed, but no access token was found in ${refreshedAuth.path}.`);
    }
  } catch (error) {
    return {
      auth,
      ...result,
      errors: [...result.errors, { label: "Codex auth refresh", error }]
    };
  }

  return {
    auth: refreshedAuth,
    ...(await fetchBackendDataPartial(refreshedAuth, deps))
  };
}

async function fetchBackendData(auth, deps) {
  const usage = await fetchUsage(auth, { fetch: deps.fetchImpl, nowMs: deps.nowMs });
  const resetCredits = await fetchResetCredits(auth, { fetch: deps.fetchImpl, nowMs: deps.nowMs });
  const loadPhotonMarkBoostTokenFn = deps.loadPhotonMarkBoostTokenFn || loadPhotonMarkBoostToken;
  const photonmarkBoostToken = loadPhotonMarkBoostTokenFn();
  const photonmarkBoost = photonmarkBoostToken.ok
    ? await fetchPhotonMarkBoost(photonmarkBoostToken.token, { fetch: deps.fetchImpl, nowMs: deps.nowMs })
    : undefined;
  return { usage: { ...usage, photonmarkBoost }, resetCredits };
}

async function fetchBackendDataPartial(auth, deps) {
  const result = { errors: [] };
  const attempt = async (label, operation, key) => {
    try {
      result[key] = await operation();
    } catch (error) {
      result.errors.push({ label, error });
    }
  };

  await attempt(
    "Usage",
    () => fetchUsage(auth, { fetch: deps.fetchImpl, nowMs: deps.nowMs }),
    "usage"
  );
  await attempt(
    "Reset credits",
    () => fetchResetCredits(auth, { fetch: deps.fetchImpl, nowMs: deps.nowMs }),
    "resetCredits"
  );

  const loadPhotonMarkBoostTokenFn = deps.loadPhotonMarkBoostTokenFn || loadPhotonMarkBoostToken;
  const photonmarkBoostToken = loadPhotonMarkBoostTokenFn();
  if (photonmarkBoostToken.ok) {
    await attempt(
      "PhotonMark Boost",
      () => fetchPhotonMarkBoost(photonmarkBoostToken.token, { fetch: deps.fetchImpl, nowMs: deps.nowMs }),
      "photonmarkBoost"
    );
  }

  return result;
}

function normalizePartialInfluxData(auth, { usage, resetCredits, photonmarkBoost }, nowMs) {
  if (!usage && !resetCredits && !photonmarkBoost) {
    return undefined;
  }

  const timestamp = usage?.timestamp
    ?? resetCredits?.timestamp
    ?? photonmarkBoost?.timestamp
    ?? Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000);
  const normalized = usage
    ? normalizeUsage(usage.payload, {
      email: auth.email,
      resetCreditsPayload: resetCredits?.payload,
      timestamp: usage.timestamp
    })
    : {
      timestamp,
      email: auth.email
    };

  if (!usage && resetCredits) {
    const normalizedResetCredits = normalizeResetCredits(resetCredits.payload, resetCredits.timestamp);
    if (normalizedResetCredits) {
      normalized.rate_limit_reset_credits = normalizedResetCredits;
    }
  }

  if (photonmarkBoost) {
    const normalizedPhotonmarkBoost = normalizePhotonMarkBoost(photonmarkBoost.payload);
    if (normalizedPhotonmarkBoost) {
      normalized.photonmark_boost = normalizedPhotonmarkBoost;
    }
  }

  return normalized;
}

function isAuthFailure(error) {
  return error instanceof UsageError && error.code === "auth_failed";
}

function formatPartialErrors(errors) {
  return errors.map(({ label, error }) => `${label}: ${formatError(error)}`).join("\n");
}

function formatError(error) {
  if (error instanceof UsageError) {
    return error.message;
  }
  return error && error.message ? error.message : String(error);
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  LOGIN_HINT,
  fetchBackendData,
  fetchUsageWithRefresh,
  main,
  outputFromEnv,
  ensureAuth,
  runLogin
};
