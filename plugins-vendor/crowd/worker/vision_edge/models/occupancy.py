"""
Occupancy — multi-polygon POI zones with sessions + occupancy alerts.

PROVENANCE: ports the session state machine from Vision One's
``PeoplePOIZone`` / ``VehiclePOIZone`` (occupancy/zones.py) — the
DetectionSmoother majority vote, the empty-grace before a session ends, the
minimum-session-duration filter, the fire-once alert with a re-arm and a
cooldown, and the weekday filter — but:

  - geometry is upgraded from Vision One's rectangles to MULTI-POLYGON zones
    (``vision_edge.zones``, cv2.pointPolygonTest-equivalent on the bbox
    anchor);
  - the alert is COUNT-based per the Wave-2 contract (``occupancy.alert``
    carries ``occupancy`` = objects in the zone, ``limit`` = alertLimit,
    ``sinceSec``), rather than Vision One's single-object dwell alert.

Per zone, per tick you feed the CURRENT qualifying-object COUNT and the wall
clock; the tracker emits ``occupancy.session_started`` / ``…_ended`` and
``occupancy.alert`` intents (pure dicts — the runner turns them into events).
Everything here is deterministic and unit-tested with no torch/cv2.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Optional

from ..zones import PolygonZone, parse_zones

# Vision One defaults (occupancy/zones.py) — seconds.
DEFAULT_GRACE_SEC = 120.0        # exit_timeout_seconds: empty this long ⇒ session end
DEFAULT_MIN_DURATION_SEC = 5.0   # min_session_duration: shorter sessions are dropped
DEFAULT_SMOOTHING_WINDOW = 1     # DetectionSmoother window (majority vote)
DEFAULT_ALERT_COOLDOWN_SEC = 600.0


class DetectionSmoother:
    """Majority-vote flicker filter (Vision One DetectionSmoother)."""

    def __init__(self, window_size: int = DEFAULT_SMOOTHING_WINDOW) -> None:
        self.window_size = max(1, int(window_size))
        self._history: deque[bool] = deque(maxlen=self.window_size)

    def smooth(self, is_detected: bool) -> bool:
        self._history.append(bool(is_detected))
        if len(self._history) < self.window_size:
            return bool(is_detected)
        return sum(self._history) > self.window_size // 2

    def reset(self) -> None:
        self._history.clear()


@dataclass
class ZoneEvent:
    kind: str  # 'session_started' | 'session_ended' | 'alert'
    zone: str
    tag: str
    detect: str
    data: dict[str, Any] = field(default_factory=dict)


class ZoneOccupancyTracker:
    """Session + alert state machine for ONE polygon zone (count-driven).

    ``update(count, now)`` where ``count`` = qualifying objects currently inside
    the polygon, ``now`` = unix seconds. Returns a list of ``ZoneEvent``:

      - session_started : present (smoothed count>0) while free.
      - session_ended   : empty continuously ≥ grace, IF the session lasted ≥
                          min_duration (else silently dropped). durationSec set.
      - alert           : count ≥ alertLimit sustained ≥ alertAfterSec; fires
                          once, re-arms when count drops below the limit, and
                          respects a cooldown. Carries occupancy/limit/sinceSec.
    """

    def __init__(
        self,
        zone: PolygonZone,
        grace_sec: float = DEFAULT_GRACE_SEC,
        min_duration_sec: float = DEFAULT_MIN_DURATION_SEC,
        smoothing_window: int = DEFAULT_SMOOTHING_WINDOW,
        alert_cooldown_sec: float = DEFAULT_ALERT_COOLDOWN_SEC,
    ) -> None:
        self.zone = zone
        self.grace_sec = float(grace_sec)
        self.min_duration_sec = float(min_duration_sec)
        self.alert_cooldown_sec = float(alert_cooldown_sec)
        self._smoother = DetectionSmoother(smoothing_window)

        self.is_occupied = False
        self.occupation_start: Optional[float] = None
        self.last_present: Optional[float] = None
        self.current_count = 0

        # Alert state.
        self._alert_armed = True
        self._over_since: Optional[float] = None
        self._last_alert_at: Optional[float] = None

    def _base(self) -> dict[str, Any]:
        # Wave-2 payload carries ``kind`` = 'personas'|'vehiculos'.
        return {"zone": self.zone.id, "tag": self.zone.tag, "kind": self.zone.detect}

    def update(self, count: int, now: float) -> list[ZoneEvent]:
        count = max(0, int(count))
        self.current_count = count
        present = self._smoother.smooth(count > 0)
        events: list[ZoneEvent] = []

        if present:
            self.last_present = now
            if not self.is_occupied:
                self.is_occupied = True
                self.occupation_start = now
                events.append(
                    ZoneEvent("session_started", self.zone.id, self.zone.tag, self.zone.detect, self._base())
                )
        else:
            if self.is_occupied and self.last_present is not None:
                if (now - self.last_present) >= self.grace_sec:
                    events.extend(self._end_session(now))

        events.extend(self._check_alert(count, now))
        return events

    def _end_session(self, now: float) -> list[ZoneEvent]:
        events: list[ZoneEvent] = []
        start = self.occupation_start
        end = self.last_present if self.last_present is not None else now
        duration = (end - start) if start is not None else 0.0
        if start is not None and duration >= self.min_duration_sec:
            data = self._base()
            data["durationSec"] = round(duration, 1)
            events.append(
                ZoneEvent("session_ended", self.zone.id, self.zone.tag, self.zone.detect, data)
            )
        self.is_occupied = False
        self.occupation_start = None
        self._smoother.reset()
        # Reset alert state for the next session.
        self._alert_armed = True
        self._over_since = None
        return events

    def _check_alert(self, count: int, now: float) -> list[ZoneEvent]:
        limit = self.zone.alert_limit
        if limit <= 0:
            return []
        if count >= limit:
            if self._over_since is None:
                self._over_since = now
            sustained = now - self._over_since
            if sustained < self.zone.alert_after_sec:
                return []
            if not self._alert_armed:
                return []
            if self._last_alert_at is not None and (now - self._last_alert_at) < self.alert_cooldown_sec:
                return []
            self._alert_armed = False
            self._last_alert_at = now
            data = self._base()  # already carries zone/tag/kind
            data.update(
                {
                    "occupancy": count,
                    "limit": limit,
                    "sinceSec": round(sustained, 1),
                }
            )
            return [ZoneEvent("alert", self.zone.id, self.zone.tag, self.zone.detect, data)]
        # Below the limit → re-arm.
        self._over_since = None
        self._alert_armed = True
        return []


@dataclass
class OccupancyConfig:
    zones: list[PolygonZone]
    grace_sec: float = DEFAULT_GRACE_SEC
    min_duration_sec: float = DEFAULT_MIN_DURATION_SEC
    anchor: str = "foot"  # 'foot' | 'center'

    @classmethod
    def from_dict(cls, config: dict[str, Any] | None) -> "OccupancyConfig":
        cfg = config or {}
        zones = parse_zones(cfg)
        grace = cfg.get("graceSec")
        grace = float(grace) if isinstance(grace, (int, float)) else DEFAULT_GRACE_SEC
        min_dur = cfg.get("minDurationSec")
        min_dur = float(min_dur) if isinstance(min_dur, (int, float)) else DEFAULT_MIN_DURATION_SEC
        anchor = str(cfg.get("anchor", "foot")).strip().lower()
        if anchor not in ("foot", "center"):
            anchor = "foot"
        return cls(zones=zones, grace_sec=grace, min_duration_sec=min_dur, anchor=anchor)


class OccupancyEngine:
    """Runs all zone trackers for a room. ``process(detections, now)`` counts
    detections per zone and advances each tracker, returning the merged events.
    Pure (detections are plain dicts)."""

    def __init__(self, config: OccupancyConfig) -> None:
        self.config = config
        self.trackers = {
            z.id: ZoneOccupancyTracker(
                z, grace_sec=config.grace_sec, min_duration_sec=config.min_duration_sec
            )
            for z in config.zones
        }

    def process(self, detections, now: float) -> list[ZoneEvent]:
        from ..zones import count_in_zone

        dets = list(detections)
        events: list[ZoneEvent] = []
        for z in self.config.zones:
            n = count_in_zone(z, dets, self.config.anchor)
            events.extend(self.trackers[z.id].update(n, now))
        return events


def run(config) -> int:  # pragma: no cover - runtime wiring (needs torch/cv2)
    from ..runtime import run_occupancy

    return run_occupancy(config)
