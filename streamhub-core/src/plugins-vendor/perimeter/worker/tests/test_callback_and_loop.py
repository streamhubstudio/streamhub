import hashlib
import hmac
import json

from perimeter_worker import alerts_db
from perimeter_worker.callback import build_event, post_json, sign_body
from perimeter_worker.config import Config
from perimeter_worker.runner import (
    MAX_STATUS_BYTES,
    ZoneCooldown,
    build_status,
    default_armed_fn,
    fit_status,
    run_loop,
)


class FakeFrame:
    shape = (360, 640, 3)


FRAME = FakeFrame()

# A person standing bottom-center (foot anchor inside the bottom-half zone).
PERSON_PX = [280.0, 90.0, 360.0, 350.0, 0.91]


def make_config(tmp_path, **over):
    env = {
        "PERIMETER_APP": "live",
        "PERIMETER_ROOM": "cam-1",
        "PERIMETER_DATA_DIR": str(tmp_path),
        "PERIMETER_ZONES": json.dumps([{"id": "gate", "rect": [0, 0.5, 1, 0.5]}]),
        "PERIMETER_COOLDOWN": "60",
        "PERIMETER_STATUS_INTERVAL": "2",
        "PERIMETER_CALLBACK_URL": "https://hooks.test/perimeter",
        "PERIMETER_CALLBACK_SECRET": "s3cret",
        "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/ingest",
        "STREAMHUB_INGEST_TOKEN": "tok",
    }
    env.update(over)
    return Config.from_env(env)


# ---------------------------------------------------------------------------
# callback: event shape + signing
# ---------------------------------------------------------------------------


def test_build_event_shape():
    ev = build_event("live", "cam-1", 42.5, "gate", 0.91, "/e/a.jpg", "/e/a.mp4")
    assert ev == {
        "event": "perimeter.intrusion",
        "app": "live",
        "room": "cam-1",
        "ts": 42.5,
        "zone": "gate",
        "confidence": 0.91,
        "snapshot": "/e/a.jpg",
        "clip": "/e/a.mp4",
    }


def test_sign_body_matches_core_callbacks_scheme():
    body = b'{"event":"perimeter.intrusion"}'
    expected = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert sign_body(body, "s3cret") == f"sha256={expected}"


class _FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_post_json_sets_token_and_signature_headers():
    captured = {}

    def opener(req, timeout):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = req.data
        return _FakeResp(202)

    status = post_json(
        "https://hooks.test/p", {"a": 1}, token="tok", secret="s3cret", opener=opener
    )
    assert status == 202
    headers = {k.lower(): v for k, v in captured["headers"].items()}
    assert headers["x-plugin-ingest-token"] == "tok"
    assert headers["x-streamhub-signature"] == sign_body(captured["body"], "s3cret")

    # no token/secret → no auth headers at all
    def opener2(req, timeout):
        captured["headers2"] = {k.lower() for k, _ in req.header_items()}
        return _FakeResp(200)

    post_json("https://hooks.test/p", {"a": 1}, opener=opener2)
    assert "x-plugin-ingest-token" not in captured["headers2"]
    assert "x-streamhub-signature" not in captured["headers2"]

    def boom(req, timeout):
        raise OSError("no network")

    assert post_json("https://hooks.test/p", {"a": 1}, opener=boom) == 0


# ---------------------------------------------------------------------------
# cooldown
# ---------------------------------------------------------------------------


def test_zone_cooldown_is_per_zone():
    cd = ZoneCooldown(60)
    assert cd.try_fire("gate", 0.0) is True
    assert cd.try_fire("gate", 30.0) is False
    assert cd.try_fire("door", 30.0) is True  # other zone independent
    assert cd.try_fire("gate", 60.0) is True  # elapsed → re-fires
    assert cd.try_fire("gate", 61.0) is False


# ---------------------------------------------------------------------------
# the loop
# ---------------------------------------------------------------------------


def run_with(config, db, frames, detect, times, posts, armed=True, clip=None):
    it = iter(times)
    return run_loop(
        config,
        frames,
        detect,
        db,
        post=lambda url, payload, token="", secret="": (
            posts.append({"url": url, "payload": payload, "token": token, "secret": secret}),
            200,
        )[1],
        now=lambda: next(it),
        armed_fn=lambda t: armed,
        snapshot=lambda frame, path: True,
        clip=clip,
        thumb=lambda frame: "THUMB64",
        emit=lambda *a, **k: None,
    )


def test_run_loop_fires_persists_and_delivers(tmp_path):
    config = make_config(tmp_path)
    db = alerts_db.connect(config.db_path())
    posts = []
    stats = run_with(
        config,
        db,
        [FRAME],
        lambda f: [PERSON_PX],
        times=[1000.0],
        posts=posts,
        clip=lambda out: True,
    )
    assert stats["intrusions"] == 1
    assert stats["event_posts"] == 1
    assert stats["status_posts"] == 1  # pushed immediately on alert
    assert stats["post_errors"] == 0

    rows = alerts_db.recent_alerts(db)
    assert len(rows) == 1
    assert rows[0]["zone"] == "gate"
    assert rows[0]["confidence"] == 0.91
    assert rows[0]["snapshot"].endswith("-gate.jpg")
    assert rows[0]["clip"].endswith("-gate.mp4")
    assert rows[0]["acked"] is False

    event_post = posts[0]
    assert event_post["url"] == "https://hooks.test/perimeter"
    assert event_post["payload"]["event"] == "perimeter.intrusion"
    assert event_post["payload"]["zone"] == "gate"
    assert event_post["secret"] == "s3cret"  # signed operator webhook

    status_post = posts[1]
    assert status_post["url"] == "http://127.0.0.1:3020/ingest"
    assert status_post["token"] == "tok"
    payload = status_post["payload"]
    assert payload["room"] == "cam-1"
    assert payload["armed"] is True
    assert payload["unacked"] == 1
    assert payload["alerts"][0]["thumb"] == "THUMB64"
    assert payload["persons"][0]["conf"] == 0.91
    assert payload["frame"] == "THUMB64"
    db.close()


def test_cooldown_stops_alert_storms_and_recovers(tmp_path):
    config = make_config(tmp_path)  # cooldown 60s
    db = alerts_db.connect(config.db_path())
    posts = []
    # person stays in the zone for 4 frames over 90s: alert at t=0 and t=61
    stats = run_with(
        config,
        db,
        [FRAME, FRAME, FRAME, FRAME],
        lambda f: [PERSON_PX],
        times=[0.0, 30.0, 61.0, 90.0],
        posts=posts,
    )
    assert stats["intrusions"] == 2
    assert alerts_db.unacked_count(db) == 2
    db.close()


def test_disarmed_never_fires_but_status_flows(tmp_path):
    config = make_config(tmp_path)
    db = alerts_db.connect(config.db_path())
    posts = []
    stats = run_with(
        config,
        db,
        [FRAME, FRAME],
        lambda f: [PERSON_PX],
        times=[0.0, 5.0],
        posts=posts,
        armed=False,
    )
    assert stats["intrusions"] == 0
    assert stats["event_posts"] == 0
    assert stats["status_posts"] == 2  # cadence 2s: t=0 and t=5
    assert all(p["payload"]["armed"] is False for p in posts)
    assert alerts_db.unacked_count(db) == 0
    db.close()


def test_status_cadence_respects_interval(tmp_path):
    config = make_config(tmp_path)  # status_interval 2s
    db = alerts_db.connect(config.db_path())
    posts = []
    stats = run_with(
        config,
        db,
        [FRAME] * 5,
        lambda f: [],  # nobody in frame
        times=[0.0, 0.5, 1.0, 2.0, 2.5],
        posts=posts,
    )
    # pushes at t=0 and t=2 only
    assert stats["status_posts"] == 2
    assert stats["intrusions"] == 0
    db.close()


def test_out_of_zone_person_does_not_fire(tmp_path):
    config = make_config(tmp_path)
    db = alerts_db.connect(config.db_path())
    posts = []
    # person whose feet are in the TOP half (zone is the bottom half)
    top_person = [280.0, 10.0, 360.0, 150.0, 0.9]
    stats = run_with(
        config, db, [FRAME], lambda f: [top_person], times=[0.0], posts=posts
    )
    assert stats["intrusions"] == 0
    assert stats["persons"] == 1
    db.close()


# ---------------------------------------------------------------------------
# status payload builders
# ---------------------------------------------------------------------------


def test_build_status_and_fit_status_budget(tmp_path):
    config = make_config(tmp_path)
    alerts = [
        {"id": 3, "ts": 3.0, "zone": "g", "confidence": 0.9, "acked": False, "thumb": "x" * 40_000},
        {"id": 2, "ts": 2.0, "zone": "g", "confidence": 0.9, "acked": False, "thumb": "x" * 40_000},
    ]
    payload = build_status(config, 10.0, True, [], alerts, 2, frame_b64="y" * 40_000)
    assert payload["room"] == "cam-1"
    assert payload["zones"] == 1

    trimmed = fit_status(payload, MAX_STATUS_BYTES)
    # oldest thumb dropped first; metadata survives; total under budget
    assert trimmed["alerts"][1]["thumb"] == ""
    assert trimmed["alerts"][0]["zone"] == "g"
    assert len(json.dumps(trimmed)) <= MAX_STATUS_BYTES

    # small payloads pass through untouched
    small = build_status(config, 1.0, False, [], [], 0)
    assert fit_status(dict(small)) == small


def test_default_armed_fn_honors_override_and_schedule(tmp_path):
    # manual overrides win regardless of clock
    armed = default_armed_fn(make_config(tmp_path, PERIMETER_ARM_MODE="armed"))
    disarmed = default_armed_fn(make_config(tmp_path, PERIMETER_ARM_MODE="disarmed"))
    assert armed(0.0) is True and armed(1e9) is True
    assert disarmed(0.0) is False and disarmed(1e9) is False

    # schedule mode in an explicit tz: 2026-07-08 23:00 UTC (Wednesday) is
    # inside 22:00-06:00 UTC; 12:00 UTC is not.
    cfg = make_config(tmp_path, PERIMETER_TIMEZONE="UTC")
    fn = default_armed_fn(cfg)
    assert fn(1783551600.0) is True  # 2026-07-08T23:00:00Z
    assert fn(1783512000.0) is False  # 2026-07-08T12:00:00Z
