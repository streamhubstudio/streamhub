# Devices — pairing and remote control of field encoders

**Since 3.4.x (branch `feat/encoder-core`). Off by default.** The device plane lets a field encoder
(`streamhub-encoder/`, or any device that speaks this protocol) join an app with a short code shown
on its screen, receive its publish endpoints without anyone typing a stream key, and be controlled
from the dashboard over an **outbound** WebSocket (works behind NAT / CGNAT, only needs 443).

It is gap E4 (+ E6) of `planning/SOFTWARE-ENCODER-PLAN.md` §5. Module: `streamhub-core-go/internal/devices`;
wiring: `cmd/streamhub/fielddevicesplane.go`; tables `devices`, `device_pairings`, `device_channels`
(global DB, migration `010`).

```bash
STREAMHUB_DEVICES_ENABLE=on    # default off: every route 503, the WS refuses
```

> **Wire contract.** This file IS the protocol the encoder implements. Changing a field, a frame or a
> status code means changing `streamhub-encoder` in the same release.

## 1. Pairing (device-code flow)

```
device                                   core                                 operator
  │ POST /api/v1/devices/pair/start ──────▶│                                      │
  │◀── {deviceId, code, pollToken, …} ─────│                                      │
  │  shows "K7Q4-M2XP" on LCD / UI / HDMI   │                                      │
  │                                         │◀── POST /apps/{app}/devices/claim ───│ {code, name}
  │ GET /api/v1/devices/pair/{id}?token=… ─▶│  (every pollInterval s)              │
  │◀── {status:"pending"} …                 │                                      │
  │◀── {status:"claimed", credential, wsUrl, app}   (exactly once)                 │
  │ WSS /api/v1/devices/ws  Authorization: Device dk_… ─▶                          │
```

### 1.1 `POST /api/v1/devices/pair/start` (public)

Body (all optional, ≤ 120 chars each): `{"model": "SH-ENC-4", "version": "0.3.1", "serial": "A1B2C3"}`.

`201`:

```json
{"data": {
  "deviceId": "dev_3f9c0a1b2c3d4e5f",
  "code": "K7Q4M2XP",
  "displayCode": "K7Q4-M2XP",
  "pollToken": "<43 chars base64url>",
  "expiresAt": "2026-10-29T12:10:00.000Z",
  "pollInterval": 5
}, "error": null}
```

- `code`: 8 symbols from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0 O 1 I L`), ≈ 8.5·10¹¹ codes. Show
  `displayCode`. The operator may type it in any case, with or without the dash.
- Unclaimed codes expire after **10 min** (`expiresAt`); start again for a new one.
- `pollToken` is the device's secret for step 1.2 — never display it.
- Limits: 10 starts/min per IP and at most 5 live pairings per IP (1000 in total) → `429`
  (`Retry-After` on the rate limit). `503` while the plane is off.

### 1.2 `GET /api/v1/devices/pair/{deviceId}?token=<pollToken>` (public)

Poll every `pollInterval` seconds (≤ 120/min per IP).

| Answer | Meaning |
|---|---|
| `200 {"data": {"status": "pending", "expiresAt": "…"}}` | not claimed yet |
| `200 {"data": {"status": "claimed", "deviceId": "dev_…", "credential": "dk_dev_….<secret>", "wsUrl": "wss://host/api/v1/devices/ws", "app": "live"}}` | claimed: **store the credential now** — it is delivered once and only its SHA-256 is kept server side |
| `404 {"statusCode":404,"message":"unknown or expired pairing","error":"Not Found"}` | expired, already delivered, unknown id or wrong token (indistinguishable). Five wrong tokens burn the pairing |
| `429` | polling too fast |

After a claim the device has 10 more minutes to pick the credential up. `wsUrl` derives from
`PUBLIC_BASE_URL` (`https` → `wss`), else from the request host.

### 1.3 Claim (operator) — `POST /api/v1/apps/{app}/devices/claim` (`app:write`)

`{"code": "k7q4-m2xp", "name": "Truck 2 — cam A"}` → `201` the device (§3). The code is single use: a
second claim, from this or any other app, is `404 invalid or expired pairing code`. Five wrong codes
from one account lock it out for 30 s (doubling, up to 15 min), and 30 claim attempts per minute per
IP → `429`. Failed claims are audited (`device.claim_failed`) and count as security offenses
(auto-ban when enabled). Unknown app → `404 app not found`.

## 2. Control channel — `wss://<host>/api/v1/devices/ws`

Upgrade with **`Authorization: Device <credential>`** (the header only — never a query string).
`401 invalid device credential` for a bad, tampered or revoked credential; `403` from a blocked IP;
`503` while the plane is off. One socket per device: a newer one closes the older with **`4409`**.
A revoked device is closed with **`4401`** — stop reconnecting and go back to pairing.

The core sends protocol-level WS pings every 15 s; 3 unanswered → closed. Any WS library answers
them automatically. Text frames only, JSON objects with a `type`; ≤ 1 MiB per frame. Reconnect with
backoff (1 s → 30 s) on any other close.

### 2.1 device → core

**`hello`** — first frame after connecting (and again after any local change of capabilities). The
core answers with `config`.

```json
{"type": "hello", "model": "SH-ENC-4", "version": "0.3.1", "serial": "A1B2C3",
 "capabilities": {"channels": [{"id": "1", "name": "SDI 1"}, {"id": "2", "name": "SDI 2"}],
                  "encoders": ["x264", "nvenc_h264", "nvenc_hevc"], "protocols": ["rtmp", "srt"]}}
```

`capabilities` is free-form JSON (≤ 32 KiB), stored verbatim and shown in the dashboard; the
`channels` list is what the dashboard offers to link (§4).

**`status`** — every 5–15 s and on any state change. The whole frame (minus `type`, plus
`receivedAt`) is stored as the device's latest status (≤ 64 KiB) and its `lastSeenAt` is bumped.

```json
{"type": "status", "cpu": 41.5, "gpu": 12, "temperature": 61, "uptimeSec": 86400,
 "channels": [{"id": "1", "state": "live", "bitrateKbps": 6000, "fps": 50, "input": "1080p50", "error": null},
              {"id": "2", "state": "error", "error": "no input signal"}],
 "errors": []}
```

Suggested channel `state`: `idle | starting | live | reconnecting | error | stopped`.

**`command_result`** — the answer to a `command`, within 10 s:
`{"type": "command_result", "id": "<command id>", "ok": true, "message": "restarted"}`.

**`ping`** → the core answers `{"type":"pong"}` (optional JSON keepalive).

### 2.2 core → device

**`config`** — the desired configuration, sent after `hello` and whenever it changes (rename, a
channel linked/unlinked). `rev` increases on every change; apply the newest.

```json
{"type": "config", "rev": 3,
 "device": {"id": "dev_3f9c0a1b2c3d4e5f", "name": "Truck 2 — cam A", "app": "live"},
 "channels": [
   {"id": "1", "name": "SDI 1", "room": "live-truck2", "protocol": "rtmp",
    "publishUrl": "rtmp://media.example.com:1935/live/AbCdEf", "streamKey": "AbCdEf", "ingressId": "IN_x"},
   {"id": "2", "room": "live-truck2-hevc", "protocol": "srt",
    "publishUrl": "srt://media.example.com:8890?streamid=publish:live/ptk_…", "streamKey": "ptk_…", "ingressId": "pti_srt_…"}
 ]}
```

`publishUrl` is complete (key included): push there as is. A channel absent from `channels` must
not publish. Keys are never typed by a human; rotating one is a new `config`.

**`command`** — `{"type": "command", "id": "<uuid>", "action": "restart", "channel": "1"}`.

| `action` | fields | effect |
|---|---|---|
| `start` / `stop` / `restart` | `channel` | the channel's pipeline |
| `apply_preset` | `channel`, `preset` | load a local preset on the channel |
| `reboot` | — | reboot the device (the REST call requires `confirm: true`) |

Answer every command with `command_result` (unknown action → `ok:false`).

**`error`** — `{"type":"error","message":"invalid frame"}` for a non-JSON / typeless / unknown frame.

## 3. Dashboard

App → **Encoders** tab (`streamhub-web/src/pages/AppDetail/DevicesTab.tsx`): claim by
code, the device cards (online, last seen, CPU/GPU/temperature, errors), per channel the
reported state / bitrate / fps, link to a room (RTMP or SRT) with the publish URL the
core pushed, start / stop / restart, rename, reboot (confirmed) and revoke. With the
plane off the tab explains how to enable it.

## 3b. Management API (app-scoped)

See [api/README.md § Devices](../api/README.md#devices-field-encoders-pairing--control). The
device object:

```json
{"id": "dev_…", "app": "live", "name": "Truck 2 — cam A", "model": "SH-ENC-4", "version": "0.3.1",
 "serial": "A1B2C3", "paired": true, "online": true, "lastSeenAt": "…", "lastIp": "203.0.113.9",
 "capabilities": {…}, "status": {…}, "configRev": 3, "createdAt": "…", "createdBy": "<user id>",
 "channels": [{"id": "1", "room": "live-truck2", "protocol": "rtmp", "ingressId": "…", "publishUrl": "…", "streamKey": "…", "createdAt": "…"}]}
```

`paired:false` means claimed but the device has not picked its credential up yet.

Revoking (`DELETE /apps/{app}/devices/{id}`) deletes the device row, its pairing, its channels **and
their ingresses** (a revoked device can't keep pushing with a key it still holds), and closes the
live socket with `4401`. To bring it back, pair again (a new id and credential).

## 4. Channels → streams (E6)

`PUT /apps/{app}/devices/{id}/channels/{channel}` `{room, protocol: "rtmp"|"srt", name?}` links a
device channel to a room: the core creates the ingress through the same service as
`POST /apps/{app}/ingress` (quotas, `rtmp.passthrough`, MediaMTX all apply) — `rtmp` is the LiveKit
plane (transcode, WebRTC + HLS), `srt` is the passthrough plane (`-c copy` → HLS; needs
`STREAMHUB_RTMP_PASSTHROUGH_ENABLE`, and the MediaMTX SRT front for key auth, see
[rtmp-single-port.md](rtmp-single-port.md#srt)). Re-linking replaces the old ingress.
`DELETE …/channels/{channel}` unlinks and deletes the ingress. Each change pushes a new `config`.

`GET /apps/{app}/streams` (and `/streams/{id}`) carry `sourceDevice: {deviceId, name, channel}` on a
stream whose room is fed by a linked channel (absent otherwise).

## 5. Security notes

| Threat | Mitigation |
|---|---|
| Guessing a pairing code | 31⁸ space, 10 min TTL, single use, per-account backoff + per-IP window, audit + auto-ban offense |
| Stealing the credential from the poll | `pollToken` (256-bit) required; delivered once; 5 wrong tokens burn the pairing |
| Credential at rest | only `sha256(credential)` stored; constant-time compare; `dk_<deviceId>.<secret>` binds it to one device |
| Credential replay after revoke | row deleted → `401`; live socket closed `4401` |
| Cross-app access | every management query filters by `app`; app-scoped tokens are confined by the authz guard |
| Credential leak in logs | header-only (`Authorization: Device`), never `?token=` |
| What a device credential can do | **only** the device WS: it is not an `sk_` token and opens no REST route |
