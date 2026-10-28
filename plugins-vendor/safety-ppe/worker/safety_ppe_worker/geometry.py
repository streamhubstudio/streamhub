"""
Pure box geometry — no heavy deps (unit-tested).

Boxes are [x1, y1, x2, y2]; the association logic works on frame-normalized
0–1 coordinates, the letterbox helpers on pixels. Mirrors the deface worker's
style: everything between "raw model output" and "payload" is plain Python.
"""
from __future__ import annotations

from typing import Sequence

Box = Sequence[float]  # [x1, y1, x2, y2]
Det = Sequence[float]  # [x1, y1, x2, y2, score]


def iou(a: Box, b: Box) -> float:
    """Intersection-over-union of two [x1,y1,x2,y2] boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def containment(inner: Box, outer: Box) -> float:
    """Fraction of `inner`'s area inside `outer` (0–1).

    The person↔PPE association metric: a helmet box is small relative to a
    person box, so IoU is tiny even for a perfect wear — what matters is how
    much of the ITEM lies within the PERSON.
    """
    ix1, iy1 = max(inner[0], outer[0]), max(inner[1], outer[1])
    ix2, iy2 = min(inner[2], outer[2]), min(inner[3], outer[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area = max(0.0, inner[2] - inner[0]) * max(0.0, inner[3] - inner[1])
    return inter / area if area > 0 else 0.0


def expand_box(box: Box, margin: float) -> list[float]:
    """Grow a box about its center by `margin` × each dimension per side.

    Used before association: a worn helmet's box may poke slightly above the
    detected person box, so the person box gets a small tolerance margin.
    """
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    m = max(0.0, float(margin))
    w, h = x2 - x1, y2 - y1
    return [x1 - w * m, y1 - h * m, x2 + w * m, y2 + h * m]


def nms(dets: Sequence[Det], iou_thresh: float = 0.45) -> list[list[float]]:
    """Greedy non-maximum suppression on [x1,y1,x2,y2,score] detections."""
    ordered = sorted((list(d) for d in dets), key=lambda d: d[4], reverse=True)
    kept: list[list[float]] = []
    for det in ordered:
        if all(iou(det, k) <= iou_thresh for k in kept):
            kept.append(det)
    return kept


# ---------------------------------------------------------------------------
# Letterbox mapping (frame pixels ↔ model input pixels)
# ---------------------------------------------------------------------------

def letterbox_params(
    frame_w: float, frame_h: float, input_w: float, input_h: float
) -> tuple[float, float, float]:
    """(scale, pad_x, pad_y) of the aspect-preserving letterbox that fits a
    frame into the model input, centered (ultralytics-style)."""
    if frame_w <= 0 or frame_h <= 0:
        return (1.0, 0.0, 0.0)
    scale = min(input_w / frame_w, input_h / frame_h)
    pad_x = (input_w - frame_w * scale) / 2.0
    pad_y = (input_h - frame_h * scale) / 2.0
    return (scale, pad_x, pad_y)


def unletterbox_box(
    box: Box, scale: float, pad_x: float, pad_y: float, frame_w: float, frame_h: float
) -> list[float]:
    """Model-input [x1,y1,x2,y2] → frame pixels, clamped to the frame."""
    if scale <= 0:
        return [0.0, 0.0, 0.0, 0.0]
    x1 = (float(box[0]) - pad_x) / scale
    y1 = (float(box[1]) - pad_y) / scale
    x2 = (float(box[2]) - pad_x) / scale
    y2 = (float(box[3]) - pad_y) / scale
    return [
        min(max(x1, 0.0), frame_w),
        min(max(y1, 0.0), frame_h),
        min(max(x2, 0.0), frame_w),
        min(max(y2, 0.0), frame_h),
    ]


def normalize_box(box: Box, frame_w: float, frame_h: float) -> list[float]:
    """Pixel [x1,y1,x2,y2] → frame-normalized 0–1 [x1,y1,x2,y2] (4 decimals)."""
    if frame_w <= 0 or frame_h <= 0:
        return [0.0, 0.0, 0.0, 0.0]
    return [
        round(float(box[0]) / frame_w, 4),
        round(float(box[1]) / frame_h, 4),
        round(float(box[2]) / frame_w, 4),
        round(float(box[3]) / frame_h, 4),
    ]
