"""
Realtime people counting — multi-line, FIXED-cadence (Wave-2: 3.5 FPS, NOT
adaptive sampling — recon flagged ByteTrack/BoT-SORT ID-swap sensitivity when
the frame gap varies).

``LineCrossingCounter`` is a VERBATIM logic port of Vision One's
``LineCrossingCounter`` (vision_one/models/people_counting/counting.py), keeping
every production-tuned guard:
  - a minimum track length before a crossing can count (kills 1-frame ghosts);
  - a per-track cooldown after a counted crossing (a person lingering ON the
    line can't be double-counted while the tracker jitters);
  - a max-displacement guard (a huge jump between frames is a tracker ID switch,
    not real movement — Vision One's ``max_crossing_speed``);
  - stale-track cleanup that keeps tracks parked NEAR the line alive.

``MultiLineCounter`` runs one counter per configured line (each tagged),
driving ``count.in`` / ``count.out`` events and a rolling ``count.occupancy``.

Config schema (config_json): {"lines":[{"id","tag","x","y","length","angle",
"inside":"top"|"bottom"|"left"|"right"}], "fps":3.5, "capacity"?}.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Mapping

from ..geometry import (
    DEFAULT_SEGMENT_BUFFER,
    Point,
    crossing_direction,
    line_from_center,
    point_segment_distance,
    resolve_in_side,
)
from ..zones import NamedPolygon, parse_pois

# Vision One tuning (counting.py), normalized where the original was in pixels.
DEFAULT_MIN_TRACK_LENGTH = 2
DEFAULT_COOLDOWN_FRAMES = 15   # ≈3 s at 5 FPS
DEFAULT_MAX_JUMP = 0.15       # Vision One: ~150 px on ~1280 px
DEFAULT_HISTORY = 30
DEFAULT_CLEANUP_DISTANCE = 0.08
DEFAULT_FPS = 3.5


class LineCrossingCounter:
    """Counts IN/OUT crossings of a directed line and tracks live occupancy."""

    def __init__(
        self,
        line_a: Point,
        line_b: Point,
        in_side: str = "right",
        *,
        min_track_length: int = DEFAULT_MIN_TRACK_LENGTH,
        cooldown_frames: int = DEFAULT_COOLDOWN_FRAMES,
        max_jump: float = DEFAULT_MAX_JUMP,
        history: int = DEFAULT_HISTORY,
        buffer: float = DEFAULT_SEGMENT_BUFFER,
    ) -> None:
        self.line_a = (float(line_a[0]), float(line_a[1]))
        self.line_b = (float(line_b[0]), float(line_b[1]))
        self.in_side = in_side if in_side in ("right", "left") else "right"
        self.min_track_length = max(1, int(min_track_length))
        self.cooldown_frames = max(0, int(cooldown_frames))
        self.max_jump = float(max_jump)
        self.history = max(2, int(history))
        self.buffer = float(buffer)

        self.total_in = 0
        self.total_out = 0

        self._tracks: dict[int, deque[Point]] = {}
        self._last: dict[int, Point] = {}
        self._cooldown: dict[int, int] = {}

    @property
    def occupancy(self) -> int:
        """Current occupancy — clamped at 0 exactly like Vision One's report."""
        return max(0, self.total_in - self.total_out)

    def track_count(self) -> int:
        return len(self._tracks)

    def check(self, track_id: int, pos: Point, frame_num: int = 0) -> str | None:
        """Feed one tracked position; returns 'in' | 'out' when it crossed.

        Same decision ladder as Vision One's ``check_line_crossing``:
        first-sighting init → cooldown → min track length → displacement
        (ID-switch) guard → buffered intersection + strict side change.
        """
        cur = (float(pos[0]), float(pos[1]))

        if track_id not in self._tracks:
            self._tracks[track_id] = deque(maxlen=self.history)
            self._tracks[track_id].append(cur)
            self._last[track_id] = cur
            self._cooldown[track_id] = 0
            return None

        self._tracks[track_id].append(cur)

        if self._cooldown[track_id] > 0:
            self._cooldown[track_id] -= 1
            self._last[track_id] = cur
            return None

        if len(self._tracks[track_id]) < self.min_track_length:
            self._last[track_id] = cur
            return None

        prev = self._last[track_id]

        dx, dy = cur[0] - prev[0], cur[1] - prev[1]
        if (dx * dx + dy * dy) ** 0.5 > self.max_jump:
            self._last[track_id] = cur
            return None

        direction = crossing_direction(
            prev, cur, self.line_a, self.line_b, self.in_side, self.buffer
        )
        if direction:
            self._cooldown[track_id] = self.cooldown_frames
            if direction == "in":
                self.total_in += 1
            else:
                self.total_out += 1
        self._last[track_id] = cur
        return direction

    def cleanup(self, active_ids) -> None:
        """Drop state of tracks that vanished — unless they parked near the
        line or are still in cooldown (Vision One's ``cleanup_old_tracks``)."""
        active = set(active_ids)
        for track_id in list(self._tracks.keys()):
            if track_id in active:
                continue
            if self._cooldown.get(track_id, 0) > 0:
                continue
            last = self._tracks[track_id][-1] if self._tracks[track_id] else None
            if last is not None:
                dist = point_segment_distance(last, self.line_a, self.line_b)
                if dist <= DEFAULT_CLEANUP_DISTANCE:
                    continue
            del self._tracks[track_id]
            self._last.pop(track_id, None)
            self._cooldown.pop(track_id, None)


class CapacityAlert:
    """Edge detector for a capacity event.

    Fires ONCE when occupancy climbs to >= capacity, then re-arms only after
    occupancy drops back BELOW capacity — so a full room doesn't spam the
    alert per crossing. capacity <= 0 disables it.
    """

    def __init__(self, capacity: int) -> None:
        self.capacity = max(0, int(capacity))
        self._armed = True

    @property
    def enabled(self) -> bool:
        return self.capacity > 0

    def update(self, occupancy: int) -> bool:
        if not self.enabled:
            return False
        if occupancy >= self.capacity:
            if self._armed:
                self._armed = False
                return True
            return False
        self._armed = True
        return False


@dataclass(frozen=True)
class CountingLine:
    id: str
    tag: str
    a: Point
    b: Point
    in_side: str


def _f(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass
class CountingConfig:
    lines: list[CountingLine]
    fps: float = DEFAULT_FPS
    capacity: int = 0
    # Optional POIs: when set, a crossing only COUNTS if the track's foot is
    # inside a POI, and the event carries that POI's name. Empty = whole frame.
    pois: list[NamedPolygon] = field(default_factory=list)

    @classmethod
    def from_dict(cls, config: Mapping[str, Any] | None) -> "CountingConfig":
        cfg = config or {}
        fps = _f(cfg.get("fps"), DEFAULT_FPS)
        fps = min(15.0, max(0.5, fps))
        cap = cfg.get("capacity")
        capacity = max(0, int(cap)) if isinstance(cap, (int, float)) else 0
        pois = parse_pois(cfg)
        lines: list[CountingLine] = []
        seen: set[str] = set()
        raw_lines = cfg.get("lines")
        if isinstance(raw_lines, (list, tuple)):
            for i, item in enumerate(raw_lines):
                if not isinstance(item, Mapping):
                    continue
                lid = item.get("id")
                lid = lid.strip() if isinstance(lid, str) and lid.strip() else f"line{i}"
                if lid in seen:
                    continue
                x, y = _f(item.get("x"), 0.5), _f(item.get("y"), 0.5)
                length = _f(item.get("length"), 0.6)
                angle = _f(item.get("angle"), 0.0)
                if length <= 0:
                    continue
                a, b = line_from_center(x, y, length, angle)
                if a == b:
                    continue
                inside = str(item.get("inside", "top")).strip().lower()
                if inside not in ("top", "bottom", "left", "right"):
                    inside = "top"
                in_side = resolve_in_side(a, b, inside)
                tag = item.get("tag")
                tag = tag.strip() if isinstance(tag, str) and tag.strip() else lid
                seen.add(lid)
                lines.append(CountingLine(id=lid, tag=tag, a=a, b=b, in_side=in_side))
        return cls(lines=lines, fps=fps, capacity=capacity, pois=pois)


class MultiLineCounter:
    """One ``LineCrossingCounter`` per configured line, plus a shared capacity
    alert on the aggregate occupancy.

    ``feed(track_id, pos, conf)`` returns a list of crossing dicts (one per
    line that this movement crossed): ``{line, tag, direction, trackId,
    confidence}``. ``occupancy`` is the summed live occupancy across lines.
    """

    def __init__(self, config: CountingConfig, **counter_kwargs: Any) -> None:
        self.config = config
        self._counters: dict[str, LineCrossingCounter] = {
            ln.id: LineCrossingCounter(ln.a, ln.b, ln.in_side, **counter_kwargs)
            for ln in config.lines
        }
        self._tags: dict[str, str] = {ln.id: ln.tag for ln in config.lines}
        self.alert = CapacityAlert(config.capacity)

    @property
    def occupancy(self) -> int:
        return sum(c.occupancy for c in self._counters.values())

    def totals(self) -> tuple[int, int]:
        return (
            sum(c.total_in for c in self._counters.values()),
            sum(c.total_out for c in self._counters.values()),
        )

    def feed(
        self,
        track_id: int,
        pos: Point,
        confidence: float | None = None,
        poi: str | None = None,
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for lid, counter in self._counters.items():
            direction = counter.check(track_id, pos)
            if direction:
                out.append(
                    {
                        "line": lid,
                        "tag": self._tags[lid],
                        "direction": direction,
                        "trackId": track_id,
                        "confidence": confidence,
                        # The POI the crossing happened in (None = whole frame).
                        "poi": poi,
                    }
                )
        return out

    def cleanup(self, active_ids) -> None:
        for counter in self._counters.values():
            counter.cleanup(active_ids)

    def capacity_tripped(self) -> bool:
        return self.alert.update(self.occupancy)


def run(config) -> int:  # pragma: no cover - runtime wiring (needs torch/cv2)
    """Runtime entrypoint (wires HLS reader + YOLO/ByteTrack tracker at a FIXED
    ``fps`` cadence). Not exercised by the pure tests."""
    from ..runtime import run_realtime_counting

    return run_realtime_counting(config)
