# VOD (list / get / delete) + S3 config

## What it does

VODs are the recorded MP4s stored in the app's S3 bucket, tracked in the per-app
`vods.db`. This feature covers listing, fetching (with playback URLs), and
deleting with a full cascade, plus setting the app's S3 configuration and the
optional public URL.

## VOD endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/vods?limit&offset` | vod:read | List VODs (newest first) |
| GET | `/vods/:id` | vod:read | VOD detail + playback URLs |
| DELETE | `/vods/:id` | vod:delete | Delete with cascade (DB + S3 + local) |

`limit` default 200 (1..1000), `offset` default 0.

### GET /apps/:app/vods/:id — response

```json
{ "data": {
  "id": 12, "appId": 3, "streamId": "demo/alice", "room": "demo-room1",
  "name": "demo-room1-2026...mp4", "fileKey": "streamhub/demo/....mp4",
  "s3Url": "...", "publicUrl": null, "sizeBytes": 10485760,
  "durationS": 123, "width": 1280, "height": 720, "format": "mp4",
  "status": "ready", "localPath": null,
  "startedAt": "...", "endedAt": "...", "metatagsJson": "{...}",
  "snapshotKey": "streamhub/demo/snapshots/....jpg",
  "url": "<public-or-presigned>",
  "presignedUrl": "https://...X-Amz-Signature...",
  "publicUrl": "https://cdn.example.com/streamhub/demo/....mp4"
} }
```

- `url` = `publicUrl` when the app's S3 `public_url` is set, otherwise `presignedUrl`.
- `status` ∈ recording | uploading | ready | failed.
- When the app enables the `transcoding:` block, the detail also carries
  `adaptive` (HLS master playlist entry point) and `variants[]`
  (master/renditions/alternates such as WebM/VP8). See
  [adaptive-vod.md](adaptive-vod.md) and the full response shape in
  [api-app.md](../api-app.md#get-appsappvodsid). Empty/`null` for plain VODs.

### DELETE /apps/:app/vods/:id — cascade

Removes: the `vods.db` row + the S3 object + the S3 snapshot + the local file +
local snapshot. Idempotent for already-absent objects.

```json
{ "data": { "id": 12, "deleted": true, "s3Deleted": 2, "localDeleted": false } }
```

`s3Deleted` counts S3 objects removed (recording + snapshot **+ every variant
object**: master/rendition playlists, HLS segments, WebM alternates);
`localDeleted` is true when a local file was removed. This same cascade is
reused by the DB purge (see db-maintenance.md).

## S3 config endpoints (under `/apps/:app`)

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/s3` | s3:read | Get S3 config (credentials masked) |
| PUT | `/s3` | s3:write | Set S3 block + key/secret, re-init the client |

### PUT /apps/:app/s3 — body

```json
{
  "provider": "wasabi",
  "bucket": "my-bucket",
  "region": "us-east-1",
  "endpoint": "https://s3.us-east-1.wasabisys.com",
  "forcePathStyle": false,
  "prefix": "streamhub/demo",
  "public_url": "https://cdn.example.com",
  "key": "AKIA...",
  "secret": "....",
  "confirmPublic": true
}
```

- Non-secret fields are written to `config.yaml`; `key`/`secret` go to
  `data/secrets.json` (chmod 600), **never** the yaml. The S3 client is
  re-initialized after saving (no process restart).
- **Fold-3 gate**: enabling a non-empty `public_url` requires `confirmPublic:true`
  — it makes recordings publicly accessible (not presigned). Clearing it needs
  no confirm. Default remains presigned-with-expiry; a CDN signed URL over an
  open bucket is recommended.

`GET /s3` returns the config with `key`/`secret` masked.

## Examples

```bash
# list VODs
curl -s "$BASE/apps/demo/vods?limit=50" -H "Authorization: Bearer $TOKEN"

# get one (with presigned URL)
curl -s $BASE/apps/demo/vods/12 -H "Authorization: Bearer $TOKEN"

# delete (cascade)
curl -s -X DELETE $BASE/apps/demo/vods/12 -H "Authorization: Bearer $TOKEN"

# set S3 (Wasabi) with a public CDN base
curl -s -X PUT $BASE/apps/demo/s3 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"wasabi","bucket":"ale-backup","region":"us-east-1",
       "endpoint":"https://s3.us-east-1.wasabisys.com","prefix":"streamhub/demo",
       "public_url":"https://cdn.example.com","confirmPublic":true,
       "key":"AKIA...","secret":"..."}'
```

## Notes

- Providers: `aws` | `wasabi` | `minio`. MinIO uses `forcePathStyle:true`.
- VOD metatags (`metatagsJson`) include room, app, duration, resolution, codec.
- Snapshots for a VOD are stored under `<prefix>/snapshots/` and deleted with the VOD.
</content>
