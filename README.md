# codex-usage-exporter

A container image to export current Codex usage limit data to JSON or InfluxDB Line Protocol for import into a time series database like InfluxDB via Telegraf.

Uses Codex CLI device authentication for authentication and polls the same usage API which the Codex app and ChatGPT website <https://chatgpt.com/codex/cloud/settings/analytics#usage> uses: `https://chatgpt.com/backend-api/wham/usage`. Reset-credit expiry details are fetched from `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`. If `/data/photonmark-boost.token` exists, PhotonMark Codex Boost status is also fetched from `https://codex.photonmark.com/api/v1/services/boost/status`.

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

To enable optional PhotonMark Boost export, write the PhotonMark bearer token into the same Docker volume. The file may contain either the raw token or a `Bearer ...` value:

```bash
docker run --rm -it -v codex-usage-exporter:/data codex-usage-exporter bash -c 'read -rsp "PhotonMark Boost token: " token; printf "\n"; printf "%s\n" "$token" > /data/photonmark-boost.token'
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
    ["docker", "run", "--rm", "-e", "CODEX_USAGE_OUTPUT=influx", "-v", "codex-usage-exporter:/data", "codex-usage-exporter"]
  ]
  interval = "5m"
  timeout = "30s"
  ignore_error = true
  data_format = "influx"
```

In `influx` mode, the exporter emits every successful measurement before
returning a non-zero status if one or more requests failed. `ignore_error =
true` lets Telegraf parse those emitted Influx lines while still logging the
failed collection.

The Telegraf service user must be able to run Docker. On Debian this is usually the `telegraf` user. Use one of these approaches:

```bash
sudo usermod -aG docker telegraf
sudo systemctl restart telegraf
```

Membership in the `docker` group is effectively root-equivalent. If you prefer not to add `telegraf` to that group, use `sudo` in the Telegraf command and allow only this Docker invocation in sudoers:

```toml
[[inputs.exec]]
  commands = [
    ["sudo", "/usr/bin/docker", "run", "--rm", "-e", "CODEX_USAGE_OUTPUT=influx", "-v", "codex-usage-exporter:/data", "codex-usage-exporter"]
  ]
  interval = "5m"
  timeout = "30s"
  ignore_error = true
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
{"timestamp":1780199981,"email":"person@example.com","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":2,"limit_window_seconds":18000,"reset_after_seconds":17956,"reset_at":1780217937},"secondary_window":{"used_percent":27,"limit_window_seconds":604800,"reset_after_seconds":245230,"reset_at":1780445211}},"rate_limit_reset_credits":{"available_count":1,"credits":[{"id":"RateLimitResetCredit_1","reset_type":"codex_rate_limits","status":"available","title":"One free rate limit reset","granted_at":1780172548,"expires_at":1782764548,"expires_after_seconds":2564567}],"next_granted_at":1780172548,"next_expires_at":1782764548,"next_expires_after_seconds":2564567},"photonmark_boost":{"service":"boost","service_name":"Codex Boost","status":"active","raw_status":"active","active":true,"entitlement_id":130,"email":"photonmark@example.com","balance_usd":30,"balance_usd_micros":30000000,"prepaid_usd":30,"prepaid_usd_micros":30000000,"spent_usd":0,"spent_usd_micros":0,"expires_at":1785458000,"seconds_remaining":2589259,"as_of":1782868740}}
```

When present, compact JSON also includes the normalized top-level
`additional_rate_limits` array shown in the pretty JSON example below.

Pretty JSON:

```bash
docker run --rm -e CODEX_USAGE_OUTPUT=pretty -v codex-usage-exporter:/data codex-usage-exporter
```

When the backend reports an additional limit, normalized JSON includes it as a
top-level `additional_rate_limits` array alongside `rate_limit`. For example,
the `gpt-reserve` entry retains its `limit_name` and `metered_feature`, with
its normalized `rate_limit.primary_window`.

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
  "additional_rate_limits": [
    {
      "limit_name": "gpt-reserve",
      "metered_feature": "base_model_inference",
      "rate_limit": {
        "allowed": true,
        "limit_reached": false,
        "primary_window": {
          "used_percent": 0,
          "limit_window_seconds": 604800,
          "reset_after_seconds": 604800,
          "reset_at": 1780783921
        }
      }
    }
  ],
  "rate_limit_reset_credits": {
    "available_count": 1,
    "credits": [
      {
        "id": "RateLimitResetCredit_1",
        "reset_type": "codex_rate_limits",
        "status": "available",
        "title": "One free rate limit reset",
        "granted_at": 1780172548,
        "expires_at": 1782764548,
        "expires_after_seconds": 2564567
      }
    ],
    "next_granted_at": 1780172548,
    "next_expires_at": 1782764548,
    "next_expires_after_seconds": 2564567
  },
  "photonmark_boost": {
    "service": "boost",
    "service_name": "Codex Boost",
    "status": "active",
    "raw_status": "active",
    "active": true,
    "entitlement_id": 130,
    "email": "photonmark@example.com",
    "balance_usd": 30,
    "balance_usd_micros": 30000000,
    "prepaid_usd": 30,
    "prepaid_usd_micros": 30000000,
    "spent_usd": 0,
    "spent_usd_micros": 0,
    "expires_at": 1785458000,
    "seconds_remaining": 2589259,
    "as_of": 1782868740
  }
}
```

Raw backend JSON:

```bash
docker run --rm -e CODEX_USAGE_OUTPUT=raw -v codex-usage-exporter:/data codex-usage-exporter
```

```json
{"usage":{"rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":2,"limit_window_seconds":18000,"reset_after_seconds":17956},"secondary_window":{"used_percent":27,"limit_window_seconds":604800,"reset_after_seconds":245230}},"rate_limit_reset_credits":{"available_count":1}},"rate_limit_reset_credits":{"credits":[{"id":"RateLimitResetCredit_1","reset_type":"codex_rate_limits","status":"available","granted_at":"2026-06-18T00:22:28.036003Z","expires_at":"2026-07-18T00:22:28.036003Z","redeemed_at":null,"title":"One free rate limit reset"}],"available_count":1},"photonmark_boost":{"service":"boost","service_name":"Codex Boost","status":"active","raw_status":"active","active":true,"entitlement_id":130,"proxy_user":"photonmark@example.com","balance_usd":"30.0000","balance_usd_micros":30000000,"prepaid_usd":"30.0000","prepaid_usd_micros":30000000,"spent_usd":"0.0000","spent_usd_micros":0,"expires_at":"2026-07-31T00:33:20+00:00","seconds_remaining":2589259,"as_of":"2026-07-01T01:19:00+00:00"}}
```

InfluxDB Line Protocol:

```bash
docker run --rm -e CODEX_USAGE_OUTPUT=influx -v codex-usage-exporter:/data codex-usage-exporter
```

```text
codex_usage_windows,email=person@example.com,window=primary used_percent=2,limit_window_seconds=18000i,reset_after_seconds=17956i,reset_at=1780217937i 1780199981000000000
codex_usage_windows,email=person@example.com,window=secondary used_percent=27,limit_window_seconds=604800i,reset_after_seconds=245230i,reset_at=1780445211i 1780199981000000000
codex_usage_windows,email=person@example.com,window=gpt-reserve-primary used_percent=0,limit_window_seconds=604800i,reset_after_seconds=604800i,reset_at=1780783921i 1780199981000000000
codex_usage_resets,email=person@example.com available_count=1i,next_granted_at=1780172548i,next_expires_at=1782764548i,next_expires_after_seconds=2564567i 1780199981000000000
codex_usage_photonmark_boost,email=person@example.com proxy_user="photonmark@example.com",active=1i,entitlement_id=130i,balance_usd=30,prepaid_usd=30,spent_usd=0,expires_at=1785458000i,seconds_remaining=2589259i 1780199981000000000
```

`codex_usage_windows` uses `email` and `window` tags. `used_percent` is emitted as a float-compatible numeric field; `limit_window_seconds`, `reset_after_seconds`, and `reset_at` are emitted as Influx integer fields.

The `gpt-reserve` primary window is emitted in this same measurement with
`window=gpt-reserve-primary`. No series is emitted for its secondary window
when the API reports that window as `null`.

`codex_usage_resets` uses the `email` tag. `available_count`, `next_granted_at`, `next_expires_at`, and `next_expires_after_seconds` are emitted as Influx integer fields. The `next_*` fields are omitted when there is no available reset credit with an expiry timestamp. Individual reset-credit IDs are not emitted as tags to avoid creating a series per credit.

`codex_usage_photonmark_boost` is emitted only when `/data/photonmark-boost.token` exists and the PhotonMark request succeeds. It uses the Codex account email as the `email` tag and emits PhotonMark's `proxy_user` as a string field. `active`, `entitlement_id`, `expires_at`, and `seconds_remaining` are emitted as Influx integer fields; `balance_usd`, `prepaid_usd`, and `spent_usd` are emitted as numeric fields. Micros fields, `as_of`, and calculated percentages are intentionally omitted from Influx output.

The Influx timestamp is generated from the HTTP `Date` header on the usage API response, converted from Unix seconds to nanoseconds. If the header is missing or invalid, the exporter falls back to the local clock. The same Unix-seconds value is exposed as `timestamp` in normalized JSON.

See [`INFLUX_MIGRATION.md`](INFLUX_MIGRATION.md) for migration notes and InfluxQL backfill examples for the measurement split.

## Development

```bash
npm test
```
