"""LineCrossingCounter guards + occupancy accounting + the capacity edge."""
from people_counter_worker.counter import CapacityAlert, LineCrossingCounter

A, B = (0.2, 0.5), (0.8, 0.5)  # horizontal mid-line, inside = below ('right')


def make(**kw):
    kw.setdefault("cooldown_frames", 3)
    return LineCrossingCounter(A, B, "right", **kw)


def walk(counter, track_id, ys, x=0.5, start_frame=0):
    """Feed a vertical walk; returns the list of non-None directions."""
    out = []
    for i, y in enumerate(ys):
        d = counter.check(track_id, (x, y), start_frame + i)
        if d:
            out.append(d)
    return out


# A walking-pace approach/cross/leave (each step below the max_jump guard).
WALK_IN = [0.32, 0.44, 0.56, 0.68]
WALK_OUT = list(reversed(WALK_IN))


class TestCounting:
    def test_walk_in_counts_once(self):
        c = make()
        assert walk(c, 1, WALK_IN) == ["in"]
        assert (c.total_in, c.total_out, c.occupancy) == (1, 0, 1)

    def test_walk_out_counts_once(self):
        c = make()
        assert walk(c, 1, WALK_OUT) == ["out"]
        assert (c.total_in, c.total_out) == (0, 1)

    def test_occupancy_never_negative(self):
        # Two people leave a space we never saw them enter.
        c = make()
        walk(c, 1, WALK_OUT)
        walk(c, 2, WALK_OUT)
        assert c.total_out == 2
        assert c.occupancy == 0  # clamped, exactly like Vision One

    def test_in_then_out_balances(self):
        c = make()
        walk(c, 1, WALK_IN)
        walk(c, 2, WALK_IN)
        walk(c, 3, WALK_OUT)
        assert (c.total_in, c.total_out, c.occupancy) == (2, 1, 1)

    def test_first_sighting_never_counts(self):
        # A track that APPEARS on the far side did not cross on camera.
        c = make()
        assert c.check(9, (0.5, 0.7), 0) is None
        assert c.total_in == 0


class TestGuards:
    def test_cooldown_blocks_immediate_recross(self):
        # Jitter on the line right after a count must not double-count.
        c = make(cooldown_frames=3)
        assert walk(c, 1, [0.4, 0.45, 0.55, 0.45, 0.55, 0.45]) == ["in"]
        assert (c.total_in, c.total_out) == (1, 0)

    def test_recross_counts_after_cooldown_expires(self):
        c = make(cooldown_frames=2)
        ys = [0.4, 0.45, 0.55, 0.6, 0.6, 0.6, 0.45, 0.4]
        assert walk(c, 1, ys) == ["in", "out"]

    def test_id_switch_jump_is_ignored(self):
        # A displacement above max_jump is a tracker ID switch, not a person
        # teleporting across the line (Vision One's max_crossing_speed guard).
        c = make(max_jump=0.15)
        c.check(1, (0.5, 0.2), 0)
        c.check(1, (0.5, 0.25), 1)
        assert c.check(1, (0.5, 0.8), 2) is None
        assert c.total_in == 0

    def test_small_step_across_still_counts(self):
        c = make(max_jump=0.15)
        assert walk(c, 1, [0.44, 0.47, 0.53]) == ["in"]

    def test_min_track_length_requires_history(self):
        # min_track_length=3: the 2nd sample (history len 2) may not count yet.
        c = make(min_track_length=3)
        c.check(1, (0.5, 0.45), 0)
        assert c.check(1, (0.5, 0.55), 1) is None
        # ...but with enough history the same movement counts.
        assert c.check(1, (0.5, 0.45), 2) == "out"


class TestCleanup:
    def test_vanished_track_far_from_line_is_dropped(self):
        c = make()
        walk(c, 1, [0.1, 0.14])
        assert c.track_count() == 1
        c.cleanup(active_ids=[])
        assert c.track_count() == 0

    def test_track_parked_near_line_is_kept(self):
        # A person standing ON the line who flickers out of detection keeps
        # their history — a re-detection with the same id must not re-count.
        c = make()
        walk(c, 1, [0.45, 0.49])
        c.cleanup(active_ids=[])
        assert c.track_count() == 1

    def test_active_tracks_are_never_dropped(self):
        c = make()
        walk(c, 1, [0.1, 0.14])
        c.cleanup(active_ids=[1])
        assert c.track_count() == 1


class TestCapacityAlert:
    def test_fires_once_at_capacity(self):
        a = CapacityAlert(2)
        assert a.update(1) is False
        assert a.update(2) is True
        assert a.update(3) is False  # still over — no spam
        assert a.update(2) is False

    def test_rearms_after_dropping_below(self):
        a = CapacityAlert(2)
        assert a.update(2) is True
        assert a.update(1) is False  # drops below → re-arms silently
        assert a.update(2) is True

    def test_zero_capacity_disables(self):
        a = CapacityAlert(0)
        assert not a.enabled
        assert a.update(100) is False

    def test_negative_capacity_disables(self):
        assert CapacityAlert(-5).update(1) is False
