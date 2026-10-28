"""Realtime counting — LineCrossingCounter port + multi-line + config."""
from vision_edge.models.counting import (
    CapacityAlert,
    CountingConfig,
    LineCrossingCounter,
    MultiLineCounter,
)

A = (0.2, 0.5)
B = (0.8, 0.5)


def _counter(**kw):
    kw.setdefault("min_track_length", 1)
    kw.setdefault("cooldown_frames", 3)
    return LineCrossingCounter(A, B, "right", **kw)


def test_single_in_crossing():
    # Movements stay within max_jump (0.1 < 0.15) so the ID-switch guard passes.
    c = _counter()
    assert c.check(1, (0.5, 0.45)) is None           # first sighting
    assert c.check(1, (0.5, 0.55)) == "in"           # crossed downward = in
    assert c.total_in == 1 and c.occupancy == 1


def test_out_crossing():
    c = _counter()
    c.check(2, (0.5, 0.55))
    assert c.check(2, (0.5, 0.45)) == "out"
    assert c.total_out == 1 and c.occupancy == 0     # clamped at 0


def test_cooldown_prevents_double_count():
    c = _counter(cooldown_frames=5)
    c.check(3, (0.5, 0.45))
    assert c.check(3, (0.5, 0.55)) == "in"
    # Immediately bouncing back is swallowed by the cooldown.
    assert c.check(3, (0.5, 0.45)) is None
    assert c.total_in == 1 and c.total_out == 0


def test_id_switch_jump_rejected():
    c = _counter(max_jump=0.15)
    c.check(4, (0.5, 0.45))
    # A huge teleport across the line is a tracker ID switch, not a crossing.
    assert c.check(4, (0.5, 0.95)) is None
    assert c.total_in == 0


def test_min_track_length_guard():
    c = LineCrossingCounter(A, B, "right", min_track_length=3, cooldown_frames=0)
    c.check(5, (0.5, 0.4))   # len 1 (init)
    assert c.check(5, (0.5, 0.6)) is None  # len 2 < 3 → no count yet
    assert c.total_in == 0


def test_slide_along_line_not_counted():
    c = _counter()
    c.check(6, (0.3, 0.4))
    assert c.check(6, (0.7, 0.4)) is None  # moves parallel, never crosses
    assert c.total_in == 0


def test_cleanup_keeps_near_line_track():
    c = _counter()
    c.check(7, (0.5, 0.51))  # parked just below the line
    c.cleanup(active_ids=[])  # 7 not active
    assert c.track_count() == 1  # kept (near line)


def test_cleanup_drops_far_track():
    c = _counter()
    c.check(8, (0.5, 0.95))  # far from the line
    c.cleanup(active_ids=[])
    assert c.track_count() == 0


def test_capacity_alert_fires_once_and_rearms():
    alert = CapacityAlert(2)
    assert alert.update(1) is False
    assert alert.update(2) is True    # reaches capacity → fires
    assert alert.update(3) is False   # stays over → no repeat
    assert alert.update(1) is False   # drops below → re-arms
    assert alert.update(2) is True    # fires again


def test_capacity_alert_disabled():
    assert CapacityAlert(0).enabled is False
    assert CapacityAlert(0).update(100) is False


def test_counting_config_parses_lines():
    cfg = CountingConfig.from_dict({
        "lines": [
            {"id": "door", "tag": "main", "x": 0.5, "y": 0.5, "length": 0.6, "angle": 0.0, "inside": "bottom"},
        ],
        "fps": 4.0,
        "capacity": 50,
    })
    assert len(cfg.lines) == 1
    ln = cfg.lines[0]
    assert ln.id == "door" and ln.tag == "main"
    assert ln.in_side == "right"      # 'bottom' on a horizontal line = right side
    assert cfg.fps == 4.0 and cfg.capacity == 50


def test_counting_config_defaults_fps_and_skips_bad():
    cfg = CountingConfig.from_dict({"lines": [{"id": "l1", "length": 0}, {"id": "l2", "x": 0.5, "y": 0.5, "length": 0.4}]})
    assert cfg.fps == 3.5           # default cadence
    assert [l.id for l in cfg.lines] == ["l2"]  # zero-length skipped


def test_multiline_counter_feeds_all_lines():
    cfg = CountingConfig.from_dict({
        "lines": [
            {"id": "l1", "tag": "t1", "x": 0.5, "y": 0.5, "length": 0.6, "angle": 0.0, "inside": "bottom"},
        ],
        "capacity": 1,
    })
    mc = MultiLineCounter(cfg, min_track_length=1, cooldown_frames=0)
    mc.feed(1, (0.5, 0.45))
    crossings = mc.feed(1, (0.5, 0.55))
    assert len(crossings) == 1
    assert crossings[0]["line"] == "l1" and crossings[0]["direction"] == "in"
    assert crossings[0]["poi"] is None            # no POI configured = whole frame
    assert mc.occupancy == 1
    assert mc.capacity_tripped() is True


def test_counting_config_parses_pois():
    cfg = CountingConfig.from_dict({
        "lines": [{"id": "l1", "x": 0.5, "y": 0.5, "length": 0.6}],
        "pois": [{"id": "aisle", "tag": "aisle-3", "points": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]}],
    })
    assert len(cfg.pois) == 1
    assert cfg.pois[0].id == "aisle" and cfg.pois[0].name == "aisle-3"
    # Backward compatible: no `pois` key → empty list (whole frame).
    assert CountingConfig.from_dict({"lines": [{"id": "l1", "x": 0.5, "y": 0.5, "length": 0.6}]}).pois == []


def test_multiline_feed_stamps_poi_name():
    cfg = CountingConfig.from_dict({
        "lines": [{"id": "l1", "tag": "t1", "x": 0.5, "y": 0.5, "length": 0.6, "angle": 0.0, "inside": "bottom"}],
    })
    mc = MultiLineCounter(cfg, min_track_length=1, cooldown_frames=0)
    mc.feed(1, (0.5, 0.45), poi="aisle-3")
    crossings = mc.feed(1, (0.5, 0.55), poi="aisle-3")
    assert crossings[0]["poi"] == "aisle-3"       # the crossing carries the POI name
