"""
Per-plugin SQLite alert store — stdlib sqlite3 only (unit-tested for real).

One DB per app at `<PERIMETER_DATA_DIR>/perimeter.db` (the plugin's spawn ctx
maps that to `apps/<app>/perimeter/`). The WORKER owns all writes; the
dashboard reads alerts through the live-data channel (the worker publishes the
recent rows), and acknowledges by PATCHing the plugin config (`ackThrough`),
which restarts the worker — `ack_through` is applied on boot.

Schema (README): alerts(ts, zone, confidence, snapshot_path, acked) plus an
`id` PK and a `clip_path` for the optional HLS evidence clip.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            REAL    NOT NULL,          -- unix seconds (float)
  zone          TEXT    NOT NULL,          -- zone id from the config
  confidence    REAL    NOT NULL,          -- best person confidence 0-1
  snapshot_path TEXT    NOT NULL DEFAULT '',
  clip_path     TEXT    NOT NULL DEFAULT '',
  acked         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
"""


def connect(db_path: str) -> sqlite3.Connection:
    """Open (creating parent dirs + schema as needed) the alerts DB."""
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 3000")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def insert_alert(
    conn: sqlite3.Connection,
    ts: float,
    zone: str,
    confidence: float,
    snapshot_path: str = "",
    clip_path: str = "",
) -> int:
    """Insert one intrusion alert; returns its row id."""
    cur = conn.execute(
        "INSERT INTO alerts (ts, zone, confidence, snapshot_path, clip_path)"
        " VALUES (?, ?, ?, ?, ?)",
        (float(ts), zone, float(confidence), snapshot_path, clip_path),
    )
    conn.commit()
    return int(cur.lastrowid or 0)


def ack_through(conn: sqlite3.Connection, ts: float) -> int:
    """Acknowledge every alert at or before `ts` (unix seconds). Returns the
    number of rows flipped. The dashboard's per-alert "Acknowledge" sets the
    clicked alert's ts, acknowledging it and everything older (alarm-queue
    "ack up to here" semantics).
    """
    cur = conn.execute(
        "UPDATE alerts SET acked = 1 WHERE acked = 0 AND ts <= ?",
        (float(ts),),
    )
    conn.commit()
    return int(cur.rowcount or 0)


def recent_alerts(conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    """Newest-first alerts for the live status payload."""
    rows = conn.execute(
        "SELECT id, ts, zone, confidence, snapshot_path, clip_path, acked"
        " FROM alerts ORDER BY ts DESC, id DESC LIMIT ?",
        (max(1, int(limit)),),
    ).fetchall()
    return [
        {
            "id": int(r["id"]),
            "ts": float(r["ts"]),
            "zone": r["zone"],
            "confidence": float(r["confidence"]),
            "snapshot": r["snapshot_path"],
            "clip": r["clip_path"],
            "acked": bool(r["acked"]),
        }
        for r in rows
    ]


def unacked_count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM alerts WHERE acked = 0").fetchone()
    return int(row["n"])
