import json

from perimeter_worker.config import Config


def full_env(**over):
    env = {
        "PERIMETER_APP": "live",
        "PERIMETER_ROOM": "cam-1",
        "PERIMETER_DATA_DIR": "/data/apps/live/perimeter",
        "PERIMETER_ZONES": json.dumps([{"id": "gate", "rect": [0, 0.5, 1, 0.5]}]),
    }
    env.update(over)
    return env


def test_defaults_from_minimal_env():
    cfg = Config.from_env(full_env())
    assert cfg.app == "live"
    assert cfg.room == "cam-1"
    assert cfg.model == "yolov8n"
    assert cfg.device == "cpu"
    assert cfg.confidence == 0.5
    assert cfg.fps == 1.0
    assert cfg.anchor == "foot"
    assert cfg.arm_mode == "schedule"
    assert cfg.arm_window == (22 * 60, 6 * 60)  # default 22:00-06:00
    assert cfg.arm_weekends is True
    assert cfg.timezone == ""
    assert cfg.cooldown == 60.0
    assert cfg.clip_seconds == 10.0
    assert cfg.ack_through == 0.0
    assert [z["id"] for z in cfg.zones] == ["gate"]
    assert cfg.validate() == []


def test_clamping_and_fallbacks():
    cfg = Config.from_env(
        full_env(
            PERIMETER_MODEL="yolov9-giant",
            PERIMETER_DEVICE="tpu",
            PERIMETER_CONFIDENCE="7",
            PERIMETER_FPS="99",
            PERIMETER_ANCHOR="head",
            PERIMETER_ARM_MODE="party",
            PERIMETER_ARM_SCHEDULE="garbage",
            PERIMETER_COOLDOWN="0",
            PERIMETER_CLIP_SECONDS="900",
            PERIMETER_ARM_WEEKENDS="off",
        )
    )
    assert cfg.model == "yolov8n"
    assert cfg.device == "cpu"
    assert cfg.confidence == 1.0
    assert cfg.fps == 10.0
    assert cfg.anchor == "foot"
    assert cfg.arm_mode == "schedule"
    assert cfg.arm_window is None  # malformed window → never armed by window
    assert cfg.cooldown == 1.0
    assert cfg.clip_seconds == 60.0
    assert cfg.arm_weekends is False


def test_callback_and_ingest_channels():
    cfg = Config.from_env(
        full_env(
            PERIMETER_CALLBACK_URL="https://hooks.example/perimeter",
            PERIMETER_CALLBACK_SECRET="s3cret",
            STREAMHUB_INGEST_URL="http://127.0.0.1:3020/api/v1/apps/live/plugins/perimeter/live",
            STREAMHUB_INGEST_TOKEN="tok-1",
        )
    )
    assert cfg.callback_url == "https://hooks.example/perimeter"
    assert cfg.callback_secret == "s3cret"
    assert cfg.ingest_url.endswith("/plugins/perimeter/live")
    assert cfg.ingest_token == "tok-1"


def test_derived_paths_and_stream_source():
    cfg = Config.from_env(
        full_env(
            PERIMETER_HLS_DIR="/data/apps/live/hls",
            PERIMETER_PUBLIC_BASE="https://stream.example.com/",
        )
    )
    assert cfg.db_path() == "/data/apps/live/perimeter/perimeter.db"
    assert cfg.evidence_dir() == "/data/apps/live/perimeter/evidence"
    assert cfg.local_playlist() == "/data/apps/live/hls/cam-1/index.m3u8"
    assert cfg.public_playlist() == "https://stream.example.com/hls/live/cam-1/index.m3u8"
    # prefer the local playlist when present
    assert cfg.stream_source(exists=lambda p: True) == cfg.local_playlist()
    assert cfg.stream_source(exists=lambda p: False) == cfg.public_playlist()


def test_validate_reports_missing_pieces():
    cfg = Config.from_env({})
    problems = "\n".join(cfg.validate())
    assert "PERIMETER_APP" in problems
    assert "PERIMETER_ROOM" in problems
    assert "PERIMETER_DATA_DIR" in problems
    assert "ZONES" in problems

    # empty zones json is a config problem (nothing to guard)
    cfg2 = Config.from_env(full_env(PERIMETER_ZONES="[]"))
    assert any("zone" in p.lower() for p in cfg2.validate())
