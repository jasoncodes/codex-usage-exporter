"use strict";

function toInflux(payload, options = {}) {
  const timestamp = options.timestampNs || timestampNs(payload.timestamp);
  const email = payload.email || "unknown";
  const rateLimit = payload.rate_limit || {};
  const windows = [
    ["primary", rateLimit.primary_window],
    ["secondary", rateLimit.secondary_window]
  ];

  return windows
    .filter(([, window]) => window)
    .map(([name, window]) => {
      const tags = `email=${escapeTag(email)},window=${escapeTag(name)}`;
      const fields = [
        field("used_percent", window.used_percent),
        integerField("limit_window_seconds", window.limit_window_seconds),
        integerField("reset_after_seconds", window.reset_after_seconds)
      ].join(",");
      return `codex_usage,${tags} ${fields} ${timestamp}`;
    })
    .join("\n");
}

function timestampNs(timestampSeconds) {
  if (timestampSeconds === undefined || timestampSeconds === null) {
    return `${BigInt(Date.now()) * 1000000n}`;
  }

  const number = Number(timestampSeconds);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Influx timestamp must be a safe Unix seconds integer.");
  }

  return `${BigInt(number) * 1000000000n}`;
}

function field(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Influx field ${name} must be numeric.`);
  }
  return `${name}=${number}`;
}

function integerField(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Influx field ${name} must be a safe integer.`);
  }
  return `${name}=${number}i`;
}

function escapeTag(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/ /g, "\\ ").replace(/=/g, "\\=");
}

module.exports = {
  toInflux,
  timestampNs,
  integerField,
  escapeTag
};
