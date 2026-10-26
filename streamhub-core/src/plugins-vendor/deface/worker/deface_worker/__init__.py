"""
StreamHub deface worker — face obfuscation (based on ORB-HD/deface).

A per-app worker (spawned by the streamhub-core `deface` plugin via the
framework worker-hook, or run standalone in Docker) that:

  1. pulls the app's live stream over HLS  (/hls/<app>/<room>/index.m3u8),
  2. samples frames at a target FPS,
  3. runs CENTERFACE face detection (the ONNX model deface uses) on each frame,
  4. expands each box by the configured mask scale (deface --mask-scale) and
     POSTs NORMALIZED face boxes + scores for EVERY sampled frame to the
     callback URL (by default the core's plugin live-data channel, so the
     player overlay can obfuscate the regions client-side),
  5. logs structured JSON lines to stdout (mirrored into the plugin logs UI by
     the core worker-hook).

The heavy deps (opencv, onnxruntime) are imported lazily so the pure config /
geometry / decode / callback logic stays unit-testable without them installed.
"""

__version__ = "1.0.0"
