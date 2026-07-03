#!/usr/bin/env node
/**
 * MANUAL integration proof — per-app MQTT event publishing against a REAL
 * broker (EMQX/mosquitto/...). NOT a jest spec: it opens sockets on purpose
 * and is never picked up by `npm test`.
 *
 * It instantiates the real MqttService (from the compiled dist/) with stub
 * apps/logs contracts, publishes one event of each family through it, and a
 * SEPARATE raw subscriber client asserts the messages actually arrive on the
 * expected topics with the {event, app, timestamp, data} envelope.
 *
 * Build first, then run with credentials in the ENVIRONMENT (never hardcode):
 *
 *   cd streamhub-core && npm run build
 *   MQTT_PROOF_URL='mqtt://127.0.0.1:1883' \
 *   MQTT_PROOF_PUB_USER='user1' MQTT_PROOF_PUB_PASS='...' \
 *   MQTT_PROOF_SUB_USER='user2' MQTT_PROOF_SUB_PASS='...' \
 *   node scripts/mqtt-proof.js
 *
 * Exits 0 on success, 1 on failure/timeout.
 */
'use strict';

const assert = require('node:assert');
const mqtt = require('mqtt');
const { MqttService } = require('../dist/modules/mqtt/mqtt.service');
const {
  defaultMqttClientFactory,
} = require('../dist/modules/mqtt/mqtt-client.factory');

const URL = process.env.MQTT_PROOF_URL || 'mqtt://127.0.0.1:1883';
const PUB_USER = process.env.MQTT_PROOF_PUB_USER || '';
const PUB_PASS = process.env.MQTT_PROOF_PUB_PASS || '';
const SUB_USER = process.env.MQTT_PROOF_SUB_USER || PUB_USER;
const SUB_PASS = process.env.MQTT_PROOF_SUB_PASS || PUB_PASS;

const APP = 'prooftest';
const PREFIX = `streamhub/${APP}`;
const TIMEOUT_MS = 15_000;

/** The per-app config the service would normally read from config.yaml. */
const appConfig = {
  name: APP,
  mqtt: {
    enabled: true,
    url: URL,
    username: PUB_USER,
    password: PUB_PASS,
    topicPrefix: PREFIX,
    qos: 1,
    tls: false,
    events: ['all'],
    logs: { enabled: true, level: 'info' },
  },
};

const appsStub = { getConfig: async () => appConfig };
const logsStub = {
  write: (level, source, message, meta) =>
    console.log(`   [svc:${source}] ${level}: ${message}`, meta ?? ''),
  query: async () => [],
};

const EXPECTED = [
  { topic: `${PREFIX}/connection/stream_started`, event: 'stream_started' },
  { topic: `${PREFIX}/vod/vod_ready`, event: 'vod_ready' },
  { topic: `${PREFIX}/plugin/plugin_worker_started`, event: 'plugin_worker_started' },
  { topic: `${PREFIX}/alert/stream.latency_high`, event: 'stream.latency_high' },
  { topic: `${PREFIX}/log/error`, event: 'log' },
];

async function main() {
  console.log(`→ broker: ${URL} (pub user: ${PUB_USER || '<anonymous>'}, sub user: ${SUB_USER || '<anonymous>'})`);

  // 1) Independent raw subscriber (its own credentials).
  const received = new Map(); // topic → parsed envelope
  const sub = mqtt.connect(URL, {
    clientId: `streamhub-proof-sub-${Date.now()}`,
    ...(SUB_USER ? { username: SUB_USER, password: SUB_PASS } : {}),
    connectTimeout: 8000,
  });
  await new Promise((resolve, reject) => {
    sub.once('connect', resolve);
    sub.once('error', reject);
  });
  await sub.subscribeAsync(`${PREFIX}/#`, { qos: 1 });
  console.log(`✓ subscriber connected + subscribed to ${PREFIX}/#`);
  sub.on('message', (topic, payload) => {
    try {
      received.set(topic, JSON.parse(payload.toString('utf8')));
    } catch {
      received.set(topic, { parseError: payload.toString('utf8') });
    }
    console.log(`   ← ${topic}`);
  });

  // 2) The real MqttService publishing through its own (lazily created) client.
  const svc = new MqttService(appsStub, logsStub, defaultMqttClientFactory);
  await svc.publishEvent(APP, 'stream_started', {
    room: 'proof-1',
    streamId: 'proof-1/publisher',
    type: 'rtmp',
  });
  await svc.publishEvent(APP, 'vod_ready', { room: 'proof-1', vodId: 42 });
  await svc.publishEvent(APP, 'plugin_worker_started', {
    plugin: 'yolo',
    pid: 4242,
  });
  await svc.publishEvent(APP, 'stream.latency_high', {
    room: 'proof-1',
    rttMs: 2380,
    thresholdMs: 1000,
    metric: 'livekit_room_probe_rtt_ms',
  });
  await svc.publishLog(APP, 'error', 'recording', 'upload failed', {
    app: APP,
  });
  console.log('✓ published 4 events + 1 log line through MqttService');

  // 3) Wait for everything to land.
  const t0 = Date.now();
  while (
    EXPECTED.some((e) => !received.has(e.topic)) &&
    Date.now() - t0 < TIMEOUT_MS
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4) Assert.
  let failures = 0;
  for (const { topic, event } of EXPECTED) {
    const env = received.get(topic);
    try {
      assert.ok(env, `nothing arrived on ${topic}`);
      assert.strictEqual(env.event, event, `wrong event on ${topic}`);
      assert.strictEqual(env.app, APP, `wrong app on ${topic}`);
      assert.ok(
        typeof env.timestamp === 'string' &&
          !Number.isNaN(Date.parse(env.timestamp)),
        `bad timestamp on ${topic}`,
      );
      assert.ok(env.data && typeof env.data === 'object', `bad data on ${topic}`);
      console.log(`✓ ${topic} → event=${env.event} data=${JSON.stringify(env.data)}`);
    } catch (err) {
      failures++;
      console.error(`✗ ${err.message}`);
    }
  }

  svc.onModuleDestroy();
  sub.end(true);

  if (failures) {
    console.error(`\nPROOF FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nPROOF PASSED — all events arrived over MQTT with the expected envelope');
}

main().catch((err) => {
  console.error('PROOF FAILED —', err.message);
  process.exit(1);
});
