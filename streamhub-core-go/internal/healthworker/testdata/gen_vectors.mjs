// Node-generated vectors for the Go port of health-worker/ (deleted in F1 —
// regenerate from the last tree that had it):
//
//   git worktree add /tmp/hw d05b0512
//   node streamhub-core-go/internal/healthworker/testdata/gen_vectors.mjs /tmp/hw/health-worker
//
// Writes vectors.json next to this file. Deterministic (seeded PRNG).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = path.resolve(process.argv[2] ?? 'health-worker', 'src');
const mod = async (f) => import(pathToFileURL(path.join(src, f)).href);
const { parsePlaylist, diffPlaylist, measuredKbps } = await mod('playlist.js');
const { analyzeTsContinuity, isTsSegment } = await mod('tscc.js');
const { parseFfprobe, parseFps } = await mod('probe.js');
const { parseVolumeDetect } = await mod('volume.js');
const { createRoomState, evaluate } = await mod('state.js');
const { resolveThresholds, parseAppConfig } = await mod('settings.js');

let seed = 20261028;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// --- playlists: parse + diff of consecutive pairs ---------------------------
const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-TARGETDURATION: 4 ', '#EXT-X-TARGETDURATION:x',
  '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-MEDIA-SEQUENCE:', '#EXT-X-MEDIA-SEQUENCE:0x10', '#EXT-X-MEDIA-SEQUENCE:1.5', '#EXT-X-MEDIA-SEQUENCE:-3',
  '#EXT-X-DISCONTINUITY', '#EXT-X-DISCONTINUITY-SEQUENCE:2', '#EXTINF:6.000,', '#EXTINF:2.5,title', '#EXTINF:abc,', '#EXTINF:,',
  '#EXTINF: 4 ,', '#EXT-X-ENDLIST', '  seg-1.ts  ', 'seg-2.ts?x=1', 'sub/seg-3.ts', 'https://cdn/x.ts', '', '   ', '#COMMENT', 'seg-é.ts', ' seg-nb.ts '];
const playlists = [];
for (let i = 0; i < 300; i++) {
  const n = Math.floor(rnd() * 14);
  const sep = pick(['\n', '\r\n', '\n\n']);
  playlists.push(Array.from({ length: n }, () => pick(lines)).join(sep));
}
playlists.push('', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n');
const playlistVec = playlists.map((text, i) => {
  const parsed = parsePlaylist(text);
  const prevText = i > 0 ? playlists[i - 1] : null;
  const diff = diffPlaylist(prevText === null ? null : parsePlaylist(prevText), parsed);
  return { text, parsed, diff };
});

// --- measuredKbps -------------------------------------------------------------
const kbps = [];
for (let i = 0; i < 100; i++) {
  const segs = Array.from({ length: Math.floor(rnd() * 4) }, () => ({
    bytes: pick([0, -5, 1, 750000, 1500000, Math.floor(rnd() * 3e6)]),
    duration: pick([0, -1, 0.04, 2, 6, rnd() * 10]),
  }));
  kbps.push({ segs, kbps: measuredKbps(segs) });
}

// --- TS continuity: synthetic packet streams ----------------------------------
function packet(pid, cc, { payload = true, disc = false, afLen = 1 } = {}) {
  const b = Buffer.alloc(188, 0xff);
  b[0] = 0x47; b[1] = (pid >> 8) & 0x1f; b[2] = pid & 0xff;
  const afc = (disc || !payload ? 0x2 : 0) | (payload ? 0x1 : 0);
  b[3] = (afc << 4) | (cc & 0x0f);
  if (afc & 0x2) { b[4] = afLen; b[5] = disc ? 0x80 : 0x00; }
  return b;
}
const tscc = [];
for (let i = 0; i < 100; i++) {
  const parts = [];
  const cc = new Map();
  const n = Math.floor(rnd() * 24);
  for (let k = 0; k < n; k++) {
    const pid = pick([0x100, 0x101, 0x1fff, 0x0, 0x11]);
    let c = ((cc.get(pid) ?? Math.floor(rnd() * 16)) + pick([1, 1, 1, 1, 0, 2, 5])) & 0x0f;
    cc.set(pid, c);
    const r = rnd();
    if (r < 0.05) parts.push(Buffer.alloc(Math.floor(rnd() * 200), pick([0, 0x47, 0x12])));
    parts.push(packet(pid, c, { payload: rnd() > 0.1, disc: rnd() < 0.05, afLen: pick([0, 1, 1, 7]) }));
  }
  let buf = Buffer.concat(parts);
  if (rnd() < 0.2) buf = buf.subarray(0, Math.max(0, buf.length - Math.floor(rnd() * 150)));
  tscc.push({ hex: buf.toString('hex'), result: analyzeTsContinuity(buf) });
}
const tsNames = ['a.ts', 'a.TS', 'a.ts?v=1', 'a.ts?', 'a.tsx', 'a.m4s', '', 'x.ts\n', '.ts', 'a.ts#f', 'a.ts?x\ny'];

// --- ffprobe / fps / volumedetect ---------------------------------------------
const fixtures = path.dirname(fileURLToPath(import.meta.url));
const probeInputs = ['ffprobe-av.json', 'ffprobe-video-only.json', 'ffprobe-desync.json'].map((f) => fs.readFileSync(path.join(fixtures, f), 'utf8'));
probeInputs.push('', 'null', '42', '[]', '"x"', '{}', '{"streams":{}}', '{"streams":[null,1,{"codec_type":"video"}]}',
  '{"streams":[{"codec_type":"video","codec_name":7,"width":"1280","height":"x","avg_frame_rate":"0/0","r_frame_rate":"30000/1001","bit_rate":"2143999","start_time":"1.5"},{"codec_type":"audio","codec_name":null,"sample_rate":"48000","channels":2,"bit_rate":"","start_time":"1.2495"}],"format":{"duration":"6.0","bit_rate":"-1500"}}',
  '{"streams":[{"codec_type":"audio","start_time":0}],"format":[]}', '{"format":{"duration":true,"bit_rate":"1e3"}}',
  '{"streams":[{"codec_type":"video","start_time":"0.0005"},{"codec_type":"audio","start_time":"0"}]}');
const probe = probeInputs.map((text) => ({ text, facts: parseFfprobe(text) }));
const fps = ['30000/1001', '25/1', '25', '0/0', '', 'x/y', '24/0', '-5/1', '60/1/2', ' 30 ', '1e2/4', '0x1e/1', null, 29.97, '/1', '30/'].map((r) => ({ rate: r, fps: parseFps(r) }));
const volInputs = ['volumedetect-normal.txt', 'volumedetect-silent.txt', 'volumedetect-noaudio.txt'].map((f) => fs.readFileSync(path.join(fixtures, f), 'utf8'));
volInputs.push('', 'mean_volume: -1.2.3 dB', 'mean_volume:-20 dB\nmax_volume: -.5 dB', 'mean_volume: -20dB max_volume: x dB', 'mean_volume: 0.0 dB', 'mean_volume: - dB');
const volume = volInputs.map((text) => ({ text, volume: parseVolumeDetect(text) }));

// --- thresholds + app config --------------------------------------------------
const cfgInputs = [undefined, '', '{}', 'nope', '[1]', 'null', '{"stall_sec":30,"x":1}', '{"silence_db":"-60","desync_ms":5,"recover_samples":"0x2","bitrate_drop_pct":0,"2":"a"}'];
const appConfig = cfgInputs.map((json) => ({ json: json ?? null, parsed: parseAppConfig(json), stringified: JSON.stringify(parseAppConfig(json)) }));
const vals = [undefined, null, true, '', ' 30 ', '1e1', 'abc', 0, 1, 2, 5, 10, 20, 95, 96, 300, 301, -50, -121, 1e9, 0.5, '0x10'];
const keys = ['sample_interval_sec', 'silence_db', 'silence_duration_sec', 'desync_ms', 'stall_sec', 'bitrate_drop_pct', 'recover_samples'];
const thresholds = [];
for (let i = 0; i < 150; i++) {
  const layer = () => Object.fromEntries(keys.filter(() => rnd() < 0.4).map((k) => [k, pick(vals)]));
  const app = layer(); const over = rnd() < 0.3 ? undefined : layer();
  thresholds.push({ app, override: over ?? null, resolved: resolveThresholds(app, over) });
}

// --- state machine: random multi-step scenarios ---------------------------------
const T = resolveThresholds({}, {});
const states = [];
for (let i = 0; i < 120; i++) {
  const t = rnd() < 0.3 ? { ...T, recover_samples: pick([1, 2, 3]), bitrate_drop_pct: pick([0, 50, 80]), silence_duration_sec: pick([1, 15, 30]) } : T;
  const s = createRoomState();
  const steps = [];
  let now = Math.floor(rnd() * 1e6);
  for (let k = 0; k < 12; k++) {
    now += pick([2000, 10000, 10000, 30000, 61000]);
    const sample = {
      secondsSinceAdvance: pick([0, 2, 2, 2, 19.5, 20, 25.4, 40]),
      droppedSegments: pick([0, 0, 0, 0, 2]),
      ccErrors: pick([0, 0, 0, 0, 3]),
      newDiscontinuityTags: pick([0, 0, 0, 1]),
      hasAudioTrack: pick([true, true, true, false, null]),
      meanDb: pick([-23, -23, -80, -91.4, -50, null]),
      desyncMs: pick([10, 10, 199.6, 200, 350.4, -400, null]),
      measuredKbps: pick([2000, 2000, 1900, 800, 2100, 0, null]),
    };
    const r = evaluate(s, sample, t, now);
    steps.push({ now, sample, events: r.events, status: r.status, reasons: r.reasons });
  }
  states.push({ t, steps });
}

fs.writeFileSync(path.join(fixtures, 'vectors.json'), JSON.stringify({
  playlists: playlistVec, kbps, tscc, tsNames: tsNames.map((n) => ({ name: n, ts: isTsSegment(n) })),
  probe, fps, volume, appConfig, thresholds, states,
}) + '\n');
