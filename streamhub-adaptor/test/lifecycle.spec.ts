/**
 * Connection lifecycle + teardown: stop() / leaveFromRoom() / closeWebSocket(),
 * the RoomEvent.Connected/Disconnected/Reconnected -> session_restored/closed
 * mapping, ConnectionStateChanged -> ice_connection_state_changed, and the
 * iceConnectionState()/getDebugInfo() helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHubAdaptor, roomOf, collector, baseConfig } from "./harness.ts";
import { ConnectionState } from "./fake-livekit.ts";

test("stop() after publish disconnects and emits publish_finished", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.stop("s1");
  assert.equal(roomOf(a).calls.disconnect, 1);
  assert.deepEqual(c.last("publish_finished"), { streamId: "s1" });
});

test("stop() while idle: no disconnect, still emits publish_finished, no throw", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await assert.doesNotReject(a.stop());
  assert.equal(roomOf(a).calls.disconnect, 0);
  assert.equal(c.count("publish_finished"), 1);
  assert.deepEqual(c.first("publish_finished"), { streamId: undefined });
});

test("leaveFromRoom() disconnects and emits leavedFromRoom with ATTR_ROOM_NAME", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.joinRoom("room-7", "me");
  await a.leaveFromRoom("room-7");
  assert.equal(roomOf(a).calls.disconnect, 1);
  assert.deepEqual(c.last("leavedFromRoom"), { ATTR_ROOM_NAME: "room-7" });
});

test("closeWebSocket() disconnects the room", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  a.closeWebSocket();
  // disconnectInternal is async fire-and-forget; give it a tick.
  await Promise.resolve();
  assert.equal(roomOf(a).calls.disconnect, 1);
});

test("RoomEvent.Connected -> session_restored; Disconnected -> closed", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.fire("connected");
  room.fire("disconnected");
  assert.equal(c.count("session_restored"), 1);
  assert.equal(c.count("closed"), 1);
});

test("RoomEvent.Reconnected re-emits session_restored", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  roomOf(a).fire("reconnected");
  assert.equal(c.count("session_restored"), 1);
});

test("ConnectionStateChanged -> ice_connection_state_changed with mapped state", () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.fire("connectionStateChanged", ConnectionState.Connected);
  room.fire("connectionStateChanged", ConnectionState.Reconnecting);
  const states = c.all("ice_connection_state_changed").map((o) => o.state);
  assert.deepEqual(states, ["connected", "disconnected"]);
});

test("iceConnectionState() maps room.state to an ICE-style string", () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  room.state = ConnectionState.Connected;
  assert.equal(a.iceConnectionState(), "connected");
  room.state = ConnectionState.Connecting;
  assert.equal(a.iceConnectionState(), "checking");
  room.state = ConnectionState.Reconnecting;
  assert.equal(a.iceConnectionState(), "disconnected");
  room.state = ConnectionState.Disconnected;
  assert.equal(a.iceConnectionState(), "closed");
});

test("getDebugInfo() emits debugInfo carrying a JSON room snapshot", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.getDebugInfo("s1");
  const obj = c.last("debugInfo");
  const parsed = JSON.parse(obj.debugInfo);
  assert.equal(parsed.connectionState, "connected");
  assert.equal(typeof parsed.participants, "number");
  assert.ok(parsed.localTracks >= 1);
});
