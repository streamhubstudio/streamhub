"""
Per-plugin SQLite violation store (stdlib sqlite3 — no extra dependency).

One database file per StreamHub install (`<DATA_DIR>/safety-ppe.db`, path
injected via SAFETY_PPE_DB); rows are scoped by app + room so several apps'
workers can share it (WAL mode keeps concurrent writers safe). This is the
DURABLE archive — the dashboard tab reads the recent-events window from the
worker log ring; audits query this file.

Schema (also documented in the plugin README):

    CREATE TABLE violations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            REAL    NOT NULL,   -- unix seconds
      app           TEXT    NOT NULL DEFAULT '',
      room          TEXT    NOT NULL DEFAULT '',
      zone          TEXT    NOT NULL,
      missing       TEXT    NOT NULL,   -- comma-joined: 'helmet' | 'vest' | 'helmet,vest'
      confidence    REAL    NOT NULL,
      snapshot_path TEXT    NOT NULL DEFAULT '',
      acked         INTEGER NOT NULL DEFAULT 0
    );
"""
from __future__ import annotations

import os
import sqlite3
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS violations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL    NOT NULL,
  app           TEXT    NOT NULL DEFAULT '',
  room          TEXT    NOT NULL DEFAULT '',
  zone          TEXT    NOT NULL,
  missing       TEXT    NOT NULL,
  confidence    REAL    NOT NULL,
  snapshot_path TEXT    NOT NULL DEFAULT '',
  acked         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_violations_ts ON violations (ts DESC);
CREATE INDEX IF NOT EXISTS idx_violations_app_room ON violations (app, room, ts DESC);
"""


class ViolationStore:
    """Owns one sqlite connection. Not thread-safe by design — the worker is a
    single-threaded loop; each worker process opens its own connection."""

    def __init__(self, path: str) -> None:
        self.path = path
        if path != ":memory:":
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.row_factory = sqlite3.Row
        if path != ":memory:":
            self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def insert(
        self,
        ts: float,
        app: str,
        room: str,
        zone: str,
        missing: Iterable[str],
        confidence: float,
        snapshot_path: str = "",
    ) -> int:
        """Persist one violation; returns the new row id."""
        cur = self._db.execute(
            "INSERT INTO violations (ts, app, room, zone, missing, confidence, snapshot_path)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                float(ts),
                app,
                room,
                zone,
                ",".join(sorted(set(missing))),
                float(confidence),
                snapshot_path or "",
            ),
        )
        self._db.commit()
        return int(cur.lastrowid or 0)

    def recent(
        self, limit: int = 50, app: str | None = None, room: str | None = None
    ) -> list[dict[str, Any]]:
        """Newest violations first, optionally scoped to app/room. `missing`
        comes back as a list."""
        sql = "SELECT * FROM violations"
        where: list[str] = []
        params: list[Any] = []
        if app is not None:
            where.append("app = ?")
            params.append(app)
        if room is not None:
            where.append("room = ?")
            params.append(room)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY ts DESC, id DESC LIMIT ?"
        params.append(max(1, int(limit)))
        rows = self._db.execute(sql, params).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            d["missing"] = [m for m in str(d["missing"]).split(",") if m]
            d["acked"] = bool(d["acked"])
            out.append(d)
        return out

    def ack(self, violation_id: int) -> bool:
        """Mark a violation acknowledged. Returns True if a row changed."""
        cur = self._db.execute(
            "UPDATE violations SET acked = 1 WHERE id = ?", (int(violation_id),)
        )
        self._db.commit()
        return cur.rowcount > 0

    def count(self) -> int:
        row = self._db.execute("SELECT COUNT(*) AS n FROM violations").fetchone()
        return int(row["n"])
