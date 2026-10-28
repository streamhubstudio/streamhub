"""
Person detector — thin wrapper over ultralytics YOLO (imported lazily).

Only COCO class 0 (person) is requested from the model; the wrapper returns
raw pixel detections `[x1, y1, x2, y2, conf]`. All downstream mapping
(normalization, zone hits) is pure and lives in geometry.py — tests inject a
fake `detect` and never import torch.
"""
from __future__ import annotations

from typing import Any

# COCO id for 'person' — the only class the perimeter cares about.
PERSON_CLASS_ID = 0


class PersonDetector:
    """Loads a YOLO model once and returns person boxes per frame."""

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

    def detect(self, frame: Any) -> list[list[float]]:
        """Frame → [[x1, y1, x2, y2, conf], ...] pixel person boxes."""
        model = self._ensure_model()
        # verbose=False keeps ultralytics from spamming stdout (we log ourselves)
        results = model.predict(
            frame,
            conf=self.min_conf,
            classes=[PERSON_CLASS_ID],
            device=self._device,
            verbose=False,
        )
        if not results:
            return []
        boxes = getattr(results[0], "boxes", None)
        if boxes is None or len(boxes) == 0:
            return []
        xyxy = boxes.xyxy.tolist()
        scores = boxes.conf.tolist()
        return [
            [float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(s)]
            for b, s in zip(xyxy, scores)
        ]
