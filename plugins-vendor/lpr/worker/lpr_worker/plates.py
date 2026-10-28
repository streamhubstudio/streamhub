"""
Plate text handling — PURE functions (unit-tested, no deps).

Normalization makes matching case/separator-insensitive: `ab-123 cd` and
`AB123CD` are the same plate. Whitelist/blacklist values are parsed from the
plugin config's comma/newline-separated strings and normalized the same way,
so an operator can paste plates in any familiar format.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

_NON_ALNUM = re.compile(r"[^A-Z0-9]+")
_SPLIT = re.compile(r"[,;\n\r]+")


def normalize_plate(raw: object) -> str:
    """Canonical plate form: uppercase A–Z0–9 only (spaces/dashes/dots gone).

    Anything non-string or that normalizes to empty returns ''.
    """
    if not isinstance(raw, str):
        return ""
    return _NON_ALNUM.sub("", raw.upper())


def parse_plate_list(raw: object) -> list[str]:
    """Parse a comma/semicolon/newline-separated plate list into normalized,
    de-duplicated plates (original order kept). '' / None → [].
    """
    if not isinstance(raw, str) or not raw.strip():
        return []
    out: list[str] = []
    seen: set[str] = set()
    for chunk in _SPLIT.split(raw):
        plate = normalize_plate(chunk)
        if plate and plate not in seen:
            seen.add(plate)
            out.append(plate)
    return out


def match_list(
    plate: str,
    whitelist: Iterable[str],
    blacklist: Iterable[str],
) -> Optional[str]:
    """Which list a NORMALIZED plate belongs to: 'blacklist' | 'whitelist' | None.

    A plate present on BOTH lists is DENIED — blacklist wins (the safe default
    for a barrier: a revoked plate must not slip through via a stale whitelist
    entry).
    """
    if plate in set(blacklist):
        return "blacklist"
    if plate in set(whitelist):
        return "whitelist"
    return None


def events_for(list_match: Optional[str]) -> list[str]:
    """The event names one accepted read emits: `plate.detected` always, plus
    the list verdict when there is one.
    """
    events = ["plate.detected"]
    if list_match == "whitelist":
        events.append("plate.allowed")
    elif list_match == "blacklist":
        events.append("plate.denied")
    return events
