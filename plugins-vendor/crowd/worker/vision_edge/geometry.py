"""
Geometry — pure functions over NORMALIZED [0,1] coordinates (no cv2/numpy).

Two families:

1. LINE crossing (people counting). PROVENANCE: ported verbatim in logic from
   Vision One's production ``LineCrossingCounter``
   (streamhub-vision-one: vision_one/models/people_counting/counting.py), via
   StreamHub's people-counter-worker geometry. The cross-product side test, the
   buffered segment-intersection check and the side-based IN/OUT resolution are
   the same math, re-expressed over normalized coordinates so the runtime is
   resolution-independent (Vision One worked in pixels of a fixed frame).

2. POLYGON membership (occupancy / crowd zones). ``point_in_polygon`` is a pure
   ray-casting test with the SAME inside/outside verdict as OpenCV's
   ``cv2.pointPolygonTest(...) >= 0`` used in Vision One's zone processing — so
   the runtime can use cv2 in production and the tests assert membership with
   no OpenCV import.

Coordinate convention (screen coords, y DOWN — matches video frames and the
dashboard editors): a directed line a→b has ``side_of_line`` +1 on the RIGHT,
-1 on the LEFT; ``in_side`` ('right'|'left') names which side is INSIDE.
"""
from __future__ import annotations

import math
from typing import Sequence

Point = tuple[float, float]

# Vision One extended the movement segment by a 5 px buffer on ~1280 px frames
# so a track that lands exactly on the line still registers; normalized
# equivalent (5/1280 ≈ 0.004).
DEFAULT_SEGMENT_BUFFER = 0.004


# ---------------------------------------------------------------------------
# Line crossing (people counting)
# ---------------------------------------------------------------------------

def side_of_line(p: Point, a: Point, b: Point) -> int:
    """Which side of the directed line a→b the point is on.

    +1 = right (screen coords, y down), -1 = left, 0 = on the line. Same cross
    product as Vision One's ``get_side_of_line`` (sign-stable so the dashboard
    arrow and the runtime agree on what "in" means).
    """
    cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if cross > 0:
        return 1
    if cross < 0:
        return -1
    return 0


def segments_intersect(
    p1: Point,
    p2: Point,
    a: Point,
    b: Point,
    buffer: float = DEFAULT_SEGMENT_BUFFER,
) -> bool:
    """True when the movement segment p1→p2 crosses the counting segment a→b.

    The movement segment is extended by ``buffer`` at both ends (Vision One's
    ``check_line_intersection`` trick) so a step that ENDS exactly on the line
    is still caught on the next step. Parallel/degenerate pairs are False.
    """
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    length = math.hypot(dx, dy)
    if length > 0 and buffer > 0:
        ux, uy = dx / length, dy / length
        p1 = (p1[0] - ux * buffer, p1[1] - uy * buffer)
        p2 = (p2[0] + ux * buffer, p2[1] + uy * buffer)

    x1, y1 = a
    x2, y2 = b
    x3, y3 = p1
    x4, y4 = p2

    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-12:
        return False
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom
    return 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0


def crossing_direction(
    prev: Point,
    cur: Point,
    a: Point,
    b: Point,
    in_side: str,
    buffer: float = DEFAULT_SEGMENT_BUFFER,
) -> str | None:
    """'in' | 'out' | None for the movement prev→cur across the line a→b.

    A crossing needs BOTH a geometric intersection and a strict side change
    (Vision One required both — intersection alone misfires on tracks sliding
    along the line). ``in_side`` names which side is INSIDE; landing on it =
    'in', leaving it = 'out'. A point exactly ON the line defers to the next
    step.
    """
    if not segments_intersect(prev, cur, a, b, buffer):
        return None
    s_prev = side_of_line(prev, a, b)
    s_cur = side_of_line(cur, a, b)
    if s_prev == 0 or s_cur == 0 or s_prev == s_cur:
        return None
    inside = 1 if in_side == "right" else -1
    return "in" if s_cur == inside else "out"


def point_segment_distance(p: Point, a: Point, b: Point) -> float:
    """Perpendicular distance from p to the SEGMENT a→b (clamped projection).

    Port of Vision One's ``point_to_line_distance`` — used by the stale-track
    cleanup so tracks parked near the line are kept alive.
    """
    vx, vy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(vx, vy)
    if length == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (length * length)
    t = max(0.0, min(1.0, t))
    cx, cy = a[0] + t * vx, a[1] + t * vy
    return math.hypot(p[0] - cx, p[1] - cy)


def line_from_center(
    x: float, y: float, length: float, angle_deg: float
) -> tuple[Point, Point]:
    """Endpoints of a line drawn as center (x,y) + length + angle (degrees).

    The dashboard's line editor stores lines this way (see the Wave-2 counting
    schema `{x,y,length,angle,inside}`). a→b is centered on (x,y); at angle 0
    the line is horizontal (a left, b right).
    """
    half = length / 2.0
    rad = math.radians(angle_deg)
    dx, dy = math.cos(rad) * half, math.sin(rad) * half
    return (x - dx, y - dy), (x + dx, y + dy)


def resolve_in_side(a: Point, b: Point, inside_hint: str, delta: float = 0.05) -> str:
    """Map a compass-ish inside hint ('top'|'bottom'|'left'|'right') to the
    directed-line ``in_side`` ('right'|'left') for the line a→b.

    Robust for ANY line angle: it probes which side a reference point (just
    above/below/left/right of the line's midpoint) falls on. So flipping the
    arrow in the UI or drawing a diagonal line both resolve correctly without
    the operator reasoning about cross-product signs.
    """
    mx, my = (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0
    probes = {
        "top": (mx, my - delta),
        "bottom": (mx, my + delta),
        "left": (mx - delta, my),
        "right": (mx + delta, my),
    }
    probe = probes.get(inside_hint, probes["top"])
    side = side_of_line(probe, a, b)
    return "right" if side >= 0 else "left"


# ---------------------------------------------------------------------------
# Polygon membership (occupancy / crowd zones)
# ---------------------------------------------------------------------------

def point_in_polygon(px: float, py: float, polygon: Sequence[Point]) -> bool:
    """Ray-casting point-in-polygon test.

    Same inside/outside verdict as ``cv2.pointPolygonTest(poly, pt, False) >=
    0`` used in Vision One's zone processor (edges/vertices count as inside).
    A polygon with fewer than 3 vertices is empty (never contains a point).
    """
    n = len(polygon)
    if n < 3:
        return False

    # Boundary points count as inside (matches cv2's >= 0 semantics).
    for i in range(n):
        ax, ay = polygon[i]
        bx, by = polygon[(i + 1) % n]
        if _on_segment(px, py, ax, ay, bx, by):
            return True

    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > py) != (yj > py):
            x_cross = (xj - xi) * (py - yi) / (yj - yi) + xi
            if px < x_cross:
                inside = not inside
        j = i
    return inside


def _on_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> bool:
    """Is point (px,py) on the segment (ax,ay)→(bx,by) (small tolerance)?"""
    cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    if abs(cross) > 1e-9:
        return False
    if min(ax, bx) - 1e-9 <= px <= max(ax, bx) + 1e-9 and (
        min(ay, by) - 1e-9 <= py <= max(ay, by) + 1e-9
    ):
        return True
    return False


def bbox_anchor(bbox: Sequence[float], mode: str = "foot") -> Point:
    """Anchor of a normalized [x1,y1,x2,y2] bbox.

    ``foot`` = bottom-center (feet on the floor — stable for CCTV persons);
    ``center`` = box centroid (Vision One's zone test used the centroid). Both
    clamped into [0,1].
    """
    x1, y1, x2, y2 = (float(v) for v in bbox[:4])
    cx = (x1 + x2) / 2.0
    cy = y2 if mode == "foot" else (y1 + y2) / 2.0
    return (min(1.0, max(0.0, cx)), min(1.0, max(0.0, cy)))
