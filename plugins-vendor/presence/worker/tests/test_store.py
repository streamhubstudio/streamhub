"""SQLite store: schema, writes, range reads, retention prune."""
import sqlite3

from presence_worker.store import PresenceStore


def test_creates_db_with_documented_schema(tmp_path):
    path = tmp_path / "nested" / "dir" / "presence.db"
    store = PresenceStore(str(path))
    store.close()
    assert path.exists()

    conn = sqlite3.connect(str(path))
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert {"events", "occupancy"} <= tables
    ev_cols = [r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()]
    assert ev_cols == ["ts", "zone", "type"]
    oc_cols = [r[1] for r in conn.execute("PRAGMA table_info(occupancy)").fetchall()]
    assert oc_cols == ["ts", "zone", "persons"]
    conn.close()


def test_event_round_trip_newest_first(tmp_path):
    store = PresenceStore(str(tmp_path / "presence.db"))
    store.add_event(100.0, "desk", "presence.absent")
    store.add_event(200.0, "desk", "presence.returned")
    store.add_event(300.0, "door", "presence.after_hours")

    rows = store.events_since(0)
    assert [r["event"] for r in rows] == [
        "presence.after_hours",
        "presence.returned",
        "presence.absent",
    ]
    assert rows[0] == {"ts": 300.0, "zone": "door", "event": "presence.after_hours"}
    # since filter + limit
    assert len(store.events_since(150.0)) == 2
    assert len(store.events_since(0, limit=1)) == 1
    store.close()


def test_occupancy_round_trip_oldest_first(tmp_path):
    store = PresenceStore(str(tmp_path / "presence.db"))
    store.add_occupancy(10.0, "desk", 1)
    store.add_occupancy(20.0, "desk", 0)
    store.add_occupancy(30.0, "door", 2)

    rows = store.occupancy_since(0)
    assert rows == [
        {"ts": 10.0, "zone": "desk", "persons": 1},
        {"ts": 20.0, "zone": "desk", "persons": 0},
        {"ts": 30.0, "zone": "door", "persons": 2},
    ]
    assert store.occupancy_since(15.0) == rows[1:]
    store.close()


def test_prune_drops_old_rows_from_both_tables(tmp_path):
    store = PresenceStore(str(tmp_path / "presence.db"))
    store.add_event(10.0, "desk", "presence.absent")
    store.add_event(500.0, "desk", "presence.returned")
    store.add_occupancy(10.0, "desk", 0)
    store.add_occupancy(500.0, "desk", 1)
    store.prune(100.0)
    assert [r["ts"] for r in store.events_since(0)] == [500.0]
    assert [r["ts"] for r in store.occupancy_since(0)] == [500.0]
    store.close()


def test_reopen_keeps_data(tmp_path):
    path = str(tmp_path / "presence.db")
    store = PresenceStore(path)
    store.add_event(1.0, "desk", "presence.absent")
    store.close()
    store2 = PresenceStore(path)  # idempotent schema
    assert len(store2.events_since(0)) == 1
    store2.close()
