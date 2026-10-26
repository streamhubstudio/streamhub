"""Zone parsing + anchor-point membership."""
from safety_ppe_worker.zones import (
    Zone,
    anchor_point,
    full_frame_zone,
    parse_zones,
    zones_containing,
)


def test_parse_valid_zones():
    zones = parse_zones(
        '[{"name":"dock","rect":[0.1,0.2,0.3,0.4]},'
        ' {"name":"gate","rect":[0.6,0.0,0.4,1.0]}]'
    )
    assert zones == [
        Zone("dock", (0.1, 0.2, 0.3, 0.4)),
        Zone("gate", (0.6, 0.0, 0.4, 1.0)),
    ]


def test_parse_empty_or_malformed_falls_back_to_full_frame():
    for raw in (None, "", "   ", "not json", "{}", "[{}]", '[{"name":""}]', "[1,2]"):
        assert parse_zones(raw) == [full_frame_zone()]


def test_parse_clamps_out_of_range_rects():
    zones = parse_zones('[{"name":"z","rect":[-0.2,0.5,2.0,0.9]}]')
    # x clamped to 0, w clamped to fit, h clamped so y+h <= 1.
    assert zones == [Zone("z", (0.0, 0.5, 1.0, 0.5))]


def test_parse_drops_zero_area_and_duplicate_names():
    zones = parse_zones(
        '[{"name":"line","rect":[0.5,0.0,0.0,1.0]},'
        ' {"name":"a","rect":[0,0,0.5,0.5]},'
        ' {"name":"a","rect":[0.5,0.5,0.5,0.5]}]'
    )
    assert zones == [Zone("a", (0.0, 0.0, 0.5, 0.5))]


def test_anchor_is_bottom_center():
    ax, ay = anchor_point([0.2, 0.1, 0.4, 0.8])
    assert abs(ax - 0.3) < 1e-9 and ay == 0.8


def test_zones_containing_uses_feet_not_center():
    # Person spans the top half but STANDS at y=0.5 → only the bottom-edge
    # zone that includes y=0.5 contains them.
    zones = [Zone("top", (0.0, 0.0, 1.0, 0.4)), Zone("mid", (0.0, 0.4, 1.0, 0.3))]
    assert zones_containing([0.4, 0.0, 0.6, 0.5], zones) == ["mid"]


def test_zones_can_overlap_person_in_both():
    zones = [Zone("a", (0.0, 0.0, 1.0, 1.0)), Zone("b", (0.4, 0.4, 0.6, 0.6))]
    assert zones_containing([0.4, 0.2, 0.6, 0.8], zones) == ["a", "b"]
