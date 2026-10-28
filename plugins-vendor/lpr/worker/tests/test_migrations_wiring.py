"""
The ReadsStore runs the shared streamhub_sdk migration runner on open (F0
decoupling pilot): a fresh db lands at schema version 1 and stays usable; an
existing pre-migration db (schema built directly, user_version 0) is adopted
without losing rows, and a VACUUM INTO backup is written first.
"""
from __future__ import annotations

import os
import sqlite3

from lpr_worker.store import ReadsStore


def _uv(db_path: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def test_fresh_store_is_migrated_to_v1(tmp_path):
    db = str(tmp_path / "lpr" / "lpr.db")
    store = ReadsStore(db)
    try:
        assert store.schema_version == 1
        assert _uv(db) == 1
        store.add(1.0, "ABC123", 0.9, "whitelist", None)
        assert store.count() == 1
    finally:
        store.close()


def test_pre_migration_db_is_adopted_without_data_loss(tmp_path):
    db = str(tmp_path / "lpr.db")
    # Simulate an older worker: schema created directly, user_version left at 0.
    conn = sqlite3.connect(db)
    conn.executescript(
        "CREATE TABLE reads (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,"
        " plate TEXT NOT NULL, confidence REAL NOT NULL, list_match TEXT,"
        " snapshot_path TEXT);"
    )
    conn.execute("INSERT INTO reads (ts, plate, confidence) VALUES (1.0, 'OLD001', 0.8)")
    conn.commit()
    conn.close()
    assert _uv(db) == 0

    store = ReadsStore(db)
    try:
        assert store.schema_version == 1
        assert _uv(db) == 1
        rows = store.recent()
        assert [r["plate"] for r in rows] == ["OLD001"]
    finally:
        store.close()

    # A VACUUM INTO backup of the pre-migration db (schema v0) was written.
    backups = [n for n in os.listdir(tmp_path) if ".pre-migrate-v0.bak" in n]
    assert len(backups) == 1
