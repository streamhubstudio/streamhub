"""Schedule logic: window/day parsing, overnight windows, tz-aware contains."""
from datetime import datetime, timezone

from presence_worker.schedule import (
    Schedule,
    in_window,
    parse_days,
    parse_window,
)


def ts(y, mo, d, h, mi):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp()


def test_parse_window():
    assert parse_window("08:00-18:00") == (480, 1080)
    assert parse_window(" 9:30-17:05 ") == (570, 1025)
    assert parse_window("22:00-06:00") == (1320, 360)  # overnight
    assert parse_window("") is None
    assert parse_window(None) is None
    assert parse_window("8-18") is None
    assert parse_window("25:00-26:00") is None
    assert parse_window("08:99-18:00") is None
    assert parse_window("08:00-08:00") is None  # zero-length = disabled


def test_parse_days_lists_ranges_and_wrap():
    assert parse_days("mon-fri") == {0, 1, 2, 3, 4}
    assert parse_days("mon,wed,fri") == {0, 2, 4}
    assert parse_days("sat-sun") == {5, 6}
    assert parse_days("fri-mon") == {4, 5, 6, 0}  # wrap-around
    assert parse_days("Monday, TUESDAY") == {0, 1}  # 3-letter prefixes
    assert parse_days("") == set(range(7))
    assert parse_days(None) == set(range(7))
    assert parse_days("weekdays") == set(range(7))  # unparseable = every day


def test_in_window_normal_and_overnight():
    day = (480, 1080)  # 08:00-18:00
    assert not in_window(479, day)
    assert in_window(480, day)
    assert in_window(1079, day)
    assert not in_window(1080, day)  # end exclusive

    night = (1320, 360)  # 22:00-06:00
    assert in_window(1320, night)
    assert in_window(0, night)
    assert in_window(359, night)
    assert not in_window(360, night)
    assert not in_window(720, night)


def test_schedule_contains_utc():
    # 2026-01-05 is a Monday.
    s = Schedule.from_strings("08:00-18:00", "mon-fri", "UTC")
    assert s.enabled
    assert s.contains(ts(2026, 1, 5, 9, 0))       # Mon 09:00 → in
    assert not s.contains(ts(2026, 1, 5, 19, 0))  # Mon 19:00 → after hours
    assert not s.contains(ts(2026, 1, 5, 7, 59))  # Mon 07:59 → before hours
    assert not s.contains(ts(2026, 1, 10, 9, 0))  # Sat 09:00 → off day


def test_schedule_overnight_window():
    s = Schedule.from_strings("22:00-06:00", "", "UTC")
    assert s.contains(ts(2026, 1, 5, 23, 0))
    assert s.contains(ts(2026, 1, 6, 5, 59))
    assert not s.contains(ts(2026, 1, 6, 12, 0))


def test_disabled_schedule_contains_everything():
    s = Schedule.from_strings("", "mon-fri", "UTC")
    assert not s.enabled
    assert s.contains(ts(2026, 1, 10, 3, 0))  # Saturday 03:00 still "in"


def test_named_timezone_shifts_the_window():
    # 12:00 UTC = 09:00 in America/Argentina/Buenos_Aires (UTC-3, no DST).
    s = Schedule.from_strings(
        "08:00-18:00", "mon-fri", "America/Argentina/Buenos_Aires"
    )
    assert s.contains(ts(2026, 1, 5, 12, 0))       # Mon 09:00 local → in
    assert not s.contains(ts(2026, 1, 5, 10, 30))  # Mon 07:30 local → out
    # An invalid tz name falls back to local time and never crashes.
    fallback = Schedule.from_strings("08:00-18:00", "mon-fri", "Not/AZone")
    assert fallback.tz is None
