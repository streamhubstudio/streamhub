"""
Shared capture — ONE decode loop per SOURCE feeding N model consumers.

The problem (owner item 33): running crowd + counting + occupancy on the SAME
camera today spawns N worker processes, each with its OWN ``HlsFrameReader``
(cv2.VideoCapture) pulling + decoding the SAME HLS stream → **N× network pull +
N× decode**. Inference is inherently per-model, but the pull + decode are not.

The fix: run the models that share a SOURCE inside ONE process, decode the frame
ONCE, and fan each decoded frame out to every model consumer. After the change a
source that hosts N models costs **1× decode + N× inference** (was N× decode +
N× inference) — see ``streamhub-docs/features/vision-edge.md`` for the numbers.

This module is the PURE core (no cv2/torch/threads), unit-tested by feeding an
explicit clock + synthetic frames:

  - :class:`FrameRing`     — bounded latest-N ring the consumers sample from.
  - :func:`make_sampler`   — the per-consumer cadence predicate (occupancy =
                             adaptive skip, counting = fixed fps, crowd /
                             demography = one frame per interval).
  - :class:`SharedCapture` — the fan-out planner: owns the ring + the named
                             consumers, and per decoded frame returns which
                             consumers want it (each keeps its own cadence).

The per-source **decode-fps cap** (knob #3) lives in the reader
(``HlsFrameReader(decode_gate=...)`` in ``hls.py``): the source is decoded at
most ``decode_fps`` times/sec ONCE, and every consumer samples from that capped
stream. The impure shell that wires a real ``HlsFrameReader`` to a
``SharedCapture`` and drives the model callbacks lives in
``runtime.run_multiplex`` (needs cv2/torch → ``pragma: no cover``).
"""
from __future__ import annotations

from collections import deque
from typing import Any, Callable, Optional

from .sampler import AdaptiveFrameSampler, FpsThrottle

# ``wants(idx, now) -> bool`` — the same signature as the HLS reader's ``emit``
# so a consumer's cadence predicate is interchangeable with a standalone reader.
Sampler = Callable[[int, float], bool]

DEFAULT_RING_MAXLEN = 8


class FrameRing:
    """Bounded ring of the latest ``(seq, frame)`` decoded frames.

    Consumers sample the ``latest()`` frame; the ring keeps a small lookback so a
    slightly-late consumer still finds a frame instead of ``None``. When full the
    OLDEST frame is dropped (a slow consumer can never grow memory without
    bound). ``pushed`` / ``dropped`` are lifetime counters for logs + tests.
    """

    def __init__(self, maxlen: int = DEFAULT_RING_MAXLEN) -> None:
        self.maxlen = max(1, int(maxlen))
        self._items: deque[tuple[int, Any]] = deque(maxlen=self.maxlen)
        self.pushed = 0
        self.dropped = 0

    def push(self, seq: int, frame: Any) -> None:
        if len(self._items) >= self.maxlen:
            self.dropped += 1  # the deque is about to evict the oldest
        self._items.append((seq, frame))
        self.pushed += 1

    def latest(self) -> Optional[tuple[int, Any]]:
        return self._items[-1] if self._items else None

    def __len__(self) -> int:
        return len(self._items)


def make_sampler(
    model: str,
    fps: float = 3.5,
    interval_sec: float = 120.0,
) -> Sampler:
    """Build the cadence predicate for a model consumer of the shared stream.

    Each returned ``wants(idx, now)`` is pure/deterministic (driven by the
    caller's clock), matching how each model samples today when it owns its own
    reader:

      - ``counting``            → FIXED ``fps`` (contract: 3.5; ByteTrack ID-swap
        sensitivity forbids a variable gap);
      - ``occupancy``           → Vision One ADAPTIVE skip (dwell logic tolerates
        a variable gap; more detections → sample more often);
      - ``crowd`` / ``demography`` → ONE frame per ``interval_sec`` (snapshot
        models), sampled straight off the continuous shared stream instead of
        opening a fresh capture each interval.
    """
    m = (model or "").strip().lower()
    if m == "occupancy":
        sampler = AdaptiveFrameSampler()
        state = {"skip_left": 0}

        def wants_adaptive(_idx: int, _now: float) -> bool:
            if state["skip_left"] > 0:
                state["skip_left"] -= 1
                return False
            state["skip_left"] = sampler.frames_to_skip()
            return True

        return wants_adaptive

    if m in ("crowd", "demography"):
        iv = interval_sec if interval_sec and interval_sec > 0 else 120.0
        throttle = FpsThrottle(1.0 / iv)
        return lambda _idx, now: throttle.should_emit(now)

    # counting (and any other realtime model) — fixed cadence.
    throttle = FpsThrottle(fps if fps and fps > 0 else 3.5)
    return lambda _idx, now: throttle.should_emit(now)


class SharedCapture:
    """Fan-out planner: ONE decoded stream → N named model consumers.

    Register each consumer with :meth:`add_consumer` (a name + its cadence
    :data:`Sampler`). For every decoded frame the shell calls :meth:`dispatch`,
    which pushes the frame into the ring, bumps the sequence, and returns the
    names of the consumers whose sampler fired for THIS frame. The decode itself
    happened ONCE upstream (in the reader, capped by ``decode_fps``), so the cost
    of adding a consumer is only its own inference — never another decode.

    Pure: no cv2/threads. ``dispatch`` takes the wall clock so the fan-out
    decisions are unit-tested with a synthetic clock.
    """

    def __init__(self, ring_maxlen: int = DEFAULT_RING_MAXLEN) -> None:
        self.ring = FrameRing(ring_maxlen)
        self._consumers: "dict[str, Sampler]" = {}
        self._seq = 0

    def add_consumer(self, name: str, wants: Sampler) -> None:
        self._consumers[str(name)] = wants

    def remove_consumer(self, name: str) -> None:
        self._consumers.pop(str(name), None)

    def consumer_names(self) -> list[str]:
        return list(self._consumers.keys())

    @property
    def seq(self) -> int:
        return self._seq

    def dispatch(self, frame: Any, now: float, idx: int | None = None) -> list[str]:
        """Push one decoded frame and return the consumers that want it.

        ``idx`` defaults to a monotonic decoded-frame counter (what a lone reader
        would pass its ``emit``); each consumer's sampler decides independently,
        so N consumers on ONE decode never re-pull or re-decode the source.
        """
        self._seq += 1
        i = self._seq if idx is None else int(idx)
        self.ring.push(self._seq, frame)
        return [name for name, wants in self._consumers.items() if wants(i, now)]
