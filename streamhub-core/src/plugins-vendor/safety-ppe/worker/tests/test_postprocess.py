"""Pure YOLOv8 ONNX decode → NMS → role detections (no numpy/onnxruntime)."""
from safety_ppe_worker.geometry import letterbox_params, unletterbox_box
from safety_ppe_worker.postprocess import decode_rows, nms_per_class, to_detections

# 3-class toy model: [Person, Hardhat, Safety Vest]
NAMES = ["Person", "Hardhat", "Safety Vest"]


def row(cx, cy, w, h, scores):
    return [cx, cy, w, h, *scores]


def test_decode_rows_argmax_and_threshold():
    rows = [
        row(100, 100, 40, 80, [0.9, 0.05, 0.02]),   # person, keep
        row(200, 200, 20, 20, [0.10, 0.30, 0.02]),  # hardhat but < 0.5, drop
        row(300, 300, 30, 30, [0.05, 0.10, 0.75]),  # vest, keep
    ]
    dets = decode_rows(rows, 0.5)
    assert len(dets) == 2
    x1, y1, x2, y2, score, cid = dets[0]
    assert (x1, y1, x2, y2) == (80, 60, 120, 140)  # cxcywh → xyxy
    assert score == 0.9 and cid == 0.0
    assert dets[1][5] == 2.0


def test_decode_rows_ignores_short_rows():
    assert decode_rows([[1, 2, 3, 4]], 0.1) == []


def test_nms_per_class_keeps_best_of_overlaps_but_not_across_classes():
    a = [0, 0, 100, 100, 0.9, 0.0]
    a_dup = [5, 5, 105, 105, 0.6, 0.0]     # heavy overlap, same class → dropped
    b_same_box = [0, 0, 100, 100, 0.8, 1.0]  # same box, OTHER class → kept
    kept = nms_per_class([a, a_dup, b_same_box], iou_thresh=0.45)
    assert [d[5] for d in kept] == [0.0, 1.0]
    assert kept[0][4] == 0.9


def test_letterbox_roundtrip_maps_input_box_back_to_frame():
    # 1920×1080 frame letterboxed into 640×640: scale=1/3, pad_y=140.
    scale, pad_x, pad_y = letterbox_params(1920, 1080, 640, 640)
    assert abs(scale - 1 / 3) < 1e-9 and pad_x == 0 and pad_y == 140
    # A box at input (320, 320) center maps back to frame center.
    back = unletterbox_box([300, 300, 340, 340], scale, pad_x, pad_y, 1920, 1080)
    for got, want in zip(back, [900, 480, 1020, 600]):
        assert abs(got - want) < 1e-6


def test_unletterbox_clamps_padding_area_into_frame():
    scale, pad_x, pad_y = letterbox_params(1920, 1080, 640, 640)
    # A box inside the top padding band clamps to y=0.
    back = unletterbox_box([0, 0, 100, 130], scale, pad_x, pad_y, 1920, 1080)
    assert back[1] == 0.0 and back[3] == 0.0


def test_to_detections_maps_roles_and_normalizes():
    # Frame 1000×500 → 640×640 input: scale 0.64, pad_y = (640-320)/2 = 160.
    dets_in = [
        [0, 160, 640, 480, 0.9, 0.0],    # person covering the whole frame
        [320, 160, 480, 320, 0.8, 1.0],  # hardhat in the right-top quadrant
        [100, 200, 200, 300, 0.7, 99.0], # class id out of range → dropped
    ]
    out = to_detections(dets_in, NAMES, 1000.0, 500.0, 640.0, 640.0)
    assert [d["role"] for d in out] == ["person", "helmet"]
    person = out[0]
    assert person["class"] == "Person"
    assert person["bbox"] == [0.0, 0.0, 1.0, 1.0]
    helmet = out[1]
    assert helmet["bbox"] == [0.5, 0.0, 0.75, 0.5]
    assert helmet["conf"] == 0.8


def test_to_detections_drops_roleless_classes():
    names = ["Person", "Safety Cone"]
    dets_in = [[0, 0, 100, 100, 0.9, 1.0]]  # a cone
    assert to_detections(dets_in, names, 640, 640, 640, 640) == []


def test_to_detections_drops_degenerate_boxes():
    # Entirely inside the horizontal padding of a portrait frame → zero width.
    # Portrait 500×1000 → scale 0.64, pad_x = 160.
    dets_in = [[0, 0, 150, 300, 0.9, 0.0]]
    assert to_detections(dets_in, NAMES, 500.0, 1000.0, 640.0, 640.0) == []
