/**
 * Safari/iOS browser-compat layer: the pure helpers in src/browserCompat.ts
 * and their wiring inside StreamHubAdaptor (codec default, getUserMedia error
 * names, screen-share guard, autoplay unlock, inline-playback attributes,
 * TURN hint on transport failures).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StreamHubAdaptor,
  roomOf,
  flush,
  collector,
  baseConfig,
  lk,
} from "./harness.ts";

const compat: any = await import("../src/browserCompat.ts");
const {
  isIOS,
  isSafari,
  isWebKit,
  supportsScreenShare,
  applyInlinePlaybackAttributes,
  classifyGetUserMediaError,
  installAutoplayUnlock,
  withTurnHint,
  TURN_HINT,
} = compat;

// --- UA fixtures -------------------------------------------------------------

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
};

// --- pure helpers ------------------------------------------------------------

test("isIOS / isSafari / isWebKit UA matrix (incl. iPadOS desktop-mode)", () => {
  assert.equal(isIOS({ userAgent: UA.iphoneSafari }), true);
  assert.equal(isIOS({ userAgent: UA.iosChrome }), true);
  assert.equal(isIOS({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 }), true);
  assert.equal(isIOS({ userAgent: UA.macSafari, maxTouchPoints: 0 }), false);
  assert.equal(isIOS({ userAgent: UA.androidChrome }), false);
  assert.equal(isIOS(undefined), false);

  assert.equal(isSafari({ userAgent: UA.macSafari }), true);
  assert.equal(isSafari({ userAgent: UA.iphoneSafari }), true);
  assert.equal(isSafari({ userAgent: UA.macChrome }), false);
  assert.equal(isSafari({ userAgent: UA.iosChrome }), false);
  assert.equal(isSafari({ userAgent: UA.androidChrome }), false);
  assert.equal(isSafari({ userAgent: UA.linuxFirefox }), false);

  // Every iOS browser is WebKit; Safari is WebKit everywhere.
  assert.equal(isWebKit({ userAgent: UA.iosChrome }), true);
  assert.equal(isWebKit({ userAgent: UA.macSafari }), true);
  assert.equal(isWebKit({ userAgent: UA.macChrome }), false);
  assert.equal(isWebKit({ userAgent: UA.linuxFirefox }), false);
});

test("supportsScreenShare: strictly requires a getDisplayMedia function", () => {
  assert.equal(
    supportsScreenShare({ mediaDevices: { getDisplayMedia: () => {} } }),
    true,
  );
  // iOS Safari shape: mediaDevices exists, getDisplayMedia absent.
  assert.equal(supportsScreenShare({ mediaDevices: {} }), false);
  assert.equal(supportsScreenShare({ mediaDevices: null }), false);
  assert.equal(supportsScreenShare({}), false);
  assert.equal(supportsScreenShare(null), false);
});

test("applyInlinePlaybackAttributes: playsinline + webkit-playsinline (+muted)", () => {
  const calls: Array<[string, string]> = [];
  const el: any = { setAttribute: (n: string, v: string) => calls.push([n, v]) };
  applyInlinePlaybackAttributes(el);
  assert.deepEqual(calls, [
    ["playsinline", ""],
    ["webkit-playsinline", ""],
  ]);
  assert.equal(el.muted, undefined); // remote elements stay audible

  calls.length = 0;
  applyInlinePlaybackAttributes(el, { muted: true });
  assert.deepEqual(calls, [
    ["playsinline", ""],
    ["webkit-playsinline", ""],
    ["muted", ""],
  ]);
  assert.equal(el.muted, true);
});

test("applyInlinePlaybackAttributes tolerates null and non-DOM stand-ins", () => {
  assert.doesNotThrow(() => applyInlinePlaybackAttributes(null));
  assert.doesNotThrow(() => applyInlinePlaybackAttributes(undefined));
  // Plain object without setAttribute (the test doubles apps pass around):
  const bare: any = {};
  assert.doesNotThrow(() => applyInlinePlaybackAttributes(bare, { muted: true }));
  assert.equal(bare.muted, true); // property still set for livekit attach parity
});

test("classifyGetUserMediaError: DOMException names pass through, rest null", () => {
  for (const name of [
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "OverconstrainedError",
    "AbortError",
    "SecurityError",
  ]) {
    assert.equal(classifyGetUserMediaError({ name }), name);
  }
  assert.equal(classifyGetUserMediaError(new Error("boom")), null); // name: "Error"
  assert.equal(classifyGetUserMediaError({ name: "TypeError" }), null); // not gUM-specific
  assert.equal(classifyGetUserMediaError(undefined), null);
  assert.equal(classifyGetUserMediaError("NotAllowedError"), null); // must be err.name
});

test("withTurnHint: transport failures get the TURN hint, others untouched", () => {
  const iceMsg = "could not establish pc connection";
  assert.equal(withTurnHint(iceMsg), `${iceMsg} — ${TURN_HINT}`);
  assert.match(withTurnHint("connection timed out"), /TURN/);
  assert.match(withTurnHint("ICE failed after 15s"), /TURN/);
  assert.match(withTurnHint("websocket closed unexpectedly"), /TURN/);
  // Auth / app errors must NOT get network advice.
  assert.equal(withTurnHint("token mint failed (401)"), "token mint failed (401)");
  assert.equal(withTurnHint("permission denied"), "permission denied");
});

test("installAutoplayUnlock: fires once on the first gesture, disposer works", () => {
  const target = new EventTarget() as any;
  let fired = 0;
  installAutoplayUnlock(() => fired++, target);
  target.dispatchEvent(new Event("pointerdown"));
  target.dispatchEvent(new Event("touchend")); // must be a no-op (one-shot)
  target.dispatchEvent(new Event("keydown"));
  assert.equal(fired, 1);

  // Disposal before any gesture -> callback never runs.
  let fired2 = 0;
  const dispose = installAutoplayUnlock(() => fired2++, target);
  dispose();
  target.dispatchEvent(new Event("pointerdown"));
  assert.equal(fired2, 0);

  // No document / no target (SSR, node) -> inert disposer, no throw.
  assert.doesNotThrow(() => installAutoplayUnlock(() => {})());
});

// --- adaptor wiring ----------------------------------------------------------

test("RoomOptions: videoCodec defaults to h264 (Safari/egress interop)", () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  assert.equal(roomOf(a).ctorOptions.publishDefaults.videoCodec, "h264");
});

test("RoomOptions: videoCodec is overridable via config", () => {
  const { cfg } = baseConfig({ videoCodec: "vp8" });
  const a = new StreamHubAdaptor(cfg);
  assert.equal(roomOf(a).ctorOptions.publishDefaults.videoCodec, "vp8");
});

test("constructor applies inline-playback attrs: local muted, remote audible", () => {
  const mk = () => {
    const calls: Array<[string, string]> = [];
    return {
      calls,
      el: { setAttribute: (n: string, v: string) => calls.push([n, v]) } as any,
    };
  };
  const local = mk();
  const remote = mk();
  const { cfg } = baseConfig({
    localVideoElement: local.el,
    remoteVideoElement: remote.el,
  });
  new StreamHubAdaptor(cfg);
  assert.deepEqual(local.calls, [
    ["playsinline", ""],
    ["webkit-playsinline", ""],
    ["muted", ""],
  ]);
  assert.equal(local.el.muted, true);
  assert.deepEqual(remote.calls, [
    ["playsinline", ""],
    ["webkit-playsinline", ""],
  ]);
  assert.equal(remote.el.muted, undefined);
});

test("publish(): camera permission denial surfaces AntMedia-style 'NotAllowedError'", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).localParticipant.failCamera = Object.assign(
    new Error("Permission denied by user"),
    { name: "NotAllowedError" },
  );
  await a.publish("s1");
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].error, "NotAllowedError");
  assert.match(String(c.errors[0].message), /Permission denied/);
  assert.equal(c.count("publish_started"), 0);
});

test("publish(): non-gUM failures keep the generic 'publishError' code", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).localParticipant.failCamera = new Error("weird internal failure");
  await a.publish("s1");
  assert.equal(c.errors[0].error, "publishError");
});

test("RoomEvent.MediaDevicesError routes the DOMException name to callbackError", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).fire(
    lk.RoomEvent.MediaDevicesError,
    Object.assign(new Error("device lost"), { name: "NotReadableError" }),
  );
  assert.equal(c.errors[0].error, "NotReadableError");
  // Unknown names fall back to the generic code.
  roomOf(a).fire(lk.RoomEvent.MediaDevicesError, new Error("???"));
  assert.equal(c.errors[1].error, "mediaDevicesError");
});

test("switchDesktopCapture: browser without getDisplayMedia fails fast + clear", async () => {
  // Simulate a browser context: `window` exists but (like iOS Safari and this
  // node process) navigator.mediaDevices.getDisplayMedia does not.
  (globalThis as any).window = {};
  try {
    const { cfg, c } = baseConfig();
    const a = new StreamHubAdaptor(cfg);
    await a.publish("s1");
    await a.switchDesktopCapture("s1");
    assert.equal(c.errors.length, 1);
    assert.equal(c.errors[0].error, "screenShareError");
    assert.match(String(c.errors[0].message), /not supported/i);
    assert.match(String(c.errors[0].message), /iOS/);
    // The LiveKit call must never have been attempted.
    assert.deepEqual(roomOf(a).localParticipant.calls.setScreenShareEnabled, []);
    assert.equal(c.count("screen_share_started"), 0);
  } finally {
    delete (globalThis as any).window;
  }
});

test("audio blocked -> audioPlaybackStatusChanged + one-gesture auto-unlock", async () => {
  // Provide a `document` for the gesture listener (node's EventTarget).
  (globalThis as any).document = new EventTarget();
  try {
    const { cfg, c } = baseConfig();
    const a = new StreamHubAdaptor(cfg);
    const room = roomOf(a);

    // Safari blocks playback: LiveKit flips canPlaybackAudio + fires the event.
    room.canPlaybackAudio = false;
    room.fire(lk.RoomEvent.AudioPlaybackStatusChanged);
    assert.deepEqual(c.last("audioPlaybackStatusChanged"), { canPlayback: false });

    // First user gesture anywhere -> room.startAudio() (the unlock).
    (globalThis as any).document.dispatchEvent(new Event("pointerdown"));
    await flush();
    assert.equal(room.calls.startAudio, 1);

    // LiveKit then reports playback restored.
    room.fire(lk.RoomEvent.AudioPlaybackStatusChanged);
    assert.deepEqual(c.last("audioPlaybackStatusChanged"), { canPlayback: true });

    // Further gestures must not re-trigger (one-shot).
    (globalThis as any).document.dispatchEvent(new Event("pointerdown"));
    await flush();
    assert.equal(room.calls.startAudio, 1);
  } finally {
    delete (globalThis as any).document;
  }
});

test("startAudioPlayback(): manual unlock calls Room.startAudio, never throws", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.startAudioPlayback();
  assert.equal(roomOf(a).calls.startAudio, 1);
  // Rejection (no gesture yet) is swallowed — AntMedia apps don't expect throws.
  roomOf(a).startAudio = async () => {
    throw new Error("user gesture required");
  };
  await assert.doesNotReject(a.startAudioPlayback());
});

test("connect failure carries the TURN hint into the joinRoom error", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).failConnect = new Error("could not establish pc connection");
  await a.joinRoom("room1", "s1");
  assert.equal(c.errors[0].error, "joinRoomError");
  assert.match(String(c.errors[0].message), /TURN/);
  assert.match(String(c.errors[0].message), /livekit\.yaml/);
});

test("non-transport connect failures do NOT get network advice", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).failConnect = new Error("invalid token");
  await a.joinRoom("room1", "s1");
  assert.equal(c.errors[0].error, "joinRoomError");
  assert.doesNotMatch(String(c.errors[0].message), /TURN/);
});
