"""Person↔PPE association — the core violation logic (pure, no ML deps)."""
from safety_ppe_worker.association import (
    analyze_frame,
    best_associated_conf,
    person_status,
)
from safety_ppe_worker.geometry import containment, expand_box, iou
from safety_ppe_worker.zones import Zone, full_frame_zone


def det(role, bbox, conf=0.9):
    return {"role": role, "class": role, "conf": conf, "bbox": list(bbox)}


# A person occupying the left-middle of the frame, head at the top of the box.
PERSON = det("person", [0.10, 0.20, 0.30, 0.90], conf=0.88)
# A helmet sitting fully inside the person's upper box.
HELMET_ON = det("helmet", [0.15, 0.20, 0.25, 0.28], conf=0.8)
# A vest on the torso.
VEST_ON = det("vest", [0.12, 0.40, 0.28, 0.65], conf=0.75)
# A helmet lying on the ground far from the person.
HELMET_GROUND = det("helmet", [0.70, 0.80, 0.80, 0.88], conf=0.9)


# ---------------------------------------------------------------------------
# geometry: containment vs IoU
# ---------------------------------------------------------------------------

def test_containment_full_inside_is_one_but_iou_is_small():
    # The whole point of using containment: a worn helmet has ~1.0 containment
    # in the person box while its IoU with the person is tiny.
    assert containment(HELMET_ON["bbox"], PERSON["bbox"]) == 1.0
    assert iou(HELMET_ON["bbox"], PERSON["bbox"]) < 0.1


def test_containment_is_fraction_of_inner_area():
    inner = [0.0, 0.0, 0.2, 0.2]
    outer = [0.1, 0.0, 1.0, 1.0]  # right half of inner inside outer
    assert abs(containment(inner, outer) - 0.5) < 1e-9


def test_containment_disjoint_and_degenerate():
    assert containment([0.7, 0.7, 0.9, 0.9], [0.0, 0.0, 0.5, 0.5]) == 0.0
    assert containment([0.5, 0.5, 0.5, 0.5], [0.0, 0.0, 1.0, 1.0]) == 0.0  # zero area


def test_expand_box_margin():
    got = expand_box([0.2, 0.2, 0.4, 0.6], 0.1)
    want = [0.18, 0.16, 0.42, 0.64]
    assert all(abs(g - w) < 1e-9 for g, w in zip(got, want))
    assert expand_box([0.2, 0.2, 0.4, 0.6], 0.0) == [0.2, 0.2, 0.4, 0.6]


# ---------------------------------------------------------------------------
# association
# ---------------------------------------------------------------------------

def test_best_associated_conf_picks_contained_item():
    conf = best_associated_conf(PERSON["bbox"], [HELMET_ON], 0.5, 0.1)
    assert conf == 0.8


def test_best_associated_conf_ignores_far_item():
    # A helmet on the ground must NOT count as worn.
    conf = best_associated_conf(PERSON["bbox"], [HELMET_GROUND], 0.5, 0.1)
    assert conf == 0.0


def test_margin_rescues_helmet_poking_above_person_box():
    # Helmet slightly above the person box top: half in, half out.
    poking = det("helmet", [0.15, 0.16, 0.25, 0.24], conf=0.7)
    assert best_associated_conf(PERSON["bbox"], [poking], 0.6, 0.0) == 0.0
    assert best_associated_conf(PERSON["bbox"], [poking], 0.6, 0.1) == 0.7


def test_person_fully_equipped_has_nothing_missing():
    status = person_status(PERSON, [PERSON, HELMET_ON, VEST_ON], ["helmet", "vest"])
    assert status["missing"] == set()
    assert status["confidence"] == 0.88


def test_person_without_any_helmet_detection_is_missing_helmet():
    # Absence counts as missing (errs on the safe side).
    status = person_status(PERSON, [PERSON, VEST_ON], ["helmet", "vest"])
    assert status["missing"] == {"helmet"}


def test_explicit_negative_class_beats_weaker_positive():
    no_helmet = det("no_helmet", [0.15, 0.20, 0.25, 0.28], conf=0.9)
    weak_helmet = det("helmet", [0.15, 0.20, 0.25, 0.28], conf=0.3)
    status = person_status(
        PERSON, [PERSON, no_helmet, weak_helmet], ["helmet"]
    )
    assert status["missing"] == {"helmet"}


def test_stronger_positive_beats_negative():
    no_helmet = det("no_helmet", [0.15, 0.20, 0.25, 0.28], conf=0.4)
    strong_helmet = det("helmet", [0.15, 0.20, 0.25, 0.28], conf=0.85)
    status = person_status(
        PERSON, [PERSON, no_helmet, strong_helmet], ["helmet"]
    )
    assert status["missing"] == set()


def test_only_required_items_are_checked():
    status = person_status(PERSON, [PERSON], ["vest"])
    assert status["missing"] == {"vest"}  # helmet absence irrelevant


def test_unknown_required_items_are_ignored():
    status = person_status(PERSON, [PERSON, HELMET_ON, VEST_ON], ["helmet", "gloves"])
    assert status["missing"] == set()


# ---------------------------------------------------------------------------
# analyze_frame (zones × persons)
# ---------------------------------------------------------------------------

def test_analyze_frame_reports_offender_in_full_frame_zone():
    report = analyze_frame(
        [PERSON, VEST_ON], [full_frame_zone()], ["helmet", "vest"]
    )
    entry = report["all"]
    assert entry["persons"] == 1
    assert entry["missing"] == {"helmet"}
    assert entry["confidence"] == 0.88
    assert entry["offenders"] == [
        {"bbox": PERSON["bbox"], "missing": ["helmet"], "confidence": 0.88}
    ]


def test_analyze_frame_every_zone_reported_even_when_clean():
    zones = [Zone("left", (0.0, 0.0, 0.5, 1.0)), Zone("right", (0.5, 0.0, 0.5, 1.0))]
    report = analyze_frame([PERSON, HELMET_ON, VEST_ON], zones, ["helmet", "vest"])
    # Person's feet anchor at x=0.2 → "left" zone only; both zones present.
    assert set(report) == {"left", "right"}
    assert report["left"]["persons"] == 1
    assert report["left"]["missing"] == set()
    assert report["right"]["persons"] == 0
    assert report["right"]["missing"] == set()


def test_analyze_frame_person_outside_all_zones_is_ignored():
    zones = [Zone("corner", (0.8, 0.8, 0.2, 0.2))]
    report = analyze_frame([PERSON], zones, ["helmet"])
    assert report["corner"]["persons"] == 0
    assert report["corner"]["missing"] == set()


def test_analyze_frame_unions_missing_and_takes_max_conf():
    p2 = det("person", [0.35, 0.20, 0.55, 0.90], conf=0.95)  # missing both
    dets = [PERSON, VEST_ON, p2]  # PERSON misses helmet; p2 misses helmet+vest
    report = analyze_frame(dets, [full_frame_zone()], ["helmet", "vest"])
    entry = report["all"]
    assert entry["persons"] == 2
    assert entry["missing"] == {"helmet", "vest"}
    assert entry["confidence"] == 0.95
    assert len(entry["offenders"]) == 2


def test_analyze_frame_no_required_items_is_always_clean():
    report = analyze_frame([PERSON], [full_frame_zone()], [])
    assert report["all"]["missing"] == set()
    assert report["all"]["offenders"] == []


def test_ppe_items_of_one_person_do_not_dress_another():
    # Equipped person on the left, bare person on the right — the right one
    # must still be flagged even though helmets exist in the frame.
    bare = det("person", [0.60, 0.20, 0.80, 0.90], conf=0.9)
    dets = [PERSON, HELMET_ON, VEST_ON, bare]
    report = analyze_frame(dets, [full_frame_zone()], ["helmet", "vest"])
    entry = report["all"]
    assert entry["missing"] == {"helmet", "vest"}
    assert [o["bbox"] for o in entry["offenders"]] == [bare["bbox"]]
