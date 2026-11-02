# Stream Health monitor (`stream-health` Studio App)

Per-stream ORIGIN quality validation: an installable Studio App whose worker
samples every live stream's HLS output and turns anomalies into `health.*`
alerts (signed webhook + MQTT + Streamflow triggers) plus an at-a-glance
monitor tab in the dashboard — "el monitor para ver la salud de todos los
streams desde una app interna".

## What it checks (detection catalogue)

| Detector | Signal | Default threshold | Event |
|---|---|---|---|
| Stall | the media playlist stopped advancing (no new segment) | `stall_sec` = 20 s | `health.stalled` (always **critical**) |
| Dropped segments | `#EXT-X-MEDIA-SEQUENCE` jumped past the previously seen window — segments were produced and rotated out unseen | any gap | `health.discontinuity` |
| TS continuity errors | per-PID continuity-counter skips in the newest `.ts` segment (real packet loss, invisible at playlist level; honors the discontinuity_indicator + legal duplicates) | any skip | `health.discontinuity` |
| Discontinuity tags | `#EXT-X-DISCONTINUITY` markers on new segments | any tag | `health.discontinuity` |
| Audio silence | mean segment volume (audio-only `volumedetect` decode) at or below `silence_db` continuously for `silence_duration_sec` | −50 dBFS / 15 s | `health.audio_lost` (`reason: 'silence'`) |
| Audio track missing | ffprobe finds no audio stream in a new segment | immediate | `health.audio_lost` (`reason: 'no_audio_track'`) |
| *(source has no audio)* | the core says the room's publishers carry no audio track (see [Sources without audio](#sources-without-audio-audiosource-none)) — both audio detectors are off, the stream stays `healthy` | — | fact `audioSource: "none"`; an open `audio_lost` closes with `health.audio_recovered` (`reason: 'no_audio_source'`) |
| A/V desync | \|video.start_time − audio.start_time\| of the newest segment (PTS drift) | `desync_ms` = 200 ms | `health.av_desync` |
| Bitrate drop | measured delivery bitrate (new-segment bytes / seconds) below `bitrate_drop_pct` % of the rolling healthy baseline (EMA; bad readings never drag the baseline down) | 50 % (0 = off) | rollup only (`bitrate_low` reason) |
| Stream facts | codecs, resolution, fps, bitrates (ffprobe headers) | — | surfaced on the monitor tab + overview feed |

**Rollup:** `critical` when stalled or ≥ 2 distinct issues; `degraded` on
exactly 1; back to `healthy` after `recover_samples` consecutive clean samples
(hysteresis — default 2 — so a flapping input can't spam alerts).
`health.degraded` fires on every worsening transition (payload
`{ status, reasons[] }`), `health.recovered` on return to healthy (payload
`{ clearedReasons[] }`). Level detectors fire once on their rising edge;
`health.discontinuity` is a pulse rate-limited to one per 60 s per room.

## Engine — the core binary's own worker, and what it costs

The worker is the **core binary itself**: the framework spawns
`streamhub-core health-worker` (`streamhub-core-go/internal/healthworker`),
shelling out to the **ffprobe/ffmpeg binaries the core already ships** (they
are the core's own snapshot/VOD tooling) — no Node, no pip/venv, nothing extra
to install. It is a straight port of the 2.x Node worker (`health-worker/`,
removed in 3.x): same `HEALTH_*` env contract, same events/payloads and stdout
lines, locked by Node-generated vectors and a side-by-side run over synthetic
HLS (`streamhub-core-go/test/healthworker-parity`). `HEALTH_FFPROBE` /
`HEALTH_FFMPEG` override the binaries. The 3.4 additions — remote probes
through the edges and the "source has no audio" fact — have no Node
counterpart and are off by default (no `edge_hls_bases`, no `stream_sources`
row), so the Node-locked behaviour is unchanged unless they are used.

**Sampling-based, never a full decode.** Per stream per sample (default every
`sample_interval_sec` = 10 s), and **only when a new segment appeared**:

- 1 × playlist read + diff (µs),
- 1 × `ffprobe -show_format -show_streams` on the newest segment — header
  parse, ~30–80 ms wall, negligible CPU,
- 1 × bounded read of the newest `.ts` segment head (≤ 4 MB) for the
  continuity-counter scan — pure Go, ~ms,
- 1 × `ffmpeg -vn -af volumedetect -f null -` over that ONE segment — decodes
  ~2–6 s of AAC only (video is never decoded), ~20–50 ms CPU.

That is **well under 1 % of one core per stream** at the default cadence; a
stalled stream costs just the playlist read. Raising `sample_interval_sec`
scales the cost down linearly. The worker holds no LiveKit connection and
never re-encodes anything.

## Event plane

The worker POSTs the framework event channel
(`POST /apps/:app/plugins/stream-health/events`, ingest-token auth); only the
manifest-declared `health.*` names are accepted (spoof guard), then each event
flows through the app's **signed callbacks funnel** — webhook (HMAC
`X-StreamHub-Signature`) + the **MQTT tap** (classified into the
`<prefix>/alert/<event>` topic, same family as `stream.latency_*`) + the
in-process dispatch tap that powers **Streamflow** (the events appear in the
`trigger.event` catalogue under the `streamHealth` family, wildcard
`health.*`). A `stream-health` module sink also records every `health.*`
dispatch into the per-app db for the dashboard history.

Events: `health.degraded`, `health.recovered`, `health.audio_lost`,
`health.audio_recovered`, `health.av_desync`, `health.stalled`,
`health.discontinuity`.

## Live feed + REST surface

Every cycle the worker pushes an `overview` snapshot (all rooms: status,
reasons, facts, metrics) to the plugin live-data channel; the tab reads it via
the framework route `GET /apps/:app/plugins/stream-health/live/state?room=overview`
(authenticated). The module's own routes (Bearer + config permission, standard
envelope):

| Method | Path | Permission | What |
|--------|------|-----------|------|
| GET | `/apps/{app}/plugins/stream-health/overview` | config:read | events today + rooms with recent history/overrides |
| GET | `/apps/{app}/plugins/stream-health/events?limit&room` | config:read | recent `health.*` transitions (db, default 50, max 1000) |
| GET | `/apps/{app}/plugins/stream-health/streams/{room}/settings` | config:read | per-room override + resolved effective thresholds |
| PUT | `/apps/{app}/plugins/stream-health/streams/{room}/settings` | config:write | set a PARTIAL override — body `{"config":{…thresholds}}` (`400` unknown key / out of range; `{}` clears) |

**The PUT body is a wrapper:** the thresholds go INSIDE `config`:

```bash
curl -X PUT -H "Authorization: Bearer $SK" -H 'content-type: application/json' \
  "$BASE/api/v1/apps/live/plugins/stream-health/streams/cam-1/settings" \
  -d '{"config":{"silence_db":-60,"stall_sec":30}}'
```

An empty body, `null`, `{}`, `{"config":{}}` and `{"config":null}` all CLEAR the
override (back to the app defaults). Since 3.4 any other top-level key — e.g. the
unwrapped `{"silence_db":-100}` — or a non-object body (array, string, number) is a
`400` (`unknown top-level key 'silence_db': thresholds go inside {"config":{…}}`) and
the stored override is left alone; before 3.4 (and in 2.x) such a body answered `200`
and silently stored an EMPTY override, wiping the previous one
(`planning/GO-DIVERGENCES.md`). The MCP tool `set_stream_health_room_settings` builds
the wrapper itself.

## Thresholds (three layers)

`defaults ⊕ app install config ⊕ per-room override` — the same keys at every
layer: `sample_interval_sec` (10), `silence_db` (−50), `silence_duration_sec`
(15), `desync_ms` (200), `stall_sec` (20), `bitrate_drop_pct` (50),
`recover_samples` (2). App-level values are the plugin install config (PATCH
`/apps/:app/plugins/stream-health`, restarts the worker); per-room overrides
are stored in `stream-health.db` and **re-read by the worker every cycle,
read-only** — a PUT applies on the next probe, no restart. A remote probe
(below) uses its origin room's thresholds.

App-level only (not a threshold, not per room): `edge_hls_bases` (default `""`)
— the edge/CDN bases to probe through, see the next section.

## Probing through the CDN/edges (`edge_hls_bases`, 3.4)

The origin's disk is what the egress WROTE, not what viewers RECEIVE. Set the
app-level `edge_hls_bases` (install config) to also probe every live room
**through each edge/CDN**:

```bash
curl -X PATCH -H "Authorization: Bearer $SK" -H 'content-type: application/json' \
  "$BASE/api/v1/apps/live/plugins/stream-health" \
  -d '{"config":{"edge_hls_bases":"edge1=https://cdn1.example.com, https://cdn2.example.com"}}'
```

- Entries are separated by commas/whitespace; `name=url` names an edge
  (otherwise the name is the URL's `host[:port]`); only absolute `http(s)`
  URLs are kept, a repeated name is dropped, a path prefix is kept
  (`https://cdn/base` → `https://cdn/base/hls/…`).
- For every room found on the origin's disk the worker GETs
  `<base>/hls/<app>/<room>/index.m3u8` (≤ 1 MB) each sample and — only when a
  new segment appeared — the **newest** new segment (bounded at 4 MB, the TS
  read cap) into a temp file, then runs the same detectors: stall, dropped
  segments, CC scan, discontinuity tags, ffprobe facts, volumedetect, desync,
  bitrate (the newest segment's size over its EXTINF). Segment URIs are
  followed only on the edge's own scheme+host.
- Each (room, edge) is its own monitored stream with its own state: the
  overview snapshot is keyed `<room>@<edge>` (an on-disk room can never take
  that key: HLS dirs are slugged to `[A-Za-z0-9_-]`) and adds `origin`
  (the room), `via` (the edge name), `url` (the playlist probed) and `error`
  (last fetch failure, e.g. `HTTP 502`). Origin snapshots are unchanged.
- Events of a remote probe carry the **origin** room as `room` (webhook
  consumers map rooms to streams) plus `data.via: "<edge>"`; the worker's
  stdout line uses the `<room>@<edge>` key.
- A failed playlist GET is "no advance" — after `stall_sec` the remote probe
  goes `stalled`/critical while the origin stays healthy (an edge with nginx
  down). It is never "stream ended": the origin's disk owns the room's life,
  and a room leaving the disk drops its remote probes. The first good fetch
  after an outage reports the segments that rotated out unseen as dropped.
- Cost: one playlist GET per room per edge per sample, plus one segment GET +
  the usual ffprobe/volumedetect when the edge advanced — i.e. the origin cost
  again per edge, plus the transfer of one segment.
- The dashboard groups remote probes under their room's card (one row per
  edge with its status and last-segment age or fetch error); the drill-down of
  a remote probe shows the edge and URL, and edits / lists the ORIGIN room's
  thresholds and events (events show `via <edge>`).

Requests go out with `user-agent: streamhub-health-worker` and no credentials:
for an app with `public_playback: false` (signed HLS, G2) the edge answers
401/403 and the remote probe reports it as a fetch error — remote probing is
for public-playback apps. The edge list is static per worker run (a PATCH of
the config restarts the worker); building it from the registered edges is a
follow-up.

## Sources without audio (`audioSource: none`)

An RTMP/WebRTC source with **no audio track** still gets an AAC track in the
HLS: the LiveKit RoomComposite egress muxes digital silence (−91 dB). Sampled
blindly that is `audio_silent` forever — a permanent `degraded` that masks the
real status. The worker cannot tell that filler from a source whose audio went
silent (both are digital silence), so the **core** tells it:

- After every LiveKit `track_published`, `track_unpublished` and
  `participant_left` webhook of an app with stream-health installed, the core
  lists the room's participants (LiveKit RoomService, async, never delaying the
  webhook answer) and records whether any non-hidden publisher has an audio /
  video track in `stream-health.db` → `stream_sources` (keyed by the HLS dir
  name; nothing published deletes the row).
- The worker reads that table read-only every cycle (like the overrides). For a
  room whose publishers carry **no audio**, both audio detectors are off (no
  volumedetect decode either), the stream stays `healthy`, and the snapshot
  facts say `audioSource: "none"` (the dashboard shows "no audio source"
  instead of the filler codec). When the source does publish audio the fact is
  `"track"` and silence detection applies as before; no row = unknown =
  unchanged 2.x behaviour.

Trade-off (why not a per-room `silence_detect` switch): a switch would be
operator toil per room and stay wrong when the same room later gets a source
with audio; a worker-side heuristic ("silent since discovery") would also hide
a real fault — an encoder whose audio feed is unplugged from the start. Asking
LiveKit is exact for LiveKit-ingested rooms and needs no configuration. Its
limits: a **muted** mic still counts as an audio track (its silence is
reported — LiveKit sends no mute webhook); a missed webhook leaves the last
answer until the next publish change; and HLS that does not come from LiveKit
(RTMP/SRT **passthrough** remux) has no participants, so a video-only
passthrough source still reports `audio_missing`.

## Storage

Per-app `apps/<app>/stream-health/stream-health.db` (WAL): `health_events`
(bounded history, 30-day retention pruned on write) + `stream_settings`
(per-room overrides) + `stream_sources` (3.4: per-room publisher media kinds,
`has_audio`/`has_video`, written by the core from the LiveKit webhooks).
Declared as `storage.db` on the manifest.

## Dashboard

The Studio App tab (`apps/:app/studio/stream-health`) has two deep-linkable
sections: **Monitor** (worst-first grid of status chips —
healthy/degraded/critical, or *stale* grey when the worker feed is older than
45 s — with reasons and key facts/metrics per stream; click → drill-down with
the full numbers, that room's event history and the threshold editor where
blank fields inherit) and **Events** (the recent transition history). i18n:
`streamHealth` namespace, es + en.

## Limitations (honest)

- **HLS-based**: only streams with an on-disk HLS output are probed (LiveKit
  HLS egress or RTMP/SRT passthrough). A WebRTC-only stream with no HLS has no
  origin artifact to sample — WebRTC-side stats (RTP jitter/loss from the SFU)
  are a possible future detector, not in this cut.
- Segment-level A/V desync measures muxed PTS drift; it cannot see capture-side
  lip-sync problems that were already baked in upstream with consistent
  timestamps.
- TS continuity analysis applies to `.ts` segments (fMP4/`.m4s` segments skip
  the CC scan; the other detectors still apply).
- The worker runs co-located on the origin (`placement: local`); it is not
  edge-distributed — there is exactly one worker per app. It can probe
  through the edges over HTTP (`edge_hls_bases`, above), but only for rooms
  present on the origin's disk and only for public-playback apps.
