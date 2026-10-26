"""Evidence snapshot path building (pure — the cv2 writer is not tested)."""
import os

from safety_ppe_worker.evidence import snapshot_relpath


def test_relpath_shape_and_slugging():
    rel = snapshot_relpath(1720000000.123, "Live App", "Main Cam", "Dock / North", ["vest", "helmet"])
    assert rel == os.path.join("live-app", "1720000000123-main-cam-dock-north-helmet-vest.jpg")


def test_relpath_is_sortable_and_unique_by_millisecond():
    a = snapshot_relpath(100.001, "a", "r", "z", ["helmet"])
    b = snapshot_relpath(100.002, "a", "r", "z", ["helmet"])
    assert a != b and sorted([b, a]) == [a, b]


def test_relpath_never_escapes_the_evidence_dir():
    rel = snapshot_relpath(1.0, "../etc", "../../room", "zone/../..", ["helmet"])
    assert ".." not in rel
    assert not os.path.isabs(rel)


def test_relpath_handles_empty_parts():
    rel = snapshot_relpath(1.0, "", "", "", [])
    assert rel == os.path.join("app", "1000-x-x-none.jpg")
