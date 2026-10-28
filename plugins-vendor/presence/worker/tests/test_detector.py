"""Pure detection-normalization logic (no torch/ultralytics import)."""
from presence_worker.detector import PERSON_CLASS_ID, normalize_person_boxes


def test_keeps_only_confident_persons_normalized():
    boxes = [
        [100, 200, 300, 600],   # person, conf .9
        [0, 0, 50, 50],         # person, conf .2 (below threshold)
        [10, 10, 90, 90],       # class 2 (car)
    ]
    scores = [0.9, 0.2, 0.99]
    classes = [PERSON_CLASS_ID, PERSON_CLASS_ID, 2]
    out = normalize_person_boxes(boxes, scores, classes, 0.35, 1000.0, 1000.0)
    assert len(out) == 1
    assert out[0]["bbox"] == [0.1, 0.2, 0.2, 0.4]
    assert out[0]["conf"] == 0.9


def test_clamps_boxes_into_frame_and_skips_degenerate():
    boxes = [
        [-50, -50, 500, 500],   # spills out of frame → clamped
        [200, 200, 200, 400],   # zero width → skipped
    ]
    scores = [0.8, 0.8]
    classes = [0, 0]
    out = normalize_person_boxes(boxes, scores, classes, 0.5, 1000.0, 1000.0)
    assert len(out) == 1
    assert out[0]["bbox"] == [0.0, 0.0, 0.5, 0.5]


def test_zero_sized_frame_returns_nothing():
    assert normalize_person_boxes([[0, 0, 1, 1]], [0.9], [0], 0.1, 0.0, 100.0) == []
