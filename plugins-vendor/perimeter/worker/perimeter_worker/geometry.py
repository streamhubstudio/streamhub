"""
Pure zone geometry — no heavy deps (unit-tested).

Everything between "raw YOLO person boxes" and "which restricted zone was
entered" lives here as plain-Python functions: zone JSON parsing (normalized
polygons + rect shorthand), point-in-polygon (ray casting), the person anchor
point (foot/center) and box normalization. Same conventions as deface-worker:
normalized boxes are [x, y, w, h] in 0-1 frame coordinates.
"""
from __future__ import annotations

import json
import re
from typing import Any, Sequence

Point = tuple[float, float]

_ANCHORS = {"foot", "center"}


def clamp01(v: float) -> float:
    return min(1.0, max(0.0, float(v)))


def _zone_id(raw: Any, index: int) -> str:
    """A usable zone id: the entry's own id (trimmed) or `zone-<n>`."""
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return f"zone-{index + 1}"


def rect_to_points(rect: Sequence[float]) -> list[Point] | None:
    """[x, y, w, h] (normalized) → 4 clockwise polygon points, or None."""
    if len(rect) != 4:
        return None
    try:
        x, y, w, h = (float(v) for v in rect)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    x1, y1 = round(clamp01(x), 4), round(clamp01(y), 4)
    x2, y2 = round(clamp01(x + w), 4), round(clamp01(y + h), 4)
    if x2 - x1 <= 0 or y2 - y1 <= 0:
        return None
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def parse_zones(raw: str | None) -> list[dict[str, Any]]:
    """Parse the `zones` config JSON into [{id, points:[(x,y),...]}].

    Accepted entry shapes (coordinates normalized 0-1, clamped):
      {"id": "gate", "points": [[x,y], [x,y], [x,y], ...]}   # >= 3 points
      {"id": "door", "rect": [x, y, w, h]}                    # axis-aligned

    Malformed JSON, non-list roots and unusable entries are DROPPED, never
    raised — a config typo must not crash the loop (deface `parse_scale` rule).
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []

    zones: list[dict[str, Any]] = []
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            continue
        points: list[Point] | None = None
        if isinstance(entry.get("rect"), (list, tuple)):
            points = rect_to_points(entry["rect"])
        elif isinstance(entry.get("points"), (list, tuple)):
            pts: list[Point] = []
            for p in entry["points"]:
                if not isinstance(p, (list, tuple)) or len(p) < 2:
                    pts = []
                    break
                try:
                    pts.append((clamp01(float(p[0])), clamp01(float(p[1]))))
                except (TypeError, ValueError):
                    pts = []
                    break
            if len(pts) >= 3:
                points = pts
        if not points:
            continue
        zones.append({"id": _zone_id(entry.get("id"), i), "points": points})
    return zones


def point_in_polygon(pt: Point, polygon: Sequence[Point]) -> bool:
    """Ray-casting point-in-polygon test (edges count as inside-ish: the
    crossing rule; exact-on-vertex behavior is not load-bearing for zones).
    """
    x, y = pt
    inside = False
    n = len(polygon)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def anchor_point(bbox: Sequence[float], anchor: str = "foot") -> Point:
    """Normalized [x, y, w, h] person box → the point tested against zones.

    `foot` (default) is the bottom-center — the standard intrusion anchor: a
    person "is" where they stand, so a floor zone triggers on entry rather than
    when a head crosses it. `center` is the box centroid.
    """
    x, y, w, h = (float(v) for v in bbox[:4])
    if anchor not in _ANCHORS:
        anchor = "foot"
    cx = clamp01(x + w / 2.0)
    if anchor == "center":
        return (cx, clamp01(y + h / 2.0))
    return (cx, clamp01(y + h))


def normalize_box(box: Sequence[float], frame_w: float, frame_h: float) -> list[float]:
    """Pixel [x1,y1,x2,y2] → normalized [x, y, w, h] in 0-1 (4 decimals)."""
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    return [
        round(x1 / frame_w, 4),
        round(y1 / frame_h, 4),
        round((x2 - x1) / frame_w, 4),
        round((y2 - y1) / frame_h, 4),
    ]


def persons_to_payload(
    dets: Sequence[Sequence[float]],
    frame_w: float,
    frame_h: float,
) -> list[dict[str, Any]]:
    """Raw pixel detections [x1,y1,x2,y2,conf] → [{bbox:[x,y,w,h], conf}].

    Degenerate boxes (zero/negative area) and zero-sized frames are dropped.
    """
    out: list[dict[str, Any]] = []
    if frame_w <= 0 or frame_h <= 0:
        return out
    for det in dets:
        x1, y1, x2, y2 = (float(v) for v in det[:4])
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            continue
        out.append(
            {
                "bbox": normalize_box(det, frame_w, frame_h),
                "conf": round(float(det[4]), 4),
            }
        )
    return out


def zones_hit(
    persons: Sequence[dict[str, Any]],
    zones: Sequence[dict[str, Any]],
    anchor: str = "foot",
) -> list[tuple[str, float]]:
    """Which zones contain at least one person anchor point.

    Returns [(zone_id, max_confidence)] in zone order — one entry per hit zone
    regardless of how many people are inside (the cooldown is per zone).
    """
    hits: list[tuple[str, float]] = []
    for zone in zones:
        best = -1.0
        for person in persons:
            pt = anchor_point(person["bbox"], anchor)
            if point_in_polygon(pt, zone["points"]):
                best = max(best, float(person.get("conf", 0.0)))
        if best >= 0:
            hits.append((zone["id"], round(best, 4)))
    return hits


def slugify_zone(zone_id: str) -> str:
    """Zone id → filesystem-safe chunk for evidence filenames."""
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", zone_id.strip()).strip("-").lower()
    return slug or "zone"
