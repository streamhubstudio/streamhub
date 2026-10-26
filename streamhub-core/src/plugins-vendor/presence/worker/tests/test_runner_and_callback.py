"""Runner loop + callback plumbing: event fan-out (core signed callbacks +
external webhook), SQLite writes, live-channel pushes — all with fakes (no
OpenCV/torch/network)."""
import io
import json
import urllib.error

from presence_worker.callback import (
    build_event_payload,
    build_live_payload,
    post_json,
)
from presence_worker.config import Config
from presence_worker.monitor import PresenceMonitor
from presence_worker.runner import (
    LIVE_PUSH_INTERVAL_S,
    OCCUPANCY_HEARTBEAT_S,
    run_loop,
)
from presence_worker.schedule import Schedule
from presence_worker.store import PresenceStore
from presence_worker.zones import Zone

ZONES_JSON = json.dumps(
    [{"id": "desk", "name": "Desk", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}]
)


def make_config(tmp_path, **over):
    env = {
        "PRESENCE_APP": "live",
        "PRESENCE_ROOM": "office",
        "PRESENCE_ZONES": ZONES_JSON,
        "PRESENCE_THRESHOLD_MIN": "1",  # 60s
        "PRESENCE_DATA_DIR": str(tmp_path),
        "PRESENCE_CALLBACK_URL": "https://hooks.example.com/presence",
        "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/api/v1/apps/live/plugins/presence/live",
        "STREAMHUB_INGEST_TOKEN": "tok-1",
    }
    env.update(over)
    return Config.from_env(env)


# ---------------------------------------------------------------------------
# callback payloads + POST
# ---------------------------------------------------------------------------


def test_build_event_payload_carries_event_fields():
    ev = {
        "event": "presence.absent",
        "zone": "desk",
        "zoneName": "Desk",
        "ts": 12.5,
        "emptyForSec": 60.0,
        "thresholdMin": 1.0,
    }
    body = build_event_payload("live", "office", ev)
    assert body["app"] == "live" and body["room"] == "office"
    assert body["event"] == "presence.absent"
    assert body["zone"] == "desk" and body["thresholdMin"] == 1.0


def test_build_live_payload_shape():
    body = build_live_payload(
        room="office",
        ts=99.0,
        zones=[{"id": "desk", "persons": 1}],
        events=[{"event": "presence.returned"}],
        timeline=[{"ts": 1, "zone": "desk", "persons": 1}],
        threshold_min=5.0,
        schedule={"window": "08:00-18:00", "inSchedule": True},
    )
    assert body["room"] == "office" and body["ts"] == 99.0
    assert body["thresholdMin"] == 5.0
    assert body["zones"][0]["id"] == "desk"
    assert body["schedule"]["inSchedule"] is True


def test_post_json_success_headers_and_token():
    seen = {}

    def opener(req, timeout):
        seen["url"] = req.full_url
        seen["headers"] = dict(req.headers)
        seen["body"] = json.loads(req.data.decode("utf-8"))
        resp = io.BytesIO(b"{}")
        resp.status = 200
        return resp

    status = post_json(
        "http://core/events", {"event": "presence.absent"}, token="tok-1", opener=opener
    )
    assert status == 200
    assert seen["body"] == {"event": "presence.absent"}
    assert seen["headers"].get("X-plugin-ingest-token") == "tok-1"

    # without a token the header is absent
    seen.clear()
    post_json("http://ext/hook", {"a": 1}, opener=opener)
    assert "X-plugin-ingest-token" not in seen["headers"]


def test_post_json_never_raises():
    def http_error(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "nope", None, None)

    def net_error(req, timeout):
        raise urllib.error.URLError("refused")

    assert post_json("http://x", {}, opener=http_error) == 401
    assert post_json("http://x", {}, opener=net_error) == 0


# ---------------------------------------------------------------------------
# run_loop
# ---------------------------------------------------------------------------


class FakePoster:
    def __init__(self, status=200):
        self.status = status
        self.calls = []

    def __call__(self, url, payload, token="", timeout=5.0):
        self.calls.append({"url": url, "payload": payload, "token": token})
        return self.status

    def to(self, url):
        return [c for c in self.calls if c["url"] == url]


def run_scripted(config, script, store, post):
    """Drive run_loop with a scripted timeline: [(t, persons), ...]. The fake
    detector emits `persons` centered boxes for the frame at time t. run_loop
    calls now() once up-front (DB seeding), so the first time is prepended."""
    times = iter([script[0][0]] + [t for (t, _n) in script])
    counts = iter([n for (_t, n) in script])
    frames = range(len(script))

    def detect(_frame):
        n = next(counts)
        return [{"bbox": [0.4, 0.4, 0.2, 0.3], "conf": 0.9} for _ in range(n)]

    schedule = Schedule.from_strings("", "", "")  # disabled → always in hours
    monitor = PresenceMonitor(
        [Zone("desk", "Desk", 0.0, 0.0, 1.0, 1.0)],
        threshold_s=config.threshold_min * 60.0,
        in_schedule=schedule.contains,
    )
    return run_loop(
        config,
        frames,
        detect,
        monitor,
        store,
        schedule,
        post=post,
        now=lambda: next(times),
        emit=lambda *a, **k: None,
    )


def test_events_fan_out_to_core_and_webhook(tmp_path):
    config = make_config(tmp_path)
    store = PresenceStore(config.db_path())
    post = FakePoster()
    # occupied at t=0, empty from t=10 → absent at t=70; returns at t=80
    stats = run_scripted(
        config, [(0, 1), (10, 0), (70, 0), (80, 1)], store, post
    )
    assert stats["frames"] == 4
    assert stats["events"] == 2  # absent + returned
    assert stats["post_errors"] == 0

    events_url = config.events_url()
    core_events = post.to(events_url)
    hook_events = post.to(config.callback_url)
    assert [c["payload"]["event"] for c in core_events] == [
        "presence.absent",
        "presence.returned",
    ]
    assert [c["payload"]["event"] for c in hook_events] == [
        "presence.absent",
        "presence.returned",
    ]
    # ingest token ONLY on the core channel, never leaked to the webhook
    assert all(c["token"] == "tok-1" for c in core_events)
    assert all(c["token"] == "" for c in hook_events)
    # the events also landed in the worker-owned SQLite
    db = store.events_since(0)
    assert [r["event"] for r in db] == ["presence.returned", "presence.absent"]
    store.close()


def test_occupancy_written_on_change_and_heartbeat(tmp_path):
    config = make_config(tmp_path, PRESENCE_CALLBACK_URL="")
    store = PresenceStore(config.db_path())
    post = FakePoster()
    dt = OCCUPANCY_HEARTBEAT_S
    stats = run_scripted(
        config,
        [(0, 1), (1, 1), (2, 0), (3, 0), (3 + dt, 0)],
        store,
        post,
    )
    rows = store.occupancy_since(0)
    # t=0 first sample, t=2 change to 0, t=3+dt heartbeat — t=1 and t=3 skipped
    assert [(r["ts"], r["persons"]) for r in rows] == [
        (0.0, 1),
        (2.0, 0),
        (3.0 + dt, 0),
    ]
    assert stats["occupancy_writes"] == 3
    store.close()


def test_live_pushes_are_throttled_and_carry_state(tmp_path):
    config = make_config(tmp_path, PRESENCE_CALLBACK_URL="")
    store = PresenceStore(config.db_path())
    post = FakePoster()
    step = LIVE_PUSH_INTERVAL_S
    run_scripted(
        config,
        [(0, 1), (0.5, 1), (step, 2), (step + 0.5, 2)],
        store,
        post,
    )
    pushes = post.to(config.ingest_url)
    assert len(pushes) == 2  # t=0 and t=step; the in-between samples throttled
    first, second = (p["payload"] for p in pushes)
    assert first["room"] == "office"
    assert first["zones"][0]["persons"] == 1
    assert second["zones"][0]["persons"] == 2
    assert second["timeline"][-1]["persons"] == 2
    assert all(p["token"] == "tok-1" for p in pushes)
    store.close()


def test_post_errors_are_counted_not_fatal(tmp_path):
    config = make_config(tmp_path)
    store = PresenceStore(config.db_path())
    post = FakePoster(status=500)
    stats = run_scripted(config, [(0, 1), (10, 0), (70, 0)], store, post)
    assert stats["events"] == 1
    # 1 event × (core + webhook) + live pushes all failed but the loop survived
    assert stats["post_errors"] >= 3
    assert stats["frames"] == 3
    store.close()


def test_timeline_seeds_from_existing_db(tmp_path):
    config = make_config(tmp_path, PRESENCE_CALLBACK_URL="")
    seed = PresenceStore(config.db_path())
    seed.add_occupancy(1.0, "desk", 3)
    seed.add_event(1.5, "desk", "presence.absent")
    seed.close()

    store = PresenceStore(config.db_path())
    post = FakePoster()
    run_scripted(config, [(2, 0)], store, post)
    payload = post.to(config.ingest_url)[0]["payload"]
    assert {"ts": 1.0, "zone": "desk", "persons": 3} in payload["timeline"]
    assert payload["events"][0]["event"] == "presence.absent"
    store.close()
