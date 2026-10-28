# Parity harness (Go core ↔ the recorded NestJS oracle)

The HTTP contract of the Go core is pinned by a request corpus
(`cases/<module>.json`, ~1.3k cases) and by the responses the legacy NestJS core
(the **oracle**) gave to it, recorded in `golden/<module>.json`. The oracle
itself was retired from `main`; it lives on in branch `legacy/node-2.x`
(tag `2.24.0`) and is only needed to re-record.

```bash
# from streamhub-core-go/ — needs plugins-vendor/ composed exactly as apps.lock.json pins
go build -o bin/streamhub ./cmd/streamhub
go run ./cmd/parity -go ./bin/streamhub          # replay (the default): Go vs golden/
```

No Node, Redis, LiveKit, SMTP or network. A full replay takes ~10 s. CI runs it
(`parity` job in `.gitlab-ci.yml`). Build the binary without the
`-X …/version.Override` ldflag (or the reported version won't be the fixed parity
one, see below).

## Modes

| Mode | Boots | Does |
|---|---|---|
| `-replay` (default) | Go | seeds the fixture through Go, runs the corpus, diffs every response against `golden/` |
| `-record` | Node | seeds through Node, runs the corpus, (re)writes `golden/` + `golden/_meta.json`; refuses to write if the oracle broke a case's `expectStatus` |
| `-live` | Node + Go | the original side-by-side differential (both on copies of one Node-seeded fixture) |

`-record` and `-live` need the oracle: `git worktree add ../node2 legacy/node-2.x`,
then `npm ci && npm run build` in `../node2/streamhub-core`, and pass
`-node ../node2/streamhub-core`. They use that build's `dist/plugins-vendor`
(what Node loads) for both cores.

| Flag | |
|---|---|
| `-go`, `-node`, `-node-bin` | the binaries (`-go` default `./bin/streamhub`) |
| `-vendor <dir>` | composed apps both cores load (replay default `<repo>/plugins-vendor`) |
| `-module auth` | one case file |
| `-case <name>` | report one case; the earlier cases of its file still run (they set up state and captures) |
| `-accept` | replay only: overwrite the selected cases' golden entries with Go's responses (`"source": "go"`) |
| `-keep` | keep the temp root: `seed-data/`, `data-<side>[-n]/`, `logs/`, `fixture.json` |
| `-env K=V` | extra server env (repeatable) |
| `-v` | print passing/skipped cases too |
| `-cases`, `-golden` | dir overrides |

Exit code: `0` all pass, `1` any diff or case error, `2` harness/boot failure.

## Golden files

`golden/<module>.json` holds one entry per case, in case order:

```jsonc
{
  "name": "tokens-create-global",
  "fingerprint": "sha256:…",   // of the case's request + comparison knobs (+ file defaults/env)
  "request": {"method": "POST", "path": "/api/v1/tokens", "auth": "adminJwt", "body": {…}},
  "status": 201,
  "headers": {"content-type": "application/json;charset=utf-8", "ratelimit": null},  // compared headers; null = absent
  "bodyKind": "json",          // json | text | absent (compare:"status")
  "body": {"id": 4, "token": "{{newToken}}"}                                           // normalized
}
```

The stored response is exactly what the comparison looks at, already
normalized (see below), so a replay diff is identical to what the live diff
would print. JSON keys are sorted; re-recording an unchanged contract is a
no-op diff. `_meta.json` records the vendor digest: replay refuses to run on a
different composition of the decoupled apps (their manifests show up in the
plugin catalog responses).

Replay reports a case as **ERROR** when its golden entry is missing (new case)
or its fingerprint no longer matches (the case changed after recording). Notes,
`skip` and `expectStatus` are not part of the fingerprint.

### Changing the contract after the oracle

The recording is the contract. A deliberate deviation from Node:

1. change the Go code and record the reason in `planning/GO-DIVERGENCES.md`;
2. `go run ./cmd/parity -go ./bin/streamhub -module <m> [-case <c>] -accept`;
3. review the golden diff in the commit — accepted entries carry `"source": "go"`.

A new or edited case has no oracle answer either: write it, review Go's answer
(`-v`, or `-keep` and the logs), then `-accept`. Re-record from
`legacy/node-2.x` only when you want the oracle's own answer.

## What a run does

1. **Fixture** — boots one core (Node for `-record`/`-live`, Go for `-replay`)
   on an empty `DATA_DIR` (signup temporarily open), seeds a global token with
   that runtime's seed tool (`scripts/seed-token.js` /
   `streamhub-core seed-token`, stdin form), then through its own API:
   break-glass admin login, an app-scoped token on the default app `live`, a
   revoked global token, and a team: owner (signup) + viewer and editor
   (invited, then completing signup). The server is stopped (SIGTERM → WAL
   checkpoint). Captured values land in `fixture.json`.
2. The seed is copied once per server (`data-node/`, `data-go/`); each server
   gets its own cwd holding a fixed `VERSION` (`99.0.0-parity`, exposed as
   `{{appVersion}}`), so releases never churn the recording. Node also writes
   `openapi.json` into its cwd.
3. The servers boot on free loopback ports with the env below and are polled
   on `/api/v1/health`.
4. Each case file runs in filename order, case by case. Files share the
   servers (state carries across files) unless they set an `env` (below).

Env (`cmd/parity/fixture.go:baseEnv`): `NODE_ENV=production`,
`ADMIN_USER=admin`, `ADMIN_PASS=parity-admin-pass`,
`STREAMHUB_JWT_SECRET=parity-jwt-secret-0123456789abcdef`,
`REDIS_URL=redis://127.0.0.1:63999` (dead port), empty `LIVEKIT_*`,
`STREAMHUB_AUTHZ_ENFORCE=on`, `STREAMHUB_PUBLIC_REGISTRATION=off`,
`STREAMHUB_IP_ACCESS_MODE=off`, `AUTH_RATE_LIMIT_MAX=50`,
`AUTH_RATE_LIMIT_WINDOW_MS=900000`, `STREAMHUB_BACKUPS_ENABLED=false`,
`STREAMHUB_PLUGINS_VENDOR_DIR=<vendor>`, plus `PORT/HOST=127.0.0.1/DATA_DIR`.
Only `PATH/HOME/TMPDIR` leak from your shell.

## Variables

Placeholders `{{name}}` work in `path`, `headers`, `body` and `rawBody`. A body
string that is exactly `"{{name}}"` is replaced by the value with its JSON type
(numbers stay numbers). Each side keeps its own variable set: the fixture
values plus that side's captures.

Fixture: `adminUser adminPass adminJwt globalToken appToken appTokenId
revokedToken revokedTokenId liveAppId ownerEmail ownerPass ownerJwt ownerUserId
ownerTenantId viewerEmail viewerPass viewerJwt viewerUserId editorEmail
editorPass editorJwt editorUserId appVersion`; per side: `dataDir`.

## Case format (`cases/<module>.json`)

```jsonc
{
  "module": "auth",
  "env": {"STREAMHUB_CLUSTER_TOKEN": "x"}, // optional: extra server env for this file (see below)
  "defaults": {                         // merged into every case
    "headers": {},                      // request headers
    "compareHeaders": ["content-type"], // response headers to diff
    "maskHeaders": [], "ignore": [], "mask": []
  },
  "cases": [{
    "name": "tokens-create-global",     // unique in the file
    "note": "free text",
    "skip": "reason",                   // non-empty → skipped (infra: SMTP, LiveKit, side effects)
    "method": "POST",
    "path": "/api/v1/tokens",
    "auth": "adminJwt",                 // shorthand for Authorization: Bearer {{adminJwt}}
    "headers": {"X-Foo": "{{var}}"},
    "body": {"name": "x", "appId": "{{liveAppId}}"},   // or "rawBody": "verbatim text"
    "sleepMs": 5,                       // wait before sending (wall-clock-keyed state)
    "expectStatus": 201,                // asserted on the ORACLE (-record/-live): guards the corpus itself
    "compare": "json",                  // json (default) | text | status (status+headers only)
    "compareHeaders": ["location"],
    "maskHeaders": ["content-length"],  // compared header whose VALUE is masked (presence still compared)
    "ignore": ["data.ts"],              // dropped on both sides (absence not checked)
    "mask": ["data.*.id"],              // value replaced by <masked> (presence still checked)
    "unordered": ["data"],              // array compared as a multiset
    "strict": false,                    // true = no generic normalizers
    "capture": {"newTokenId": "id", "sid": "data.[current=true].id", "loc": "header:Location"}
  }]
}
```

Paths are dotted (`data.entries.0.ts`), `*` matches every key/element, the root
is `$`; captures also accept `[key=value]` to pick an array element.

### Per-file env

A file may set `"env"` (string → string), overlaid on the base env (and any
`-env` flags). Files with no `env` share the default servers; each distinct
`env` gets its own, booted on a **fresh copy of the seeded fixture**
(`data-<side>-<n>/`, `logs/<side>-<n>.log`) after the default group has run.
Use it for boot-time behaviour (e.g. `STREAMHUB_CLUSTER_TOKEN` for
`cluster.json` / `edge.json`) without disturbing every other file.

## Normalization and comparison

Per side, before diffing:

1. `ignore` / `mask` paths.
2. Reverse variable substitution: a string equal to a known variable value
   (≥ 6 chars) becomes `{{name}}`; longer values (≥ 12) are also replaced as
   substrings. So ids/JWTs each side captured independently line up — and a
   value captured earlier pins every later occurrence (e.g. a bundle sha256
   that must match its listing).
3. Generic normalizers (off with `strict`): JWT → `<jwt>`, `sk_…` →
   `<sk_token>`, ISO-8601 → `<iso-ts>`, SQLite `YYYY-MM-DD HH:MM:SS` →
   `<sql-ts>`, UUIDs → `<uuid#N>` numbered by first appearance. ISO vs SQLite
   formats stay distinct — Node mixes them and that is contract.
4. Headers: `content-type` compared case/space-insensitively (charset
   included), `RateLimit … reset=N` → `reset=<n>`, `maskHeaders` → `<masked>`.

Then: status equal; each compared header equal (missing on one side is a
diff); bodies deep-equal with key order ignored, **null vs missing is a diff**,
array order significant unless `unordered`.

Known irreproducible bytes (gzip framing of bundles/exports, V8 error texts)
are masked in the cases that touch them — see `planning/GO-DIVERGENCES.md`.
