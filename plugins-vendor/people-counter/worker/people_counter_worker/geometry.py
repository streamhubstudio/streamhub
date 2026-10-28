"""
Line-crossing geometry — pure functions over NORMALIZED [0,1] coordinates.

PROVENANCE: ported from Vision One's production people-counting model
(streamhub-vision-one repo: vision_one/models/people_counting/counting.py,
class ``LineCrossingCounter`` — itself a faithful copy of the validated
storehub-people-counting counter). The cross-product side test, the buffered
segment-intersection check and the side-based IN/OUT resolution are the same
math, re-expressed over normalized coordinates so the worker is
resolution-independent (Vision One worked in pixels of a fixed frame).

Coordinate convention (screen coords, y DOWN — matches both video frames and
the dashboard line editor):
  - the counting line is DIRECTED a→b (the two points the operator drew);
  - ``side_of_line`` returns +1 for the RIGHT side of a→b, -1 for the LEFT
    (right = where your right hand points walking from a to b with y down);
  - ``in_side`` ('right' | 'left') says which side is INSIDE: finishing a
    crossing on that side counts as 'in', the opposite move as 'out'.
    Flipping the arrow in the UI = swapping in_side (no line change needed).
"""
from __future__ import annotations

import math

Point = tuple[float, float]

# Vision One extended the movement segment by a 5 px buffer on ~1280 px frames
# so a track that lands exactly on the line still registers; normalized
# equivalent (5/1280 ≈ 0.004).
DEFAULT_SEGMENT_BUFFER = 0.004


def side_of_line(p: Point, a: Point, b: Point) -> int:
    """Which side of the directed line a→b the point is on.

    +1 = right side (screen coords, y down), -1 = left side, 0 = on the line.
    Same cross product as Vision One's ``get_side_of_line`` (kept sign-stable
    so the dashboard arrow and the worker agree on what "in" means).
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
    (Vision One required both too — intersection alone misfires on tracks
    sliding along the line). ``in_side`` ('right'|'left') is which side of
    a→b is INSIDE; landing on it = 'in', leaving it = 'out'. A point exactly
    ON the line (side 0) defers the decision to the next step.
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
