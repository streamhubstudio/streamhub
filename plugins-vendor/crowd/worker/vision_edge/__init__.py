"""
StreamHub Vision Edge runtime — the Python package the master orchestrates.

Two run modes (see ``vision_edge.config``):

* ``worker`` — a single model bound to one room, spawned co-located by the
  vision plugin's worker lifecycle (``python -m vision_edge --model … --app …``).
* ``edge``   — a long-lived daemon that dials the master's edge WebSocket out,
  receives assignments and supervises one child ``worker`` process each.

Everything here is env/args driven and imports nothing from the core, so the
same code runs on the master host or on a remote GPU edge. The heavy deps
(ultralytics / opencv / insightface / websockets) are imported lazily inside
the runtime paths only — the pure logic (geometry, zones, samplers, counters,
threshold state, config, event batching, protocol frames) is unit-testable
with no torch/cv2/network, exactly like the other StreamHub *-worker packages.
"""

__version__ = "0.1.0"
