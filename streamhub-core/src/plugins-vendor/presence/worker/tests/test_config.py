"""Config: env parsing, clamping, derived URLs/paths, validation."""
import json
import os

from presence_worker.config import Config

ZONES = json.dumps([{"id": "desk", "x": 0.1, "y": 0.1, "w": 0.4, "h": 0.6}])


def full_env(**over):
    env = {
        "PRESENCE_APP": "live",
        "PRESENCE_ROOM": "office",
        "PRESENCE_ZONES": ZONES,
        "PRESENCE_SCHEDULE": "09:00-17:00",
        "PRESENCE_SCHEDULE_DAYS": "mon-sat",
        "PRESENCE_TZ": "UTC",
        "PRESENCE_THRESHOLD_MIN": "2.5",
        "PRESENCE_AFTER_HOURS": "false",
        "PRESENCE_MODEL": "yolov8s",
        "PRESENCE_DEVICE": "cuda",
        "PRESENCE_CONFIDENCE": "0.5",
        "PRESENCE_FPS": "4",
        "PRESENCE_CALLBACK_URL": "https://hooks.example.com/presence",
        "PRESENCE_DATA_DIR": "/data/apps/live/presence",
        "PRESENCE_HLS_DIR": "/data/apps/live/hls",
        "PRESENCE_PUBLIC_BASE": "https://stream.example.com",
        "PRESENCE_LIVEKIT_URL": "ws://127.0.0.1:7880",
        "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/api/v1/apps/live/plugins/presence/live",
        "STREAMHUB_INGEST_TOKEN": "tok-123",
    }
    env.update(over)
    return env


def test_from_env_full():
    c = Config.from_env(full_env())
    assert c.app == "live" and c.room == "office"
    assert [z.id for z in c.zones] == ["desk"]
    assert c.schedule_window == "09:00-17:00"
    assert c.schedule_days == "mon-sat"
    assert c.timezone == "UTC"
    assert c.threshold_min == 2.5
    assert c.after_hours is False
    assert c.model == "yolov8s" and c.device == "cuda"
    assert c.confidence == 0.5 and c.fps == 4.0
    assert c.callback_url == "https://hooks.example.com/presence"
    assert c.ingest_token == "tok-123"
    assert c.data_dir == "/data/apps/live/presence"


def test_defaults_and_clamps():
    c = Config.from_env(
        full_env(
            PRESENCE_MODEL="yolov99",
            PRESENCE_DEVICE="tpu",
            PRESENCE_CONFIDENCE="7",
            PRESENCE_FPS="99",
            PRESENCE_THRESHOLD_MIN="0",
            PRESENCE_AFTER_HOURS="not-a-bool",
        )
    )
    assert c.model == "yolov8n"          # unknown model → nano
    assert c.device == "cpu"             # unknown device → cpu
    assert c.confidence == 1.0           # clamped
    assert c.fps == 10.0                 # clamped to presence max
    assert c.threshold_min == 0.1        # clamped low
    assert c.after_hours is True         # unparseable → default


def test_data_dir_falls_back_to_cache():
    c = Config.from_env(full_env(PRESENCE_DATA_DIR=""))
    expected_tail = os.path.join(".cache", "streamhub", "presence", "live")
    assert c.data_dir.endswith(expected_tail)
    assert c.db_path() == os.path.join(c.data_dir, "presence.db")


def test_events_url_derived_from_ingest_url():
    c = Config.from_env(full_env())
    assert c.events_url() == (
        "http://127.0.0.1:3020/api/v1/apps/live/plugins/presence/events"
    )
    assert Config.from_env(full_env(STREAMHUB_INGEST_URL="")).events_url() == ""
    weird = Config.from_env(full_env(STREAMHUB_INGEST_URL="http://x/notlive"))
    assert weird.events_url() == ""


def test_stream_source_prefers_local_playlist():
    c = Config.from_env(full_env())
    local = os.path.join("/data/apps/live/hls", "office", "index.m3u8")
    assert c.local_playlist() == local
    assert c.stream_source(exists=lambda p: p == local) == local
    # local missing → public URL (the remote/GRID path)
    assert (
        c.stream_source(exists=lambda _p: False)
        == "https://stream.example.com/hls/live/office/index.m3u8"
    )


def test_validate_reports_all_problems():
    ok = Config.from_env(full_env())
    assert ok.validate() == []
    bad = Config.from_env(
        full_env(PRESENCE_APP="", PRESENCE_ROOM="", PRESENCE_ZONES="[]")
    )
    problems = " ".join(bad.validate())
    assert "PRESENCE_APP" in problems
    assert "PRESENCE_ROOM" in problems
    assert "PRESENCE_ZONES" in problems
