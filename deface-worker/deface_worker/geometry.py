"""
Pure box geometry — no heavy deps (unit-tested).

Everything the worker does to a face box between "raw CenterFace output" and
"payload the player overlay can mask" lives here as plain-Python functions:
detection-size parsing, mask-scale expansion (deface's `scale_bb` semantics),
clamping, normalization to 0–1 coords, IoU and greedy NMS.
"""
from __future__ import annotations

from typing import Sequence

# CenterFace's conv stride — input sides must be multiples of this.
STRIDE = 32

Box = Sequence[float]  # [x1, y1, x2, y2]
Det = Sequence[float]  # [x1, y1, x2, y2, score]


def parse_scale(raw: str | None) -> tuple[int, int] | None:
    """Parse a 'WxH' downscale spec (e.g. '640x360') into (w, h).

    Empty / malformed / non-positive specs return None (= detect at native
    frame size) rather than raising — a config typo must never crash the loop.
    """
    if not raw:
        return None
    parts = raw.strip().lower().replace("×", "x").split("x")
    if len(parts) != 2:
        return None
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if w <= 0 or h <= 0:
        return None
    return (w, h)


def fit_to_stride(w: int, h: int, stride: int = STRIDE) -> tuple[int, int]:
    """Round a detection size UP to the model stride (min one stride cell)."""
    fit = lambda v: max(stride, int(-(-v // stride) * stride))  # noqa: E731
    return (fit(w), fit(h))


def expand_box(box: Box, mask_scale: float) -> list[float]:
    """Grow a box about its center by deface's `scale_bb` rule: each side moves
    out by (mask_scale - 1) x that dimension, so the mask covers hair/chin.
    mask_scale 1.0 = unchanged.
    """
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    s = max(0.0, float(mask_scale) - 1.0)
    h, w = y2 - y1, x2 - x1
    return [x1 - w * s, y1 - h * s, x2 + w * s, y2 + h * s]


def clamp_box(box: Box, frame_w: float, frame_h: float) -> list[float]:
    """Clamp a box into [0, frame_w] x [0, frame_h]."""
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    return [
        min(max(x1, 0.0), frame_w),
        min(max(y1, 0.0), frame_h),
        min(max(x2, 0.0), frame_w),
        min(max(y2, 0.0), frame_h),
    ]


def normalize_box(box: Box, frame_w: float, frame_h: float) -> list[float]:
    """Pixel [x1,y1,x2,y2] → normalized [x, y, w, h] in 0–1 (4 decimals)."""
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    return [
        round(x1 / frame_w, 4),
        round(y1 / frame_h, 4),
        round((x2 - x1) / frame_w, 4),
        round((y2 - y1) / frame_h, 4),
    ]


def faces_to_payload(
    dets: Sequence[Det],
    frame_w: float,
    frame_h: float,
    mask_scale: float,
) -> list[dict]:
    """Raw detections → callback face dicts.

    Per face: expand by mask_scale (deface semantics), clamp to the frame,
    normalize to 0–1 [x, y, w, h] and attach the rounded score. Degenerate
    boxes (zero/negative area after clamping) are dropped.
    """
    out: list[dict] = []
    if frame_w <= 0 or frame_h <= 0:
        return out
    for det in dets:
        expanded = clamp_box(expand_box(det, mask_scale), frame_w, frame_h)
        if expanded[2] - expanded[0] <= 0 or expanded[3] - expanded[1] <= 0:
            continue
        out.append(
            {
                "bbox": normalize_box(expanded, frame_w, frame_h),
                "score": round(float(det[4]), 4),
            }
        )
    return out


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


def nms(dets: Sequence[Det], iou_thresh: float = 0.3) -> list[list[float]]:
    """Greedy non-maximum suppression on [x1,y1,x2,y2,score] detections."""
    ordered = sorted((list(d) for d in dets), key=lambda d: d[4], reverse=True)
    kept: list[list[float]] = []
    for det in ordered:
        if all(iou(det, k) <= iou_thresh for k in kept):
            kept.append(det)
    return kept
