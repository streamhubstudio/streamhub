// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Regenerate urlencoded_vectors.json from the Node core's body-parser/qs:
//   node internal/platform/httpx/testdata/gen_urlencoded.js ../streamhub-core
const path = require('path');
const nodeDir = path.resolve(process.argv[2] || '../streamhub-core');
const qs = require(path.join(nodeDir, 'node_modules/qs'));
const inputs = [
  'a=1', 'a=1&b=2', 'a=1&a=2', 'a=1&a=2&a=3', 'a', 'a=', '=x', '&&a=1&&', 'a+b=c+d', 'a%20b=%41',
  'bad=%E0%A4%A', 'bad=%FF', 'a[b]=c', 'a[b][c]=d', 'a[]=1&a[]=2', 'a[0]=x&a[1]=y', 'a[1]=y&a[0]=x',
  'a[5]=x', 'a[101]=x', 'a[100]=x', 'a[-1]=x', 'a[01]=x', 'a[b]=1&a=2', 'a=2&a[b]=1', 'a[]=1&a[b]=2',
  'a[b]=1&a[]=2', 'a[0][b]=1&a[0][c]=2', 'a[0][b]=1&a[1][b]=2', '[a]=b', 'a[b=c', 'a]=b', 'a[b]c=d',
  'a[b][]=1&a[b][]=2', 'x[__proto__]=1', 'a[ ]=1', 'a[b][c][d][e][f]=1', '2=x&b=y&1=z',
  'slug=form-tag&label=Form+Tag&kind=custom', 'config[zones][0][id]=a&config[zones][0][points][0][0]=0',
  'a=1&a[]=2', 'a[]=1&a=2', 'a[0]=1&a=2', 'a=%26%3D', 'a=%', 'a[0]=1&a[0]=2', 'a[]=&a[]=',
  'k' + '[x]'.repeat(32) + '=v', 'k' + '[x]'.repeat(33) + '=v', 'k' + '[x]'.repeat(32) + 'tail=v',
];
const out = inputs.map((input) => {
  const count = input.split('&').length;
  try {
    const v = qs.parse(input, { allowPrototypes: true, arrayLimit: Math.max(100, count), depth: 32,
      charsetSentinel: false, interpretNumericEntities: false, charset: 'utf-8', parameterLimit: 1000, strictDepth: true });
    return { input, json: JSON.stringify(v) };
  } catch (e) {
    return { input, error: e instanceof RangeError ? 'depth' : String(e) };
  }
});
require('fs').writeFileSync(path.join(__dirname, 'urlencoded_vectors.json'), JSON.stringify(out, null, 1) + '\n');
