// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0). Its output is EMBEDDED
// in the binary and is now the SOURCE of truth — edit it directly; this script
// only documents where it came from.
//
// Renders the Node sample pages with sentinel values into *.tmpl.html (run
// from streamhub-core: node ../streamhub-core-go/internal/apps/samples/gen.js).
// Each sentinel carries a '&' so its escaped (@@X&amp;@@) and raw (@@X&@@)
// occurrences stay distinguishable; samples.go substitutes them.
const fs = require('fs');
const path = require('path');
const { renderSamplePages } = require(path.join(process.cwd(), 'dist/modules/apps/sample-pages'));
const pages = renderSamplePages({
  appName: '@@A&@@', roomName: '@@R&@@', publicBaseUrl: '@@B&@@',
  publicWsUrl: '@@W&@@', apiBase: '@@P&@@',
});
for (const k of ['publish', 'play', 'embed']) {
  fs.writeFileSync(path.join(__dirname, `${k}.tmpl.html`), pages[k]);
}
// Golden for a realistic context (samples_test.go).
const real = renderSamplePages({
  appName: 'live', roomName: 'li<v>e"&', publicBaseUrl: 'https://x.example/',
  publicWsUrl: 'wss://m.example', apiBase: 'https://x.example/api/v1/',
});
fs.writeFileSync(path.join(__dirname, 'golden.json'), JSON.stringify(real, null, 2));
