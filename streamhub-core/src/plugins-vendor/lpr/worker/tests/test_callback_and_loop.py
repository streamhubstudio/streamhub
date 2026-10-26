from collections import deque

from lpr_worker.callback import (
    build_direct,
    build_event,
    build_live,
    post_json,
    read_payload,
)
from lpr_worker.config import Config
from lpr_worker.runner import run_loop
from lpr_worker.snapshot import snapshot_filename
from lpr_worker.stream import FpsThrottle


# ---------------------------------------------------------------------------
# payload builders
# ---------------------------------------------------------------------------

def test_read_payload_shape():
    p = read_payload("AB123CD", 0.91234, 123.5, "whitelist", "/snaps/1.jpg")
    assert p == {
        "plate": "AB123CD",
        "confidence": 0.9123,
        "ts": 123.5,
        "listMatch": "whitelist",
        "snapshot": "/snaps/1.jpg",
    }
    assert read_payload("X", 0.5, 1.0, None, "")["snapshot"] is None


def test_build_event_and_direct_and_live_shapes():
    read = read_payload("AB123CD", 0.9, 42.0, None, None)
    assert build_event("plate.detected", "gate", read) == {
        "event": "plate.detected",
        "room": "gate",
        "data": read,
    }
    direct = build_direct("parking", "gate", "plate.denied", read)
    assert direct["app"] == "parking"
    assert direct["room"] == "gate"
    assert direct["event"] == "plate.denied"
    assert direct["plate"] == "AB123CD"

    live = build_live("gate", 42.0, {"plate": "AB123CD", "thumb": "abc"}, [read])
    assert live == {
        "room": "gate",
        "ts": 42.0,
        "last": {"plate": "AB123CD", "thumb": "abc"},
        "recent": [read],
    }


def test_snapshot_filename_is_deterministic_and_safe():
    assert snapshot_filename("AB123CD", 1712345678.912) == "1712345678912-AB123CD.jpg"
    assert snapshot_filename("../evil", 1.0) == "1000-evil.jpg"
    assert snapshot_filename("", 1.0) == "1000-UNKNOWN.jpg"


# ---------------------------------------------------------------------------
# post_json
# ---------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_post_json_sends_ingest_token_header_and_returns_status():
    captured = {}

    def opener(req, timeout):
        captured["url"] = req.full_url
        captured["body"] = req.data
        captured["token"] = req.get_header("X-plugin-ingest-token")
        return _FakeResp(201)

    status = post_json(
        "http://127.0.0.1:3020/api/v1/apps/parking/plugins/lpr/events",
        {"event": "plate.detected"},
        token="tok-1",
        opener=opener,
    )
    assert status == 201
    assert captured["token"] == "tok-1"
    assert b'"event": "plate.detected"' in captured["body"]


def test_post_json_omits_header_without_token_and_swallows_errors():
    captured = {}

    def opener(req, timeout):
        captured["token"] = req.get_header("X-plugin-ingest-token")
        return _FakeResp(200)

    assert post_json("https://hooks.test/d", {"a": 1}, opener=opener) == 200
    assert captured["token"] is None

    def boom(req, timeout):
        raise OSError("no network")

    assert post_json("https://hooks.test/d", {"a": 1}, opener=boom) == 0


def test_fps_throttle_gates_by_wall_clock():
    th = FpsThrottle(target_fps=2.0)  # min interval 0.5s
    assert th.should_emit(0.0) is True
    assert th.should_emit(0.2) is False
    assert th.should_emit(0.5) is True


# ---------------------------------------------------------------------------
# run_loop
# ---------------------------------------------------------------------------

class _Clock:
    def __init__(self, start=100.0, step=1.0):
        self.t = start
        self.step = step

    def __call__(self):
        current = self.t
        self.t += self.step
        return current


class _FakeStore:
    def __init__(self):
        self.rows = []

    def add(self, ts, plate, confidence, list_match, snapshot_path):
        self.rows.append((ts, plate, confidence, list_match, snapshot_path))
        return len(self.rows)


class _Posts:
    """Capture every POST; per-URL status override."""

    def __init__(self, statuses=None):
        self.calls = []
        self.statuses = statuses or {}

    def __call__(self, url, payload, token=""):
        self.calls.append((url, token, payload))
        return self.statuses.get(url, 200)

    def to(self, url):
        return [c for c in self.calls if c[0] == url]


def _cfg(**overrides):
    env = {
        "LPR_APP": "parking",
        "LPR_ROOM": "gate",
        "LPR_CONFIDENCE": "0.5",
        "LPR_DEDUPE_SEC": "10",
        "LPR_WHITELIST": "AB123CD",
        "LPR_BLACKLIST": "XX999XX",
        "LPR_CALLBACK_URL": "https://hooks.test/gate",
        "STREAMHUB_EVENTS_URL": "http://core/events",
        "STREAMHUB_INGEST_URL": "http://core/live",
        "STREAMHUB_INGEST_TOKEN": "tok-9",
    }
    env.update(overrides)
    return Config.from_env(env)


def test_run_loop_whitelisted_plate_emits_detected_plus_allowed_everywhere():
    posts = _Posts()
    store = _FakeStore()
    stats = run_loop(
        _cfg(),
        frames=["f0"],
        read_plates=lambda f: [{"plate": "ab-123 cd", "confidence": 0.9}],
        post=posts,
        store=store,
        save_snapshot=lambda frame, plate, ts: f"/snaps/{plate}.jpg",
        make_thumb=lambda frame: "THUMBB64",
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    assert stats["reads"] == 1
    assert stats["events"] == 2
    assert stats["post_errors"] == 0

    # Framework event channel: detected + allowed, token-authenticated.
    events = posts.to("http://core/events")
    assert [c[2]["event"] for c in events] == ["plate.detected", "plate.allowed"]
    assert all(c[1] == "tok-9" for c in events)
    data = events[0][2]["data"]
    assert data["plate"] == "AB123CD"  # normalized
    assert data["listMatch"] == "whitelist"
    assert data["snapshot"] == "/snaps/AB123CD.jpg"

    # Direct callback: same two events, flat body, NO ingest token.
    direct = posts.to("https://hooks.test/gate")
    assert [c[2]["event"] for c in direct] == ["plate.detected", "plate.allowed"]
    assert all(c[1] == "" for c in direct)
    assert direct[0][2]["app"] == "parking"

    # Live-data ring: one push, last carries the thumb, recent has the read.
    live = posts.to("http://core/live")
    assert len(live) == 1
    body = live[0][2]
    assert body["room"] == "gate"
    assert body["last"]["thumb"] == "THUMBB64"
    assert body["recent"][0]["plate"] == "AB123CD"
    assert "thumb" not in body["recent"][0]

    # SQLite row written.
    assert store.rows == [(100.0, "AB123CD", 0.9, "whitelist", "/snaps/AB123CD.jpg")]


def test_run_loop_blacklisted_and_unknown_verdicts():
    posts = _Posts()
    reads = iter(
        [
            [{"plate": "XX999XX", "confidence": 0.8}],
            [{"plate": "ZZ111ZZ", "confidence": 0.8}],
        ]
    )
    stats = run_loop(
        _cfg(),
        frames=["f0", "f1"],
        read_plates=lambda f: next(reads),
        post=posts,
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    assert stats["events"] == 3  # detected+denied, detected
    names = [c[2]["event"] for c in posts.to("http://core/events")]
    assert names == ["plate.detected", "plate.denied", "plate.detected"]
    denied = posts.to("http://core/events")[1][2]["data"]
    assert denied["listMatch"] == "blacklist"


def test_run_loop_dedupes_within_window_and_reemits_after():
    posts = _Posts()
    clock = _Clock(100.0, step=4.0)  # reads at t=100, 104, 108, 112 …
    stats = run_loop(
        _cfg(LPR_DEDUPE_SEC="10"),
        frames=["f0", "f1", "f2", "f3"],
        read_plates=lambda f: [{"plate": "ZZ111ZZ", "confidence": 0.9}],
        post=posts,
        now=clock,
        emit=lambda *a, **k: None,
    )
    # t=100 emits; 104/108 suppressed (window 10 from EMIT); 112 re-emits.
    assert stats["reads"] == 2
    assert stats["duplicates"] == 2
    assert len(posts.to("http://core/events")) == 2


def test_run_loop_filters_low_confidence_and_unreadable():
    posts = _Posts()
    stats = run_loop(
        _cfg(),
        frames=["f0"],
        read_plates=lambda f: [
            {"plate": "ZZ111ZZ", "confidence": 0.2},  # below 0.5
            {"plate": "###", "confidence": 0.9},  # normalizes to ''
        ],
        post=posts,
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    assert stats["reads"] == 0
    assert stats["low_confidence"] == 1
    assert posts.calls == []


def test_run_loop_counts_post_errors_and_keeps_going():
    posts = _Posts(statuses={"http://core/events": 500})
    stats = run_loop(
        _cfg(),
        frames=["f0"],
        read_plates=lambda f: [{"plate": "ZZ111ZZ", "confidence": 0.9}],
        post=posts,
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    # events channel failed (1 event name × 1 = detected only for unknown),
    # direct callback + live push still went out.
    assert stats["post_errors"] == 1
    assert len(posts.to("https://hooks.test/gate")) == 1
    assert len(posts.to("http://core/live")) == 1


def test_run_loop_seeds_dashboard_ring_on_start():
    posts = _Posts()
    seeded = deque(
        [{"plate": "OLD111", "confidence": 0.8, "ts": 90.0}], maxlen=25
    )
    run_loop(
        _cfg(),
        frames=[],
        read_plates=lambda f: [],
        post=posts,
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
        ring=seeded,
    )
    live = posts.to("http://core/live")
    assert len(live) == 1
    assert live[0][2]["recent"][0]["plate"] == "OLD111"


def test_run_loop_edge_mode_without_room_skips_live_channel():
    posts = _Posts()
    cfg = _cfg(LPR_ROOM="", LPR_SOURCE="rtsp://cam/1")
    stats = run_loop(
        cfg,
        frames=["f0"],
        read_plates=lambda f: [{"plate": "ZZ111ZZ", "confidence": 0.9}],
        post=posts,
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    assert stats["reads"] == 1
    assert posts.to("http://core/live") == []
    assert len(posts.to("http://core/events")) == 1
    assert len(posts.to("https://hooks.test/gate")) == 1


def test_run_loop_snapshots_off_skips_saver():
    calls = []
    run_loop(
        _cfg(LPR_SNAPSHOTS="false"),
        frames=["f0"],
        read_plates=lambda f: [{"plate": "ZZ111ZZ", "confidence": 0.9}],
        post=_Posts(),
        save_snapshot=lambda frame, plate, ts: calls.append(plate) or "/x.jpg",
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    assert calls == []


def test_run_loop_ring_is_bounded_newest_first():
    posts = _Posts()
    plates = [f"ZZ{i:03d}ZZ" for i in range(30)]
    it = iter(plates)
    run_loop(
        _cfg(LPR_DEDUPE_SEC="0", LPR_WHITELIST="", LPR_BLACKLIST=""),
        frames=list(range(30)),
        read_plates=lambda f: [{"plate": next(it), "confidence": 0.9}],
        post=posts,
        now=_Clock(100.0),
        emit=lambda *a, **k: None,
    )
    last_push = posts.to("http://core/live")[-1][2]
    assert len(last_push["recent"]) == 25  # RING_SIZE cap
    assert last_push["recent"][0]["plate"] == "ZZ029ZZ"  # newest first
