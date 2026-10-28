import os

from lpr_worker.config import (
    Config,
    DEFAULT_DETECTOR,
    DEFAULT_OCR_MODEL,
    merge_json_config,
)


def full_env(**overrides):
    env = {
        "LPR_APP": "parking",
        "LPR_ROOM": "gate",
        "LPR_DETECTOR": "yolo-v9-t-512-license-plate-end2end",
        "LPR_OCR_MODEL": "cct-s-v1-global-model",
        "LPR_DEVICE": "cuda",
        "LPR_CONFIDENCE": "0.65",
        "LPR_FPS": "4",
        "LPR_DEDUPE_SEC": "30",
        "LPR_WHITELIST": "ab123cd, AA 000 AA",
        "LPR_BLACKLIST": "xx-999-xx",
        "LPR_CALLBACK_URL": "https://hooks.test/gate",
        "LPR_SNAPSHOTS": "false",
        "LPR_DATA_DIR": "/data/apps/parking/lpr",
        "LPR_MODEL_DIR": "/data/models/lpr",
        "LPR_HLS_DIR": "/data/apps/parking/hls",
        "LPR_PUBLIC_BASE": "https://stream.example.com",
        "LPR_LIVEKIT_URL": "ws://127.0.0.1:7880",
        "STREAMHUB_EVENTS_URL": "http://127.0.0.1:3020/api/v1/apps/parking/plugins/lpr/events",
        "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/api/v1/apps/parking/plugins/lpr/live",
        "STREAMHUB_INGEST_TOKEN": "tok-1",
    }
    env.update(overrides)
    return env


def test_from_env_full_mapping():
    c = Config.from_env(full_env())
    assert c.app == "parking"
    assert c.room == "gate"
    assert c.detector == "yolo-v9-t-512-license-plate-end2end"
    assert c.ocr_model == "cct-s-v1-global-model"
    assert c.device == "cuda"
    assert c.confidence == 0.65
    assert c.fps == 4.0
    assert c.dedupe_sec == 30.0
    assert c.whitelist == ["AB123CD", "AA000AA"]  # normalized
    assert c.blacklist == ["XX999XX"]
    assert c.callback_url == "https://hooks.test/gate"
    assert c.snapshots is False
    assert c.events_url.endswith("/plugins/lpr/events")
    assert c.ingest_url.endswith("/plugins/lpr/live")
    assert c.ingest_token == "tok-1"
    assert c.db_path() == os.path.join("/data/apps/parking/lpr", "lpr.db")
    assert c.snapshots_dir() == os.path.join("/data/apps/parking/lpr", "snapshots")


def test_from_env_defaults_and_clamps():
    c = Config.from_env({"LPR_APP": "a", "LPR_ROOM": "r"})
    assert c.detector == DEFAULT_DETECTOR
    assert c.ocr_model == DEFAULT_OCR_MODEL
    assert c.device == "cpu"
    assert c.confidence == 0.5
    assert c.fps == 2.0
    assert c.dedupe_sec == 10.0
    assert c.snapshots is True
    assert c.whitelist == [] and c.blacklist == []
    # data dir falls back to a user cache; model dir nests under it
    assert c.data_dir.endswith(os.path.join(".cache", "streamhub", "lpr"))
    assert c.model_dir == os.path.join(c.data_dir, "models")

    clamped = Config.from_env(
        {
            "LPR_APP": "a",
            "LPR_ROOM": "r",
            "LPR_CONFIDENCE": "7",
            "LPR_FPS": "999",
            "LPR_DEDUPE_SEC": "-4",
            "LPR_DEVICE": "tpu",
            "LPR_DETECTOR": "not-a-model",
        }
    )
    assert clamped.confidence == 1.0
    assert clamped.fps == 30.0
    assert clamped.dedupe_sec == 0.0
    assert clamped.device == "cpu"
    assert clamped.detector == DEFAULT_DETECTOR


def test_explicit_lpr_urls_override_framework_env():
    c = Config.from_env(
        full_env(
            LPR_EVENTS_URL="https://origin.example/events",
            LPR_INGEST_URL="https://origin.example/live",
        )
    )
    assert c.events_url == "https://origin.example/events"
    assert c.ingest_url == "https://origin.example/live"


def test_stream_source_priority():
    c = Config.from_env(full_env())
    local = c.local_playlist()
    assert local == os.path.join("/data/apps/parking/hls", "gate", "index.m3u8")
    # local exists → local wins
    assert c.stream_source(exists=lambda p: p == local) == local
    # local missing → public URL
    assert (
        c.stream_source(exists=lambda p: False)
        == "https://stream.example.com/hls/parking/gate/index.m3u8"
    )
    # explicit LPR_SOURCE (edge: RTSP camera) wins over everything
    edge = Config.from_env(full_env(LPR_SOURCE="rtsp://10.0.0.5/stream1"))
    assert edge.stream_source(exists=lambda p: True) == "rtsp://10.0.0.5/stream1"


def test_validate_reports_problems():
    ok = Config.from_env(full_env())
    assert ok.validate() == []

    missing = Config.from_env({})
    problems = " | ".join(missing.validate())
    assert "LPR_APP" in problems
    assert "LPR_ROOM" in problems
    assert "no event target" in problems

    # An edge run with LPR_SOURCE + callback URL and no room is valid.
    edge = Config.from_env(
        {
            "LPR_APP": "edge",
            "LPR_SOURCE": "rtsp://cam/1",
            "LPR_CALLBACK_URL": "https://hooks.test/gate",
        }
    )
    assert edge.validate() == []


def test_merge_json_config_overrides_and_clamps():
    base = Config.from_env(full_env())
    merged = merge_json_config(
        base,
        """{
          "room": "north-gate",
          "detector": "yolo-v9-t-256-license-plate-end2end",
          "ocrModel": "cct-xs-v1-global-model",
          "confidence": 9,
          "fps": 0.01,
          "dedupeWindowSec": 999,
          "whitelist": ["ab 123 cd", "zz111zz"],
          "blacklist": "xx999xx; yy888yy",
          "callbackUrl": "https://edge.test/hook",
          "snapshots": true,
          "cuda": false,
          "source": "rtsp://cam/1",
          "unknownKey": 42
        }""",
    )
    assert merged.room == "north-gate"
    assert merged.detector == "yolo-v9-t-256-license-plate-end2end"
    assert merged.confidence == 1.0  # clamped
    assert merged.fps == 0.1  # clamped
    assert merged.dedupe_sec == 300.0  # clamped
    assert merged.whitelist == ["AB123CD", "ZZ111ZZ"]
    assert merged.blacklist == ["XX999XX", "YY888YY"]
    assert merged.callback_url == "https://edge.test/hook"
    assert merged.snapshots is True
    assert merged.device == "cpu"
    assert merged.source == "rtsp://cam/1"
    # base untouched (returns a NEW config)
    assert base.room == "gate"


def test_merge_json_config_empty_and_invalid():
    base = Config.from_env(full_env())
    assert merge_json_config(base, None) is base
    assert merge_json_config(base, "  ") is base
    for bad in ("{nope", "[1,2]", '"str"'):
        try:
            merge_json_config(base, bad)
            raised = False
        except ValueError:
            raised = True
        assert raised, f"expected ValueError for {bad!r}"
