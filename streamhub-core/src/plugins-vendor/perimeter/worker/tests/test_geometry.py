import json

from perimeter_worker.geometry import (
    anchor_point,
    normalize_box,
    parse_zones,
    persons_to_payload,
    point_in_polygon,
    rect_to_points,
    slugify_zone,
    zones_hit,
)

SQUARE = [(0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.25, 0.75)]
TRIANGLE = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]


def test_point_in_polygon_square():
    assert point_in_polygon((0.5, 0.5), SQUARE) is True
    assert point_in_polygon((0.1, 0.5), SQUARE) is False
    assert point_in_polygon((0.5, 0.9), SQUARE) is False
    assert point_in_polygon((0.9, 0.9), SQUARE) is False


def test_point_in_polygon_non_convex_triangle():
    assert point_in_polygon((0.2, 0.2), TRIANGLE) is True
    assert point_in_polygon((0.8, 0.8), TRIANGLE) is False
    # fewer than 3 points can never contain anything
    assert point_in_polygon((0.5, 0.5), [(0, 0), (1, 1)]) is False


def test_rect_to_points_clamps_and_rejects_degenerate():
    assert rect_to_points([0.1, 0.2, 0.3, 0.4]) == [
        (0.1, 0.2),
        (0.4, 0.2),
        (0.4, 0.6),
        (0.1, 0.6),
    ]
    # overflow is clamped into 0-1
    assert rect_to_points([0.8, 0.8, 0.5, 0.5]) == [
        (0.8, 0.8),
        (1.0, 0.8),
        (1.0, 1.0),
        (0.8, 1.0),
    ]
    assert rect_to_points([0.5, 0.5, 0.0, 0.2]) is None
    assert rect_to_points([1.0, 1.0, 0.2, 0.2]) is None  # fully out of frame
    assert rect_to_points([0.1, 0.2, 0.3]) is None


def test_parse_zones_accepts_rects_and_polygons_and_ids():
    raw = json.dumps(
        [
            {"id": "gate", "rect": [0.0, 0.5, 0.5, 0.5]},
            {"points": [[0, 0], [1, 0], [0.5, 1]]},  # no id → zone-2
            {"id": "  ", "rect": [0.2, 0.2, 0.1, 0.1]},  # blank id → zone-3
        ]
    )
    zones = parse_zones(raw)
    assert [z["id"] for z in zones] == ["gate", "zone-2", "zone-3"]
    assert zones[0]["points"][0] == (0.0, 0.5)
    assert len(zones[1]["points"]) == 3


def test_parse_zones_drops_garbage_without_raising():
    assert parse_zones(None) == []
    assert parse_zones("") == []
    assert parse_zones("not json") == []
    assert parse_zones('{"id":"x"}') == []  # not a list
    bad_entries = json.dumps(
        [
            "nope",
            {"id": "two-points", "points": [[0, 0], [1, 1]]},
            {"id": "bad-coord", "points": [[0, 0], [1, "x"], [1, 1]]},
            {"id": "bad-rect", "rect": [0.5, 0.5, -0.1, 0.2]},
        ]
    )
    assert parse_zones(bad_entries) == []


def test_anchor_point_foot_and_center():
    bbox = [0.4, 0.2, 0.2, 0.6]  # x, y, w, h
    assert anchor_point(bbox, "foot") == (0.5, 0.8)
    assert anchor_point(bbox, "center") == (0.5, 0.5)
    # unknown anchor falls back to foot; foot is clamped into the frame
    assert anchor_point(bbox, "bogus") == (0.5, 0.8)
    assert anchor_point([0.4, 0.8, 0.2, 0.5], "foot") == (0.5, 1.0)


def test_normalize_and_persons_payload():
    assert normalize_box([160, 90, 480, 360], 640, 360) == [0.25, 0.25, 0.5, 0.75]
    persons = persons_to_payload(
        [[160, 90, 480, 360, 0.87654], [10, 10, 10, 40, 0.9]],  # 2nd is degenerate
        640,
        360,
    )
    assert persons == [{"bbox": [0.25, 0.25, 0.5, 0.75], "conf": 0.8765}]
    assert persons_to_payload([[0, 0, 10, 10, 0.5]], 0, 0) == []


def test_zones_hit_uses_foot_anchor_and_max_conf():
    zones = parse_zones(
        json.dumps(
            [
                {"id": "floor", "rect": [0.0, 0.5, 1.0, 0.5]},  # bottom half
                {"id": "shelf", "rect": [0.0, 0.0, 0.2, 0.2]},  # top-left corner
            ]
        )
    )
    # Person whose HEAD is top-left but whose FEET are bottom-center: only the
    # floor zone (foot anchor) trips, not the shelf the bbox overlaps.
    persons = [
        {"bbox": [0.1, 0.1, 0.3, 0.8], "conf": 0.6},
        {"bbox": [0.4, 0.3, 0.2, 0.6], "conf": 0.9},
    ]
    assert zones_hit(persons, zones, "foot") == [("floor", 0.9)]
    assert zones_hit(persons, zones, "center") == [("floor", 0.9)]
    assert zones_hit([], zones, "foot") == []
    assert zones_hit(persons, [], "foot") == []


def test_slugify_zone():
    assert slugify_zone("Front Gate #1") == "front-gate-1"
    assert slugify_zone("  ") == "zone"
    assert slugify_zone("ok_id-9") == "ok_id-9"
