"""StreamHub people-counter worker — realtime line-crossing people counting.

YOLOv8 person detection + ByteTrack tracking over an app's live HLS stream;
counts IN/OUT crossings of an operator-drawn line, keeps live occupancy,
fires capacity alerts, and persists everything to a per-plugin SQLite DB.

Counting/tracking approach ported from Vision One
(streamhub-vision-one: vision_one/models/people_counting/counting.py and
custom_bytetrack_persons.yaml) — see geometry.py / counter.py / trackers/.
"""

__version__ = "1.0.0"
