# DB maintenance (per-app SQLite)

## What it does

Health, optimization and purge for the per-app SQLite DBs and the global
registry DB. Each app owns its own SQLite (`vods.db`/`app.db`); the global
`streamhub.db` holds the registry + tenancy + tokens + logs.

## Endpoints

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps/:app/db/health` | usage:read | App DB health (size, WAL, pages, fragmentation, per-table rows) |
| POST | `/apps/:app/db/optimize` | app:write | Optimize the app DB (before/after sizes) |
| POST | `/apps/:app/db/purge` | app:delete | Purge app data by scope (needs confirm:true) |
| GET | `/system/db/health` | usage:read (global scope) | Global registry DB health |

### GET /apps/:app/db/health → DbHealth

```json
{ "data": {
  "sizeBytes": 262144, "walBytes": 32768,
  "pageCount": 64, "freelistCount": 2, "fragmentationPct": 3.1,
  "tables": { "vods": 42, "streams": 7 }
} }
```

### POST /apps/:app/db/optimize
Runs `PRAGMA optimize` + `ANALYZE` + `REINDEX` + `VACUUM` +
`wal_checkpoint(TRUNCATE)`. Returns `DbOptimizeResult` with before/after sizes.

### POST /apps/:app/db/purge — body

```json
{ "scope": "vods", "confirm": true }
```

- `scope` ∈ `vods` | `logs` | `all`. `confirm` **must be literally true** (else 400).
- `vods` — deletes VODs with the **full S3 + local cascade** (reuses the VOD
  delete cascade). `logs` — deletes the app's `server_logs`. `all` — vods +
  streams + logs, but **keeps the app registration and its config**.

### Response — PurgeResult

```json
{ "data": {
  "scope": "all",
  "vodsDeleted": 42, "streamsDeleted": 7, "logsDeleted": 300,
  "s3Deleted": 84, "localDeleted": 3
} }
```

### GET /system/db/health
Health of the global `data/streamhub.db`. Requires a **global-scope** credential
(an app-scoped token is 403; no-op check in dev/skeleton).

## Examples

```bash
curl -s $BASE/apps/demo/db/health -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/apps/demo/db/optimize -H "Authorization: Bearer $TOKEN"

# purge all app data (keep app + config)
curl -s -X POST $BASE/apps/demo/db/purge -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"scope":"all","confirm":true}'

# global registry health (needs global token)
curl -s $BASE/system/db/health -H "Authorization: Bearer $GLOBAL_TOKEN"
```

## Notes

- The VOD purge pages from offset 0 repeatedly (deletes shrink the list) and is
  guarded against infinite loops.
- Purge never removes the app itself or its `config.yaml`; use `DELETE /apps/:name`
  for that.
</content>
