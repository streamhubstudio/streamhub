// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0). Its output is EMBEDDED
// in the binary and is now the SOURCE of truth — edit it directly; this script
// only documents where it came from.
//
// Dumps the Node sample TEMPLATES (placeholders unresolved) into this dir and
// writes the cross-runtime goldens into ../testdata. Run from streamhub-core
// after `npm run build`:
//   node ../streamhub-core-go/internal/samples/templates/gen.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dist = path.join(process.cwd(), 'dist/modules/samples');
const { SAMPLE_FILES, TEMPLATES, renderPlaceholders } = require(path.join(dist, 'sample-templates'));
const eb = require(path.join(dist, 'example-bundle'));
const { createZip } = require(path.join(dist, 'zip'));
const { ExamplesService } = require(path.join(dist, 'examples.service'));

for (const f of SAMPLE_FILES) fs.writeFileSync(path.join(__dirname, f), TEMPLATES[f]);
fs.writeFileSync(path.join(__dirname, 'files.json'), JSON.stringify(SAMPLE_FILES, null, 2) + '\n');

const td = path.join(__dirname, '..', 'testdata');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Server-rendered pages for one context (incl. an unknown key left as-is).
const ctx = {
  APP: 'live', ROOM: 'live-room', WS_URL: 'wss://m.example', API_URL: 'https://x.example/api/v1',
  ADAPTOR_URL: 'https://x.example/sdk/streamhub-adaptor.global.js', HLS_URL: 'https://x.example/hls/live',
};
const rendered = {};
for (const f of SAMPLE_FILES) rendered[f] = renderPlaceholders(TEMPLATES[f], ctx);
rendered['_unknown'] = renderPlaceholders('{{APP}} {{NOPE}} {{lower}} {{ROOM}}', ctx);
fs.writeFileSync(path.join(td, 'rendered.json'), JSON.stringify({ ctx, pages: rendered }, null, 1));

// Example bundles: per-app context and the placeholder context.
const appCtx = { app: 'live', room: 'li"ve ', baseUrl: 'https://x.example', wsUrl: 'wss://m.example' };
const bundles = { app: eb.buildAllBundles(appCtx), placeholder: eb.buildAllBundles() };
fs.writeFileSync(path.join(td, 'bundles.json'), JSON.stringify({ appCtx, bundles, catalogue: eb.EXAMPLE_BUNDLES }, null, 1));

// Zip vectors.
const vectors = [
  [],
  [{ name: 'a.txt', data: 'hello' }],
  [{ name: 'dir/ñ.md', data: 'ünï\ncode' }, { name: 'empty', data: '' }],
].map((entries) => {
  const b = createZip(entries);
  return { entries, base64: b.toString('base64') };
});
// zipOne / zipAll through the service with a stub SamplesService.
const svc = new ExamplesService({ exampleContext: async () => appCtx });
(async () => {
  const one = await svc.zipByName('live', 'webrtc-play.zip');
  const all = await svc.zipByName('live', 'all.zip');
  fs.writeFileSync(path.join(td, 'zips.json'), JSON.stringify({
    vectors,
    one: { filename: one.filename, length: one.buffer.length, sha256: sha(one.buffer) },
    all: { filename: all.filename, length: all.buffer.length, sha256: sha(all.buffer) },
  }, null, 1));
})();
