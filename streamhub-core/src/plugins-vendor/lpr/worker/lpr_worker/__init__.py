"""
StreamHub LPR worker — realtime license-plate recognition (ALPR).

A per-app worker (spawned by the streamhub-core `lpr` plugin via the framework
worker-hook, or run standalone on an edge box) that:

  1. pulls a live stream (HLS /hls/<app>/<room>/index.m3u8, or any LPR_SOURCE
     URL OpenCV can open — e.g. an RTSP gate camera),
  2. samples frames at a target FPS,
  3. runs fast-alpr (MIT: YOLOv9-t ONNX plate detection + fast-plate-ocr ONNX
     OCR — open-source models only, CPU-friendly) on each frame,
  4. normalizes each read (uppercase, separators stripped), deduplicates it
     (same plate within the dedupe window = ONE event) and matches it against
     the whitelist/blacklist,
  5. emits `plate.detected` (always) + `plate.allowed`/`plate.denied` to the
     framework EVENT channel (→ app signed callbacks) and to the optional
     direct callback URL (e.g. a barrier opener),
  6. persists every read to a local SQLite (`<LPR_DATA_DIR>/lpr.db`) + saves a
     JPEG snapshot, and pushes a rolling "recent reads" payload to the
     live-data channel for the dashboard panel,
  7. logs structured JSON lines to stdout (mirrored into the plugin logs UI).

The heavy deps (opencv, fast-alpr/onnxruntime) are imported lazily so the pure
plates / dedupe / store / config / callback logic stays unit-testable without
them installed.
"""

__version__ = "1.0.0"
