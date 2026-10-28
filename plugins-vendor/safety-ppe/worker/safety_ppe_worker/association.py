"""
Person ↔ PPE association + per-zone frame analysis (pure, unit-tested).

This is the heart of the plugin: given one frame's role detections
(person/helmet/no_helmet/vest/no_vest, normalized boxes), decide PER ZONE which
persons are missing which required items.

Association metric: CONTAINMENT of the PPE item box inside the (slightly
margin-expanded) person box — not IoU, because a helmet is tiny relative to a
person so IoU is near zero even for a perfect wear. The margin tolerates worn
helmets whose box pokes above the detected person box.

Presence rule per item: take the best-confidence associated POSITIVE detection
(helmet/vest) and the best associated NEGATIVE one (no_helmet/no_vest — the
model emits explicit violation classes). The item is PRESENT iff a positive
exists and beats the negative; an explicit negative overrides a weaker
positive. A required item that is not present is MISSING — so a person with no
helmet detection at all (occlusion, distance) still counts as missing, which
errs on the safe side for a safety monitor.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from .classes import ITEMS
from .geometry import containment, expand_box
from .zones import Zone, zones_containing

#: Default: at least half of the item box must lie inside the person box.
DEFAULT_ASSOC_THRESHOLD = 0.5
#: Person-box expansion per side (fraction of the dimension) before association.
DEFAULT_PERSON_MARGIN = 0.1

_POSITIVE = {"helmet": "helmet", "vest": "vest"}
_NEGATIVE = {"helmet": "no_helmet", "vest": "no_vest"}


def best_associated_conf(
    person_box: Sequence[float],
    items: Iterable[Mapping[str, Any]],
    assoc_threshold: float,
    margin: float,
) -> float:
    """Highest confidence among `items` associated to the person (0.0 if none).

    An item is associated when containment(item, expanded person) reaches
    `assoc_threshold`.
    """
    expanded = expand_box(person_box, margin)
    best = 0.0
    for it in items:
        if containment(it["bbox"], expanded) >= assoc_threshold:
            best = max(best, float(it["conf"]))
    return best


def person_status(
    person: Mapping[str, Any],
    dets: Sequence[Mapping[str, Any]],
    require: Iterable[str],
    assoc_threshold: float = DEFAULT_ASSOC_THRESHOLD,
    margin: float = DEFAULT_PERSON_MARGIN,
) -> dict[str, Any]:
    """PPE status of one person: which required items are missing.

    Returns { "missing": set[str], "confidence": float } — confidence is the
    person detection's own score (how sure we are a person is there at all).
    """
    missing: set[str] = set()
    for item in require:
        if item not in ITEMS:
            continue
        positives = [d for d in dets if d["role"] == _POSITIVE[item]]
        negatives = [d for d in dets if d["role"] == _NEGATIVE[item]]
        pos = best_associated_conf(person["bbox"], positives, assoc_threshold, margin)
        neg = best_associated_conf(person["bbox"], negatives, assoc_threshold, margin)
        present = pos > 0.0 and pos >= neg
        if not present:
            missing.add(item)
    return {"missing": missing, "confidence": float(person["conf"])}


def analyze_frame(
    dets: Sequence[Mapping[str, Any]],
    zones: Sequence[Zone],
    require: Iterable[str],
    assoc_threshold: float = DEFAULT_ASSOC_THRESHOLD,
    margin: float = DEFAULT_PERSON_MARGIN,
) -> dict[str, dict[str, Any]]:
    """One frame's detections → per-zone report.

    Every zone gets an entry (so the tracker can RESET streaks for zones that
    are currently clean):

      zone name → {
        "persons":    int        persons anchored in the zone,
        "missing":    set[str]   union of items missing across its offenders,
        "confidence": float      max offender person confidence (0.0 if clean),
        "offenders":  [ { "bbox", "missing": sorted list, "confidence" } ],
      }
    """
    require = [i for i in require if i in ITEMS]
    report: dict[str, dict[str, Any]] = {
        z.name: {"persons": 0, "missing": set(), "confidence": 0.0, "offenders": []}
        for z in zones
    }
    if not require:
        return report

    persons = [d for d in dets if d["role"] == "person"]
    for person in persons:
        zone_names = zones_containing(person["bbox"], zones)
        if not zone_names:
            continue
        status = person_status(person, dets, require, assoc_threshold, margin)
        for name in zone_names:
            entry = report[name]
            entry["persons"] += 1
            if status["missing"]:
                entry["missing"] |= status["missing"]
                entry["confidence"] = max(entry["confidence"], status["confidence"])
                entry["offenders"].append(
                    {
                        "bbox": list(person["bbox"]),
                        "missing": sorted(status["missing"]),
                        "confidence": status["confidence"],
                    }
                )
    return report
