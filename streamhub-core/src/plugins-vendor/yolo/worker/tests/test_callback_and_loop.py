from yolo_worker.callback import build_payload, post_json
from yolo_worker.config import Config
from yolo_worker.stream import FpsThrottle
from yolo_worker.runner import run_loop


def test_build_payload_shape():
    p = build_payload("live", "main", 123.5, [{"class": "person", "conf": 0.9, "bbox": [0, 0, 1, 1]}])
    assert p == {
        "app": "live",
        "room": "main",
        "ts": 123.5,
        "detections": [{"class": "person", "conf": 0.9, "bbox": [0, 0, 1, 1]}],
    }


class _FakeResp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_post_json_returns_status_and_swallows_errors():
    captured = {}

    def opener(req, timeout):
        captured["url"] = req.full_url
        captured["body"] = req.data
        return _FakeResp(202)

    status = post_json("https://hooks.test/y", {"a": 1}, opener=opener)
    assert status == 202
    assert captured["url"] == "https://hooks.test/y"
    assert b'"a": 1' in captured["body"]

    def boom(req, timeout):
        raise OSError("no network")

    assert post_json("https://hooks.test/y", {"a": 1}, opener=boom) == 0


def test_fps_throttle_gates_by_wall_clock():
    th = FpsThrottle(target_fps=2.0)  # min interval 0.5s
    assert th.should_emit(0.0) is True
    assert th.should_emit(0.2) is False
    assert th.should_emit(0.5) is True
    assert th.should_emit(0.9) is False
    assert th.should_emit(1.0) is True


def test_run_loop_posts_only_frames_with_detections():
    cfg = Config.from_env(
        {"YOLO_APP": "live", "YOLO_ROOM": "main", "YOLO_CALLBACK_URL": "https://h/y"}
    )
    frames = ["f0", "f1", "f2"]

    def detect(frame):
        if frame == "f1":
            return [{"class": "person", "conf": 0.9, "bbox": [0, 0, 1, 1]}]
        return []

    posts = []

    def post(url, payload):
        posts.append((url, payload))
        return 200

    stats = run_loop(cfg, frames, detect, post=post, now=lambda: 42.0)
    assert stats == {"frames": 3, "detections": 1, "posts": 1, "post_errors": 0}
    assert len(posts) == 1
    assert posts[0][0] == "https://h/y"
    assert posts[0][1]["ts"] == 42.0
    assert posts[0][1]["detections"][0]["class"] == "person"


def test_run_loop_counts_callback_errors():
    cfg = Config.from_env(
        {"YOLO_APP": "a", "YOLO_ROOM": "r", "YOLO_CALLBACK_URL": "https://h/y"}
    )

    def detect(_):
        return [{"class": "car", "conf": 0.7, "bbox": [0, 0, 1, 1]}]

    stats = run_loop(cfg, ["f"], detect, post=lambda u, p: 500, now=lambda: 1.0)
    assert stats["posts"] == 1
    assert stats["post_errors"] == 1
