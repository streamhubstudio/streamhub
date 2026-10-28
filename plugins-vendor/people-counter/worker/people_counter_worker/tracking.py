"""
Person detection + tracking — thin wrapper over ultralytics YOLO `track()`
with the built-in ByteTrack tracker (imported LAZILY: importing this module
never requires torch, so the pure-logic tests run without it).

PROVENANCE: same inference call shape as Vision One's counting.py step 2 —
`model.track(persist=True, classes=[0], tracker=<tuned yaml>, max_det=50)`,
with `half=True` only on CUDA (Vision One notes that CUDA numeric shortcuts
cause tracker ID swaps; we keep inference plain, exactly like vision-test).

`normalize_tracks` is pure (unit-tested): raw parallel arrays → per-track
dicts with the bbox CENTER in normalized [0,1] coordinates — the counter and
the dashboard line editor share that coordinate space.
"""
from __future__ import annotations

from typing import Any, Sequence


def normalize_tracks(
    boxes_xyxy: Sequence[Sequence[float]],
    track_ids: Sequence[int],
    scores: Sequence[float],
    width: float,
    height: float,
    min_conf: float = 0.0,
) -> list[dict[str, Any]]:
    """Parallel arrays → [{'id', 'cx', 'cy', 'conf'}] with normalized centers.

    - drops entries below `min_conf`;
    - drops degenerate frames (width/height <= 0) entirely;
    - centers are clamped to [0,1] so a box hanging off-frame can't push a
      position outside the line editor's coordinate space.
    """
    if width <= 0 or height <= 0:
        return []
    out: list[dict[str, Any]] = []
    for box, tid, score in zip(boxes_xyxy, track_ids, scores):
        conf = float(score)
        if conf < min_conf:
            continue
        x1, y1, x2, y2 = (float(v) for v in box[:4])
        cx = min(1.0, max(0.0, ((x1 + x2) / 2.0) / width))
        cy = min(1.0, max(0.0, ((y1 + y2) / 2.0) / height))
        out.append({"id": int(tid), "cx": cx, "cy": cy, "conf": round(conf, 4)})
    return out


class PersonTracker:
    """Loads a YOLO model once and runs tracked person inference per frame."""

    PERSON_CLASS = 0  # COCO 'person'

    def __init__(
        self,
        model: str,
        device: str,
        min_conf: float,
        tracker_yaml: str,
        imgsz: int = 640,
    ) -> None:
        self.min_conf = min_conf
        self._device = device
        self._model_name = model
        self._tracker_yaml = tracker_yaml
        self._imgsz = imgsz
        self._model = None  # lazy

    def _ensure_model(self) -> Any:
        if self._model is None:
            from ultralytics import YOLO  # lazy: heavy (torch)

            self._model = YOLO(self._model_name)
        return self._model

    def track(self, frame: Any) -> list[dict[str, Any]]:
        """One tracked-inference step → normalized track dicts."""
        model = self._ensure_model()
        results = model.track(
            frame,
            conf=self.min_conf,
            iou=0.3,  # Vision One's NMS IoU for overlapping people
            imgsz=self._imgsz,
            classes=[self.PERSON_CLASS],
            persist=True,  # keep tracker state across frames
            tracker=self._tracker_yaml,
            verbose=False,
            half=self._device == "cuda",
            max_det=50,
            device=self._device,
        )
        if not results:
            return []
        r = results[0]
        boxes = getattr(r, "boxes", None)
        if boxes is None or len(boxes) == 0 or boxes.id is None:
            return []  # tracker hasn't confirmed any track yet
        try:
            h, w = r.orig_shape[:2]
        except (AttributeError, TypeError):
            return []
        return normalize_tracks(
            boxes.xyxy.tolist(),
            [int(i) for i in boxes.id.int().tolist()],
            boxes.conf.tolist(),
            float(w),
            float(h),
            self.min_conf,
        )
