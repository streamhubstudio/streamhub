"""Env parsing + clamping, line parsing, stream-source resolution, validation."""
import os

from people_counter_worker.config import (
    DEFAULT_LINE,
    Config,
    default_tracker_path,
    parse_line,
)


def cfg(**env):
    base = {"PC_APP": "live", "PC_ROOM": "door"}
    base.update(env)
    return Config.from_env(base)


class TestParseLine:
    def test_valid(self):
        assert parse_line("0.1,0.2,0.9,0.8") == (0.1, 0.2, 0.9, 0.8)

    def test_clamped_to_unit_square(self):
        assert parse_line("-1,0.5,2,0.5") == (0.0, 0.5, 1.0, 0.5)

    def test_malformed_falls_back_to_default(self):
        assert parse_line("nope") == DEFAULT_LINE
        assert parse_line("0.1,0.2,0.3") == DEFAULT_LINE
        assert parse_line("") == DEFAULT_LINE
        assert parse_line(None) == DEFAULT_LINE

    def test_degenerate_line_falls_back_to_default(self):
        # Both points equal (also after clamping) → useless zero-length line.
        assert parse_line("0.5,0.5,0.5,0.5") == DEFAULT_LINE
        assert parse_line("2,0.5,3,0.5") == DEFAULT_LINE  # both clamp to (1,0.5)


class TestFromEnv:
    def test_defaults(self):
        c = cfg()
        assert c.model == "yolov8n"
        assert c.device == "cpu"
        assert c.confidence == 0.3
        assert c.fps == 5.0
        assert c.line == DEFAULT_LINE
        assert c.in_side == "right"
        assert c.capacity == 0
        assert c.tracker == default_tracker_path()
        assert c.sample_interval == 10.0
        assert c.db_path.endswith("people-counter.db")

    def test_bundled_tracker_yaml_exists(self):
        assert os.path.isfile(default_tracker_path())

    def test_model_whitelist(self):
        assert cfg(PC_MODEL="yolov8m").model == "yolov8m"
        assert cfg(PC_MODEL="resnet").model == "yolov8n"

    def test_device_whitelist(self):
        assert cfg(PC_DEVICE="CUDA").device == "cuda"
        assert cfg(PC_DEVICE="mps").device == "cpu"

    def test_in_direction_whitelist(self):
        assert cfg(PC_IN_DIRECTION="LEFT").in_side == "left"
        assert cfg(PC_IN_DIRECTION="up").in_side == "right"

    def test_numeric_clamps(self):
        c = cfg(PC_CONFIDENCE="7", PC_FPS="99", PC_CAPACITY="-3", PC_MAX_JUMP="9")
        assert c.confidence == 1.0
        assert c.fps == 30.0
        assert c.capacity == 0
        assert c.max_jump == 1.0

    def test_garbage_numbers_fall_back(self):
        c = cfg(PC_CONFIDENCE="high", PC_FPS="", PC_CAPACITY="lots")
        assert c.confidence == 0.3
        assert c.fps == 5.0
        assert c.capacity == 0

    def test_callback_and_ingest(self):
        c = cfg(
            PC_CALLBACK_URL=" https://x/hook ",
            PC_CALLBACK_SECRET="s3cret",
            STREAMHUB_INGEST_URL="http://127.0.0.1:3020/api/v1/apps/live/plugins/people-counter/live",
            STREAMHUB_INGEST_TOKEN="tok",
        )
        assert c.callback_url == "https://x/hook"
        assert c.callback_secret == "s3cret"
        assert c.ingest_url.endswith("/live")
        assert c.ingest_token == "tok"

    def test_db_path_override(self):
        assert cfg(PC_DB_PATH="/data/people-counter.db").db_path == (
            "/data/people-counter.db"
        )


class TestStreamSource:
    def test_prefers_existing_local_playlist(self):
        c = cfg(PC_HLS_DIR="/apps/live/hls", PC_PUBLIC_BASE="https://hub.example")
        local = os.path.join("/apps/live/hls", "door", "index.m3u8")
        assert c.stream_source(exists=lambda p: p == local) == local

    def test_falls_back_to_public_url(self):
        c = cfg(PC_HLS_DIR="/apps/live/hls", PC_PUBLIC_BASE="https://hub.example/")
        assert (
            c.stream_source(exists=lambda p: False)
            == "https://hub.example/hls/live/door/index.m3u8"
        )

    def test_empty_when_nothing_configured(self):
        assert cfg().stream_source(exists=lambda p: False) == ""


class TestValidate:
    def test_ok(self):
        assert cfg().validate() == []

    def test_missing_app_and_room(self):
        problems = Config.from_env({}).validate()
        assert "PC_APP is required" in problems
        assert "PC_ROOM is required" in problems
