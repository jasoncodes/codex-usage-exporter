"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadAuth, emailFromJwt } = require("../src/auth");

test("loadAuth reads access token, account id, and email", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(
    path.join(dir, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "access",
        account_id: "acct",
        id_token: jwt({ email: "person@example.com" })
      }
    })
  );

  const auth = loadAuth({ HOME: dir });
  assert.equal(auth.ok, true);
  assert.equal(auth.accessToken, "access");
  assert.equal(auth.accountId, "acct");
  assert.equal(auth.email, "person@example.com");
});

test("loadAuth reports missing auth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  const auth = loadAuth({ HOME: dir });
  assert.equal(auth.ok, false);
  assert.equal(auth.reason, "missing_auth");
});

test("loadAuth reports missing token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(path.join(dir, ".codex", "auth.json"), JSON.stringify({ tokens: {} }));

  const auth = loadAuth({ HOME: dir });
  assert.equal(auth.ok, false);
  assert.equal(auth.reason, "missing_token");
});

test("loadAuth falls back to CODEX_ACCOUNT_EMAIL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(
    path.join(dir, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "access" } })
  );

  const auth = loadAuth({ HOME: dir, CODEX_ACCOUNT_EMAIL: "fallback@example.com" });
  assert.equal(auth.ok, true);
  assert.equal(auth.email, "fallback@example.com");
});

test("emailFromJwt returns undefined for invalid tokens", () => {
  assert.equal(emailFromJwt("not-a-jwt"), undefined);
});

function jwt(payload) {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}
