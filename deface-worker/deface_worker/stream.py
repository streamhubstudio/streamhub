"""
HLS frame source.

`FpsThrottle` is a pure, wall-clock frame gate (unit-tested). `HlsFrameReader`
wraps cv2.VideoCapture (imported lazily) to pull decoded frames from an HLS
playlist — a local `index.m3u8` path or an `http(s)://…/index.m3u8` URL both
work through OpenCV's ffmpeg backend. (Mirrors yolo-worker's reader.)
"""
from __future__ import annotations

import time
from typing import Iterator, Optional


class FpsThrottle:
    """Emit at most `target_fps` frames per second (by wall clock).

    Decoupled from any clock/source so it is deterministic under test: call
    `should_emit(now)` per decoded frame; it returns True when enough time has
    elapsed since the last emitted frame.
    """

    def __init__(self, target_fps: float) -> None:
        self.min_interval = 1.0 / max(0.01, target_fps)
        self._last: Optional[float] = None

    def should_emit(self, now: float) -> bool:
        if self._last is None or (now - self._last) >= self.min_interval:
            self._last = now
            return True
        return False


class HlsFrameReader:
    """Iterate decoded BGR frames from an HLS source, throttled to `target_fps`.

    Reconnects on transient read failures (live HLS can gap between segments).
    cv2 is imported lazily so importing this module never requires OpenCV.
    """

    def __init__(
        self,
        source: str,
        target_fps: float,
        clock=time.monotonic,
        sleep=time.sleep,
    ) -> None:
        self.source = source
        self.throttle = FpsThrottle(target_fps)
        self._clock = clock
        self._sleep = sleep
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    def frames(self) -> Iterator["object"]:
        import cv2  # lazy: only needed at runtime

        cap = cv2.VideoCapture(self.source)
        # Keep the live edge: don't buffer stale segments where supported.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:  # noqa: BLE001 - property unsupported on some builds
            pass

        misses = 0
        try:
            while not self._stop:
                ok, frame = cap.read()
                if not ok or frame is None:
                    misses += 1
                    if misses > 50:  # stream ended / long gap → reconnect
                        cap.release()
                        self._sleep(1.0)
                        cap = cv2.VideoCapture(self.source)
                        misses = 0
                    else:
                        self._sleep(0.05)
                    continue
                misses = 0
                if self.throttle.should_emit(self._clock()):
                    yield frame
        finally:
            cap.release()
