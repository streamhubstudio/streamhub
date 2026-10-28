// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates node_vectors.json from the Node core's own dist build: the exact
// Twirp request JSON LiveKitService sends for each call (ingress profiles,
// egress shapes, room ops), the mapped results for canned LiveKit responses,
// join tokens minted by livekit-server-sdk, the ingress_auth scrypt hash, the
// simulcast metadata hint and a webhook signed by the Node AccessToken.
// Run from the repo root (after `npm run build` in streamhub-core):
//   node streamhub-core-go/internal/livekit/testdata/gen-vectors.js
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const core = path.resolve(__dirname, '../../../../streamhub-core');
const req = (p) => require(path.join(core, 'node_modules', p));
const { LiveKitService } = require(path.join(core, 'dist/modules/livekit/livekit.service.js'));
const { LiveKitController } = require(path.join(core, 'dist/modules/livekit/livekit.controller.js'));
const { AccessToken } = req('livekit-server-sdk');

const logs = { write() {} };

function service(profile, extra = {}) {
  const config = {
    livekitUrl: 'ws://lk.test:7880',
    livekitApiKey: 'APIkey',
    livekitApiSecret: 'secret-0123456789',
    ingestProfile: profile,
    rtmpPublicHost: 'rtmp.example.com',
    ...extra,
  };
  return new LiveKitService(config, logs);
}

// Replace each SDK client's Twirp transport: record the request, answer from
// the queue (an Error entry rejects like a LiveKit error).
function capture(svc, responses) {
  const requests = [];
  for (const c of [svc.roomClient, svc.ingressClient, svc.egressClient]) {
    c.rpc.request = async (service, method, data) => {
      const d = JSON.parse(JSON.stringify(data));
      if (method === 'SendData') delete d.nonce; // random per call
      requests.push({ service, method, data: d });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r ?? {};
    };
  }
  return requests;
}

const vectors = [];
async function vec(name, profile, responses, fn, extra) {
  const svc = service(profile, extra);
  const requests = capture(svc, [...responses]);
  let result, error;
  try {
    result = await fn(svc);
  } catch (e) {
    error = { status: e.getStatus?.() ?? null, message: e.message };
  }
  vectors.push({ name, profile, responses, requests, result: result ?? null, error: error ?? null });
}

const ingressInfo = { ingressId: 'IN_1', url: 'rtmp://10.0.0.5:1935/x', streamKey: 'SK_1', roomName: 'live-ch1' };

(async () => {
  const base = { appName: 'live', roomName: 'live-ch1', participantIdentity: 'ingress-live', participantName: 'Cam' };
  for (const profile of ['livekit', 'efficient']) {
    await vec(`ingress-rtmp-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp', enableTranscoding: true }));
    await vec(`ingress-rtmp-bypass-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp', enableTranscoding: false }));
    await vec(`ingress-whip-bypass-${profile}`, profile, [{ ingressId: 'IN_2', url: 'https://lk/w' }], (s) => s.createIngress({ ...base, inputType: 'whip', enableTranscoding: false }));
    await vec(`ingress-whip-on-${profile}`, profile, [{ ingressId: 'IN_2', url: 'https://lk/w' }], (s) => s.createIngress({ ...base, inputType: 'whip', enableTranscoding: true }));
    await vec(`ingress-url-${profile}`, profile, [{ ingressId: 'IN_3' }], (s) => s.createIngress({ ...base, inputType: 'url', url: 'rtsp://93.184.216.34/cam' }));
    await vec(`ingress-1080-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp', maxHeight: 1080 }));
    await vec(`ingress-480-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp', maxHeight: 480 }));
    await vec(`ingress-adaptive-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp', simulcast: true }));
    await vec(`ingress-adaptive-1080-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'url', url: 'srt://93.184.216.34:9000', simulcast: true, maxHeight: 1080 }));
    await vec(`ingress-audio-${profile}`, profile, [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp', audioOnly: true }));
    await vec(`ingress-reject-${profile}`, profile, [new Error('invalid preset'), ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp' }));
  }
  await vec('ingress-no-public-host', 'livekit', [ingressInfo], (s) => s.createIngress({ ...base, inputType: 'rtmp' }), { rtmpPublicHost: '' });
  await vec('ingress-list', 'livekit', [{ items: [
    { ingressId: 'IN_1', name: 'live-ch1', url: 'rtmp://10.0.0.5:1935/x', streamKey: 'SK_1', roomName: 'live-ch1', inputType: 'RTMP_INPUT',
      state: { status: 'ENDPOINT_PUBLISHING', startedAt: '1700000000123456789', video: { averageBitrate: 2500000, width: 1920, height: 1080 } } },
    { ingressId: 'IN_2', url: 'https://lk/w', roomName: 'live-ch2', inputType: 'WHIP_INPUT', state: { status: 'ENDPOINT_BUFFERING', startedAt: '1700000000' } },
    { ingressId: 'IN_3', roomName: 'other', inputType: 'URL_INPUT' },
  ] }], (s) => s.listIngress());
  await vec('ingress-delete', 'livekit', [{}], (s) => s.deleteIngress('IN_1'));

  const enc = { file: true };
  await vec('egress-room-composite', 'livekit', [{ egressId: 'EG_1', status: 'EGRESS_STARTING' }], (s) =>
    s.startEgress({ appName: 'live', roomName: 'live-ch1', mode: 'room-composite', layout: 'grid', outputFilepath: '/data/rec/a.mp4', snapshotIntervalS: 10.7, snapshotFilePrefix: '/data/rec/snap_' }));
  await vec('egress-participant', 'livekit', [{ egressId: 'EG_2', status: 'EGRESS_ACTIVE' }], (s) =>
    s.startEgress({ appName: 'live', roomName: 'live-ch1', mode: 'participant', participantIdentity: 'u1', outputFilepath: '/data/rec/b.mp4' }));
  await vec('egress-participant-missing', 'livekit', [], (s) =>
    s.startEgress({ appName: 'live', roomName: 'live-ch1', mode: 'participant', outputFilepath: '/x.mp4' }));
  const parts = { identity: 'u1', sid: 'PA_1', tracks: [
    { sid: 'TR_V', type: 'VIDEO', source: 'CAMERA' }, { sid: 'TR_A', type: 'AUDIO', source: 'MICROPHONE', muted: true }, { sid: 'TR_A2', type: 'AUDIO' } ] };
  await vec('egress-track', 'livekit', [parts, { egressId: 'EG_3', status: 'EGRESS_STARTING' }], (s) =>
    s.startTrackCompositeEgress({ appName: 'live', roomName: 'live-ch1', participantIdentity: 'u1', outputFilepath: '/r.mp4' }));
  await vec('egress-track-audio', 'livekit', [parts, { egressId: 'EG_4', status: 'EGRESS_STARTING' }], (s) =>
    s.startTrackCompositeEgress({ appName: 'live', roomName: 'live-ch1', participantIdentity: 'u1', outputFilepath: '/r.mp4', audioOnly: true }));
  await vec('egress-track-none', 'livekit', [{ identity: 'u1' }], (s) =>
    s.startTrackCompositeEgress({ appName: 'live', roomName: 'live-ch1', participantIdentity: 'u1', outputFilepath: '/r.mp4' }));
  await vec('egress-stream', 'livekit', [{ egressId: 'EG_5', status: 'EGRESS_STARTING', roomName: 'live-ch1' }], (s) =>
    s.startStreamEgress({ appName: 'live', roomName: 'live-ch1', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/key', layout: 'speaker' }));
  await vec('egress-hls', 'livekit', [{ egressId: 'EG_6', status: 'EGRESS_STARTING' }], (s) =>
    s.startHlsEgress({ appName: 'live', roomName: 'live-ch1', outputDir: '/data/hls/live/ch1', playlistName: 'index.m3u8', segmentDurationS: 2.5 }));
  await vec('egress-hls-dvr', 'livekit', [{ egressId: 'EG_7', status: 'EGRESS_ACTIVE', segmentResults: [{ playlistLocation: '/data/hls/x/index.m3u8' }] }], (s) =>
    s.startHlsEgress({ appName: 'live', roomName: 'live-ch1', outputDir: '/data/hls/x', playlistName: 'index.m3u8', livePlaylistName: 'live.m3u8' }));
  const active = { items: [
    { egressId: 'E1', roomName: 'live-ch1', status: 'EGRESS_ACTIVE', roomComposite: { roomName: 'live-ch1', segmentOutputs: [{ playlistName: '/d/a.m3u8' }] } },
    { egressId: 'E2', roomName: 'live', status: 'EGRESS_STARTING', segmentResults: [{ playlistName: '/d/b.m3u8' }] },
    { egressId: 'E3', roomName: 'live-ch2', status: 'EGRESS_ACTIVE', streamResults: [{ url: 'rtmp://x/1' }, { url: '' }] },
    { egressId: 'E4', roomName: 'live-ch3', status: 'EGRESS_ACTIVE', roomComposite: { streamOutputs: [{ urls: ['rtmp://y/1', 'rtmp://y/2'] }] } },
    { egressId: 'E5', roomName: 'livex', status: 'EGRESS_ACTIVE', segmentResults: [{ playlistName: '/d/c.m3u8' }] },
    { egressId: 'E6', roomName: 'live-ch4', status: 'EGRESS_ACTIVE', roomComposite: { fileOutputs: [{ filepath: '/f.mp4' }] } },
    { egressId: 'E7', roomName: 'live-ch5', status: 99, streamResults: [{ url: 'rtmp://z' }] },
  ] };
  await vec('egress-list-hls', 'livekit', [active], (s) => s.listHlsEgress('live'));
  await vec('egress-list-stream', 'livekit', [active], (s) => s.listStreamEgress('live'));
  await vec('egress-stop', 'livekit', [{ egressId: 'E1', status: 'EGRESS_ENDING' }], (s) => s.stopEgress('E1'));
  await vec('egress-stop-fail', 'livekit', [new Error('egress not found')], (s) => s.stopEgress('E9'));

  const room = { name: 'live-ch1', sid: 'RM_1', numParticipants: 3, creationTime: '1700000000', metadata: '{"onAir":true}' };
  await vec('room-create', 'livekit', [room], (s) => s.createRoom('live-ch1', 86400));
  await vec('room-create-default', 'livekit', [room], (s) => s.createRoom('live-ch2'));
  await vec('room-delete', 'livekit', [{}], (s) => s.deleteRoom('live-ch1'));
  await vec('room-list', 'livekit', [{ rooms: [room, { name: 'x', sid: 'RM_2' }] }], (s) => s.listRooms());
  await vec('room-list-names', 'livekit', [{ rooms: [room] }], (s) => s.listRooms(['live-ch1', 'live-ch9']));
  await vec('room-list-detailed', 'livekit', [{ rooms: [room, { name: 'x', sid: 'RM_2' }] }], (s) => s.listRoomsDetailed());
  await vec('room-get', 'livekit', [{ rooms: [room] }], (s) => s.getRoom('live-ch1'));
  await vec('room-get-missing', 'livekit', [{ rooms: [] }], (s) => s.getRoom('live-ch1'));
  await vec('room-metadata', 'livekit', [room], (s) => s.updateRoomMetadata('live-ch1', '{"onAir":true}'));
  await vec('room-metadata-empty', 'livekit', [{ name: 'live-ch1', sid: 'RM_1' }], (s) => s.updateRoomMetadata('live-ch1', ''));
  const pList = { participants: [
    { identity: 'u1', name: 'U1', sid: 'PA_1', metadata: 'm', joinedAt: '1700000000', permission: { canPublish: true, canSubscribe: true, canPublishData: true },
      tracks: [{ sid: 'TR_V', type: 'VIDEO', source: 'CAMERA' }, { sid: 'TR_A', type: 'AUDIO', source: 'MICROPHONE', muted: true }, { sid: 'TR_S', type: 'VIDEO', source: 'SCREEN_SHARE_AUDIO' }] },
    { identity: 'qc', sid: 'PA_2', permission: { hidden: true, canSubscribe: true }, joinedAtMs: '1700000000123' },
    { identity: 'ingress-live', sid: 'PA_3', kind: 'INGRESS', joinedAt: '1700000000123', tracks: [{ sid: 'T', type: 'DATA', source: 'UNKNOWN' }] },
  ] };
  await vec('participants', 'livekit', [pList], (s) => s.listParticipants('live-ch1'));
  await vec('participants-detailed', 'livekit', [pList], (s) => s.listParticipantsDetailed('live-ch1'));
  await vec('participant-get', 'livekit', [pList.participants[0]], (s) => s.getParticipant('live-ch1', 'u1'));
  await vec('participant-remove', 'livekit', [{}], (s) => s.removeParticipant('live-ch1', 'u1'));
  await vec('participant-mute', 'livekit', [{ track: { sid: 'TR_A', muted: true } }], (s) => s.mutePublishedTrack('live-ch1', 'u1', 'TR_A', true));
  await vec('participant-mute-empty', 'livekit', [{}], (s) => s.mutePublishedTrack('live-ch1', 'u1', 'TR_A', false));
  await vec('participant-update', 'livekit', [pList.participants[0]], (s) =>
    s.updateParticipant('live-ch1', 'u1', { metadata: 'md', name: 'New', permission: { canPublish: false, canSubscribe: true, canPublishData: true, hidden: false } }));
  await vec('participant-update-meta', 'livekit', [pList.participants[0]], (s) => s.updateParticipant('live-ch1', 'u1', { metadata: '' }));
  await vec('participant-subscriptions', 'livekit', [{}], (s) => s.updateSubscriptions('live-ch1', 'u1', ['TR_A', 'TR_V'], false));
  await vec('data-send', 'livekit', [{}], (s) => s.sendData('live-ch1', '{"topic":"chat"}', { topic: 'chat', destinationIdentities: ['u1'] }));
  await vec('data-send-lossy', 'livekit', [{}], (s) => s.sendData('live-ch1', 'x', { topic: '', reliable: false }));
  await vec('data-send-fail', 'livekit', [new Error('room not found')], (s) => s.sendData('live-ch1', 'x', { topic: 't' }));

  // Join tokens (Go re-mints with the same nbf and must produce the same bytes).
  const tokens = [];
  const tok = async (name, opts) => {
    const s = service('livekit');
    tokens.push({ name, opts, token: await s.mintTokenAdvanced(opts) });
  };
  await tok('publisher', { room: 'live-ch1', identity: 'u1', name: 'User <1>', metadata: '{"a":"<&>"}' });
  await tok('viewer', { room: 'live-ch1', identity: 'viewer-1234abcd', canPublish: false, canSubscribe: true, canPublishData: false, hidden: true, ttl: '6h' });
  await tok('listener-audio', { room: 'live-radio', identity: 'listener-1', canPublish: false, canSubscribe: true, canPublishData: false, hidden: true, audioOnly: true, ttl: '6h' });
  await tok('audio-publisher', { room: 'live-radio', identity: 'host', audioOnly: true, recorder: true, ttl: '90m' });
  await tok('ttl-variants', { room: 'r', identity: 'i', ttl: '1.5 hours' });
  await tok('ttl-days', { room: 'r', identity: 'i', ttl: '2d', canSubscribe: false });
  const badTtl = [];
  for (const ttl of ['3600', '6 parsecs', '-1h ago']) {
    try { await service('livekit').mintTokenAdvanced({ room: 'r', identity: 'i', ttl }); badTtl.push({ ttl, error: null }); }
    catch (e) { badTtl.push({ ttl, error: e.message }); }
  }

  // ingress_auth scrypt (salt is the hex STRING).
  const scrypt = [['pw-1', '00112233445566778899aabbccddeeff'], ['ünïcødé 🔑', 'abcdef']].map(([pw, salt]) => ({
    password: pw, salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex'),
  }));

  // Simulcast metadata hint.
  const cfg = { webrtc: { layers: [{ name: 'low', height: 360 }, { name: 'high', height: 720 }] } };
  const hint = [undefined, '', '{"b":1,"streamhub":"old","a":[1,2]}', '[1,"x"]', '"str"', 'null', '7', 'not json', '{"2":"x","1":"y","z":true}']
    .map((raw) => ({ raw: raw ?? null, out: LiveKitController.prototype.withSimulcastHint.call(null, raw, cfg) }));

  // A webhook signed exactly like LiveKit does (Authorization: <jwt> with sha256).
  const body = JSON.stringify({ event: 'track_published', id: 'EV_1', createdAt: '1700000000', room: { name: 'live-ch1', sid: 'RM_1' },
    participant: { identity: 'u1', name: 'U', sid: 'PA_1', kind: 'STANDARD', permission: {} }, track: { sid: 'TR_1', type: 'VIDEO', source: 'CAMERA' }, unknownField: 1 });
  const at = new AccessToken('APIkey', 'secret-0123456789', { ttl: '1000d' });
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const webhook = { body, auth: await at.toJwt() };

  fs.writeFileSync(path.join(__dirname, 'node_vectors.json'),
    JSON.stringify({ vectors, tokens, badTtl, scrypt, hint, webhook }, null, 1) + '\n');
  console.log(`wrote ${vectors.length} request vectors, ${tokens.length} tokens`);
})();
