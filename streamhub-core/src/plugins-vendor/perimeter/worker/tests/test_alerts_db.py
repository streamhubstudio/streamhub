import os

from perimeter_worker import alerts_db


def make_db(tmp_path):
    return alerts_db.connect(str(tmp_path / "nested" / "perimeter.db"))


def test_connect_creates_parent_dirs_and_schema(tmp_path):
    db_path = tmp_path / "deep" / "dir" / "perimeter.db"
    conn = alerts_db.connect(str(db_path))
    try:
        assert os.path.exists(db_path)
        cols = {
            r["name"]
            for r in conn.execute("PRAGMA table_info(alerts)").fetchall()
        }
        assert cols == {
            "id",
            "ts",
            "zone",
            "confidence",
            "snapshot_path",
            "clip_path",
            "acked",
        }
    finally:
        conn.close()


def test_insert_and_recent_alerts_newest_first(tmp_path):
    conn = make_db(tmp_path)
    try:
        a = alerts_db.insert_alert(conn, 100.0, "gate", 0.9, "/e/a.jpg", "/e/a.mp4")
        b = alerts_db.insert_alert(conn, 200.0, "door", 0.8, "/e/b.jpg")
        assert a == 1 and b == 2
        rows = alerts_db.recent_alerts(conn, limit=10)
        assert [r["id"] for r in rows] == [2, 1]
        assert rows[0] == {
            "id": 2,
            "ts": 200.0,
            "zone": "door",
            "confidence": 0.8,
            "snapshot": "/e/b.jpg",
            "clip": "",
            "acked": False,
        }
        # limit is respected
        assert len(alerts_db.recent_alerts(conn, limit=1)) == 1
    finally:
        conn.close()


def test_ack_through_flips_older_rows_only(tmp_path):
    conn = make_db(tmp_path)
    try:
        alerts_db.insert_alert(conn, 100.0, "gate", 0.9)
        alerts_db.insert_alert(conn, 200.0, "gate", 0.8)
        alerts_db.insert_alert(conn, 300.0, "door", 0.7)
        assert alerts_db.unacked_count(conn) == 3

        assert alerts_db.ack_through(conn, 200.0) == 2  # <= is inclusive
        rows = {r["ts"]: r["acked"] for r in alerts_db.recent_alerts(conn)}
        assert rows == {100.0: True, 200.0: True, 300.0: False}
        assert alerts_db.unacked_count(conn) == 1

        # idempotent: already-acked rows are not re-counted
        assert alerts_db.ack_through(conn, 250.0) == 0
        assert alerts_db.ack_through(conn, 300.0) == 1
        assert alerts_db.unacked_count(conn) == 0
    finally:
        conn.close()


def test_alerts_survive_reconnect(tmp_path):
    path = str(tmp_path / "perimeter.db")
    conn = alerts_db.connect(path)
    alerts_db.insert_alert(conn, 1.5, "gate", 0.5, "snap.jpg")
    conn.close()

    conn2 = alerts_db.connect(path)  # schema re-run is idempotent
    try:
        rows = alerts_db.recent_alerts(conn2)
        assert len(rows) == 1
        assert rows[0]["zone"] == "gate"
        assert rows[0]["snapshot"] == "snap.jpg"
    finally:
        conn2.close()
