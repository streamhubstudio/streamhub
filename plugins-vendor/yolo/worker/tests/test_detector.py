from yolo_worker.detector import normalize_result


def test_normalize_filters_by_confidence():
    dets = normalize_result(
        boxes_xyxy=[[0, 0, 10, 10], [1, 1, 2, 2]],
        scores=[0.9, 0.1],
        class_ids=[0, 2],
        min_conf=0.5,
        keep_ids=None,
    )
    assert len(dets) == 1
    assert dets[0]["class"] == "person"
    assert dets[0]["conf"] == 0.9
    assert dets[0]["bbox"] == [0.0, 0.0, 10.0, 10.0]


def test_normalize_filters_by_class_ids():
    dets = normalize_result(
        boxes_xyxy=[[0, 0, 1, 1], [0, 0, 1, 1]],
        scores=[0.8, 0.8],
        class_ids=[0, 2],  # person, car
        min_conf=0.3,
        keep_ids={2},  # keep car only
    )
    assert [d["class"] for d in dets] == ["car"]


def test_normalize_empty_keep_ids_means_all():
    dets = normalize_result(
        boxes_xyxy=[[0, 0, 1, 1]],
        scores=[0.8],
        class_ids=[16],  # dog
        min_conf=0.3,
        keep_ids=None,
    )
    assert dets[0]["class"] == "dog"
