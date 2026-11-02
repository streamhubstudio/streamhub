# HLS live

## What it does

Serves a live stream as **HLS** (video.js-compatible, embeddable, ~6-15s
latency) in addition to the low-latency WebRTC path. A **RoomComposite
SegmentedFileOutput (HLS)** egress writes the playlist + segments to a local
directory that the core serves publicly.

- On-disk: `<DATA_DIR>/apps/<app>/hls/<room>/index.m3u8` (+ `.ts` segments).
- Public URL: `https://streamhub.digitalhub.com.ar/hls/<app>/<room>/index.m3u8`
  (apps with `features.public_playback: false` need `?st=<token>` — 403 otherwise; the
  `playlistUrl` the API returns already carries it — see [signed-hls.md](signed-hls.md))
  — CORS fully open; `.ts` segments are immutable + long-cached; the `.m3u8` is
  `no-cache` by default, or CDN-cacheable (short live TTL + stale-while-revalidate)
  when `STREAMHUB_HLS_CDN=on` — see [HLS-CDN.md](HLS-CDN.md) to front it with an
  edge/CDN. Served by the core's `/hls` static mount (`internal/platform/web/static.go`, not under `/api/v1`), terminal (a
  missing file 404s, does not fall through to the SPA).

Starting HLS fires the `hls_started` callback; stopping fires `hls_stopped`.
Start is idempotent (an already-running egress is reused).

## Endpoints (under `/apps/:app/streams/:id/hls`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/apps/:app/streams/:id/hls/start` | Bearer | Start the live HLS egress |
| POST | `/apps/:app/streams/:id/hls/stop` | Bearer | Stop the live HLS egress |
| GET | `/apps/:app/streams/:id/hls` | Bearer | Status + public playlist URL |

### Responses

```json
// POST .../hls/start
{ "data": { "egressId": "EG_xxx", "room": "demo-room1",
            "playlistUrl": "https://streamhub.digitalhub.com.ar/hls/demo/demo-room1/index.m3u8",
            "status": "starting" }, "error": null }

// GET .../hls
{ "data": { "available": true,
            "playlistUrl": ".../hls/demo/demo-room1/index.m3u8",
            "status": "active" }, "error": null }

// POST .../hls/stop
{ "data": { "egressId": "EG_xxx", "status": "stopping" }, "error": null }
```

The absolute playlist origin is `PUBLIC_BASE_URL` when set, otherwise derived
from the request (honoring `X-Forwarded-Proto`/`X-Forwarded-Host`).

## Examples

```bash
# start live HLS for a stream
curl -s -X POST $BASE/apps/demo/streams/demo-room1%2Falice/hls/start \
  -H "Authorization: Bearer $TOKEN"

# play it (no auth needed for the playlist itself)
open https://streamhub.digitalhub.com.ar/hls/demo/demo-room1/index.m3u8
```

```html
<!-- embed with video.js -->
<video-js id=p class="video-js" controls></video-js>
<script>
  const player = videojs('p');
  player.src({ src: 'https://streamhub.digitalhub.com.ar/hls/demo/demo-room1/index.m3u8',
               type: 'application/x-mpegURL' });
</script>
```

## Notes

- The playlist path segment order differs from disk: the URL is
  `/hls/<app>/<room>/...` but on disk the `hls` segment sits in the middle
  (`apps/<app>/hls/<room>/...`); the static mount injects it.
- Optional auto-HLS per app (config `hls.enabled`) can start the egress when a
  stream begins.
- Each HLS egress is a headless Chrome — same weight as a recording egress.
- **DVR / hlsTime / hlsListSize (3.4.0)**: `features.hls.segment_seconds` sets the
  egress segment length, `features.hls.list_size` / `features.dvr` make the core serve
  a sliding-window `dvr.m3u8` (rewindable, with seek / "Ir al vivo" / `?t=` in the
  players), and `features.clips` cuts clips out of these segments. See
  [dvr-clips.md](dvr-clips.md).
</content>
