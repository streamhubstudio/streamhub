"""
Zone geometry — pure functions (unit-tested, no heavy deps).

Zones are axis-aligned rectangles in NORMALIZED coordinates (0-1 fractions of
the video frame), exactly as the plugin config stores them:

    [{ "id": "desk-1", "name": "Front desk", "x": 0.1, "y": 0.2,
       "w": 0.3, "h": 0.4 }, ...]

A person "occupies" a zone when their ANCHOR POINT is inside the rectangle.
The anchor is the bottom-center of the detection bbox (where the feet meet the
floor) — for typical CCTV/workstation angles this is far more stable than the
box center, which drifts into background zones when a person leans or stands.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


@dataclass(frozen=True)
class Zone:
    id: str
    name: str
    x: float
    y: float
    w: float
    h: float


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _f(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN / inf guard
        return None
    return f


def parse_zones(raw: str | None) -> list[Zone]:
    """Parse the zones config JSON, tolerantly.

    - non-JSON / non-list input → []
    - entries without a non-empty string `id` are skipped
    - `name` defaults to the id
    - x/y clamp into [0,1]; w/h clamp so the rect stays inside the frame
    - zero-area rects are skipped
    - duplicate ids: first one wins
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []

    out: list[Zone] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, Mapping):
            continue
        zid = item.get("id")
        if not isinstance(zid, str) or not zid.strip():
            continue
        zid = zid.strip()
        if zid in seen:
            continue
        x = _f(item.get("x"))
        y = _f(item.get("y"))
        w = _f(item.get("w"))
        h = _f(item.get("h"))
        if x is None or y is None or w is None or h is None:
            continue
        x = _clamp(x, 0.0, 1.0)
        y = _clamp(y, 0.0, 1.0)
        w = _clamp(w, 0.0, 1.0 - x)
        h = _clamp(h, 0.0, 1.0 - y)
        if w <= 0.0 or h <= 0.0:
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            name = zid
        seen.add(zid)
        out.append(Zone(id=zid, name=name.strip(), x=x, y=y, w=w, h=h))
    return out


def anchor_point(bbox: Sequence[float]) -> tuple[float, float]:
    """Anchor of a normalized [x, y, w, h] person bbox: bottom-center (feet)."""
    x, y, w, h = (float(v) for v in bbox[:4])
    return (_clamp(x + w / 2.0, 0.0, 1.0), _clamp(y + h, 0.0, 1.0))


def zone_contains(zone: Zone, px: float, py: float) -> bool:
    """Point-in-rect test (edges inclusive)."""
    return zone.x <= px <= zone.x + zone.w and zone.y <= py <= zone.y + zone.h


def count_occupancy(
    zones: Iterable[Zone],
    boxes: Iterable[Any],
) -> dict[str, int]:
    """Persons per zone. `boxes` are detection dicts ({'bbox': [x,y,w,h], ...})
    or bare [x,y,w,h] sequences. One person can occupy several overlapping
    zones (each zone counts independently).
    """
    anchors: list[tuple[float, float]] = []
    for b in boxes:
        bbox = b.get("bbox") if isinstance(b, Mapping) else b
        if bbox is None:
            continue
        try:
            anchors.append(anchor_point(bbox))
        except (TypeError, ValueError, IndexError):
            continue
    return {
        z.id: sum(1 for (px, py) in anchors if zone_contains(z, px, py))
        for z in zones
    }
