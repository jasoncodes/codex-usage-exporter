"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { refreshAuth } = require("../src/refresh");

test("refreshAuth calls Codex app-server account/read with refreshToken", async () => {
  const calls = [];
  const result = await refreshAuth({
    env: { CODEX_HOME: "/data/codex" },
    timeoutMs: 1000,
    spawn: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return fakeChild((message, child) => {
        if (message.id === 1) {
          child.stdout.write(`${JSON.stringify({ id: 1, result: { account: null } })}\n`);
        }
      });
    }
  });

  assert.deepEqual(result, { account: null });
  assert.equal(calls[0].cmd, "codex");
  assert.deepEqual(calls[0].args, ["app-server", "--listen", "stdio://"]);
  assert.equal(calls[0].options.env.CODEX_HOME, "/data/codex");
  assert.equal(calls[0].options.env.RUST_LOG, "off");
});

test("refreshAuth rejects JSON-RPC errors", async () => {
  await assert.rejects(
    refreshAuth({
      timeoutMs: 1000,
      spawn: () => fakeChild((message, child) => {
        if (message.id === 1) {
          child.stdout.write(`${JSON.stringify({ id: 1, error: { message: "bad refresh" } })}\n`);
        }
      })
    }),
    /bad refresh/
  );
});

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.emit("close", null, signal);
  };

  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\n/);
    buffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) {
        onMessage(JSON.parse(line), child);
      }
    }
  });

  return child;
}
