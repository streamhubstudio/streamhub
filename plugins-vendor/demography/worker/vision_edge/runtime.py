"""
Runtime wiring — the IMPURE glue (HLS decode + YOLO/InsightFace + network).

Each ``run_*`` builds the reader/detector, drives the corresponding pure engine
and delivers events through the batched channel. Structured JSON log lines go
to stdout (the core worker-hook mirrors them into the plugin Logs UI). None of
this is exercised by the pure tests — it needs torch/cv2/insightface — so the
whole module is marked ``pragma: no cover``; the correctness lives in the pure
cores it wires together.
"""
from __future__ import annotations

import base64
import json
import sys
import time
from typing import Any

from .events import EventBatcher, build_event
from .sampler import FpsThrottle


def log(event: str, **fields: Any) -> None:  # pragma: no cover
    rec = {"ts": round(time.time(), 3), "event": event, **fields}
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _batcher(config) -> EventBatcher:  # pragma: no cover
    return EventBatcher(config.events_url, token=config.ingest_token)


def _emit(batcher: EventBatcher, base: dict[str, Any], event: str, data: dict[str, Any]) -> None:  # pragma: no cover
    batcher.add(build_event(base, event, data, time.time()))


# ---------------------------------------------------------------------------
# Realtime models (occupancy, counting) — persistent tracking over frames
# ---------------------------------------------------------------------------

def run_occupancy(config) -> int:  # pragma: no cover
    from .detector import PERSON_ID, VEHICLE_IDS, Detector
    from .hls import HlsFrameReader
    from .models.occupancy import OccupancyConfig, OccupancyEngine

    occ = OccupancyConfig.from_dict(config.config)
    if not occ.zones:
        log("config_error", message="occupancy: no valid polygon zones configured")
        return 2
    wants_vehicles = any(z.detect == "vehiculos" for z in occ.zones)
    classes = (PERSON_ID, *VEHICLE_IDS) if wants_vehicles else (PERSON_ID,)
    engine = OccupancyEngine(occ)
    batcher = _batcher(config)
    base = config.base_payload()

    reader = HlsFrameReader(config.hls_url, emit=_adaptive_emit(config.config), log=log)
    detector = Detector(_model_for(config), config.device, 0.20, classes)
    log("start", model="occupancy", room=config.room, zones=len(occ.zones))
    try:
        for frame in reader.frames():
            dets = detector.track(frame)
            for ev in engine.process(dets, time.time()):
                _emit(batcher, base, f"occupancy.{ev.kind}", ev.data)
            batcher.flush()
    except KeyboardInterrupt:
        pass
    log("stop", model="occupancy")
    return 0


def run_realtime_counting(config) -> int:  # pragma: no cover
    from .detector import PERSON_ID, Detector
    from .hls import HlsFrameReader
    from .models.counting import CountingConfig, MultiLineCounter
    from .zones import poi_for_anchor

    cc = CountingConfig.from_dict(config.config)
    if not cc.lines:
        log("config_error", message="counting: no valid lines configured")
        return 2
    counter = MultiLineCounter(cc)
    batcher = _batcher(config)
    base = config.base_payload()

    throttle = FpsThrottle(cc.fps)  # FIXED cadence (contract: 3.5 FPS)
    reader = HlsFrameReader(config.hls_url, emit=lambda _i, now: throttle.should_emit(now), log=log)
    detector = Detector(_model_for(config), config.device, 0.25, (PERSON_ID,))
    log("start", model="counting", room=config.room, lines=len(cc.lines), fps=cc.fps, pois=len(cc.pois))
    try:
        for frame in reader.frames():
            dets = detector.track(frame)
            active = [d["trackId"] for d in dets]
            for d in dets:
                x1, y1, x2, y2 = d["bbox"]
                foot = ((x1 + x2) / 2.0, y2)
                poi_name = None
                if cc.pois:
                    p = poi_for_anchor(cc.pois, d["bbox"])
                    if p is None:
                        continue  # foot outside every POI → not counted
                    poi_name = p.name
                for cr in counter.feed(d["trackId"], foot, d.get("conf"), poi=poi_name):
                    _emit(batcher, base, f"count.{cr['direction']}", cr)
            counter.cleanup(active)
            tin, tout = counter.totals()
            _emit(batcher, base, "count.occupancy", {"inside": counter.occupancy, "capacity": cc.capacity or None})
            batcher.flush()
    except KeyboardInterrupt:
        pass
    log("stop", model="counting")
    return 0


# ---------------------------------------------------------------------------
# Snapshot models (crowd, demography) — one frame per interval
# ---------------------------------------------------------------------------

def run_crowd(config) -> int:  # pragma: no cover
    from .detector import PERSON_ID, Detector
    from .hls import HlsFrameReader
    from .models.crowd import CrowdConfig, CrowdEngine

    cc = CrowdConfig.from_dict(config.config)
    if not cc.zones:
        log("config_error", message="crowd: no valid polygon zones configured")
        return 2
    engine = CrowdEngine(cc)
    batcher = _batcher(config)
    base = config.base_payload()
    reader = HlsFrameReader(config.hls_url, log=log)
    detector = Detector(_model_for(config), config.device, 0.25, (PERSON_ID,))
    log("start", model="crowd", room=config.room, zones=len(cc.zones), intervalSec=cc.interval_sec)
    try:
        while True:
            frame = reader.read_one()
            if frame is not None:
                frame = _apply_clahe(frame)
                dets = detector.track(frame)
                counts, thresholds = engine.process(dets, time.time())
                for c in counts:
                    _emit(batcher, base, "crowd.count", c)
                for t in thresholds:
                    _emit(batcher, base, "crowd.threshold", t)
                batcher.flush()
            time.sleep(cc.interval_sec)
    except KeyboardInterrupt:
        pass
    log("stop", model="crowd")
    return 0


def run_demography(config) -> int:  # pragma: no cover
    from .hls import HlsFrameReader
    from .models import demography as dm
    from .models.demography import DemographyConfig
    from .zones import poi_for_anchor

    # The engine (local vs openai/deepseek) rides as VISION_ENGINE env
    # (config.engine), NOT in the per-stream config_json; fold it in unless the
    # resolved settings override it explicitly.
    settings = dict(config.config)
    settings.setdefault("engine", getattr(config, "engine", "local"))
    dc = DemographyConfig.from_dict(settings)
    batcher = _batcher(config)
    base = config.base_payload()
    reader = HlsFrameReader(config.hls_url, log=log)
    log("start", model="demography", room=config.room, engine=dc.engine, intervalSec=dc.interval_sec, pois=len(dc.pois))
    analyze = _build_demography_analyzer(config, dc)
    try:
        while True:
            frame = reader.read_one()
            if frame is not None:
                for rec in analyze(frame):
                    ev = _demography_event(dm, dc, rec, poi_for_anchor)
                    if ev is not None:
                        _emit(batcher, base, "demography.face", ev)
                batcher.flush()
            time.sleep(dc.interval_sec)
    except KeyboardInterrupt:
        pass
    log("stop", model="demography")
    return 0


def _demography_event(dm, dc, rec, poi_for_anchor):  # pragma: no cover
    """Turn a raw face record into a ``demography.face`` payload, gated + tagged
    by POI. A local-engine face carries a normalized ``bbox`` → resolve which POI
    it fell in (drop it when outside every POI). An AI-engine record has no bbox
    (whole-frame aggregate) → POIs are not applied per-face."""
    bbox = rec.get("bbox")
    poi_name = None
    if dc.pois and bbox is not None:
        p = poi_for_anchor(dc.pois, bbox, mode="center")
        if p is None:
            return None
        poi_name = p.name
    return dm.build_face_event(rec, dc.engine, poi=poi_name)


def _build_demography_analyzer(config, dc):  # pragma: no cover
    from .models import demography as dm

    if dc.engine == "local":
        backend = None

        def analyze_local(frame):
            nonlocal backend
            if backend is None:
                from .insightface_backend import InsightFaceBackend

                backend = InsightFaceBackend(device=config.device)
            # RAW records (with a normalized ``bbox`` per face) — the caller
            # resolves POI + builds the event.
            return backend.analyze(frame, dc)

        return analyze_local

    # AI-API engine (openai / deepseek).
    import os

    guard = dm.BudgetGuard(config.snapshot_path(f"demography-budget-{config.app}.json"), dc.ai_budget_monthly)
    api_key = os.environ.get("VISION_AI_API_KEY", "")
    base_url = os.environ.get("VISION_AI_BASE_URL", "")

    def analyze_ai(frame):
        if not guard.can_spend(dc.ai_cost_per_image):
            log("budget_exceeded", engine=dc.engine, spent=guard.spent(), budget=dc.ai_budget_monthly)
            return []
        image_b64 = _encode_jpeg_b64(frame)
        messages = dm.build_vision_messages(dc.ai_prompt, image_b64)
        content = _call_vision_api(dc.engine, dc.ai_model, api_key, base_url, messages)
        guard.record(dc.ai_cost_per_image)
        rec = dm.parse_ai_response(content or "")
        return [rec] if rec else []  # RAW record, no bbox (whole-frame aggregate)

    return analyze_ai


def _call_vision_api(engine, model, api_key, base_url, messages) -> str | None:  # pragma: no cover
    import urllib.request

    url = base_url or ("https://api.openai.com/v1/chat/completions" if engine == "openai" else "https://api.deepseek.com/chat/completions")
    model = model or ("gpt-4o-mini" if engine == "openai" else "deepseek-chat")
    body = json.dumps({"model": model, "messages": messages, "max_tokens": 200}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        return data["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        log("ai_error", engine=engine, error=str(exc))
        return None


def _encode_jpeg_b64(frame) -> str:  # pragma: no cover
    import cv2

    ok, buf = cv2.imencode(".jpg", frame)
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def _apply_clahe(frame):  # pragma: no cover
    import cv2

    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    lab = cv2.merge((clahe.apply(l), a, b))
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def _adaptive_emit(config_dict):  # pragma: no cover
    """Occupancy tolerates adaptive sampling; skip decoded frames per the
    Vision One AdaptiveFrameSampler (occupancy dwell logic works on seconds)."""
    from .sampler import AdaptiveFrameSampler

    sampler = AdaptiveFrameSampler()
    state = {"skip_left": 0}

    def emit(_idx, _now):
        if state["skip_left"] > 0:
            state["skip_left"] -= 1
            return False
        state["skip_left"] = sampler.frames_to_skip()
        return True

    return emit


def _model_for(config) -> str:  # pragma: no cover
    name = "yolo11n.pt" if config.device == "cpu" else "yolo11s.pt"
    model_dir = getattr(config, "model_dir", "")
    if model_dir:
        import os

        return os.path.join(model_dir, name)
    return name


# ---------------------------------------------------------------------------
# Shared capture — ONE decode loop, N model consumers (owner item 33)
# ---------------------------------------------------------------------------

def run_multiplex(mux) -> int:  # pragma: no cover - runtime wiring (needs cv2/torch)
    """Run N model consumers off ONE shared decode loop for one source.

    Instead of N worker processes each opening their own ``HlsFrameReader`` (N×
    network pull + N× decode), this ONE process pulls + decodes the source once
    (capped by ``VISION_DECODE_FPS``) and fans every decoded frame out to each
    model consumer, which samples at its own cadence and runs its own inference.
    Net: 1× decode + N× inference (was N× decode + N× inference).
    """
    from .capture import SharedCapture, make_sampler
    from .hls import HlsFrameReader
    from .sampler import FpsThrottle

    sc = SharedCapture()
    steps: dict[str, Any] = {}
    batchers = []
    builders = {
        "occupancy": _occupancy_consumer,
        "counting": _counting_consumer,
        "crowd": _crowd_consumer,
        "demography": _demography_consumer,
    }
    for model in mux.models:
        builder = builders.get(model)
        if builder is None:
            continue
        cfg = mux.for_model(model)
        built = builder(cfg)
        if built is None:
            log("consumer_skip", model=model, reason="no valid config")
            continue
        sampler, step, batcher, interval = built
        sc.add_consumer(model, sampler)
        steps[model] = step
        batchers.append(batcher)
        log("consumer_start", model=model, room=cfg.room)

    if not steps:
        log("config_error", message="multiplex: no runnable model consumers")
        return 2

    decode_gate = (
        FpsThrottle(mux.decode_fps).should_emit
        if mux.decode_fps and mux.decode_fps > 0
        else None
    )
    reader = HlsFrameReader(mux.base.hls_url, log=log, decode_gate=decode_gate)
    log(
        "start",
        mode="multiplex",
        room=mux.base.room,
        models=list(steps.keys()),
        decodeFps=mux.decode_fps,
    )
    try:
        for frame in reader.frames():
            now = time.time()
            for name in sc.dispatch(frame, now):
                steps[name](frame, now)
            for b in batchers:
                b.flush()
    except KeyboardInterrupt:
        pass
    log("stop", mode="multiplex")
    return 0


def _occupancy_consumer(config):  # pragma: no cover
    from .capture import make_sampler
    from .detector import PERSON_ID, VEHICLE_IDS, Detector
    from .models.occupancy import OccupancyConfig, OccupancyEngine

    occ = OccupancyConfig.from_dict(config.config)
    if not occ.zones:
        return None
    wants_vehicles = any(z.detect == "vehiculos" for z in occ.zones)
    classes = (PERSON_ID, *VEHICLE_IDS) if wants_vehicles else (PERSON_ID,)
    engine = OccupancyEngine(occ)
    batcher = _batcher(config)
    base = config.base_payload()
    detector = Detector(_model_for(config), config.device, 0.20, classes)

    def step(frame, now):
        for ev in engine.process(detector.track(frame), now):
            _emit(batcher, base, f"occupancy.{ev.kind}", ev.data)

    return make_sampler("occupancy"), step, batcher, 0.0


def _counting_consumer(config):  # pragma: no cover
    from .capture import make_sampler
    from .detector import PERSON_ID, Detector
    from .models.counting import CountingConfig, MultiLineCounter
    from .zones import poi_for_anchor

    cc = CountingConfig.from_dict(config.config)
    if not cc.lines:
        return None
    counter = MultiLineCounter(cc)
    batcher = _batcher(config)
    base = config.base_payload()
    detector = Detector(_model_for(config), config.device, 0.25, (PERSON_ID,))

    def step(frame, now):
        dets = detector.track(frame)
        active = [d["trackId"] for d in dets]
        for d in dets:
            x1, y1, x2, y2 = d["bbox"]
            foot = ((x1 + x2) / 2.0, y2)
            poi_name = None
            if cc.pois:
                p = poi_for_anchor(cc.pois, d["bbox"])
                if p is None:
                    continue
                poi_name = p.name
            for cr in counter.feed(d["trackId"], foot, d.get("conf"), poi=poi_name):
                _emit(batcher, base, f"count.{cr['direction']}", cr)
        counter.cleanup(active)
        _emit(batcher, base, "count.occupancy", {"inside": counter.occupancy, "capacity": cc.capacity or None})

    return make_sampler("counting", fps=cc.fps), step, batcher, 0.0


def _crowd_consumer(config):  # pragma: no cover
    from .capture import make_sampler
    from .detector import PERSON_ID, Detector
    from .models.crowd import CrowdConfig, CrowdEngine

    cc = CrowdConfig.from_dict(config.config)
    if not cc.zones:
        return None
    engine = CrowdEngine(cc)
    batcher = _batcher(config)
    base = config.base_payload()
    detector = Detector(_model_for(config), config.device, 0.25, (PERSON_ID,))

    def step(frame, now):
        dets = detector.track(_apply_clahe(frame))
        counts, thresholds = engine.process(dets, now)
        for c in counts:
            _emit(batcher, base, "crowd.count", c)
        for t in thresholds:
            _emit(batcher, base, "crowd.threshold", t)

    return make_sampler("crowd", interval_sec=cc.interval_sec), step, batcher, cc.interval_sec


def _demography_consumer(config):  # pragma: no cover
    from .capture import make_sampler
    from .models import demography as dm
    from .models.demography import DemographyConfig
    from .zones import poi_for_anchor

    settings = dict(config.config)
    settings.setdefault("engine", getattr(config, "engine", "local"))
    dc = DemographyConfig.from_dict(settings)
    batcher = _batcher(config)
    base = config.base_payload()
    analyze = _build_demography_analyzer(config, dc)

    def step(frame, now):
        for rec in analyze(frame):
            ev = _demography_event(dm, dc, rec, poi_for_anchor)
            if ev is not None:
                _emit(batcher, base, "demography.face", ev)

    return make_sampler("demography", interval_sec=dc.interval_sec), step, batcher, dc.interval_sec


# ---------------------------------------------------------------------------
# Edge daemon
# ---------------------------------------------------------------------------

def run_edge(config) -> int:  # pragma: no cover
    import asyncio

    from .supervisor import AssignmentSupervisor
    from .telemetry import collect_stats
    from .ws_client import WsClient

    def spawn(argv, env, cwd=None):
        import subprocess

        return subprocess.Popen(argv, env=env, cwd=cwd or None)

    import os

    from .supervisor import edge_child_base_env

    sink: dict = {}

    def on_status(aid, status, detail=None):
        client = sink.get("client")
        if client is not None:
            client.report_status(aid, status, detail)

    supervisor = AssignmentSupervisor(
        spawn=spawn,
        on_status=on_status,
        base_env=edge_child_base_env(os.environ, config.node_id),
    )

    def stats_fn():
        return collect_stats(config.capabilities)

    def log_reader(n):
        return _tail_log(config.log_path, n)

    client = WsClient(config, supervisor, stats_fn, log_reader, logger=lambda m: log("edge", message=m))
    sink["client"] = client

    async def reaper():
        while True:
            supervisor.reap()
            await asyncio.sleep(5)

    async def main():
        reap_task = asyncio.ensure_future(reaper())
        try:
            return await client.run()
        finally:
            reap_task.cancel()
            supervisor.stop_all()

    return asyncio.run(main())


def _tail_log(path: str, n: int) -> list[str]:  # pragma: no cover
    import os

    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return [ln.rstrip("\n") for ln in f.readlines()[-max(1, n):]]
    except OSError:
        return []
