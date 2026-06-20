#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { loadAuth } = require("./auth");
const { refreshAuth } = require("./refresh");
const { fetchResetCredits, fetchUsage, normalizeUsage, UsageError } = require("./usage");
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
      refreshAuthFn: deps.refreshAuth || refreshAuth,
      spawnAsync
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
  refreshAuthFn,
  spawnAsync
}) {
  const { auth: currentAuth, resetCredits, usage } = await fetchUsageWithRefresh(auth, {
    env,
    stderr,
    fetchImpl,
    nowMs,
    loadAuthFn,
    refreshAuthFn,
    spawnAsync
  });

  if (output === "raw") {
    stdout.write(`${JSON.stringify({
      usage: usage.payload,
      rate_limit_reset_credits: resetCredits.payload
    })}\n`);
    return;
  }

  const normalized = normalizeUsage(usage.payload, {
    email: currentAuth.email,
    resetCreditsPayload: resetCredits.payload,
    timestamp: usage.timestamp
  });

  if (output === "influx") {
    stdout.write(`${toInflux(normalized)}\n`);
    return;
  }

  if (output === "pretty") {
    stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(normalized)}\n`);
}

async function fetchUsageWithRefresh(auth, deps) {
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

async function fetchBackendData(auth, deps) {
  const usage = await fetchUsage(auth, { fetch: deps.fetchImpl, nowMs: deps.nowMs });
  const resetCredits = await fetchResetCredits(auth, { fetch: deps.fetchImpl, nowMs: deps.nowMs });
  return { usage, resetCredits };
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
