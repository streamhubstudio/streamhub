"""
Runner — the job loop: scan the jobs dir, claim, transcribe every track,
write the result for the core, log structured JSON lines to stdout (the core
worker-hook mirrors them into the plugin logs UI).

The transcriber is injectable so the loop and the per-job processing are
tested without faster-whisper; `run(config)` builds the real one.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable

from .config import Config
from .jobs import claim_job, finish_job, scan_jobs, write_result
from .srt import build_srt, merge_tracks


def log(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line to stdout."""
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def process_job(
    job: dict[str, Any],
    transcribe: Callable[[str, str | None], tuple[list[dict], str | None]],
) -> dict[str, Any]:
    """Transcribe every track of a job → the result document for the core.

    Pure given an injected `transcribe`; any engine exception becomes an
    `ok: False` result (the core surfaces it on the transcript row) instead
    of crashing the worker loop.
    """
    try:
        language: str | None = None
        tracks_out: list[dict[str, Any]] = []
        for track in job["tracks"]:
            segments, detected = transcribe(track["path"], job.get("language"))
            tracks_out.append(
                {"speaker": track.get("speaker"), "segments": segments}
            )
            language = language or detected
        return {
            "ok": True,
            "vodId": job["vodId"],
            "language": language,
            "tracks": tracks_out,
        }
    except Exception as exc:  # noqa: BLE001 — report, never crash the loop
        return {"ok": False, "vodId": job.get("vodId"), "error": str(exc)}


def run_loop(
    config: Config,
    transcribe: Callable[[str, str | None], tuple[list[dict], str | None]],
    should_stop: Callable[[], bool],
    sleep: Callable[[float], None] = time.sleep,
    emit: Callable[..., None] = log,
) -> dict[str, int]:
    """Poll the jobs dir until stopped. Returns a small stats dict (tests)."""
    stats = {"jobs": 0, "ok": 0, "failed": 0, "malformed": 0}
    while not should_stop():
        pending = scan_jobs(config.jobs_dir)
        if not pending:
            sleep(config.poll_seconds)
            continue
        for path in pending:
            if should_stop():
                break
            job, working, error = claim_job(path)
            if error:
                stats["malformed"] += 1
                emit("job_malformed", path=path, error=error)
                continue
            if job is None:
                continue  # lost the claim race
            stats["jobs"] += 1
            emit("job", vod=job["vodId"], tracks=len(job["tracks"]))
            result = process_job(job, transcribe)
            write_result(config.results_dir, job["vodId"], result)
            finish_job(working)
            if result["ok"]:
                stats["ok"] += 1
                # Local debugging artifact mirroring what the core uploads.
                emit(
                    "job_done",
                    vod=job["vodId"],
                    language=result.get("language"),
                    segments=sum(len(t["segments"]) for t in result["tracks"]),
                    srt_preview=build_srt(merge_tracks(result["tracks"]))[:120],
                )
            else:
                stats["failed"] += 1
                emit("job_failed", vod=job["vodId"], error=result.get("error"))
    return stats


def run(config: Config, should_stop: Callable[[], bool], transcriber=None) -> int:
    """Validate config, build the real engine (unless injected) and loop."""
    problems = config.validate()
    if problems:
        for p in problems:
            log("config_error", message=p)
        return 2

    log(
        "start",
        app=config.app,
        engine="faster-whisper",
        model=config.model,
        language=config.language,
        device=config.device,
        jobs_dir=config.jobs_dir,
        results_dir=config.results_dir,
    )

    if transcriber is None:
        try:
            from .engine import build_transcriber

            transcriber = build_transcriber(config)
        except Exception as exc:  # noqa: BLE001 — import/model/download errors
            log("fatal", message=f"could not load faster-whisper model: {exc}")
            return 1
        log("model_ready", model=config.model)

    try:
        stats = run_loop(config, transcriber, should_stop)
    except KeyboardInterrupt:
        stats = {}
    except Exception as exc:  # noqa: BLE001 — report + non-zero exit
        log("fatal", message=str(exc))
        return 1
    log("stop", **stats)
    return 0
