# Telegraf MQTT Home Assistant Discovery

This setup keeps the existing InfluxDB metrics and publishes selected Telegraf
metrics to MQTT for Home Assistant discovery.

The exporter still runs as an `inputs.exec` command with
`CODEX_USAGE_OUTPUT=influx`, so Telegraf receives the normal
`codex_usage_windows` and `codex_usage_resets` points:

```text
codex_usage_windows,email=openai@example.com,window=primary used_percent=8,limit_window_seconds=18000i,reset_after_seconds=14400i,reset_at=1782032403i 1782015447000000000
codex_usage_windows,email=openai@example.com,window=secondary used_percent=66,limit_window_seconds=604800i,reset_after_seconds=325900i,reset_at=1782341347i 1782015447000000000
codex_usage_resets,email=openai@example.com available_count=1i,next_granted_at=1780172548i,next_expires_at=1782764548i,next_expires_after_seconds=2564567i 1782015447000000000
```

The Starlark processor preserves those original metrics and returns additional
`mqtt_output` and `mqtt_output_retain` metrics for MQTT publishing.

## MQTT Outputs

Use one non-retained output for live state payloads and one retained output for
Home Assistant discovery payloads:

```toml
[[outputs.mqtt]]
  alias = "mqtt_output"
  namepass = ["mqtt_output"]
  servers = ["tcp://127.0.0.1:1883"]
  username = "telegraf"
  password = "..."
  topic = '{{ .Tag "topic" }}'
  data_format = "template"
  template = '{{ .Field "payload" }}'

[[outputs.mqtt]]
  alias = "mqtt_output_retain"
  namepass = ["mqtt_output_retain"]
  servers = ["tcp://127.0.0.1:1883"]
  username = "telegraf"
  password = "..."
  topic = '{{ .Tag "topic" }}'
  data_format = "template"
  template = '{{ .Field "payload" }}'
  retain = true
```

## Codex Window Processor

```toml
[[processors.starlark]]
  alias = "codex_usage_windows_mqtt"
  namepass = ["codex_usage_windows"]
  source = '''
load("json.star", "json")
load("time.star", "time")

def topic_part(value):
    return str(value).lower().replace("/", "_").replace("+", "_").replace("#", "_").replace(" ", "_")

def object_id_part(value):
    return topic_part(value).replace("@", "_").replace(".", "_").replace(":", "_")

def iso_from_unix_seconds(value):
    if value == None:
        return None
    return time.from_timestamp(int(value)).format("2006-01-02T15:04:05Z07:00")

def mqtt_metric(topic, payload, retain=False):
    name = "mqtt_output_retain" if retain else "mqtt_output"
    m = Metric(name)
    m.tags["topic"] = topic
    m.fields["payload"] = payload
    return m

def sensor_discovery(topic, unique_id, name, state_topic, value_template, device, unit=None, device_class=None, state_class=None, suggested_display_precision=None):
    payload = {
        "name": name,
        "unique_id": unique_id,
        "state_topic": state_topic,
        "value_template": value_template,
        "device": device,
    }

    if unit != None:
        payload["unit_of_measurement"] = unit
    if device_class != None:
        payload["device_class"] = device_class
    if state_class != None:
        payload["state_class"] = state_class
    if suggested_display_precision != None:
        payload["suggested_display_precision"] = suggested_display_precision

    return mqtt_metric(topic, json.encode(payload), True)

def apply(metric):
    email = metric.tags.get("email", "")
    window = metric.tags.get("window", "")

    if not email or not window:
        return metric

    email_topic = topic_part(email)
    email_id = object_id_part(email)
    window_id = object_id_part(window)

    state_topic = "telegraf/codex_usage_windows/" + email_topic + "/" + topic_part(window)
    object_prefix = "codex_usage_windows_" + email_id + "_" + window_id
    discovery_prefix = "homeassistant/sensor/" + object_prefix

    collected_at = int(metric.time / 1000000000)
    payload = {
        "timestamp": iso_from_unix_seconds(collected_at),
    }

    for key, value in metric.fields.items():
        if key == "reset_at":
            payload[key] = iso_from_unix_seconds(value)
        else:
            payload[key] = value

    device = {
        "identifiers": ["codex_usage_exporter_" + email_id],
        "name": "Codex Usage " + email,
        "manufacturer": "OpenAI",
        "model": "Codex Usage Exporter",
    }

    window_name = "5h" if window == "primary" else "1w" if window == "secondary" else window

    return [
        metric,
        mqtt_metric(state_topic, json.encode(payload)),

        sensor_discovery(
            discovery_prefix + "_used_percent/config",
            object_prefix + "_used_percent",
            window_name + " used",
            state_topic,
            "{{ value_json.used_percent }}",
            device,
            unit="%",
            state_class="measurement",
            suggested_display_precision=0,
        ),

        sensor_discovery(
            discovery_prefix + "_reset_at/config",
            object_prefix + "_reset_at",
            window_name + " reset",
            state_topic,
            "{{ value_json.reset_at }}",
            device,
            device_class="timestamp",
        ),
    ]
'''
```

## Codex Reset Processor

```toml
[[processors.starlark]]
  alias = "codex_usage_resets_mqtt"
  namepass = ["codex_usage_resets"]
  source = '''
load("json.star", "json")
load("time.star", "time")

def topic_part(value):
    return str(value).lower().replace("/", "_").replace("+", "_").replace("#", "_").replace(" ", "_")

def object_id_part(value):
    return topic_part(value).replace("@", "_").replace(".", "_").replace(":", "_")

def iso_from_unix_seconds(value):
    if value == None:
        return None
    return time.from_timestamp(int(value)).format("2006-01-02T15:04:05Z07:00")

def mqtt_metric(topic, payload, retain=False):
    name = "mqtt_output_retain" if retain else "mqtt_output"
    m = Metric(name)
    m.tags["topic"] = topic
    m.fields["payload"] = payload
    return m

def sensor_discovery(topic, unique_id, name, state_topic, value_template, device, unit=None, device_class=None, state_class=None, suggested_display_precision=None):
    payload = {
        "name": name,
        "unique_id": unique_id,
        "state_topic": state_topic,
        "value_template": value_template,
        "device": device,
    }

    if unit != None:
        payload["unit_of_measurement"] = unit
    if device_class != None:
        payload["device_class"] = device_class
    if state_class != None:
        payload["state_class"] = state_class

    if suggested_display_precision != None:
        payload["suggested_display_precision"] = suggested_display_precision

    return mqtt_metric(topic, json.encode(payload), True)

def apply(metric):
    email = metric.tags.get("email", "")

    if not email:
        return metric

    email_topic = topic_part(email)
    email_id = object_id_part(email)

    state_topic = "telegraf/codex_usage_resets/" + email_topic
    object_prefix = "codex_usage_resets_" + email_id
    discovery_prefix = "homeassistant/sensor/" + object_prefix

    collected_at = int(metric.time / 1000000000)
    payload = {
        "timestamp": iso_from_unix_seconds(collected_at),
    }

    for key, value in metric.fields.items():
        if key == "next_granted_at" or key == "next_expires_at":
            payload[key] = iso_from_unix_seconds(value)
        else:
            payload[key] = value

    device = {
        "identifiers": ["codex_usage_exporter_" + email_id],
        "name": "Codex Usage " + email,
        "manufacturer": "OpenAI",
        "model": "Codex Usage Exporter",
    }

    return [
        metric,
        mqtt_metric(state_topic, json.encode(payload)),

        sensor_discovery(
            discovery_prefix + "_available_count/config",
            object_prefix + "_available_count",
            "resets available",
            state_topic,
            "{{ value_json.available_count }}",
            device,
            state_class="measurement",
            suggested_display_precision=0,
        ),

        sensor_discovery(
            discovery_prefix + "_next_expires_at/config",
            object_prefix + "_next_expires_at",
            "next reset expires",
            state_topic,
            "{{ value_json.next_expires_at }}",
            device,
            device_class="timestamp",
        ),
    ]
'''
```

## Published Topics

The state messages are not retained:

```text
telegraf/codex_usage_windows/openai@example.com/primary
telegraf/codex_usage_windows/openai@example.com/secondary
telegraf/codex_usage_resets/openai@example.com
```

Example state payload:

```json
{
  "limit_window_seconds": 18000,
  "reset_after_seconds": 16956,
  "reset_at": "2026-06-21T19:00:03+10:00",
  "timestamp": "2026-06-21T14:17:27+10:00",
  "used_percent": 8.0
}
```

Example reset state payload:

```json
{
  "available_count": 1,
  "next_expires_after_seconds": 2564567,
  "next_expires_at": "2026-07-18T10:22:28+10:00",
  "next_granted_at": "2026-06-18T10:22:28+10:00",
  "timestamp": "2026-06-21T14:17:27+10:00"
}
```

The Home Assistant discovery messages are retained:

```text
homeassistant/sensor/codex_usage_windows_openai_example_com_primary_used_percent/config
homeassistant/sensor/codex_usage_windows_openai_example_com_primary_reset_at/config
homeassistant/sensor/codex_usage_windows_openai_example_com_secondary_used_percent/config
homeassistant/sensor/codex_usage_windows_openai_example_com_secondary_reset_at/config
homeassistant/sensor/codex_usage_resets_openai_example_com_available_count/config
homeassistant/sensor/codex_usage_resets_openai_example_com_next_expires_at/config
```

Home Assistant should discover six sensors under the `Codex Usage <email>`
device:

```text
5h used
5h reset
1w used
1w reset
resets available
next reset expires
```

Because the discovery payloads include `unique_id`, Home Assistant will register
the entities and allow normal entity ID renames in the UI.

## Home Assistant Status Helper

Create a Template sensor helper to produce a voice-friendly summary string.

In Home Assistant, go to:

```text
Settings -> Devices & services -> Helpers -> Create helper -> Template -> Template a sensor
```

Use:

```text
Name: Status
Device: Codex Usage <email>
```

Use this state template, adjusting the entity IDs if Home Assistant generated
different ones for your MQTT discovery sensors:

```jinja
{% set five_used = states('sensor.codex_usage_openai_example_com_codex_5h_used') | float(0) %}
{% set week_used = states('sensor.codex_usage_openai_example_com_codex_1w_used') | float(0) %}
{% set reset_count = states('sensor.codex_usage_openai_example_com_resets_available') | int(0) %}
{% set five_reset = as_datetime(states('sensor.codex_usage_openai_example_com_codex_5h_reset')) if has_value('sensor.codex_usage_openai_example_com_codex_5h_reset') else none %}
{% set week_reset = as_datetime(states('sensor.codex_usage_openai_example_com_codex_1w_reset')) if has_value('sensor.codex_usage_openai_example_com_codex_1w_reset') else none %}
{% set reset_expiry = as_datetime(states('sensor.codex_usage_openai_example_com_next_reset_expires')) if has_value('sensor.codex_usage_openai_example_com_next_reset_expires') else none %}
{% macro duration_words(dt) -%}
  {%- set seconds = ((dt - now()).total_seconds() | int(0)) if dt else 0 -%}
  {%- set seconds = [seconds, 0] | max -%}
  {%- if seconds >= 86400 -%}
    {%- set days = ((seconds + 86399) // 86400) | int -%}
    {{ days }} {{ 'day' if days == 1 else 'days' }}
  {%- elif seconds >= 3600 -%}
    {%- set hours = ((seconds + 3599) // 3600) | int -%}
    {{ hours }} {{ 'hour' if hours == 1 else 'hours' }}
  {%- else -%}
    {%- set minutes = ((seconds + 59) // 60) | int -%}
    {{ minutes }} {{ 'minute' if minutes == 1 else 'minutes' }}
  {%- endif -%}
{%- endmacro %}
{{ (100 - five_used) | round(0) | int }}% remaining for {{ duration_words(five_reset) }}.
{{ (100 - week_used) | round(0) | int }}% remaining for {{ duration_words(week_reset) }}.
{% if reset_count > 0 %}{{ reset_count }} {{ 'reset' if reset_count == 1 else 'resets' }} available{% if reset_expiry %} expiring in {{ duration_words(reset_expiry) }}{% endif %}.{% endif %}
```

The duration calculation rounds up to the next whole unit so it matches Home
Assistant's relative timestamp display, for example `In 3 hours` rather than a
floored `2 hours` while the reset is still more than two hours away.

Example output without resets:

```text
88% remaining for 4 hours.
33% remaining for 4 days.
```

Example output with a reset:

```text
88% remaining for 4 hours.
33% remaining for 4 days.
1 reset available expiring in 21 days.
```

## Testing

Run Telegraf's exec input in test mode:

```bash
sudo -u telegraf telegraf --test --input-filter exec
```

Expected output includes the original `codex_usage_windows` metrics plus
additional `mqtt_output` and `mqtt_output_retain` metrics.

The Telegraf test mode does not publish to MQTT. To verify live publication,
listen to the relevant topics:

```bash
mosquitto_sub -h 127.0.0.1 -u telegraf -P '...' -v -t 'telegraf/codex_usage_windows/#'
mosquitto_sub -h 127.0.0.1 -u telegraf -P '...' -v -t 'telegraf/codex_usage_resets/#'
mosquitto_sub -h 127.0.0.1 -u telegraf -P '...' -v -t 'homeassistant/sensor/#'
```
