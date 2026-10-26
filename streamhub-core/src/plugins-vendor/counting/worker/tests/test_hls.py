"""HLS reader — pure stale/reconnect accounting + reopen loop (no cv2)."""
from vision_edge.hls import HlsFrameReader, StaleDetector, reopen_backoff
from vision_edge.sampler import FpsThrottle


def test_reconnect_after_max_misses():
    d = StaleDetector(max_misses=3, stale_seconds=100.0)
    d.on_miss(0.0)
    d.on_miss(0.1)
    assert d.should_reconnect(0.2) is False
    d.on_miss(0.2)
    assert d.should_reconnect(0.3) is True


def test_reconnect_when_stale_by_time():
    d = StaleDetector(max_misses=1000, stale_seconds=10.0)
    d.on_frame(0.0)
    d.on_miss(1.0)
    assert d.should_reconnect(5.0) is False
    assert d.should_reconnect(11.0) is True   # >10s since last frame


def test_on_frame_resets_misses_and_reconnects():
    d = StaleDetector(max_misses=2, stale_seconds=100.0)
    d.on_miss(0.0)
    d.on_miss(0.1)
    d.on_reconnect()
    d.on_frame(1.0)
    assert d.misses == 0
    assert d.reconnects == 0
    assert d.should_reconnect(1.1) is False


def test_reopen_backoff_stepped_schedule():
    # Bounded 2 → 5 → 10, then held at 10 (never the old 30s cap).
    assert reopen_backoff(0) == 2.0
    assert reopen_backoff(1) == 5.0
    assert reopen_backoff(2) == 10.0
    assert reopen_backoff(9) == 10.0
    assert reopen_backoff(-1) == 2.0


def test_on_reconnect_walks_schedule_and_counts():
    d = StaleDetector()
    assert d.on_reconnect() == 2.0
    assert d.on_reconnect() == 5.0
    assert d.on_reconnect() == 10.0
    assert d.on_reconnect() == 10.0    # held
    assert d.total_reopens == 4        # lifetime counter (not reset by backoff)


def test_reconnect_resets_miss_counter():
    d = StaleDetector(max_misses=3, stale_seconds=100.0)
    d.on_miss(0.0)
    d.on_miss(0.1)
    d.on_reconnect()
    assert d.misses == 0


# -- frames() reopen loop, seamed with a fake capture (no opencv) -----------

class _FakeCap:
    """Scripted VideoCapture stand-in. ``script`` items:
      ("frame", obj) → (True, obj);  "miss" → (False, None);  "raise" → boom.
    Exhausted script keeps returning misses (a dead stream)."""

    def __init__(self, script):
        self._script = list(script)
        self.released = False

    def read(self):
        if not self._script:
            return False, None
        item = self._script.pop(0)
        if item == "raise":
            raise RuntimeError("decode boom")
        if item == "miss":
            return False, None
        _tag, obj = item
        return True, obj

    def release(self):
        self.released = True


def _reader(source, caps):
    """Reader whose _new_capture pops the next fake cap from ``caps``."""
    seq = iter(caps)
    logs = []
    r = HlsFrameReader(
        source,
        clock=lambda: 0.0,
        sleep=lambda _s: None,
        log=lambda ev, **f: logs.append((ev, f)),
        open_capture=lambda _src: next(seq),
    )
    r.logs = logs  # type: ignore[attr-defined]
    return r


def test_frames_reopens_after_misses_then_yields():
    frame = object()
    cap1 = _FakeCap(["miss", "miss", "miss"])          # dead → triggers reopen
    cap2 = _FakeCap([("frame", frame), "raise"])       # recovers, then stops us
    r = _reader("hls://x", [cap1, cap2])
    r.detector = StaleDetector(max_misses=2, stale_seconds=1e9)
    gen = r.frames()
    got = next(gen)                                    # drives cap1 misses → reopen → cap2 frame
    assert got is frame
    assert cap1.released is True                        # old capture released on reopen
    assert r.detector.total_reopens == 1
    assert any(ev == "hls_reopen" for ev, _ in r.logs)
    r.stop()
    gen.close()


def test_frames_swallows_decode_exception_without_exiting():
    frame = object()
    # cap raises on first read (decode error) then misses to force a reopen.
    cap1 = _FakeCap(["raise", "miss"])
    cap2 = _FakeCap([("frame", frame)])
    r = _reader("hls://x", [cap1, cap2])
    r.detector = StaleDetector(max_misses=2, stale_seconds=1e9)
    gen = r.frames()
    got = next(gen)                                    # exception did NOT propagate
    assert got is frame
    assert any(ev == "hls_read_error" for ev, _ in r.logs)
    r.stop()
    gen.close()


def test_frames_retries_a_failed_open_without_raising():
    frame = object()
    calls = {"n": 0}

    def opener(_src):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("cannot open stream")   # first open fails
        return _FakeCap([("frame", frame)])

    logs = []
    r = HlsFrameReader(
        "hls://x",
        clock=lambda: 0.0,
        sleep=lambda _s: None,
        log=lambda ev, **f: logs.append((ev, f)),
        open_capture=opener,
    )
    gen = r.frames()
    got = next(gen)                                    # open retried, then a frame
    assert got is frame
    assert calls["n"] == 2
    assert any(ev == "hls_open_error" for ev, _ in logs)
    r.stop()
    gen.close()


# -- decode-fps cap: grab() every frame, retrieve() (decode) only at the cap ---

class _GrabCap:
    """VideoCapture stand-in exposing grab()/retrieve() so the decode-cap path
    runs with NO opencv. ``frames`` are handed out by retrieve() in order; grab()
    just advances (and counts, so a test can assert decode << grab)."""

    def __init__(self, frames):
        self._frames = list(frames)
        self.grabs = 0
        self.retrieves = 0

    def grab(self):
        self.grabs += 1
        return True

    def retrieve(self):
        self.retrieves += 1
        if not self._frames:
            return False, None
        return True, self._frames.pop(0)

    def release(self):
        pass


def test_decode_gate_skips_decode_between_cap_ticks():
    # A monotonically-advancing clock; the cap only decodes at >=0.5s intervals.
    ticks = iter([0.0, 0.1, 0.2, 0.5, 0.6])
    gate = FpsThrottle(2.0)  # 0.5s min interval
    cap = _GrabCap([f"f{i}" for i in range(5)])
    yielded = []
    r = HlsFrameReader(
        "hls://x",
        clock=lambda: next(ticks),
        sleep=lambda _s: None,
        open_capture=lambda _src: cap,
        decode_gate=gate.should_emit,
    )
    gen = r.frames()
    # Two frames pass the cap (t=0.0 and t=0.5); grab is called for every frame.
    yielded.append(next(gen))
    yielded.append(next(gen))
    assert yielded == ["f0", "f1"]     # only the two decoded frames
    assert cap.retrieves == 2          # decoded ONCE per cap tick
    assert cap.grabs >= 4              # but grabbed every frame in between
    r.stop()
    gen.close()


def test_decode_gate_treats_grabbed_skips_as_live_not_stale():
    # Grabbed-but-skipped frames keep the stream "live" (no false reconnect).
    ticks = iter([0.0, 0.1, 0.2, 0.3])
    gate = FpsThrottle(0.5)  # 2s interval → only the first frame decodes
    cap = _GrabCap(["only"])
    r = HlsFrameReader(
        "hls://x",
        clock=lambda: next(ticks),
        sleep=lambda _s: None,
        open_capture=lambda _src: cap,
        decode_gate=gate.should_emit,
    )
    r.detector = StaleDetector(max_misses=2, stale_seconds=1e9)
    gen = r.frames()
    assert next(gen) == "only"         # first tick decodes
    # The skipped grabs did not accrue misses (still 0) — stream stays healthy.
    assert r.detector.misses == 0
    r.stop()
    gen.close()
