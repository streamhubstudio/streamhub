from datetime import datetime
from zoneinfo import ZoneInfo

from perimeter_worker.schedule import (
    armed_by_schedule,
    effective_armed,
    is_weekend,
    parse_window,
    resolve_tz,
    window_contains,
)

NIGHT = parse_window("22:00-06:00")  # overnight wrap
DAY = parse_window("09:00-17:00")


def test_parse_window():
    assert NIGHT == (22 * 60, 6 * 60)
    assert DAY == (9 * 60, 17 * 60)
    assert parse_window("7:5-8:30") is None  # minutes must be 2 digits
    assert parse_window("7:05-8:30") == (7 * 60 + 5, 8 * 60 + 30)
    assert parse_window("") is None
    assert parse_window(None) is None
    assert parse_window("25:00-06:00") is None
    assert parse_window("22:00-06:60") is None
    assert parse_window("garbage") is None
    # zero-length window = never armed (a typo must not arm 24/7)
    assert parse_window("22:00-22:00") is None


def test_window_contains_handles_overnight_wrap():
    assert window_contains(NIGHT, 23 * 60) is True
    assert window_contains(NIGHT, 2 * 60) is True
    assert window_contains(NIGHT, 5 * 60 + 59) is True
    assert window_contains(NIGHT, 6 * 60) is False  # end exclusive
    assert window_contains(NIGHT, 12 * 60) is False
    assert window_contains(NIGHT, 22 * 60) is True  # start inclusive
    assert window_contains(DAY, 12 * 60) is True
    assert window_contains(DAY, 8 * 60) is False
    assert window_contains(None, 12 * 60) is False


def test_weekend_rule_arms_all_day():
    sat_noon = datetime(2026, 7, 11, 12, 0)  # Saturday
    mon_noon = datetime(2026, 7, 13, 12, 0)  # Monday
    assert is_weekend(sat_noon) is True
    assert is_weekend(mon_noon) is False
    assert armed_by_schedule(sat_noon, NIGHT, weekends=True) is True
    assert armed_by_schedule(sat_noon, NIGHT, weekends=False) is False
    assert armed_by_schedule(mon_noon, NIGHT, weekends=True) is False
    # weeknight window still applies with weekends on
    mon_night = datetime(2026, 7, 13, 23, 30)
    assert armed_by_schedule(mon_night, NIGHT, weekends=True) is True


def test_effective_armed_manual_override_wins():
    sat_noon = datetime(2026, 7, 11, 12, 0)
    mon_noon = datetime(2026, 7, 13, 12, 0)
    assert effective_armed("armed", mon_noon, NIGHT, True) is True
    assert effective_armed("disarmed", sat_noon, NIGHT, True) is False
    assert effective_armed("schedule", sat_noon, NIGHT, True) is True
    assert effective_armed("schedule", mon_noon, NIGHT, True) is False


def test_timezone_changes_the_verdict():
    # 01:30 UTC is inside 22:00-06:00 in UTC, but 22:30 the previous evening
    # in Buenos Aires (UTC-3) — armed in both. 12:00 UTC is 09:00 in BA:
    # disarmed in both. The interesting case: 08:00 UTC = 05:00 BA (armed in
    # BA, disarmed in UTC).
    utc = ZoneInfo("UTC")
    ba = ZoneInfo("America/Argentina/Buenos_Aires")
    t = datetime(2026, 7, 8, 8, 0, tzinfo=utc)  # Wednesday
    assert armed_by_schedule(t, NIGHT, False) is False
    assert armed_by_schedule(t.astimezone(ba), NIGHT, False) is True


def test_resolve_tz_fallbacks():
    assert resolve_tz("") is None
    assert resolve_tz(None) is None
    assert resolve_tz("Not/AZone") is None
    tz = resolve_tz("America/Argentina/Buenos_Aires")
    assert tz is not None
