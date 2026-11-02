# Config editor (raw YAML) + reload/restart

## What it does

Edit the app's `config.yaml` as **raw YAML** with safety rails: timestamped
backups, a **dry-run** validate-with-diff, revert-to-backup, and hot-reload
(re-read config + re-init the app's S3 client without restarting the process).
A heavy `POST /admin/restart` restarts the whole core via systemd.

## Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps/:app/config/raw` | config:read | Raw config.yaml text |
| PUT | `/apps/:app/config/raw` | config:write | Validate + backup + write + hot-reload |
| POST | `/apps/:app/config/raw/validate` | config:read | Dry-run: validate + diff, no write |
| GET | `/apps/:app/config/backups` | config:read | List timestamped backups (newest first) |
| GET | `/apps/:app/config/backups/:ts` | config:read | Read one backup's YAML |
| POST | `/apps/:app/config/backups/:ts/revert` | config:write | Restore a backup + hot-reload |
| POST | `/apps/:app/reload` | config:write | Manual hot-reload |
| POST | `/admin/restart` | global-scope token | Restart the streamhub-core process (systemd) |

### GET /apps/:app/config/raw

```json
{ "data": { "yaml": "name: demo\nroom_prefix: demo\n..." }, "error": null }
```

### PUT /apps/:app/config/raw — body / response

```json
// body
{ "yaml": "name: demo\nroom_prefix: demo\n..." }
// response 200
{ "data": { "reloaded": true, "warnings": [] }, "error": null }
```

Validates (js-yaml parse + minimum shape). A parse/shape error → **400 with the
detail, no write**. On success: backs up the current file to
`config.yaml.bak.<ts>`, writes the new YAML, re-reads it into the in-memory
registry and re-inits the S3 client.

### POST /apps/:app/config/raw/validate — dry-run

```json
{ "data": {
  "valid": true, "warnings": [], "error": null,
  "changed": true,
  "diff": "--- current\n+++ proposed\n@@ ... @@\n-split_minutes: 0\n+split_minutes: 30"
}, "error": null }
```

Validates the proposed YAML and returns the diff vs current **without writing**.

### Backups + revert

```json
// GET /config/backups
{ "data": [ { "ts": "20260630T120000Z", "sizeBytes": 812, "createdAt": "..." } ] }
// POST /config/backups/:ts/revert
{ "data": { "reloaded": true, "warnings": [] } }   // current is backed up first
```

### POST /admin/restart

```json
{ "data": { "scheduled": true, "unit": "streamhub-core" }, "error": null }
```

Requires a **global-scope** token (app tokens → 403). Dispatched asynchronously
after the HTTP reply flushes; `systemctl restart <unit>` (unit from `SYSTEMD_UNIT`,
default `streamhub-core`, with a `sudo -n` fallback).

## Examples

```bash
# read raw
curl -s $BASE/apps/demo/config/raw -H "Authorization: Bearer $TOKEN"

# dry-run a change
curl -s -X POST $BASE/apps/demo/config/raw/validate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"yaml":"name: demo\nroom_prefix: demo\n..."}'

# write + hot-reload
curl -s -X PUT $BASE/apps/demo/config/raw -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"yaml":"name: demo\nroom_prefix: demo\n..."}'

# revert to a backup
curl -s -X POST $BASE/apps/demo/config/backups/20260630T120000Z/revert -H "Authorization: Bearer $TOKEN"

# restart the whole core (global token)
curl -s -X POST $BASE/admin/restart -H "Authorization: Bearer $GLOBAL_TOKEN"
```

## Notes

- Hot-reload does not restart the process, so other apps' streams are not cut.
- The raw editor writes the on-disk YAML verbatim (with `*_env` secret refs); S3
  key/secret are still managed only via `PUT /apps/:app/s3`.
- Backup ids are the `<ts>` token in the filename `config.yaml.bak.<ts>`.
</content>
