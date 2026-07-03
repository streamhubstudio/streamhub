// Seed a global API bearer token (sk_...) into the StreamHub global DB.
// Runs INSIDE the core container (has better-sqlite3 + the migrated DB):
//   printf '%s' "$TOKEN" | docker compose exec -T core node deploy/seed-token.js - [name]
//   docker compose exec -T core node deploy/seed-token.js <sk_token> [name]
//
// Prefer the stdin form ("-"): the token never appears in any argv/cmdline.
// Idempotent: if any non-revoked global token already exists, it does nothing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let token = process.argv[2];
if (!token || token === '-') {
  try {
    token = fs.readFileSync(0, 'utf8').trim();
  } catch {
    token = '';
  }
}
const name = process.argv[3] || 'bootstrap';
if (!token) {
  console.error('usage: seed-token.js <token> [name]');
  process.exit(2);
}

const dataDir = process.env.DATA_DIR || '/data';
const file = path.join(dataDir, 'data', 'streamhub.db');
const db = new Database(file);

const existing = db
  .prepare("SELECT COUNT(*) AS c FROM api_tokens WHERE scope='global' AND revoked=0")
  .get();
if (existing.c > 0) {
  console.log('global api_token already present — skipping seed');
  process.exit(0);
}

const hash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare(
  "INSERT INTO api_tokens(name, token_hash, scope, app_id) VALUES(?, ?, 'global', NULL)"
).run(name, hash);
console.log('seeded global api_token:', name);
