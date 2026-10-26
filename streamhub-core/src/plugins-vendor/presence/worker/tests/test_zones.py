"""Zone geometry: parsing tolerance, anchor points, point-in-zone occupancy."""
import json

from presence_worker.zones import (
    Zone,
    anchor_point,
    count_occupancy,
    parse_zones,
    zone_contains,
)


def test_parse_zones_happy_path():
    raw = json.dumps(
        [
            {"id": "desk-1", "name": "Front desk", "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4},
            {"id": "door", "x": 0, "y": 0, "w": 0.2, "h": 0.2},
        ]
    )
    zones = parse_zones(raw)
    assert [z.id for z in zones] == ["desk-1", "door"]
    assert zones[0].name == "Front desk"
    assert zones[1].name == "door"  # name defaults to id
    assert zones[0] == Zone("desk-1", "Front desk", 0.1, 0.2, 0.3, 0.4)


def test_parse_zones_tolerates_garbage():
    assert parse_zones(None) == []
    assert parse_zones("") == []
    assert parse_zones("not json") == []
    assert parse_zones('{"id":"x"}') == []  # not a list
    # entries without id / with non-numeric coords are skipped
    raw = json.dumps(
        [
            {"name": "no id", "x": 0, "y": 0, "w": 1, "h": 1},
            {"id": "", "x": 0, "y": 0, "w": 1, "h": 1},
            {"id": "bad", "x": "a", "y": 0, "w": 1, "h": 1},
            "a string",
            {"id": "ok", "x": 0.5, "y": 0.5, "w": 0.25, "h": 0.25},
        ]
    )
    assert [z.id for z in parse_zones(raw)] == ["ok"]


def test_parse_zones_clamps_into_frame_and_skips_zero_area():
    raw = json.dumps(
        [
            {"id": "overflow", "x": 0.8, "y": 0.9, "w": 0.9, "h": 0.9},
            {"id": "negative", "x": -0.5, "y": -0.5, "w": 0.5, "h": 0.5},
            {"id": "flat", "x": 0.2, "y": 0.2, "w": 0.0, "h": 0.5},
            {"id": "outside", "x": 1.0, "y": 0.0, "w": 0.4, "h": 0.4},
        ]
    )
    zones = {z.id: z for z in parse_zones(raw)}
    assert set(zones) == {"overflow", "negative"}
    ov = zones["overflow"]
    assert (ov.x, ov.y) == (0.8, 0.9)
    assert abs(ov.x + ov.w - 1.0) < 1e-9 and abs(ov.y + ov.h - 1.0) < 1e-9
    neg = zones["negative"]
    assert (neg.x, neg.y) == (0.0, 0.0)
    assert (neg.w, neg.h) == (0.5, 0.5)


def test_parse_zones_dedupes_ids_first_wins():
    raw = json.dumps(
        [
            {"id": "z", "name": "first", "x": 0, "y": 0, "w": 0.5, "h": 0.5},
            {"id": "z", "name": "second", "x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5},
        ]
    )
    zones = parse_zones(raw)
    assert len(zones) == 1
    assert zones[0].name == "first"


def test_anchor_point_is_bottom_center_clamped():
    px, py = anchor_point([0.2, 0.1, 0.2, 0.3])
    assert abs(px - 0.3) < 1e-9 and abs(py - 0.4) < 1e-9
    # feet below the frame clamp to 1.0
    px, py = anchor_point([0.4, 0.8, 0.2, 0.5])
    assert abs(px - 0.5) < 1e-9 and py == 1.0


def test_zone_contains_edges_inclusive():
    z = Zone("z", "z", 0.25, 0.25, 0.5, 0.5)
    assert zone_contains(z, 0.25, 0.25)
    assert zone_contains(z, 0.75, 0.75)
    assert zone_contains(z, 0.5, 0.5)
    assert not zone_contains(z, 0.24, 0.5)
    assert not zone_contains(z, 0.5, 0.76)


def test_count_occupancy_multiple_zones_and_overlap():
    zones = [
        Zone("left", "left", 0.0, 0.0, 0.5, 1.0),
        Zone("right", "right", 0.5, 0.0, 0.5, 1.0),
        Zone("all", "all", 0.0, 0.0, 1.0, 1.0),
    ]
    boxes = [
        {"bbox": [0.1, 0.1, 0.1, 0.3], "conf": 0.9},  # anchor (0.15, 0.4) → left
        {"bbox": [0.7, 0.2, 0.1, 0.3]},               # anchor (0.75, 0.5) → right
        [0.65, 0.5, 0.1, 0.2],                        # bare bbox → right
    ]
    counts = count_occupancy(zones, boxes)
    assert counts == {"left": 1, "right": 2, "all": 3}


def test_count_occupancy_empty_and_malformed_boxes():
    zones = [Zone("z", "z", 0.0, 0.0, 1.0, 1.0)]
    assert count_occupancy(zones, []) == {"z": 0}
    assert count_occupancy(zones, [{"nope": 1}, "junk", {"bbox": None}]) == {"z": 0}
