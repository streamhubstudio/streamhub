"""Polygon zones — parsing, membership, class filtering, counting, POIs."""
from vision_edge.zones import (
    NamedPolygon,
    PolygonZone,
    count_all_zones,
    count_in_zone,
    detect_kind_matches,
    parse_points,
    parse_pois,
    parse_zones,
    poi_for_anchor,
)

SQUARE = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
LEFT = [[0.0, 0.0], [0.4, 0.0], [0.4, 1.0], [0.0, 1.0]]
RIGHT = [[0.6, 0.0], [1.0, 0.0], [1.0, 1.0], [0.6, 1.0]]


def _cfg(**over):
    base = {"id": "z1", "tag": "front", "detect": "personas", "points": SQUARE}
    base.update(over)
    return {"zones": [base]}


def test_parse_points_valid_and_clamped():
    pts = parse_points([[1.4, -0.2], [0.8, 0.2], [0.5, 0.9]])
    assert pts == ((1.0, 0.0), (0.8, 0.2), (0.5, 0.9))


def test_parse_points_too_few_is_empty():
    assert parse_points([[0.1, 0.1], [0.2, 0.2]]) == ()
    assert parse_points("nope") == ()


def test_parse_zones_basic():
    zones = parse_zones(_cfg())
    assert len(zones) == 1
    z = zones[0]
    assert z.id == "z1" and z.tag == "front" and z.detect == "personas"
    assert z.classes == frozenset({"person"})


def test_parse_zones_defaults_tag_to_id_and_kind():
    zones = parse_zones({"zones": [{"id": "z9", "points": SQUARE, "detect": "bogus"}]})
    assert zones[0].tag == "z9"
    assert zones[0].detect == "personas"  # invalid kind falls back


def test_parse_zones_vehicle_classes():
    zones = parse_zones(_cfg(detect="vehiculos"))
    assert zones[0].classes == frozenset({"car", "truck", "bus", "motorcycle"})
    assert zones[0].class_ids == (2, 7, 5, 3)


def test_parse_zones_skips_bad_and_dedupes():
    cfg = {
        "zones": [
            {"id": "", "points": SQUARE},                 # empty id
            {"id": "dup", "points": SQUARE},
            {"id": "dup", "points": SQUARE, "tag": "x"},  # duplicate id ignored
            {"id": "noverts", "points": [[0.1, 0.1]]},    # too few points
        ]
    }
    zones = parse_zones(cfg)
    assert [z.id for z in zones] == ["dup"]


def test_parse_zones_accepts_bare_list():
    zones = parse_zones([{"id": "z1", "points": SQUARE}])
    assert len(zones) == 1


def test_parse_zones_alert_fields():
    zones = parse_zones(_cfg(alertLimit=3, alertAfterSec=30, confidence=0.6))
    z = zones[0]
    assert z.alert_limit == 3 and z.alert_after_sec == 30.0 and z.confidence == 0.6


def test_detect_kind_matches():
    z = parse_zones(_cfg())[0]
    assert detect_kind_matches(z, "person") is True
    assert detect_kind_matches(z, "car") is False
    assert detect_kind_matches(z, None) is False


def test_count_in_zone_person_inside_and_outside():
    z = parse_zones(_cfg())[0]
    dets = [
        {"bbox": [0.45, 0.4, 0.55, 0.7], "cls": "person", "conf": 0.9},   # foot (0.5,0.7) inside
        {"bbox": [0.85, 0.85, 0.95, 0.95], "cls": "person", "conf": 0.9}, # outside
        {"bbox": [0.45, 0.4, 0.55, 0.7], "cls": "car", "conf": 0.9},      # wrong class
    ]
    assert count_in_zone(z, dets) == 1


def test_count_in_zone_confidence_filter():
    z = parse_zones(_cfg(confidence=0.5))[0]
    dets = [{"bbox": [0.45, 0.4, 0.55, 0.7], "cls": "person", "conf": 0.3}]
    assert count_in_zone(z, dets) == 0


def test_count_in_zone_center_anchor():
    z = parse_zones(_cfg())[0]
    # A tall box whose foot is below the zone but whose center is inside.
    det = {"bbox": [0.45, 0.4, 0.55, 0.95], "cls": "person", "conf": 0.9}
    assert count_in_zone(z, [det], mode="foot") == 0
    assert count_in_zone(z, [det], mode="center") == 1


def test_count_all_zones():
    cfg = {
        "zones": [
            {"id": "a", "points": SQUARE, "detect": "personas"},
            {"id": "b", "points": [[0.0, 0.0], [0.1, 0.0], [0.1, 0.1]], "detect": "personas"},
        ]
    }
    zones = parse_zones(cfg)
    dets = [{"bbox": [0.45, 0.4, 0.55, 0.7], "cls": "person", "conf": 0.9}]
    counts = count_all_zones(zones, dets)
    assert counts == {"a": 1, "b": 0}


# --- POIs (generic tagged polygon regions, owner item 34) -------------------

def test_parse_pois_basic_and_tag_defaults_to_id():
    pois = parse_pois({"pois": [{"id": "door", "tag": "entrance", "points": SQUARE},
                                {"id": "till", "points": RIGHT}]})
    assert [p.id for p in pois] == ["door", "till"]
    assert pois[0].tag == "entrance" and pois[0].name == "entrance"
    assert pois[1].tag == "till" and pois[1].name == "till"  # tag defaults to id


def test_parse_pois_autofills_id_and_dedupes():
    pois = parse_pois({"pois": [{"points": SQUARE}, {"id": "z", "points": RIGHT},
                                {"id": "z", "points": LEFT}]})
    assert [p.id for p in pois] == ["poi0", "z"]  # auto-id + duplicate 'z' dropped


def test_parse_pois_skips_bad_and_accepts_bare_list():
    assert parse_pois({"pois": "nope"}) == []
    assert parse_pois({"pois": [{"id": "x", "points": [[0.1, 0.1]]}]}) == []  # <3 pts
    bare = parse_pois([{"id": "a", "points": SQUARE}])
    assert len(bare) == 1 and bare[0].id == "a"
    assert parse_pois({}) == []  # no POIs configured = whole frame


def test_poi_for_anchor_first_match_and_none():
    pois = [NamedPolygon("L", "left", tuple(map(tuple, LEFT))),
            NamedPolygon("R", "right", tuple(map(tuple, RIGHT)))]
    # foot (0.2, 0.9) is in the LEFT poi.
    assert poi_for_anchor(pois, [0.15, 0.5, 0.25, 0.9]).id == "L"
    # foot (0.8, 0.9) is in the RIGHT poi.
    assert poi_for_anchor(pois, [0.75, 0.5, 0.85, 0.9]).id == "R"
    # foot (0.5, 0.9) is in the GAP between them → None (gated out).
    assert poi_for_anchor(pois, [0.45, 0.5, 0.55, 0.9]) is None


def test_poi_for_anchor_center_mode():
    pois = [NamedPolygon("C", "center", tuple(map(tuple, SQUARE)))]
    # A tall box: foot below the square, center inside it.
    det = [0.45, 0.4, 0.55, 0.95]
    assert poi_for_anchor(pois, det, mode="foot") is None
    assert poi_for_anchor(pois, det, mode="center").id == "C"
