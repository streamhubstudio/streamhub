// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates recording_vectors.json from the Node core's dist build: the
// ffprobe/ffmpeg argv of media.util (execFile stubbed BEFORE the require),
// probeMedia's parse of canned ffprobe output, renderFilenameTemplate with a
// fixed clock, and RecordingService's download filename / content type.
// Run from the repo root: node streamhub-core-go/internal/recording/testdata/gen-recording-vectors.js
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

let next = '';
const calls = [];
cp.execFile = (bin, args, _opts, cb) => {
  calls.push({ bin, args: [...args] });
  if (next instanceof Error) cb(next, '');
  else cb(null, next);
};

const core = path.resolve(__dirname, '../../../../streamhub-core/dist/modules/recording');
const media = require(path.join(core, 'media.util.js'));
const tpl = require(path.join(core, 'filename-template.js'));
const { RecordingService } = require(path.join(core, 'recording.service.js'));

(async () => {
  const probes = [];
  const outputs = [
    JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac', duration: '9.5' }, { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '12.345' }], format: { duration: '13', format_name: 'mov,mp4' } }),
    JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '61.2xyz', format_name: 'mp3' } }),
    JSON.stringify({ streams: [{ codec_type: 'video', width: 640 }], format: {} }),
    JSON.stringify({ format: { duration: 'N/A' } }),
    'not json',
    new Error('spawn ffprobe ENOENT'),
  ];
  for (const out of outputs) {
    next = out;
    calls.length = 0;
    const res = await media.probeMedia('/data/apps/live/recordings/a b.mp4');
    probes.push({ output: out instanceof Error ? null : out, failed: out instanceof Error, argv: calls[0], result: res });
  }
  next = '';
  calls.length = 0;
  await media.extractSnapshot('/in.mp4', '/out.jpg', 1);
  await media.extractSnapshot('/in.mp4', '/out.jpg', -3);
  await media.extractSnapshot('/in.mp4', '/out.jpg', 2.5);
  const snapshots = calls.map((c) => c);

  const now = new Date(Date.UTC(2026, 0, 5, 7, 8, 9));
  const templates = [
    '', '   ', '${app}_${room}_${streamId}', '${app}/${streamId}', '${date:yyyy-MM-dd_HHmmss}-${type}', '${date:yyMMdd}',
    '${var.site}-${var.missing}-${ts}', '${unknown}x${ app }', '../../${var.evil}/../x', '${room}.${type}',
    '-..weird..name--', 'ñandú 😀 ${app}', `${'a'.repeat(250)}.-`, '${date:yyyy}${date:MM}', '..${var.dots}..',
  ].map((t) => ({
    template: t,
    out: tpl.renderFilenameTemplate(t, { app: 'live', streamId: 'cam/1', room: 'live-room', type: 'mp4',
      variables: { site: 'hq', evil: '../../etc/passwd', dots: '....' }, now }),
  }));

  const svc = Object.create(RecordingService.prototype);
  const vods = [
    { name: 'cam-1.mp4', room: 'r', format: 'h264' },
    { name: 'Weird "name"\n.MKV', room: null, format: null },
    { name: '  ', room: 'Room 1', format: 'h264' },
    { name: '', room: '', format: null },
    { name: '.hidden', room: 'r', format: 'mp4' },
    { name: 'a.b.c.webm', room: 'r', format: null },
    { name: 'ñandú/ünï.mov', room: 'r', format: null },
    { name: '---', room: 'r', format: null },
  ].map((v) => ({ vod: v, out: svc.downloadFilename(v, 42) }));
  const types = ['/x/a.mp4', '/x/a.WEBM', '/x/a.mkv', '/x/a.mov', '/x/a.ts', '/x/.mp4', '/x/a'].map((p) => ({ path: p, out: svc.rawContentType(p) }));

  fs.writeFileSync(path.join(__dirname, 'recording_vectors.json'),
    JSON.stringify({ probes, snapshots, templates, now: now.toISOString(), downloads: vods, types }, null, 1) + '\n');
  console.log('wrote recording vectors');
})();
