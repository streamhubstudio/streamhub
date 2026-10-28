"""
Arming schedule — pure datetime logic (unit-tested, no clock access here).

The perimeter is ARMED when intrusions should alert:
  - `armMode` config: 'armed' / 'disarmed' force the state (manual override);
    'schedule' (default) evaluates the window + weekend rules below.
  - `armSchedule` is a daily "HH:MM-HH:MM" window (e.g. "22:00-06:00"). A
    window that wraps midnight arms from start until end THE NEXT MORNING.
  - `armWeekends` additionally arms ALL DAY Saturday + Sunday.

TIMEZONE NOTE: the schedule is wall-clock local to `timezone` (an IANA name
like "America/Argentina/Buenos_Aires"). Empty/unknown names fall back to the
HOST's local time — inside Docker that is usually UTC unless TZ is set, so
set `timezone` explicitly when the server clock is not the site's clock.
Callers pass an already-localized datetime into the pure functions here.
"""
from __future__ import annotations

import re
from datetime import datetime, tzinfo

ARM_MODES = {"schedule", "armed", "disarmed"}

_WINDOW_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$")

Window = tuple[int, int]  # (start, end) minutes of day, end exclusive


def parse_window(raw: str | None) -> Window | None:
    """Parse "HH:MM-HH:MM" into minutes-of-day (start, end).

    Returns None (= no daily window) for empty/malformed specs or out-of-range
    times, and for a zero-length window ("22:00-22:00") — a typo must never
    silently arm 24/7. End is exclusive; start > end wraps past midnight.
    """
    if not raw:
        return None
    m = _WINDOW_RE.match(raw)
    if not m:
        return None
    h1, m1, h2, m2 = (int(g) for g in m.groups())
    if h1 > 23 or h2 > 23 or m1 > 59 or m2 > 59:
        return None
    start, end = h1 * 60 + m1, h2 * 60 + m2
    if start == end:
        return None
    return (start, end)


def window_contains(window: Window | None, minute_of_day: int) -> bool:
    """Is a minute-of-day inside the window? Handles the overnight wrap:
    (1320, 360) = 22:00-06:00 contains 23:59 and 05:59 but not 06:00.
    """
    if window is None:
        return False
    start, end = window
    if start < end:
        return start <= minute_of_day < end
    return minute_of_day >= start or minute_of_day < end


def is_weekend(dt: datetime) -> bool:
    """Saturday/Sunday by the datetime's own (already localized) calendar."""
    return dt.weekday() >= 5


def armed_by_schedule(dt: datetime, window: Window | None, weekends: bool) -> bool:
    """Schedule verdict for a localized datetime: weekend rule OR daily window."""
    if weekends and is_weekend(dt):
        return True
    return window_contains(window, dt.hour * 60 + dt.minute)


def effective_armed(
    mode: str,
    dt: datetime,
    window: Window | None,
    weekends: bool,
) -> bool:
    """The single arming decision: manual override wins, else the schedule."""
    if mode == "armed":
        return True
    if mode == "disarmed":
        return False
    return armed_by_schedule(dt, window, weekends)


def resolve_tz(name: str | None) -> tzinfo | None:
    """IANA timezone name → tzinfo, or None (= host local time) when the name
    is empty or unknown. Never raises — see the module TIMEZONE NOTE.
    """
    if not name or not name.strip():
        return None
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name.strip())
    except Exception:  # noqa: BLE001 - unknown tz / missing tzdata
        return None
