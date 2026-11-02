# MCP — operate StreamHub from an AI client

`streamhub-mcp` is an **MCP (Model Context Protocol) server** that exposes the
StreamHub REST API (`/api/v1`) as **89 typed tools**, 3 resources and 2 prompts
over stdio, so **Claude Desktop**, **Claude Code** or any MCP-capable agent can
operate an instance conversationally: create apps, mint RTMP/SRT/MPEG-TS ingest
credentials, apply config presets, start recordings, browse VODs and
transcripts, moderate live rooms, tag streams, pause/resume/finish a live
broadcast, monitor stream health, build Streamflow automation workflows, and
install plugins.

- **One static binary** (Go, no runtime needed) for macOS, Linux and Windows,
  amd64 + arm64. Source: `streamhub-core-go/cmd/streamhub-mcp` +
  `streamhub-core-go/internal/mcpserver` (official Go SDK,
  `github.com/modelcontextprotocol/go-sdk`).
- Transport: **stdio** (the standard for local MCP servers).
- Auth: a StreamHub **`sk_` API token** passed via environment.
- Every tool maps to exactly **one** documented REST endpoint
  ([`api/openapi.json`](../api/openapi.json) is the authoritative surface) and
  unwraps the `{ data, error }` envelope for the model.
- **Destructive operations are off by default** (see
  [Safety](#safety-destructive-operations--token-scope)).

> Until 3.0 this was a Node/TypeScript package (`mcp-server/`, run with
> `node dist/index.js`). The Go binary is a drop-in replacement: same tool,
> resource and prompt names, descriptions and JSON Schemas, same env vars and
> flag, same error texts — only the `command` in your client config changes.

---

## Install

**Prebuilt binary.** Download `streamhub-mcp-<version>-<os>-<arch>` (`.exe` on
Windows) from the release assets, verify it against its `.sha256`, make it
executable and put it somewhere stable:

```bash
chmod +x streamhub-mcp-3.0.0-darwin-arm64
sudo mv streamhub-mcp-3.0.0-darwin-arm64 /usr/local/bin/streamhub-mcp
```

> macOS: a binary downloaded with a browser is quarantined — run
> `xattr -d com.apple.quarantine /usr/local/bin/streamhub-mcp` once.

**From source** (Go 1.26+):

```bash
cd streamhub-core-go && go build -o streamhub-mcp ./cmd/streamhub-mcp
deploy/make-mcp.sh            # or: every platform → dist/streamhub-mcp-<ver>-<os>-<arch>
```

## Configure

Everything is environment-driven (MCP clients pass env via their config):

| Variable | Required | Meaning |
|---|---|---|
| `STREAMHUB_API_URL` | yes | Base URL of the instance — the origin (`https://media.example.com`) or the full API base (`.../api/v1`); both accepted. For a local core: `http://127.0.0.1:3020`. |
| `STREAMHUB_API_TOKEN` | yes | An `sk_` API token. **Use an app-scoped token** unless you really need global surfaces (see [Safety](#safety-destructive-operations--token-scope)). |
| `STREAMHUB_ALLOW_DESTRUCTIVE` | no | `true`/`1`/`yes`/`on` registers the destructive tools (delete app, delete VOD, db purge). Default: off — they are not even visible to the model. |

CLI flag: `--allow-destructive` is equivalent to the env var. The server never
writes to stdout (the MCP transport); its one-line ready message and errors go
to stderr.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "streamhub": {
      "command": "/usr/local/bin/streamhub-mcp",
      "env": {
        "STREAMHUB_API_URL": "https://media.example.com",
        "STREAMHUB_API_TOKEN": "sk_..."
      }
    }
  }
}
```

On Windows use the full path to the `.exe`
(`"command": "C:\\Tools\\streamhub-mcp.exe"`). Add
`"args": ["--allow-destructive"]` only if you deliberately want the destructive
tools. Restart Claude Desktop after editing.

### Claude Code

```bash
claude mcp add streamhub \
  -e STREAMHUB_API_URL=https://media.example.com \
  -e STREAMHUB_API_TOKEN=sk_... \
  -- /usr/local/bin/streamhub-mcp
```

`claude mcp list` should show `streamhub` as connected.

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
cd streamhub-core-go
go test ./internal/mcpserver/          # no network: httptest fake API
go build ./cmd/streamhub-mcp
```

The catalogue (`internal/mcpserver/catalog.json`: names, titles, descriptions,
JSON Schemas, annotations) is served verbatim; `tools_table.go` maps each tool
to its endpoint (method, path, body/query args). Add a tool by editing both.
Input validation reproduces zod's issue objects and messages, so the model
sees the same errors as with the TypeScript server.

Parity with the former TypeScript server is locked by vectors generated from it
(`internal/mcpserver/testdata/gen.mjs` → `ts_catalog.json`, `ts_calls.json`):
`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`
(gate off and on), the initialize result, and ~250 `tools/call` exchanges per
gate mode (every tool's endpoint mapping, every response/error shape, every
zod issue kind), plus `resources/read` and `prompts/get` — all replayed over a
real MCP session against an `httptest` fake with the same script.

## Related docs

- [`api/README.md`](../api/README.md) — every endpoint + permission
- [`api/POSTMAN.md`](../api/POSTMAN.md) — the `{data, error}` envelope & bearer auth
