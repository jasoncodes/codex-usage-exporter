"use strict";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

class UsageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "UsageError";
    this.code = options.code || "usage_error";
    this.status = options.status;
  }
}

async function fetchUsage(auth, options = {}) {
  return fetchJsonEndpoint(USAGE_URL, "Usage", auth, options);
}

async function fetchResetCredits(auth, options = {}) {
  return fetchJsonEndpoint(RESET_CREDITS_URL, "Reset credits", auth, options);
}

async function fetchJsonEndpoint(url, label, auth, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new UsageError("No fetch implementation is available.", { code: "missing_fetch" });
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: requestHeaders(auth)
    });
  } catch (error) {
    throw new UsageError(`${label} request failed: ${error.message}`, { code: "network_error" });
  }

  if (response.status === 401 || response.status === 403) {
    throw new UsageError(`Authentication failed with HTTP ${response.status}.`, {
      code: "auth_failed",
      status: response.status
    });
  }

  if (!response.ok) {
    throw new UsageError(`${label} request failed with HTTP ${response.status}.`, {
      code: "api_error",
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
    throw new UsageError(`${label} response was not valid JSON: ${error.message}`, {
      code: "invalid_json"
    });
  }
}

function responseTimestampSeconds(response, nowMs = Date.now()) {
  const dateHeader = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("date")
    : undefined;
  const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
  const timestampMs = Number.isFinite(parsed) ? parsed : nowMs;
  return Math.floor(timestampMs / 1000);
}

function requestHeaders(auth) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.accessToken}`
  };

  if (auth.accountId) {
    headers["ChatGPT-Account-ID"] = auth.accountId;
  }

  return headers;
}

function normalizeUsage(payload, context = {}) {
  const nowSeconds = context.timestamp === undefined
    ? Math.floor((context.nowMs || Date.now()) / 1000)
    : context.timestamp;
  const source = findRateLimitSource(payload);

  if (!source) {
    throw new UsageError("Usage response did not contain rate limit data.", {
      code: "missing_rate_limit"
    });
  }

  const primary = normalizeWindow(source.primary_window || source.primary, nowSeconds);
  const secondary = normalizeWindow(source.secondary_window || source.secondary, nowSeconds);

  if (!primary || !secondary) {
    throw new UsageError("Usage response did not contain primary and secondary windows.", {
      code: "missing_windows"
    });
  }

  const normalized = {
    timestamp: nowSeconds,
    email: context.email || "unknown",
    rate_limit: {
      allowed: booleanWithDefault(source.allowed, inferAllowed(source)),
      limit_reached: booleanWithDefault(
        source.limit_reached,
        booleanWithDefault(source.rate_limit_reached, !inferAllowed(source))
      ),
      primary_window: primary,
      secondary_window: secondary
    }
  };

  const resetCredits = normalizeResetCredits(
    context.resetCreditsPayload || payload.rate_limit_reset_credits || payload.rateLimitResetCredits,
    nowSeconds
  );
  if (resetCredits) {
    normalized.rate_limit_reset_credits = resetCredits;
  }

  return normalized;
}

function findRateLimitSource(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  if (payload.rate_limit) {
    return payload.rate_limit;
  }
  if (payload.rateLimit) {
    return payload.rateLimit;
  }
  if (payload.primary || payload.primary_window) {
    return payload;
  }
  if (Array.isArray(payload.rate_limits) && payload.rate_limits.length > 0) {
    return payload.rate_limits.find((item) => item.primary || item.primary_window) || payload.rate_limits[0];
  }
  if (Array.isArray(payload.rateLimits) && payload.rateLimits.length > 0) {
    return payload.rateLimits.find((item) => item.primary || item.primary_window) || payload.rateLimits[0];
  }

  return undefined;
}

function normalizeWindow(window, nowSeconds) {
  if (!window || typeof window !== "object") {
    return undefined;
  }

  const usedPercent = numberFrom(window.used_percent, window.usedPercent, window.percent_used);
  const limitWindowSeconds = numberFrom(
    window.limit_window_seconds,
    window.limitWindowSeconds,
    window.window_seconds,
    window.windowSeconds,
    secondsFromMinutes(window.window_minutes),
    secondsFromMinutes(window.windowMinutes)
  );
  const resetAt = numberFrom(window.reset_at, window.resetAt, window.resets_at, window.resetsAt);
  const resetAfterSeconds = numberFrom(
    window.reset_after_seconds,
    window.resetAfterSeconds,
    resetAt === undefined ? undefined : Math.max(0, resetAt - nowSeconds)
  );

  if (usedPercent === undefined || limitWindowSeconds === undefined || resetAfterSeconds === undefined) {
    return undefined;
  }

  const normalized = {
    used_percent: usedPercent,
    limit_window_seconds: limitWindowSeconds,
    reset_after_seconds: resetAfterSeconds
  };

  normalized.reset_at = resetAt === undefined ? nowSeconds + resetAfterSeconds : resetAt;
  return normalized;
}

function normalizeResetCredits(source, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const credits = Array.isArray(source.credits)
    ? source.credits.map((credit) => normalizeResetCredit(credit, nowSeconds)).filter(Boolean)
    : undefined;
  const availableCount = numberFrom(
    source.available_count,
    source.availableCount,
    credits && credits.filter((credit) => credit.status === "available").length
  );

  if (availableCount === undefined && (!credits || credits.length === 0)) {
    return undefined;
  }

  const normalized = {};
  if (availableCount !== undefined) {
    normalized.available_count = availableCount;
  }
  if (credits && credits.length > 0) {
    normalized.credits = credits;
  }

  const nextCredit = nextExpiringAvailableCredit(credits);
  if (nextCredit) {
    if (nextCredit.granted_at !== undefined) {
      normalized.next_granted_at = nextCredit.granted_at;
    }
    normalized.next_expires_at = nextCredit.expires_at;
    normalized.next_expires_after_seconds = Math.max(0, nextCredit.expires_at - nowSeconds);
  }

  return normalized;
}

function normalizeResetCredit(credit, nowSeconds) {
  if (!credit || typeof credit !== "object") {
    return undefined;
  }

  const normalized = {
    id: stringOrUndefined(credit.id),
    reset_type: stringOrUndefined(credit.reset_type || credit.resetType),
    status: stringOrUndefined(credit.status),
    title: stringOrUndefined(credit.title)
  };

  const grantedAt = timestampFromIso(credit.granted_at || credit.grantedAt);
  const expiresAt = timestampFromIso(credit.expires_at || credit.expiresAt);
  const redeemStartedAt = timestampFromIso(credit.redeem_started_at || credit.redeemStartedAt);
  const redeemedAt = timestampFromIso(credit.redeemed_at || credit.redeemedAt);

  if (grantedAt !== undefined) {
    normalized.granted_at = grantedAt;
  }
  if (expiresAt !== undefined) {
    normalized.expires_at = expiresAt;
    normalized.expires_after_seconds = Math.max(0, expiresAt - nowSeconds);
  }
  if (redeemStartedAt !== undefined) {
    normalized.redeem_started_at = redeemStartedAt;
  }
  if (redeemedAt !== undefined) {
    normalized.redeemed_at = redeemedAt;
  }

  for (const key of Object.keys(normalized)) {
    if (normalized[key] === undefined) {
      delete normalized[key];
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function nextExpiringAvailableCredit(credits) {
  if (!credits) {
    return undefined;
  }

  return credits
    .filter((credit) => credit.status === "available" && credit.expires_at !== undefined)
    .sort((left, right) => left.expires_at - right.expires_at)[0];
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

function inferAllowed(source) {
  if (typeof source.has_credits === "boolean") {
    return source.has_credits;
  }
  if (typeof source.hasCredits === "boolean") {
    return source.hasCredits;
  }
  if (typeof source.rate_limit_reached === "boolean") {
    return !source.rate_limit_reached;
  }
  if (typeof source.limit_reached === "boolean") {
    return !source.limit_reached;
  }
  return true;
}

function booleanWithDefault(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function secondsFromMinutes(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number * 60 : undefined;
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

module.exports = {
  RESET_CREDITS_URL,
  USAGE_URL,
  UsageError,
  fetchResetCredits,
  fetchUsage,
  normalizeUsage,
  requestHeaders,
  responseTimestampSeconds
};
