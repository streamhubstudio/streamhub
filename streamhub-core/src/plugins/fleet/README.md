# fleet plugin

IoT/agent fleet management over MQTT for the **StreamHub Agents** running against
an app. App-tab, `version 0.1.0`, **no worker** — the work is done by the in-core
`modules/fleet` service (an always-on MQTT subscriber + command publisher +
per-app `apps/<app>/fleet/fleet.db`), which reuses the app's existing `mqtt:`
broker (no second broker) and only activates when this plugin is installed +
enabled AND `mqtt.enabled` is on.

- Telemetry in: `<prefix>/agents/<agentId>/telemetry` (retained), status/LWT on
  `.../status`.
- Control out: `POST /apps/:app/plugins/fleet/command` → `<prefix>/agents/<id>/cmd`
  (`restart` | `ota` | `config` | `ping`); results on `.../cmd/result`.
- Data: `GET /apps/:app/plugins/fleet/agents`, `GET .../agents/:agentId`.

Full protocol, OTA flow and security model:
[https://streamhub.studio/docs/features/fleet](https://streamhub.studio/docs/features/fleet).
The agent side (`scripts/fleet_agent.py`, paho-mqtt) lives in the separate
`vision-agent` repo (branch `fleet-mqtt`).
