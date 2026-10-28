"""
ALPR inference wrapper — the ONLY module that touches fast-alpr.

MODEL CHOICE (owner requirement: open-source only):
  - fast-alpr            MIT  https://github.com/ankandrew/fast-alpr
      = open-image-models  MIT  (YOLOv9-t license-plate DETECTION, ONNX)
      + fast-plate-ocr     MIT  (CCT plate OCR, ONNX)
  Both run on onnxruntime — CPU-friendly, CUDA optional. Models auto-download
  to LPR_MODEL_DIR on first use.

fast-alpr is imported LAZILY inside `_ensure()` so the pure-logic pytest
suite never needs onnxruntime/fast-alpr installed; the runner injects a fake
reader in tests.
"""
from __future__ import annotations

import os
from typing import Any, Callable, Optional


class PlateReader:
    """`read(frame) -> [{plate, confidence, bbox}]` over fast-alpr.

    `plate` is the RAW OCR text (the runner normalizes it); `confidence` is
    the mean OCR character confidence (0..1); `bbox` is [x1, y1, x2, y2] in
    pixels when the detection carries one.
    """

    def __init__(
        self,
        detector_model: str,
        ocr_model: str,
        device: str = "cpu",
        model_dir: str = "",
        on_note: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.detector_model = detector_model
        self.ocr_model = ocr_model
        self.device = device
        self.model_dir = model_dir
        self._on_note = on_note or (lambda _msg: None)
        self._alpr: Any = None

    def _ensure(self) -> None:
        if self._alpr is not None:
            return
        if self.model_dir:
            os.makedirs(self.model_dir, exist_ok=True)
            # fast-alpr's sub-packages cache their ONNX downloads via the
            # standard cache-dir envs — pin them so models land in the shared
            # <DATA_DIR>/models/lpr instead of the service user's $HOME.
            os.environ.setdefault("XDG_CACHE_HOME", self.model_dir)
            os.environ.setdefault("HF_HOME", os.path.join(self.model_dir, "hf"))

        from fast_alpr import ALPR  # lazy: heavy (onnxruntime)

        kwargs: dict[str, Any] = {
            "detector_model": self.detector_model,
            "ocr_model": self.ocr_model,
        }
        if self.device == "cuda":
            kwargs["detector_providers"] = [
                "CUDAExecutionProvider",
                "CPUExecutionProvider",
            ]
            kwargs["ocr_device"] = "cuda"
        try:
            self._alpr = ALPR(**kwargs)
        except TypeError:
            # Older/newer fast-alpr signature without provider kwargs — fall
            # back to defaults (CPU) rather than crash-looping the worker.
            self._on_note(
                "fast-alpr does not accept provider kwargs — using defaults (CPU)"
            )
            self._alpr = ALPR(
                detector_model=self.detector_model, ocr_model=self.ocr_model
            )

    def read(self, frame: Any) -> list[dict[str, Any]]:
        self._ensure()
        out: list[dict[str, Any]] = []
        for result in self._alpr.predict(frame) or []:
            ocr = getattr(result, "ocr", None)
            text = getattr(ocr, "text", "") if ocr else ""
            if not text:
                continue
            confidence = float(getattr(ocr, "confidence", 0.0) or 0.0)
            bbox = None
            detection = getattr(result, "detection", None)
            box = getattr(detection, "bounding_box", None) if detection else None
            if box is not None:
                try:
                    bbox = [
                        float(box.x1),
                        float(box.y1),
                        float(box.x2),
                        float(box.y2),
                    ]
                except AttributeError:
                    bbox = None
            out.append({"plate": text, "confidence": confidence, "bbox": bbox})
        return out
