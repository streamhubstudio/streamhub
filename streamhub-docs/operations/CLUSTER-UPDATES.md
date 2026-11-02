# Updating a deployment: master, edge nodes, common nodes

How to move a running StreamHub deployment to a newer release — a single box, or
a master with joined **common** (full media) and **edge** (Vision Edge) nodes.
Upgrades are idempotent, take a pre-upgrade DB backup, and gate on health. The
building blocks (the `streamhub` CLI, the installer's upgrade path, versioning +
release pipeline) are in [INSTALL.md](./INSTALL.md); this page is the
cluster-wide procedure and ordering.

---

## 1. How releases are versioned & published

- Repo-root **`VERSION`** (single line, semver `X.Y.Z`) is the source of truth,
  bumped in the same commit as the change set.
- Tagging that commit drives the CI **release** stage: it builds a stamped,
  secret-free source tarball (`streamhub-<version>.tar.gz`) + `latest.json`, and
  publishes them to the landing site next to `install.sh`.
- The one-liner fetches `streamhub-src.tar.gz` (the newest release) by default;
  `--version X.Y.Z` fetches `streamhub-<version>.tar.gz` from the same directory.

Full pipeline, CI variables, and how the landing serves the artifacts:
[INSTALL.md §7 "Release pipeline"](./INSTALL.md#7-release-pipeline-gitlab-ciyml).

---

## 2. Before you upgrade (checklist)

1. **Back up.** The upgrade path takes a pre-upgrade SQLite snapshot
   automatically, but take your own known-good backup first — especially of the
   **master's** global + per-app DBs. See [BACKUPS.md](./BACKUPS.md).
2. **Health check** the master: `sudo streamhub doctor` (docker reachable, core
   healthy, ports listening, disk free).
3. **Note the current version** on every node: `streamhub version`.
4. **Read the release notes** for the target version (breaking changes, new env).

---

## 3. Upgrade the master (origin)

The master is a normal origin install — `streamhub upgrade` is exactly for it:

```bash
sudo streamhub upgrade                  # → the latest published version
sudo streamhub upgrade --version 2.15.0 # → pin an exact published version
```

What `streamhub upgrade` does (it re-runs the installer's idempotent upgrade path
against this dir): reads the **installed** `VERSION`, fetches the **target**,
compares with a semver check, and —

- **installed == target** and not forced → logs "already up to date", reconciles
  services, exits 0. **No backup, no migration.**
- **target > installed** (or legacy, or `--force`) → **UPGRADE**: pre-upgrade DB
  backup (`data/streamhub.db` + every `apps/*/app.db` into
  `backups/<UTCstamp>-v<from>/`) → `docker compose up -d --build` (migrations run
  automatically at core boot) → wait for core health → verify the migration delta
  and the version at `GET /api/v1/health` → re-stamp `VERSION` and print an
  upgrade summary.

Flags:

| Flag | Meaning |
|---|---|
| `--version X.Y.Z` | Pin an exact published version. **Pinning an *older* version is the roll-forward-to-older = rollback path** (the installer stamps whatever `VERSION` the tarball carries). |
| `--channel latest` | Release channel. Default and currently the only channel (`latest` = stable); `--version` is the real lever for exact pinning. |
| `--force` | Re-run the upgrade steps (backup → rebuild → re-stamp) even when already at the target version (maps to the installer's `--force-reinstall`). |

`streamhub upgrade` must run as **root** (`sudo`). It re-runs the installer
non-interactively against `$INSTALL_DIR`, keeping `.env`, `data/`, and the CLI/
logs/backups intact.

---

## 4. Upgrade the joined nodes (common + edge)

Joined nodes are separate installs on their own hosts — upgrade **each** node on
its own box, **after** the master.

> **Order: master first, then the nodes.** The master owns the control plane,
> the API, the scheduler and the node registry; bring it to the target version
> before the nodes reconcile against it.

**`sudo streamhub upgrade` works on a node too.** Every successful join persists
the node's role and join parameters in `$INSTALL_DIR/.join-profile` (mode 600 —
it holds the cluster token), and an installer re-run **without** an explicit
`--standalone`/`--join` resumes from it: same node type (common/edge), same
master, re-registering with the master (picking up any rotated keys) and
re-stamping `VERSION`. So the day-1 flow is the same on every box:

```bash
sudo streamhub upgrade                    # channel: latest
sudo streamhub upgrade --version 2.15.0   # pin (forward OR rollback)
```

Re-running the node's original **join one-liner** is equally valid (a join is
idempotent and re-runnable) and is the way to *change* a join parameter — a new
master IP, a rotated `--master-token`, a different `--node-type`:

```bash
# common (full media) node
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join --master-token clt_... --master-ip <master-private-ip> \
  --master-url https://media.example.com --node-name <name>

# edge (Vision Edge) node — same, plus --node-type edge
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join --master-token clt_... --master-ip <master-private-ip> \
  --master-url https://media.example.com --node-name <name> --node-type edge
```

To **pin a node to a specific version** with the one-liner, prefix the pinned
tarball URL (the same mechanism `streamhub upgrade --version` uses):

```bash
curl -fsSL https://www.streamhub.studio/install.sh \
  | STREAMHUB_SRC_URL=https://www.streamhub.studio/streamhub-2.15.0.tar.gz \
    sudo bash -s -- --join --master-token clt_... --master-ip <master-private-ip> ...
```

> **Pre-2.16 installs:** the `.join-profile` is written by the join run itself,
> so a node joined by an OLDER installer doesn't have one yet — its first
> upgrade must be the explicit join one-liner above (which writes the profile);
> from then on `streamhub upgrade` resumes the role by itself. Explicit flags
> always win over the profile (`--standalone` forcibly re-runs as origin).
> `streamhub status | logs -f | restart | doctor` on a node work exactly as on
> the master.

---

## 5. Verify each node rejoined

After upgrading, confirm from the **master** that every node is present and
fresh (nodes heartbeat every 60 s; a node goes `stale=true` ~90 s after its last
ping):

```bash
curl -s -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://media.example.com/api/v1/cluster/nodes | jq '.[] | {name, type, last_seen_at, stale}'
```

Or the dashboard's cluster/fleet view. Check that each node's `last_seen_at` is
recent and its `type` (`common` / `edge`) is what you expect. On an **edge** node
also confirm the runtime reconnected (its control WebSocket to the master) — see
[features/vision-edge.md](../features/vision-edge.md). On each node,
`streamhub version` shows its stamped `VERSION`.

---

## 6. If an upgrade fails health

If core does **not** become healthy after a master upgrade, the installer **keeps
the pre-upgrade backup**, leaves the old `VERSION` on disk (so a re-run retries),
prints explicit restore instructions, and exits non-zero. The rollback is:
restore the backed-up DBs from `backups/<stamp>-v<from>/` and bring the stack
back up. The exact commands are in
[INSTALL.md §"Rollback"](./INSTALL.md#rollback).

Because a pinned `--version` stamps whatever the tarball carries, **pinning the
previous version is a clean rollback** once you've confirmed the DBs are
consistent:

```bash
sudo streamhub upgrade --version <previous-version>
```

Migrations are forward-only and idempotent (`CREATE TABLE IF NOT EXISTS` +
copy-if-absent), so a forward migration is safe; the backup exists for the rare
case a new build fails to boot.

Diagnostics on any node:

```bash
streamhub doctor           # docker / core health / ports / disk
streamhub logs core -f     # tail (origin); on a node: streamhub logs -f
streamhub logs --save      # write a log bundle to logs/streamhub-<ts>.log
```

---

## 7. What is not yet per-app

Studio Apps ship **with the platform** — an upgrade moves the whole install,
including its bundled apps, as one unit; **per-app version pinning / rollback is
on the roadmap, not available today.**

---

## See also

- [INSTALL.md](./INSTALL.md) — the `streamhub` CLI, the upgrade internals,
  versioning + release pipeline.
- [INSTALL-NODE.md](./INSTALL-NODE.md) — the `--join` flow (re-runnable) in depth.
- [BACKUPS.md](./BACKUPS.md) — backup / restore.
- [MANUAL-BUILD-INSTALL.md](./MANUAL-BUILD-INSTALL.md) — build from source & manual install.
- [features/vision-edge.md](../features/vision-edge.md) — the CV edge cluster + node retype.
</content>
