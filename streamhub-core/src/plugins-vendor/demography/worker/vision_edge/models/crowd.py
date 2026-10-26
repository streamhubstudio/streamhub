"""
Crowd — snapshot person counting per polygon zone with a multi-cycle threshold.

PROVENANCE: ports Vision One's ``CrowdStateManager`` time-threshold logic
(vision_one/models/crowd/state.py): each cycle (one snapshot every
``intervalSec``), if a zone's person count ≥ its threshold the consecutive-
cycle counter increments; below threshold it resets to 0. When the counter
reaches the required number of cycles the ``crowd.threshold`` event fires
(then re-arms only after the count drops back below threshold, so a sustained
crowd doesn't spam an alert every cycle). Every cycle also emits ``crowd.count``.

The required cycle count is derived from ``alertAfterSec / intervalSec`` (≥1),
so the Wave-2 zone schema (``alertLimit`` = person threshold, ``alertAfterSec``
= how long) drives it without a new field.

Runtime (not tested here): read ONE frame per interval from HLS, apply CLAHE,
YOLO-count persons inside each polygon, save an annotated snapshot locally.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from ..zones import PolygonZone, parse_zones

DEFAULT_INTERVAL_SEC = 120.0
DEFAULT_REQUIRED_CYCLES = 1


class CrowdZoneState:
    """Per-zone consecutive-cycle threshold counter (Vision One state.py)."""

    def __init__(self, threshold: int, required_cycles: int) -> None:
        self.threshold = max(0, int(threshold))
        self.required_cycles = max(1, int(required_cycles))
        self.cycles = 0
        self.last_count = 0
        self._armed = True

    def update(self, count: int) -> dict[str, Any]:
        """Feed this cycle's person count. Returns:
        {count, cycles, should_notify_count, should_notify_threshold}."""
        count = max(0, int(count))
        self.last_count = count
        over = self.threshold > 0 and count >= self.threshold
        if over:
            self.cycles += 1
        else:
            self.cycles = 0
            self._armed = True

        should_threshold = False
        if over and self.cycles >= self.required_cycles and self._armed:
            should_threshold = True
            self._armed = False  # fire once until it drops below threshold

        return {
            "count": count,
            "cycles": self.cycles,
            "should_notify_count": count > 0,
            "should_notify_threshold": should_threshold,
        }


def required_cycles(alert_after_sec: float, interval_sec: float) -> int:
    """cycles = ceil(alertAfterSec / intervalSec), at least 1."""
    if alert_after_sec <= 0 or interval_sec <= 0:
        return DEFAULT_REQUIRED_CYCLES
    return max(1, int(math.ceil(alert_after_sec / interval_sec)))


@dataclass
class CrowdConfig:
    zones: list[PolygonZone]
    interval_sec: float = DEFAULT_INTERVAL_SEC
    anchor: str = "foot"

    @classmethod
    def from_dict(cls, config: dict[str, Any] | None) -> "CrowdConfig":
        cfg = config or {}
        zones = parse_zones(cfg)
        interval = cfg.get("intervalSec")
        interval = float(interval) if isinstance(interval, (int, float)) and interval > 0 else DEFAULT_INTERVAL_SEC
        anchor = str(cfg.get("anchor", "foot")).strip().lower()
        if anchor not in ("foot", "center"):
            anchor = "foot"
        return cls(zones=zones, interval_sec=interval, anchor=anchor)


class CrowdEngine:
    """Runs all crowd zone states for a room. ``process(detections, now)``
    counts persons per zone and advances each threshold state, returning
    ``(count_events, threshold_events)`` as lists of pure dicts.
    """

    def __init__(self, config: CrowdConfig) -> None:
        self.config = config
        self.states: dict[str, CrowdZoneState] = {}
        for z in config.zones:
            cycles = required_cycles(z.alert_after_sec, config.interval_sec)
            self.states[z.id] = CrowdZoneState(z.alert_limit, cycles)

    def process(self, detections, now: float | None = None):
        from ..zones import count_in_zone

        dets = list(detections)
        count_events: list[dict[str, Any]] = []
        threshold_events: list[dict[str, Any]] = []
        for z in self.config.zones:
            n = count_in_zone(z, dets, self.config.anchor)
            state = self.states[z.id]
            res = state.update(n)
            count_events.append({"zone": z.id, "tag": z.tag, "count": res["count"]})
            if res["should_notify_threshold"]:
                threshold_events.append(
                    {
                        "zone": z.id,
                        "tag": z.tag,
                        "count": res["count"],
                        "threshold": state.threshold,
                        "cycles": res["cycles"],
                    }
                )
        return count_events, threshold_events


def run(config) -> int:  # pragma: no cover - runtime wiring (needs cv2/torch)
    from ..runtime import run_crowd

    return run_crowd(config)
