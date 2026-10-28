"""
HLS frame source — cv2.VideoCapture(FFMPEG) wrapper with reconnect/stale
detection, porting Vision One's ``StreamCapture`` patterns (occupancy/
streaming.py) to a single-process reader.

The reconnect POLICY is pure (``StaleDetector`` — miss counting + capped
exponential backoff, testable with no cv2); ``HlsFrameReader`` wraps it around
a lazily-imported ``cv2.VideoCapture`` and yields decoded BGR frames, throttled
by a caller-supplied sampler (``FpsThrottle`` for fixed cadence, or the
adaptive skip loop for occupancy).
"""
from __future__ import annotations

import time
from typing import Callable, Iterator, Optional

# Vision One streaming.py timings (translated to a single-process reader).
MAX_MISSES_BEFORE_RECONNECT = 50   # consecutive failed reads → force reconnect
STALE_SECONDS = 10.0               # no decoded frame this long → stale
# Bounded reopen backoff (seconds): 2 → 5 → 10, then HELD at 10. A choppy HLS
# restream that recovers is re-grabbed within 10 s — Vision One's 30 s cap was
# too slow for a flaky edge restream, which left the worker idle (field F5b).
REOPEN_BACKOFF_SCHEDULE = (2.0, 5.0, 10.0)
# ffmpeg read/open timeouts pushed onto the capture so a stalled HLS source
# returns a failed read in seconds instead of blocking on the 30 s default.
OPEN_TIMEOUT_MS = 10_000
READ_TIMEOUT_MS = 5_000


def reopen_backoff(reopen_count: int) -> float:
    """Pure bounded reopen backoff: step ``reopen_count`` through
    ``REOPEN_BACKOFF_SCHEDULE`` (2, 5, 10), holding at the last value."""
    if reopen_count < 0:
        reopen_count = 0
    return REOPEN_BACKOFF_SCHEDULE[min(reopen_count, len(REOPEN_BACKOFF_SCHEDULE) - 1)]


class StaleDetector:
    """Pure miss/stale accounting for a frame reader.

    ``on_miss(now)`` / ``on_frame(now)`` update state; ``should_reconnect()``
    is True after ``max_misses`` consecutive misses OR ``stale_seconds`` with
    no decoded frame. ``on_reconnect()`` returns the bounded reopen backoff
    (2 → 5 → 10 s) for the current attempt and bumps ``total_reopens`` — a
    lifetime counter the reader surfaces in logs. Reset on a successful read.
    """

    def __init__(
        self,
        max_misses: int = MAX_MISSES_BEFORE_RECONNECT,
        stale_seconds: float = STALE_SECONDS,
    ) -> None:
        self.max_misses = int(max_misses)
        self.stale_seconds = float(stale_seconds)
        self.misses = 0
        self.reconnects = 0
        self.total_reopens = 0     # lifetime reopen count (never reset — for logs)
        self._last_frame_at: Optional[float] = None

    def on_frame(self, now: float) -> None:
        self.misses = 0
        self.reconnects = 0
        self._last_frame_at = now

    def on_miss(self, now: float) -> None:
        self.misses += 1
        if self._last_frame_at is None:
            self._last_frame_at = now

    def should_reconnect(self, now: float | None = None) -> bool:
        if self.misses >= self.max_misses:
            return True
        if now is not None and self._last_frame_at is not None:
            if (now - self._last_frame_at) >= self.stale_seconds:
                return True
        return False

    def on_reconnect(self) -> float:
        """Record a reopen attempt and return the bounded backoff to wait."""
        delay = reopen_backoff(self.reconnects)
        self.reconnects += 1
        self.total_reopens += 1
        self.misses = 0
        return delay


class HlsFrameReader:
    """Iterate decoded BGR frames from an HLS/RTSP source with reconnect.

    ``cv2`` is imported lazily so importing this module never needs OpenCV.
    ``emit(frame_index, now)`` decides whether to yield a decoded frame (the
    caller passes a fixed-cadence throttle or an adaptive skip predicate);
    default emits every frame.
    """

    def __init__(
        self,
        source: str,
        emit=None,
        clock=time.monotonic,
        sleep=time.sleep,
        log: Optional[Callable[..., None]] = None,
        open_capture: Optional[Callable[[str], object]] = None,
        decode_gate: Optional[Callable[[float], bool]] = None,
    ) -> None:
        self.source = source
        self._emit = emit or (lambda _idx, _now: True)
        self._clock = clock
        self._sleep = sleep
        # ``log(event, **fields)`` mirrors the runtime logger; None → silent.
        self._log = log or (lambda *_a, **_k: None)
        # Capture factory seam: None → the cv2 path; a callable (source)->cap in
        # tests so the reopen/backoff loop runs with NO opencv.
        self._open_capture = open_capture
        # Per-source DECODE-fps cap (shared capture, knob #3). When set, every
        # raw frame is grab()'d (cheap, no decode) but only retrieve()'d
        # (decoded) when ``decode_gate(now)`` passes — so a source feeding N
        # shared consumers is DECODED at most once per cap tick regardless of how
        # many models sample it. None → decode every frame (legacy behavior).
        self._decode_gate = decode_gate
        self._stop = False
        self.detector = StaleDetector()

    def stop(self) -> None:
        self._stop = True

    def frames(self) -> Iterator["object"]:
        """Yield decoded BGR frames forever, reopening a broken/stale source with
        bounded backoff. A recoverable stream gap (failed read, decode error, or
        a capture that won't open) NEVER exits this loop — only ``stop()`` does —
        so the worker keeps trying instead of falling idle (field F5b)."""
        cap = self._open_with_retry()
        idx = 0
        try:
            while not self._stop:
                now = self._clock()
                live, frame = self._grab(cap, now)
                if live:
                    # A live source (frame arrived on the wire) — reset stale
                    # accounting even when we SKIP its decode under the cap.
                    self.detector.on_frame(now)
                    if frame is not None:
                        idx += 1
                        if self._emit(idx, now):
                            yield frame
                    continue
                # A failed/timed-out read or a decode error is a miss.
                self.detector.on_miss(now)
                if self.detector.should_reconnect(now):
                    cap = self._reopen(cap)
                else:
                    self._sleep(0.05)
        finally:
            self._release(cap)

    def _grab(self, cap, now: float):
        """Return ``(live, frame)`` for one source frame.

        ``live`` is True whenever a frame arrived on the wire (keeps the stream
        from looking stale); ``frame`` is the decoded BGR image, or ``None`` when
        it was intentionally SKIPPED by the decode-fps cap. Without a cap this is
        exactly the legacy ``_read`` path (``live`` = a successful decoded read).
        """
        if self._decode_gate is None:
            ok, frame = self._read(cap)
            live = bool(ok) and frame is not None
            return (live, frame if live else None)
        return self._read_capped(cap, now)

    def _read_capped(self, cap, now: float):
        """Decode-capped read: grab() every frame (cheap), retrieve() (decode)
        only when the cap allows. Falls back to ``read()`` on captures that do
        not expose grab/retrieve (still caps DELIVERY, decode unavoidable there).
        """
        if cap is None:
            return (False, None)
        grab = getattr(cap, "grab", None)
        retrieve = getattr(cap, "retrieve", None)
        try:
            if callable(grab) and callable(retrieve):
                if not grab():
                    return (False, None)  # nothing on the wire → miss
                if not self._decode_gate(now):
                    return (True, None)   # live, but skip the decode (the win)
                ok, frame = retrieve()
                live = bool(ok) and frame is not None
                return (live, frame if live else None)
            # No grab/retrieve: decode via read(), then apply the cap to delivery.
            ok, frame = cap.read()
            if not (bool(ok) and frame is not None):
                return (False, None)
            return (True, frame if self._decode_gate(now) else None)
        except Exception as exc:  # noqa: BLE001 - a decode error is a recoverable gap
            self._log("hls_read_error", source=self.source, error=str(exc))
            return (False, None)

    def _read(self, cap):
        """Read one frame, turning a cv2 decode exception into a miss (never
        propagates out of the loop)."""
        if cap is None:
            return False, None
        try:
            ok, frame = cap.read()
            return bool(ok), frame
        except Exception as exc:  # noqa: BLE001 - a decode error is a recoverable gap
            self._log("hls_read_error", source=self.source, error=str(exc))
            return False, None

    def _reopen(self, cap):
        """Release the dead capture, back off, and reopen (with retry)."""
        self._release(cap)
        delay = self.detector.on_reconnect()
        self._log(
            "hls_reopen",
            source=self.source,
            reopen=self.detector.total_reopens,
            backoffSec=round(delay, 1),
            misses=self.detector.misses,
        )
        self._sleep(delay)
        return self._open_with_retry()

    def _open_with_retry(self):
        """Open the capture, backing off + retrying on failure. Never raises: a
        source that refuses to open is a recoverable gap, not a worker exit."""
        while not self._stop:
            try:
                return self._new_capture()
            except Exception as exc:  # noqa: BLE001 - failed open is recoverable
                delay = self.detector.on_reconnect()
                self._log(
                    "hls_open_error",
                    source=self.source,
                    error=str(exc),
                    reopen=self.detector.total_reopens,
                    backoffSec=round(delay, 1),
                )
                self._sleep(delay)
        return None

    def _new_capture(self):
        if self._open_capture is not None:
            return self._open_capture(self.source)
        import cv2  # lazy: only needed at runtime

        return self._open(cv2)

    @staticmethod
    def _release(cap) -> None:
        if cap is None:
            return
        try:
            cap.release()
        except Exception:  # noqa: BLE001 - already gone
            pass

    def _open(self, cv2):
        cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
        # Keep the live edge + bound ffmpeg's stall timeouts so a dead source
        # returns a failed read fast (props unsupported on some builds → skip).
        for prop, value in (
            ("CAP_PROP_BUFFERSIZE", 1),
            ("CAP_PROP_OPEN_TIMEOUT_MSEC", OPEN_TIMEOUT_MS),
            ("CAP_PROP_READ_TIMEOUT_MSEC", READ_TIMEOUT_MS),
        ):
            try:
                cap.set(getattr(cv2, prop), value)
            except Exception:  # noqa: BLE001 - property unsupported on some builds
                pass
        return cap

    def read_one(self):
        """Decode a SINGLE frame (for snapshot models: crowd/demography). Opens,
        grabs, releases. Returns a BGR frame or None — a failed open or decode is
        swallowed (the caller's interval loop retries) so a gap never exits."""
        try:
            cap = self._new_capture()
        except Exception as exc:  # noqa: BLE001 - failed open → skip this tick
            self._log("hls_open_error", source=self.source, error=str(exc))
            return None
        try:
            ok, frame = cap.read()
            return frame if ok else None
        except Exception as exc:  # noqa: BLE001 - decode error → skip this tick
            self._log("hls_read_error", source=self.source, error=str(exc))
            return None
        finally:
            self._release(cap)
