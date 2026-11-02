# Operations — Install, Upgrade & Release

StreamHub installs as a **single self-contained application** under one folder
(`/opt/streamhub` by default), managed as **one service**. The SFU building
blocks (LiveKit + ingress + egress + redis) are part of the app and are hidden
behind it — the operator never runs raw `docker compose`.

This doc covers the app layout, the `streamhub` CLI, the managed systemd unit,
day-0 install, day-1 upgrade (idempotent, migrated, backed-up, rollback-able),
and the versioning + release pipeline that feeds the landing one-liner.

For the **edge/`--join`** flow and the mechanics of hosting the installer, see
[INSTALL-NODE.md](./INSTALL-NODE.md). For the two deploy *shapes* (Compose+Caddy
vs systemd+nginx) see [DEPLOY.md](./DEPLOY.md).

---

## 1. Folder layout (`$INSTALL_DIR`, default `/opt/streamhub`)

Everything the app owns lives under one directory:

```
/opt/streamhub/
├── VERSION                 # stamped system/release version, e.g. 2.2.0
├── .env                    # config + secrets (mode 600, never committed)
├── .install-profile        # mode=origin|join|cdn-edge, proxy=caddy|nginx, node_ip=auto|off|<ip> (read by the CLI + re-runs)
├── docker-compose.yml      # the stack definition (redis livekit ingress egress core [caddy: `caddy` profile])
├── bin/
│   └── streamhub           # the control CLI (symlinked to /usr/local/bin/streamhub)
├── logs/
│   └── install.log         # every installer run is tee'd here (credential-free)
├── backups/
│   └── <UTCstamp>-v<from>/  # pre-upgrade SQLite snapshots (global + per-app)
├── data/                   # runtime (bind-mounted into core + egress)
│   ├── data/streamhub.db   # global registry DB
│   └── apps/<app>/app.db   # per-app DBs
├── install.sh · uninstall.sh
└── deploy/ · streamhub-core-go/ · streamhub-web/ · ... (source tree)
```

The source tree stays in place; the installer only **adds** the surrounding
structure (`bin/ logs/ backups/`). A re-run/upgrade never touches `.env`,
`data/`, `bin/`, `logs/`, `backups/` or `.install-profile`.

---

## 2. Day-0 install

```bash
# origin (standalone/master) — interactive
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash

# non-interactive
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
    --non-interactive --domain media.example.com --email you@example.com
```

The installer (idempotent) fetches the latest source, writes `.env` with strong
random secrets, builds + starts the stack, seeds the `sk_` API token, installs
the `streamhub` CLI + the managed systemd unit + the heartbeat timer, and stamps
`VERSION`. Flags are unchanged from prior releases — see `install.sh --help`.

New in 2.2.0: `--force-reinstall` (re-run the upgrade steps even when already at
the target version) and a richer `--dry-run` that prints the plan (fresh vs
upgrade vs up-to-date). The install log is at `logs/install.log`.

---

## 3. The `streamhub` CLI

Installed to `/opt/streamhub/bin/streamhub`, symlinked into `PATH`. A thin,
dependency-free wrapper over the pinned compose project — it knows which
services this node runs (from `.install-profile`) so an nginx origin never
starts the Caddy service and an edge only manages the media services.

| Command | Does |
|---|---|
| `streamhub start` / `stop` / `restart` | bring the whole stack up / down / cycle |
| `streamhub status` (alias `ps`) | running state of every service |
| `streamhub logs [service] [-f] [--save]` | tail compose logs; `--save` writes `logs/streamhub-<ts>.log` |
| `streamhub version` | installed `VERSION` + core runtime version + per-service image state |
| `streamhub config` | effective settings from `.env`, **secrets redacted** |
| `streamhub doctor` | checks docker, core health, listening ports, disk |
| `streamhub upgrade [--channel latest \| --version X.Y.Z] [--force]` | re-run the installer's idempotent upgrade path |
| `streamhub uninstall [--yes] [--purge]` | tear the node down (runs `uninstall.sh`) |

Override the target dir with `STREAMHUB_DIR=/path streamhub ...`.

```bash
streamhub status
streamhub logs core -f
sudo streamhub upgrade                 # to the latest published version
sudo streamhub upgrade --version 2.2.0 # pin a specific published version
sudo streamhub doctor
```

---

## 4. One managed service (systemd)

`deploy/systemd/streamhub.service` (installed to `/etc/systemd/system/`) fronts
the whole stack as a single unit:

```ini
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/streamhub/bin/streamhub start
ExecStop=/opt/streamhub/bin/streamhub stop
# Requires=docker.service, After=docker.service
```

So `systemctl status streamhub` reflects the entire app, and it starts on boot.
The existing `streamhub-heartbeat.timer` (cluster liveness, every 60s) is kept
as-is. The compose services carry `restart: unless-stopped`, so the oneshot unit
stays `active (exited)` while the containers run.

---

## 5. Day-1 upgrade — idempotent, migrated, backed-up, rollback-able

Re-running the one-liner (or `streamhub upgrade`) on an existing box:

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash    # or: sudo streamhub upgrade
```

The installer:

1. **Detects** the existing install and reads `$INSTALL_DIR/VERSION` (**INSTALLED**)
   *before* the fetch overwrites it. An absent `VERSION` on an existing dir ⇒ a
   pre-2.2.0 legacy install (treated as older).
2. Fetches the new source and reads its bundled `VERSION` (**TARGET**, authoritative).
3. Compares with a semver check:
   - `INSTALLED == TARGET` and not forced ⇒ logs **“already at X.Y.Z (up to date)”**,
     safe-reconciles services, exits 0. **No backup, no migration.** (Idempotent.)
   - `TARGET > INSTALLED` (or legacy, or `--force-reinstall`) ⇒ **UPGRADE**:
     1. **Pre-upgrade backup** — copies every SQLite DB (`data/streamhub.db` +
        `apps/*/app.db`) via `sqlite3 .backup` (or `cp` fallback) into
        `backups/<UTCstamp>-vINSTALLED/`, and records the global DB’s
        `PRAGMA user_version`. Taken *before* the rebuild/restart — the only
        moment the DBs mutate.
     2. `docker compose up -d --build` (rebuilds the core image → **migrations
        run automatically at core boot** via `PRAGMA user_version`; see
        [DEPLOY.md](./DEPLOY.md#db-migration--automatic-idempotent-backed-up)).
     3. Waits for core health.
     4. **Verifies** the migration: logs the global DB `user_version` *before → after*
        and the version reported by `GET /api/v1/health`.
     5. Stamps `$INSTALL_DIR/VERSION = TARGET` and prints an **UPGRADE SUMMARY**
        (from → to, backup path, migration delta, health OK).

### Rollback

If core does **not** become healthy after an upgrade, the installer **keeps the
backup** and prints explicit instructions, then exits non-zero:

```bash
streamhub stop
# restore the pre-upgrade DBs
cp -a /opt/streamhub/backups/<stamp>-vINSTALLED/data/streamhub.db \
      /opt/streamhub/data/data/streamhub.db
cp -a /opt/streamhub/backups/<stamp>-vINSTALLED/apps/. \
      /opt/streamhub/data/apps/            # if per-app DBs changed
docker compose -f /opt/streamhub/docker-compose.yml up -d --build
```

Migrations are `CREATE TABLE IF NOT EXISTS` + copy-if-absent (append-only
`user_version`), so a forward migration is safe; the backup exists for the rare
case a new build fails to boot.

---

## 6. Versioning scheme

- **`VERSION`** (repo root, single line, e.g. `2.2.0`) is the **system/release
  version** — the source of truth stamped into every artifact and into
  `$INSTALL_DIR/VERSION`. Semantic `X.Y.Z`.
- The installer’s own `--version` reports the **installer format version** (this
  script), which tracks the system version.
- `GET /api/v1/health` reports the **release `VERSION`** at runtime. The Go core
  has it baked in at link time (`-X …/internal/platform/version.Override=<VERSION>`,
  done by `deploy/Dockerfile` and `deploy/make-core-bundle.sh`); an unstamped dev
  build falls back to a `VERSION` file in the working dir / next to the binary
  (or one level up), else `dev`. `streamhub-core-go/internal/platform/version`.

Bump `VERSION` in the same commit as the change set; tagging that commit drives
the release pipeline below.

---

## 7. Release pipeline (`.gitlab-ci.yml`)

A `release` stage runs on git **tags**:

- **`release:artifact`** (`rules: if $CI_COMMIT_TAG`) runs
  `deploy/make-release-artifact.sh "$CI_COMMIT_TAG"` and uploads `dist/` as job
  artifacts:
  - `dist/streamhub-<version>.tar.gz` — the flat source tree (docker-compose.yml
    at the archive root, which `install.sh` expects) with a **stamped VERSION**,
    **excluding** `.git`, all `node_modules/dist/coverage/__pycache__`, local Go
    builds (`streamhub-core-go/bin`, `streamhub-core-go/streamhub`), the
    runtime `data/` tree, and every secret (`.env`, `*.local`, `Access.md`,
    `deploy-streamhub.sh`).
  - `dist/latest.json` — `{version, tarball, sha256, installer, published_at}`.
  - copies of `install.sh` / `uninstall.sh`.
- **`release:publish`** (`when: manual`, `needs: [release:artifact]`) mirrors the
  artifact + `latest.json` + installer to the landing’s public dir over SSH, and
  refreshes `streamhub-src.tar.gz` (the stable name the one-liner fetches by
  default) to the newest tarball.

### Required CI variables (Settings ▸ CI/CD ▸ Variables — mark Protected + Masked)

Because the repo is private and the landing serves the artifacts **anonymously**,
nothing is hardcoded — publishing reads protected variables and fails loudly if
any is unset:

| Variable | Required | Meaning |
|---|---|---|
| `LANDING_SSH_KEY` | yes | Private key (PEM/OpenSSH) with write access to the landing dir. |
| `LANDING_HOST` | yes | Landing host (e.g. `www.streamhub.studio` or its IP). |
| `LANDING_PATH` | yes | Absolute public dir served at the site root. |
| `LANDING_USER` | no (default `deploy`) | SSH user. |
| `LANDING_PORT` | no (default `22`) | SSH port. |

### How the landing serves it

The landing’s site root must serve, anonymously:

```
install.sh                     ← curl … | sudo bash
uninstall.sh
latest.json                    ← {version, sha256, …}
streamhub-src.tar.gz           ← what install.sh fetches by default (= newest tarball)
streamhub-<version>.tar.gz     ← pinned versions (streamhub upgrade --version X.Y.Z)
```

`install.sh` fetches `STREAMHUB_SRC_URL` (default
`https://www.streamhub.studio/streamhub-src.tar.gz`); `streamhub upgrade
--version X.Y.Z` points it at `streamhub-<version>.tar.gz` in the same dir.

---

## 8. Build a test artifact locally

`deploy/make-release-artifact.sh` is the **same** builder CI uses, runnable
locally to validate the upgrade path against a real box:

```bash
deploy/make-release-artifact.sh 2.2.0
# → dist/streamhub-2.2.0.tar.gz  (flat, stamped VERSION, secret-free)
#   dist/latest.json             ({version, tarball, sha256, installer, published_at})
#   dist/install.sh              (a copy)
# prints:  <sha256>  streamhub-2.2.0.tar.gz
```

Host `dist/` at a temp URL and point an install at it:

```bash
# on the test box — install/upgrade from your temp artifact
curl -fsSL https://TEMP/install.sh \
  | STREAMHUB_SRC_URL=https://TEMP/streamhub-2.2.0.tar.gz sudo bash -s -- --non-interactive
```

The builder refuses to ship if `docker-compose.yml`/`install.sh` are missing from
the staged tree, and excludes the same secrets/build-output as CI.

---

## 9. Telemetry — anonymous install ping (opt-out)

At the **end of a successful** install / upgrade / join, the installer fires a single
fire-and-forget POST to `https://streamhub.studio/api/installs` so the project can count
installs and versions in the wild. It **never** fails or delays the install (backgrounded,
5-second cap, errors swallowed).

**What is sent** (exactly, nothing else):

```json
{
  "install_id": "<random uuid, persisted at $INSTALL_DIR/.install_id so re-runs reuse it>",
  "version":    "<the installed VERSION>",
  "os":         "linux",
  "arch":       "amd64 | arm64 | <uname -m>",
  "mode":       "fresh | upgrade | join",
  "channel":    "stable | marketplace-<builder>"
}
```

`channel` is `stable` for the one-liner. A server booted from a marketplace image reports
the image's channel (`marketplace-digitalocean`, `-vultr`, `-hcloud`, `-amazon-ebs`, written
into `/opt/streamhub/.image-prepared` at build time — [MARKETPLACE.md](./MARKETPLACE.md)), so
installs can be counted per channel. `STREAMHUB_TELEMETRY_CHANNEL` overrides it.

**What is NOT sent:** no hostname, no IP (the server hashes the source IP for de-duplication;
the installer sends no IP field), no domain, no email, no tokens/secrets, no config. The
`install_id` is a random UUID with no link to any identity.

**Opt out:** set `STREAMHUB_NO_TELEMETRY=1` (env or before the one-liner). The installer then
skips the ping and logs one line saying so. Override the endpoint for testing with
`STREAMHUB_TELEMETRY_URL`.

```bash
# install with telemetry disabled
curl -fsSL https://www.streamhub.studio/install.sh | sudo STREAMHUB_NO_TELEMETRY=1 bash
```

## 10. Uninstall

```bash
sudo streamhub uninstall --yes            # stop + remove stack, keep cert/images
sudo streamhub uninstall --yes --purge    # also prune images + nginx site + sysctl
```

`uninstall.sh` also removes the `streamhub.service` unit, the
`/usr/local/bin/streamhub` symlink and the heartbeat units. See its `--help`.
