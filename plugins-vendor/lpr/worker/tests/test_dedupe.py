from lpr_worker.dedupe import DedupeWindow


def test_same_plate_within_window_is_one_event():
    d = DedupeWindow(10.0)
    assert d.should_emit("AB123CD", 100.0) is True
    assert d.should_emit("AB123CD", 104.0) is False
    assert d.should_emit("AB123CD", 109.9) is False


def test_window_anchors_on_last_emit_not_last_sighting():
    d = DedupeWindow(10.0)
    assert d.should_emit("AB123CD", 100.0) is True
    # Suppressed sightings do NOT extend the window…
    assert d.should_emit("AB123CD", 105.0) is False
    assert d.should_emit("AB123CD", 109.0) is False
    # …so an idling car re-emits exactly one window after the last EMIT.
    assert d.should_emit("AB123CD", 110.0) is True
    assert d.should_emit("AB123CD", 115.0) is False


def test_different_plates_are_independent():
    d = DedupeWindow(10.0)
    assert d.should_emit("AB123CD", 100.0) is True
    assert d.should_emit("XX999XX", 100.5) is True
    assert d.should_emit("AB123CD", 101.0) is False
    assert d.should_emit("XX999XX", 101.0) is False


def test_zero_window_disables_dedupe():
    d = DedupeWindow(0)
    assert d.should_emit("AB123CD", 100.0) is True
    assert d.should_emit("AB123CD", 100.0) is True
    assert d.should_emit("AB123CD", 100.1) is True


def test_negative_window_clamps_to_disabled():
    d = DedupeWindow(-5)
    assert d.window_sec == 0.0
    assert d.should_emit("AB123CD", 1.0) is True
    assert d.should_emit("AB123CD", 1.0) is True


def test_prune_drops_expired_entries_only():
    d = DedupeWindow(10.0)
    d.should_emit("OLD1", 100.0)
    d.should_emit("OLD2", 102.0)
    d.should_emit("FRESH", 115.0)
    assert len(d) == 3
    d.prune(120.0)  # cutoff 110: OLD1/OLD2 expired, FRESH kept
    assert len(d) == 1
    # An expired plate emits again immediately.
    assert d.should_emit("OLD1", 120.5) is True
    assert d.should_emit("FRESH", 120.5) is False
