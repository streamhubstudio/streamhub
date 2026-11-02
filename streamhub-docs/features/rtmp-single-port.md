# Single-port :1935 RTMP ingest via MediaMTX

**Status:** shipped (env-gated OFF by default). **Front:** [MediaMTX](https://github.com/bluenviron/mediamtx)
`v1.19.2`. **Pairs with:** the core `modules/passthrough` hooks
(`/api/v1/internal/mediamtx/{auth,ready,notready}`).

One public RTMP port — **`:1935`** — for **both** ingest planes. MediaMTX fronts
the port but does **not** decide the plane: it notifies the **core** on every
publish, and the core classifies by the stream **key** and does all the work
(the core owns every ffmpeg — MediaMTX runs none):

| Push URL | Core sees | Plane | What the CORE does |
|---|---|---|---|
| `rtmp://<host>:1935/<app>/ptk_<key>` | a `ptk_` key | **passthrough** (remux → HLS) | arms an `ffmpeg -c copy` → HLS remux (see [rtmp-passthrough.md](rtmp-passthrough.md)) |
| `rtmp://<host>:1935/live/<key>` | a non-`ptk_` key under `live/` | **LiveKit** (transcode / WebRTC / recording) | arms a forward (`ffmpeg -c copy`) to the LiveKit ingress on the internal **`:11935`** |

This replaces the older **multi-port** model (LiveKit on `:1935` + passthrough on
its own `:1937+` pool), which remains the **fallback** whenever
`STREAMHUB_MEDIAMTX_ENABLE` is unset. It is **additive and reversible**: with the
switch off, behaviour is byte-for-byte what it was before.

## Why the CORE classifies (not a MediaMTX regex)

The obvious design — a MediaMTX `~^live/(.+)$` path that forwards and everything
else passthrough — **breaks**, because the default seeded tenant app is literally
named `live`: a passthrough push on it is `live/ptk_…`, which such a regex would
misroute to LiveKit. Go's RE2 has **no negative lookahead** to exclude `ptk_`. So
MediaMTX stays dumb (one global hook for every publish) and the **core** keys on
the `ptk_` prefix — unambiguous regardless of app name. For encoders the **only**
change is the passthrough port moving `1937 → 1935`; paths and the LiveKit URL
are unchanged.

> **Residual edge:** the discriminator is the `ptk_` prefix, so a LiveKit ingress
> stream key literally starting with `ptk_` would be misclassified as passthrough.
> LiveKit never generates such keys today, so this is theoretical — noted for
> completeness.

## Topology

```
                          :1935 (public RTMP)
   encoder ───RTMP──▶  ┌──────────── MediaMTX ─────────────┐
                       │ auth:      POST → core /…/auth      │  allow/deny (?secret=)
                       │ runOnReady:  POST → core /…/ready   │  every publish, ONE hook
                       │ runOnNotReady: POST → core /…/notready │
                       └───────────────────┬────────────────┘
                                           │ the CORE classifies by key + owns ffmpeg:
                          ptk_<key> ────────┼─▶ ffmpeg -c copy -f hls  (pull rtmp://127.0.0.1:1935/<app>/<key>)
                                           │      → DATA_DIR/apps/<app>/hls/<room>/   (passthrough)
                          live/<key> ───────┴─▶ ffmpeg -c copy -f flv  → LiveKit ingress 127.0.0.1:11935
   MediaMTX API on 127.0.0.1:9997 (loopback only) — REQUIRED: core boot re-arm.
```

- **MediaMTX** binds `:1935` (RTMP) and `127.0.0.1:9997` (API — **loopback only,
  and required**: the core queries `GET /v3/paths/list` on boot to re-arm
  remuxes/forwards for streams already publishing). Its own HLS / RTSP / WebRTC /
  SRT / MoQ muxers are **off** — StreamHub keeps serving HLS from the core
  (`DATA_DIR`), so the player, VOD and dashboard are untouched. It runs
  **host-networked** (like every other media service) so its loopback hooks reach
  the core (`:3020`) and its pulled/forwarded ffmpeg (run by the core) reach the
  LiveKit ingress (`:11935`) — a bridge network could not (the core binds
  `127.0.0.1`).
- **LiveKit ingress** moves `rtmp_port: 1935 → 11935`
  (`STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT` — one var that is BOTH the ingress listen
  port and the core's forward target; `deploy/ingress.yaml` for the bare
  template). It is reachable on loopback only.
- **rtmps front** (stunnel, the `rtmps` profile) forwards decrypted RTMP to
  `127.0.0.1:1935` — now MediaMTX — so **rtmps works for both planes**.
- **SRT passthrough is unaffected** — it stays on its own listener
  (`STREAMHUB_RTMP_PASSTHROUGH_PORT`, UDP); MediaMTX fronts RTMP only in this wave.

## Core ↔ MediaMTX HTTP contract

MediaMTX fires three loopback hooks; the core (`modules/passthrough`,
`streamhub-core-go/internal/passthrough/hooks.go`) guards each with the source IP **plus** the shared
`STREAMHUB_MEDIAMTX_HOOK_SECRET`, then classifies by the path:

| MediaMTX config | → core route | Secret transport | Body / notes |
|---|---|---|---|
| `authHTTPAddress` | `POST /api/v1/internal/mediamtx/auth` | **`?secret=`** query¹ | MediaMTX's fixed auth JSON (`{user,password,ip,action,path,protocol,…}`). `20x` = allow. `publish` of a `ptk_` key is validated; `live/*` and reads allowed. |
| `pathDefaults.runOnReady` | `POST /api/v1/internal/mediamtx/ready` | `X-MediaMTX-Secret` header | `{"path":"<full/path>"}` — the core arms the remux **or** the LiveKit forward. |
| `pathDefaults.runOnNotReady` | `POST /api/v1/internal/mediamtx/notready` | `X-MediaMTX-Secret` header | `{"path":"<full/path>"}` — the core tears the flow down. |

- **Secret:** `ready`/`notready` carry it in a header that MediaMTX expands from
  `${STREAMHUB_MEDIAMTX_HOOK_SECRET}` (process env). ¹`authHTTPAddress` **cannot
  send a custom header**, and MediaMTX does **not** expand `${VARS}` inside config
  *values* — so the auth URL carries `?secret=` injected via the
  **`MTX_AUTHHTTPADDRESS`** env override (compose `environment:` interpolates it
  from `.env`; the bare node writes it into `/etc/streamhub/mediamtx.env`,
  `chmod 600`). The committed `mediamtx.yml` keeps a secret-free base
  `authHTTPAddress` so it validates standalone.

MediaMTX runs `runOn*` commands **without a shell**: the string is split with
shell-quoting rules and the binary is `exec`'d directly, while `$VARS` are
expanded by MediaMTX first (`$MTX_PATH` from the path; any other `$NAME` from the
environment via `os.Getenv`). So each hook is a **single** `wget` — no pipes,
`&&` or `;`. `wget` is busybox in the compose `-ffmpeg` image and GNU wget on a
bare node; the `--header` / `--post-data` flags used work on both. **The plain
`bluenviron/mediamtx` image is `FROM scratch`** (no shell/wget) and cannot run
the hooks — the `-ffmpeg` tag (alpine + busybox wget) is used purely for its
wget, not its ffmpeg.

## Enable it

### One-liner installer (bare node — recommended)

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- --mediamtx
# or on an existing install:  sudo STREAMHUB_MEDIAMTX_ENABLE=1 bash install.sh
```

`--mediamtx` (idempotent) sets the `.env` keys below, installs the **pinned**
`mediamtx` binary (download + sha256-verified) with `wget` (no ffmpeg — the core
owns it), drops the config at `/etc/streamhub/mediamtx.yml` + the secret env at
`/etc/streamhub/mediamtx.env` (`chmod 600`, incl. `MTX_AUTHHTTPADDRESS`), and
enables `streamhub-mediamtx.service`. The LiveKit ingress moves to `:11935` via
the compose `up` in the same install.

### Plain docker compose

```bash
# .env:
STREAMHUB_MEDIAMTX_ENABLE=true
STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT=11935
STREAMHUB_MEDIAMTX_HOOK_SECRET=<long-random>

docker compose --profile mediamtx up -d
```

The `mediamtx` service (host-networked, image `bluenviron/mediamtx:1.19.2-ffmpeg`)
only starts under the `mediamtx` profile — so with the profile off the service is
present but dormant and the stack behaves exactly as today. Its `environment:`
sets `STREAMHUB_MEDIAMTX_HOOK_SECRET` (ready/notready header) and
`MTX_AUTHHTTPADDRESS=…/auth?secret=${STREAMHUB_MEDIAMTX_HOOK_SECRET}` (auth query).

> The gitignored operator script `deploy-streamhub.sh` must add the same three
> `.env` keys (and start the `mediamtx` profile / systemd unit).

### Firewall

Open only **`:1935/tcp`** publicly for RTMP (unchanged from before). The internal
`:11935` (LiveKit ingress) and `:9997` (MediaMTX API) are **loopback only** — do
**not** open them. The old `:1937+` passthrough ports are no longer used.

## SRT

**Opt-in (E2), off by default.** Without it an SRT passthrough ingress is an ffmpeg
`mode=listener` on its own `:1937+` port that accepts **any** caller (the
`streamid` is not checked: the "auth" is knowing the port). With

```bash
STREAMHUB_MEDIAMTX_ENABLE=true
STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on
STREAMHUB_MEDIAMTX_SRT_ENABLE=true    # true|false only (compose passes it to MediaMTX as MTX_SRT)
#STREAMHUB_MEDIAMTX_SRT_PORT=8890
```

MediaMTX listens SRT on `:8890/udp` and:

1. `POST /apps/:app/ingress {inputType:"srt", mode:"passthrough"}` returns
   `srt_url = srt://<host>:8890?streamid=publish:<app>/<ptk_key>` (no per-ingress
   listener is spawned, at create or at boot re-arm).
2. The encoder pushes there. MediaMTX maps the `streamid` to the path `<app>/<ptk_key>`
   and calls the auth hook (`action: publish`, `protocol: srt`): the same check as an
   RTMP push — a minted passthrough key of that app, `allowedPublisherCidr`,
   `features.geo` — else `401` and MediaMTX drops the caller.
3. The ready hook arms the remux, which **pulls** the stream back over SRT from
   loopback (`-i srt://127.0.0.1:8890?streamid=read:<app>/<key>`, `-c copy` → HLS).
   MPEG-TS carries any codec, so this is also the HEVC path ([§ HEVC](#hevc)).
4. An SRT `read` passes the auth hook **only from loopback** (`127.0.0.1`/`::1`): the
   listener is public and would otherwise serve any path raw to anyone who has it.
   RTMP reads are unchanged.

Firewall: open `8890/udp`. Rollback: `STREAMHUB_MEDIAMTX_SRT_ENABLE=false` + restart
(existing SRT ingresses go back to their `:1937+` listener URLs).

## HEVC

**Opt-in (E1), off by default** — `STREAMHUB_PASSTHROUGH_HEVC=on`, on top of the
MediaMTX front. Passthrough is `-c copy`, so the core can't transcode H.265; it can
package it so browsers play it. Apple (Safari / iOS native HLS) only plays HEVC in
**fMP4** segments tagged **`hvc1`**, and MSE players (hls.js) need fMP4 as well.

When the ready hook arms a pull remux, the core asks the MediaMTX API for the path's
tracks (`GET /v3/paths/get/<app>/<key>`). If the video track is `H265`, the remux
writes `index.m3u8` + `init.mp4` + `seg_NNNNN.m4s`
(`-tag:v hvc1 -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4`). H.264, an
unreachable API, or the switch off keep MPEG-TS segments, byte for byte as before. The
playlist URL does not change. `/hls` serves `.m4s` as `video/iso.segment` (immutable)
and `init.mp4` as `video/mp4` (`no-cache`); the nginx / Caddy direct-serve configs
cache `.m4s` like `.ts`. The `?st=` rewrite of private apps covers `#EXT-X-MAP`.

- **Which encoders:** H.265 over **SRT** (MPEG-TS, [§ SRT](#srt)) is the supported
  path. Enhanced-RTMP HEVC into MediaMTX should work the same way (MediaMTX reports
  the track), but it depends on the encoder and on ffmpeg's RTMP reader — **[verify]**.
  The multi-port listener (switch off) can't detect the codec: HEVC needs the front.
- **Playback:** Safari / iOS natively; Chrome / Edge through hls.js where the
  platform decodes HEVC in hardware; Firefox generally not — **[verify]** current
  browser support. For universal playback, keep H.264 on the LiveKit plane (WebRTC
  + ABR) and use HEVC passthrough for bandwidth-bound contribution feeds.
- The ingress `capabilities` block still says `requiresH264Aac: true` (unchanged
  contract); with this switch it applies only to the listener path.

## Fallback (multi-port) — when the switch is OFF

With `STREAMHUB_MEDIAMTX_ENABLE` unset (the default):

- LiveKit ingress binds `:1935` directly (the compose `ingress` defaults
  `STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT` to `1935`).
- RTMP→HLS passthrough runs on its own `:1937+` pool
  (`STREAMHUB_RTMP_PASSTHROUGH_*`) — see [rtmp-passthrough.md](rtmp-passthrough.md).
- The `mediamtx` compose service does not start; no MediaMTX binary is needed.

Rollback from single-port = set `STREAMHUB_MEDIAMTX_ENABLE=false` +
`STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT=1935`, restart the stack, stop
`streamhub-mediamtx.service`, and re-point encoders to the `:1937+` URLs. The
multi-port plane is untouched throughout, so this is instant.

## Files

| File | Role |
|---|---|
| `deploy/mediamtx.yml` | MediaMTX config (RTMP `:1935`, API loopback, HLS/RTSP/WebRTC/SRT off, one global auth + ready/notready hook pair; NO ffmpeg — the core owns it). |
| `docker-compose.yml` | `mediamtx` service (profile `mediamtx`, host net, `-ffmpeg` image, `MTX_AUTHHTTPADDRESS`); `ingress.rtmp_port = ${STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT:-1935}`. |
| `deploy/ingress.yaml` | bare-node LiveKit ingress template (`rtmp_port: 11935`). |
| `deploy/systemd/streamhub-mediamtx.service` | bare-node native-binary unit. |
| `install.sh` | `--mediamtx`: pinned binary install + config/secret/unit + `.env` wiring. |

## Notes / limitations

- MediaMTX-served HLS is **off** by design — HLS stays core-served from `DATA_DIR`.
- SRT through MediaMTX: opt-in since E2 (`STREAMHUB_MEDIAMTX_SRT_ENABLE`, see
  [§ SRT](#srt)); off, SRT passthrough keeps its own listener.
- Multi-node / edge MediaMTX is out of scope (the front runs on the origin that
  owns RTMP ingest).
