"""The detect → associate → track → snapshot/store/POST loop, fully faked."""
import datetime as dt
import os

from safety_ppe_worker.config import Config
from safety_ppe_worker.runner import run_loop
from safety_ppe_worker.store import ViolationStore


def make_config(**env):
    base = {
        "SAFETY_PPE_APP": "live",
        "SAFETY_PPE_ROOM": "main",
        "SAFETY_PPE_SUSTAIN_FRAMES": "1",
        "SAFETY_PPE_COOLDOWN_SECONDS": "120",
        "SAFETY_PPE_CALLBACK_URL": "https://hooks.test/ppe",
        "SAFETY_PPE_CALLBACK_SECRET": "sec",
        "SAFETY_PPE_EVIDENCE_DIR": os.path.join("/tmp", "evidence"),
    }
    base.update(env)
    return Config.from_env(base)


def person(conf=0.9):
    return {"role": "person", "class": "Person", "conf": conf, "bbox": [0.1, 0.1, 0.3, 0.9]}


def helmet():
    return {"role": "helmet", "class": "Hardhat", "conf": 0.8, "bbox": [0.15, 0.1, 0.25, 0.2]}


def vest():
    return {"role": "vest", "class": "Safety Vest", "conf": 0.8, "bbox": [0.12, 0.35, 0.28, 0.6]}


class Recorder:
    """Collects posts / snapshots / log events."""

    def __init__(self, post_status=200, save_ok=True):
        self.posts = []
        self.saves = []
        self.events = []
        self._status = post_status
        self._save_ok = save_ok

    def post(self, url, payload, token="", secret="", **kw):
        self.posts.append({"url": url, "payload": payload, "secret": secret})
        return self._status

    def save(self, frame, path):
        self.saves.append(path)
        return self._save_ok

    def emit(self, event, **fields):
        self.events.append({"event": event, **fields})


def clock(start=1000.0, step=1.0):
    state = {"t": start - step}

    def now():
        state["t"] += step
        return state["t"]

    return now


def workday():  # a Wednesday, 10:00 — inside any sane schedule
    return dt.datetime(2026, 7, 8, 10, 0, 0)


def test_sustained_violation_fires_once_with_snapshot_store_and_signed_post(tmp_path):
    config = make_config(SAFETY_PPE_DB=str(tmp_path / "v.db"))
    store = ViolationStore(config.db_path)
    rec = Recorder()
    # Frame 1: helmet missing (streak 1, sustain=1 → no fire yet).
    # Frame 2: still missing → fires. Frames 3-4: cooldown suppresses.
    frames = ["f1", "f2", "f3", "f4"]
    detections = [
        [person(), vest()],
        [person(), vest()],
        [person(), vest()],
        [person(), vest()],
    ]
    it = iter(detections)
    stats = run_loop(
        config,
        frames,
        detect=lambda f: next(it),
        post=rec.post,
        store=store,
        save=rec.save,
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    assert stats["frames"] == 4 and stats["analyzed"] == 4
    assert stats["violations"] == 1
    assert stats["posts"] == 1 and stats["post_errors"] == 0

    # Signed POST with the ppe.violation event.
    assert len(rec.posts) == 1
    posted = rec.posts[0]
    assert posted["url"] == "https://hooks.test/ppe"
    assert posted["secret"] == "sec"
    assert posted["payload"]["event"] == "ppe.violation"
    assert posted["payload"]["zone"] == "all"
    assert posted["payload"]["missing"] == ["helmet"]
    assert posted["payload"]["snapshot_path"] == rec.saves[0]

    # Snapshot under <evidence>/<app>/….jpg
    assert rec.saves[0].startswith(os.path.join("/tmp", "evidence", "live"))
    assert rec.saves[0].endswith(".jpg")

    # SQLite row persisted with the same data.
    rows = store.recent()
    assert len(rows) == 1
    assert rows[0]["zone"] == "all" and rows[0]["missing"] == ["helmet"]
    assert rows[0]["snapshot_path"] == rec.saves[0]
    store.close()

    # One violation log line for the dashboard table.
    violations = [e for e in rec.events if e["event"] == "violation"]
    assert len(violations) == 1
    assert violations[0]["zone"] == "all"
    assert violations[0]["missing"] == ["helmet"]
    assert violations[0]["snapshot"] == rec.saves[0]


def test_compliant_frames_fire_nothing():
    config = make_config()
    rec = Recorder()
    stats = run_loop(
        config,
        ["f1", "f2", "f3"],
        detect=lambda f: [person(), helmet(), vest()],
        post=rec.post,
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    assert stats["violations"] == 0 and rec.posts == []


def test_off_schedule_frames_skip_detection_and_reset_streaks():
    config = make_config(
        SAFETY_PPE_WORK_HOURS="08:00-18:00", SAFETY_PPE_WORK_DAYS="mon-fri"
    )
    rec = Recorder()
    calls = {"n": 0}

    def detect(frame):
        calls["n"] += 1
        return [person(), vest()]  # helmet missing whenever analyzed

    times = iter(
        [
            dt.datetime(2026, 7, 8, 10, 0),  # in schedule → streak 1
            dt.datetime(2026, 7, 8, 19, 0),  # off hours → skipped, streak reset
            dt.datetime(2026, 7, 9, 10, 0),  # in schedule → streak 1 again
        ]
    )
    stats = run_loop(
        config,
        ["f1", "f2", "f3"],
        detect=detect,
        post=rec.post,
        now=clock(),
        localtime=lambda: next(times),
        emit=rec.emit,
    )
    assert calls["n"] == 2                      # detection never ran off-schedule
    assert stats["off_schedule"] == 1
    assert stats["violations"] == 0             # streak reset prevented the fire
    schedule_events = [e for e in rec.events if e["event"] == "schedule"]
    assert [e["active"] for e in schedule_events] == [True, False, True]


def test_callback_error_counted_and_loop_survives():
    config = make_config()
    rec = Recorder(post_status=500)
    stats = run_loop(
        config,
        ["f1", "f2", "f3"],
        detect=lambda f: [person(), vest()],
        post=rec.post,
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    assert stats["violations"] == 1
    assert stats["post_errors"] == 1
    assert any(e["event"] == "callback_error" for e in rec.events)


def test_no_callback_url_means_no_posts_but_everything_else_works(tmp_path):
    config = make_config(SAFETY_PPE_CALLBACK_URL="", SAFETY_PPE_DB=str(tmp_path / "v.db"))
    store = ViolationStore(config.db_path)
    rec = Recorder()
    stats = run_loop(
        config,
        ["f1", "f2"],
        detect=lambda f: [person(), vest()],
        post=rec.post,
        store=store,
        save=rec.save,
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    assert stats["violations"] == 1 and stats["posts"] == 0
    assert rec.posts == [] and store.count() == 1
    store.close()


def test_failed_snapshot_posts_empty_path():
    config = make_config()
    rec = Recorder(save_ok=False)
    run_loop(
        config,
        ["f1", "f2"],
        detect=lambda f: [person(), vest()],
        post=rec.post,
        save=rec.save,
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    assert rec.posts[0]["payload"]["snapshot_path"] == ""
    assert any(e["event"] == "snapshot_error" for e in rec.events)


def test_zones_status_logged_only_on_change():
    config = make_config()
    rec = Recorder()
    seq = [
        [person(), helmet(), vest()],  # clean
        [person(), helmet(), vest()],  # clean (same signature — no log)
        [person(), vest()],            # helmet goes missing → log
    ]
    it = iter(seq)
    run_loop(
        config,
        ["f1", "f2", "f3"],
        detect=lambda f: next(it),
        post=rec.post,
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    zone_lines = [e for e in rec.events if e["event"] == "zones"]
    assert len(zone_lines) == 2
    assert zone_lines[0]["zones"]["all"]["missing"] == []
    assert zone_lines[1]["zones"]["all"]["missing"] == ["helmet"]


def test_store_failure_does_not_break_loop():
    config = make_config()
    rec = Recorder()

    class BrokenStore:
        def insert(self, *a, **kw):
            raise RuntimeError("disk full")

    stats = run_loop(
        config,
        ["f1", "f2"],
        detect=lambda f: [person(), vest()],
        post=rec.post,
        store=BrokenStore(),
        now=clock(),
        localtime=workday,
        emit=rec.emit,
    )
    assert stats["violations"] == 1
    assert any(e["event"] == "store_error" for e in rec.events)
    assert len(rec.posts) == 1  # callback still went out
