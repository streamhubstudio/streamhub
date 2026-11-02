# Live Control — pause / resume / finish an already-live stream

Let an operator take over an **already-live** stream from the dashboard or the
REST API:

- **Pause** — viewers stop seeing the live feed and instead see a configured
  **cover** (an image, a looping video, or a text card); audio is muted until you
  resume.
- **Resume** — back to the live feed; audio unmuted.
- **Finish** — end the live with a final card/asset.

Cover assets (images / short looping videos) are uploaded to the **app's S3**
(the same storage recordings use — Live Control requires it, and reuses the same
`storage_not_configured` guard). Defaults are configured **per app**, with an
optional **per-stream override** on each pause/finish call. All state lives
server-side and every transition fires a signed callback event so
[Streamflow](./streamflow.md) and webhooks can react.

> This feature is owner item 31. Design notes (the extend-vs-new decision and the
> viewer-swap mechanism per plane) are in `planning/LIVE-CONTROL-DESIGN.md`.

## Two plugins, one engine

The framework binds **one UI slot per plugin**, so a single plugin cannot be both
a full-page operator console (`app-tab`) and a viewer cover (`player-overlay`).
Live Control therefore ships as **two built-ins over one in-core module**
(`modules/live-control`, per-app `live-control.db`):

| Plugin | Kind / slot | Role |
|---|---|---|
| **`live-control`** | `app` / `app-tab` | The operator **console**: stream list, pause/resume/finish, and the S3 cover-asset manager. |
| **`live-control-overlay`** | `plugin` / `player-overlay` | The viewer **cover**: renders the configured cover over the video (and mutes it) while a stream is paused/finished. |

**Install + enable BOTH** for the full experience: the console alone changes the
server-side state (and mutes audio in LiveKit), but viewers only see the cover
when the overlay plugin is enabled on the app. The console shows a reminder.

## How viewers actually see the swap (and the limits)

There is **no stream-level replacement** in v1 — Live Control uses a **client-side
overlay** plus a **server-side audio mute**:

- **WebRTC / LiveKit viewers (our players):** the overlay draws the cover on top
  of the video for every viewer, and the core also mutes the publisher's audio
  track(s) in LiveKit (best-effort) so audio stops for everyone. The live pixels
  are still being sent underneath the cover — this is an overlay, not a track
  swap.
- **HLS players (our `/play` + `/embed`):** the same overlay runs, so they get
  the cover too. **A consumer hitting the raw `.m3u8` URL directly bypasses the
  overlay in v1** (honest limitation). A true segment-level slate swap (an ffmpeg
  slate loop spliced into the playlist) is deferred — it needs a per-stream slate
  encoder and playlist rewriting, a real transcode/ops cost not justified for v1.
- **State + instant updates:** the state machine lives in `live-control.db`. On
  every transition the core pushes a message on the LiveKit data topic
  `live-control` so mounted overlays react instantly; the overlay also polls the
  public state as a fallback (the only transport on HLS/MJPEG players).

## State machine

Per stream: `live` → `paused` → `live` (resume) and `→ finished`. **No row ⇒
`live`** (the default). A stream row is created the first time it is acted on.
`finished` is not terminal — an operator can still resume/re-pause it. `finish`
does **not** tear down the underlying stream/room; it only changes what viewers
see.

Each transition fires a callback funnel event: `livecontrol.paused`,
`livecontrol.resumed`, `livecontrol.finished` (payload `{ stream, room, state,
mode, assetId }`) — delivered to the app webhook + MQTT tap + Streamflow.

## Cover resolution (per-stream override → app default)

When paused/finished the cover is resolved as: `mode` = per-stream override else
the app `defaultMode`; for an image/video the `assetId` = override else the app's
default **pause** or **finish** asset for that phase; a text card uses
`cardTitle`/`cardText`/`cardColor`. An image/video mode with **no** resolvable
asset **degrades to a text card** so viewers never see a broken cover.

## Configuration

**Per-app static defaults** live in the `live-control` plugin config (Marketplace
→ Configure): `defaultMode` (image | video | text), `defaultCardTitle`,
`defaultCardText`, `defaultCardColor`, `muteAudioServerSide` (also mute in
LiveKit, default on), `pollSeconds`. **Dynamic defaults** (which uploaded asset is
the default pause/finish cover) are set from the console's asset manager and
stored in `live-control.db`.

The **`live-control-overlay`** plugin config only tunes rendering: `fit`
(cover | contain) and `showFinishedBadge`.

## API (all under `/api/v1`)

Everything the console does is available over documented endpoints (see
[api/README.md](../api/README.md#live-control)). Reads take `config:read`, writes
`config:write`; `/public` is anonymous.

```bash
# Pause stream s1 with a text card override
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"text","cardTitle":"Back in 5","cardText":"We will be right back"}' \
  https://host/api/v1/apps/live/plugins/live-control/streams/s1/pause

# Upload a cover asset (409 storage_not_configured if the app has no S3 bucket)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -F file=@intro.png -F label='Intro slate' \
  https://host/api/v1/apps/live/plugins/live-control/assets

# Resume
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://host/api/v1/apps/live/plugins/live-control/streams/s1/resume

# Public state read (what the anonymous overlay polls)
curl 'https://host/api/v1/apps/live/plugins/live-control/public?room=live-room1'
```

## Storage

- `apps/<app>/live-control/live-control.db` — `stream_state` (state machine +
  per-stream override), `assets` (uploaded covers), `app_settings` (default
  asset ids).
- Cover assets in the app S3 under `live-control/assets/<uuid>-<name>`.
