"use strict";

function toInflux(payload, options = {}) {
  const timestamp = options.timestampNs || timestampNs(payload.timestamp);
  const email = payload.email || "unknown";
  const rateLimit = payload.rate_limit || {};
  const windows = Object.entries(rateLimit)
    .filter(([, window]) => window && typeof window === "object");

  const lines = windows
    .filter(([, window]) => window)
    .map(([name, window]) => {
      const windowName = name.endsWith("_window") ? name.slice(0, -"_window".length) : name;
      const tags = `email=${escapeTag(email)},window=${escapeTag(windowName)}`;
      const fields = [
        field("used_percent", window.used_percent),
        integerField("limit_window_seconds", window.limit_window_seconds),
        integerField("reset_after_seconds", window.reset_after_seconds),
        integerField("reset_at", window.reset_at)
      ].join(",");
      return `codex_usage_windows,${tags} ${fields} ${timestamp}`;
    });

  const resetCredits = payload.rate_limit_reset_credits;
  if (resetCredits && resetCredits.available_count !== undefined) {
    const tags = `email=${escapeTag(email)}`;
    const fields = [
      integerField("available_count", resetCredits.available_count),
      optionalIntegerField("next_granted_at", resetCredits.next_granted_at),
      optionalIntegerField("next_expires_at", resetCredits.next_expires_at),
      optionalIntegerField("next_expires_after_seconds", resetCredits.next_expires_after_seconds)
    ].filter(Boolean).join(",");
    lines.push(`codex_usage_resets,${tags} ${fields} ${timestamp}`);
  }

  const photonmarkBoost = payload.photonmark_boost;
  if (photonmarkBoost && photonmarkBoost.email) {
    const tags = `email=${escapeTag(email)}`;
    const fields = [
      stringField("proxy_user", photonmarkBoost.email),
      optionalBooleanIntegerField("active", photonmarkBoost.active),
      optionalIntegerField("entitlement_id", photonmarkBoost.entitlement_id),
      optionalField("balance_usd", photonmarkBoost.balance_usd),
      optionalField("prepaid_usd", photonmarkBoost.prepaid_usd),
      optionalField("spent_usd", photonmarkBoost.spent_usd),
      optionalIntegerField("expires_at", photonmarkBoost.expires_at),
      optionalIntegerField("seconds_remaining", photonmarkBoost.seconds_remaining)
    ].filter(Boolean).join(",");
    if (fields) {
      lines.push(`codex_usage_photonmark_boost,${tags} ${fields} ${timestamp}`);
    }
  }

  return lines.join("\n");
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

function optionalIntegerField(name, value) {
  return value === undefined || value === null ? undefined : integerField(name, value);
}

function optionalField(name, value) {
  return value === undefined || value === null ? undefined : field(name, value);
}

function optionalBooleanIntegerField(name, value) {
  return typeof value === "boolean" ? integerField(name, value ? 1 : 0) : optionalIntegerField(name, value);
}

function stringField(name, value) {
  if (value === undefined || value === null) {
    throw new Error(`Influx field ${name} must be a string.`);
  }
  return `${name}="${escapeStringField(value)}"`;
}

function escapeStringField(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeTag(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/ /g, "\\ ").replace(/=/g, "\\=");
}

module.exports = {
  toInflux,
  timestampNs,
  integerField,
  optionalField,
  optionalIntegerField,
  stringField,
  escapeTag
};
