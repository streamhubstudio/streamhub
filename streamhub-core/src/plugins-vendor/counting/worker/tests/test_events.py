"""Event batching — flush cadence, spool on failure, bounded ring, retry."""
import os
import tempfile

from vision_edge.events import EventBatcher, build_event


class FakePoster:
    def __init__(self, status=200):
        self.status = status
        self.calls = []

    def __call__(self, url, events, token=""):
        self.calls.append(list(events))
        return self.status


def _ev(i):
    return {"event": "count.in", "n": i}


def test_build_event_merges_envelope():
    base = {"app": "a", "room": "r", "tags": ["t"], "nodeId": "n", "model": "counting"}
    ev = build_event(base, "count.in", {"line": "l1", "trackId": 5}, 1234.5678)
    assert ev["event"] == "count.in" and ev["ts"] == 1234.568
    assert ev["app"] == "a" and ev["line"] == "l1" and ev["trackId"] == 5


def test_first_add_flushes():
    p = FakePoster(200)
    b = EventBatcher("http://x", poster=p)
    flushed = b.add(_ev(1), now=0.0)
    assert flushed is True
    assert p.calls == [[_ev(1)]]
    assert b.sent == 1


def test_rate_limited_flush():
    p = FakePoster(200)
    b = EventBatcher("http://x", flush_interval=1.0, poster=p)
    b.add(_ev(1), now=0.0)              # flush 1
    b.add(_ev(2), now=0.5)             # within interval → buffered
    assert len(p.calls) == 1
    assert b.pending_count == 1
    b.add(_ev(3), now=1.0)             # interval elapsed → flush 2 (e2+e3)
    assert len(p.calls) == 2
    assert p.calls[1] == [_ev(2), _ev(3)]


def test_batch_max_forces_flush():
    p = FakePoster(200)
    b = EventBatcher("http://x", flush_interval=1000.0, batch_max=2, poster=p)
    b.add(_ev(1), now=0.0)   # first add is due → flush
    b.add(_ev(2), now=0.1)   # buffered (not due)
    assert b.pending_count == 1
    b.add(_ev(3), now=0.2)   # pending hits batch_max=2 → flush
    assert len(p.calls) == 2


def test_failed_post_spools_then_retries():
    p = FakePoster(500)
    b = EventBatcher("http://x", poster=p)
    b.add(_ev(1), now=0.0)        # fails → spooled
    assert b.spool_count == 1 and b.sent == 0
    p.status = 200
    b.flush(now=5.0)             # retries the spool
    assert b.sent == 1 and b.spool_count == 0
    assert p.calls[-1] == [_ev(1)]


def test_no_url_keeps_spooling_bounded():
    b = EventBatcher("", poster=FakePoster(200))
    b.add(_ev(1), now=0.0)
    b.add(_ev(2), now=5.0)
    assert b.spool_count == 2 and b.sent == 0


def test_spool_ring_drops_oldest_when_full():
    p = FakePoster(500)
    b = EventBatcher("http://x", spool_max=2, poster=p)
    b.add(_ev(1), now=0.0)   # spool [1]
    b.add(_ev(2), now=1.0)   # spool [1,2]
    b.add(_ev(3), now=2.0)   # spool [2,3], dropped 1
    assert b.spool_count == 2
    assert b.dropped == 1
    # The retained events are the newest two.
    p.status = 200
    b.flush(now=3.0)
    assert p.calls[-1] == [_ev(2), _ev(3)]


def test_spool_to_disk_and_reload():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "spool.jsonl")
        b = EventBatcher("", poster=FakePoster(200))
        b.add(_ev(1), now=0.0)
        b.add(_ev(2), now=5.0)
        assert b.spool_to_disk(path) == 2
        b2 = EventBatcher("http://x", poster=FakePoster(200))
        assert b2.load_from_disk(path) == 2
        assert b2.spool_count == 2
