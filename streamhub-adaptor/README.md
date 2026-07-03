# @streamhub/adaptor

A **drop-in replacement** for AntMedia's `@antmedia/webrtc_adaptor`
(`WebRTCAdaptor`) that talks to a **StreamHub** media server (LiveKit) under the
hood via [`livekit-client`](https://www.npmjs.com/package/livekit-client).

The goal: apps that today use the AntMedia SDK migrate by **changing (almost)
only the import / `<script src>`**. The public surface — constructor options,
methods, and the **string-based callbacks** (`"initialized"`,
`"publish_started"`, `"newStreamAvailable"`, ...) — is emulated.

```ts
// before
import { WebRTCAdaptor } from "@antmedia/webrtc_adaptor";
// after
import { WebRTCAdaptor } from "@streamhub/adaptor";
```

`WebRTCAdaptor` is an **alias** of `StreamHubAdaptor`, so `new WebRTCAdaptor({...})`
keeps working unchanged.

---

## Install

```bash
npm install @streamhub/adaptor livekit-client
```

`livekit-client` is a **peer dependency** for the ESM/CJS builds (your bundler
provides it). The browser/CDN build bundles it (see below).

## How it gets a token

StreamHub mints LiveKit join tokens at `POST /apps/:app/tokens` →
`{ data: { token, wsUrl, room, identity, playUrl, embedUrl, iframe } }`.

The adaptor resolves credentials in this order:

1. **Pre-minted**: pass `token` + `wsUrl` in the constructor → no network call
   (recommended for production; mint server-side with your StreamHub API token).
2. **Mint client-side**: pass `streamhubTokenUrl` (or `streamhubApiUrl` + `appName`)
   and optionally `streamhubApiToken` (Bearer). The adaptor POSTs the token
   request (room/identity/canPublish/ttl…) for you.
3. **Derive from `websocket_url`**: an AntMedia-style
   `wss://host/<app>/websocket` is parsed to `https://host/api/v1/apps/<app>/tokens`.

---

## Constructor options

| Option | Origin | Notes |
|--------|--------|-------|
| `websocket_url` | AntMedia | `wss://host/<app>/websocket`; the `<app>` segment is used to mint tokens. A bare `wss://media.host` is reused as the LiveKit URL. |
| `mediaConstraints` | AntMedia | `{ video, audio }` → mapped to LiveKit capture options. |
| `localVideoElement` / `localVideoId` | AntMedia | Local preview `<video>`. |
| `bandwidth` | AntMedia | kbps → LiveKit `videoEncoding.maxBitrate`. |
| `dataChannelEnabled` | AntMedia | default `true`. |
| `isPlayMode` / `playOnly` | AntMedia | subscribe-only (no camera/mic). |
| `callback` | AntMedia | `(info, obj) => void` — string events. |
| `callbackError` / `callback_error` | AntMedia | `(error, message) => void`. |
| `peerconnection_config`, `sdp_constraints`, `pluginInitMethods` | AntMedia | **accepted but ignored** (LiveKit-managed). |
| `streamhubTokenUrl` | StreamHub | full mint endpoint URL. |
| `streamhubApiUrl` + `appName` | StreamHub | base + app → builds the mint URL. |
| `streamhubApiToken` | StreamHub | Bearer for the mint call (client-side minting only). |
| `token` + `wsUrl` | StreamHub | pre-minted LiveKit token (skips mint). |
| `tokenRequest` | StreamHub | extra body for the mint (`ttl`, `metadata`, `hidden`…). |

---

## AntMedia method → StreamHubAdaptor → livekit-client

| AntMedia `WebRTCAdaptor` method | StreamHubAdaptor | livekit-client mapping |
|---|---|---|
| `new WebRTCAdaptor(cfg)` | ✅ same ctor | `new Room(opts)`; emits `initialized` next tick |
| `joinRoom(room, streamId, mode)` | ✅ | `room.connect(wsUrl, token)`; emits `joinedTheRoom` + `roomInformation`. `mode` ignored (always SFU multitrack) |
| `publish(streamId, token, subId, subCode, name, mainTrack, meta)` | ✅ | `localParticipant.setCameraEnabled(true)` + `setMicrophoneEnabled(true)`. `token`/`subId`/`subCode` ignored (LiveKit grant) |
| `play(streamId, token, roomId, tracks, subId, subCode, meta)` | ✅ | auto-subscribe (`autoSubscribe: true`); re-announces tracks; emits `play_started` |
| `leaveFromRoom(room)` | ✅ | `room.disconnect()`; emits `leavedFromRoom` |
| `stop(streamId)` | ✅ | `room.disconnect()`; emits `publish_finished` |
| `sendData(streamId, data)` | ✅ | `localParticipant.publishData(bytes, { reliable: true })` |
| `turnOffLocalCamera(id)` / `turnOnLocalCamera(id)` | ✅ | `localParticipant.setCameraEnabled(false/true)` |
| `muteLocalMic()` / `unmuteLocalMic()` | ✅ | `localParticipant.setMicrophoneEnabled(false/true)` |
| `switchVideoCameraCapture(id, deviceId)` | ✅ | `room.switchActiveDevice('videoinput', deviceId)` (or facingMode flip) |
| `switchAudioInputSource(id, deviceId)` | ✅ | `room.switchActiveDevice('audioinput', deviceId)` |
| `switchDesktopCapture(id)` | ✅ | `localParticipant.setScreenShareEnabled(true)`; emits `screen_share_started` |
| `enableStats(id)` / `disableStats(id)` | ✅ | polls `track.getRTCStatsReport()`; emits `updated_stats` |
| `getRoomInfo(room, id)` | ✅ | reads `room.remoteParticipants`; emits `roomInformation` |
| `getDebugInfo(id)` | ✅ | emits `debugInfo` from room state |
| `applyConstraints(constraints)` | ✅ | `mediaStreamTrack.applyConstraints()` on local video |
| `iceConnectionState(id)` | ✅ | derived from `room.state` |
| `assignVideoTrack(trackId, id, enable)` | ⚠️ best-effort | `RemoteTrackPublication.setEnabled()` |
| `closeWebSocket()` | ✅ | `room.disconnect()` |
| `enableAudioLevelForLocalStream(cb)` | ✅ | polls `localParticipant.audioLevel` |
| `setMaxVideoTrackCount(n)` | 🟡 no-op | LiveKit `adaptiveStream`/`dynacast` handle it |
| `updateAudioLevel()` | 🟡 no-op | native in LiveKit |
| `enableEffect()` / `setBackgroundImage()` | 🟥 no-op (deprecated) | needs `@livekit/track-processors` (not bundled) |

Direct-property compat also provided (apps poke these):

- `webRTCAdaptor.remotePeerConnection[streamId]` → shim with `getSenders()`
  (so `replaceTrack` / `getParameters` / `setParameters` for **device switch &
  bitrate change** keep working — e.g. streambuy's `mobile-streamer`).
- `webRTCAdaptor.mediaManager.bandwidth` and `webRTCAdaptor.mediaManager.getDevices()`.
- `WebRTCAdaptor.pluginInitMethods` (static, no-op).

## Callback (`info`) string → LiveKit `RoomEvent`

| AntMedia `info` string | Emitted from |
|---|---|
| `initialized` | constructor (next tick) |
| `joinedTheRoom` | after `room.connect()` in `joinRoom()` |
| `publish_started` | `RoomEvent.LocalTrackPublished` |
| `publish_finished` | `stop()` |
| `play_started` | `play()` resolved |
| `play_finished` | (on unsubscribe / stop) |
| `newStreamAvailable` | `RoomEvent.TrackSubscribed` |
| `roomInformation` | `ParticipantConnected/Disconnected`, `TrackPublished`, `TrackUnsubscribed` |
| `leavedFromRoom` | `leaveFromRoom()` |
| `data_received` | `RoomEvent.DataReceived` |
| `data_channel_opened` | first `LocalTrackPublished` (when `dataChannelEnabled`) |
| `available_devices` | `RoomEvent.MediaDevicesChanged` / `getDevices()` |
| `updated_stats` | stats poll (`enableStats`) |
| `ice_connection_state_changed` | `RoomEvent.ConnectionStateChanged` |
| `session_restored` | `RoomEvent.Connected` / `Reconnected` |
| `screen_share_started` / `screen_share_stopped` | screen-share toggles |
| `closed` | `RoomEvent.Disconnected` |
| `debugInfo` | `getDebugInfo()` |

### `obj` payload shapes (kept AntMedia-compatible)

- `joinedTheRoom` / `roomInformation`: `{ ATTR_ROOM_NAME, streamId, streams[], streamList[], maxTrackCount }`
- `newStreamAvailable`: `{ streamId, track: MediaStreamTrack, trackId: "ARDAMSx"+id, stream, streamName }`
- `data_received`: `{ streamId, data: string, topic, event }`
- `available_devices`: the raw `MediaDeviceInfo[]` array
- `updated_stats`: `{ videoRoundTripTime, audioRoundTripTime, videoJitter, audioJitter, currentOutgoingBitrate, videoPacketsLost, audioPacketsLost, totalVideoPacketsSent, totalAudioPacketsSent, ... }`

---

## No-op / deprecated (no LiveKit equivalent)

| Feature | Why | Behaviour |
|---|---|---|
| `subscriberCode` (TOTP) on publish/play | LiveKit auth is the minted JWT grant | argument **ignored** |
| `mode` MCU / "legacy"/"mcu" in `joinRoom` | LiveKit is always an SFU; MCU mixing = server-side **egress** (StreamHub recording) | argument **ignored** |
| `enableEffect()` / `setBackgroundImage()` (virtual bg/blur) | needs `@livekit/track-processors` | **no-op** (logs in debug) |
| `setMaxVideoTrackCount()` / `updateAudioLevel()` | handled by `adaptiveStream`/native | **no-op** |
| `pluginInitMethods` | AntMedia plugin system | **static no-op** |

---

## Migration example 1 — 1:1 / conference video call

```diff
- import { WebRTCAdaptor } from "@antmedia/webrtc_adaptor";
+ import { WebRTCAdaptor } from "@streamhub/adaptor";

  const adaptor = new WebRTCAdaptor({
-   websocket_url: "wss://media.example.com/Conference/websocket",
+   // Option A: AntMedia-style URL still works (app parsed → token minted)
+   websocket_url: "wss://media.example.com/Conference/websocket",
+   streamhubApiUrl: "https://streamhub.example.com/api/v1",
+   appName: "Conference",
+   streamhubApiToken: "<server-side mgmt token>",
    mediaConstraints: { video: true, audio: true },
    callback: (info, obj) => {
      if (info === "initialized") {
        adaptor.joinRoom("room1", "user-123", "multitrack");
      } else if (info === "joinedTheRoom") {
        adaptor.publish(obj.streamId);          // publish my camera/mic
        adaptor.play(obj.ATTR_ROOM_NAME);       // subscribe to the room
      } else if (info === "newStreamAvailable") {
        attachToVideoTile(obj.streamId, obj.track);   // obj.track is a MediaStreamTrack
      } else if (info === "roomInformation") {
        renderRoster(obj.streams);              // string[] of remote identities
      }
    },
    callbackError: (err, msg) => console.warn(err, msg),
  });
```

Nothing in the callback `if`-chain changed.

## Migration example 2 — liveshopping publish (streambuy `mobile-streamer`)

The Blade view loads the adaptor from a CDN and reads
`window.webrtc_adaptor.WebRTCAdaptor`. Swap **one `<script src>`**:

```diff
- <script src="https://cdn.jsdelivr.net/npm/@antmedia/webrtc_adaptor@2.16.2/dist/browser/webrtc_adaptor.js"></script>
+ <script src="https://streamhub.example.com/sdk/streamhub-adaptor.global.js"></script>
  <script>window.WebRTCAdaptor = window.webrtc_adaptor?.WebRTCAdaptor;</script>
```

The Alpine component is unchanged:

```js
this.webRTCAdaptor = new WebRTCAdaptor({
  websocket_url: websocketUrl,                  // wss://host/<app>/websocket
  localVideoElement: document.getElementById('localVideo'),
  mediaConstraints: this.getMediaConstraints(),
  bandwidth: this.selectedBitrate.value,
  dataChannelEnabled: false,
  callback: (info) => {
    if (info === 'initialized')      this.webRTCAdaptor.publish(config.streamId);
    else if (info === 'publish_started') { this.isStreaming = true; }
    else if (info === 'publish_finished') { this.isStreaming = false; }
  },
  callbackError: (error) => { if (error === 'noStreamNameSpecified') return; /* ... */ },
});
// later — bitrate / device switching via the peer-connection shim still works:
const pc = this.webRTCAdaptor.remotePeerConnection[config.streamId];
const sender = pc.getSenders().find(s => s.track?.kind === 'video');
sender.replaceTrack(newVideoTrack);
```

> Tip: for production, mint the token server-side and pass `token` + `wsUrl`
> instead of `streamhubApiToken`, so the management token never reaches the browser.

---

## Build

```bash
npm install
npm run build      # → dist/index.js (ESM), index.cjs (CJS), index.d.ts, streamhub-adaptor.global.js (IIFE/CDN)
npm run typecheck
```

Outputs:

- `dist/index.js` / `dist/index.cjs` + `dist/index.d.ts` — library (livekit-client external).
- `dist/streamhub-adaptor.global.js` — browser IIFE, global `webrtc_adaptor`, livekit-client **bundled**.
