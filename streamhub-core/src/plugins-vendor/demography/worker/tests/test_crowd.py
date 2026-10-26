"""Crowd — multi-cycle threshold state + config + engine."""
from vision_edge.models.crowd import (
    CrowdConfig,
    CrowdEngine,
    CrowdZoneState,
    required_cycles,
)


def test_required_cycles():
    assert required_cycles(0, 120) == 1        # no sustain requirement
    assert required_cycles(120, 120) == 1
    assert required_cycles(300, 120) == 3      # ceil(2.5)
    assert required_cycles(50, 0) == 1


def test_state_increments_and_resets():
    st = CrowdZoneState(threshold=5, required_cycles=3)
    r1 = st.update(6)
    assert r1["cycles"] == 1 and r1["should_notify_threshold"] is False
    st.update(7)
    r3 = st.update(8)
    assert r3["cycles"] == 3 and r3["should_notify_threshold"] is True
    # Drops below → resets and re-arms.
    r_reset = st.update(2)
    assert r_reset["cycles"] == 0 and r_reset["should_notify_threshold"] is False


def test_state_fires_once_until_drop():
    st = CrowdZoneState(threshold=3, required_cycles=1)
    assert st.update(5)["should_notify_threshold"] is True
    assert st.update(5)["should_notify_threshold"] is False  # armed off
    st.update(0)                                             # drop → re-arm
    assert st.update(5)["should_notify_threshold"] is True


def test_state_should_notify_count():
    st = CrowdZoneState(threshold=10, required_cycles=1)
    assert st.update(0)["should_notify_count"] is False
    assert st.update(3)["should_notify_count"] is True


def test_state_zero_threshold_never_fires():
    st = CrowdZoneState(threshold=0, required_cycles=1)
    assert st.update(999)["should_notify_threshold"] is False


def test_crowd_config_from_dict():
    cfg = CrowdConfig.from_dict({
        "zones": [{"id": "z", "points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], "alertLimit": 5, "alertAfterSec": 360}],
        "intervalSec": 120,
    })
    assert cfg.interval_sec == 120.0
    assert len(cfg.zones) == 1
    # required cycles for this zone = ceil(360/120) = 3.
    eng = CrowdEngine(cfg)
    assert eng.states["z"].required_cycles == 3


def test_crowd_engine_emits_count_and_threshold():
    cfg = CrowdConfig.from_dict({
        "zones": [{"id": "z", "points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], "alertLimit": 2, "alertAfterSec": 0}],
        "intervalSec": 60,
    })
    eng = CrowdEngine(cfg)
    dets = [
        {"bbox": [0.4, 0.4, 0.5, 0.6], "cls": "person", "conf": 0.9},
        {"bbox": [0.5, 0.4, 0.6, 0.6], "cls": "person", "conf": 0.9},
    ]
    counts, thresholds = eng.process(dets)
    assert counts == [{"zone": "z", "tag": "z", "count": 2}]
    assert len(thresholds) == 1
    assert thresholds[0]["count"] == 2 and thresholds[0]["threshold"] == 2 and thresholds[0]["cycles"] == 1
