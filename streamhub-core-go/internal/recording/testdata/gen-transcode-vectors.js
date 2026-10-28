// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates transcode_vectors.json from the Node core's dist build: the exact
// ffmpeg argv of the VOD transcode helpers (captured by stubbing
// child_process.execFile BEFORE the util is required), master playlists,
// rendition ladders, bitrate/width math and the shaka-packager argv builders.
// Run from the repo root: node streamhub-core-go/internal/recording/testdata/gen-transcode-vectors.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');

const calls = [];
cp.execFile = (bin, args, _opts, cb) => {
  calls.push({ bin, args: [...args] });
  cb(null, '');
};

const dist = path.resolve(__dirname, '../../../../streamhub-core/dist/modules/recording');
const util = require(path.join(dist, 'vod-transcode.util.js'));
const shaka = require(path.join(dist, 'drm/drm-packager.util.js'));
const drmCfg = require(path.join(dist, 'drm/drm-config.js'));

// Output dirs must be creatable; argv paths are rewritten to /W afterwards.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcvec-'));
const W = (s) => s.split(tmp).join('/W');
const W2 = (v) => JSON.parse(W(JSON.stringify(v)));

(async () => {
  const argv = [];
  const capture = async (name, fn) => {
    calls.length = 0;
    await fn();
    argv.push({ name, ...W2(calls[0]) });
  };
  for (const r of [
    { height: 720, bitrateKbps: 2800 },
    { height: 1080, bitrateKbps: 5000 },
    { height: 361, bitrateKbps: 1263.5 },
    { height: 144, bitrateKbps: 250 },
  ]) {
    await capture(`hls-${r.height}`, () => util.transcodeHlsRendition('/W/src.mp4', path.join(tmp, `${r.height}p`), r));
    await capture(`hls6-${r.height}`, () => util.transcodeHlsRendition('/W/src.mp4', path.join(tmp, `${r.height}p`), r, 6));
    await capture(`mp4-${r.height}`, () => util.transcodeRenditionMp4('/W/src.mp4', path.join(tmp, 'mezz', `${r.height}p.mp4`), r));
  }
  await capture('webm-default', () => util.transcodeWebmVp8('/W/src.mp4', path.join(tmp, 'a.webm')));
  await capture('webm-1400', () => util.transcodeWebmVp8('/W/src.mp4', path.join(tmp, 'a.webm'), 1400));
  await capture('webm-frac', () => util.transcodeWebmVp8('/W/src.mp4', path.join(tmp, 'a.webm'), 3782.5));
  fs.rmSync(tmp, { recursive: true, force: true });

  const cfg = (transcoding, layers) => ({ transcoding: { vodRenditions: transcoding }, webrtc: { layers } });
  const ladders = [
    { name: 'explicit', cfg: cfg([{ height: 1080, bitrateKbps: 5000 }, { height: 480, bitrateKbps: 1400 }], []) },
    { name: 'layers', cfg: cfg([], [{ name: 'h', height: 720 }, { name: 'm', height: 480 }, { name: 'l', height: 240 }]) },
    { name: 'odd', cfg: cfg([{ height: 1080.7, bitrateKbps: 5000.9 }, { height: 100, bitrateKbps: 300 }, { height: 5000, bitrateKbps: 1 },
      { height: 720, bitrateKbps: 0 }, { height: 1080, bitrateKbps: 1 }, { height: 360, bitrateKbps: 800 }], []) },
    { name: 'layers-odd', cfg: cfg([], [{ name: 'a', height: 1080.7 }, { name: 'b', height: 1000 }, { name: 'c', height: 130 }, { name: 'd', height: 1000 }]) },
    { name: 'cap5', cfg: cfg([144, 240, 360, 480, 720, 1080, 1440].map((h) => ({ height: h, bitrateKbps: h * 2 })), []) },
    { name: 'empty', cfg: cfg([], []) },
  ].map((l) => ({ name: l.name, cfg: l.cfg, out: util.resolveVodRenditions(l.cfg) }));

  const bitrates = [2160, 1440, 1080, 720, 480, 360, 240, 144, 1000, 50, 1080.7, 333].map((h) => ({ h, out: util.bitrateForHeight(h) }));
  const widths = [
    [720, null, null], [480, null, null], [1080, 1920, 1080], [720, 1080, 1920], [480, 640, 480], [361, 1920, 1080], [240, 0, 0], [720, 1440, 0],
  ].map(([h, w, sh]) => ({ h, w, sh, out: util.widthForHeight(h, w, sh) }));

  const masters = [
    { name: 'two', entries: [{ uri: '720p/index.m3u8', height: 720, bitrateKbps: 2800, width: 1280 }, { uri: '480p/index.m3u8', height: 480, bitrateKbps: 1400 }] },
    { name: 'none', entries: [] },
    { name: 'frac', entries: [{ uri: 'x.m3u8', height: 361, bitrateKbps: 1263.5 }] },
  ].map((m) => ({ ...m, out: util.buildMasterPlaylist(m.entries) }));

  const KID = '0123456789abcdef0123456789abcdef';
  const KEY = 'fedcba9876543210fedcba9876543210';
  const rawKeys = [
    { name: 'single', keys: { assetId: 'a', keys: [{ keyId: KID, key: KEY }] }, scheme: 'cbcs' },
    { name: 'iv-cenc', keys: { assetId: 'a', keys: [{ keyId: KID, key: KEY, iv: KEY }] }, scheme: 'cenc' },
    { name: 'multi-pssh-uri', keys: { assetId: 'a', keys: [{ keyId: KID, key: KEY }, { keyId: KEY, key: KID }],
      pssh: [{ system: 'widevine', boxBase64: 'AAAAMHBzc2g=' }, { system: 'playready', boxBase64: 'UFI' }, { system: 'fairplay', boxBase64: 'a-b_c' }],
      hlsKeyUri: 'skd://asset-a' }, scheme: 'cbcs' },
  ].map((v) => ({ ...v, out: shaka.buildRawKeyArgs(v.keys, v.scheme) }));
  const shakaJobs = [
    { name: 'two', job: { renditions: [{ height: 720, mp4Path: '/w/720p.mp4' }, { height: 480, mp4Path: '/w/480p.mp4' }], audioSourcePath: '/w/source.mp4', outDir: '/w/out', keyArgs: ['--enable_raw_key_encryption'] } },
    { name: 'seg6', job: { renditions: [{ height: 720, mp4Path: '/w/720p.mp4' }], audioSourcePath: '/w/s.mp4', outDir: '/w/out/', segmentSeconds: 6, keyArgs: [] } },
  ].map((v) => ({ ...v, out: shaka.buildShakaHlsArgs(v.job) }));

  const drm = [
    null, {}, { enabled: true, provider: 'EXTERNAL', systems: ['Widevine', 'nope', 'widevine', 'FairPlay'], scheme: 'CENC',
      key_server_url: ' https://k ', key_server_token_env: 'TOK', license_urls: { widevine: ' u ', playready: 5 }, fairplay_cert_url: 'c', fail_open: true },
    { enabled: 'true', fail_open: 1, systems: 'widevine', scheme: 'sample-aes' },
  ].map((disk) => ({ disk, out: drmCfg.resolveDrmFeatures(disk) }));

  fs.writeFileSync(path.join(__dirname, 'transcode_vectors.json'),
    JSON.stringify({ argv, ladders, bitrates, widths, masters, rawKeys, shakaJobs, drm }, null, 1) + '\n');
  console.log(`wrote ${argv.length} argv vectors`);
})();
