"use strict";

const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 30000;

function refreshAuth(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(options.env || {}),
    RUST_LOG: "off"
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let response;

    const child = spawnImpl("codex", ["app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      finish(new Error("Timed out while refreshing Codex auth."));
      killChild("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      finish(new Error(`Failed to run codex app-server: ${error.message}`));
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\n/);
      stdout = lines.pop();

      for (const line of lines) {
        handleLine(line);
      }
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (response) {
        finish();
        return;
      }

      const detail = stderr.trim() ? ` ${stderr.trim()}` : "";
      finish(new Error(`codex app-server exited before refreshing auth (code ${code}, signal ${signal}).${detail}`));
    });

    writeJson(child, {
      id: 0,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_usage_exporter",
          title: "Codex Usage Exporter",
          version: "0.0.0"
        }
      }
    });
    writeJson(child, { method: "initialized", params: {} });
    writeJson(child, {
      id: 1,
      method: "account/read",
      params: { refreshToken: true }
    });

    function handleLine(line) {
      if (!line.trim()) {
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id !== 1) {
        return;
      }

      response = message;
      if (message.error) {
        finish(new Error(`Codex auth refresh failed: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        finish();
      }
      killChild("SIGINT");
    }

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(response && response.result);
      }
    }

    function killChild(signal) {
      if (!child.killed) {
        child.kill(signal);
      }
    }
  });
}

function writeJson(child, payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

module.exports = {
  refreshAuth
};
