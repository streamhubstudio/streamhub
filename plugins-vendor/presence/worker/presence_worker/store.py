"""
Per-plugin SQLite store — the worker OWNS `<data dir>/presence.db` (stdlib
sqlite3, no ORM). Schema (documented in the plugin README):

    CREATE TABLE events (
      ts   REAL NOT NULL,   -- unix seconds (float)
      zone TEXT NOT NULL,   -- zone id (config `zones[].id`)
      type TEXT NOT NULL    -- presence.absent | presence.returned | presence.after_hours
    );
    CREATE INDEX idx_events_ts ON events(ts);

    CREATE TABLE occupancy (
      ts      REAL NOT NULL,     -- unix seconds (float)
      zone    TEXT NOT NULL,     -- zone id
      persons INTEGER NOT NULL   -- persons counted in the zone at ts
    );
    CREATE INDEX idx_occupancy_ts ON occupancy(ts);

Occupancy rows are written on COUNT CHANGE plus a periodic heartbeat (see
runner), so the table stays a compact step function rather than one row per
sampled frame.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  ts   REAL NOT NULL,
  zone TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS occupancy (
  ts      REAL NOT NULL,
  zone    TEXT NOT NULL,
  persons INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occupancy_ts ON occupancy(ts);
"""


class PresenceStore:
    """Tiny synchronous wrapper — one worker process is the only writer."""

    def __init__(self, path: str) -> None:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.path = path
        self._conn = sqlite3.connect(path)
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:
            pass  # WAL unsupported (e.g. some network mounts) → default journal
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # -- writes --------------------------------------------------------------

    def add_event(self, ts: float, zone: str, type_: str) -> None:
        self._conn.execute(
            "INSERT INTO events (ts, zone, type) VALUES (?, ?, ?)",
            (float(ts), zone, type_),
        )
        self._conn.commit()

    def add_occupancy(self, ts: float, zone: str, persons: int) -> None:
        self._conn.execute(
            "INSERT INTO occupancy (ts, zone, persons) VALUES (?, ?, ?)",
            (float(ts), zone, int(persons)),
        )
        self._conn.commit()

    def prune(self, before_ts: float) -> None:
        """Retention: drop rows older than `before_ts` from both tables."""
        self._conn.execute("DELETE FROM events WHERE ts < ?", (float(before_ts),))
        self._conn.execute(
            "DELETE FROM occupancy WHERE ts < ?", (float(before_ts),)
        )
        self._conn.commit()

    # -- reads (worker restart seeding + tests) --------------------------------

    def events_since(
        self, ts: float, limit: int = 200
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT ts, zone, type FROM events WHERE ts >= ? "
            "ORDER BY ts DESC LIMIT ?",
            (float(ts), int(limit)),
        ).fetchall()
        return [{"ts": r[0], "zone": r[1], "event": r[2]} for r in rows]

    def occupancy_since(
        self, ts: float, limit: int = 2000
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT ts, zone, persons FROM occupancy WHERE ts >= ? "
            "ORDER BY ts ASC LIMIT ?",
            (float(ts), int(limit)),
        ).fetchall()
        return [{"ts": r[0], "zone": r[1], "persons": r[2]} for r in rows]

    def close(self) -> None:
        self._conn.close()
