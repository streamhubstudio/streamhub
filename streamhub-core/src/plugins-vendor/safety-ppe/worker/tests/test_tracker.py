"""Sustained-violation counting + per-zone cooldown."""
from safety_ppe_worker.tracker import ViolationTracker


def test_fires_only_after_sustain_frames_exceeded():
    t = ViolationTracker(sustain_frames=3, cooldown_seconds=120)
    # Frames 1..3: streak building, nothing fires ("> N frames" semantics).
    for _ in range(3):
        assert t.update("dock", {"helmet"}, 0.9, now=100.0) is None
    # 4th consecutive frame → event.
    ev = t.update("dock", {"helmet"}, 0.9, now=101.0)
    assert ev == {"zone": "dock", "missing": ["helmet"], "confidence": 0.9}


def test_streak_resets_when_item_reappears():
    t = ViolationTracker(sustain_frames=2, cooldown_seconds=0)
    assert t.update("z", {"helmet"}, 0.9, 0.0) is None
    assert t.update("z", {"helmet"}, 0.9, 1.0) is None
    # Helmet back on → streak resets…
    assert t.update("z", set(), 0.0, 2.0) is None
    assert t.streak("z", "helmet") == 0
    # …so the count starts over.
    assert t.update("z", {"helmet"}, 0.9, 3.0) is None
    assert t.update("z", {"helmet"}, 0.9, 4.0) is None
    assert t.update("z", {"helmet"}, 0.9, 5.0) is not None


def test_cooldown_suppresses_refire_until_elapsed():
    t = ViolationTracker(sustain_frames=0, cooldown_seconds=120)
    assert t.update("z", {"vest"}, 0.8, now=1000.0) is not None
    # Still missing every frame — suppressed inside the window.
    assert t.update("z", {"vest"}, 0.8, now=1060.0) is None
    assert t.update("z", {"vest"}, 0.8, now=1119.9) is None
    # Window over → fires again.
    assert t.update("z", {"vest"}, 0.8, now=1120.0) is not None


def test_cooldown_is_per_zone_and_per_item():
    t = ViolationTracker(sustain_frames=0, cooldown_seconds=120)
    assert t.update("a", {"helmet"}, 0.9, 0.0) is not None
    # Same item, other zone: independent.
    assert t.update("b", {"helmet"}, 0.9, 1.0) is not None
    # Same zone, other item: independent.
    assert t.update("a", {"vest"}, 0.9, 2.0) is not None
    # Same zone + item: cooled down.
    assert t.update("a", {"helmet"}, 0.9, 3.0) is None


def test_items_firing_together_group_into_one_event():
    t = ViolationTracker(sustain_frames=1, cooldown_seconds=120)
    assert t.update("z", {"helmet", "vest"}, 0.7, 0.0) is None
    ev = t.update("z", {"helmet", "vest"}, 0.7, 1.0)
    assert ev == {"zone": "z", "missing": ["helmet", "vest"], "confidence": 0.7}


def test_item_joining_later_fires_its_own_event():
    t = ViolationTracker(sustain_frames=1, cooldown_seconds=120)
    t.update("z", {"helmet"}, 0.7, 0.0)
    ev1 = t.update("z", {"helmet", "vest"}, 0.7, 1.0)  # helmet crosses now
    assert ev1["missing"] == ["helmet"]
    ev2 = t.update("z", {"helmet", "vest"}, 0.7, 2.0)  # vest crosses next
    assert ev2["missing"] == ["vest"]


def test_reset_clears_streaks_but_keeps_cooldowns():
    t = ViolationTracker(sustain_frames=1, cooldown_seconds=120)
    t.update("z", {"helmet"}, 0.9, 0.0)
    ev = t.update("z", {"helmet"}, 0.9, 1.0)
    assert ev is not None
    t.reset()  # e.g. off-schedule gap
    assert t.streak("z", "helmet") == 0
    # Streak must rebuild AND cooldown still applies — no immediate refire.
    t.update("z", {"helmet"}, 0.9, 2.0)     # streak 1 (rebuilding)
    assert t.update("z", {"helmet"}, 0.9, 3.0) is None  # sustained but cooled down
    # After the window, the still-sustained streak fires again.
    assert t.update("z", {"helmet"}, 0.9, 130.0) is not None


def test_zone_names_do_not_leak_streaks_between_zones():
    t = ViolationTracker(sustain_frames=2, cooldown_seconds=0)
    t.update("a", {"helmet"}, 0.9, 0.0)
    t.update("a", {"helmet"}, 0.9, 1.0)
    # Zone b never accumulated anything.
    assert t.update("b", {"helmet"}, 0.9, 2.0) is None
    assert t.streak("a", "helmet") == 2
    assert t.streak("b", "helmet") == 1
