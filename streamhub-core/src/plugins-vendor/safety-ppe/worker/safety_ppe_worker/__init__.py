"""StreamHub safety-ppe worker — realtime PPE (helmet/vest) violation detection.

HLS in → ONNX PPE inference → person↔PPE association per work zone →
sustained-violation tracking → evidence snapshot + SQLite row + signed
`ppe.violation` callback POST.
"""

__version__ = "1.0.0"
