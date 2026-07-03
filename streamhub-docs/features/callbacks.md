# Callbacks (HMAC-signed outbound webhooks)

## What it does

Per app, StreamHub POSTs a **signed JSON payload** to the app's configured
`callbacks.url` for **every** event of the room's lifecycle (AntMedia-style).
Configured via `PATCH /apps/:app` (`callbackUrl`, `callbackSecret`) or the raw
config editor.

- Every forwarded LiveKit webhook + every StreamHub business event fires a callback.
- Best-effort delivery with bounded retries; **never** crashes the caller.
- Callbacks are **not** fired when no app can be resolved for the event.

## Envelope

```json
{
  "id": "<uuid delivery id>",
  "event": "<event type>",
  "app": "<app>",
  "room": "<room or null>",
  "ts": "2026-06-30T12:00:00.000Z",
  "timestamp": "2026-06-30T12:00:00.000Z",
  "data": { /* event-specific, flat & JSON-safe */ }
}
```

`timestamp` is an alias of `ts` (back-compat). `data` may include
`participant`, `track`, `ingress`, `egress`, `eventId`, `createdAt`, plus
business fields (`streamId`, `type`, `vodId`, `reaction`, `message`, …).

## Headers

| Header | Value |
|--------|-------|
| `X-StreamHub-Event` | the event type |
| `X-StreamHub-Signature` | `sha256=<hex HMAC-SHA256(secret, rawBody)>` (only when a secret is set) |
| `X-StreamHub-Delivery` | the delivery id (uuid) |
| `X-StreamHub-Timestamp` | ISO-8601 emission time |
| `Content-Type` | `application/json` |
| `User-Agent` | `streamhub-core/callbacks` |

**Verify** on your side: `HMAC_SHA256(secret, rawRequestBody)` hex == the
`sha256=` value.

## Event taxonomy

Classifiable by `event`:

**Room / participants** (forwarded LiveKit webhooks):
`room_started`, `room_finished`, `participant_joined`, `participant_left`,
`track_published`, `track_unpublished`.

**Ingress / Egress** (forwarded LiveKit webhooks):
`ingress_started`, `ingress_ended`, `egress_started`, `egress_updated`, `egress_ended`.

**StreamHub business events** (fired by the Recording/Streams/HLS services):
`stream_started`, `stream_ended`, `recording_started`, `recording_part_ready`,
`recording_ready`, `recording_failed`, `snapshot_taken`, `vod_ready`,
`vod_variants_ready` (post-transcode adaptive HLS / WebM variants of a VOD —
see [adaptive-vod.md](adaptive-vod.md)), `hls_started`, `hls_stopped`,
`restream_started`, `restream_stopped`, `restream_failed` (one per forwarding
destination — see [restream.md](restream.md); payload URLs are always masked).

**Chat / reactions** (fired when a data message is sent server-side):
`chat_message`, `reaction`.

**Plugin workers** (fired by the plugins-framework worker hook):
`plugin_worker_started`, `plugin_worker_stopped`, `plugin_worker_error`
(payload: `plugin`, plus `pid` / `exitCode`+`signal` / `error`).

**Stream health alerts** (fired by the latency monitor — see
[mqtt.md](mqtt.md#high-latency-alert)): `stream.latency_high`,
`stream.latency_recovered` (payload: `room`, `rttMs`, `thresholdMs`, `metric`).

> Every event above is ALSO published to the app's MQTT broker when the
> per-app `mqtt:` block is enabled — same taxonomy, same `data` payload,
> envelope `{event, app, timestamp, data}`. See [mqtt.md](mqtt.md).

## Delivery semantics

- Timeout 10s per attempt, up to **3 attempts**, exponential backoff (500ms base).
- Retryable: HTTP 5xx, 408, 429, and network errors. Non-retryable: other 4xx.
- Result is metered to Prometheus (`streamhub_callbacks_total{event,result}` —
  `delivered` | `failed` | `dropped`).

## Configure + verify

```bash
# set callback URL + secret
curl -s -X PATCH $BASE/apps/demo -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"callbackUrl":"https://example.com/hook","callbackSecret":"shhh"}'
```

```js
// Node receiver — verify signature
import crypto from 'node:crypto';
app.post('/hook', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.get('X-StreamHub-Signature') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET)
                                     .update(req.body).digest('hex');
  if (sig !== expected) return res.status(401).end();
  const evt = JSON.parse(req.body.toString());
  console.log(evt.event, evt.app, evt.room, evt.data);
  res.sendStatus(200);
});
```

## Notes

- Callbacks are **outbound only** — there is no inbound callback endpoint.
- The LiveKit webhook sink (`POST /api/v1/webhooks/livekit`) is internal
  (signature-verified against the LiveKit key, not a Bearer token) and is what
  drives most forwarded events.
</content>
