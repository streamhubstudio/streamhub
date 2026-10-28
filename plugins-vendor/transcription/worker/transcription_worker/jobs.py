"""
File-based job exchange with the core (modules/transcription).

The core drops `vod-<id>.json` into the jobs dir; the worker CLAIMS a job by
renaming it to `<name>.working` (atomic on POSIX — two workers can never both
own it), transcribes, writes the result ATOMICALLY into the results dir
(`.tmp` + rename, so the core never reads a half-written JSON) and finally
removes the working file. A malformed job is renamed to `<name>.bad` so it is
never retried in a loop.

Job JSON:    { vodId, app, language, model, tracks: [{ path, speaker }] }
Result JSON: { ok, vodId, language?, tracks?: [{ speaker, segments }], error? }

Everything here is pure file/dict logic — unit-tested without whisper.
"""
from __future__ import annotations

import json
import os
from typing import Any


def scan_jobs(jobs_dir: str) -> list[str]:
    """Absolute paths of pending job files (`*.json`), oldest name first."""
    try:
        entries = os.listdir(jobs_dir)
    except OSError:
        return []
    return [
        os.path.join(jobs_dir, name)
        for name in sorted(entries)
        if name.endswith(".json")
    ]


def parse_job(text: str) -> dict[str, Any]:
    """Parse + validate one job document. Raises ValueError when unusable."""
    try:
        job = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc
    if not isinstance(job, dict):
        raise ValueError("job must be a JSON object")
    vod_id = job.get("vodId")
    if not isinstance(vod_id, int):
        raise ValueError("job.vodId must be an integer")
    tracks = job.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ValueError("job.tracks must be a non-empty list")
    for i, track in enumerate(tracks):
        if not isinstance(track, dict) or not isinstance(track.get("path"), str) \
                or not track["path"]:
            raise ValueError(f"job.tracks[{i}].path must be a non-empty string")
    return job


def claim_job(path: str) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """Atomically claim + parse a job file.

    Returns (job, working_path, error):
      - (job, working, None)  — claimed and valid.
      - (None, None, None)    — someone else claimed it first / it vanished.
      - (None, None, error)   — claimed but malformed; parked as `<name>.bad`.
    """
    working = path + ".working"
    try:
        os.rename(path, working)
    except OSError:
        return None, None, None  # lost the race / already gone
    try:
        with open(working, "r", encoding="utf-8") as fh:
            job = parse_job(fh.read())
        return job, working, None
    except (OSError, ValueError) as exc:
        bad = path + ".bad"
        try:
            os.replace(working, bad)
        except OSError:
            pass
        return None, None, str(exc)


def write_result(results_dir: str, vod_id: int, result: dict[str, Any]) -> str:
    """Atomically write the result JSON for a vod. Returns the final path."""
    os.makedirs(results_dir, exist_ok=True)
    final = os.path.join(results_dir, f"vod-{vod_id}.json")
    tmp = final + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    os.replace(tmp, final)
    return final


def finish_job(working_path: str | None) -> None:
    """Best-effort removal of a claimed job file once its result is written."""
    if not working_path:
        return
    try:
        os.remove(working_path)
    except OSError:
        pass
