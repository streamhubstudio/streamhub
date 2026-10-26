/**
 * StreamHub extension callbacks (no AntMedia equivalent). Apps that only handle
 * the AntMedia set never see them; apps that opt in get these exact shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHubAdaptor, roomOf, collector, baseConfig } from "./harness.ts";
import { FakeRemoteParticipant, ConnectionQuality } from "./fake-livekit.ts";

test("roomMetadataChanged -> { room, metadata }", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.joinRoom("room-1", "me");
  roomOf(a).fire("roomMetadataChanged", '{"theme":"dark"}');
  assert.deepEqual(c.last("roomMetadataChanged"), {
    room: "room-1",
    metadata: '{"theme":"dark"}',
  });
});

test("participantMetadataChanged (remote) -> { streamId, metadata, prevMetadata, isLocal:false }", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const bob = new FakeRemoteParticipant("bob", "Bob", '{"role":"host"}');
  roomOf(a).fire("participantMetadataChanged", '{"role":"guest"}', bob);
  assert.deepEqual(c.last("participantMetadataChanged"), {
    streamId: "bob",
    metadata: '{"role":"host"}',
    prevMetadata: '{"role":"guest"}',
    isLocal: false,
  });
});

test("participantMetadataChanged (local participant) -> isLocal:true", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.localParticipant.identity = "me";
  room.localParticipant.metadata = '{"hand":"up"}';
  room.fire("participantMetadataChanged", undefined, room.localParticipant);
  const obj = c.last("participantMetadataChanged");
  assert.equal(obj.streamId, "me");
  assert.equal(obj.metadata, '{"hand":"up"}');
  assert.equal(obj.prevMetadata, undefined);
  assert.equal(obj.isLocal, true);
});

test("connectionQualityChanged -> { streamId, quality:string, isLocal }", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  const bob = new FakeRemoteParticipant("bob");
  room.fire("connectionQualityChanged", ConnectionQuality.Poor, bob);
  assert.deepEqual(c.last("connectionQualityChanged"), {
    streamId: "bob",
    quality: "poor",
    isLocal: false,
  });
  room.localParticipant.identity = "me";
  room.fire("connectionQualityChanged", ConnectionQuality.Excellent, room.localParticipant);
  assert.deepEqual(c.last("connectionQualityChanged"), {
    streamId: "me",
    quality: "excellent",
    isLocal: true,
  });
});

test("activeSpeakersChanged -> { speakers: identities[] } in order", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).fire("activeSpeakersChanged", [
    new FakeRemoteParticipant("loudest"),
    new FakeRemoteParticipant("quieter"),
  ]);
  assert.deepEqual(c.last("activeSpeakersChanged"), {
    speakers: ["loudest", "quieter"],
  });
});

test("extension events are inert for AntMedia-only apps (never mistaken for a known info)", () => {
  const c = collector();
  const a = new StreamHubAdaptor({ token: "t", wsUrl: "w", callback: c.callback });
  roomOf(a).fire("activeSpeakersChanged", []);
  // The only info seen is the extension name itself — no AntMedia alias leaked.
  assert.deepEqual(c.infos(), ["activeSpeakersChanged"]);
});
