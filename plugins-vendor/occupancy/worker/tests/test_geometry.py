"""Geometry — line crossing math + polygon membership + line helpers."""
from vision_edge.geometry import (
    bbox_anchor,
    crossing_direction,
    line_from_center,
    point_in_polygon,
    point_segment_distance,
    resolve_in_side,
    segments_intersect,
    side_of_line,
)

# A horizontal mid-line a→b (left to right).
A = (0.2, 0.5)
B = (0.8, 0.5)


def test_side_of_line_signs():
    assert side_of_line((0.5, 0.9), A, B) == 1   # below (y down) = right of a→b
    assert side_of_line((0.5, 0.1), A, B) == -1  # above = left
    assert side_of_line((0.5, 0.5), A, B) == 0   # on the line


def test_segments_intersect_true_and_false():
    assert segments_intersect((0.5, 0.4), (0.5, 0.6), A, B) is True
    assert segments_intersect((0.5, 0.4), (0.5, 0.45), A, B) is False  # doesn't reach
    assert segments_intersect((0.05, 0.4), (0.05, 0.6), A, B) is False  # left of segment


def test_segments_intersect_parallel_is_false():
    assert segments_intersect((0.2, 0.4), (0.8, 0.4), A, B) is False


def test_crossing_direction_in_and_out():
    # in_side='right' → landing below the line (y larger) is 'in'.
    assert crossing_direction((0.5, 0.4), (0.5, 0.6), A, B, "right") == "in"
    assert crossing_direction((0.5, 0.6), (0.5, 0.4), A, B, "right") == "out"


def test_crossing_direction_inside_flip():
    assert crossing_direction((0.5, 0.4), (0.5, 0.6), A, B, "left") == "out"
    assert crossing_direction((0.5, 0.6), (0.5, 0.4), A, B, "left") == "in"


def test_crossing_direction_slide_along_line_is_none():
    # Movement that intersects but ends ON the line defers (side 0).
    assert crossing_direction((0.5, 0.4), (0.5, 0.5), A, B, "right") is None


def test_crossing_direction_no_touch_is_none():
    assert crossing_direction((0.5, 0.3), (0.5, 0.45), A, B, "right") is None


def test_point_segment_distance_perpendicular_and_endpoint():
    assert abs(point_segment_distance((0.5, 0.6), A, B) - 0.1) < 1e-9
    # Beyond the segment end → distance to the endpoint.
    d = point_segment_distance((1.0, 0.5), A, B)
    assert abs(d - 0.2) < 1e-9


def test_line_from_center_horizontal():
    a, b = line_from_center(0.5, 0.5, 0.6, 0.0)
    assert abs(a[0] - 0.2) < 1e-9 and abs(b[0] - 0.8) < 1e-9
    assert abs(a[1] - 0.5) < 1e-9 and abs(b[1] - 0.5) < 1e-9


def test_line_from_center_vertical():
    a, b = line_from_center(0.5, 0.5, 0.4, 90.0)
    assert abs(a[0] - 0.5) < 1e-9 and abs(b[0] - 0.5) < 1e-9
    assert abs(a[1] - 0.3) < 1e-9 and abs(b[1] - 0.7) < 1e-9


def test_resolve_in_side_maps_hints():
    a, b = line_from_center(0.5, 0.5, 0.6, 0.0)  # horizontal
    # 'bottom' (y larger) is the right side of a→b (y down) → 'right'.
    assert resolve_in_side(a, b, "bottom") == "right"
    assert resolve_in_side(a, b, "top") == "left"


def test_resolve_in_side_diagonal_is_consistent():
    a, b = line_from_center(0.5, 0.5, 0.6, 45.0)
    left = resolve_in_side(a, b, "left")
    right = resolve_in_side(a, b, "right")
    assert {left, right} == {"left", "right"}  # opposite hints resolve opposite


def test_point_in_polygon_square():
    sq = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
    assert point_in_polygon(0.5, 0.5, sq) is True
    assert point_in_polygon(0.1, 0.1, sq) is False
    assert point_in_polygon(0.9, 0.5, sq) is False


def test_point_in_polygon_boundary_inside():
    sq = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
    assert point_in_polygon(0.2, 0.5, sq) is True  # on the left edge


def test_point_in_polygon_concave():
    # An L-shape whose top-left is notched out (x<0.3 & y>0.3 is excluded).
    poly = [(0.0, 0.0), (0.6, 0.0), (0.6, 0.6), (0.3, 0.6), (0.3, 0.3), (0.0, 0.3)]
    assert point_in_polygon(0.1, 0.1, poly) is True    # in the filled base
    assert point_in_polygon(0.45, 0.45, poly) is True  # right arm is filled
    assert point_in_polygon(0.15, 0.45, poly) is False  # in the notch


def test_point_in_polygon_degenerate():
    assert point_in_polygon(0.5, 0.5, [(0.0, 0.0), (1.0, 1.0)]) is False  # <3 verts


def test_bbox_anchor_foot_and_center():
    box = [0.4, 0.2, 0.6, 0.8]  # x1,y1,x2,y2
    assert bbox_anchor(box, "foot") == (0.5, 0.8)
    assert bbox_anchor(box, "center") == (0.5, 0.5)


def test_bbox_anchor_clamps():
    box = [-0.2, -0.2, 1.4, 1.4]
    ax, ay = bbox_anchor(box, "foot")
    assert 0.0 <= ax <= 1.0 and 0.0 <= ay <= 1.0
