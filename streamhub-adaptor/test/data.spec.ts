/**
 * Data channel: sendData() -> localParticipant.publishData (reliable), and the
 * receive path RoomEvent.DataReceived -> `data_received` with the AntMedia
 * payload shape `{ streamId, data, topic, event }`. Server-side data push
 * (POST /rooms/:room/data) arrives through the exact same callback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamHubAdaptor, roomOf, baseConfig } from "./harness.ts";
import { FakeRemoteParticipant } from "./fake-livekit.ts";

const dec = new TextDecoder();

test("sendData(string) encodes UTF-8 and publishes reliably", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1"); // connect first
  await a.sendData("s1", "hello world");
  const calls = roomOf(a).localParticipant.calls.publishData;
  assert.equal(calls.length, 1);
  assert.ok(calls[0].payload instanceof Uint8Array);
  assert.equal(dec.decode(calls[0].payload), "hello world");
  assert.deepEqual(calls[0].opts, { reliable: true });
});

test("sendData(object) is JSON-serialized", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  await a.sendData("s1", { type: "chat", text: "hi" });
  const payload = roomOf(a).localParticipant.calls.publishData[0].payload;
  assert.deepEqual(JSON.parse(dec.decode(payload)), { type: "chat", text: "hi" });
});

test("sendData(Uint8Array) is passed through untouched", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await a.publish("s1");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await a.sendData("s1", bytes);
  assert.equal(roomOf(a).localParticipant.calls.publishData[0].payload, bytes);
});

test("sendData() before connect is a silent no-op (no throw, nothing published)", async () => {
  const { cfg } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  await assert.doesNotReject(a.sendData("s1", "too early"));
  assert.equal(roomOf(a).localParticipant.calls.publishData.length, 0);
});

test("DataReceived -> data_received with { streamId, data, topic, event }", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const room = roomOf(a);
  const payload = new TextEncoder().encode("ping");
  const sender = new FakeRemoteParticipant("bob");
  room.fire("dataReceived", payload, sender, /* kind */ 1, "chat");

  const obj = c.first("data_received");
  assert.equal(obj.streamId, "bob");
  assert.equal(obj.data, "ping");
  assert.equal(obj.topic, "chat");
  assert.deepEqual(obj.event, { data: "ping" });
});

test("server-side data push (no participant) still delivers via data_received", async () => {
  const { cfg, c } = baseConfig();
  const a = new StreamHubAdaptor(cfg);
  const payload = new TextEncoder().encode('{"kick":true}');
  roomOf(a).fire("dataReceived", payload, undefined, 1, "moderation");
  const obj = c.first("data_received");
  assert.equal(obj.streamId, undefined);
  assert.equal(obj.topic, "moderation");
  assert.equal(obj.data, '{"kick":true}');
});
