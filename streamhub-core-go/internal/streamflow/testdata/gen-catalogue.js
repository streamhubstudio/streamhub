// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0). Its output is EMBEDDED
// in the binary and is now the SOURCE of truth — edit it directly; this script
// only documents where it came from.
//
// Regenerates boxes.json / dangerous.json / events.json (embedded by
// catalogue.go) from the Node core build, so the palette and the event
// catalogue stay byte-identical. Run from the repo root after `npm run build`:
//   node streamhub-core-go/internal/streamflow/testdata/gen-catalogue.js
const fs = require('node:fs');
const path = require('node:path');
const dist = path.join(__dirname, '../../../../streamhub-core/dist/modules/streamflow/boxes');
const { BOX_CATALOGUE, DANGEROUS_BOXES } = require(path.join(dist, 'catalogue.js'));
const { EVENT_CATALOGUE } = require(path.join(dist, 'event-catalogue.js'));
const out = path.join(__dirname, '..');
fs.writeFileSync(path.join(out, 'boxes.json'), JSON.stringify(BOX_CATALOGUE));
fs.writeFileSync(path.join(out, 'dangerous.json'), JSON.stringify(DANGEROUS_BOXES));
fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(EVENT_CATALOGUE));
