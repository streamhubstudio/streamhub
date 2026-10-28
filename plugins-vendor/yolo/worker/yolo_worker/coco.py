"""
COCO class helpers — pure, no heavy deps (unit-tested).

The 80 COCO class names in the canonical ultralytics order (index == class id).
Kept here so both the class filter and any tooling share ONE source of truth.
"""
from __future__ import annotations

from typing import Iterable

COCO_CLASSES: list[str] = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon",
    "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
    "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
    "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]

_NAME_TO_ID: dict[str, int] = {name: i for i, name in enumerate(COCO_CLASSES)}


def parse_classes(csv: str | None) -> list[str]:
    """Split a comma-separated class filter into a clean, de-duped name list.

    Empty / None → [] (meaning "all classes"). Unknown names are dropped (a
    typo never silently disables detection of everything).
    """
    if not csv:
        return []
    seen: dict[str, None] = {}
    for raw in csv.split(","):
        name = raw.strip().lower()
        if name and name in _NAME_TO_ID and name not in seen:
            seen[name] = None
    return list(seen.keys())


def names_to_ids(names: Iterable[str]) -> list[int]:
    """Map class names to COCO ids, skipping unknowns. Sorted for determinism."""
    ids = {_NAME_TO_ID[n] for n in names if n in _NAME_TO_ID}
    return sorted(ids)


def id_to_name(class_id: int) -> str:
    """COCO id → name, or 'class_<id>' if out of range."""
    if 0 <= class_id < len(COCO_CLASSES):
        return COCO_CLASSES[class_id]
    return f"class_{class_id}"
