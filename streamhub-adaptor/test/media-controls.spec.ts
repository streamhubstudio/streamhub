/**
 * Local-media controls, device switching, screen share, stats and the no-op /
 * deprecated surface — the rest of the AntMedia method table the README maps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHubAdaptor, roomOf, flush, collector, baseConfig } from "./harness.ts";
import { FakeRemoteParticipant, Track } from "./fake-livekit.ts";

test("turnOffLocalCamera / turnOnLocalCamera toggle setCameraEnabled", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const lp = roomOf(a).localParticipant;
  const before = lp.calls.setCameraEnabled.length;
  await a.turnOffLocalCamera("s1");
  await a.turnOnLocalCamera("s1");
  const toggles = lp.calls.setCameraEnabled.slice(before).map((x) => x.enabled);
  assert.deepEqual(toggles, [false, true]);
});

test("muteLocalMic / unmuteLocalMic toggle setMicrophoneEnabled", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const lp = roomOf(a).localParticipant;
  const before = lp.calls.setMicrophoneEnabled.length;
  await a.muteLocalMic();
  await a.unmuteLocalMic();
  assert.deepEqual(lp.calls.setMicrophoneEnabled.slice(before), [false, true]);
});

test("switchVideoCameraCapture(id, deviceId) -> room.switchActiveDevice('videoinput', ...)", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.switchVideoCameraCapture("s1", "cam-2");
  assert.deepEqual(roomOf(a).calls.switchActiveDevice.at(-1), {
    kind: "videoinput",
    deviceId: "cam-2",
  });
});

test("switchVideoCameraCapture without deviceId flips facingMode", async () => {
  const { cfg } = baseConfig({ mediaConstraints: { video: { facingMode: "user" }, audio: true } });
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const lp = roomOf(a).localParticipant;
  await a.switchVideoCameraCapture("s1");
  assert.equal(lp.calls.setCameraEnabled.at(-1)!.opts.facingMode, "environment");
});

test("switchAudioInputSource(id, deviceId) -> room.switchActiveDevice('audioinput', ...)", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.switchAudioInputSource("s1", "mic-2");
  assert.deepEqual(roomOf(a).calls.switchActiveDevice.at(-1), {
    kind: "audioinput",
    deviceId: "mic-2",
  });
});

test("switchDesktopCapture on/off emits screen_share_started/stopped", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.switchDesktopCapture("s1");
  await a.stopDesktopCapture("s1");
  const lp = roomOf(a).localParticipant;
  assert.deepEqual(lp.calls.setScreenShareEnabled, [true, false]);
  assert.equal(c.count("screen_share_started"), 1);
  assert.equal(c.count("screen_share_stopped"), 1);
});

test("switchDesktopCapture denial routes to callbackError('screenShareError')", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  roomOf(a).localParticipant.failScreenShare = true;
  await a.switchDesktopCapture("s1");
  assert.equal(c.errors[0].error, "screenShareError");
});

test("applyConstraints() applies to live local *video* tracks only", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const lp = roomOf(a).localParticipant;
  const constraints = { width: 640 };
  await a.applyConstraints(constraints);
  const cam = lp.getTrackPublication(Track.Source.Camera)!;
  const mic = lp.getTrackPublication(Track.Source.Microphone)!;
  assert.deepEqual(cam.track.mediaStreamTrack.appliedConstraints, constraints);
  assert.equal(mic.track.mediaStreamTrack.appliedConstraints, null);
});

test("assignVideoTrack() best-effort setEnabled on the remote video publication", () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  const alice = new FakeRemoteParticipant("alice");
  const vpub = alice.addPublication(Track.Kind.Video, true);
  room.remoteParticipants.set("alice", alice);
  a.assignVideoTrack("ARDAMSx0", "alice", false);
  assert.equal(vpub.enabledState, false);
});

test("available_devices: mediaManager.getDevices() returns + emits the raw device array", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const devices = await a.mediaManager.getDevices();
  assert.equal(devices.length, 2);
  const emitted = c.last("available_devices");
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].kind, "videoinput");
});

test("MediaDevicesChanged event re-emits available_devices", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).fire("mediaDevicesChanged");
  await flush();
  assert.ok(c.count("available_devices") >= 1);
});

test("connecting also surfaces available_devices (AntMedia first-poll parity)", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await flush();
  assert.ok(c.count("available_devices") >= 1);
});

test("enableStats()/disableStats() manage a single timer", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  a.enableStats("s1");
  assert.notEqual((a as any).statsTimer, null);
  a.enableStats("s1"); // idempotent guard — no second timer
  a.disableStats("s1");
  assert.equal((a as any).statsTimer, null);
});

test("sampleStats() emits updated_stats with the AntMedia field shape + bitrate delta", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const cam = roomOf(a).localParticipant.getTrackPublication(Track.Source.Camera)!;
  const makeReport = (bytes: number) =>
    new Map<string, any>([
      ["o", { type: "outbound-rtp", kind: "video", bytesSent: bytes, packetsSent: 10 }],
      ["r", { type: "remote-inbound-rtp", kind: "video", packetsLost: 2, jitter: 0.01, roundTripTime: 0.05 }],
    ]);
  cam.track.statsReport = makeReport(1000);

  const origNow = Date.now;
  try {
    (Date as any).now = () => 1_000_000;
    await (a as any).sampleStats();
    const s1 = c.last("updated_stats");
    assert.equal(s1.videoRoundTripTime, 50);
    assert.equal(s1.videoJitter, 10);
    assert.equal(s1.videoPacketsLost, 2);
    assert.equal(s1.totalVideoPacketsSent, 10);
    assert.equal(s1.totalBytesSent, 1000);
    assert.equal(s1.currentOutgoingBitrate, 0); // first sample, no delta

    cam.track.statsReport = makeReport(2000);
    (Date as any).now = () => 1_001_000; // +1s, +1000 bytes => 8 kbps
    await (a as any).sampleStats();
    assert.equal(c.last("updated_stats").currentOutgoingBitrate, 8);
  } finally {
    (Date as any).now = origNow;
  }
});

test("enableAudioLevelForLocalStream() polls audioLevel and emits updated_audio_level", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).localParticipant.audioLevel = 0.42;
  const seen: number[] = [];
  a.enableAudioLevelForLocalStream((lvl: number) => seen.push(lvl));
  t.mock.timers.tick(1000);
  assert.deepEqual(seen, [0.42]);
  assert.deepEqual(c.last("updated_audio_level"), { audioLevel: 0.42 });
});

test("no-op / deprecated surface never throws (setMaxVideoTrackCount, updateAudioLevel, enableEffect, setBackgroundImage)", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  assert.doesNotThrow(() => a.setMaxVideoTrackCount(3));
  assert.doesNotThrow(() => a.updateAudioLevel());
  assert.doesNotThrow(() => a.setBackgroundImage("https://x/bg.png"));
  await assert.doesNotReject(a.enableEffect("blur"));
});
