# StreamHub app package format

The on-the-wire contract for a **decoupled Studio App**: the tar.gz a StreamHub
core composes into its build, how it is pinned + verified, and how it is
produced. This is the reference the tooling — `streamhub-core apps pack|pull|bump`,
built into the core binary (`streamhub-core-go/internal/appstool`; it replaced
`scripts/apps-*.mjs` in 3.x) — and an app repo's CI both implement.

From a checkout, run it without installing anything but Go:

```bash
cd streamhub-core-go && go run ./cmd/streamhub apps <pull|pack|bump> …
```

The repo root is found by walking up from the cwd to the nearest `apps.lock.json`
(override: `STREAMHUB_REPO_ROOT`).

`lpr` is the live pilot: it lives in its own repo
(`gitlab:digitalhub_com_ar/streamhub-app-lpr`), ships releases from its own CI,
and is composed into this repo from a pinned release — see the worked example at
the bottom. `deface` followed as the second decoupled app
(`gitlab:digitalhub_com_ar/streamhub-app-deface`) — same contract, but with **no
worker SQLite** (so no `streamhub_sdk/` migration runner and no `storage`/
`migrations` in its manifest). Background: [`planning/APP-DECOUPLING-PLAN.md`](../../planning/APP-DECOUPLING-PLAN.md).

## The bundle (tar.gz)

A package is a **gzipped USTAR** archive whose ROOT holds:

```
streamhub.app.json     the PUBLISHED manifest (the `build` block stripped)
worker/                the Python worker package, self-contained:
                         <pkg>_worker/          the module (incl. migrations/)
                         streamhub_sdk/         the vendored SDK (migration runner)
                         requirements.txt
frontend/              the web PluginModule SOURCE (index.tsx, api.ts, util.ts …);
                       *.spec.ts are dropped
migrations/            (optional) NNN_*.sql, when not carried inside worker/<pkg>/migrations/
```

- **No executable JavaScript for the core.** The backend is the declarative
  `streamhub.app.json` only; the core runs it through the spawn-template
  interpreter (`spawn-template.ts`), never `require()`-ing package code. The
  worker is a subprocess, exactly as an in-tree app's worker is.
- **The published manifest drops the `build` block** (monorepo/CI glue) and keeps
  `worker.workerDir` **package-relative** (`"worker"`) — it stays relative all the
  way to runtime: the registry resolves it against the vendored package's own
  directory, so a composed core is fully **portable** (no absolute host paths are
  ever baked into a build artifact).
- **The worker is self-contained**: it imports `streamhub_sdk` off its own
  `PYTHONPATH` (=`worker/`), so the SAME bytes run co-located inside a core OR
  standalone on an edge box.

### Determinism & the content hash

The **uncompressed tar** MUST be byte-reproducible: sorted entries, fixed
mtime (0), uid/gid 0. Both the monorepo packer and the app-repo CI use the same
writer — `internal/appstool` (`streamhub-core apps pack`), byte-identical to the
former `scripts/lib/tar.mjs` that the app repos' `ci/pack.mjs` still mirror (locked
by Node-generated vectors + a rebuild of every pinned release) — so a package packed
either place extracts identically on the core. Directory entries are ordered with
`String#localeCompare` (ICU root collation, **not** byte order: `_` < `-` < `.`,
case-insensitive first) — any re-implementation must do the same or every pin flips. Caches/compiled/db files and
anything > 5 MiB (model weights) are excluded.

**The lock's `sha256` is the hash of the UNCOMPRESSED tar, NOT the `.tar.gz`.**
gzip is *not* reproducible across zlib versions/platforms — a re-run release
pipeline re-uploads the same tar wrapped in different gzip bytes, which would
flip a gzip-hash lock and silently break the build (this bit people-counter
once). The tar itself is deterministic, so `apps-pull` gunzips the download and
hashes the tar before comparing to the lock (fail-closed on mismatch). When you
pin an app in the lock, compute the value with `curl … | gunzip | sha256sum`
(the deterministic tar), not from the CI `.tar.gz` sidecar.

## The lock — `apps.lock.json`

A committed array pinning each composed app to an exact version **and sha256**:

```json
[
  { "id": "lpr",
    "repo": "gitlab:digitalhub_com_ar/streamhub-app-lpr",
    "version": "0.1.0",
    "sha256": "b6111741434675d8c55783d23fb7ece02183df95a9f1ea5279871ea2986d1b33" }
]
```

The lock is the build's source of truth: it is auditable, reproducible, and CI
**never** resolves "latest" on its own. `streamhub-core apps bump [--write]` is the explicit,
human-run "use the newest stable release" command — it queries releases,
downloads the asset to compute the new sha256, and updates the lock for review.

### Sources

`repo` (or an overriding `source`) selects how `apps pull` fetches the bytes:

| Source | Meaning | Auth |
|---|---|---|
| `file:./path.tar.gz` | a local tarball (offline / pilot) | — |
| `https://…` | a direct tarball URL | — |
| `gitlab:group/project` | a GitLab **release** asset | `STREAMHUB_APPS_TOKEN` (env) |

For `gitlab:`, `apps pull` downloads the deterministic generic-package URL
`<host>/api/v4/projects/<group%2Fproject>/packages/generic/streamhub-app-<id>/<version>/streamhub-app-<id>-<version>.tar.gz`
(`<host>` = `STREAMHUB_APPS_GITLAB_HOST`, default `https://gitlab.com`) — no
`read_api` call, so a read-only **deploy token** (`read_package_registry`) is
enough. A `gldt-…` token authenticates with the `Deploy-Token` header, any other
(`glpat-…`, handy locally) with `PRIVATE-TOKEN`. The token is read from **`STREAMHUB_APPS_TOKEN`
in the environment only** — never the lock, never a URL, never logs. A private
source with **no token fails closed** with a clear message (it never silently
skips a pinned app in a real build).

## Composing — `apps pull`

```bash
STREAMHUB_APPS_TOKEN=<token> streamhub-core apps pull
# from a checkout: (cd streamhub-core-go && go run ./cmd/streamhub apps pull)
```

For each lock entry it downloads the package, **verifies its sha256 against the
lock (fail-closed on mismatch)**, extracts to `vendor/apps/<id>/` (gitignored),
then links the parts into the auto-discovery paths:

- backend → `plugins-vendor/<id>/` at the **repo root** (gitignored) holding the
  manifest **plus the worker source copied alongside it** (`<id>/worker/**`).
  `worker.workerDir` stays package-relative and the registry resolves it against
  the package dir, so the composed backend is **self-contained**: the image and
  the native bundle copy `plugins-vendor/` next to the core binary, which is
  where the registry looks — composition happens at **pack time**,
  and production needs no token, no network, no `apps pull`;
- frontend → `streamhub-web/src/plugins-vendor/<id>/**` (globbed by
  `discovery.ts` at SPA build time; single-`../` framework imports are rewritten
  to resolve from the vendor dir).

The appstore/export worker-source resolution prefers the vendored package's own
`worker/` (version-pinned by the lock) over `STREAMHUB_WORKER_SRC_ROOT`, so a
stale operator copy of a worker can never shadow the pinned release.

On an id that ALSO exists in-tree (a built-in), **the in-tree copy wins**: the
registry skips the vendored one with a warning, and `apps pull` flags it as
shadowed (composing never silently shadows a shipped app).

### The composed build in tests

The `core-go` CI job runs `streamhub-core apps pull` as a **lock gate** (every pin
downloads and matches its content sha256) when `STREAMHUB_APPS_TOKEN` is set — a
protected variable, so on protected refs only; the Go unit tests stay hermetic
(httptest fakes, no network). The legacy oracle's `pretest` still composes the
locked apps (via the Go command) **only when the token is set**. Specs that assert a decoupled app's presence read from the
vendored dir and **skip when it isn't composed**, running at full strength in CI
(where the token is set) — the always-in-tree `presence` app is the interpreter's
living witness so the machinery is never left untested. Set `STREAMHUB_APPS_TOKEN`
as a masked CI variable in the monorepo for the composed-build gate.

## Producing a release (app repo CI)

An app repo's CI, on a git tag `v<version>` (matching `streamhub.app.json`'s
`version`), builds the deterministic bundle, then publishes:

- the bundle `streamhub-app-<id>-<version>.tar.gz` **+ a `.sha256` sidecar** as
  **GitLab Release assets** (uploaded to the generic package registry so their
  URLs are token-fetchable), on the tag.

`apps pull` (and `apps bump`) resolve exactly those assets. The monorepo then
pins `{ id, repo: gitlab:…, version, sha256 }` and composes it.

## Worked example — `lpr`

```
streamhub-app-lpr/            # its own repo (own CI, own version)
├── streamhub.app.json        # build: { workerSrc: "worker", frontendSrc: "frontend" }
├── worker/                   # lpr_worker/ + vendored streamhub_sdk/ + requirements.txt + tests/
├── frontend/                 # index.tsx, api.ts, util.ts (+ util.spec.ts, dropped from the bundle)
└── ci/pack.mjs               # the deterministic packer (a mirror of the former scripts/lib helpers;
                              #   `streamhub-core apps pack --manifest …` produces the same bytes)
```

- The monorepo's `apps.lock.json` pins `gitlab:digitalhub_com_ar/streamhub-app-lpr@0.1.0`
  with the release's sha256.
- `STREAMHUB_APPS_TOKEN=<token> streamhub-core apps pull` composes it; the core
  boots with `lpr` in the catalog **identically** to when it was a built-in
  (same `kind`/`exportable`/`edge`/`storage`/spawn).

An app repo's CI can pack with the released core binary instead of its own
`ci/pack.mjs` (same bytes, so existing pins stay valid):

```bash
# version = $CI_COMMIT_TAG (v-stripped), else the manifest's; writes
# <out>/streamhub-app-<id>-<version>.tar.gz + .sha256 (content hash)
streamhub-core apps pack --manifest streamhub.app.json \
  --worker worker --frontend frontend [--worker-sdk DIR] [--migrations DIR] --out dist
```

The monorepo's old in-tree authoring flow (`apps-pack.mjs <id>` reading a `build`
block that pointed at scattered in-tree sources) is gone: every app lives in its
own repo, and `apps pack` only takes explicit sources.
