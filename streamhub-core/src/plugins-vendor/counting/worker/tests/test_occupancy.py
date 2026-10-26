"""Occupancy — session state machine + count-based alert + smoother."""
from vision_edge.models.occupancy import (
    DetectionSmoother,
    OccupancyConfig,
    OccupancyEngine,
    ZoneOccupancyTracker,
)
from vision_edge.zones import PolygonZone

SQUARE = ((0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8))


def _zone(**over):
    kw = dict(id="z1", tag="front", detect="personas", points=SQUARE, confidence=0.3, alert_limit=0, alert_after_sec=0.0)
    kw.update(over)
    return PolygonZone(**kw)


def _tracker(zone=None, **kw):
    kw.setdefault("grace_sec", 5.0)
    kw.setdefault("min_duration_sec", 1.0)
    return ZoneOccupancyTracker(zone or _zone(), **kw)


def test_smoother_window1_passthrough():
    s = DetectionSmoother(1)
    assert s.smooth(True) is True
    assert s.smooth(False) is False


def test_smoother_majority_vote():
    s = DetectionSmoother(3)
    assert s.smooth(True) is True     # warming (len<window)
    assert s.smooth(True) is True     # warming
    assert s.smooth(False) is True    # [T,T,F] majority True
    assert s.smooth(False) is False   # [T,F,F] majority False


def test_session_start_emits_started():
    tr = _tracker()
    evs = tr.update(1, now=0.0)
    assert len(evs) == 1
    assert evs[0].kind == "session_started"
    assert evs[0].zone == "z1" and evs[0].tag == "front"
    assert tr.is_occupied is True


def test_session_end_after_grace_with_duration():
    tr = _tracker(grace_sec=5.0, min_duration_sec=1.0)
    tr.update(1, now=0.0)   # start
    tr.update(1, now=2.0)   # present (last_present=2)
    assert tr.update(0, now=3.0) == []   # empty but within grace
    evs = tr.update(0, now=8.0)          # 8-2=6 >= grace → end
    assert len(evs) == 1
    assert evs[0].kind == "session_ended"
    assert evs[0].data["durationSec"] == 2.0
    assert tr.is_occupied is False


def test_short_session_dropped():
    tr = _tracker(grace_sec=2.0, min_duration_sec=10.0)
    tr.update(1, now=0.0)
    evs = tr.update(0, now=5.0)  # empty past grace; duration 0 < min → dropped
    assert evs == []
    assert tr.is_occupied is False


def test_alert_fires_after_sustained_and_once():
    z = _zone(alert_limit=3, alert_after_sec=10.0)
    tr = _tracker(z, alert_cooldown_sec=600.0)
    tr.update(3, now=0.0)                       # over threshold, sustained 0
    assert all(e.kind != "alert" for e in tr.update(3, now=5.0))  # 5 < 10
    evs = tr.update(3, now=10.0)               # sustained 10 → alert
    alerts = [e for e in evs if e.kind == "alert"]
    assert len(alerts) == 1
    a = alerts[0]
    assert a.data["occupancy"] == 3 and a.data["limit"] == 3 and a.data["sinceSec"] == 10.0
    # Still over → no repeat.
    assert all(e.kind != "alert" for e in tr.update(3, now=11.0))


def test_alert_rearms_after_drop_below_limit():
    z = _zone(alert_limit=2, alert_after_sec=0.0)
    tr = _tracker(z, alert_cooldown_sec=0.0)
    assert any(e.kind == "alert" for e in tr.update(2, now=0.0))   # fires immediately
    assert all(e.kind != "alert" for e in tr.update(2, now=1.0))   # armed False
    tr.update(0, now=2.0)                                          # drop → re-arm
    assert any(e.kind == "alert" for e in tr.update(2, now=3.0))   # fires again


def test_alert_disabled_when_no_limit():
    tr = _tracker(_zone(alert_limit=0))
    for t in range(5):
        assert all(e.kind != "alert" for e in tr.update(100, now=float(t)))


def test_occupancy_config_from_dict():
    cfg = OccupancyConfig.from_dict({
        "zones": [{"id": "z", "points": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], "detect": "vehiculos", "alertLimit": 2, "alertAfterSec": 30}],
        "graceSec": 60,
        "anchor": "center",
    })
    assert len(cfg.zones) == 1
    assert cfg.zones[0].detect == "vehiculos"
    assert cfg.grace_sec == 60.0
    assert cfg.anchor == "center"


def test_engine_end_to_end_start():
    cfg = OccupancyConfig.from_dict({
        "zones": [{"id": "z", "points": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], "detect": "personas"}],
        "graceSec": 5, "minDurationSec": 1,
    })
    eng = OccupancyEngine(cfg)
    dets = [{"bbox": [0.45, 0.4, 0.55, 0.7], "cls": "person", "conf": 0.9}]
    evs = eng.process(dets, now=0.0)
    assert any(e.kind == "session_started" and e.zone == "z" for e in evs)
