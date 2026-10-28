"""
Work-hours schedule (pure, unit-tested).

PPE rules usually apply during work hours only; outside them the worker idles
(no inference, no events). Two independent config strings:

  hours: "HH:MM-HH:MM"  e.g. "08:00-18:00"; overnight shifts wrap ("22:00-06:00").
  days:  day names/ranges/lists — "mon-fri", "mon,wed,fri", "sat-sun" — or ISO
         numbers where 1=Monday … 7=Sunday ("1-5", "6,7").

Empty or malformed specs mean ALWAYS ON (fail open: a config typo must never
silently disable a safety monitor). Times are the HOST's local time.
"""
from __future__ import annotations

import datetime as _dt
import re

_DAY_BY_NAME = {
    "mon": 0, "monday": 0,
    "tue": 1, "tues": 1, "tuesday": 1,
    "wed": 2, "wednesday": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
    "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5,
    "sun": 6, "sunday": 6,
}

Hours = tuple[int, int]  # (start, end) minutes since midnight; start==end → 24h


def parse_hours(raw: str | None) -> Hours | None:
    """'08:00-18:00' → (480, 1080). None/empty/malformed → None (always on)."""
    if not raw or not str(raw).strip():
        return None
    m = re.fullmatch(
        r"\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*", str(raw)
    )
    if not m:
        return None
    h1, m1, h2, m2 = (int(g) for g in m.groups())
    if h1 > 23 or h2 > 23 or m1 > 59 or m2 > 59:
        return None
    return (h1 * 60 + m1, h2 * 60 + m2)


def _parse_day_token(token: str) -> int | None:
    token = token.strip().lower()
    if token in _DAY_BY_NAME:
        return _DAY_BY_NAME[token]
    if re.fullmatch(r"[1-7]", token):
        return int(token) - 1  # ISO: 1=Monday → 0-based weekday()
    return None


def parse_days(raw: str | None) -> set[int] | None:
    """Day spec → set of `datetime.weekday()` ints (0=Mon). None → every day.

    Any unparseable token invalidates the whole spec (→ None, always on),
    matching the fail-open policy.
    """
    if not raw or not str(raw).strip():
        return None
    days: set[int] = set()
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_raw, _, hi_raw = part.partition("-")
            lo, hi = _parse_day_token(lo_raw), _parse_day_token(hi_raw)
            if lo is None or hi is None:
                return None
            if lo <= hi:
                days.update(range(lo, hi + 1))
            else:  # wrapping range, e.g. "sat-mon"
                days.update(range(lo, 7))
                days.update(range(0, hi + 1))
        else:
            d = _parse_day_token(part)
            if d is None:
                return None
            days.add(d)
    return days or None


def in_schedule(
    when: _dt.datetime, hours: Hours | None, days: set[int] | None
) -> bool:
    """Is `when` inside the configured work schedule?"""
    if days is not None and when.weekday() not in days:
        return False
    if hours is None:
        return True
    start, end = hours
    minute = when.hour * 60 + when.minute
    if start == end:
        return True  # degenerate spec = the whole day
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end  # overnight wrap
