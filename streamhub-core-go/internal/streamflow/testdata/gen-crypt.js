// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates crypt.json: ciphertexts produced by the Node secret-crypt util,
// which the Go decryptSecret must open (and per-app isolation must hold).
//   node streamhub-core-go/internal/streamflow/testdata/gen-crypt.js
const fs = require('node:fs');
const path = require('node:path');
const { encryptSecret, maskSecret } = require(path.join(__dirname,
  '../../../../streamhub-core/dist/modules/streamflow/secret-crypt.util.js'));
const cases = [
  { master: 'parity-jwt-secret-0123456789abcdef', app: 'live', plaintext: 'sk-live-ABCDEFGH1234' },
  { master: 'm', app: 'ñandú', plaintext: '-----BEGIN KEY-----\nñ 😀\n-----END KEY-----' },
  { master: 'x'.repeat(64), app: 'a', plaintext: '' },
];
const out = cases.map((c) => ({ ...c, stored: encryptSecret(c.plaintext, c.master, c.app) }));
const masks = ['', 'abcd', 'abcde', 'sk-live-ABCDEFGH1234', 'ghp_xyz9876', 'xoxb-1-2-3', 'AKIAXXXX', 'plain😀value'].map((v) => ({ v, mask: maskSecret(v) }));
fs.writeFileSync(path.join(__dirname, 'crypt.json'), JSON.stringify({ cases: out, masks }, null, 2) + '\n');
