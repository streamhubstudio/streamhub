from yolo_worker.coco import (
    COCO_CLASSES,
    id_to_name,
    names_to_ids,
    parse_classes,
)


def test_there_are_80_classes_in_canonical_order():
    assert len(COCO_CLASSES) == 80
    assert COCO_CLASSES[0] == "person"
    assert COCO_CLASSES[2] == "car"
    assert COCO_CLASSES[-1] == "toothbrush"


def test_parse_classes_cleans_dedups_and_drops_unknown():
    assert parse_classes("person, Car ,person,unicorn") == ["person", "car"]
    assert parse_classes("") == []
    assert parse_classes(None) == []


def test_names_to_ids_sorted_and_filtered():
    assert names_to_ids(["car", "person", "unicorn"]) == [0, 2]


def test_id_to_name_roundtrip_and_out_of_range():
    assert id_to_name(0) == "person"
    assert id_to_name(999) == "class_999"
