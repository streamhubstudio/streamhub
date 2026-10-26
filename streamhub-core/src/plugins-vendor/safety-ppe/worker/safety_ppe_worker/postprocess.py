"""
Pure YOLOv8 ONNX output decode (unit-tested, no numpy required).

An ultralytics YOLOv8 detect export outputs (1, 4 + n_classes, N) — per anchor
a cx,cy,w,h box in INPUT pixels plus one score per class (already sigmoided,
no objectness). The runtime detector transposes + `.tolist()`s that tensor and
hands PLAIN LISTS to these functions, so the whole decode → NMS → role-mapping
pipeline is testable without onnxruntime.
"""
from __future__ import annotations

from typing import Any, Sequence

from .classes import roles_for
from .geometry import letterbox_params, nms, normalize_box, unletterbox_box

# [x1, y1, x2, y2, score, class_id] in model-input pixels.
RawDet = list[float]


def decode_rows(
    rows: Sequence[Sequence[float]], conf_thresh: float
) -> list[RawDet]:
    """Rows of [cx, cy, w, h, s0, s1, …] → raw dets above `conf_thresh`.

    Best class per row = argmax over the class scores. cx,cy,w,h → x1,y1,x2,y2
    (still in model-input pixel space).
    """
    out: list[RawDet] = []
    for row in rows:
        if len(row) < 5:
            continue
        scores = row[4:]
        best_id = 0
        best = float(scores[0])
        for i in range(1, len(scores)):
            s = float(scores[i])
            if s > best:
                best, best_id = s, i
        if best < conf_thresh:
            continue
        cx, cy, w, h = (float(v) for v in row[:4])
        out.append(
            [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, best, float(best_id)]
        )
    return out


def nms_per_class(dets: Sequence[Sequence[float]], iou_thresh: float = 0.45) -> list[RawDet]:
    """Greedy NMS applied independently per class id (index 5)."""
    by_class: dict[float, list[list[float]]] = {}
    for d in dets:
        by_class.setdefault(d[5], []).append(list(d))
    kept: list[RawDet] = []
    for cid, group in by_class.items():
        for k in nms(group, iou_thresh):
            kept.append(list(k[:5]) + [cid])
    kept.sort(key=lambda d: d[4], reverse=True)
    return kept


def to_detections(
    dets: Sequence[Sequence[float]],
    class_names: list[str],
    frame_w: float,
    frame_h: float,
    input_w: float,
    input_h: float,
) -> list[dict[str, Any]]:
    """Raw input-space dets → role detection dicts in frame-normalized coords.

    Classes without a canonical role (gloves, cones, …) are DROPPED here —
    downstream logic only ever sees person/helmet/no_helmet/vest/no_vest.

      { "role", "class", "conf", "bbox": [x1,y1,x2,y2] (0–1) }
    """
    roles = roles_for(class_names)
    scale, pad_x, pad_y = letterbox_params(frame_w, frame_h, input_w, input_h)
    out: list[dict[str, Any]] = []
    for d in dets:
        cid = int(d[5])
        if cid < 0 or cid >= len(roles):
            continue
        role = roles[cid]
        if role is None:
            continue
        pixel = unletterbox_box(d, scale, pad_x, pad_y, frame_w, frame_h)
        if pixel[2] - pixel[0] <= 0 or pixel[3] - pixel[1] <= 0:
            continue
        out.append(
            {
                "role": role,
                "class": class_names[cid],
                "conf": round(float(d[4]), 4),
                "bbox": normalize_box(pixel, frame_w, frame_h),
            }
        )
    return out
