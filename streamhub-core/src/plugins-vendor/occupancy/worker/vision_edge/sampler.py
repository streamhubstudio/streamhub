"""
Frame samplers — pure, wall-clock deterministic (no cv2/threads).

Two cadences, both unit-tested by feeding an explicit clock:

* ``FpsThrottle`` — FIXED cadence. Emit at most ``target_fps`` frames/sec by
  wall clock. Used by realtime **counting** (Wave-2 contract pins 3.5 FPS, NOT
  adaptive sampling — recon flagged ByteTrack/BoT-SORT ID-swap sensitivity when
  the frame gap varies) and as the base gate everywhere else.

* ``AdaptiveFrameSampler`` — VARIABLE skip. Faithful port of Vision One's
  ``AdaptiveFrameSampler`` (occupancy/streaming.py): two EMAs (detection
  activity + system load) drive how many decoded frames to skip between
  inferences, clamped to [min_skip, max_skip]. Occupancy tolerates this because
  its session/dwell logic works on seconds, not per-frame identity. See the
  exact constants below.
"""
from __future__ import annotations

from typing import Optional


class FpsThrottle:
    """Emit at most ``target_fps`` frames per second (by wall clock).

    Decoupled from any clock/source so it is deterministic under test: call
    ``should_emit(now)`` per decoded frame; True when enough time has elapsed
    since the last emitted frame.
    """

    def __init__(self, target_fps: float) -> None:
        self.target_fps = max(0.01, float(target_fps))
        self.min_interval = 1.0 / self.target_fps
        self._last: Optional[float] = None

    def should_emit(self, now: float) -> bool:
        if self._last is None or (now - self._last) >= self.min_interval:
            self._last = now
            return True
        return False

    def reset(self) -> None:
        self._last = None


# Vision One AdaptiveFrameSampler constants (occupancy/streaming.py).
DEFAULT_BASE_SKIP = 9
DEFAULT_MIN_SKIP = 4
DEFAULT_MAX_SKIP = 19
ACTIVITY_EMA_ALPHA = 0.3          # weight of a new activity sample
ACTIVITY_SATURATION = 5.0         # detections that saturate the activity score
LOAD_EMA_ALPHA = 0.2              # weight of a new load sample
LOAD_SATURATION = 20.0            # queue depth that saturates the load score
SKIP_BASE_FLOOR = 0.5             # multiplier floor
SKIP_ACTIVITY_WEIGHT = 0.3        # weight of (1 - activity) in the multiplier
SKIP_LOAD_WEIGHT = 0.4            # weight of load in the multiplier


class AdaptiveFrameSampler:
    """Port of Vision One's occupancy AdaptiveFrameSampler.

    Two exponential moving averages:
      activity_score = 0.7*activity_score + 0.3*min(detections/5, 1.0)
      system_load    = 0.8*system_load    + 0.2*min(queue_depth/20, 1.0)

    Skip decision:
      activity_factor = 1 - activity_score
      skip = int(base_skip * (0.5 + activity_factor*0.3 + system_load*0.4))
      return clamp(min_skip, max_skip, skip)

    So MORE detections → sample MORE often (fewer skips); HIGHER load → sample
    LESS often (more skips). Initial ``system_load`` is 0.5 (Vision One), so a
    cold sampler at defaults returns skip=int(9*(0.5+0.3+0.2))=9.
    """

    def __init__(
        self,
        base_skip: int = DEFAULT_BASE_SKIP,
        min_skip: int = DEFAULT_MIN_SKIP,
        max_skip: int = DEFAULT_MAX_SKIP,
    ) -> None:
        self.base_skip = int(base_skip)
        self.min_skip = int(min_skip)
        self.max_skip = int(max_skip)
        self.activity_score = 0.0
        self.system_load = 0.5

    def update_activity(self, detections_count: int) -> None:
        sample = min(detections_count / ACTIVITY_SATURATION, 1.0)
        self.activity_score = (
            (1 - ACTIVITY_EMA_ALPHA) * self.activity_score
            + ACTIVITY_EMA_ALPHA * sample
        )

    def update_system_load(self, queue_depth: int) -> None:
        sample = min(queue_depth / LOAD_SATURATION, 1.0)
        self.system_load = (
            (1 - LOAD_EMA_ALPHA) * self.system_load + LOAD_EMA_ALPHA * sample
        )

    def frames_to_skip(self) -> int:
        activity_factor = 1.0 - self.activity_score
        skip = int(
            self.base_skip
            * (
                SKIP_BASE_FLOOR
                + activity_factor * SKIP_ACTIVITY_WEIGHT
                + self.system_load * SKIP_LOAD_WEIGHT
            )
        )
        return max(self.min_skip, min(self.max_skip, skip))
