"""
StreamHub YOLO worker.

A per-app worker (spawned by the streamhub-core `yolo` plugin via the framework
worker-hook, or run standalone in Docker) that:

  1. pulls the app's live stream over HLS  (/hls/<app>/<room>/index.m3u8),
  2. samples frames at a target FPS,
  3. runs ultralytics YOLO inference on each frame,
  4. POSTs the detections for any frame that has them to the configured
     callback URL as {app, room, ts, detections:[{class, conf, bbox}]},
  5. logs structured JSON lines to stdout (mirrored into the plugin logs UI by
     the core worker-hook).

The heavy deps (opencv, ultralytics/torch) are imported lazily so the pure
config / coco / callback logic stays unit-testable without them installed.
"""

__version__ = "1.0.0"
