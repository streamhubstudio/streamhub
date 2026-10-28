"""Env → Config parsing, clamping, derived paths + validation."""
from safety_ppe_worker.config import DEFAULT_MODEL_URL, Config
from safety_ppe_worker.zones import Zone, full_frame_zone


def test_defaults_from_minimal_env():
    c = Config.from_env({"SAFETY_PPE_APP": "live", "SAFETY_PPE_ROOM": "main"})
    assert c.app == "live" and c.room == "main"
    assert c.confidence == 0.35
    assert c.fps == 1.0
    assert c.require_helmet is True and c.require_vest is True
    assert c.require() == ["helmet", "vest"]
    assert c.zones == [full_frame_zone()]
    assert c.work_hours is None and c.work_days is None
    assert c.sustain_frames == 3
    assert c.cooldown_seconds == 120.0
    assert c.assoc_threshold == 0.5
    assert c.execution_provider == "cpu"
    assert c.class_names is None
    assert c.model_url == DEFAULT_MODEL_URL
    assert c.model_path().endswith("safety-ppe.onnx")
    assert c.validate() == []


def test_full_env_mapping():
    c = Config.from_env(
        {
            "SAFETY_PPE_APP": "site",
            "SAFETY_PPE_ROOM": "cam1",
            "SAFETY_PPE_CONFIDENCE": "0.6",
            "SAFETY_PPE_FPS": "2",
            "SAFETY_PPE_REQUIRE_HELMET": "false",
            "SAFETY_PPE_REQUIRE_VEST": "true",
            "SAFETY_PPE_ZONES": '[{"name":"dock","rect":[0,0,0.5,1]}]',
            "SAFETY_PPE_WORK_HOURS": "08:00-18:00",
            "SAFETY_PPE_WORK_DAYS": "mon-fri",
            "SAFETY_PPE_SUSTAIN_FRAMES": "5",
            "SAFETY_PPE_COOLDOWN_SECONDS": "60",
            "SAFETY_PPE_ASSOC_THRESHOLD": "0.7",
            "SAFETY_PPE_EXECUTION_PROVIDER": "cuda",
            "SAFETY_PPE_CLASS_NAMES": "Person,Hardhat",
            "SAFETY_PPE_MODEL_DIR": "/models/ppe",
            "SAFETY_PPE_MODEL_URL": "https://example.com/m.onnx",
            "SAFETY_PPE_DB": "/data/safety-ppe.db",
            "SAFETY_PPE_EVIDENCE_DIR": "/data/evidence",
            "SAFETY_PPE_CALLBACK_URL": "https://hooks.test/ppe",
            "SAFETY_PPE_CALLBACK_SECRET": "s3cret",
            "SAFETY_PPE_HLS_DIR": "/data/apps/site/hls",
            "SAFETY_PPE_PUBLIC_BASE": "https://stream.example.com/",
        }
    )
    assert c.require() == ["vest"]
    assert c.zones == [Zone("dock", (0.0, 0.0, 0.5, 1.0))]
    assert c.work_hours == (480, 1080)
    assert c.work_days == {0, 1, 2, 3, 4}
    assert c.sustain_frames == 5 and c.cooldown_seconds == 60.0
    assert c.assoc_threshold == 0.7
    assert c.execution_provider == "cuda"
    assert c.class_names == ["Person", "Hardhat"]
    assert c.model_path() == "/models/ppe/safety-ppe.onnx"
    assert c.db_path == "/data/safety-ppe.db"
    assert c.callback_secret == "s3cret"


def test_bad_values_clamp_or_fall_back():
    c = Config.from_env(
        {
            "SAFETY_PPE_APP": "a",
            "SAFETY_PPE_ROOM": "r",
            "SAFETY_PPE_CONFIDENCE": "7",
            "SAFETY_PPE_FPS": "0",
            "SAFETY_PPE_SUSTAIN_FRAMES": "-2",
            "SAFETY_PPE_COOLDOWN_SECONDS": "nope",
            "SAFETY_PPE_ASSOC_THRESHOLD": "0",
            "SAFETY_PPE_EXECUTION_PROVIDER": "tpu",
            "SAFETY_PPE_ZONES": "not-json",
            "SAFETY_PPE_WORK_HOURS": "9am-5pm",
            "SAFETY_PPE_WORK_DAYS": "someday",
        }
    )
    assert c.confidence == 1.0
    assert c.fps == 0.1
    assert c.sustain_frames == 0
    assert c.cooldown_seconds == 120.0
    assert c.assoc_threshold == 0.05
    assert c.execution_provider == "cpu"
    assert c.zones == [full_frame_zone()]
    assert c.work_hours is None and c.work_days is None  # fail open


def test_stream_source_prefers_existing_local_playlist():
    c = Config.from_env(
        {
            "SAFETY_PPE_APP": "live",
            "SAFETY_PPE_ROOM": "main",
            "SAFETY_PPE_HLS_DIR": "/data/apps/live/hls",
            "SAFETY_PPE_PUBLIC_BASE": "https://s.example.com",
        }
    )
    local = "/data/apps/live/hls/main/index.m3u8"
    assert c.stream_source(exists=lambda p: p == local) == local
    assert (
        c.stream_source(exists=lambda p: False)
        == "https://s.example.com/hls/live/main/index.m3u8"
    )


def test_validate_reports_problems():
    c = Config.from_env({})
    problems = c.validate()
    assert any("SAFETY_PPE_APP" in p for p in problems)
    assert any("SAFETY_PPE_ROOM" in p for p in problems)

    c2 = Config.from_env(
        {
            "SAFETY_PPE_APP": "a",
            "SAFETY_PPE_ROOM": "r",
            "SAFETY_PPE_REQUIRE_HELMET": "false",
            "SAFETY_PPE_REQUIRE_VEST": "off",
        }
    )
    assert any("nothing to enforce" in p for p in c2.validate())
