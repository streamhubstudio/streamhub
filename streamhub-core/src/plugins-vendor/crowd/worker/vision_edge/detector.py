"""
YOLO + ByteTrack detector wrapper (lazy ``ultralytics`` import).

Mirrors Vision One's occupancy inference call: ``model.track(frame,
persist=True, tracker=…, classes=…, conf=…)`` — a persistent ByteTrack keeps
IDs across frames. Bounding boxes are normalized to [0,1] here so every
downstream consumer (zones, line counters) is resolution-independent.

Not unit-tested (needs torch); the pure cores are fed plain detection dicts by
the tests. Kept small and dependency-lazy so importing the package is cheap.
"""
from __future__ import annotations

import os
from typing import Any


def default_tracker_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "trackers", "custom_bytetrack_persons.yaml")


# COCO class ids we ever track (person + the vehicle group).
PERSON_ID = 0
VEHICLE_IDS = (2, 3, 5, 7)  # car, motorcycle, bus, truck
COCO_NAMES = {0: "person", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}


class Detector:  # pragma: no cover - runtime only (needs ultralytics/torch)
    """Persistent-tracking detector. ``track(frame)`` returns a list of
    ``{trackId, bbox:[x1,y1,x2,y2] normalized, cls, conf}`` dicts."""

    def __init__(
        self,
        model_name: str = "yolo11n.pt",
        device: str = "cpu",
        confidence: float = 0.25,
        classes: tuple[int, ...] = (PERSON_ID,),
        tracker: str = "",
        imgsz: int = 640,
    ) -> None:
        from ultralytics import YOLO  # lazy

        self.model = YOLO(model_name)
        if device == "cuda":
            try:
                self.model.to("cuda")
            except Exception:  # noqa: BLE001 - fall back to cpu
                device = "cpu"
        self.device = device
        self.confidence = confidence
        self.classes = list(classes)
        self.tracker = tracker or default_tracker_path()
        self.imgsz = imgsz

    def track(self, frame: Any) -> list[dict[str, Any]]:
        h, w = frame.shape[0], frame.shape[1]
        results = self.model.track(
            frame,
            persist=True,
            tracker=self.tracker,
            conf=self.confidence,
            classes=self.classes,
            imgsz=self.imgsz,
            verbose=False,
        )
        out: list[dict[str, Any]] = []
        if not results:
            return out
        r = results[0]
        boxes = getattr(r, "boxes", None)
        if boxes is None or boxes.id is None:
            return out
        ids = boxes.id.int().cpu().tolist()
        xyxy = boxes.xyxy.cpu().tolist()
        confs = boxes.conf.cpu().tolist()
        clss = boxes.cls.int().cpu().tolist()
        for tid, (x1, y1, x2, y2), cf, cl in zip(ids, xyxy, confs, clss):
            out.append(
                {
                    "trackId": int(tid),
                    "bbox": [x1 / w, y1 / h, x2 / w, y2 / h],
                    "cls": COCO_NAMES.get(int(cl), str(cl)),
                    "conf": float(cf),
                }
            )
        return out
