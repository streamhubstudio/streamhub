# Recording → S3 → VOD

## What it does

Records a LiveKit room (or participant) via **egress** to a local MP4, then a
job uploads it to the app's **S3**, generates a snapshot, writes the VOD row and
deletes the local file. Supports recording a **live** stream in place, **split**
into N-minute parts, and periodic **snapshots**.

### Flow (critical path)
1. `recording/start` (or `.../record/start` for a live stream) → LiveKit egress
   (room-composite | participant) writes `apps/<app>/recordings/<slug>.mp4`.
   A VOD row is inserted with `status=recording`. Fires `recording_started`.
2. Webhook `egress_updated`/`egress_ended` → `status=uploading`, enqueue an
   upload job (BullMQ on the existing redis; falls back to in-process).
3. Job: `s3.upload(localFile)` → build `public_url` (presigned or public) →
   delete local (if `delete_local_after_upload`) → generate + upload snapshot →
   `status=ready`, save metatags (room/app/duration/resolution/codec). Fires
   `vod_ready` (and `recording_ready`).
4. On upload failure: `status=failed`, local kept, error logged, `recording_failed`.

### Split MP4
When `split_minutes > 0`, the recording is cut every N minutes: stop the current
egress part + start a new one in the same room. **Each part = its own MP4 = its
own VOD** under `streamhub/<app>/`, indexed. Fires `recording_part_ready` per
part. `0` = one continuous file (default). Allowed: 0,15,30,60,90,120.

### Snapshots
When `snapshot_seconds > 0`, a JPEG snapshot is captured every N seconds during
the recording (egress ImageOutput or a parallel ffmpeg) and uploaded to
`streamhub/<app>/snapshots/`. Fires `snapshot_taken`. Allowed: 0,1,30,60,120,360.
On-demand snapshots also exist via `POST /apps/:app/snapshots` (see below).

### Post-transcode: adaptive VOD + encodings (opt-in)
When the app enables the `transcoding:` block (`enabled: true` + `vod_adaptive`
and/or `encoding: h264+vp8`), a second BullMQ job (`streamhub-vod-transcode`)
runs ffmpeg over the source MP4 after the VOD is `ready`: HLS renditions + a
master playlist and/or a WebM/VP8 alternate, stored as **VOD variants** and
fired as `vod_variants_ready`. The local MP4 delete is deferred to that job.
Default is OFF (new apps record a single MP4, no transcoding). Full
architecture: [adaptive-vod.md](adaptive-vod.md).

Recording mode + layout come from the app config, not the request. Starting a
recording is subject to `max_recording_minutes_month`.

## Endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| POST | `/recording/start` | recording:start | Start recording a room |
| POST | `/recording/:id/stop` | recording:stop | Stop a recording (VOD id or egress id) |
| POST | `/streams/:id/record/start` | recording:start | Record an already-live stream (record-live) |
| POST | `/streams/:id/record/stop` | recording:stop | Stop recording a live stream |
| POST | `/snapshots` | stream:write | On-demand snapshot of a room/participant |

VOD read/delete endpoints are in [vod.md](vod.md).

### POST /apps/:app/recording/start — body

```json
{ "roomName": "live-room-1", "streamId": "cam-42" }
```

`roomName` required; `streamId` optional (in participant mode it is the
participant identity to egress). Returns a **RecordingHandle**:

```json
{ "data": { "vodId": 12, "egressId": "EG_xxx", "status": "recording" } }
```

### POST /apps/:app/streams/:id/record/start
Resolves the stream id → its LiveKit room, then starts a room-composite egress
over it (reusing the recording flow, honoring the app split/snapshot config).
Returns the same RecordingHandle shape.

### POST /apps/:app/snapshots — body

```json
{ "room": "live/lobby", "participantIdentity": "camera-1" }
```

Captures a single frame from the room via ffmpeg and (if S3 configured) uploads
it. `participantIdentity` optional (defaults to the room composite). Returns a
`SnapshotResultDto` (key/url/local path).

## Examples

```bash
# start recording a room
curl -s -X POST $BASE/apps/demo/recording/start -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"roomName":"demo-room1"}'

# record an already-live stream
curl -s -X POST $BASE/apps/demo/streams/demo-room1%2Falice/record/start \
  -H "Authorization: Bearer $TOKEN"

# stop by egress or vod id
curl -s -X POST $BASE/apps/demo/recording/EG_xxx/stop -H "Authorization: Bearer $TOKEN"

# enable 30-min splits + 60s snapshots via config
curl -s -X PATCH $BASE/apps/demo -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"splitMinutes":30,"snapshotSeconds":60}'

# on-demand snapshot
curl -s -X POST $BASE/apps/demo/snapshots -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"room":"demo-room1"}'
```

## Notes

- Egress = headless Chrome (room-composite); it is heavy — roughly one Chrome per
  recording/HLS. Output is verified H.264.
- Presigned VOD URLs default to a 7-day TTL. VOD prefix: `streamhub/<app>/...`.
- The upload queue name is `streamhub-recording-upload` (BullMQ v5; no `:` in name).
- Callbacks fired across the flow: `recording_started`, `recording_part_ready`,
  `recording_ready`, `recording_failed`, `snapshot_taken`, `vod_ready` (see callbacks.md).
</content>
