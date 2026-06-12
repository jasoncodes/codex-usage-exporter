# codex-usage-exporter

A container image to export current Codex usage limit data to JSON or InfluxDB Line Protocol for import into a time series database like InfluxDB via Telegraf.

Uses Codex CLI device authentication for authentication and polls the same usage API which the Codex app and ChatGPT website <https://chatgpt.com/codex/cloud/settings/analytics#usage> uses: `https://chatgpt.com/backend-api/wham/usage`.

Normal polling does not run a model command. If the usage request fails with HTTP 401 or 403, the exporter asks Codex CLI's app-server JSON-RPC API to refresh managed ChatGPT auth, rereads `auth.json`, and retries the usage request once.

## Build

Build the image with Compose:

```bash
docker compose build
```

## Authenticate

Run the container once and complete the device authentication flow. The compose stack included with the repo creates a Docker volume called `codex-usage-exporter` to store the token in.

```bash
docker compose run --rm -t codex-usage-exporter
```

## Telegraf Influx Example

Use `docker run` for Telegraf to avoid Compose wrapper output and TTY behavior:

```bash
sudo install -m 0644 codex-usage.conf /etc/telegraf/telegraf.d/codex-usage.conf
sudo systemctl restart telegraf
```

The included [`codex-usage.conf`](codex-usage.conf) contains:

```toml
[[inputs.exec]]
  commands = [
    "docker run --rm -e CODEX_USAGE_OUTPUT=influx -v codex-usage-exporter:/data codex-usage-exporter"
  ]
  interval = "5m"
  timeout = "30s"
  data_format = "influx"
```

The Telegraf service user must be able to run Docker. On Debian this is usually the `telegraf` user. Use one of these approaches:

```bash
sudo usermod -aG docker telegraf
sudo systemctl restart telegraf
```

Membership in the `docker` group is effectively root-equivalent. If you prefer not to add `telegraf` to that group, use `sudo` in the Telegraf command and allow only this Docker invocation in sudoers:

```toml
[[inputs.exec]]
  commands = [
    "sudo /usr/bin/docker run --rm -e CODEX_USAGE_OUTPUT=influx -v codex-usage-exporter:/data codex-usage-exporter"
  ]
  interval = "5m"
  timeout = "30s"
  data_format = "influx"
```

Example sudoers entry:

```sudoers
telegraf ALL=(root) NOPASSWD: /usr/bin/docker run --rm -e CODEX_USAGE_OUTPUT=influx -v codex-usage-exporter\:/data codex-usage-exporter
```

## Output Examples

Default compact JSON:

```bash
docker run --rm -v codex-usage-exporter:/data codex-usage-exporter
```

```json
{"timestamp":1780199981,"email":"person@example.com","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":2,"limit_window_seconds":18000,"reset_after_seconds":17956,"reset_at":1780217937},"secondary_window":{"used_percent":27,"limit_window_seconds":604800,"reset_after_seconds":245230,"reset_at":1780445211}},"rate_limit_reset_credits":{"available_count":1}}
```

Pretty JSON:

```bash
docker run --rm -e CODEX_USAGE_OUTPUT=pretty -v codex-usage-exporter:/data codex-usage-exporter
```

```json
{
  "timestamp": 1780199981,
  "email": "person@example.com",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 2,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 17956,
      "reset_at": 1780217937
    },
    "secondary_window": {
      "used_percent": 27,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 245230,
      "reset_at": 1780445211
    }
  },
  "rate_limit_reset_credits": {
    "available_count": 1
  }
}
```

Raw backend JSON:

```bash
docker run --rm -e CODEX_USAGE_OUTPUT=raw -v codex-usage-exporter:/data codex-usage-exporter
```

```json
{"rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":2,"limit_window_seconds":18000,"reset_after_seconds":17956},"secondary_window":{"used_percent":27,"limit_window_seconds":604800,"reset_after_seconds":245230}},"rate_limit_reset_credits":{"available_count":1}}
```

InfluxDB Line Protocol:

```bash
docker run --rm -e CODEX_USAGE_OUTPUT=influx -v codex-usage-exporter:/data codex-usage-exporter
```

```text
codex_usage,email=person@example.com,window=primary used_percent=2,limit_window_seconds=18000i,reset_after_seconds=17956i,reset_at=1780217937i 1780199981000000000
codex_usage,email=person@example.com,window=secondary used_percent=27,limit_window_seconds=604800i,reset_after_seconds=245230i,reset_at=1780445211i 1780199981000000000
codex_usage,email=person@example.com rate_limit_reset_credits_available_count=1i 1780199981000000000
```

`email` and `window` are tags. `used_percent` is emitted as a float-compatible numeric field; `limit_window_seconds`, `reset_after_seconds`, `reset_at`, and `rate_limit_reset_credits_available_count` are emitted as Influx integer fields. Reset-credit availability is emitted only when the backend includes it; the observed usage API response does not currently include reset-credit expiration timestamps.

The Influx timestamp is generated from the HTTP `Date` header on the usage API response, converted from Unix seconds to nanoseconds. If the header is missing or invalid, the exporter falls back to the local clock. The same Unix-seconds value is exposed as `timestamp` in normalized JSON.

## Development

```bash
npm test
```
