"use strict";

const fs = require("node:fs");
const path = require("node:path");

function authPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || "/root", ".codex");
  return path.join(home, "auth.json");
}

function loadAuth(env = process.env, filePath = authPath(env)) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: "missing_auth", path: filePath };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, reason: "invalid_auth_json", path: filePath, error };
  }

  const accessToken = parsed && parsed.tokens && parsed.tokens.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    return { ok: false, reason: "missing_token", path: filePath, auth: parsed };
  }

  return {
    ok: true,
    path: filePath,
    auth: parsed,
    accessToken,
    accountId: stringOrUndefined(parsed.tokens.account_id),
    email: extractEmail(parsed, env)
  };
}

function extractEmail(auth, env = process.env) {
  const idToken = auth && auth.tokens && auth.tokens.id_token;
  const email = idToken ? emailFromJwt(idToken) : undefined;
  return email || env.CODEX_ACCOUNT_EMAIL || "unknown";
}

function emailFromJwt(token) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return stringOrUndefined(payload.email);
  } catch {
    return undefined;
  }
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

module.exports = {
  authPath,
  loadAuth,
  extractEmail,
  emailFromJwt
};
