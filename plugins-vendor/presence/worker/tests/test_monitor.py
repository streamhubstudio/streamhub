"""Presence state machine: absence timers, returns, after-hours re-arming."""
from presence_worker.monitor import PresenceMonitor
from presence_worker.zones import Zone

Z = [Zone("desk", "Desk", 0.0, 0.0, 0.5, 1.0)]
Z2 = Z + [Zone("door", "Door", 0.5, 0.0, 0.5, 1.0)]


def events_of(evs, name):
    return [e for e in evs if e["event"] == name]


def test_absent_fires_once_after_threshold():
    m = PresenceMonitor(Z, threshold_s=300)
    assert m.update(0, {"desk": 1}) == []
    assert m.update(10, {"desk": 0}) == []          # just emptied
    assert m.update(309, {"desk": 0}) == []         # 299s empty — not yet
    evs = m.update(310, {"desk": 0})                # 300s empty → absent
    assert len(evs) == 1
    ev = evs[0]
    assert ev["event"] == "presence.absent"
    assert ev["zone"] == "desk" and ev["zoneName"] == "Desk"
    assert ev["ts"] == 310
    assert ev["emptyForSec"] == 300.0
    assert ev["thresholdMin"] == 5.0
    # stays silent while the zone remains empty
    assert m.update(1000, {"desk": 0}) == []


def test_returned_fires_after_absent_with_duration():
    m = PresenceMonitor(Z, threshold_s=60)
    m.update(0, {"desk": 1})
    m.update(10, {"desk": 0})
    assert len(m.update(70, {"desk": 0})) == 1      # absent
    evs = m.update(100, {"desk": 2})
    assert len(evs) == 1
    ev = evs[0]
    assert ev["event"] == "presence.returned"
    assert ev["zone"] == "desk"
    assert ev["persons"] == 2
    assert ev["absentForSec"] == 90.0               # empty since t=10
    # a later empty episode re-fires the cycle
    m.update(110, {"desk": 0})
    assert len(m.update(171, {"desk": 0})) == 1


def test_no_returned_without_prior_absent():
    m = PresenceMonitor(Z, threshold_s=300)
    m.update(0, {"desk": 1})
    m.update(10, {"desk": 0})
    assert m.update(20, {"desk": 1}) == []          # short gap → no events


def test_empty_from_start_anchors_at_first_update():
    m = PresenceMonitor(Z, threshold_s=300)
    assert m.update(1000, {"desk": 0}) == []
    evs = m.update(1300, {"desk": 0})
    assert len(evs) == 1 and evs[0]["event"] == "presence.absent"


def test_after_hours_fires_and_rearms_on_empty():
    # Schedule: "in hours" only before t=100.
    m = PresenceMonitor(Z, threshold_s=1e9, in_schedule=lambda ts: ts < 100)
    assert m.update(0, {"desk": 1}) == []            # in hours
    evs = m.update(150, {"desk": 1})                 # after hours, present
    assert [e["event"] for e in evs] == ["presence.after_hours"]
    assert evs[0]["persons"] == 1
    assert m.update(200, {"desk": 1}) == []          # continuous stay: no re-fire
    m.update(250, {"desk": 0})                       # zone empties → re-arm
    evs = m.update(300, {"desk": 1})
    assert [e["event"] for e in evs] == ["presence.after_hours"]


def test_after_hours_rearms_when_schedule_resumes():
    in_hours = {"on": False}
    m = PresenceMonitor(
        Z, threshold_s=1e9, in_schedule=lambda ts: in_hours["on"]
    )
    assert [e["event"] for e in m.update(0, {"desk": 1})] == [
        "presence.after_hours"
    ]
    in_hours["on"] = True
    assert m.update(10, {"desk": 1}) == []           # back in hours → re-arm
    in_hours["on"] = False
    assert [e["event"] for e in m.update(20, {"desk": 1})] == [
        "presence.after_hours"
    ]


def test_after_hours_disabled():
    m = PresenceMonitor(
        Z, threshold_s=1e9, in_schedule=lambda _ts: False, after_hours_enabled=False
    )
    assert m.update(0, {"desk": 1}) == []


def test_zones_are_independent():
    m = PresenceMonitor(Z2, threshold_s=60)
    m.update(0, {"desk": 1, "door": 1})
    m.update(10, {"desk": 0, "door": 1})
    evs = m.update(80, {"desk": 0, "door": 1})
    assert [(e["event"], e["zone"]) for e in evs] == [("presence.absent", "desk")]
    evs = m.update(90, {"desk": 1, "door": 0})
    assert [(e["event"], e["zone"]) for e in evs] == [("presence.returned", "desk")]


def test_snapshot_reflects_state():
    m = PresenceMonitor(Z2, threshold_s=60)
    m.update(0, {"desk": 2, "door": 0})
    m.update(30, {"desk": 2, "door": 0})
    snap = {s["id"]: s for s in m.snapshot(30)}
    assert snap["desk"]["persons"] == 2
    assert snap["desk"]["absent"] is False
    assert snap["desk"]["lastPresentTs"] == 30
    assert snap["door"]["persons"] == 0
    assert snap["door"]["emptyForSec"] == 30.0
