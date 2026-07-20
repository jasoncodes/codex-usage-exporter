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

def duration_name(value, fallback):
    if value == None:
        return fallback

    seconds = int(value)
    if seconds > 0 and seconds % 604800 == 0:
        weeks = seconds // 604800
        return str(weeks) + (" week" if weeks == 1 else " weeks")
    if seconds > 0 and seconds % 86400 == 0:
        days = seconds // 86400
        return str(days) + (" day" if days == 1 else " days")
    if seconds > 0 and seconds % 3600 == 0:
        hours = seconds // 3600
        return str(hours) + (" hour" if hours == 1 else " hours")
    if seconds > 0 and seconds % 60 == 0:
        minutes = seconds // 60
        return str(minutes) + (" minute" if minutes == 1 else " minutes")
    if seconds > 0:
        return str(seconds) + (" second" if seconds == 1 else " seconds")
    return fallback

def mqtt_metric(topic, payload, retain=False):
    name = "mqtt_output_retain" if retain else "mqtt_output"
    m = Metric(name)
    m.tags["topic"] = topic
    m.fields["payload"] = payload
    return m

def sensor_discovery(topic, unique_id, default_entity_id, name, state_topic, value_template, device, unit=None, device_class=None, state_class=None, suggested_display_precision=None):
    payload = {
        "name": name,
        "unique_id": unique_id,
        "default_entity_id": default_entity_id,
        "state_topic": state_topic,
        "value_template": value_template,
        "json_attributes_topic": state_topic,
        "expire_after": 900,
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

    window_name = duration_name(metric.fields.get("limit_window_seconds"), window)
    entity_prefix = "sensor.codex_usage_" + email_id + "_" + window_id

    return [
        metric,
        mqtt_metric(state_topic, json.encode(payload)),

        sensor_discovery(
            discovery_prefix + "_used_percent/config",
            object_prefix + "_used_percent",
            entity_prefix + "_used",
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
            entity_prefix + "_reset",
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
            "{{ value_json.get('next_expires_at', none) }}",
            device,
            device_class="timestamp",
        ),
    ]
'''
```

## PhotonMark Boost Processor

```toml
[[processors.starlark]]
  alias = "codex_usage_photonmark_boost_mqtt"
  namepass = ["codex_usage_photonmark_boost"]
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

    state_topic = "telegraf/codex_usage_photonmark_boost/" + email_topic
    object_prefix = "codex_usage_photonmark_boost_" + email_id
    discovery_prefix = "homeassistant/sensor/" + object_prefix

    collected_at = int(metric.time / 1000000000)
    payload = {
        "timestamp": iso_from_unix_seconds(collected_at),
    }

    for key, value in metric.fields.items():
        if key == "expires_at":
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
            discovery_prefix + "_balance_usd/config",
            object_prefix + "_balance_usd",
            "boost balance",
            state_topic,
            "{{ value_json.balance_usd }}",
            device,
            unit="$",
            device_class="monetary",
            state_class="total",
            suggested_display_precision=2,
        ),

        sensor_discovery(
            discovery_prefix + "_prepaid_usd/config",
            object_prefix + "_prepaid_usd",
            "boost prepaid",
            state_topic,
            "{{ value_json.prepaid_usd }}",
            device,
            unit="$",
            device_class="monetary",
            state_class="total",
            suggested_display_precision=2,
        ),

        sensor_discovery(
            discovery_prefix + "_spent_usd/config",
            object_prefix + "_spent_usd",
            "boost spent",
            state_topic,
            "{{ value_json.spent_usd }}",
            device,
            unit="$",
            device_class="monetary",
            state_class="total",
            suggested_display_precision=2,
        ),

        sensor_discovery(
            discovery_prefix + "_expires_at/config",
            object_prefix + "_expires_at",
            "boost expires",
            state_topic,
            "{{ value_json.expires_at }}",
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
telegraf/codex_usage_photonmark_boost/openai@example.com
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

Example PhotonMark Boost state payload:

```json
{
  "active": 1,
  "balance_usd": 29.67,
  "entitlement_id": 130,
  "expires_at": "2026-07-31T10:33:20+10:00",
  "prepaid_usd": 30,
  "proxy_user": "photonmark@example.com",
  "seconds_remaining": 2589259,
  "spent_usd": 0.33,
  "timestamp": "2026-07-01T11:19:00+10:00"
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
homeassistant/sensor/codex_usage_photonmark_boost_openai_example_com_balance_usd/config
homeassistant/sensor/codex_usage_photonmark_boost_openai_example_com_prepaid_usd/config
homeassistant/sensor/codex_usage_photonmark_boost_openai_example_com_spent_usd/config
homeassistant/sensor/codex_usage_photonmark_boost_openai_example_com_expires_at/config
```

Window sensor discovery uses each point's `limit_window_seconds` field for its
display name. For example, a `604800`-second `primary` window is named `1 week`
rather than assuming every primary window is five hours. The discovery payload
also gives each window role a stable default entity ID:

```text
sensor.codex_usage_openai_example_com_primary_used
sensor.codex_usage_openai_example_com_primary_reset
sensor.codex_usage_openai_example_com_secondary_used
sensor.codex_usage_openai_example_com_secondary_reset
```

`default_entity_id` is applied when Home Assistant first creates an entity. It
does not override an entity ID already stored in Home Assistant's entity
registry.

Window sensors use `expire_after = 900`, three times the five-minute collection
interval. If a window disappears from the exporter output, its existing Home
Assistant entities become unavailable after 15 minutes and become available
again if the window returns. The state JSON is also exposed as entity attributes
through `json_attributes_topic`, including `limit_window_seconds` for status
templates that need a duration-derived label.

Home Assistant discovers two sensors for every window currently emitted under
the `Codex Usage <email>` device, plus two reset sensors and four optional Boost
sensors on the same device when Boost export is enabled. For a five-hour primary
and one-week secondary window, the display names are:

```text
5 hours used
5 hours reset
1 week used
1 week reset
resets available
next reset expires
boost balance
boost prepaid
boost spent
boost expires
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

Use this state template, adjusting the account portion of the entity IDs. It
uses the role-based default entity IDs from MQTT discovery and omits any window
whose used and reset sensors are unavailable:

```jinja
{% set primary_used_entity = 'sensor.codex_usage_openai_example_com_primary_used' %}
{% set primary_reset_entity = 'sensor.codex_usage_openai_example_com_primary_reset' %}
{% set secondary_used_entity = 'sensor.codex_usage_openai_example_com_secondary_used' %}
{% set secondary_reset_entity = 'sensor.codex_usage_openai_example_com_secondary_reset' %}
{% set reset_count = states('sensor.codex_usage_openai_example_com_resets_available') | int(0) %}
{% set reset_expiry = as_datetime(states('sensor.codex_usage_openai_example_com_next_reset_expires')) if has_value('sensor.codex_usage_openai_example_com_next_reset_expires') else none %}
{% set boost_balance_entity = 'sensor.codex_usage_openai_example_com_boost_balance' %}
{% set boost_expires_entity = 'sensor.codex_usage_openai_example_com_boost_expires' %}
{% set ns = namespace(lines=[]) %}
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
{% if has_value(primary_used_entity) and has_value(primary_reset_entity) %}
  {% set used = states(primary_used_entity) | float(0) %}
  {% set reset = as_datetime(states(primary_reset_entity)) %}
  {% set ns.lines = ns.lines + [((100 - used) | round(0) | int | string) ~ '% remaining for ' ~ duration_words(reset) ~ '.'] %}
{% endif %}
{% if has_value(secondary_used_entity) and has_value(secondary_reset_entity) %}
  {% set used = states(secondary_used_entity) | float(0) %}
  {% set reset = as_datetime(states(secondary_reset_entity)) %}
  {% set ns.lines = ns.lines + [((100 - used) | round(0) | int | string) ~ '% remaining for ' ~ duration_words(reset) ~ '.'] %}
{% endif %}
{% if reset_count > 0 %}
  {% set reset_line = (reset_count | string) ~ ' ' ~ ('reset' if reset_count == 1 else 'resets') ~ ' available' %}
  {% if reset_expiry %}
    {% set reset_line = reset_line ~ ' expiring in ' ~ duration_words(reset_expiry) %}
  {% endif %}
  {% set ns.lines = ns.lines + [reset_line ~ '.'] %}
{% endif %}
{% if has_value(boost_balance_entity) and has_value(boost_expires_entity) %}
  {% set boost_balance = states(boost_balance_entity) | float(0) %}
  {% set boost_expires = as_datetime(states(boost_expires_entity)) %}
  {% set ns.lines = ns.lines + ['$' ~ ("%.2f" | format(boost_balance)) ~ ' boost expiring in ' ~ duration_words(boost_expires) ~ '.'] %}
{% endif %}
{{ ns.lines | join('\n') }}
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
$29.67 boost expiring in 29 days.
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
mosquitto_sub -h 127.0.0.1 -u telegraf -P '...' -v -t 'telegraf/codex_usage_photonmark_boost/#'
mosquitto_sub -h 127.0.0.1 -u telegraf -P '...' -v -t 'homeassistant/sensor/#'
```
