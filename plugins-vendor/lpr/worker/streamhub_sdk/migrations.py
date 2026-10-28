"""SQLite migrations runner for StreamHub app workers.

A decoupled Studio App owns its worker-side SQLite database (e.g.
``<appDir>/lpr/lpr.db``). When a new version of the app ships, the DATA must
survive — so the worker applies ordered ``migrations/NNN_*.sql`` files on boot,
tracked by SQLite's ``PRAGMA user_version``. This is the worker-side twin of the
core's own boot migration: idempotent, transactional, backed up before it
touches an existing database, and HONEST about downgrades (it refuses rather
than silently corrupting a schema newer than the code understands).

Usage (from a worker's entrypoint)::

    from streamhub_sdk.migrations import apply_migrations
    apply_migrations(db_path, migrations_dir)

Rules:
  * files are named ``NNN_description.sql`` (``NNN`` = a positive integer, any
    width); they run in ascending numeric order;
  * ``user_version`` records the highest applied migration; only files with a
    higher number than the current ``user_version`` run (idempotent re-runs);
  * before the FIRST pending migration of a run — and only when the database
    already holds data worth protecting — a ``VACUUM INTO`` backup is written
    next to the db;
  * each migration runs inside its own transaction; a failing statement rolls
    the whole migration back (including its ``user_version`` bump), so a partial
    file never leaves a half-migrated schema;
  * if ``user_version`` is already HIGHER than the highest migration on disk the
    database was written by newer code — the runner refuses (raising
    :class:`MigrationError`) instead of pretending a downgrade is safe.
"""

from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from typing import Callable, List, Optional

__all__ = ["Migration", "MigrationError", "apply_migrations", "discover_migrations"]

_FILENAME_RE = re.compile(r"^(\d+)_.+\.sql$")


class MigrationError(RuntimeError):
    """Raised on a malformed migration set, a failed migration, or a downgrade."""


@dataclass(frozen=True)
class Migration:
    """One discovered migration file."""

    version: int
    path: str

    @property
    def name(self) -> str:
        return os.path.basename(self.path)


def discover_migrations(migrations_dir: str) -> List[Migration]:
    """Return the migrations under ``migrations_dir`` sorted by version.

    Ignores non-matching filenames (READMEs, dotfiles). Raises
    :class:`MigrationError` on a duplicate version or a non-positive number, so
    an ambiguous set fails loudly rather than applying an unpredictable order.
    """
    try:
        entries = sorted(os.listdir(migrations_dir))
    except FileNotFoundError:
        return []

    migrations: List[Migration] = []
    seen: dict[int, str] = {}
    for name in entries:
        m = _FILENAME_RE.match(name)
        if not m:
            continue
        version = int(m.group(1))
        if version <= 0:
            raise MigrationError(
                f"migration '{name}': version must be a positive integer"
            )
        if version in seen:
            raise MigrationError(
                f"duplicate migration version {version}: "
                f"'{seen[version]}' and '{name}'"
            )
        seen[version] = name
        migrations.append(Migration(version=version, path=os.path.join(migrations_dir, name)))

    migrations.sort(key=lambda mig: mig.version)
    return migrations


def _has_user_tables(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master "
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchone()
    return bool(row and row[0])


def _backup_path(db_path: str, current: int) -> str:
    return f"{db_path}.pre-migrate-v{current}.bak"


def apply_migrations(
    db_path: str,
    migrations_dir: str,
    *,
    backup: bool = True,
    log: Optional[Callable[[str], None]] = None,
) -> int:
    """Apply every pending migration to ``db_path``. Returns the count applied.

    ``backup`` (default True) writes a ``VACUUM INTO`` copy before the first
    pending migration when the database already contains tables. ``log`` is an
    optional line sink (e.g. ``print`` or ``logger.info``).
    """

    def emit(msg: str) -> None:
        if log:
            log(msg)

    migrations = discover_migrations(migrations_dir)
    if not migrations:
        emit(f"no migrations under {migrations_dir}; nothing to do")
        return 0

    highest = migrations[-1].version

    # Ensure the parent dir exists so a brand-new db can be created.
    parent = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(parent, exist_ok=True)

    # Autocommit mode: WE own transaction boundaries via explicit BEGIN/COMMIT.
    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        current = conn.execute("PRAGMA user_version").fetchone()[0]

        if current > highest:
            raise MigrationError(
                f"database schema version {current} is newer than the highest "
                f"available migration {highest} — refusing to downgrade "
                f"(roll the CODE back, not the schema)"
            )

        pending = [m for m in migrations if m.version > current]
        if not pending:
            emit(f"schema up to date at version {current}; {len(migrations)} migration(s) on disk")
            return 0

        if backup and _has_user_tables(conn):
            dest = _backup_path(db_path, current)
            if os.path.exists(dest):
                os.remove(dest)
            conn.execute("VACUUM INTO ?", (dest,))
            emit(f"backed up schema v{current} → {dest}")

        applied = 0
        for mig in pending:
            with open(mig.path, "r", encoding="utf-8") as fh:
                sql = fh.read()
            script = f"BEGIN;\n{sql}\nPRAGMA user_version = {mig.version};\nCOMMIT;"
            try:
                conn.executescript(script)
            except Exception as exc:  # noqa: BLE001 — re-raised as MigrationError
                # Roll back via execute(), NOT executescript(): the latter can
                # issue an implicit COMMIT first (Python <3.12), which would
                # PERSIST the half-applied migration before the rollback runs.
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise MigrationError(
                    f"migration '{mig.name}' failed and was rolled back: {exc}"
                ) from exc
            emit(f"applied {mig.name} → schema v{mig.version}")
            applied += 1

        return applied
    finally:
        conn.close()
