"""
CenterFace face detector — the ONNX model deface uses.

Split in two layers so the math is unit-testable without onnxruntime/opencv:

  - PURE decode: `decode_heatmap` turns the raw network outputs (heatmap +
    exp-encoded scales + center offsets, stride 4 — identical to deface's
    CenterFace.decode) into [x1,y1,x2,y2,score] boxes, and `rescale_dets` maps
    them from detection-input coords back to frame coords. Plain lists in/out.
  - RUNTIME wrapper: `CenterFace` downloads/caches centerface.onnx, builds an
    onnxruntime session (CUDA→CPU fallback) or an OpenCV-DNN net, and runs
    frames through preprocess → forward → decode → NMS.
"""
from __future__ import annotations

import math
import os
import urllib.request
from typing import Any, Callable, Sequence

from .geometry import fit_to_stride, nms

# The centerface.onnx graph's tensor names (fixed in the shipped model).
_INPUT_NAME = "input.1"
_OUTPUT_NAMES = ["537", "538", "539", "540"]  # heatmap, scale, offset, lms
_STRIDE_OUT = 4  # output feature maps are 1/4 of the input size

Det = list[float]  # [x1, y1, x2, y2, score]


# ---------------------------------------------------------------------------
# Pure decode (unit-tested, no numpy required)
# ---------------------------------------------------------------------------

def decode_heatmap(
    heatmap: Sequence[Sequence[float]],
    scale0: Sequence[Sequence[float]],
    scale1: Sequence[Sequence[float]],
    offset0: Sequence[Sequence[float]],
    offset1: Sequence[Sequence[float]],
    size_wh: tuple[float, float],
    thresh: float,
) -> list[Det]:
    """CenterFace output → boxes in DETECTION-INPUT pixel coords.

    Mirrors deface's decode: for every heatmap cell above `thresh`, the box
    size is exp(scale)*4 and its top-left derives from the cell center plus
    the regressed offset, clamped to the input size. Row index 0 is the
    y-axis (scale0/offset0), row index 1 the x-axis — as in the original.
    """
    in_w, in_h = float(size_wh[0]), float(size_wh[1])
    dets: list[Det] = []
    for cy, row in enumerate(heatmap):
        for cx, score in enumerate(row):
            s = float(score)
            if s <= thresh:
                continue
            s0 = math.exp(float(scale0[cy][cx])) * _STRIDE_OUT  # box height
            s1 = math.exp(float(scale1[cy][cx])) * _STRIDE_OUT  # box width
            o0 = float(offset0[cy][cx])  # y offset
            o1 = float(offset1[cy][cx])  # x offset
            x1 = max(0.0, (cx + o1 + 0.5) * _STRIDE_OUT - s1 / 2)
            y1 = max(0.0, (cy + o0 + 0.5) * _STRIDE_OUT - s0 / 2)
            x1, y1 = min(x1, in_w), min(y1, in_h)
            dets.append([x1, y1, min(x1 + s1, in_w), min(y1 + s0, in_h), s])
    return dets


def rescale_dets(dets: Sequence[Sequence[float]], sx: float, sy: float) -> list[Det]:
    """Map boxes from detection-input coords back to frame coords."""
    return [
        [d[0] * sx, d[1] * sy, d[2] * sx, d[3] * sy, d[4]] for d in dets
    ]


# ---------------------------------------------------------------------------
# Model download
# ---------------------------------------------------------------------------

def ensure_model(
    model_dir: str,
    url: str,
    retrieve: Callable[[str, str], Any] = urllib.request.urlretrieve,
) -> str:
    """Return the local centerface.onnx path, downloading it once if missing.

    Downloads to a `.part` file and atomically renames, so a killed worker
    never leaves a truncated model that poisons every later start.
    """
    path = os.path.join(model_dir, "centerface.onnx")
    if os.path.exists(path):
        return path
    os.makedirs(model_dir, exist_ok=True)
    part = f"{path}.part"
    retrieve(url, part)
    os.replace(part, path)
    return path


# ---------------------------------------------------------------------------
# Runtime wrapper (lazy heavy imports)
# ---------------------------------------------------------------------------

class CenterFace:
    """Loads centerface.onnx once and detects faces per BGR frame.

    backend: 'onnxrt' | 'opencv' | 'auto' (onnxrt if importable, else opencv).
    execution_provider: 'cuda' tries the CUDA EP with a graceful CPU fallback.
    `on_note(message)` receives human-readable runtime notes (fallbacks etc.).
    """

    def __init__(
        self,
        model_path: str,
        backend: str = "auto",
        execution_provider: str = "cpu",
        scale: tuple[int, int] | None = None,
        on_note: Callable[[str], None] | None = None,
    ) -> None:
        self.model_path = model_path
        self.backend = backend
        self.execution_provider = execution_provider
        self.scale = scale
        self._note = on_note or (lambda _msg: None)
        self._sess: Any = None       # onnxruntime session
        self._net: Any = None        # cv2.dnn net
        self._resolved: str | None = None

    # -- backend resolution -------------------------------------------------

    def _resolve_backend(self) -> str:
        if self._resolved:
            return self._resolved
        choice = self.backend
        if choice == "auto":
            try:
                import onnx  # noqa: F401  (needed to dynamicize input dims)
                import onnxruntime  # noqa: F401
                choice = "onnxrt"
            except ImportError:
                self._note("onnxruntime not available — using the OpenCV DNN backend")
                choice = "opencv"
        self._resolved = choice
        return choice

    def _ensure_onnxrt(self) -> Any:
        if self._sess is None:
            import onnx
            from onnx.tools.update_model_dims import update_inputs_outputs_dims
            import onnxruntime as ort

            # The shipped centerface.onnx has static (1,3,32,32) dims — relax
            # them to dynamic B/H/W exactly like deface's dynamicize_shapes.
            # NOTE: the old-style export lists weight initializers as graph
            # inputs too, and update_inputs_outputs_dims requires an entry for
            # EVERY input/output — so collect the existing dims first and only
            # override the real image input + the four detection outputs.
            static_model = onnx.load(self.model_path)
            input_dims: dict[str, list] = {}
            output_dims: dict[str, list] = {}
            for node in static_model.graph.input:
                dims = [d.dim_value for d in node.type.tensor_type.shape.dim]
                input_dims[node.name] = dims
            for node in static_model.graph.output:
                dims = [d.dim_value for d in node.type.tensor_type.shape.dim]
                output_dims[node.name] = dims
            input_dims[_INPUT_NAME] = ["B", 3, "H", "W"]
            output_dims.update(
                {
                    _OUTPUT_NAMES[0]: ["B", 1, "h", "w"],
                    _OUTPUT_NAMES[1]: ["B", 2, "h", "w"],
                    _OUTPUT_NAMES[2]: ["B", 2, "h", "w"],
                    _OUTPUT_NAMES[3]: ["B", 10, "h", "w"],
                }
            )
            dyn = update_inputs_outputs_dims(static_model, input_dims, output_dims)
            # The old-style export triggers ~100 benign "initializer appears
            # in graph inputs" warnings — silence them like deface does, so
            # they don't flood the plugin logs ring buffer.
            ort.set_default_logger_severity(3)
            providers = ["CPUExecutionProvider"]
            if self.execution_provider == "cuda":
                available = ort.get_available_providers()
                if "CUDAExecutionProvider" in available:
                    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
                else:
                    self._note(
                        "CUDA requested but CUDAExecutionProvider is not "
                        "available (install onnxruntime-gpu) — falling back to CPU"
                    )
            try:
                self._sess = ort.InferenceSession(
                    dyn.SerializeToString(), providers=providers
                )
            except Exception as exc:  # noqa: BLE001 — CUDA init can fail late
                if providers[0] != "CPUExecutionProvider":
                    self._note(f"CUDA session failed ({exc}) — retrying on CPU")
                    self._sess = ort.InferenceSession(
                        dyn.SerializeToString(),
                        providers=["CPUExecutionProvider"],
                    )
                else:
                    raise
        return self._sess

    def _ensure_opencv(self) -> Any:
        if self._net is None:
            import cv2

            self._net = cv2.dnn.readNetFromONNX(self.model_path)
            if self.execution_provider == "cuda":
                self._note(
                    "CUDA is only supported on the onnxrt backend — "
                    "OpenCV DNN runs on CPU"
                )
        return self._net

    # -- inference ------------------------------------------------------------

    def detect(self, frame: Any, thresh: float) -> list[Det]:
        """BGR frame → [x1,y1,x2,y2,score] face boxes in FRAME pixel coords."""
        import cv2

        frame_h, frame_w = frame.shape[:2]
        want_w, want_h = self.scale or (frame_w, frame_h)
        in_w, in_h = fit_to_stride(int(want_w), int(want_h))

        blob = cv2.dnn.blobFromImage(
            frame,
            scalefactor=1.0,
            size=(in_w, in_h),
            mean=(0, 0, 0),
            swapRB=True,
            crop=False,
        )

        if self._resolve_backend() == "onnxrt":
            sess = self._ensure_onnxrt()
            heatmap, scale, offset, _lms = sess.run(
                _OUTPUT_NAMES, {_INPUT_NAME: blob}
            )
        else:
            net = self._ensure_opencv()
            net.setInput(blob)
            heatmap, scale, offset, _lms = net.forward(_OUTPUT_NAMES)

        dets = decode_heatmap(
            heatmap[0][0].tolist(),
            scale[0][0].tolist(),
            scale[0][1].tolist(),
            offset[0][0].tolist(),
            offset[0][1].tolist(),
            (in_w, in_h),
            thresh,
        )
        dets = nms(dets, iou_thresh=0.3)
        return rescale_dets(dets, frame_w / in_w, frame_h / in_h)
