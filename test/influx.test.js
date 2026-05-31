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
          reset_after_seconds: 17956
        },
        secondary_window: {
          used_percent: 27,
          limit_window_seconds: 604800,
          reset_after_seconds: 245230
        }
      }
    }
  );

  assert.equal(
    output,
    [
      "codex_usage,email=person\\,\\ one@example.com,window=primary used_percent=2,limit_window_seconds=18000i,reset_after_seconds=17956i 1780122381000000000",
      "codex_usage,email=person\\,\\ one@example.com,window=secondary used_percent=27,limit_window_seconds=604800i,reset_after_seconds=245230i 1780122381000000000"
    ].join("\n")
  );
});
