"""
Dedupe window — PURE, clock-injected (unit-tested, no deps).

The same plate re-read within `window_sec` of its LAST EMITTED event is
suppressed: a car idling at the gate produces ONE event per window, not one
per sampled frame. The window is anchored on the last EMIT (not the last
sighting), so a plate that stays in view re-emits every `window_sec` — which
is what a barrier/presence consumer wants ("still here" heartbeats) while
webhook spam stays bounded.
"""
from __future__ import annotations


class DedupeWindow:
    """Per-plate emit gate. `should_emit(plate, now)` returns True when the
    plate's event should fire (and records the emit); False = duplicate.

    `window_sec <= 0` disables deduplication (every read emits).
    """

    def __init__(self, window_sec: float) -> None:
        self.window_sec = max(0.0, float(window_sec))
        self._last_emit: dict[str, float] = {}

    def should_emit(self, plate: str, now: float) -> bool:
        if self.window_sec <= 0:
            return True
        last = self._last_emit.get(plate)
        if last is not None and (now - last) < self.window_sec:
            return False
        self._last_emit[plate] = now
        return True

    def prune(self, now: float) -> None:
        """Drop plates whose window has fully elapsed (bounds memory on long
        runs — call occasionally, e.g. once per emitted event)."""
        if self.window_sec <= 0:
            self._last_emit.clear()
            return
        cutoff = now - self.window_sec
        stale = [p for p, ts in self._last_emit.items() if ts < cutoff]
        for p in stale:
            del self._last_emit[p]

    def __len__(self) -> int:
        return len(self._last_emit)
