from deface_worker.config import DEFAULT_MODEL_URL, Config


def test_defaults_from_empty_env():
    cfg = Config.from_env({})
    assert cfg.app == ""
    assert cfg.room == ""
    assert cfg.thresh == 0.2
    assert cfg.mask_scale == 1.3
    assert cfg.scale is None
    assert cfg.backend == "auto"
    assert cfg.execution_provider == "cpu"
    assert cfg.fps == 2.0
    assert cfg.callback_url == ""
    assert cfg.model_url == DEFAULT_MODEL_URL
    assert cfg.model_dir  # always has a usable cache default
    assert cfg.model_path().endswith("centerface.onnx")


def test_env_parsing_and_clamping():
    cfg = Config.from_env(
        {
            "DEFACE_APP": " live ",
            "DEFACE_ROOM": "main",
            "DEFACE_THRESH": "1.7",          # > 1 → clamp
            "DEFACE_MASK_SCALE": "0.2",      # < 1 → clamp
            "DEFACE_FPS": "99",              # > 30 → clamp
            "DEFACE_SCALE": "640x360",
            "DEFACE_BACKEND": "ONNXRT",
            "DEFACE_EXECUTION_PROVIDER": "CUDA",
            "DEFACE_MODEL_DIR": "/data/models/deface",
        }
    )
    assert cfg.app == "live"
    assert cfg.thresh == 1.0
    assert cfg.mask_scale == 1.0
    assert cfg.fps == 30.0
    assert cfg.scale == (640, 360)
    assert cfg.backend == "onnxrt"
    assert cfg.execution_provider == "cuda"
    assert cfg.model_dir == "/data/models/deface"
    assert cfg.model_path() == "/data/models/deface/centerface.onnx"


def test_bogus_values_fall_back_safely():
    cfg = Config.from_env(
        {
            "DEFACE_THRESH": "not-a-number",
            "DEFACE_MASK_SCALE": "",
            "DEFACE_FPS": "0",               # < 0.1 → clamp up
            "DEFACE_SCALE": "wide",          # malformed → native
            "DEFACE_BACKEND": "tensorrt",    # unknown → auto
            "DEFACE_EXECUTION_PROVIDER": "tpu",  # unknown → cpu
        }
    )
    assert cfg.thresh == 0.2
    assert cfg.mask_scale == 1.3
    assert cfg.fps == 0.1
    assert cfg.scale is None
    assert cfg.backend == "auto"
    assert cfg.execution_provider == "cpu"


def test_callback_prefers_explicit_override_then_framework_ingest():
    framework = {
        "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/api/v1/apps/live/plugins/deface/live",
        "STREAMHUB_INGEST_TOKEN": "tok-123",
    }
    cfg = Config.from_env(framework)
    assert cfg.callback_url == framework["STREAMHUB_INGEST_URL"]
    assert cfg.ingest_token == "tok-123"

    cfg2 = Config.from_env({**framework, "DEFACE_CALLBACK_URL": "https://hooks/x"})
    assert cfg2.callback_url == "https://hooks/x"


def test_playlists_and_stream_source_resolution():
    cfg = Config.from_env(
        {
            "DEFACE_APP": "live",
            "DEFACE_ROOM": "main",
            "DEFACE_HLS_DIR": "/data/apps/live/hls",
            "DEFACE_PUBLIC_BASE": "https://streamhub.example.com/",
        }
    )
    import os

    assert cfg.local_playlist() == os.path.join(
        "/data/apps/live/hls", "main", "index.m3u8"
    )
    assert cfg.public_playlist() == "https://streamhub.example.com/hls/live/main/index.m3u8"
    # Local file present → local wins; absent → public URL.
    assert cfg.stream_source(exists=lambda p: True) == cfg.local_playlist()
    assert cfg.stream_source(exists=lambda p: False) == cfg.public_playlist()


def test_validate_lists_problems():
    assert Config.from_env({}).validate() == [
        "DEFACE_APP is required",
        "DEFACE_ROOM is required",
        "no callback target (set DEFACE_CALLBACK_URL, or run via the "
        "plugin worker-hook which injects STREAMHUB_INGEST_URL)",
    ]
    ok = Config.from_env(
        {
            "DEFACE_APP": "live",
            "DEFACE_ROOM": "main",
            "STREAMHUB_INGEST_URL": "http://127.0.0.1:3020/x",
        }
    )
    assert ok.validate() == []
