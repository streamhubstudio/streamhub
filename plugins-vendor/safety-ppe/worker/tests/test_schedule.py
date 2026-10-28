"""Work-hours schedule parsing + evaluation."""
import datetime as dt

from safety_ppe_worker.schedule import in_schedule, parse_days, parse_hours


def at(day: int, hour: int, minute: int = 0) -> dt.datetime:
    # 2026-07-06 is a Monday → weekday() == 0.
    base = dt.datetime(2026, 7, 6)
    return base + dt.timedelta(days=day, hours=hour, minutes=minute)


def test_parse_hours_valid_and_bounds():
    assert parse_hours("08:00-18:00") == (480, 1080)
    assert parse_hours(" 8:05 - 18:30 ") == (485, 1110)
    assert parse_hours("22:00-06:00") == (1320, 360)  # overnight allowed


def test_parse_hours_malformed_is_always_on():
    for raw in (None, "", "8-18", "08:00", "25:00-26:00", "08:60-09:00", "junk"):
        assert parse_hours(raw) is None


def test_parse_days_names_ranges_numbers():
    assert parse_days("mon-fri") == {0, 1, 2, 3, 4}
    assert parse_days("mon,wed,fri") == {0, 2, 4}
    assert parse_days("1-5") == {0, 1, 2, 3, 4}  # ISO: 1=Mon
    assert parse_days("6,7") == {5, 6}
    assert parse_days("sat-mon") == {5, 6, 0}  # wrapping range


def test_parse_days_malformed_is_always_on():
    for raw in (None, "", "funday", "0-5", "mon-funday", "8"):
        assert parse_days(raw) is None


def test_in_schedule_hours_window():
    hours = parse_hours("08:00-18:00")
    assert in_schedule(at(0, 8, 0), hours, None) is True     # start inclusive
    assert in_schedule(at(0, 17, 59), hours, None) is True
    assert in_schedule(at(0, 18, 0), hours, None) is False   # end exclusive
    assert in_schedule(at(0, 7, 59), hours, None) is False


def test_in_schedule_overnight_wrap():
    hours = parse_hours("22:00-06:00")
    assert in_schedule(at(0, 23, 0), hours, None) is True
    assert in_schedule(at(0, 2, 0), hours, None) is True
    assert in_schedule(at(0, 12, 0), hours, None) is False


def test_in_schedule_days_filter():
    days = parse_days("mon-fri")
    assert in_schedule(at(0, 10), None, days) is True   # Monday
    assert in_schedule(at(5, 10), None, days) is False  # Saturday
    assert in_schedule(at(6, 10), None, days) is False  # Sunday


def test_in_schedule_combined_and_empty_means_always():
    hours, days = parse_hours("08:00-18:00"), parse_days("mon-fri")
    assert in_schedule(at(0, 10), hours, days) is True
    assert in_schedule(at(5, 10), hours, days) is False   # right hour, wrong day
    assert in_schedule(at(0, 20), hours, days) is False   # right day, wrong hour
    assert in_schedule(at(6, 3), None, None) is True      # no schedule → always


def test_degenerate_equal_bounds_means_whole_day():
    assert in_schedule(at(0, 0, 0), (540, 540), None) is True
    assert in_schedule(at(0, 23, 59), (540, 540), None) is True
