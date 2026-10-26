"""
Person detector — thin wrapper over ultralytics YOLO (imported LAZILY, exactly
like yolo-worker, so importing this module never requires torch).

`normalize_person_boxes` is pure (unit-tested): it turns the raw
boxes/scores/classes arrays a YOLO result exposes into NORMALIZED (0-1)
[x, y, w, h] person boxes, dropping every non-person class and low-confidence
hit. The `PersonDetector` class only handles model loading + calling
ultralytics; the mapping logic lives in the pure function.
"""
from __future__ import annotations

from typing import Any, Sequence

# COCO class id for 'person' (canonical across all yolov8 weights).
PERSON_CLASS_ID = 0


def normalize_person_boxes(
    boxes_xyxy: Sequence[Sequence[float]],
    scores: Sequence[float],
    class_ids: Sequence[int],
    min_conf: float,
    frame_w: float,
    frame_h: float,
) -> list[dict[str, Any]]:
    """Parallel arrays → [{'bbox': [x,y,w,h] normalized 0-1, 'conf': float}].

    Keeps only `person` detections at/above `min_conf`; clamps boxes into the
    frame; skips degenerate boxes and zero-sized frames.
    """
    if frame_w <= 0 or frame_h <= 0:
        return []
    out: list[dict[str, Any]] = []
    for box, score, cid in zip(boxes_xyxy, scores, class_ids):
        if int(cid) != PERSON_CLASS_ID:
            continue
        conf = float(score)
        if conf < min_conf:
            continue
        x1, y1, x2, y2 = (float(v) for v in box[:4])
        x1, x2 = max(0.0, min(x1, x2)), min(frame_w, max(x1, x2))
        y1, y2 = max(0.0, min(y1, y2)), min(frame_h, max(y1, y2))
        w, h = x2 - x1, y2 - y1
        if w <= 0 or h <= 0:
            continue
        out.append(
            {
                "bbox": [
                    round(x1 / frame_w, 4),
                    round(y1 / frame_h, 4),
                    round(w / frame_w, 4),
                    round(h / frame_h, 4),
                ],
                "conf": round(conf, 4),
            }
        )
    return out


class PersonDetector:
    """Loads a YOLO model once and returns normalized person boxes per frame."""

    def __init__(self, model: str, device: str, min_conf: float) -> None:
        self.min_conf = min_conf
        self._device = device
        self._model_name = model
        self._model = None  # lazy

    def _ensure_model(self) -> Any:
        if self._model is None:
            from ultralytics import YOLO  # lazy: heavy (torch)

            self._model = YOLO(self._model_name)
        return self._model

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        model = self._ensure_model()
        h, w = frame.shape[:2]
        # classes=[person] keeps ultralytics from even reporting other classes;
        # verbose=False keeps it from spamming stdout (we log ourselves).
        results = model.predict(
            frame,
            conf=self.min_conf,
            device=self._device,
            classes=[PERSON_CLASS_ID],
            verbose=False,
        )
        if not results:
            return []
        r = results[0]
        boxes = getattr(r, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return []
        return normalize_person_boxes(
            boxes.xyxy.tolist(),
            boxes.conf.tolist(),
            [int(c) for c in boxes.cls.tolist()],
            self.min_conf,
            float(w),
            float(h),
        )
