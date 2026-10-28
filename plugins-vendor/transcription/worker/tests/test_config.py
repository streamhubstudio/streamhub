"""Config.from_env parsing/clamping + validation (pure, no heavy deps)."""
from transcription_worker.config import Config


def test_defaults_from_empty_env():
    cfg = Config.from_env({})
    assert cfg.app == ""
    assert cfg.model == "small"
    assert cfg.language == "auto"
    assert cfg.device == "auto"
    assert cfg.compute_type == "auto"
    assert cfg.poll_seconds == 2.0


def test_reads_the_transcribe_env():
    cfg = Config.from_env(
        {
            "TRANSCRIBE_APP": "live",
            "TRANSCRIBE_JOBS_DIR": "/data/apps/live/transcripts/jobs",
            "TRANSCRIBE_RESULTS_DIR": "/data/apps/live/transcripts/results",
            "TRANSCRIBE_MODEL": "large-v3",
            "TRANSCRIBE_LANGUAGE": "es",
            "TRANSCRIBE_DEVICE": "CUDA",
            "TRANSCRIBE_MODEL_DIR": "/data/models/transcription",
            "TRANSCRIBE_POLL_S": "0.5",
        }
    )
    assert cfg.app == "live"
    assert cfg.jobs_dir.endswith("/jobs")
    assert cfg.results_dir.endswith("/results")
    assert cfg.model == "large-v3"
    assert cfg.language == "es"
    assert cfg.device == "cuda"
    assert cfg.model_dir == "/data/models/transcription"
    assert cfg.poll_seconds == 0.5


def test_unknown_model_and_device_fall_back():
    cfg = Config.from_env(
        {"TRANSCRIBE_MODEL": "gpt-5", "TRANSCRIBE_DEVICE": "tpu"}
    )
    assert cfg.model == "small"
    assert cfg.device == "auto"


def test_poll_seconds_is_clamped_and_tolerant():
    assert Config.from_env({"TRANSCRIBE_POLL_S": "0.01"}).poll_seconds == 0.5
    assert Config.from_env({"TRANSCRIBE_POLL_S": "999"}).poll_seconds == 30.0
    assert Config.from_env({"TRANSCRIBE_POLL_S": "nope"}).poll_seconds == 2.0


def test_validate_lists_missing_required():
    problems = Config.from_env({}).validate()
    assert "TRANSCRIBE_APP is required" in problems
    assert "TRANSCRIBE_JOBS_DIR is required" in problems
    assert "TRANSCRIBE_RESULTS_DIR is required" in problems
    ok = Config.from_env(
        {
            "TRANSCRIBE_APP": "live",
            "TRANSCRIBE_JOBS_DIR": "/j",
            "TRANSCRIBE_RESULTS_DIR": "/r",
        }
    )
    assert ok.validate() == []
