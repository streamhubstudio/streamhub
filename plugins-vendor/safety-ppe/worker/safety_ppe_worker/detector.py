"""
PPE detector — ONNX Runtime wrapper around the YOLOv8 export (lazy imports).

Deliberately NOT the ultralytics package: running the shipped `best.onnx`
through plain onnxruntime keeps the AGPL-3.0 ultralytics runtime out of the
product (see the worker README's license section). All the decode math lives
in postprocess.py as pure functions; this class only handles model download,
session setup (CUDA → CPU fallback) and the numpy pre-processing.
"""
from __future__ import annotations

import os
import urllib.request
from typing import Any, Callable

from .classes import DEFAULT_CLASS_NAMES, parse_names_metadata
from .config import MODEL_FILENAME
from .postprocess import decode_rows, nms_per_class, to_detections

DEFAULT_INPUT_SIZE = (640, 640)  # (w, h) — the shipped export is static 640².


def ensure_model(
    model_dir: str,
    url: str,
    filename: str = MODEL_FILENAME,
    retrieve: Callable[[str, str], Any] = urllib.request.urlretrieve,
) -> str:
    """Return the local model path, downloading it once if missing.

    Downloads to a `.part` file and atomically renames, so a killed worker
    never leaves a truncated model that poisons every later start. (Same
    pattern as the deface worker.) Pre-seed the file for air-gapped hosts.
    """
    path = os.path.join(model_dir, filename)
    if os.path.exists(path):
        return path
    os.makedirs(model_dir, exist_ok=True)
    part = f"{path}.part"
    retrieve(url, part)
    os.replace(part, path)
    return path


class PpeDetector:
    """Loads the ONNX model once and detects PPE roles per BGR frame."""

    def __init__(
        self,
        model_path: str,
        class_names: list[str] | None = None,
        execution_provider: str = "cpu",
        confidence: float = 0.35,
        input_size: tuple[int, int] = DEFAULT_INPUT_SIZE,
        on_note: Callable[[str], None] | None = None,
    ) -> None:
        self.model_path = model_path
        self.class_names = class_names or list(DEFAULT_CLASS_NAMES)
        self.execution_provider = execution_provider
        self.confidence = confidence
        self.input_size = input_size
        self._note = on_note or (lambda _msg: None)
        self._sess: Any = None
        self._input_name: str | None = None
        self._explicit_names = class_names is not None

    # -- session -------------------------------------------------------------

    def _ensure_session(self) -> Any:
        if self._sess is not None:
            return self._sess
        import onnxruntime  # lazy: heavy

        providers = ["CPUExecutionProvider"]
        if self.execution_provider == "cuda":
            available = set(onnxruntime.get_available_providers())
            if "CUDAExecutionProvider" in available:
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            else:
                self._note(
                    "CUDA execution provider unavailable (install "
                    "onnxruntime-gpu) — falling back to CPU"
                )
        sess = onnxruntime.InferenceSession(self.model_path, providers=providers)
        self._input_name = sess.get_inputs()[0].name

        # Static export size wins over the configured default when present.
        shape = sess.get_inputs()[0].shape  # [N, C, H, W]
        if (
            isinstance(shape, (list, tuple))
            and len(shape) == 4
            and isinstance(shape[2], int)
            and isinstance(shape[3], int)
        ):
            self.input_size = (int(shape[3]), int(shape[2]))

        # The ultralytics exporter embeds the class names — trust them over
        # the built-in default (but never over an explicit operator override).
        if not self._explicit_names:
            try:
                meta = sess.get_modelmeta().custom_metadata_map or {}
                names = parse_names_metadata(meta.get("names"))
            except Exception:  # noqa: BLE001 - metadata is best-effort
                names = None
            if names:
                self.class_names = names
                self._note(f"class names from model metadata ({len(names)})")

        self._sess = sess
        return sess

    # -- inference -------------------------------------------------------------

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        """BGR frame → role detection dicts (normalized bboxes), see
        postprocess.to_detections."""
        import cv2  # lazy
        import numpy as np  # lazy

        sess = self._ensure_session()
        in_w, in_h = self.input_size
        frame_h, frame_w = frame.shape[:2]

        # Letterbox: aspect-preserving resize onto a 114-gray canvas
        # (ultralytics convention), centered.
        scale = min(in_w / frame_w, in_h / frame_h)
        new_w, new_h = max(1, round(frame_w * scale)), max(1, round(frame_h * scale))
        resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((in_h, in_w, 3), 114, dtype=np.uint8)
        off_x, off_y = (in_w - new_w) // 2, (in_h - new_h) // 2
        canvas[off_y : off_y + new_h, off_x : off_x + new_w] = resized

        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        output = sess.run(None, {self._input_name: blob})[0]

        # (1, 4+nc, N) → rows of [cx, cy, w, h, s0, …] as plain lists, then the
        # pure pipeline: decode → per-class NMS → role mapping + unletterbox.
        rows = output[0].transpose(1, 0).tolist()
        raw = decode_rows(rows, self.confidence)
        kept = nms_per_class(raw)
        return to_detections(
            kept, self.class_names, float(frame_w), float(frame_h), float(in_w), float(in_h)
        )
