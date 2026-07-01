"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { escapeTag, toInflux } = require("../src/influx");

test("escapeTag escapes Influx tag characters", () => {
  assert.equal(escapeTag("a b,c=d\\e"), "a\\ b\\,c\\=d\\\\e");
});

test("toInflux emits primary and secondary rows", () => {
  const output = toInflux(
    {
      timestamp: 1780122381,
      email: "person, one@example.com",
      rate_limit: {
        primary_window: {
          used_percent: 2,
          limit_window_seconds: 18000,
          reset_after_seconds: 17956,
          reset_at: 1780140337
        },
        secondary_window: {
          used_percent: 27,
          limit_window_seconds: 604800,
          reset_after_seconds: 245230,
          reset_at: 1780367611
        }
      },
      rate_limit_reset_credits: {
        available_count: 1,
        next_granted_at: 1780122381,
        next_expires_at: 1780208781,
        next_expires_after_seconds: 86400
      },
      photonmark_boost: {
        active: true,
        entitlement_id: 130,
        email: "photonmark, one@example.com",
        balance_usd: 30,
        balance_usd_micros: 30000000,
        prepaid_usd: 30,
        prepaid_usd_micros: 30000000,
        spent_usd: 0,
        spent_usd_micros: 0,
        expires_at: 1785458000,
        seconds_remaining: 2589259,
        as_of: 1782868740
      }
    }
  );

  assert.equal(
    output,
    [
      "codex_usage_windows,email=person\\,\\ one@example.com,window=primary used_percent=2,limit_window_seconds=18000i,reset_after_seconds=17956i,reset_at=1780140337i 1780122381000000000",
      "codex_usage_windows,email=person\\,\\ one@example.com,window=secondary used_percent=27,limit_window_seconds=604800i,reset_after_seconds=245230i,reset_at=1780367611i 1780122381000000000",
      "codex_usage_resets,email=person\\,\\ one@example.com available_count=1i,next_granted_at=1780122381i,next_expires_at=1780208781i,next_expires_after_seconds=86400i 1780122381000000000",
      "codex_usage_photonmark_boost,email=person\\,\\ one@example.com proxy_user=\"photonmark, one@example.com\",active=1i,entitlement_id=130i,balance_usd=30,prepaid_usd=30,spent_usd=0,expires_at=1785458000i,seconds_remaining=2589259i 1780122381000000000"
    ].join("\n")
  );
});
