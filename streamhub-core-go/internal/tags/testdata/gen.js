// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Node vectors for tags (run from streamhub-core after `npm run build`):
//   node ../streamhub-core-go/internal/tags/testdata/gen.js
// config: JSON.stringify(JSON.parse(input)) — the stored/served config_json.
// merge: resolveStreamSettings(defaults, tags, overrides) from dist.
const fs = require('fs');
const path = require('path');
const { resolveStreamSettings } = require(path.join(process.cwd(), 'dist/modules/tags/settings-merge'));
const configs = [
  '{"b":1,"2":"x","10":true,"a":{"z":1.50,"y":[1e2,-0.0,"<&>"]},"b":2}',
  '{"z":1,"1":2,"nested":{"k":[{"a":1}]},"4294967295":0,"01":1}',
  '{"s":"\\u2028 \\u0001 é 😀","n":1e21,"m":0.0000001,"neg":-1.5e-7}',
];
const merges = [
  [{ fps: 1, roi: { x: 0, y: 0 }, classes: ['a'] }, [{ fps: 3, roi: { y: 5 } }, { classes: ['b', 'c'] }], { roi: { w: 9 } }],
  [{ a: { b: 1 } }, [{ a: [1, 2] }], { a: { c: 2 } }],
  [undefined, [null, 5, { k: null }], undefined],
  [{ "2": 1, b: 1 }, [{ a: 1, "1": 0 }], {}],
];
const out = {
  config: configs.map((input) => ({ input, output: JSON.stringify(JSON.parse(input)) })),
  merge: merges.map(([d, t, o]) => ({ defaults: d ?? null, tags: t, overrides: o ?? null, output: JSON.stringify(resolveStreamSettings(d, t, o)) })),
};
fs.writeFileSync(path.join(__dirname, 'node_vectors.json'), JSON.stringify(out, null, 2) + '\n');
