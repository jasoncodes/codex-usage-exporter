"use strict";

const fs = require("node:fs");
const { UsageError, responseTimestampSeconds } = require("./usage");

const PHOTONMARK_BOOST_STATUS_URL = "https://codex.photonmark.com/api/v1/services/boost/status";
const PHOTONMARK_BOOST_TOKEN_PATH = "/data/photonmark-boost.token";

function loadPhotonMarkBoostToken(filePath = PHOTONMARK_BOOST_TOKEN_PATH) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: "missing_token", path: filePath };
  }

  const token = normalizeToken(fs.readFileSync(filePath, "utf8"));
  if (!token) {
    return { ok: false, reason: "empty_token", path: filePath };
  }

  return { ok: true, path: filePath, token };
}

async function fetchPhotonMarkBoost(token, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new UsageError("No fetch implementation is available.", { code: "missing_fetch" });
  }

  let response;
  try {
    response = await fetchImpl(PHOTONMARK_BOOST_STATUS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    throw new UsageError(`PhotonMark Boost request failed: ${error.message}`, {
      code: "photonmark_network_error"
    });
  }

  if (!response.ok) {
    throw new UsageError(`PhotonMark Boost request failed with HTTP ${response.status}.`, {
      code: "photonmark_api_error",
      status: response.status
    });
  }

  const timestamp = responseTimestampSeconds(response, options.nowMs);
  try {
    return {
      payload: await response.json(),
      timestamp
    };
  } catch (error) {
    throw new UsageError(`PhotonMark Boost response was not valid JSON: ${error.message}`, {
      code: "photonmark_invalid_json"
    });
  }
}

function normalizePhotonMarkBoost(source) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const normalized = {
    service: stringOrUndefined(source.service),
    service_name: stringOrUndefined(source.service_name || source.serviceName),
    status: stringOrUndefined(source.status),
    raw_status: stringOrUndefined(source.raw_status || source.rawStatus),
    active: typeof source.active === "boolean" ? source.active : undefined,
    entitlement_id: integerFrom(source.entitlement_id, source.entitlementId),
    email: stringOrUndefined(source.proxy_user || source.proxyUser),
    balance_usd: numberFrom(source.balance_usd, source.balanceUsd),
    balance_usd_micros: integerFrom(source.balance_usd_micros, source.balanceUsdMicros),
    prepaid_usd: numberFrom(source.prepaid_usd, source.prepaidUsd),
    prepaid_usd_micros: integerFrom(source.prepaid_usd_micros, source.prepaidUsdMicros),
    spent_usd: numberFrom(source.spent_usd, source.spentUsd),
    spent_usd_micros: integerFrom(source.spent_usd_micros, source.spentUsdMicros),
    expires_at: timestampFromIso(source.expires_at || source.expiresAt),
    seconds_remaining: integerFrom(source.seconds_remaining, source.secondsRemaining),
    as_of: timestampFromIso(source.as_of || source.asOf)
  };

  for (const key of Object.keys(normalized)) {
    if (normalized[key] === undefined) {
      delete normalized[key];
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeToken(value) {
  const trimmed = String(value || "").trim();
  return trimmed.replace(/^Bearer\s+/i, "").trim();
}

function timestampFromIso(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return undefined;
}

function integerFrom(...values) {
  const number = numberFrom(...values);
  return Number.isSafeInteger(number) ? number : undefined;
}

module.exports = {
  PHOTONMARK_BOOST_STATUS_URL,
  PHOTONMARK_BOOST_TOKEN_PATH,
  fetchPhotonMarkBoost,
  loadPhotonMarkBoostToken,
  normalizePhotonMarkBoost,
  normalizeToken
};
