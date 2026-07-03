from yolo_worker.config import Config


def test_from_env_parses_and_clamps():
    cfg = Config.from_env(
        {
            "YOLO_APP": "live",
            "YOLO_ROOM": "main",
            "YOLO_MODEL": "yolov8m",
            "YOLO_DEVICE": "cuda",
            "YOLO_CONFIDENCE": "0.9",
            "YOLO_FPS": "5",
            "YOLO_CLASSES": "person, car , person",
            "YOLO_CALLBACK_URL": "https://hooks.test/y",
        }
    )
    assert cfg.app == "live"
    assert cfg.room == "main"
    assert cfg.model == "yolov8m"
    assert cfg.device == "cuda"
    assert cfg.confidence == 0.9
    assert cfg.fps == 5.0
    assert cfg.classes == ["person", "car"]  # de-duped, unknowns dropped
    assert cfg.callback_url == "https://hooks.test/y"


def test_from_env_defaults_and_sanitizes():
    cfg = Config.from_env({})
    assert cfg.model == "yolov8n"
    assert cfg.device == "cpu"
    assert cfg.confidence == 0.35
    assert cfg.fps == 2.0
    assert cfg.classes == []


def test_from_env_rejects_bad_model_and_device():
    cfg = Config.from_env({"YOLO_MODEL": "gpt", "YOLO_DEVICE": "tpu"})
    assert cfg.model == "yolov8n"
    assert cfg.device == "cpu"


def test_confidence_and_fps_clamped_to_bounds():
    cfg = Config.from_env({"YOLO_CONFIDENCE": "5", "YOLO_FPS": "999"})
    assert cfg.confidence == 1.0
    assert cfg.fps == 30.0
    cfg2 = Config.from_env({"YOLO_CONFIDENCE": "-1", "YOLO_FPS": "0"})
    assert cfg2.confidence == 0.0
    assert cfg2.fps == 0.1


def test_stream_source_prefers_existing_local_then_public():
    cfg = Config.from_env(
        {
            "YOLO_APP": "live",
            "YOLO_ROOM": "main",
            "YOLO_HLS_DIR": "/data/apps/live/hls",
            "YOLO_PUBLIC_BASE": "https://cdn.test/",
        }
    )
    local = "/data/apps/live/hls/main/index.m3u8"
    # local present → local wins
    assert cfg.stream_source(exists=lambda p: p == local) == local
    # local absent → public URL
    assert (
        cfg.stream_source(exists=lambda p: False)
        == "https://cdn.test/hls/live/main/index.m3u8"
    )


def test_validate_reports_missing_required():
    cfg = Config.from_env({})
    problems = cfg.validate()
    assert any("YOLO_APP" in p for p in problems)
    assert any("YOLO_ROOM" in p for p in problems)
    assert any("YOLO_CALLBACK_URL" in p for p in problems)
