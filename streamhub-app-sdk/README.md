# streamhub-app-sdk

The Python side of the StreamHub **app contract** — the small, dependency-free
helpers a decoupled Studio App's worker imports so the exact same code runs
co-located inside a StreamHub install OR standalone on the operator's own infra.

> Part of the app-decoupling work (internal design notes). In F1 this
> directory becomes its own repository (`streamhub-app-sdk`), versioned with
> semver; each app declares the SDK range it needs. For now it lives in the
> monorepo and is consumed in-place.

## What's here (F0)

### `streamhub_sdk.migrations` — SQLite schema migrations

The guarantee that an app **update never loses worker data**. The worker owns its
own SQLite (e.g. `<appDir>/lpr/lpr.db`); its schema evolves via ordered
`migrations/NNN_*.sql` files applied on boot, tracked by `PRAGMA user_version`:

```python
from streamhub_sdk.migrations import apply_migrations

apply_migrations(db_path, migrations_dir)   # idempotent; call it on every start
```

- **Idempotent** — only files numbered above the current `user_version` run.
- **Transactional** — a failing migration rolls back whole (schema + version bump).
- **Backed up** — a `VACUUM INTO` copy is written before the first migration of a
  run, whenever the database already holds data.
- **Honest about downgrades** — a `user_version` newer than the highest migration
  on disk (a db written by newer code) is **refused**, not silently downgraded.

### `streamhub_sdk.http` — callback helpers (placeholder)

Empty in F0; the signed-callback (`X-StreamHub-Signature`) post/verify helper
lands with the standalone phase (F3).

## Tests

```bash
cd streamhub-app-sdk && pytest        # stdlib sqlite3 only — no heavy deps
```
