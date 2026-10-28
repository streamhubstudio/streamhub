"""
Per-plugin SQLite store — the worker OWNS this database (the core never opens
it). Default path: <DATA_DIR>/people-counter.db (set by the plugin's
worker.spawn via PC_DB_PATH; standalone/edge runs pick their own path).

Schema (documented in README.md):

  crossings(id, ts, app, room, direction, track_id)
      one row per counted line crossing; direction ∈ ('in','out').
  occupancy_samples(id, ts, app, room, count)
      periodic occupancy snapshots (every PC_SAMPLE_INTERVAL seconds).

`app`/`room` columns scope the rows so several workers (multi-app installs)
can safely share the single per-plugin DB file; WAL mode keeps concurrent
writers from blocking each other. Uses only the stdlib `sqlite3`.
"""
from __future__ import annotations

import os
import sqlite3
import threading

_SCHEMA = """
CREATE TABLE IF NOT EXISTS crossings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL    NOT NULL,
  app       TEXT    NOT NULL DEFAULT '',
  room      TEXT    NOT NULL DEFAULT '',
  direction TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  track_id  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crossings_ts ON crossings (app, room, ts);

CREATE TABLE IF NOT EXISTS occupancy_samples (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    REAL    NOT NULL,
  app   TEXT    NOT NULL DEFAULT '',
  room  TEXT    NOT NULL DEFAULT '',
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occupancy_ts ON occupancy_samples (app, room, ts);
"""


class CountStore:
    """Tiny synchronous writer around the per-plugin SQLite file."""

    def __init__(self, db_path: str, app: str = "", room: str = "") -> None:
        self.db_path = db_path
        self.app = app
        self.room = room
        self._lock = threading.Lock()
        parent = os.path.dirname(db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def record_crossing(self, ts: float, direction: str, track_id: int) -> None:
        if direction not in ("in", "out"):
            raise ValueError(f"invalid direction: {direction!r}")
        with self._lock:
            self._conn.execute(
                "INSERT INTO crossings (ts, app, room, direction, track_id) "
                "VALUES (?, ?, ?, ?, ?)",
                (float(ts), self.app, self.room, direction, int(track_id)),
            )
            self._conn.commit()

    def record_occupancy(self, ts: float, count: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO occupancy_samples (ts, app, room, count) "
                "VALUES (?, ?, ?, ?)",
                (float(ts), self.app, self.room, max(0, int(count))),
            )
            self._conn.commit()

    def totals(self) -> tuple[int, int]:
        """(total_in, total_out) recorded for this app/room — lifetime."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT direction, COUNT(*) FROM crossings "
                "WHERE app = ? AND room = ? GROUP BY direction",
                (self.app, self.room),
            ).fetchall()
        by_dir = {d: n for d, n in rows}
        return int(by_dir.get("in", 0)), int(by_dir.get("out", 0))

    def close(self) -> None:
        with self._lock:
            self._conn.close()
