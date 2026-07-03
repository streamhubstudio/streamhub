import pytest

from deface_worker.geometry import (
    clamp_box,
    expand_box,
    faces_to_payload,
    fit_to_stride,
    iou,
    nms,
    normalize_box,
    parse_scale,
)


# --- parse_scale -------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("640x360", (640, 360)),
        (" 1280X720 ", (1280, 720)),
        ("640×360", (640, 360)),  # unicode ×
        ("", None),
        (None, None),
        ("wide", None),
        ("640", None),
        ("640x", None),
        ("0x360", None),
        ("-640x360", None),
        ("640x360x2", None),
    ],
)
def test_parse_scale(raw, expected):
    assert parse_scale(raw) == expected


# --- fit_to_stride -----------------------------------------------------------

def test_fit_to_stride_rounds_up_to_multiples_of_32():
    assert fit_to_stride(640, 360) == (640, 384)
    assert fit_to_stride(1, 1) == (32, 32)
    assert fit_to_stride(32, 64) == (32, 64)
    assert fit_to_stride(33, 65) == (64, 96)


# --- expand_box (deface scale_bb semantics) -----------------------------------

def test_expand_box_matches_deface_scale_bb():
    # mask_scale 1.3 → each side moves out by 0.3 × that dimension.
    box = [100.0, 200.0, 200.0, 400.0]  # w=100, h=200
    assert expand_box(box, 1.3) == [70.0, 140.0, 230.0, 460.0]
    # mask_scale 1.0 → unchanged; < 1 is treated as 1 (never shrink a mask).
    assert expand_box(box, 1.0) == box
    assert expand_box(box, 0.5) == box


def test_clamp_box_confines_to_frame():
    assert clamp_box([-10, -5, 700, 400], 640, 360) == [0, 0, 640, 360]
    assert clamp_box([10, 20, 30, 40], 640, 360) == [10, 20, 30, 40]


def test_normalize_box_to_percent_xywh():
    assert normalize_box([64, 36, 320, 180], 640, 360) == [0.1, 0.1, 0.4, 0.4]


# --- faces_to_payload ----------------------------------------------------------

def test_faces_to_payload_expands_clamps_normalizes_and_scores():
    dets = [[100, 100, 200, 200, 0.87654]]
    faces = faces_to_payload(dets, 400, 400, mask_scale=1.5)
    assert len(faces) == 1
    # expanded by 0.5×dim per side → [50, 50, 250, 250]
    assert faces[0]["bbox"] == [0.125, 0.125, 0.5, 0.5]
    assert faces[0]["score"] == 0.8765


def test_faces_to_payload_drops_degenerate_and_handles_zero_frame():
    # A box entirely outside the frame clamps to zero area → dropped.
    assert faces_to_payload([[500, 500, 600, 600, 0.9]], 400, 400, 1.0) == []
    # Zero-sized frame (decoder hiccup) → no faces, no ZeroDivisionError.
    assert faces_to_payload([[0, 0, 10, 10, 0.9]], 0, 0, 1.0) == []


# --- iou / nms -----------------------------------------------------------------

def test_iou_basic():
    a = [0, 0, 10, 10]
    assert iou(a, a) == 1.0
    assert iou(a, [20, 20, 30, 30]) == 0.0
    assert iou(a, [5, 0, 15, 10]) == pytest.approx(1 / 3)


def test_nms_keeps_best_of_overlapping_cluster():
    dets = [
        [0, 0, 10, 10, 0.9],
        [1, 1, 11, 11, 0.8],   # heavy overlap with the first → suppressed
        [50, 50, 60, 60, 0.7], # far away → kept
    ]
    kept = nms(dets, iou_thresh=0.3)
    assert [d[4] for d in kept] == [0.9, 0.7]


def test_nms_orders_by_score_regardless_of_input_order():
    dets = [
        [1, 1, 11, 11, 0.5],
        [0, 0, 10, 10, 0.95],
    ]
    kept = nms(dets, iou_thresh=0.3)
    assert kept[0][4] == 0.95 and len(kept) == 1
