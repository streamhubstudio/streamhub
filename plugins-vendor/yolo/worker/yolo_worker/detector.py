"""
YOLO detector — thin wrapper over ultralytics (imported lazily).

`normalize_result` is pure (unit-tested): it turns the raw boxes/scores/classes
arrays a YOLO result exposes into the callback detection dicts, applying the
confidence + class-id filters. The `Detector` class only handles model loading
and calling ultralytics; the mapping logic lives in the pure function.
"""
from __future__ import annotations

from typing import Any, Sequence

from .coco import id_to_name, names_to_ids


def normalize_result(
    boxes_xyxy: Sequence[Sequence[float]],
    scores: Sequence[float],
    class_ids: Sequence[int],
    min_conf: float,
    keep_ids: set[int] | None,
) -> list[dict[str, Any]]:
    """Build detection dicts from parallel arrays, filtered.

    - drops detections below `min_conf`
    - if `keep_ids` is a non-empty set, drops classes not in it
      (None or empty set → keep all classes)
    """
    out: list[dict[str, Any]] = []
    for box, score, cid in zip(boxes_xyxy, scores, class_ids):
        conf = float(score)
        if conf < min_conf:
            continue
        cid = int(cid)
        if keep_ids and cid not in keep_ids:
            continue
        x1, y1, x2, y2 = (float(v) for v in box[:4])
        out.append(
            {
                "class": id_to_name(cid),
                "conf": round(conf, 4),
                "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            }
        )
    return out


class Detector:
    """Loads a YOLO model once and runs inference per frame."""

    def __init__(self, model: str, device: str, min_conf: float, classes: list[str]):
        self.min_conf = min_conf
        self.keep_ids: set[int] = set(names_to_ids(classes)) if classes else set()
        self._device = device
        self._model_name = model
        self._model = None  # lazy

    def _ensure_model(self) -> Any:
        if self._model is None:
            from ultralytics import YOLO  # lazy: heavy (torch)

            model = YOLO(self._model_name)
            self._model = model
        return self._model

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        model = self._ensure_model()
        # verbose=False keeps ultralytics from spamming stdout (we log ourselves)
        results = model.predict(
            frame,
            conf=self.min_conf,
            device=self._device,
            verbose=False,
        )
        if not results:
            return []
        r = results[0]
        boxes = getattr(r, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return []
        xyxy = boxes.xyxy.tolist()
        scores = boxes.conf.tolist()
        cls = [int(c) for c in boxes.cls.tolist()]
        return normalize_result(
            xyxy, scores, cls, self.min_conf, self.keep_ids or None
        )
