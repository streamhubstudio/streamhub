# WebRTC browser compatibility — Safari/iOS risks & mitigations

**Status:** analysis + applied mitigations (2026-07). Owner surface: the
`@streamhub/adaptor` SDK, the SPA players (`LivePlayer` / `HlsPlayer` /
`VodPlayer`), the Broadcast/Studio publisher and the Meeting room.

StreamHub is a drop-in-style AntMedia replacement, so this report mines the
bug classes AntMedia spent years fixing in `WebRTCAdaptor`
(`ant-media/StreamApp` → `webrtc_adaptor.js` / `media_manager.js`) plus the
known Safari/iOS WebRTC policies, and answers for each: **does livekit-client
already absorb it, and if not, what did StreamHub do about it.**

Key baseline (verified in `livekit-client@2.15.7` source,
`src/room/track/Track.ts` → `attachToElement` and `src/room/Room.ts`):

- `track.attach(el)` sets `playsInline=true`, `autoplay=true` (deliberately
  skipped on Safari video to dodge the Low-Power-Mode play/pause overlay —
  it calls `el.play()` out-of-band instead), mutes video-only elements, and
  carries the Safari-15 black-video + Firefox attach-timing workarounds.
- A connected `Room` registers `pagehide` + `beforeunload` →
  `disconnect()` (`disconnectOnPageLeave`, default ON).
- Automatic reconnection (ICE restart → full reconnect) is built in.
- Default publish codec is **vp8**; audio-unlock primitives exist
  (`canPlaybackAudio`, `startAudio()`, `RoomEvent.AudioPlaybackStatusChanged`)
  but the UI is the app's job.

## Ranked summary

| # | Risk (impact ▼) | Browsers | LiveKit handles? | StreamHub action |
|---|---|---|---|---|
| 1 | Audio autoplay blocked until user gesture | all; Safari/iOS strictest | primitives only, no UI | **Applied** — players render self-hiding `StartMediaButton`; adaptor auto-arms a one-shot first-gesture `startAudio()` + `audioPlaybackStatusChanged` event |
| 2 | No TURN → clients behind symmetric NAT/VPN never connect; Safari strictest | all, Safari worst | consumes ICE servers only — **server config** | **Installer flag** `--turn` (origin + nginx; drives the compose `turn:` block via `STREAMHUB_TURN_*`, issues the cert, opens 5349/3478) + adaptor appends a TURN hint to transport-failure errors |
| 3 | Muted **video** autoplay also blocked (iOS Low Power Mode / per-site setting) | Safari/iOS | detects (`VideoPlaybackStatusChanged`); no UI | **Applied** — `StartMediaButton` covers video; `HlsPlayer` gets a `blocked` state + tap-to-play overlay |
| 4 | Missing `playsinline` → iOS hijacks video into native fullscreen / black video | iOS (all browsers) | only for `attach()`-managed elements | **Applied** — video.js players get `playsinline: true` + legacy `webkit-playsinline`; adaptor stamps attrs on `localVideoElement`/`remoteVideoElement`; JSX previews get `LEGACY_INLINE_VIDEO_ATTRS` |
| 5 | Codec interop: VP8 is software-only on Apple hardware; AntMedia world is H.264-first | Safari/iOS + old devices | negotiates, but defaults to vp8 | **Applied** — publish default now **h264** in adaptor (`videoCodec` option), Broadcast publisher, Meeting room |
| 6 | getUserMedia failures surfaced as generic errors → permission UIs can't react | all (Safari prompts oftener) | throws DOMExceptions | **Applied** — adaptor emits the DOMException NAME (`NotAllowedError`, …) AntMedia-style, on `publish()` and `RoomEvent.MediaDevicesError` |
| 7 | `getDisplayMedia` absent on iOS/iPadOS → screen-share buttons throw | iOS/iPadOS (all browsers) | throws `DeviceUnsupportedError` | **Applied** — Meeting hides the toggle (`supportsScreenShare()`); adaptor fails fast with a clear message |
| 8 | Ghost streams / camera held after tab close (`unload` never fires on iOS, bfcache) | Safari/iOS | Room disconnects on pagehide — **but only published tracks** | **Applied** — Broadcast publisher stops the standalone preview/mic tracks on `pagehide` |
| 9 | Device labels empty before permission; hot-plug not reflected | Safari (strictest) | `switchActiveDevice` helpers | **Applied** — publisher re-enumerates after grant (already did) + now listens to `devicechange` |
| 10 | Black/frozen video after phone call, backgrounding, camera switch | iOS | partial (attach workarounds) | **Documented** — recovery is re-attach/republish; not automated (risky), see “Known gaps” |
| 11 | `setSinkId` (speaker picker) unsupported | Safari | `audiooutput` switch no-ops | **N/A today** — StreamHub exposes no output picker; note kept for future UI |
| 12 | iOS: 2nd `getUserMedia` audio capture silently mutes the 1st | iOS | not abstracted | **Documented** — our flows capture once; plugin authors warned here |

---

## The AntMedia history (what keeps breaking in production)

Twenty recurring bug classes were extracted from AntMedia's SDK source,
GitHub issues and forum; the ones that matter to StreamHub map as follows.

### 1. Autoplay / audio (AntMedia's biggest class)

AntMedia: playback always starts muted (`video.muted=true` just to get
autoplay through), unmute buttons that only work once on iOS WebKit, sound
meters silent because `AudioContext` starts `suspended`, and audio lost after
reconnect (ant-media/Ant-Media-Server#2481, #2903, #2490).

- **LiveKit:** tries audio playback optimistically; when the browser blocks
  it, fires `RoomEvent.AudioPlaybackStatusChanged` and exposes
  `room.canPlaybackAudio` + `room.startAudio()` (must be called inside a
  gesture handler). No UI.
- **StreamHub (applied):**
  - `LivePlayer` and the Meeting stage render `StartMediaButton`
    (@livekit/components-react) — visible ONLY while playback is blocked;
    one tap resumes audio *and* video. It replaces the audio-only
    `StartAudio` in `LivePlayer`.
  - The adaptor wires `AudioPlaybackStatusChanged` →
    `audioPlaybackStatusChanged { canPlayback }` (StreamHub extension event)
    and, while blocked, arms a **one-shot first-gesture unlock**
    (`installAutoplayUnlock` → `room.startAudio()`), so AntMedia-style apps
    get sound on the first tap with zero code changes. Manual hook:
    `adaptor.startAudioPlayback()`.

### 2. ICE failures / TURN (the "works on my WiFi" class)

AntMedia: “ICE failed, add a TURN server”, publish timeouts with zero ICE
candidates, minutes-long reconnects after a WiFi drop (#869, #2517, #4071).
Safari is the strictest engine behind symmetric NAT / enterprise firewalls;
UDP-blocked networks need **TURN over TLS (5349, ideally 443)**.

- **LiveKit:** the client just consumes the ICE servers the server hands it;
  reconnection is automatic. TURN is **server-side configuration**.
- **StreamHub:**
  - **Setup (installer-driven):** install / re-run the **origin** with `--turn`
    (nginx shape only). The installer picks `turn.<domain>` (override with
    `--turn-domain <fqdn>`), obtains a dedicated Let's Encrypt cert for it,
    opens `5349/tcp` + `3478/udp`, and — **once the cert is on disk** — flips
    `STREAMHUB_TURN_ENABLE=true` and recreates livekit. The compose
    `LIVEKIT_CONFIG` `turn:` block is driven by those seams
    (`STREAMHUB_TURN_ENABLE` / `_DOMAIN` / `_CERT_DIR`), so the effective config
    ends up as:

    ```yaml
    turn:
      enabled: true
      domain: turn.<your-domain>   # own DNS A record → this host; own TLS cert
      tls_port: 5349               # LiveKit terminates TLS itself (not behind the proxy)
      udp_port: 3478
      cert_file: /etc/letsencrypt/live/turn.<your-domain>/fullchain.pem
      key_file:  /etc/letsencrypt/live/turn.<your-domain>/privkey.pem
    ```

    LiveKit reads the certbot PEMs live from a read-only `/etc/letsencrypt`
    mount (`certbot.timer` renews them in place). **Prerequisites:** a DNS A
    record for `turn.<domain>` → this host, and reachable `:80` for the HTTP-01
    challenge. **v1 limitations:** ORIGIN-only (LiveKit's TURN on the origin
    serves the whole mesh — `--turn` is rejected on joins) and the **nginx shape
    only** (`--proxy caddy` can't expose on-disk PEMs → clear warn + skip; drop
    your own PEMs into `./data/certs/turn` and set `STREAMHUB_TURN_*` by hand to
    force it). The `bare-metal/systemd` shape edits `deploy/livekit.yaml` by
    hand (the block is pre-filled — flip `enabled:true`). Networks that only
    allow outbound 443 still need the relay on 443 (dedicated IP) or an external
    coturn — out of scope for v1. Sanity check: `streamhub doctor` verifies 5349
    is listening + the cert is readable when TURN is enabled. Seam reference:
    [operations/ENV.md](../operations/ENV.md) (TURN relay).
  - **Applied (code):** the adaptor appends a TURN hint to transport-level
    connection failures (`withTurnHint`) so the `callbackError` payload says
    what to fix instead of a bare timeout. Auth/token errors are NOT
    decorated. The SPA players already surface connection failures (the
    `connectionProblem` banner in `LivePlayer` via `LiveKitRoom onError`,
    `ConnectionPill` states, and the `poorConnection` amber banner from
    `connectionQualityChanged`).

### 3. playsinline / fullscreen hijack / black first frame

AntMedia: video elements need `playsinline autoplay muted` or iOS forces
native fullscreen (or renders black).

- **LiveKit:** handled for elements it attaches (see baseline). NOT handled
  for elements the app renders itself.
- **StreamHub (applied):** `HlsPlayer` + `VodPlayer` (video.js — outside
  LiveKit entirely) now pass `playsinline: true` and stamp the legacy
  `webkit-playsinline`; the Broadcast/streaming-plugin previews spread
  `LEGACY_INLINE_VIDEO_ATTRS` on top of React's `playsInline muted`; the
  adaptor stamps `playsinline` + `webkit-playsinline` on the app-provided
  `localVideoElement` (muted, echo-safe) and `remoteVideoElement` (audible)
  at construction and before every preview attach.

### 4. Codec: H.264 vs VP8 (AntMedia `notSetRemoteDescription`)

AntMedia's own comment: codec incompatibility when “some browsers try to
open it from VP8” — AntMedia is H.264-first, and Apple hardware
encodes/decodes H.264 in silicon (VP8 is software: hotter, ~1 h less
battery, worse quality per watt; ancient iOS is H.264-only).
StreamHub-specific bonus: HLS/MP4 egress wants H.264 anyway.

- **LiveKit:** negotiates whatever both ends support, but
  `publishDefaults.videoCodec` defaults to **vp8**. `backupCodec` exists for
  vp9/av1 publishers.
- **StreamHub (applied):** publish default switched to **`h264`** in all
  three publish paths: the adaptor (`videoCodec` config option, default
  `h264`), `usePublisher` (Broadcast/Studio + streaming/radio plugins), and
  the Meeting room (`ROOM_OPTIONS`). Every current browser decodes H.264;
  simulcast keeps working (H.264 simulcast is supported in Safari). Override
  with `videoCodec: 'vp8'` if a deployment ever needs it.

### 5. getUserMedia error surfacing + device quirks

AntMedia apps switch on the DOMException name (`"NotAllowedError"`,
`"NotFoundError"`, `"NotReadableError"`, `"OverconstrainedError"`…) in
`callbackError`. Safari adds: labels/deviceIds empty until the first grant,
deviceIds rotating between sessions, and (iOS) a second audio capture
silently muting the first.

- **LiveKit:** throws the raw DOMExceptions; fires
  `RoomEvent.MediaDevicesError`; `switchActiveDevice()` handles switching.
- **StreamHub (applied):**
  - Adaptor `publish()` classifies acquisition failures
    (`classifyGetUserMediaError`) and emits the NAME as the error code —
    AntMedia parity; everything else remains `publishError`.
    `RoomEvent.MediaDevicesError` is routed the same way (fallback code
    `mediaDevicesError`).
  - `usePublisher` already re-enumerated after the permission grant (the
    Safari labels quirk); it now also listens to
    `mediaDevices.devicechange` (guarded — older WebKit lacks it) so
    hot-plugging a camera/mic updates the pickers.
  - Capture-once discipline (the iOS single-audio-capture rule) is already
    how our flows behave; plugin authors: never open a second concurrent
    audio `getUserMedia` on iOS — reuse/clone the existing track.

### 6. Screen share

AntMedia ships `checkBrowserScreenShareSupported()` because
`getDisplayMedia` **does not exist on iOS/iPadOS at all** (any browser) and
desktop Safari is limited.

- **LiveKit:** `setScreenShareEnabled(true)` throws
  `DeviceUnsupportedError('getDisplayMedia not supported')`.
- **StreamHub (applied):** `supportsScreenShare()` in both the web lib and
  the adaptor. The Meeting UI (and the legacy `MeetingControls`) hides the
  share toggle when unsupported; the adaptor's `switchDesktopCapture()`
  fails fast with a clear `screenShareError` (“iOS/iPadOS Safari cannot
  capture the screen”) without calling LiveKit. User-denied shares keep the
  existing `screenShareError` path.

### 7. Lifecycle: tab close, bfcache, ghost streams

AntMedia: streams stuck `broadcasting` after unclean tab close — can't
republish the same id (#1497). On iOS `unload`/`beforeunload` are unreliable;
`pagehide` is the only dependable signal.

- **LiveKit:** a connected `Room` already disconnects on
  `pagehide`/`beforeunload` (`disconnectOnPageLeave`), and the server times
  out ghost participants. **Gap:** standalone local tracks that were never
  published (our Studio camera preview) belong to no Room — nothing stops
  them, and iOS keeps the camera locked in bfcache.
- **StreamHub (applied):** `usePublisher` registers a `pagehide` handler
  that stops the preview + mic tracks. `visibilitychange` was deliberately
  NOT used to tear down — switching tabs must not kill a live broadcast.

### 8. Everything LiveKit absorbs (no action needed — verified)

- Safari-15 black-video-until-resize and the Safari low-power autoplay
  overlay (attach workarounds), Firefox attach timing.
- Unified-plan (AntMedia class #7), SDP munging, `setParameters` gating —
  livekit-client is unified-plan-only and manages senders itself.
- Reconnection/ICE-restart with `Reconnecting`/`Reconnected` events —
  surfaced in the UI via `ConnectionPill` and the quality banner; do NOT
  hand-roll reconnect loops (AntMedia classes #17–19).
- Android camera-switch stop-first quirks, facingMode vs deviceId conflicts
  (`switchActiveDevice`, `videoCaptureOptions` mapping).
- Adaptive stream / dynacast (both default ON in the adaptor).

## Known gaps (documented, intentionally not automated)

1. **Black/frozen video after an iOS phone call or long backgrounding**
   (WebKit bugs 237878 & friends; AntMedia #3507). Recovery = re-attach or
   restart the track. Automating this (watching `visibilitychange` +
   restarting publications) risks fighting LiveKit's own interruption
   handling — revisit if reported in the field. Workaround: leave/rejoin.
2. **bfcache restore:** after iOS restores a page from bfcache the room was
   already disconnected (correctly). Apps must treat `pageshow` with
   `persisted=true` as "reconnect needed". The dashboard SPA effectively
   re-mints/reconnects on navigation, so exposure is the embedded players —
   a viewer taps back → the self-hiding retry/error UI covers it.
3. **`setSinkId` / speaker selection** is unsupported in Safari. StreamHub
   currently ships no audio-output picker; if one is added, hide it behind
   `'setSinkId' in HTMLMediaElement.prototype`.
4. **HLS on iOS Safari:** no MSE on older iOS — video.js falls back to
   native HLS there (VHS `overrideNative` only applies where MSE exists).
   Native HLS ignores some VHS niceties; acceptable for the 6–15 s pipeline.

## What was changed (files)

**streamhub-web** (all covered by `npm test` — 265 green — and `npm run build`):

- `src/lib/browserCompat.ts` (+ `browserCompat.spec.ts`, 8 tests) — pure
  helpers: `isIOS`/`isSafari`/`isWebKit`, `supportsScreenShare`,
  `applyInlinePlayback`, `LEGACY_INLINE_VIDEO_ATTRS`,
  `isAutoplayBlockedError`.
- `src/components/player/HlsPlayer.tsx` — `playsinline`, legacy attr, new
  `blocked` status + tap-to-play overlay (autoplay rejection is not an
  error), `loadeddata` no longer masks a blocked state.
- `src/components/player/VodPlayer.tsx` — `playsinline` + legacy attr
  (video.js big-play button remains the tap-to-play for unmuted VOD).
- `src/components/player/LivePlayer.tsx` — `StartAudio` → `StartMediaButton`
  (covers blocked video too), label `controls.tapToPlay` (es/en).
- `src/pages/Meeting.tsx` + `src/pages/Meeting/MeetingControls.tsx` —
  screen-share toggle hidden when unsupported; `ROOM_OPTIONS` publish
  default h264; self-hiding `StartMediaButton` on the stage.
- `src/pages/Broadcast/usePublisher.ts` — `pagehide` stops preview/mic;
  `devicechange` refresh; publish default h264.
- `src/pages/Broadcast.tsx`, `src/plugins/streaming/index.tsx` — legacy
  inline attrs on the preview `<video>`.

**streamhub-adaptor** (110 tests green — was 92 — + `typecheck` + `build`):

- `src/browserCompat.ts` (new) — the helpers above plus
  `classifyGetUserMediaError`, `withTurnHint`/`TURN_HINT`,
  `installAutoplayUnlock`, `applyInlinePlaybackAttributes` (all exported
  from the package for app use).
- `src/StreamHubAdaptor.ts` — h264 publish default (`videoCodec` option);
  inline attrs on local/remote video elements; gUM error names on
  `publish()` + `MediaDevicesError`; screen-share fail-fast guard;
  `audioPlaybackStatusChanged` + one-shot gesture unlock +
  `startAudioPlayback()`; TURN hint on connect failures.
- `src/types.ts` (`videoCodec`), `src/index.ts` (helper exports),
  `test/browser-compat.spec.ts` (new, 18 tests), `test/fake-livekit.ts`
  (canPlaybackAudio/startAudio/failCamera/failConnect + 2 events).

**Config/docs:** `deploy/livekit.yaml` + `docker-compose.yml` TURN blocks (now
seam-driven: `STREAMHUB_TURN_ENABLE` / `_DOMAIN` / `_CERT_DIR`), `install.sh`
`--turn` / `--turn-domain` (cert issue + ufw + enable-after-cert),
`deploy/streamhub doctor` (5349 + cert check), `streamhub-adaptor/README.md`
(option + Safari section), `streamhub-docs/testing/UNIT-TESTS.md` (new suites),
this file.

## Sources

- AntMedia: `ant-media/StreamApp` (`webrtc_adaptor.js`, `media_manager.js`);
  Ant-Media-Server issues #869, #1253, #1497, #1575, #2481, #2490, #2517,
  #2903, #3507, #4025, #4071, #4773.
- WebKit/Safari: webkit.org/blog/8672 (VP8/H.264), WebKit bugs 176843,
  186294, 231105, 237878, 247310; webrtchacks.com “Guide to WebRTC with
  Safari” + autoplay-restrictions articles; web.dev/bfcache.
- LiveKit: `livekit-client@2.15.7` source (`Track.ts#attachToElement`,
  `Room.ts#onPageLeave/startAudio/canPlaybackAudio`,
  `defaults.ts#videoCodec='vp8'`); docs.livekit.io (tracks/subscribe,
  connect, TrackPublishDefaults); `@livekit/components-react`
  `StartMediaButton`.
