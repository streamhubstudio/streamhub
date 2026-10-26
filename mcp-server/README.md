# StreamHub MCP Server

An **MCP (Model Context Protocol) server** that exposes the StreamHub REST API
(`/api/v1`) as tools, resources and prompts, so an AI client — **Claude
Desktop**, **Claude Code**, or any MCP-capable agent — can operate a StreamHub
instance conversationally: create apps, mint RTMP/SRT/MPEG-TS ingest
credentials, apply config presets, start recordings, browse VODs and
transcripts, moderate live rooms, tag streams, pause/resume/finish a live
broadcast, monitor stream health, build Streamflow automation workflows, and
install plugins.

- Transport: **stdio** (the standard for local MCP servers).
- Auth: a StreamHub **`sk_` API token** passed via environment.
- Every tool maps to exactly **one** documented REST endpoint
  ([`streamhub-docs/api/openapi.json`](../streamhub-docs/api/openapi.json) is
  the authoritative surface) and unwraps the `{ data, error }` envelope for
  the model.
- **Destructive operations are off by default** (see
  [Safety](#safety-destructive-operations--token-scope)).

---

## Install & build

The package lives in the StreamHub monorepo under `mcp-server/`. It is
standalone (own `package.json`, no dependency on the rest of the repo):

```bash
cd mcp-server
npm install
npm run build        # tsc → dist/
```

Requires **Node >= 22.6** (Node 24 recommended). The server binary is
`dist/index.js` (also exposed as the `streamhub-mcp` bin).

> Not yet published to npm — run it from a checkout. Once published,
> `npx @streamhub/mcp-server` will work as the `command` directly.

## Configure

Everything is environment-driven (MCP clients pass env via their config):

| Variable | Required | Meaning |
|---|---|---|
| `STREAMHUB_API_URL` | yes | Base URL of the instance — the origin (`https://media.example.com`) or the full API base (`.../api/v1`); both accepted. For a local core: `http://127.0.0.1:3020`. |
| `STREAMHUB_API_TOKEN` | yes | An `sk_` API token. **Use an app-scoped token** unless you really need global surfaces (see [Safety](#safety-destructive-operations--token-scope)). |
| `STREAMHUB_ALLOW_DESTRUCTIVE` | no | `true`/`1`/`yes`/`on` registers the destructive tools (delete app, delete VOD, db purge). Default: off — they are not even visible to the model. |

CLI flag: `--allow-destructive` is equivalent to the env var.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "streamhub": {
      "command": "node",
      "args": ["/absolute/path/to/vision-media-server/mcp-server/dist/index.js"],
      "env": {
        "STREAMHUB_API_URL": "https://media.example.com",
        "STREAMHUB_API_TOKEN": "sk_..."
      }
    }
  }
}
```

To enable destructive tools, add `"--allow-destructive"` to `args` **only if
you accept the risk** — the model still has to pass `confirm: true` per call.

### Claude Code

```bash
claude mcp add streamhub \
  -e STREAMHUB_API_URL=https://media.example.com \
  -e STREAMHUB_API_TOKEN=sk_... \
  -- node /absolute/path/to/vision-media-server/mcp-server/dist/index.js
```

Any other MCP client works the same way: `command: node`,
`args: [".../dist/index.js"]`, plus the two env vars.

---

## Tool catalogue

89 tools in 15 groups. **Destructive** tools (marked ⛔) only exist when
destructive mode is enabled, and additionally require `confirm: true`. Milder
mutating tools (marked ⚠) stay always-available but carry an MCP
`destructiveHint` annotation — see [Safety](#safety-destructive-operations--token-scope).

### System & observability

| Tool | Endpoint |
|---|---|
| `get_health` | `GET /api/v1/health` |
| `get_system_stats` | `GET /api/v1/stats` |
| `query_logs` | `GET /api/v1/logs` |

### Apps

| Tool | Endpoint |
|---|---|
| `list_apps` | `GET /api/v1/apps` |
| `get_app` | `GET /api/v1/apps/{name}` |
| `create_app` | `POST /api/v1/apps` |
| `update_app` | `PATCH /api/v1/apps/{name}` — incl. recording filename/snapshot templates, VOD `retentionDays`, `variables` map |
| `get_app_stats` | `GET /api/v1/apps/{app}/stats` |
| `get_app_sizes` | `GET /api/v1/apps/{name}/sizes` |
| `delete_app` ⛔ | `DELETE /api/v1/apps/{name}` |

### App config: presets

| Tool | Endpoint |
|---|---|
| `list_presets` | `GET /api/v1/apps/{app}/presets` — each entry flags `applied` |
| `apply_preset` | `POST /api/v1/apps/{app}/presets/{preset}/apply` — deep-merge + backup + hot-reload |
| `deactivate_preset` | `POST /api/v1/apps/{app}/presets/{preset}/deactivate` — reverts the preset's keys |

### Streams

| Tool | Endpoint |
|---|---|
| `list_streams` | `GET /api/v1/apps/{app}/streams` |
| `get_stream` | `GET /api/v1/apps/{app}/streams/{id}` |
| `stop_stream` ⚠ | `DELETE /api/v1/apps/{app}/streams/{id}` |
| `snapshot_stream` | `POST /api/v1/apps/{app}/streams/{id}/snapshot` — on-demand JPEG, by stream id |
| `snapshot_room` | `POST /api/v1/apps/{app}/snapshots` — on-demand JPEG, by room name |

Stream ids may contain `/` — pass them verbatim; the server URL-encodes.

### Rooms & moderation

| Tool | Endpoint |
|---|---|
| `list_rooms` | `GET /api/v1/apps/{app}/rooms` |
| `get_room` | `GET /api/v1/apps/{app}/rooms/{room}` |
| `list_participants` | `GET /api/v1/apps/{app}/rooms/{room}/participants` |
| `kick_participant` ⚠ | `DELETE /api/v1/apps/{app}/rooms/{room}/participants/{identity}` |
| `mute_participant` | `POST /api/v1/apps/{app}/rooms/{room}/participants/{identity}/mute` |
| `update_room_metadata` | `PATCH /api/v1/apps/{app}/rooms/{room}/metadata` |
| `send_room_data` | `POST /api/v1/apps/{app}/rooms/{room}/data` |

### Tags (dynamic stream/room tagging)

| Tool | Endpoint |
|---|---|
| `list_tags` | `GET /api/v1/apps/{app}/tags` |
| `get_tag` | `GET /api/v1/apps/{app}/tags/{slug}` |
| `create_tag` | `POST /api/v1/apps/{app}/tags` |
| `update_tag` | `PATCH /api/v1/apps/{app}/tags/{slug}` |
| `delete_tag` ⚠ | `DELETE /api/v1/apps/{app}/tags/{slug}` — prunes the slug from every stream |
| `apply_room_tags` | `PATCH /api/v1/apps/{app}/tags/room/{room}` |
| `get_stream_tags` | `GET /api/v1/apps/{app}/streams/{id}/tags` |
| `update_stream_tags` | `PATCH /api/v1/apps/{app}/streams/{id}/tags` |

### Ingress (RTMP / WHIP / URL pull / SRT passthrough / MPEG-TS multicast)

| Tool | Endpoint |
|---|---|
| `create_ingress` | `POST /api/v1/apps/{app}/ingress` — `inputType: rtmp\|whip\|url\|srt\|mpegts`; `rtmp` returns `rtmp_url` + `stream_key` (+ a failover pair with `backup:true`); `srt`/`mpegts` are passthrough-only (`mode:'passthrough'`) |
| `list_ingress` | `GET /api/v1/apps/{app}/ingress` |
| `get_ingress` | `GET /api/v1/apps/{app}/ingress/{id}` |
| `delete_ingress` ⚠ | `DELETE /api/v1/apps/{app}/ingress/{id}` |

### Recording

| Tool | Endpoint |
|---|---|
| `start_recording` | `POST /api/v1/apps/{app}/recording/start` |
| `stop_recording` | `POST /api/v1/apps/{app}/recording/{id}/stop` |
| `start_stream_recording` | `POST /api/v1/apps/{app}/streams/{id}/record/start` |
| `stop_stream_recording` | `POST /api/v1/apps/{app}/streams/{id}/record/stop` |

### VODs & transcription

| Tool | Endpoint |
|---|---|
| `list_vods` | `GET /api/v1/apps/{app}/vods` |
| `get_vod` | `GET /api/v1/apps/{app}/vods/{id}` — playback URLs + adaptive/HLS variants |
| `transcribe_vod` | `POST /api/v1/apps/{app}/vods/{id}/transcribe` |
| `get_vod_transcript` | `GET /api/v1/apps/{app}/vods/{id}/transcript` — text, timed segments, speakers, SRT URL |
| `delete_vod` ⛔ | `DELETE /api/v1/apps/{app}/vods/{id}` |

### Plugins

| Tool | Endpoint |
|---|---|
| `list_plugins` | `GET /api/v1/apps/{app}/plugins` |
| `get_plugin` | `GET /api/v1/apps/{app}/plugins/{id}` |
| `install_plugin` | `POST /api/v1/apps/{app}/plugins/{id}/install` |
| `configure_plugin` | `PATCH /api/v1/apps/{app}/plugins/{id}` |
| `uninstall_plugin` ⚠ | `DELETE /api/v1/apps/{app}/plugins/{id}` |
| `control_plugin_worker` | `POST .../worker/start` \| `POST .../worker/stop` \| `GET .../worker/status` (by `action`) |
| `get_plugin_logs` | `GET /api/v1/apps/{app}/plugins/{id}/logs` |

### Live Control (pause / resume / finish a live stream)

| Tool | Endpoint |
|---|---|
| `list_live_control_streams` | `GET /api/v1/apps/{app}/plugins/live-control/streams` |
| `get_live_control_stream` | `GET /api/v1/apps/{app}/plugins/live-control/streams/{streamId}` |
| `pause_live_stream` ⚠ | `POST .../streams/{streamId}/pause` — viewers see a cover, audio muted |
| `resume_live_stream` | `POST .../streams/{streamId}/resume` |
| `finish_live_stream` ⚠ | `POST .../streams/{streamId}/finish` — terminal cover |
| `list_live_control_assets` | `GET .../assets` (uploading a NEW asset is a multipart file upload — not exposed over MCP, use the dashboard) |
| `get_live_control_asset_url` | `GET .../assets/{id}/url` |
| `delete_live_control_asset` ⚠ | `DELETE .../assets/{id}` |
| `get_live_control_settings` | `GET .../settings` |
| `set_live_control_settings` | `PUT .../settings` — default pause/finish cover asset ids |

### Stream Health (origin quality monitor)

| Tool | Endpoint |
|---|---|
| `get_stream_health_overview` | `GET /api/v1/apps/{app}/plugins/stream-health/overview` |
| `list_stream_health_events` | `GET .../events` — recent `health.*` transitions |
| `get_stream_health_room_settings` | `GET .../streams/{room}/settings` |
| `set_stream_health_room_settings` | `PUT .../streams/{room}/settings` — partial threshold override (silence/desync/stall/bitrate-drop) |

### Streamflow (event-driven automation workflows)

| Tool | Endpoint |
|---|---|
| `list_streamflow_events` | `GET /api/v1/apps/{app}/plugins/streamflow/events` — trigger-event catalogue |
| `list_workflows` | `GET .../workflows` |
| `get_workflow` | `GET .../workflows/{id}` |
| `create_workflow` | `POST .../workflows` |
| `update_workflow` | `PUT .../workflows/{id}` |
| `delete_workflow` ⚠ | `DELETE .../workflows/{id}` — also deletes its run history |
| `enable_workflow` | `POST .../workflows/{id}/enable` |
| `run_workflow` | `POST .../workflows/{id}/run` — manual trigger with an optional payload |
| `export_workflow` | `GET .../workflows/{id}/export` — portable, secret-redacted JSON |
| `import_workflow` | `POST .../workflows/import` |
| `list_workflow_runs` | `GET .../runs` |
| `get_workflow_run` | `GET .../runs/{id}` — per-box steps |
| `list_streamflow_secrets` | `GET .../secrets` — NAMES + masked hint only, **values are never returned by any tool** |
| `put_streamflow_secret` | `PUT .../secrets/{name}` — write-only; response never echoes the value |
| `delete_streamflow_secret` ⚠ | `DELETE .../secrets/{name}` |

### Tokens

| Tool | Endpoint |
|---|---|
| `mint_join_token` | `POST /api/v1/apps/{app}/tokens` — LiveKit join token + player URLs |
| `sign_playback_url` | `POST /api/v1/apps/{app}/play-token/{room}/sign` — signed embed: returns `tokenUrl`/`playUrl`/`embedUrl` + a ready `iframe` snippet, for `publicPlayback: false` apps |
| `list_api_tokens` | `GET /api/v1/tokens` |
| `create_api_token` | `POST /api/v1/tokens` — plaintext returned once |
| `revoke_api_token` ⚠ | `DELETE /api/v1/tokens/{id}` |

### DB maintenance

| Tool | Endpoint |
|---|---|
| `get_app_db_health` | `GET /api/v1/apps/{app}/db/health` |
| `purge_app_db` ⛔ | `POST /api/v1/apps/{app}/db/purge` |

### Not exposed (deliberately out of scope)

- **Per-app quotas** (`quotas.maxConcurrentStreams` / `maxViewersPerStream` in
  `config.yaml`) — there is no field-level REST endpoint for them; the only
  way to set them is the full-YAML `PUT /apps/{app}/config/raw` editor, a
  separate broader feature (with backups/revert/dry-run) not covered by this
  tool set. Per-**tenant** quotas (`PATCH /tenants/{id}/quotas`, superadmin
  scope) are a distinct surface and also not exposed — deliberately
  platform-owner-only.
- **Live Control asset upload** (`POST .../live-control/assets`) — multipart
  file upload; use the dashboard.
- **Config raw editor / backups / reload / transcoding-layers view** — a
  bigger, separate surface than this wave's scope; only the presets shortcut
  (`list_presets`/`apply_preset`/`deactivate_preset`) is exposed.

## Resources & prompts

| Kind | Name | What |
|---|---|---|
| resource | `streamhub://apps` | JSON list of the apps visible to the token |
| resource | `streamhub://health` | liveness of the configured instance |
| resource template | `streamhub://apps/{app}` | one app with its resolved config |
| prompt | `go-live` | step-by-step runbook: create RTMP ingress → OBS settings → verify on air → share `/play` link → optional recording |
| prompt | `diagnose-stream` | triage a broken stream: ingress status, rooms, app stats, error logs |

---

## Safety: destructive operations & token scope

**Destructive gating — two independent layers:**

1. `delete_app`, `delete_vod` and `purge_app_db` are **not registered** unless
   the server starts with `--allow-destructive` /
   `STREAMHUB_ALLOW_DESTRUCTIVE=true`. A model cannot call (or even see) them
   by default.
2. When enabled, each requires a literal `confirm: true` argument — schema-
   rejected otherwise — and the handler refuses to fire without it. The tool
   descriptions instruct the model to obtain explicit user approval first.

Milder state-changing tools (marked ⚠ above: `stop_stream`,
`kick_participant`, `delete_tag`, `delete_ingress`, `uninstall_plugin`,
`pause_live_stream`, `finish_live_stream`, `delete_live_control_asset`,
`delete_workflow`, `delete_streamflow_secret`, `revoke_api_token`) stay
available but carry MCP `destructiveHint` annotations so well-behaved clients
ask before executing. `pause`/`finish` interrupt what viewers currently see;
the `delete_*` ones remove a tag/asset/workflow/secret — none of them wipe an
app, a VOD or a whole DB, which is why they are not behind
`--allow-destructive`.

**Streamflow secrets are write-only, everywhere.** `list_streamflow_secrets`
returns only a name + masked hint (e.g. `sk-…a1b2`); `put_streamflow_secret`
accepts a plaintext value but its response is masked metadata, never an echo
of the value. There is intentionally no tool (and no underlying REST route)
that returns a secret value — secrets are decrypted only in-process, at
workflow run time.

**Token scope — use an app-scoped `sk_` token.** The MCP client stores the
token in plaintext config, and the model can call whatever the token allows:

- An **app-scoped token** (`create_api_token` with `scope: "app"`, or the
  dashboard) confines the blast radius to one app — recommended.
- A **global token** resolves to superadmin and unlocks tenant-wide surfaces.
  Only use one for deliberate platform administration, ideally with
  `allowedIps` pinned.
- Rotate the token if the config file may have leaked (`revoke_api_token` +
  `create_api_token`).

## Development

```bash
npm run build       # compile to dist/
npm test            # node:test — 121 tests, mocked fetch, no network
npm run typecheck   # tsc --noEmit including specs
```

Tests cover the `{ data, error }` envelope client (unwrapping, pagination,
NestJS error surfacing, headers/query building) and the **complete
tool→endpoint mapping** — every tool is exercised against a fake client that
records method/path/query/body.

## Related docs

- [api/README](https://streamhub.studio/docs/api/README) — every endpoint + permission
- [api/POSTMAN](https://streamhub.studio/docs/api/POSTMAN) — the `{data, error}` envelope & bearer auth
- [integrations/MCP](https://streamhub.studio/docs/integrations/MCP) — integration overview page
