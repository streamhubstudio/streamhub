# Ingress (RTMP / WHIP / RTSP-relay)

## What it does

Ingest external media into a LiveKit room of the app using LiveKit's ingress
service. Three input types:

- **rtmp** — returns a push URL + **stream key** (OBS/ffmpeg push to
  `rtmp://<RTMP_PUBLIC_HOST>:1935/live/<key>`). When RTMPS is enabled (see
  [RTMPS ingest](#rtmps-tls-terminated-rtmp-in) below) the response also carries
  an `rtmps_url` for encrypted push. Optionally a **stream password**
  (feature `rtmpPassword`): LiveKit has no native RTMP password, so StreamHub
  registers the ingress and, on `ingress_started`, **terminates** the push if it
  was not authorized via `POST /ingress/:id/validate` first.
- **whip** — a WHIP (WebRTC-HTTP) endpoint.
- **url** — pull a remote source (e.g. `rtsp://camera/stream`) = RTSP relay.
- **srt** — an SRT **push** listener (passthrough/remux only; requires
  `mode:'passthrough'`) — see [rtmp-passthrough.md](rtmp-passthrough.md).
- **mpegts** — **PULL** an MPEG-TS-over-UDP unicast/multicast source
  (`url:'udp://@GROUP:PORT'`, passthrough/remux only) — see
  [mpegts-multicast.md](mpegts-multicast.md).

RTMP/URL ingest defaults to **transcoding on** (multi-layer) — required for the
adaptive player; WHIP defaults off unless the app opts in. Creating an ingress
counts against `max_concurrent_streams`.

## Endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/ingress` | ingress:create | Create an RTMP/WHIP/URL/SRT/MPEG-TS ingress |
| GET | `/ingress` | ingress:read | List ingresses for the app |
| GET | `/ingress/:id` | ingress:read | Get one ingress |
| DELETE | `/ingress/:id` | ingress:delete | Delete an ingress |
| POST | `/ingress/:id/validate` | ingress:write | Validate the RTMP stream password |

### POST /apps/:app/ingress — body

```json
{
  "inputType": "rtmp",
  "room": "demo",
  "participantIdentity": "rtmp-publisher",
  "participantName": "RTMP source",
  "url": "rtsp://camera.local/stream",
  "enableTranscoding": true
}
```

- `inputType` ∈ {rtmp, whip, url, srt, mpegts} (required). `srt`/`mpegts` are
  passthrough-only (require `mode:'passthrough'`).
- `url` required when `inputType=url` (remote pull) or `inputType=mpegts`
  (`udp://@GROUP:PORT` source; optional `sources`/`localaddr`/`fifoSize`/
  `overrunNonfatal` for SSM/interface/buffer tuning).
- `room` defaults to the app prefix (namespaced).
- `enableTranscoding` defaults from `adaptivePlayer`/`rtmp.transcode` (rtmp/url on).
- `backup` (RTMP only, default `false`) — also mint a backup/failover key into
  the same room. See [Primary + backup stream keys](#primary--backup-failover-stream-keys).

### Response

```json
{ "data": {
  "ingressId": "IN_xxx",
  "streamKey": "abc123",
  "url": "...",                       
  "rtmp_url": "rtmp://media.digitalhub.com.ar:1935/live/abc123",
  "rtmps_url": "rtmps://media.digitalhub.com.ar:1936/live/abc123", // only when STREAMHUB_RTMPS_ENABLE=true
  "stream_key": "abc123",
  "stream_password": "s3cr3t",        // only when rtmpPassword feature on
  "requires_password": true,
  "adaptive": true,
  "player_url": "https://streamhub.digitalhub.com.ar/play/demo/demo",
  "embed_iframe": "<iframe ...></iframe>"
} }
```

`GET /ingress` also returns `stream_key` + `rtmp_url` (+ `rtmps_url` when
enabled) on each row so the panel can show OBS settings after creation (not just
at create time).

## Primary + backup (failover) stream keys

For encoder redundancy (Dacast/Vimeo-style "primary + backup stream key"), an
**RTMP** create can request a second key: pass `"backup": true`. StreamHub then
mints **two** LiveKit ingresses bound to the **same room** — a `primary` and a
`backup` — with distinct participant identities (`<identity>` and
`<identity>-backup`). Because both keys publish into the **one room**, the
playback URL / player is **identical** whichever key is live (same HLS/WebRTC
URLs). Point a redundant/failover encoder at the backup key; if the primary
encoder drops, start pushing the backup and the channel stays live **with no URL
change**.

### Create response (with `backup: true`)

The response keeps the legacy single-key fields (`stream_key`, `rtmp_url`, …)
and adds the primary/backup surface:

```json
{ "data": {
  "ingressId": "IN_primary",
  "role": "primary",
  "hasBackup": true,
  "stream_key": "keyA",
  "primaryStreamKey": "keyA",
  "primary_rtmp_url":  "rtmp://<host>:1935/live/keyA",
  "primary_rtmps_url": "rtmps://<host>:1936/live/keyA",   // only when RTMPS on
  "backupIngressId": "IN_backup",
  "backupStreamKey": "keyB",
  "backup_stream_key": "keyB",
  "backup_rtmp_url":  "rtmp://<host>:1935/live/keyB",
  "backup_rtmps_url": "rtmps://<host>:1936/live/keyB",
  "backup_stream_password": "…",                          // only with rtmpPassword
  "player_url": "https://…/play/demo/demo",
  "embed_iframe": "<iframe …></iframe>"
} }
```

`GET /ingress` and `GET /ingress/:id` annotate each row with its `role`
(`primary`/`backup`) and `pairedIngressId`; a **primary** row also carries its
sibling's `backupStreamKey` / `backup_rtmp_url` so the dashboard can reveal both
keys from one row. Each key has its **own** `ingress_auth` row (and its own
optional stream password), so validating/authorizing one key never touches the
other.

### Semantics & limitations (honest)

- **Backup is standby, primary preferred.** StreamHub does **not** force-switch
  or auto-mute: it is an operational convention that only one encoder pushes at
  a time. Keep the failover encoder configured but idle; start it only when the
  primary drops.
- **Simultaneous dual-push = two publishers.** If BOTH keys push at once, the
  room has two `INGRESS` participants, each with its own tracks. LiveKit has no
  native "ingress precedence", so a naive player that renders the *first* video
  track may show either source. This is why the pair uses **distinct**
  participant identities — same-identity ingresses would make LiveKit evict one
  when the other joins, which is the opposite of "primary wins". Server-side
  auto-switch on the primary's `ingress_ended` is a possible future enhancement;
  it is intentionally omitted to keep the behaviour simple and correct.
- **Delete cascade.** Deleting a **primary** also tears down its paired backup
  ingress (they are one logical endpoint, so no orphan key is left accepting a
  push into the room); deleting a **backup** only unlinks the pair.
- **Quota.** Only the create is pre-checked against `max_concurrent_streams`; a
  standby backup consumes a slot only if/when it actually publishes.

Storage: the primary↔backup pairing lives in a per-app `ingress_backup_links`
table (created lazily in `apps/<app>/app.db`); the keys/passwords themselves
stay in `ingress_auth`, one row per key.

### RTMPS (TLS-terminated RTMP-in)

Plain RTMP (`:1935`) is unencrypted. For encrypted push, StreamHub ships an
opt-in TLS front (`stunnel`) that terminates TLS on `:1936` and forwards the
decrypted stream to the plaintext ingress on `:1935`. LiveKit ingress has no
native RTMPS listener — this transparent front is the supported pattern, and
because it is byte-transparent the **`rtmps_url` is the `rtmp_url` with only the
scheme and port swapped** (same `/live/<key>` path, same stream key):

```
rtmp://<host>:1935/live/<key>   →   rtmps://<host>:1936/live/<key>
```

Enable it (two steps, both required):

1. `.env`: `STREAMHUB_RTMPS_ENABLE=true` (core then advertises `rtmps_url`) and
   `STREAMHUB_RTMPS_CERT_DIR` pointing at a dir holding `fullchain.pem` +
   `privkey.pem` (nginx+certbot: `/etc/letsencrypt/live/<domain>` as-is).
2. `docker compose --profile rtmps up -d`, then `ufw allow 1936/tcp`.

Optional knobs: `STREAMHUB_RTMPS_PORT` (default `1936`), `RTMPS_PUBLIC_HOST`
(defaults to `RTMP_PUBLIC_HOST`). Full var reference + Caddy-shape cert notes in
[operations/ENV.md](../operations/ENV.md#rtmps-ingest-tls-terminated-rtmp-in).
Push with OBS: Server `rtmps://<host>:1936/live`, Stream Key = the stream key.

### POST /apps/:app/ingress/:id/validate — body

```json
{ "password": "s3cr3t" }
```

Marks the ingress authorized. Meant to be called (e.g. by an RTMP edge
`on_publish` hook, or the panel) before/while the push starts. Returns
`{ data: { ingressId, valid } }`. If an RTMP push starts unauthorized, the
webhook handler deletes the ingress and fires `stream_ended` with reason
`unauthorized_rtmp_password`.

## Examples

```bash
# RTMP ingress (with password feature enabled on the app)
curl -s -X POST $BASE/apps/demo/ingress -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputType":"rtmp","room":"demo"}'

# authorize the RTMP password before pushing
curl -s -X POST $BASE/apps/demo/ingress/IN_xxx/validate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"password":"s3cr3t"}'

# RTSP relay (pull)
curl -s -X POST $BASE/apps/demo/ingress -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputType":"url","room":"cam1","url":"rtsp://camera.local/stream"}'

# push with OBS/ffmpeg
ffmpeg -re -i input.mp4 -c:v libx264 -c:a aac -f flv \
  rtmp://media.digitalhub.com.ar:1935/live/abc123
```

## Notes

- The public RTMP host is `RTMP_PUBLIC_HOST`; the ingest port is `1935`, path `/live/<key>`.
- An ingress publisher appears in LiveKit as a participant of kind `INGRESS`;
  the webhook layer dedupes it with its ingress event so **1 ingress = 1 stream**.
- ESP32-CAM and other non-WebRTC devices ingest by relaying MJPEG/RTSP → RTMP
  (see the integrations docs).
</content>
