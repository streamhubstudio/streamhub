"""Per-plugin SQLite store — schema, rows, scoping, WAL."""
import sqlite3

import pytest

from people_counter_worker.store import CountStore


@pytest.fixture()
def db_path(tmp_path):
    return str(tmp_path / "people-counter.db")


def test_creates_schema(db_path):
    store = CountStore(db_path, app="live", room="door")
    conn = sqlite3.connect(db_path)
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    conn.close()
    store.close()
    assert {"crossings", "occupancy_samples"} <= tables


def test_wal_mode_enabled(db_path):
    store = CountStore(db_path, app="live", room="door")
    mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]
    store.close()
    assert mode.lower() == "wal"


def test_creates_parent_directory(tmp_path):
    nested = str(tmp_path / "deep" / "dir" / "pc.db")
    store = CountStore(nested, app="a", room="r")
    store.record_crossing(1.0, "in", 1)
    store.close()


def test_records_crossings_with_direction_and_track(db_path):
    store = CountStore(db_path, app="live", room="door")
    store.record_crossing(100.5, "in", 7)
    store.record_crossing(101.0, "out", 8)
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT ts, app, room, direction, track_id FROM crossings ORDER BY id"
    ).fetchall()
    conn.close()
    store.close()
    assert rows == [
        (100.5, "live", "door", "in", 7),
        (101.0, "live", "door", "out", 8),
    ]


def test_rejects_invalid_direction(db_path):
    store = CountStore(db_path)
    with pytest.raises(ValueError):
        store.record_crossing(1.0, "sideways", 1)
    store.close()


def test_records_occupancy_samples_clamped_at_zero(db_path):
    store = CountStore(db_path, app="live", room="door")
    store.record_occupancy(200.0, 3)
    store.record_occupancy(201.0, -2)  # defensive clamp
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT ts, count FROM occupancy_samples ORDER BY id"
    ).fetchall()
    conn.close()
    store.close()
    assert rows == [(200.0, 3), (201.0, 0)]


def test_totals_scoped_per_app_room_in_shared_file(db_path):
    # Two workers (different apps) share the one per-plugin DB file.
    a = CountStore(db_path, app="live", room="door")
    b = CountStore(db_path, app="other", room="gate")
    a.record_crossing(1.0, "in", 1)
    a.record_crossing(2.0, "in", 2)
    a.record_crossing(3.0, "out", 1)
    b.record_crossing(4.0, "in", 9)
    assert a.totals() == (2, 1)
    assert b.totals() == (1, 0)
    a.close()
    b.close()
