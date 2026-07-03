"""CenterFace decode math — pure, no onnxruntime/opencv/numpy needed."""
import math

import pytest

from deface_worker.centerface import decode_heatmap, ensure_model, rescale_dets


def _grid(h, w, fill=0.0):
    return [[fill for _ in range(w)] for _ in range(h)]


def test_decode_single_hot_cell_box_math():
    # 4x4 feature map (stride 4 → 16x16 input). One confident cell at (1, 2).
    h, w = 4, 4
    heat = _grid(h, w)
    heat[1][2] = 0.9
    scale0 = _grid(h, w)  # log-encoded height
    scale1 = _grid(h, w)  # log-encoded width
    off0 = _grid(h, w)
    off1 = _grid(h, w)
    scale0[1][2] = math.log(2.0)  # box height = 2 * 4 = 8
    scale1[1][2] = math.log(1.0)  # box width  = 1 * 4 = 4
    off0[1][2] = 0.25             # y offset
    off1[1][2] = -0.5             # x offset

    dets = decode_heatmap(heat, scale0, scale1, off0, off1, (16, 16), thresh=0.5)
    assert len(dets) == 1
    x1, y1, x2, y2, score = dets[0]
    # cx=2, cy=1: x1 = (2 - 0.5 + 0.5)*4 - 4/2 = 6 ; y1 = (1 + 0.25 + 0.5)*4 - 8/2 = 3
    assert (x1, y1) == (6.0, 3.0)
    assert (x2, y2) == (10.0, 11.0)
    assert score == pytest.approx(0.9)


def test_decode_applies_threshold_and_clamps_to_input():
    h, w = 2, 2
    heat = [[0.3, 0.0], [0.0, 0.95]]
    big = math.log(100.0)  # huge box → must clamp to the 8x8 input
    scale0 = [[0.0, 0.0], [0.0, big]]
    scale1 = [[0.0, 0.0], [0.0, big]]
    off0 = _grid(h, w)
    off1 = _grid(h, w)

    dets = decode_heatmap(heat, scale0, scale1, off0, off1, (8, 8), thresh=0.5)
    assert len(dets) == 1  # the 0.3 cell is below thresh
    x1, y1, x2, y2, _ = dets[0]
    assert 0 <= x1 <= 8 and 0 <= y1 <= 8
    assert x2 <= 8 and y2 <= 8


def test_decode_empty_when_nothing_above_thresh():
    z = _grid(3, 3)
    assert decode_heatmap(z, z, z, z, z, (12, 12), thresh=0.2) == []


def test_rescale_dets_maps_back_to_frame_coords():
    dets = [[10.0, 20.0, 30.0, 40.0, 0.8]]
    out = rescale_dets(dets, sx=2.0, sy=0.5)
    assert out == [[20.0, 10.0, 60.0, 20.0, 0.8]]


def test_ensure_model_downloads_once_atomically(tmp_path):
    calls = []

    def fake_retrieve(url, dest):
        calls.append((url, dest))
        with open(dest, "wb") as f:
            f.write(b"onnx-bytes")

    path = ensure_model(str(tmp_path / "models"), "https://x/centerface.onnx", retrieve=fake_retrieve)
    assert path.endswith("centerface.onnx")
    assert calls and calls[0][1].endswith(".part")  # temp file then rename
    with open(path, "rb") as f:
        assert f.read() == b"onnx-bytes"

    # Second call: cached, no new download.
    again = ensure_model(str(tmp_path / "models"), "https://x/centerface.onnx", retrieve=fake_retrieve)
    assert again == path
    assert len(calls) == 1
