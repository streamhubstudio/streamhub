import sqlite3

from lpr_worker.store import ReadsStore


def test_creates_schema_and_parent_dir(tmp_path):
    db = tmp_path / "nested" / "dir" / "lpr.db"
    store = ReadsStore(str(db))
    assert db.exists()
    assert store.count() == 0
    store.close()
    # Idempotent re-open (CREATE IF NOT EXISTS).
    store2 = ReadsStore(str(db))
    assert store2.count() == 0
    store2.close()


def test_schema_columns_match_readme_contract(tmp_path):
    store = ReadsStore(str(tmp_path / "lpr.db"))
    store.close()
    conn = sqlite3.connect(str(tmp_path / "lpr.db"))
    cols = [row[1] for row in conn.execute("PRAGMA table_info(reads)")]
    conn.close()
    assert cols == ["id", "ts", "plate", "confidence", "list_match", "snapshot_path"]


def test_add_and_recent_newest_first_with_limit(tmp_path):
    store = ReadsStore(str(tmp_path / "lpr.db"))
    store.add(100.0, "AB123CD", 0.91, "whitelist", "/snaps/1.jpg")
    store.add(101.0, "XX999XX", 0.85, "blacklist", "/snaps/2.jpg")
    store.add(102.0, "ZZ111ZZ", 0.7, None, None)

    recent = store.recent(2)
    assert [r["plate"] for r in recent] == ["ZZ111ZZ", "XX999XX"]
    assert recent[0] == {
        "ts": 102.0,
        "plate": "ZZ111ZZ",
        "confidence": 0.7,
        "listMatch": None,
        "snapshot": None,
    }
    assert recent[1]["listMatch"] == "blacklist"
    assert recent[1]["snapshot"] == "/snaps/2.jpg"
    assert store.count() == 3
    store.close()


def test_same_ts_ties_break_by_insert_order(tmp_path):
    store = ReadsStore(str(tmp_path / "lpr.db"))
    store.add(100.0, "FIRST0", 0.5)
    store.add(100.0, "SECOND", 0.5)
    assert [r["plate"] for r in store.recent(5)] == ["SECOND", "FIRST0"]
    store.close()


def test_reads_persist_across_reopen(tmp_path):
    path = str(tmp_path / "lpr.db")
    store = ReadsStore(path)
    store.add(100.0, "AB123CD", 0.9, "whitelist", "/s.jpg")
    store.close()

    reopened = ReadsStore(path)
    assert reopened.count() == 1
    assert reopened.recent(10)[0]["plate"] == "AB123CD"
    reopened.close()
