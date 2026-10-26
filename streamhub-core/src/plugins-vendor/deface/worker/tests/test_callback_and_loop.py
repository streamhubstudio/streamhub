from deface_worker.callback import build_payload, post_json
from deface_worker.config import Config
from deface_worker.runner import run_loop
from deface_worker.stream import FpsThrottle


def test_build_payload_shape():
    p = build_payload("live", "main", 123.5, [{"bbox": [0.1, 0.1, 0.2, 0.2], "score": 0.9}], 1.3)
    assert p == {
        "app": "live",
        "room": "main",
        "ts": 123.5,
        "maskScale": 1.3,
        "faces": [{"bbox": [0.1, 0.1, 0.2, 0.2], "score": 0.9}],
    }


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

    status = post_json("http://127.0.0.1:3020/api/v1/apps/live/plugins/deface/live",
                       {"room": "main"}, token="tok-1", opener=opener)
    assert status == 201
    assert captured["token"] == "tok-1"
    assert b'"room": "main"' in captured["body"]


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
    assert th.should_emit(0.9) is False
    assert th.should_emit(1.0) is True


class _Frame:
    """Fake frame exposing numpy-like .shape (h, w, channels)."""

    def __init__(self, name, w=640, h=360):
        self.name = name
        self.shape = (h, w, 3)


def _cfg():
    return Config.from_env(
        {
            "DEFACE_APP": "live",
            "DEFACE_ROOM": "main",
            "DEFACE_MASK_SCALE": "1.0",
            "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/ingest",
            "STREAMHUB_INGEST_TOKEN": "tok-9",
        }
    )


def test_run_loop_posts_every_frame_including_empty_ones():
    frames = [_Frame("f0"), _Frame("f1"), _Frame("f2")]

    def detect(frame):
        if frame.name == "f1":
            return [[64, 36, 128, 72, 0.9]]
        return []  # empty results MUST still be posted (clears overlay masks)

    posts = []

    def post(url, payload, token=""):
        posts.append((url, token, payload))
        return 200

    stats = run_loop(_cfg(), frames, detect, post=post, now=lambda: 42.0, emit=lambda *a, **k: None)
    assert stats == {"frames": 3, "faces": 1, "posts": 3, "post_errors": 0}
    assert [len(p[2]["faces"]) for p in posts] == [0, 1, 0]
    assert all(p[0] == "http://127.0.0.1:3020/ingest" and p[1] == "tok-9" for p in posts)
    # normalized bbox with mask_scale 1.0: 64/640, 36/360, 64/640, 36/360
    assert posts[1][2]["faces"][0] == {"bbox": [0.1, 0.1, 0.1, 0.1], "score": 0.9}
    assert posts[1][2]["maskScale"] == 1.0
    assert posts[1][2]["ts"] == 42.0


def test_run_loop_logs_on_count_change_and_counts_post_errors():
    frames = [_Frame(str(i)) for i in range(4)]
    results = [[], [[0, 0, 10, 10, 0.8]], [[0, 0, 10, 10, 0.8]], []]
    it = iter(results)

    def detect(_frame):
        return next(it)

    statuses = iter([200, 200, 500, 200])
    events = []

    def post(url, payload, token=""):
        return next(statuses)

    def emit(event, **fields):
        events.append((event, fields.get("count")))

    stats = run_loop(_cfg(), frames, detect, post=post, now=lambda: 1.0, emit=emit)
    assert stats["posts"] == 4
    assert stats["post_errors"] == 1
    # faces logged on 0-face start, on 0→1; the 500 logs callback_error; back to 0 logs again.
    assert events == [
        ("faces", 0),
        ("faces", 1),
        ("callback_error", None),
        ("faces", 0),
    ]
