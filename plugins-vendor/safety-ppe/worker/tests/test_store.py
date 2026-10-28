"""SQLite violation store (stdlib sqlite3 — real DB in a tmp dir, no mocks)."""
import os
import sqlite3

from safety_ppe_worker.store import ViolationStore


def test_insert_and_recent_roundtrip(tmp_path):
    store = ViolationStore(str(tmp_path / "safety-ppe.db"))
    a = store.insert(100.0, "live", "main", "dock", ["helmet"], 0.9, "/e/a.jpg")
    b = store.insert(200.0, "live", "main", "gate", ["vest", "helmet"], 0.8, "")
    assert a > 0 and b > a

    rows = store.recent()
    assert [r["zone"] for r in rows] == ["gate", "dock"]  # newest first
    assert rows[0]["missing"] == ["helmet", "vest"]       # sorted, deduped
    assert rows[0]["snapshot_path"] == ""
    assert rows[1]["missing"] == ["helmet"]
    assert rows[1]["confidence"] == 0.9
    assert rows[1]["acked"] is False
    store.close()


def test_scoping_and_limit(tmp_path):
    store = ViolationStore(str(tmp_path / "v.db"))
    store.insert(1.0, "a", "r1", "z", ["helmet"], 0.5)
    store.insert(2.0, "a", "r2", "z", ["vest"], 0.5)
    store.insert(3.0, "b", "r1", "z", ["vest"], 0.5)
    assert len(store.recent()) == 3
    assert [r["ts"] for r in store.recent(limit=1)] == [3.0]
    assert {r["room"] for r in store.recent(app="a")} == {"r1", "r2"}
    assert [r["app"] for r in store.recent(app="a", room="r1")] == ["a"]
    store.close()


def test_ack_marks_row(tmp_path):
    store = ViolationStore(str(tmp_path / "v.db"))
    vid = store.insert(1.0, "a", "r", "z", ["helmet"], 0.5)
    assert store.ack(vid) is True
    assert store.recent()[0]["acked"] is True
    assert store.ack(9999) is False
    store.close()


def test_schema_matches_documented_columns(tmp_path):
    path = str(tmp_path / "v.db")
    ViolationStore(path).close()
    db = sqlite3.connect(path)
    cols = [r[1] for r in db.execute("PRAGMA table_info(violations)")]
    assert cols == [
        "id",
        "ts",
        "app",
        "room",
        "zone",
        "missing",
        "confidence",
        "snapshot_path",
        "acked",
    ]
    db.close()


def test_creates_parent_dirs_and_survives_reopen(tmp_path):
    path = str(tmp_path / "nested" / "dir" / "v.db")
    store = ViolationStore(path)
    store.insert(1.0, "a", "r", "z", ["vest"], 0.4)
    store.close()
    assert os.path.exists(path)
    reopened = ViolationStore(path)  # idempotent schema
    assert reopened.count() == 1
    reopened.close()
