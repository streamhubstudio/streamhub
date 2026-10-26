"""Job loop + per-job processing with an injected fake transcriber."""
import json

from transcription_worker.config import Config
from transcription_worker.runner import process_job, run_loop


def fake_transcribe(path, language):
    return (
        [{"start": 0.0, "end": 1.0, "text": f"from {path}"}],
        language if language and language != "auto" else "en",
    )


def _job(vod_id=7, tracks=None, language="auto"):
    return {
        "vodId": vod_id,
        "app": "live",
        "language": language,
        "model": "small",
        "tracks": tracks
        or [{"path": "/tmp/a0.mp3", "speaker": None}],
    }


class TestProcessJob:
    def test_transcribes_every_track_and_keeps_speakers(self):
        job = _job(
            tracks=[
                {"path": "/tmp/a0.mp3", "speaker": "alice"},
                {"path": "/tmp/a1.mp3", "speaker": "bob"},
            ]
        )
        result = process_job(job, fake_transcribe)
        assert result["ok"] is True
        assert result["vodId"] == 7
        assert result["language"] == "en"
        assert [t["speaker"] for t in result["tracks"]] == ["alice", "bob"]
        assert result["tracks"][0]["segments"][0]["text"] == "from /tmp/a0.mp3"

    def test_forwards_the_requested_language(self):
        result = process_job(_job(language="es"), fake_transcribe)
        assert result["language"] == "es"

    def test_engine_exception_becomes_ok_false(self):
        def boom(_path, _lang):
            raise RuntimeError("model download failed")

        result = process_job(_job(), boom)
        assert result == {
            "ok": False,
            "vodId": 7,
            "error": "model download failed",
        }


class TestRunLoop:
    def _config(self, tmp_path):
        jobs = tmp_path / "jobs"
        results = tmp_path / "results"
        jobs.mkdir()
        return Config(
            app="live",
            jobs_dir=str(jobs),
            results_dir=str(results),
            poll_seconds=0.5,
        )

    def test_processes_a_job_end_to_end(self, tmp_path):
        config = self._config(tmp_path)
        job_file = tmp_path / "jobs" / "vod-7.json"
        job_file.write_text(json.dumps(_job()))

        calls = {"n": 0}

        def stop_after_first_pass():
            calls["n"] += 1
            return calls["n"] > 2  # scan once, then stop

        stats = run_loop(
            config, fake_transcribe, stop_after_first_pass, sleep=lambda _s: None
        )
        assert stats["jobs"] == 1 and stats["ok"] == 1

        result_file = tmp_path / "results" / "vod-7.json"
        result = json.loads(result_file.read_text())
        assert result["ok"] is True
        assert result["tracks"][0]["segments"][0]["text"] == "from /tmp/a0.mp3"
        # The claimed job file was consumed.
        assert list((tmp_path / "jobs").iterdir()) == []

    def test_malformed_job_is_counted_and_parked(self, tmp_path):
        config = self._config(tmp_path)
        (tmp_path / "jobs" / "vod-9.json").write_text("{broken")

        calls = {"n": 0}

        def stop_after_first_pass():
            calls["n"] += 1
            return calls["n"] > 2

        stats = run_loop(
            config, fake_transcribe, stop_after_first_pass, sleep=lambda _s: None
        )
        assert stats["malformed"] == 1 and stats["jobs"] == 0
        assert (tmp_path / "jobs" / "vod-9.json.bad").exists()
        assert not (tmp_path / "results").exists()

    def test_idle_loop_sleeps_and_stops(self, tmp_path):
        config = self._config(tmp_path)
        sleeps = []
        calls = {"n": 0}

        def stop_after_two():
            calls["n"] += 1
            return calls["n"] > 2

        stats = run_loop(
            config, fake_transcribe, stop_after_two, sleep=sleeps.append
        )
        assert stats["jobs"] == 0
        assert sleeps == [0.5, 0.5]

    def test_failed_engine_writes_ok_false_result(self, tmp_path):
        config = self._config(tmp_path)
        (tmp_path / "jobs" / "vod-3.json").write_text(json.dumps(_job(vod_id=3)))

        def boom(_path, _lang):
            raise RuntimeError("no cuda")

        calls = {"n": 0}

        def stop_after_first_pass():
            calls["n"] += 1
            return calls["n"] > 2

        stats = run_loop(config, boom, stop_after_first_pass, sleep=lambda _s: None)
        assert stats["failed"] == 1
        result = json.loads((tmp_path / "results" / "vod-3.json").read_text())
        assert result == {"ok": False, "vodId": 3, "error": "no cuda"}
