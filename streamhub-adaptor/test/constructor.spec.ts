/**
 * Constructor + config surface: the AntMedia ctor contract, the LiveKit
 * RoomOptions the adaptor derives (adaptiveStream / dynacast / simulcast /
 * bandwidth), and the direct-property compat apps poke.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StreamHubAdaptor,
  WebRTCAdaptor,
  AdaptorDefault,
  roomOf,
  flush,
  collector,
  baseConfig,
} from "./harness.ts";

test("emits `initialized` exactly once, on the next tick (not synchronously)", async () => {
  const c = collector();
  new StreamHubAdaptor({ token: "t", wsUrl: "wss://x", callback: c.callback });
  // Not synchronous — AntMedia apps schedule joinRoom/publish inside the cb.
  assert.equal(c.count("initialized"), 0);
  await flush();
  assert.equal(c.count("initialized"), 1);
});

test("WebRTCAdaptor alias + default export are the StreamHubAdaptor class", () => {
  assert.equal(WebRTCAdaptor, StreamHubAdaptor);
  assert.equal(AdaptorDefault, StreamHubAdaptor);
});

test("static pluginInitMethods exists and is an (empty) array no-op", () => {
  assert.ok(Array.isArray(StreamHubAdaptor.pluginInitMethods));
});

test("RoomOptions default: adaptiveStream + dynacast ON, simulcast ON", () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const opts = roomOf(a).ctorOptions;
  assert.equal(opts.adaptiveStream, true);
  assert.equal(opts.dynacast, true);
  assert.equal(opts.publishDefaults.simulcast, true);
  // No bandwidth => no forced encoding cap.
  assert.equal(opts.publishDefaults.videoEncoding, undefined);
});

test("RoomOptions: adaptiveStream / dynacast can be forced off", () => {
  const { cfg } = baseConfig({ adaptiveStream: false, dynacast: false });
  const a = new StreamHubAdaptor(cfg);
  const opts = roomOf(a).ctorOptions;
  assert.equal(opts.adaptiveStream, false);
  assert.equal(opts.dynacast, false);
});

test("bandwidth (kbps) maps to videoEncoding.maxBitrate (bps)", () => {
  const { cfg } = baseConfig({ bandwidth: 900 });
  const a = new StreamHubAdaptor(cfg);
  const opts = roomOf(a).ctorOptions;
  assert.equal(opts.publishDefaults.videoEncoding.maxBitrate, 900_000);
  // mediaManager.bandwidth mirrors it (apps read webRTCAdaptor.mediaManager.bandwidth).
  assert.equal(a.mediaManager.bandwidth, 900);
});

test("mediaManager.bandwidth defaults to 900 when unset", () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  assert.equal(a.mediaManager.bandwidth, 900);
  assert.equal(typeof a.mediaManager.getDevices, "function");
});

test("mediaConstraints defaults to { video:true, audio:true }", () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  assert.deepEqual(a.mediaConstraints, { video: true, audio: true });
});

test("mediaConstraints passthrough is preserved verbatim", () => {
  const mc = { video: { width: { ideal: 1280 } }, audio: false };
  const { cfg } = baseConfig({ mediaConstraints: mc });
  const a = new StreamHubAdaptor(cfg);
  assert.deepEqual(a.mediaConstraints, mc);
});

test("isPlayMode honored; playOnly is accepted as an alias", () => {
  const p1 = new StreamHubAdaptor({ token: "t", wsUrl: "w", isPlayMode: true });
  assert.equal(p1.isPlayMode, true);
  const p2 = new StreamHubAdaptor({ token: "t", wsUrl: "w", playOnly: true });
  assert.equal(p2.isPlayMode, true);
  const p3 = new StreamHubAdaptor({ token: "t", wsUrl: "w" });
  assert.equal(p3.isPlayMode, false);
});

test("callback_error (snake_case) is accepted as an alias for callbackError", async () => {
  const seen: any[] = [];
  const a = new StreamHubAdaptor({
    // no token/url + publish => resolveToken throws => error path fires
    callback_error: (err: string, msg: any) => seen.push([err, msg]),
  });
  await a.publish("s1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "publishError");
});

test("localVideoElement is stored for later preview attach", () => {
  const el = { _fake: "video" } as any;
  const { cfg } = baseConfig({ localVideoElement: el });
  const a = new StreamHubAdaptor(cfg);
  assert.equal(a.localVideoElement, el);
});

test("a thrown user callback never escapes the adaptor", async () => {
  const a = new StreamHubAdaptor({
    token: "t",
    wsUrl: "w",
    callback: () => {
      throw new Error("boom in app code");
    },
  });
  // initialized fires on next tick through emit(); must be swallowed.
  await assert.doesNotReject(flush());
  assert.ok(a);
});

test("accepts-but-ignores AntMedia no-op config fields without throwing", () => {
  const a = new StreamHubAdaptor({
    token: "t",
    wsUrl: "w",
    peerconnection_config: { iceServers: [] },
    sdp_constraints: { offerToReceiveAudio: true },
    pluginInitMethods: [() => {}],
  } as any);
  assert.ok(a);
});
