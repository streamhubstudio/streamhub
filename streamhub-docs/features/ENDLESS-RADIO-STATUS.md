# Endless Radio integration — re-verified status (post-2.5.0) + implementation plan

> **Historical note:** file and spec citations here refer to the 2.x Node core (`streamhub-core/src/…`, branch `legacy/node-2.x`, tag `2.24.0`); the current core is Go (`streamhub-core-go/`).

Companion to `planning/ENDLESS-RADIO-INTEGRATION.md` (internal). Re-audited against the **current** tree after
2.5.0 (cluster, GRID, HLS-CDN cache, pipeline endpoint). Corrects line drift + stale claims.

## Headline corrections vs the original doc
1. **`livePlaylistName` EXISTS** in the installed `@livekit/protocol` `SegmentedFileOutput` and StreamHub
   sets it nowhere → the DVR/manifest-growth fix is **S-M**, not "M unknown egress support".
2. **The SPA has NO CSP** (`main.ts` `helmet({contentSecurityPolicy:false})`) → Google IMA / an ad
   player loads unblocked on `/play`, `/embed`, plugin overlays. IMA-wrapped CSAI is easier than stated.
3. **HLS-CDN cache policy already ships** (`modules/streams/hls-cache.ts`): `.ts` immutable 1y, live
   `.m3u8` `no-cache` (or SWR under `STREAMHUB_HLS_CDN=on`) → CDN fan-out/cache-collapse is solved;
   distinct from manifest growth / disk retention (§3.8).
4. **The ingress SDK can't carry a room config** (`CreateIngressOptions` has no room block in
   livekit-server-sdk v2.7) → the §3.1 fix must pre-create the room (`createRoom`, currently dead code)
   or set `deploy/livekit.yaml room:`, NOT a one-liner in `createIngress`.
5. **`GET /apps/:app/pipeline`** (new) is a static topology contract — not an ad/audience seam.

## Corrected 9-item status
| # | Item | Real status (post-2.5.0) | Effort to close |
|---|---|---|---|
| 1 | Ingest RTMP 24/7 | PARTIAL (good) — one real gap: room `emptyTimeout` | **S** |
| 2 | Player + VAST/VMAP | MISSING ad-player; all seams EXIST (overlay slot, data-channel, EB) | M (IMA) / L (custom) |
| 3 | Timed metadata / markers | MISSING in HLS; **data-channel ad-cue works TODAY** | S (cue) / L (HLS DATERANGE) |
| 4 | HLS per-session (SSAI) | MISSING; mount seam clean | L |
| 5 | Audience analytics | PARTIAL — WebRTC live only, no history, HLS=0 | S (WebRTC hist) / M-L (HLS) |
| 6 | Session webhooks / freq-cap | PARTIAL — join/leave forwarded w/ sid+identity, no stable viewerId/IP | M (WebRTC) / L (HLS) |
| 7 | Multi-channel / stable URLs | EXISTS (quotas default 2/2, `-1`=unlimited) | S (config) |
| 8 | DVR / latency | PARTIAL — smaller now (`livePlaylistName`) + disk janitor | S-M + S |
| 9 | Embed tokens / geo / CORS | PARTIAL — tokens/CORS good; geo MISSING; `/hls` ungated | S (docs/gate) / M (geo) |

## Implementation plan
### Tier 1 — quick wins (S/S-M), ship first
- **QW-1** 24/7 room `emptyTimeout`: pre-create the room with a long timeout in the ingress-create
  controller before `createIngress`, gated by an app feature (`features.persistentRoom`/`hls.always_on`)
  so conference rooms keep 300s. Test in `livekit.controller.spec.ts`.
- **QW-2** Auto-HLS watchdog: reconciliation timer relaunches a dead HLS egress for `always_on` apps
  (`HlsService.start` already idempotent). New `hls-watchdog.spec.ts`.
- **QW-3** Multi-channel quotas: a "linear/broadcaster" plan preset (`maxConcurrentStreams:-1`) next to
  `FREE_PLAN_QUOTA`. `quotas.service.spec.ts`.
- **QW-4** DVR window: set `livePlaylistName` on the SegmentedFileOutput + serve the live playlist as the
  public manifest; add a `.ts` retention janitor for `always_on` rooms. Specs on egress + janitor.
- **QW-5** Embed/HLS entitlement: document that `/hls` is public+CORS-open (fine for ad-supported
  embeds); optional opt-in signed-cookie gate on the HLS mount for `private_hls` apps. Geo = edge (defer).

### Tier 2 — medium
- **M-1** Typed `ad-cue`/`ad-cue-end` data-channel contract + optional core helper (works today via
  `POST /rooms/:room/data`; WebRTC/SDK players only). `rooms.controller.spec.ts`.
- **M-2** WebRTC audience history: persist `liveStats` to a `viewer_samples` table (metrics-history shape).
- **M-3** Session webhooks + stable `viewerId` cookie in the play-token identity + IP in the payload.
- **M-4** CSAI/VAST overlay plugin (`plugins/csai-ads`, slot `player-overlay`) wrapping Google IMA on
  pre-roll + `ad-cue` mid-roll; mute-not-pause over the live `<video>`.

### Tier 3 — large (multi-week, scoped honestly)
- **L-1** Custom VAST 4.2 player (only if IMA is unacceptable).
- **L-2** HLS `EXT-X-DATERANGE`/ID3 markers — needs a `.m3u8` post-processor (egress won't insert).
- **L-3** HLS-per-session + SSAI stitcher (new service; prereqs L-2 + M-3 + program-profile ad encode).
- **L-4** HLS audience measurement (depends on the L-3 per-session seam).

**Bottom line:** 24/7 distribution is essentially ready (and cheaper than the doc thought). Tier 1 hardens
the base in days; monetization builds up S→L: ad-cue → IMA CSAI → audience history + capping → then the
multi-week HLS marker/SSAI/measurement stack.

## Tier 1 — shipped (implementation notes)

All five quick wins are implemented in `streamhub-core` behind a single per-app
`features.linear:` block (all knobs default **off** ⇒ zero behaviour change for
normal apps). Config + defaults: [`../config-reference.md`](../config-reference.md#features-spec-16).

- **QW-1 · persistent room `emptyTimeout`** — `LiveKitController.createIngress`
  pre-creates the room with `createRoom(room, roomEmptyTimeoutSeconds)` BEFORE
  `createIngress`, gated by `features.linear.persistent_room` (default 24h).
  Best-effort (a createRoom hiccup never blocks ingress). *Caveat:* LiveKit's
  `createRoom` only sets `emptyTimeout` for a room that does not yet exist.
  Test: `livekit.controller.spec.ts`.
- **QW-2 · auto-HLS watchdog** — `HlsWatchdogService` (streams module) reconciles
  every 30s: for `always_on_hls` apps, any active room with no live HLS egress
  gets one idempotent `HlsService.start`. Timer disabled under tests / via
  `STREAMHUB_HLS_WATCHDOG=off`; `reconcileOnce()` is public for tests.
  Test: `hls-watchdog.spec.ts`.
- **QW-3 · broadcaster/linear quota preset** — `BROADCASTER_PLAN_QUOTA`
  (`maxConcurrentStreams:-1`, 50 apps, unlimited monthly) next to
  `FREE_PLAN_QUOTA`; `PATCH /tenants/:id/quotas { plan: "broadcaster" }` applies
  it as the baseline (explicit metric overrides still win). Test:
  `quotas.service.spec.ts`.
- **QW-4 · DVR / bounded live manifest** — `startHlsEgress` sets
  `livePlaylistName` on the `SegmentedFileOutput` when `dvr` is on; `HlsService`
  serves the rolling `live.m3u8` as the public manifest; the watchdog runs a
  `.ts` retention janitor (`hls-dvr-janitor.ts`) that deletes segments older than
  `dvr_window_seconds` — **never** one referenced by the live playlist. Tests:
  `livekit.service.hlsegress.spec.ts`, `hls-dvr-janitor.spec.ts`.
- **QW-5 · embed / HLS entitlement** — *docs-only for Tier 1.* `/hls` is served
  **public + CORS-open** (`Access-Control-Allow-Origin: *`, `.ts` immutable-cached,
  live `.m3u8` short-TTL — see `modules/streams/hls-cache.ts`). That is the
  intended posture for **ad-supported embeds**: anyone can `<video>`-play the HLS
  from any origin. The **gated** path is WebRTC: `play-token` / `radio listen-token`
  are subscribe-only and, for `public_playback:false` apps, require a signed
  short-TTL capability URL (`?exp=&sig=`, `POST play-token/:room/sign`). An opt-in
  signed-cookie gate on the HLS static mount was **descoped**: the `/hls` mount is
  wired in the scaffolder-owned `src/main.ts` (which this work must not edit), so
  per-app HLS entitlement belongs at the **edge** (Caddy/nginx `forward_auth` or a
  signed-cookie/CDN token in front of `/hls`). **Geo-blocking is out of scope**
  (an edge concern). Recommended edge gate: a `forward_auth` to
  `GET /apps/:app/play-token/:room` (reuse the same signature) before proxying
  `/hls/:app/:room/*`.
