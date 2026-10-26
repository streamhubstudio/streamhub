"""
Per-app SQLite read log — stdlib `sqlite3` only (unit-tested against tmp dbs).

One `lpr.db` per worker data dir (the core plugin points LPR_DATA_DIR at
`apps/<app>/lpr/`, so reads stay tenant-scoped like the rest of the per-app
state). Schema (also documented in the README):

    CREATE TABLE reads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            REAL    NOT NULL,   -- unix seconds (float) of the read
      plate         TEXT    NOT NULL,   -- normalized plate (A-Z0-9)
      confidence    REAL    NOT NULL,   -- OCR confidence 0..1
      list_match    TEXT,               -- 'whitelist' | 'blacklist' | NULL
      snapshot_path TEXT                -- absolute JPEG path, or NULL
    );

The store is append-only from the worker's perspective; `recent()` feeds the
live-data ring (dashboard panel) and re-seeds it across restarts.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Any, Optional

from ._sdk import apply_migrations

# Migrations ship inside the worker package (so they travel with the code in a
# composed bundle). The shared runner drives them via PRAGMA user_version before
# the store opens — idempotent, VACUUM INTO backup on upgrade, and it REFUSES a
# schema downgrade rather than corrupt data.
MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), "migrations")

# Kept as a belt-and-suspenders idempotent guard for the (rare) path where the
# migrations dir is unavailable; migration 001 creates exactly this schema.
SCHEMA = """
CREATE TABLE IF NOT EXISTS reads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL    NOT NULL,
  plate         TEXT    NOT NULL,
  confidence    REAL    NOT NULL,
  list_match    TEXT,
  snapshot_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_reads_ts    ON reads(ts);
CREATE INDEX IF NOT EXISTS idx_reads_plate ON reads(plate);
"""


class ReadsStore:
    """Tiny append/read wrapper over `<data_dir>/lpr.db`. Idempotent schema
    creation; WAL mode so the worker's writes never block a curious reader.
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        parent = os.path.dirname(db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        # Bring the schema up to date (idempotent; backs up + refuses a
        # downgrade) BEFORE opening the store's own connection.
        apply_migrations(db_path, MIGRATIONS_DIR)
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:
            pass  # WAL unsupported on some filesystems — fine, defaults apply
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        # The schema level now applied (migration NNN), for logs/diagnostics.
        self.schema_version = int(
            self._conn.execute("PRAGMA user_version").fetchone()[0]
        )

    def add(
        self,
        ts: float,
        plate: str,
        confidence: float,
        list_match: Optional[str] = None,
        snapshot_path: Optional[str] = None,
    ) -> int:
        cur = self._conn.execute(
            "INSERT INTO reads (ts, plate, confidence, list_match, snapshot_path)"
            " VALUES (?, ?, ?, ?, ?)",
            (float(ts), plate, float(confidence), list_match, snapshot_path or None),
        )
        self._conn.commit()
        return int(cur.lastrowid or 0)

    def recent(self, limit: int = 25) -> list[dict[str, Any]]:
        """Newest-first reads, JSON-payload shaped (camelCase keys — exactly
        what the live-data ring / dashboard panel consume)."""
        rows = self._conn.execute(
            "SELECT ts, plate, confidence, list_match, snapshot_path"
            " FROM reads ORDER BY ts DESC, id DESC LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
        return [
            {
                "ts": row["ts"],
                "plate": row["plate"],
                "confidence": row["confidence"],
                "listMatch": row["list_match"],
                "snapshot": row["snapshot_path"],
            }
            for row in rows
        ]

    def count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM reads").fetchone()
        return int(row["n"])

    def close(self) -> None:
        self._conn.close()
