"""
Work zones — normalized rectangles a violation is scoped to (pure, unit-tested).

Zones come from plugin config as a JSON array of {name, rect:[x,y,w,h]} with
0–1 frame-relative coordinates. No/invalid zones config falls back to ONE
full-frame zone named "all" — the plugin works out of the box and an operator
narrows it down later. A person belongs to a zone when their ANCHOR POINT
(bottom-center of the box ≈ the feet) lies inside the zone rect: feet, not box
center, because zones are floor areas.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Sequence

#: Fallback zone covering the whole frame.
FULL_FRAME_NAME = "all"


@dataclass(frozen=True)
class Zone:
    name: str
    #: (x, y, w, h) normalized 0–1.
    rect: tuple[float, float, float, float]

    def contains(self, point: tuple[float, float]) -> bool:
        x, y, w, h = self.rect
        px, py = point
        return x <= px <= x + w and y <= py <= y + h


def _clamp01(v: float) -> float:
    return min(1.0, max(0.0, float(v)))


def full_frame_zone() -> Zone:
    return Zone(FULL_FRAME_NAME, (0.0, 0.0, 1.0, 1.0))


def parse_zones(raw: str | None) -> list[Zone]:
    """Parse the zones config JSON. Returns [full-frame "all"] when empty or
    malformed — a config typo must degrade to "watch everything", never crash.

    Each entry needs a non-empty `name` and a 4-number `rect`; values are
    clamped into 0–1 and zero-area rects are dropped. Duplicate names keep the
    first occurrence.
    """
    if not raw or not str(raw).strip():
        return [full_frame_zone()]
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return [full_frame_zone()]
    if not isinstance(data, list):
        return [full_frame_zone()]

    zones: list[Zone] = []
    seen: set[str] = set()
    for entry in data:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        rect = entry.get("rect")
        if not name or name in seen:
            continue
        if not isinstance(rect, (list, tuple)) or len(rect) != 4:
            continue
        try:
            x, y, w, h = (_clamp01(v) for v in rect)
        except (TypeError, ValueError):
            continue
        w = min(w, 1.0 - x)
        h = min(h, 1.0 - y)
        if w <= 0 or h <= 0:
            continue
        zones.append(Zone(name, (x, y, w, h)))
        seen.add(name)
    return zones or [full_frame_zone()]


def anchor_point(bbox: Sequence[float]) -> tuple[float, float]:
    """Bottom-center ("feet") of a normalized [x1,y1,x2,y2] person box."""
    return ((float(bbox[0]) + float(bbox[2])) / 2.0, float(bbox[3]))


def zones_containing(bbox: Sequence[float], zones: Sequence[Zone]) -> list[str]:
    """Names of every zone whose rect contains the person's anchor point."""
    p = anchor_point(bbox)
    return [z.name for z in zones if z.contains(p)]
