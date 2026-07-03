# Apps (multi-tenant)

## What it does

An **App** is a logical tenant: a namespace of rooms/streams with its own
config, its own S3 bucket/prefix, its own VODs and streams DB, its own tokens,
callbacks and sample pages. This is the AntMedia-style "application" concept.

Creating an app scaffolds everything it needs:
1. inserts a row in the global `streamhub.db.apps` (with `tenant_id` when the
   caller is a real user — the app is owned by the caller's team),
2. creates `apps/<name>/` with `config.yaml`, `vods.db` (migrated),
   `recordings/`, `snapshots/`, `samples/`,
3. generates the sample pages (publish/play/HLS/radio) wired to that app.

Deleting an app can optionally purge its VODs + local files. The default app,
like AntMedia, is `live`.

Rooms are namespaced under the app's `room_prefix`: a requested room `demo` for
an app whose prefix is `live` becomes `live-demo`. Webhooks map a LiveKit room
back to an app by longest-matching prefix.

## Endpoints

All under `/api/v1`. Auth: Bearer. Permission in parentheses.

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps` | app:read | List all apps visible to the caller |
| POST | `/apps` | app:create | Create an app (scaffolds dirs/config/db/samples) |
| GET | `/apps/:name` | app:read | Get one app |
| PATCH | `/apps/:name` | config:write | Edit config.yaml (flat patch), returns merged config |
| DELETE | `/apps/:name?deleteVods=<bool>` | app:delete | Delete the app, optionally purge VODs/local |

### POST /apps — body

```json
{ "name": "demo", "displayName": "Demo", "roomPrefix": "demo" }
```

- `name` (required): lowercase slug `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`.
- `displayName` (optional): defaults from name.
- `roomPrefix` (optional): defaults to `name`.

Creating an app is subject to the tenant `max_apps` quota (see quotas.md).

### Response — AppRecord

```json
{
  "id": 3,
  "name": "demo",
  "displayName": "Demo",
  "livekitRoomPrefix": "demo",
  "createdAt": "2026-06-30T12:00:00.000Z",
  "updatedAt": "2026-06-30T12:00:00.000Z",
  "settingsJson": null
}
```

### PATCH /apps/:name — body (flat, all optional)

```json
{
  "displayName": "Demo",
  "roomPrefix": "demo",
  "recordingEnabled": true,
  "splitMinutes": 30,
  "snapshotSeconds": 60,
  "callbackUrl": "https://example.com/hook",
  "callbackSecret": "shhh",
  "features": {
    "rtmpPassword": true,
    "viewerCounter": true,
    "chat": true,
    "reactions": true,
    "hiddenQc": true,
    "adaptivePlayer": true
  }
}
```

`splitMinutes` ∈ {0,15,30,60,90,120}; `snapshotSeconds` ∈ {0,1,30,60,120,360}.
Secret S3 credentials are **not** accepted here (they go through `PUT /apps/:name/s3`).
Returns the merged `AppConfig`.

## Config per app (config.yaml)

The full parsed shape (`AppConfig`) — on disk secrets live as `*_env` refs, the
resolved config carries dereferenced credentials:

```yaml
name: live
display_name: Live
room_prefix: live
recording:
  enabled: true
  mode: room-composite        # room-composite | participant
  layout: grid
  local_dir: recordings
  delete_local_after_upload: true
  split_minutes: 0            # 0|15|30|60|90|120
  snapshot_seconds: 0        # 0|1|30|60|120|360
s3:
  provider: wasabi           # aws | wasabi | minio
  bucket: ale-backup
  region: us-east-1
  endpoint: https://s3.us-east-1.wasabisys.com
  force_path_style: false
  prefix: streamhub/live
  public_url: ""             # optional CDN/public base (opt-in, see vod.md)
  access_key_env: APP_LIVE_S3_KEY    # ref only; value in data/secrets.json
  secret_key_env: APP_LIVE_S3_SECRET
webrtc:
  adaptive: true
  layers: [ {name: high, height: 720}, {name: med, height: 480}, {name: low, height: 240} ]
rtmp:
  enabled: true
  transcode: true
callbacks:
  url: ""
  secret: ""
features:
  rtmp_password: false
  viewer_counter: false
  chat: false
  reactions: false
  hidden_qc: false
  adaptive_player: false
```

The **raw** YAML can be read/edited via the config editor endpoints (see
config-editor.md). The **structured/transcoding** view is at `GET /apps/:app/config`
(see transcoding-gpu.md). S3 is managed via `GET/PUT /apps/:app/s3` (see vod.md).

## Examples

```bash
BASE=https://streamhub.example.com/api/v1
TOKEN=sk_xxx   # or a login JWT

# create
curl -s -X POST $BASE/apps -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","displayName":"Demo"}'

# list
curl -s $BASE/apps -H "Authorization: Bearer $TOKEN"

# patch (enable chat + 30-min splits)
curl -s -X PATCH $BASE/apps/demo -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"splitMinutes":30,"features":{"chat":true}}'

# delete + purge VODs
curl -s -X DELETE "$BASE/apps/demo?deleteVods=true" -H "Authorization: Bearer $TOKEN"
```

## Notes

- Every `/apps/:app/*` route is tenant-scoped: the RBAC guard verifies the app
  belongs to the caller's tenant and the role permits the action. Superadmin and
  global api_tokens bypass tenant scoping.
- Deletion never touches other apps' data; each app owns its own SQLite + S3 prefix.
- `settingsJson` is a free-form per-app settings blob on the registry row.
</content>
