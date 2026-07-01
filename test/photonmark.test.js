"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  PHOTONMARK_BOOST_STATUS_URL,
  fetchPhotonMarkBoost,
  loadPhotonMarkBoostToken,
  normalizePhotonMarkBoost,
  normalizeToken
} = require("../src/photonmark");

test("loadPhotonMarkBoostToken reports absent token file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photonmark-token-"));
  assert.deepEqual(loadPhotonMarkBoostToken(path.join(dir, "missing.token")), {
    ok: false,
    reason: "missing_token",
    path: path.join(dir, "missing.token")
  });
});

test("loadPhotonMarkBoostToken trims plain and bearer token files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photonmark-token-"));
  const plainPath = path.join(dir, "plain.token");
  const bearerPath = path.join(dir, "bearer.token");
  fs.writeFileSync(plainPath, "  plain-token\n");
  fs.writeFileSync(bearerPath, "Bearer bearer-token\n");

  assert.equal(loadPhotonMarkBoostToken(plainPath).token, "plain-token");
  assert.equal(loadPhotonMarkBoostToken(bearerPath).token, "bearer-token");
  assert.equal(normalizeToken(" bearer another-token "), "another-token");
});

test("fetchPhotonMarkBoost calls PhotonMark endpoint with bearer auth", async () => {
  const payload = samplePhotonMarkBoost();
  const calls = [];
  const result = await fetchPhotonMarkBoost("boost-token", {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ date: "Wed, 01 Jul 2026 01:19:00 GMT" }),
        json: async () => payload
      };
    }
  });

  assert.equal(calls[0].url, PHOTONMARK_BOOST_STATUS_URL);
  assert.deepEqual(calls[0].options.headers, {
    Accept: "application/json",
    Authorization: "Bearer boost-token"
  });
  assert.deepEqual(result, { payload, timestamp: 1782868740 });
});

test("fetchPhotonMarkBoost rejects HTTP and invalid JSON failures", async () => {
  await assert.rejects(
    fetchPhotonMarkBoost("boost-token", {
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
    }),
    /PhotonMark Boost request failed with HTTP 500/
  );

  await assert.rejects(
    fetchPhotonMarkBoost("boost-token", {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        }
      })
    }),
    /PhotonMark Boost response was not valid JSON/
  );
});

test("normalizePhotonMarkBoost keeps useful JSON fields", () => {
  assert.deepEqual(normalizePhotonMarkBoost(samplePhotonMarkBoost()), {
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
