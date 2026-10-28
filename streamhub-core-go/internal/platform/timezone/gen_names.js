// Generates names.txt: every IANA zone name the Node core's isValidTimezone
// accepts (Intl.supportedValuesOf + every zoneinfo link V8's ICU resolves).
// Run: node internal/platform/timezone/gen_names.js /usr/share/zoneinfo > internal/platform/timezone/names.txt
const fs = require('fs');
const path = require('path');
const root = process.argv[2] || '/usr/share/zoneinfo';
const names = new Set(Intl.supportedValuesOf('timeZone'));
names.add('UTC');
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
    if (!/^[A-Z]/.test(e.name)) continue;
    try { new Intl.DateTimeFormat('en-US', { timeZone: r }); names.add(r); } catch {}
  }
})(root, '');
process.stdout.write([...names].sort().join('\n') + '\n');
