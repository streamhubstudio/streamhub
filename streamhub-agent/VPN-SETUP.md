# VPN Infrastructure (NetBird) — LEGACY / OPTIONAL

> **The StreamHub Agent does not require a VPN.** It reaches its StreamHub
> instance directly over HTTPS/RTMPS. A NetBird mesh is only useful as an
> out-of-band channel for remote SSH/HTTP administration of a device fleet.
>
> This document previously held live server credentials (dashboard admin
> password, setup keys, OAuth client secret, project id). **Those have been
> removed.** If any were ever real, rotate them. Do not commit secrets here —
> keep them in a secrets manager or the environment.

For the device-side integration (installing the NetBird client on a Luckfox,
the `S90netbird` init script, provisioning flow and troubleshooting) see
**`NETBIRD-INTEGRATION.md`** and `etc/setup-vpn.sh` (both credential-free).

## Topology (reference)

A self-hosted NetBird deployment groups peers so that:

| Group | Members | May reach |
|-------|---------|-----------|
| `iot-devices` | agent devices (Luckfox) | servers on TCP 443 / 1935 / 1883 (HTTPS, RTMP, MQTT) |
| `servers` | media / app / management servers | devices on TCP 80 / 554 (HTTP, RTSP) |
| `admin` | admin workstations | everything |

The management server runs the standard NetBird stack behind a TLS reverse proxy
(dashboard, management, signal, relay, coturn, IdP + database). Consult the
upstream NetBird docs for deployment; supply your own domain and credentials.

## Connecting a client

```bash
# Linux / server
curl -fsSL https://pkgs.netbird.io/install.sh | sh
sudo netbird up --setup-key <SETUP_KEY> --management-url https://<vpn-host>:443
sudo netbird status
```

Provide `<SETUP_KEY>` and `<vpn-host>` from your own NetBird deployment.
