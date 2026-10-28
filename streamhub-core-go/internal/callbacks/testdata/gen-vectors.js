// Generates signatures.json: the exact body + X-StreamHub-Signature the Node
// CallbacksService produces (JSON.stringify of the envelope, HMAC-SHA256).
// Run from the repo root: node streamhub-core-go/internal/callbacks/testdata/gen-vectors.js
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const cases = [
  { name: 'stream-started', app: 'live', event: 'stream_started', secret: 's3cret',
    payload: { room: 'live_cam1', streamId: 'cam1', participants: 2 } },
  { name: 'no-room-numbers', app: 'shop', event: 'vod_ready', secret: 'k',
    payload: { vodId: 42, sizeBytes: 123456789012, ratio: 0.1, tiny: 1e-7, big: 1e21, neg: -0.5, ok: true, none: null } },
  { name: 'unicode-html', app: 'live', event: 'chat_message', secret: 'ñandú-🔑',
    payload: { room: 'sala', message: '<b>hola</b> & "chau"   ñ 😀 \t\n', nested: { z: 1, a: [1, 'x', { b: false }] } } },
  { name: 'room-non-string', app: 'live', event: 'iot.data', secret: 'x',
    payload: { room: 7, data: { temp: 21.5 } } },
  { name: 'empty-payload', app: 'live', event: 'room_finished', secret: 'x', payload: {} },
];

const out = cases.map((c) => {
  const ts = '2026-10-27T12:34:56.789Z';
  const envelope = {
    id: '11111111-2222-4333-8444-555555555555',
    event: c.event, app: c.app,
    room: typeof c.payload?.room === 'string' ? c.payload.room : null,
    ts, timestamp: ts, data: c.payload ?? {},
  };
  const body = JSON.stringify(envelope);
  const signature = 'sha256=' + createHmac('sha256', c.secret).update(body).digest('hex');
  return { ...c, payloadJson: JSON.stringify(c.payload), ts, id: envelope.id, body, signature };
});
fs.writeFileSync(path.join(__dirname, 'signatures.json'), JSON.stringify(out, null, 2) + '\n');
