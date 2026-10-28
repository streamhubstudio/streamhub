// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates node_vectors.json from the compiled Node passthrough utils:
//   node internal/passthrough/testdata/gen-vectors.js ../streamhub-core
// (run from streamhub-core-go/; the arg is the streamhub-core dir, built).
const path = require('path');
const fs = require('fs');

const core = path.resolve(process.argv[2] || '../streamhub-core');
const dist = (m) => require(path.join(core, 'dist/modules/passthrough', m));
const { buildRemuxArgs, buildForwardArgs, passthroughHlsDir } = dist('remux-args.util');
const { parseMpegtsSource } = dist('mpegts-source.util');
const { classifyMediamtxPath } = dist('mediamtx-path.util');

const remux = [
  { app: 'live', streamKey: 'ptk_abc', port: 1937, hlsDir: '/data/apps/live/hls/live-ch1' },
  { app: 'live', streamKey: 'ptk_abc', port: 1938, hlsDir: '/data/apps/live/hls/live-ch1', transport: 'rtmp' },
  { app: 'tv', streamKey: 'ptk_s', port: 1940, hlsDir: '/d/apps/tv/hls/tv-x', transport: 'srt' },
  { app: 'tv', streamKey: 'ptk_p', port: 1935, hlsDir: '/d/apps/tv/hls/tv-x', mode: 'pull' },
  { app: 'tv', streamKey: 'ptk_p', port: 1935, hlsDir: '/d/apps/tv/hls/tv-x', mode: 'pull', pullHost: '10.0.0.2' },
  { app: 'tv', streamKey: 'ptk_m', port: 0, hlsDir: '/d/apps/tv/hls/tv-m', transport: 'mpegts', mode: 'pull', sourceUrl: 'udp://@239.1.1.1:5000?overrun_nonfatal=1' },
  { app: 'tv', streamKey: 'ptk_m', port: 0, hlsDir: '/d/x/', transport: 'mpegts', sourceUrl: 'udp://@:5000?fifo_size=1000&overrun_nonfatal=0' },
  { app: 'a', streamKey: 'k', port: 2000, hlsDir: 'rel/dir', bindHost: '127.0.0.1', hlsTime: 2, hlsListSize: 10 },
  { app: 'a', streamKey: 'k', port: 2000, hlsDir: '', transport: 'srt', bindHost: '::' },
];
const forward = [
  { key: 'sk_live1', sourcePort: 1935, destPort: 11935 },
  { key: 'a/b', sourcePort: 1935, destPort: 11936, host: '10.1.1.1' },
];
const mpegts = [
  { url: 'udp://@239.1.1.1:5000' },
  { url: '  UDP://@239.1.1.1:5000  ' },
  { url: 'udp://@:5000' },
  { url: 'udp://239.1.1.1:5000' },
  { url: 'udp://@10.0.0.1:1234?localaddr=10.0.0.9' },
  { url: 'udp://@232.1.1.1:5000?sources=10.0.0.1,10.0.0.2&block=10.0.0.3' },
  { url: 'udp://@232.1.1.1:5000?sources=10.0.0.1', sources: '10.0.0.7 , 10.0.0.8' },
  { url: 'udp://@232.1.1.1:5000', sources: '' },
  { url: 'udp://@239.1.1.1:5000?fifo_size=50000&overrun_nonfatal=0' },
  { url: 'udp://@239.1.1.1:5000?overrun_nonfatal=true' },
  { url: 'udp://@239.1.1.1:5000?overrun_nonfatal=yes' },
  { url: 'udp://@239.1.1.1:5000?fifo_size=10', fifoSize: 20, overrunNonfatal: false },
  { url: 'udp://@239.1.1.1:5000?localaddr=10.0.0.1', localaddr: ' 10.0.0.2 ' },
  { url: 'udp://@239.1.1.1:5000?localaddr=10.0.0.1', localaddr: '' },
  { url: 'udp://@239.1.1.1:5000?localaddr=%2010.0.0.5%20' },
  { url: 'udp://@239.1.1.1:5000?&&fifo_size=7&' },
  { url: 'udp://@239.1.1.1:5000?fifo_size=' },
  { url: 'udp://@239.1.1.1:5000?fifo_size=1.5' },
  { url: 'udp://@239.1.1.1:5000?fifo_size=abc' },
  { url: 'udp://@239.1.1.1:5000', fifoSize: 100000001 },
  { url: 'udp://@239.1.1.1:5000', fifoSize: 0 },
  { url: 'udp://@239.1.1.1:5000?ttl=4' },
  { url: 'udp://@239.1.1.1:5000?fifo_size' },
  { url: 'udp://@239.1.1.1' },
  { url: 'udp://@239.1.1.1:0' },
  { url: 'udp://@239.1.1.1:65536' },
  { url: 'udp://@239.1.1.1:65535' },
  { url: 'rtp://@239.1.1.1:5000' },
  { url: 'udp://@host.example:5000' },
  { url: 'udp://@239.01.1.1:5000' },
  { url: 'udp://@256.1.1.1:5000' },
  { url: 'udp://@10.0.0.1:5000?sources=10.0.0.2' },
  { url: 'udp://@:5000', block: '10.0.0.2' },
  { url: 'udp://@239.1.1.1:5000', sources: '10.0.0.1,bad' },
  { url: 'udp://@239.1.1.1:5000', sources: Array.from({ length: 17 }, (_, i) => `10.0.0.${i + 1}`).join(',') },
  { url: 'udp://@239.1.1.1:5000', localaddr: 'eth0' },
  { url: 'udp://@239.1.1.1:5000/path' },
  { url: '' },
];
const paths = [
  'myapp/ptk_abc', '/myapp/ptk_abc', '//live/ptk_x', 'live/ptk_abc', 'live/sk_xyz', 'live/a/b', 'live/',
  'myapp/somekey', 'a/b/c', 'single', '', 'live', 'live/ptk_a/b',
];

function attempt(fn) {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: e.message };
  }
}

const out = {
  hlsDir: passthroughHlsDir('/data', 'live', 'live-ch1'),
  remux: remux.map((o) => ({ in: o, args: buildRemuxArgs(o) })),
  forward: forward.map((o) => ({ in: o, args: buildForwardArgs(o) })),
  mpegts: mpegts.map((o) => {
    const r = attempt(() => parseMpegtsSource(o));
    if (r.ok) {
      const p = r.ok;
      return { in: o, sourceUrl: p.sourceUrl, host: p.host, port: p.port, multicast: p.multicast,
        ssmSources: p.ssmSources, blockSources: p.blockSources, localaddr: p.localaddr ?? null,
        fifoSize: p.fifoSize ?? null, overrunNonfatal: p.overrunNonfatal };
    }
    return { in: o, error: r.error };
  }),
  paths: paths.map((p) => ({ in: p, out: classifyMediamtxPath(p) })),
};
fs.writeFileSync(path.join(__dirname, 'node_vectors.json'), JSON.stringify(out, null, 1) + '\n');
