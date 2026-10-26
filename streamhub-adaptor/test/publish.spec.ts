/**
 * publish() — the streambuy / live-shopping single-publish path and its
 * AntMedia contract: connect with the minted grant, enable camera+mic with the
 * derived LiveKit capture options, fire `publish_started` once, open the data
 * channel once, and expose the `remotePeerConnection[id]` sender shim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHubAdaptor, roomOf, flush, collector, baseConfig } from "./harness.ts";

test("publish() connects with pre-minted token + autoSubscribe and enables cam/mic", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("stream-1");
  const room = roomOf(a);

  assert.equal(room.calls.connect.length, 1);
  assert.equal(room.calls.connect[0].wsUrl, "wss://media.test");
  assert.equal(room.calls.connect[0].token, "jwt-token");
  assert.deepEqual(room.calls.connect[0].opts, { autoSubscribe: true });

  assert.equal(room.localParticipant.calls.setCameraEnabled.length, 1);
  assert.equal(room.localParticipant.calls.setCameraEnabled[0].enabled, true);
  assert.deepEqual(room.localParticipant.calls.setMicrophoneEnabled, [true]);

  assert.equal(c.count("publish_started"), 1);
  assert.deepEqual(c.first("publish_started"), { streamId: "stream-1" });
});

test("publish() maps mediaConstraints -> LiveKit capture options (resolution/deviceId/facingMode)", async () => {
  const { cfg } = baseConfig({
    mediaConstraints: {
      video: {
        deviceId: { exact: "cam-9" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
      audio: true,
    },
  });
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const opts = roomOf(a).localParticipant.calls.setCameraEnabled[0].opts;
  assert.equal(opts.deviceId, "cam-9");
  assert.deepEqual(opts.resolution, { width: 1280, height: 720 });
  assert.equal(opts.facingMode, "user");
});

test("publish() with mediaConstraints.video=false is audio-only (no camera enable)", async () => {
  const { cfg, c } = baseConfig({ mediaConstraints: { video: false, audio: true } });
  const a = new StreamHubAdaptor(cfg);
  await a.publish("audio-stream");
  const lp = roomOf(a).localParticipant;
  assert.equal(lp.calls.setCameraEnabled.length, 0);
  assert.deepEqual(lp.calls.setMicrophoneEnabled, [true]);
  assert.equal(c.count("publish_started"), 1);
});

test("publish() with audio=false publishes video only", async () => {
  const { cfg } = baseConfig({ mediaConstraints: { video: true, audio: false } });
  const a = new StreamHubAdaptor(cfg);
  await a.publish("video-stream");
  const lp = roomOf(a).localParticipant;
  assert.equal(lp.calls.setCameraEnabled.length, 1);
  assert.equal(lp.calls.setMicrophoneEnabled.length, 0);
});

test("double publish(): connects once, emits publish_started once", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.publish("s1");
  assert.equal(roomOf(a).calls.connect.length, 1);
  assert.equal(c.count("publish_started"), 1);
});

test("publish before any token config -> callbackError('publishError'), no throw", async () => {
  const c = collector();
  const a = new StreamHubAdaptor({ callback: c.callback, callbackError: c.callbackError });
  await assert.doesNotReject(a.publish("s1"));
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].error, "publishError");
  assert.equal(c.count("publish_started"), 0);
});

test("RoomEvent.LocalTrackPublished also drives publish_started (idempotent w/ direct emit)", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  // Simulate media enabled *before* publish() runs its own guard: fire the event.
  room.fire("localTrackPublished", { kind: "video" });
  assert.equal(c.count("publish_started"), 1);
  // publish() then must not double-fire.
  await a.publish("s1");
  assert.equal(c.count("publish_started"), 1);
});

test("data_channel_opened fires exactly once even across multiple LocalTrackPublished", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.fire("localTrackPublished", { kind: "video" });
  room.fire("localTrackPublished", { kind: "audio" });
  assert.equal(c.count("data_channel_opened"), 1);
});

test("data_channel_opened suppressed when dataChannelEnabled:false", async () => {
  const { cfg, c } = baseConfig({ dataChannelEnabled: false });
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).fire("localTrackPublished", { kind: "video" });
  assert.equal(c.count("data_channel_opened"), 0);
});

test("remotePeerConnection[id] sender shim exposes getSenders()/replaceTrack for bitrate+device switching", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("pub-1");
  const pc = a.remotePeerConnection["pub-1"];
  assert.ok(pc, "shim registered under the stream id");
  const senders = pc.getSenders();
  assert.ok(senders.length >= 1);
  const videoSender = senders.find((s: any) => s.track?.kind === "video");
  assert.ok(videoSender, "camera track sender is reachable (streambuy mobile-streamer path)");
  // getParameters/setParameters/replaceTrack must be callable.
  assert.ok(videoSender.getParameters().encodings);
  const newTrack = { kind: "video", id: "replacement" };
  await videoSender.replaceTrack(newTrack);
  assert.equal(videoSender.replaced, newTrack);
  assert.deepEqual(pc.getReceivers(), []);
});

test("publish() attaches the local camera track to localVideoElement (preview)", async () => {
  const el: any = {};
  const { cfg } = baseConfig({ localVideoElement: el });
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const camPub = roomOf(a).localParticipant.getTrackPublication("camera");
  assert.ok(camPub);
  assert.deepEqual(camPub!.track.attached, [el]);
});

test("isPlayMode publisher still gets canPublish grant path (defensive publish)", async () => {
  const { cfg } = baseConfig({ isPlayMode: true });
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  // Even in play mode, publish() force-enables camera (explicit publisher intent).
  assert.equal(roomOf(a).localParticipant.calls.setCameraEnabled.length, 1);
});
