/**
 * joinRoom() / play() / the remote-track subscribe path — the conference
 * migration surface: `joinedTheRoom`, `roomInformation` roster shape,
 * `newStreamAvailable` (MediaStreamTrack + ARDAMSx trackId), and `play_started`
 * / `play_finished`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHubAdaptor, roomOf, collector, baseConfig } from "./harness.ts";
import { FakeRemoteParticipant, Track } from "./fake-livekit.ts";

test("joinRoom() connects then emits joinedTheRoom + roomInformation with the AntMedia payload shape", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.remoteParticipants.set("alice", new FakeRemoteParticipant("alice"));
  room.remoteParticipants.set("bob", new FakeRemoteParticipant("bob"));

  await a.joinRoom("room-1", "me");

  const joined = c.first("joinedTheRoom");
  assert.equal(joined.ATTR_ROOM_NAME, "room-1");
  assert.equal(joined.streamId, "me");
  assert.deepEqual(joined.streams, ["alice", "bob"]);
  assert.deepEqual(joined.streamList, ["alice", "bob"]);
  assert.equal(joined.maxTrackCount, 2);
  // joinRoom surfaces an immediate roomInformation too.
  assert.equal(c.count("roomInformation"), 1);
});

test("joinRoom() ignores the mode argument (LiveKit is always an SFU)", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.joinRoom("room-1", "me", "mcu");
  // No throw, still joined.
  assert.equal(c.count("joinedTheRoom"), 1);
});

test("joinRoom() failure routes to callbackError('joinRoomError')", async () => {
  const c = collector();
  const a = new StreamHubAdaptor({ callback: c.callback, callbackError: c.callbackError });
  await a.joinRoom("room-1", "me"); // no token config => resolveToken throws
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].error, "joinRoomError");
});

test("play() connects and emits play_started", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.play("stream-x");
  assert.equal(roomOf(a).calls.connect.length, 1);
  assert.deepEqual(c.first("play_started"), { streamId: "stream-x" });
});

test("play() re-announces already-subscribed remote tracks as newStreamAvailable", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  const alice = new FakeRemoteParticipant("alice", "Alice");
  alice.addPublication(Track.Kind.Video, true);
  room.remoteParticipants.set("alice", alice);

  await a.play("room-1");

  const announced = c.all("newStreamAvailable");
  assert.equal(announced.length, 1);
  assert.equal(announced[0].streamId, "alice");
});

test("TrackSubscribed(video) -> newStreamAvailable with ARDAMSx trackId + MediaStreamTrack + streamName", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  const alice = new FakeRemoteParticipant("alice", "Alice");
  const track = { kind: Track.Kind.Video, mediaStreamTrack: { kind: "video", id: "mst-1" } };
  room.fire("trackSubscribed", track, {}, alice);

  const obj = c.first("newStreamAvailable");
  assert.equal(obj.trackId, "ARDAMSxalice");
  assert.equal(obj.streamId, "alice");
  assert.equal(obj.streamName, "Alice");
  assert.equal(obj.track, track.mediaStreamTrack); // raw MediaStreamTrack, not the LK wrapper
  assert.ok(obj.stream instanceof globalThis.MediaStream);
  assert.deepEqual(obj.stream.getTracks(), [track.mediaStreamTrack]);
});

test("TrackSubscribed(audio) -> newStreamAvailable (no streamName field for audio)", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const p = new FakeRemoteParticipant("bob");
  const track = { kind: Track.Kind.Audio, mediaStreamTrack: { kind: "audio", id: "mst-a" } };
  roomOf(a).fire("trackSubscribed", track, {}, p);
  const obj = c.first("newStreamAvailable");
  assert.equal(obj.streamId, "bob");
  assert.equal(obj.trackId, "ARDAMSxbob");
  assert.equal(obj.streamName, undefined);
});

test("streamName falls back to identity when the participant has no name", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const p = new FakeRemoteParticipant("carol"); // no display name
  const track = { kind: Track.Kind.Video, mediaStreamTrack: { kind: "video" } };
  roomOf(a).fire("trackSubscribed", track, {}, p);
  assert.equal(c.first("newStreamAvailable").streamName, "carol");
});

test("TrackUnsubscribed -> play_finished(streamId) + roomInformation (the fixed contract gap)", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const p = new FakeRemoteParticipant("alice");
  roomOf(a).fire("trackUnsubscribed", {}, {}, p);
  assert.deepEqual(c.first("play_finished"), { streamId: "alice" });
  assert.equal(c.count("roomInformation"), 1);
});

test("roster events (ParticipantConnected/Disconnected, TrackPublished) each re-emit roomInformation", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.fire("participantConnected", new FakeRemoteParticipant("x"));
  room.fire("participantDisconnected", new FakeRemoteParticipant("x"));
  room.fire("trackPublished");
  assert.equal(c.count("roomInformation"), 3);
});

test("getRoomInfo() emits roomInformation reflecting the current remote roster", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.remoteParticipants.set("z", new FakeRemoteParticipant("z"));
  a.getRoomInfo("room-9", "me");
  const info = c.first("roomInformation");
  assert.equal(info.ATTR_ROOM_NAME, "room-9");
  assert.deepEqual(info.streams, ["z"]);
});
