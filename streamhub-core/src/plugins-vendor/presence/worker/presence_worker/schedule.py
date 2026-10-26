"""
Work-schedule logic — pure functions (unit-tested, stdlib only).

The plugin config declares the WORK window ("08:00-18:00"), the work days
("mon-fri", "mon,wed,fri", …) and an optional IANA timezone. A person present
in a zone OUTSIDE that schedule triggers the `presence.after_hours` event.

Semantics:
  - window "HH:MM-HH:MM"; start > end spans midnight (e.g. "22:00-06:00")
  - the day check uses the CURRENT weekday of the instant being tested
  - an empty/invalid window disables the schedule (after-hours never fires)
  - empty days string = every day
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone, tzinfo

DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_WINDOW_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$")


def parse_window(raw: str | None) -> tuple[int, int] | None:
    """'HH:MM-HH:MM' → (start, end) minutes-since-midnight, or None."""
    if not raw:
        return None
    m = _WINDOW_RE.match(raw)
    if not m:
        return None
    h1, m1, h2, m2 = (int(g) for g in m.groups())
    if h1 > 23 or h2 > 24 or m1 > 59 or m2 > 59:
        return None
    start = h1 * 60 + m1
    end = h2 * 60 + m2
    if start == end:  # zero-length window = no schedule
        return None
    return (start, end)


def _day_index(token: str) -> int | None:
    t = token.strip().lower()[:3]
    return DAY_NAMES.index(t) if t in DAY_NAMES else None


def parse_days(raw: str | None) -> set[int]:
    """Day tokens → weekday indexes (0=mon .. 6=sun).

    Supports comma lists ('mon,wed,fri'), ranges ('mon-fri', wrap-around
    'fri-mon') and mixes. Empty/unparseable input = every day.
    """
    if not raw or not raw.strip():
        return set(range(7))
    out: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            ia, ib = _day_index(a), _day_index(b)
            if ia is None or ib is None:
                continue
            i = ia
            while True:
                out.add(i)
                if i == ib:
                    break
                i = (i + 1) % 7
        else:
            i = _day_index(part)
            if i is not None:
                out.add(i)
    return out or set(range(7))


def in_window(minute_of_day: int, window: tuple[int, int]) -> bool:
    """Is a minute-of-day inside the window? start > end spans midnight."""
    start, end = window
    if start < end:
        return start <= minute_of_day < end
    return minute_of_day >= start or minute_of_day < end


def resolve_tz(name: str | None) -> tzinfo | None:
    """IANA name → tzinfo; ''/invalid → None (server local time)."""
    if not name or not name.strip():
        return None
    if name.strip().upper() == "UTC":
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name.strip())
    except Exception:  # noqa: BLE001 - unknown tz → local time
        return None


@dataclass
class Schedule:
    """The resolved work schedule; `contains(ts)` = 'is this a work instant?'"""

    window: tuple[int, int] | None = None
    days: set[int] = field(default_factory=lambda: set(range(7)))
    tz: tzinfo | None = None

    @classmethod
    def from_strings(
        cls,
        window_raw: str | None,
        days_raw: str | None,
        tz_name: str | None = None,
    ) -> "Schedule":
        return cls(
            window=parse_window(window_raw),
            days=parse_days(days_raw),
            tz=resolve_tz(tz_name),
        )

    @property
    def enabled(self) -> bool:
        return self.window is not None

    def contains(self, ts: float) -> bool:
        """True when the unix timestamp falls inside work days AND window.
        A disabled schedule contains everything (after-hours never fires).
        """
        if self.window is None:
            return True
        dt = datetime.fromtimestamp(ts, self.tz)
        if dt.weekday() not in self.days:
            return False
        return in_window(dt.hour * 60 + dt.minute, self.window)
