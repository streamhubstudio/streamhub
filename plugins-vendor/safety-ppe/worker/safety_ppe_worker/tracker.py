"""
Sustained-violation tracking + per-zone cooldown (pure, unit-tested).

A single frame with a missing helmet is noise (occlusion, a person turning,
one bad inference). A VIOLATION requires the same item to be missing in a zone
for MORE THAN `sustain_frames` CONSECUTIVE analyzed frames (default 3 → the
event fires on the 4th consecutive frame). Once fired, the (zone, item) pair
enters a cooldown window (default 120 s) during which it cannot re-fire, so a
worker standing helmet-less in view doesn't spam an event per frame.

Streaks are per (zone, item) and reset the moment a frame shows the item no
longer missing in that zone — or on `reset()` (off-schedule / stream gap),
because frames separated by an idle period are not "consecutive" evidence.
"""
from __future__ import annotations

from typing import Iterable

DEFAULT_SUSTAIN_FRAMES = 3
DEFAULT_COOLDOWN_SECONDS = 120.0


class ViolationTracker:
    def __init__(
        self,
        sustain_frames: int = DEFAULT_SUSTAIN_FRAMES,
        cooldown_seconds: float = DEFAULT_COOLDOWN_SECONDS,
    ) -> None:
        self.sustain_frames = max(0, int(sustain_frames))
        self.cooldown_seconds = max(0.0, float(cooldown_seconds))
        self._streak: dict[tuple[str, str], int] = {}
        self._last_fired: dict[tuple[str, str], float] = {}

    def reset(self) -> None:
        """Drop every streak (schedule idle / stream gap). Cooldowns are KEPT —
        an idle minute must not re-arm an event that just fired."""
        self._streak.clear()

    def streak(self, zone: str, item: str) -> int:
        """Current consecutive-frame streak for (zone, item) — for tests/logs."""
        return self._streak.get((zone, item), 0)

    def update(
        self,
        zone: str,
        missing: Iterable[str],
        confidence: float,
        now: float,
    ) -> dict | None:
        """Feed one analyzed frame's result for one zone.

        `missing` is the set of items currently missing in the zone. Returns a
        violation event `{ "zone", "missing": [items], "confidence" }` when one
        or more items cross the sustain threshold outside their cooldown, else
        None. Items that fire together in the same frame are grouped into ONE
        event (a person missing helmet AND vest is one incident).
        """
        missing_set = set(missing)

        # Reset streaks for this zone's items that are no longer missing.
        for key in [k for k in self._streak if k[0] == zone and k[1] not in missing_set]:
            del self._streak[key]

        fired: list[str] = []
        for item in sorted(missing_set):
            key = (zone, item)
            streak = self._streak.get(key, 0) + 1
            self._streak[key] = streak
            if streak <= self.sustain_frames:
                continue
            last = self._last_fired.get(key)
            if last is not None and (now - last) < self.cooldown_seconds:
                continue
            fired.append(item)

        if not fired:
            return None
        for item in fired:
            self._last_fired[(zone, item)] = now
        return {"zone": zone, "missing": fired, "confidence": round(float(confidence), 4)}
