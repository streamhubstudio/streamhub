"""
Line-crossing counter + occupancy accounting — pure logic, no cv2/torch.

PROVENANCE: port of Vision One's ``LineCrossingCounter``
(streamhub-vision-one: vision_one/models/people_counting/counting.py), keeping
every production-tuned guard:
  - per-track position history with a minimum track length before a crossing
    can count (kills one-frame detector ghosts);
  - a per-track cooldown after a counted crossing (a person lingering ON the
    line cannot be double-counted while the tracker jitters);
  - a maximum-displacement guard (a huge jump between two frames is a tracker
    ID switch, not a real movement — Vision One's ``max_crossing_speed``);
  - stale-track cleanup that keeps tracks parked NEAR the line alive.

Adapted for StreamHub: normalized [0,1] coordinates (resolution-independent),
occupancy exposed as max(0, in - out) exactly like Vision One's final report,
plus a small CapacityAlert edge detector for the `occupancy.limit` event.
"""
from __future__ import annotations

from collections import deque

from .geometry import (
    DEFAULT_SEGMENT_BUFFER,
    Point,
    crossing_direction,
    point_segment_distance,
)

# Vision One tuning (counting.py), translated to normalized units where the
# original was in pixels of a ~1280 px frame.
DEFAULT_MIN_TRACK_LENGTH = 2
DEFAULT_COOLDOWN_FRAMES = 15  # ≈3 s at 5 FPS, same as Vision One
DEFAULT_MAX_JUMP = 0.15  # Vision One: 150 px on ~1280 px ≈ 0.12–0.15
DEFAULT_HISTORY = 30
DEFAULT_CLEANUP_DISTANCE = 0.08  # Vision One: detection_threshold(50px) * 2


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

    # -- state ---------------------------------------------------------------

    @property
    def occupancy(self) -> int:
        """Current occupancy — clamped at 0 exactly like Vision One's report."""
        return max(0, self.total_in - self.total_out)

    def track_count(self) -> int:
        return len(self._tracks)

    # -- core ----------------------------------------------------------------

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

        # Reject huge jumps: that's a tracker ID switch, not a person moving
        # (Vision One's max_crossing_speed guard against double counts).
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

    def cleanup(self, active_ids: list[int] | set[int]) -> None:
        """Drop state of tracks that vanished — unless they parked near the
        line or are still in cooldown (Vision One's ``cleanup_old_tracks``:
        a person standing ON the line keeps their history so a re-detection
        with the same id can't re-count them)."""
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
    """Edge detector for the `occupancy.limit` event.

    Fires ONCE when occupancy climbs to >= capacity, then re-arms only after
    occupancy drops back BELOW capacity — so a full room doesn't spam an alert
    per crossing. capacity <= 0 disables the alert entirely.
    """

    def __init__(self, capacity: int) -> None:
        self.capacity = max(0, int(capacity))
        self._armed = True

    @property
    def enabled(self) -> bool:
        return self.capacity > 0

    def update(self, occupancy: int) -> bool:
        """Feed the current occupancy; True exactly when the alert fires."""
        if not self.enabled:
            return False
        if occupancy >= self.capacity:
            if self._armed:
                self._armed = False
                return True
            return False
        self._armed = True
        return False
