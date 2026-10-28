"""Job claim/result file-exchange semantics (tmp dirs, no whisper)."""
import json
import os

import pytest

from transcription_worker.jobs import (
    claim_job,
    finish_job,
    parse_job,
    scan_jobs,
    write_result,
)


def _job(vod_id=7, tracks=None):
    return {
        "vodId": vod_id,
        "app": "live",
        "language": "auto",
        "model": "small",
        "tracks": tracks or [{"path": "/tmp/a0.mp3", "speaker": None}],
    }


class TestScan:
    def test_lists_only_json_sorted(self, tmp_path):
        (tmp_path / "vod-2.json").write_text("{}")
        (tmp_path / "vod-1.json").write_text("{}")
        (tmp_path / "vod-3.json.working").write_text("{}")
        (tmp_path / "vod-4.json.bad").write_text("{}")
        assert scan_jobs(str(tmp_path)) == [
            str(tmp_path / "vod-1.json"),
            str(tmp_path / "vod-2.json"),
        ]

    def test_missing_dir_is_empty(self, tmp_path):
        assert scan_jobs(str(tmp_path / "nope")) == []


class TestParse:
    def test_valid_job(self):
        job = parse_job(json.dumps(_job()))
        assert job["vodId"] == 7
        assert job["tracks"][0]["path"] == "/tmp/a0.mp3"

    @pytest.mark.parametrize(
        "raw",
        [
            "not json",
            json.dumps([1, 2]),
            json.dumps({"tracks": [{"path": "x"}]}),          # no vodId
            json.dumps({"vodId": "7", "tracks": [{"path": "x"}]}),  # str id
            json.dumps({"vodId": 7, "tracks": []}),            # empty tracks
            json.dumps({"vodId": 7, "tracks": [{"speaker": "a"}]}),  # no path
        ],
    )
    def test_rejects_malformed(self, raw):
        with pytest.raises(ValueError):
            parse_job(raw)


class TestClaim:
    def test_claim_renames_and_parses(self, tmp_path):
        path = tmp_path / "vod-7.json"
        path.write_text(json.dumps(_job()))
        job, working, error = claim_job(str(path))
        assert error is None
        assert job["vodId"] == 7
        assert working == str(path) + ".working"
        assert not path.exists()
        assert os.path.exists(working)
        finish_job(working)
        assert not os.path.exists(working)

    def test_lost_race_returns_nothing(self, tmp_path):
        job, working, error = claim_job(str(tmp_path / "gone.json"))
        assert (job, working, error) == (None, None, None)

    def test_malformed_job_is_parked_as_bad(self, tmp_path):
        path = tmp_path / "vod-8.json"
        path.write_text("{broken")
        job, working, error = claim_job(str(path))
        assert job is None and working is None
        assert "invalid JSON" in error
        assert (tmp_path / "vod-8.json.bad").exists()
        # Parked jobs are never rescanned.
        assert scan_jobs(str(tmp_path)) == []


class TestWriteResult:
    def test_atomic_write_and_content(self, tmp_path):
        results = tmp_path / "results"
        final = write_result(
            str(results), 7, {"ok": True, "vodId": 7, "tracks": []}
        )
        assert final == str(results / "vod-7.json")
        assert json.loads((results / "vod-7.json").read_text()) == {
            "ok": True,
            "vodId": 7,
            "tracks": [],
        }
        # No .tmp leftover.
        assert [p.name for p in results.iterdir()] == ["vod-7.json"]
