"""Signed envelope/HMAC builder, posters (no network) and the run loop:
track → count → sqlite → signed events → live snapshots. Also the pure
`normalize_tracks` mapping."""
import hashlib
import hmac
import json

from people_counter_worker.callback import (
    build_envelope,
    build_live_payload,
    iso_ts,
    post_event,
    post_live,
    sign_body,
)
from people_counter_worker.config import Config
from people_counter_worker.counter import CapacityAlert, LineCrossingCounter
from people_counter_worker.runner import run_loop
from people_counter_worker.store import CountStore
from people_counter_worker.stream import FpsThrottle
from people_counter_worker.tracking import normalize_tracks


def make_config(**kw):
    env = {
        "PC_APP": "live",
        "PC_ROOM": "door",
        "PC_LINE": "0.2,0.5,0.8,0.5",
        "PC_IN_DIRECTION": "right",
        "PC_SAMPLE_INTERVAL": "10",
    }
    env.update(kw)
    return Config.from_env(env)


# ---------------------------------------------------------------------------
# Envelope + signature
# ---------------------------------------------------------------------------


class TestEnvelope:
    def test_shape_mirrors_core_callbacks(self):
        env = build_envelope("live", "door", "count.in", {"occupancy": 1}, 1e9, "d-1")
        assert env == {
            "id": "d-1",
            "event": "count.in",
            "app": "live",
            "room": "door",
            "ts": env["ts"],
            "timestamp": env["ts"],
            "data": {"occupancy": 1},
        }
        assert env["ts"].endswith("Z")

    def test_empty_room_maps_to_null(self):
        assert build_envelope("live", "", "count.out", {}, 0)["room"] is None

    def test_iso_ts(self):
        assert iso_ts(0) == "1970-01-01T00:00:00.000Z"

    def test_signature_is_hmac_sha256_of_body(self):
        body = b'{"x":1}'
        expected = hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        assert sign_body("secret", body) == f"sha256={expected}"


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestPosters:
    def test_post_event_sends_signed_headers(self):
        seen = {}

        def opener(req, timeout):
            seen["url"] = req.full_url
            seen["headers"] = dict(req.header_items())
            seen["body"] = req.data
            return FakeResponse(200)

        env = build_envelope("live", "door", "count.in", {"n": 1}, 1e9, "d-9")
        status = post_event("https://x/hook", env, secret="s3", opener=opener)
        assert status == 200
        headers = {k.lower(): v for k, v in seen["headers"].items()}
        assert headers["x-streamhub-event"] == "count.in"
        assert headers["x-streamhub-delivery"] == "d-9"
        assert headers["x-streamhub-signature"] == sign_body("s3", seen["body"])
        assert json.loads(seen["body"]) == env

    def test_post_event_without_secret_has_no_signature(self):
        seen = {}

        def opener(req, timeout):
            seen["headers"] = {k.lower() for k, _ in req.header_items()}
            return FakeResponse(204)

        env = build_envelope("live", "door", "count.out", {}, 0)
        assert post_event("https://x/hook", env, opener=opener) == 204
        assert "x-streamhub-signature" not in seen["headers"]

    def test_post_event_swallows_transport_errors(self):
        def opener(req, timeout):
            raise OSError("boom")

        env = build_envelope("live", "door", "count.in", {}, 0)
        assert post_event("https://x/hook", env, opener=opener) == 0

    def test_post_live_carries_ingest_token(self):
        seen = {}

        def opener(req, timeout):
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            return FakeResponse(201)

        payload = build_live_payload("live", "door", 1.0, 2, 1, 1, 10, 3)
        assert post_live("http://core/live", payload, token="tok", opener=opener) == 201
        assert seen["headers"]["x-plugin-ingest-token"] == "tok"
        assert payload["room"] == "door"
        assert payload["occupancy"] == 1


# ---------------------------------------------------------------------------
# normalize_tracks
# ---------------------------------------------------------------------------


class TestNormalizeTracks:
    def test_centers_normalized_and_clamped(self):
        out = normalize_tracks(
            [[100, 100, 300, 500], [-100, -100, 100, 100]],
            [5, 6],
            [0.9, 0.8],
            width=1000,
            height=1000,
        )
        assert out[0] == {"id": 5, "cx": 0.2, "cy": 0.3, "conf": 0.9}
        assert out[1]["cx"] == 0.0  # clamped off-frame center
        assert out[1]["cy"] == 0.0

    def test_confidence_filter(self):
        out = normalize_tracks([[0, 0, 10, 10]], [1], [0.2], 100, 100, min_conf=0.5)
        assert out == []

    def test_degenerate_frame_size(self):
        assert normalize_tracks([[0, 0, 1, 1]], [1], [0.9], 0, 100) == []


# ---------------------------------------------------------------------------
# The run loop
# ---------------------------------------------------------------------------


def fake_walk_tracks():
    """Track 1 walks straight down across the line over 4 frames."""
    ys = [0.32, 0.44, 0.56, 0.68]
    return [[{"id": 1, "cx": 0.5, "cy": y, "conf": 0.9}] for y in ys]


class LoopHarness:
    def __init__(self, tmp_path, **cfg_env):
        self.config = make_config(**cfg_env)
        self.store = CountStore(str(tmp_path / "pc.db"), app="live", room="door")
        self.counter = LineCrossingCounter(
            *self.config.line_points(),
            self.config.in_side,
            cooldown_frames=self.config.cooldown_frames,
            max_jump=self.config.max_jump,
        )
        self.alert = CapacityAlert(self.config.capacity)
        self.events = []
        self.live = []
        self.logs = []
        self.now = iter(float(i) for i in range(1000))

    def post_event(self, url, envelope, secret=""):
        self.events.append((url, envelope, secret))
        return 200

    def post_live(self, url, payload, token=""):
        self.live.append((url, payload, token))
        return 200

    def run(self, frames_tracks):
        frames = list(range(len(frames_tracks)))
        it = iter(frames_tracks)
        return run_loop(
            self.config,
            frames,
            lambda _frame: next(it),
            self.counter,
            self.alert,
            self.store,
            post_event_fn=self.post_event,
            post_live_fn=self.post_live,
            now=lambda: next(self.now),
            emit=lambda event, **f: self.logs.append({"event": event, **f}),
        )


class TestRunLoop:
    def test_crossing_persists_and_delivers_signed_event(self, tmp_path):
        h = LoopHarness(
            tmp_path,
            PC_CALLBACK_URL="https://x/hook",
            PC_CALLBACK_SECRET="shh",
            STREAMHUB_INGEST_URL="http://core/live",
            STREAMHUB_INGEST_TOKEN="tok",
        )
        stats = h.run(fake_walk_tracks())
        assert stats["in"] == 1 and stats["out"] == 0
        assert h.store.totals() == (1, 0)
        # one count.in event, signed with the configured secret
        assert [e[1]["event"] for e in h.events] == ["count.in"]
        assert h.events[0][2] == "shh"
        assert h.events[0][1]["data"]["direction"] == "in"
        assert h.events[0][1]["data"]["occupancy"] == 1
        # live snapshots flowed to the ingest channel with the token
        assert h.live and all(t == "tok" for _, _, t in h.live)
        assert h.live[-1][1]["in"] == 1

    def test_no_callback_url_keeps_events_local(self, tmp_path):
        h = LoopHarness(tmp_path)
        stats = h.run(fake_walk_tracks())
        assert stats["in"] == 1
        assert h.events == []  # nothing delivered...
        assert h.store.totals() == (1, 0)  # ...but still persisted

    def test_occupancy_limit_fires_at_capacity(self, tmp_path):
        h = LoopHarness(tmp_path, PC_CALLBACK_URL="https://x/hook", PC_CAPACITY="2")
        # Two people walk in, one frame streams after another.
        frames = []
        for tid in (1, 2):
            for y in (0.32, 0.44, 0.56, 0.68):
                frames.append([{"id": tid, "cx": 0.5, "cy": y, "conf": 0.9}])
        h.run(frames)
        names = [e[1]["event"] for e in h.events]
        assert names == ["count.in", "count.in", "occupancy.limit"]
        limit = h.events[-1][1]
        assert limit["data"] == {"room": "door", "occupancy": 2, "capacity": 2}

    def test_counters_heartbeat_and_occupancy_samples(self, tmp_path):
        h = LoopHarness(tmp_path, PC_SAMPLE_INTERVAL="5")
        # 12 empty frames, clock ticking 1 s per event → samples at t0, +5, +10.
        stats = h.run([[] for _ in range(12)])
        assert stats["samples"] == 3
        counters = [l for l in h.logs if l["event"] == "counters"]
        assert len(counters) == 3
        assert counters[0]["occupancy"] == 0

    def test_callback_error_is_counted_and_logged(self, tmp_path):
        h = LoopHarness(tmp_path, PC_CALLBACK_URL="https://x/hook")
        h.post_event = lambda url, envelope, secret="": 500
        stats = h.run(fake_walk_tracks())
        assert stats["events"] == 1
        assert stats["event_errors"] == 1
        assert any(l["event"] == "callback_error" for l in h.logs)


class TestFpsThrottle:
    def test_emits_at_target_rate(self):
        t = FpsThrottle(2.0)  # min interval 0.5s
        assert t.should_emit(0.0) is True
        assert t.should_emit(0.2) is False
        assert t.should_emit(0.5) is True
        assert t.should_emit(0.9) is False
        assert t.should_emit(1.0) is True
