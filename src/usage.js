"use strict";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

class UsageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "UsageError";
    this.code = options.code || "usage_error";
    this.status = options.status;
  }
}

async function fetchUsage(auth, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new UsageError("No fetch implementation is available.", { code: "missing_fetch" });
  }

  let response;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: requestHeaders(auth)
    });
  } catch (error) {
    throw new UsageError(`Usage request failed: ${error.message}`, { code: "network_error" });
  }

  if (response.status === 401 || response.status === 403) {
    throw new UsageError(`Authentication failed with HTTP ${response.status}.`, {
      code: "auth_failed",
      status: response.status
    });
  }

  if (!response.ok) {
    throw new UsageError(`Usage request failed with HTTP ${response.status}.`, {
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
    throw new UsageError(`Usage response was not valid JSON: ${error.message}`, {
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

  const resetCredits = normalizeResetCredits(payload.rate_limit_reset_credits || payload.rateLimitResetCredits);
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

function normalizeResetCredits(source) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const availableCount = numberFrom(source.available_count, source.availableCount);
  if (availableCount === undefined) {
    return undefined;
  }

  return {
    available_count: availableCount
  };
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
  USAGE_URL,
  UsageError,
  fetchUsage,
  normalizeUsage,
  requestHeaders,
  responseTimestampSeconds
};
