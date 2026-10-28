"""
Event delivery — batched, signed-friendly POST to the master events channel
with an on-disk spool on outage. Pure builders + an injectable-clock batcher
so the batching/spool/retry logic is unit-tested with no network.

Each event is the Wave-2 envelope: ``{app, room, tags, nodeId, model, ts}`` +
model specifics (the caller merges ``WorkerConfig.base_payload()`` with the
event fields). The batcher POSTs ``{"events": [...]}`` to VISION_EVENTS_URL
with the per-start ``x-plugin-ingest-token`` header, flushing at most once per
``flush_interval`` seconds (default 1.0 — contract: "≤1/s flush"). On a failed
POST the batch is appended to a BOUNDED ring spool and retried on the next
flush; the ring drops the OLDEST events when full so an extended outage can
never exhaust memory/disk.

Transport is stdlib urllib (no ``requests``); the poster returns the HTTP
status and never raises (matches the other StreamHub workers).
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Callable, Deque

USER_AGENT = "streamhub-vision-edge/0.1"
DEFAULT_FLUSH_INTERVAL = 1.0
DEFAULT_SPOOL_MAX = 5000
DEFAULT_BATCH_MAX = 200


def build_event(base: dict[str, Any], event: str, data: dict[str, Any], ts: float) -> dict[str, Any]:
    """Merge the common envelope with the event-specific fields.

    ``base`` = {app, room, tags, nodeId, model}; result adds ``event`` +
    ``ts`` (unix seconds) + the flattened ``data``.
    """
    out = dict(base)
    out["event"] = event
    out["ts"] = round(float(ts), 3)
    out.update(data)
    return out


def post_events(
    url: str,
    events: list[dict[str, Any]],
    token: str = "",
    timeout: float = 5.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> int:
    """POST a batch as ``{"events": [...]}``. Returns HTTP status (0 on
    transport error). ``opener`` is injectable so tests never touch the
    network."""
    body = json.dumps({"events": events}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    if token:
        headers["X-Plugin-Ingest-Token"] = token
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with opener(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 0) or getattr(resp, "code", 0) or 0)
    except urllib.error.HTTPError as e:
        return int(e.code)
    except (urllib.error.URLError, OSError, ValueError):
        return 0


class EventBatcher:
    """Accumulate events and flush at most once per ``flush_interval`` seconds.

    Pure-testable: pass an explicit ``now`` to ``add``/``flush`` and inject a
    ``poster``. A flush that fails (status not 2xx, or url unset) re-spools the
    events into a bounded ring for the next attempt.
    """

    def __init__(
        self,
        url: str,
        token: str = "",
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        spool_max: int = DEFAULT_SPOOL_MAX,
        batch_max: int = DEFAULT_BATCH_MAX,
        poster: Callable[..., int] = post_events,
    ) -> None:
        self.url = url
        self.token = token
        self.flush_interval = max(0.0, float(flush_interval))
        self.batch_max = max(1, int(batch_max))
        self.poster = poster
        self._pending: list[dict[str, Any]] = []
        self._spool: Deque[dict[str, Any]] = deque(maxlen=max(1, int(spool_max)))
        self._last_flush: float | None = None
        # Stats (tests + a periodic log line).
        self.sent = 0
        self.dropped = 0
        self.flushes = 0

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def spool_count(self) -> int:
        return len(self._spool)

    def add(self, event: dict[str, Any], now: float | None = None) -> bool:
        """Queue one event; flush if the interval elapsed or the batch is full.
        Returns True when a flush happened as a result of this add."""
        n = time.time() if now is None else now
        self._pending.append(event)
        if len(self._pending) >= self.batch_max or self._due(n):
            return self.flush(n)
        return False

    def _due(self, now: float) -> bool:
        return self._last_flush is None or (now - self._last_flush) >= self.flush_interval

    def flush(self, now: float | None = None) -> bool:
        """Attempt to POST the spool + pending as one batch. Returns True when
        a POST was attempted (regardless of success)."""
        n = time.time() if now is None else now
        # Take ownership of everything queued so re-spooling starts from empty
        # (never double-counts the events that were already spooled).
        batch = list(self._spool) + self._pending
        self._spool.clear()
        self._pending.clear()
        if not batch:
            self._last_flush = n
            return False

        self._last_flush = n
        self.flushes += 1

        if not self.url:
            # No delivery target: keep spooling (bounded), never lose unbounded.
            self._respool(batch)
            return False

        status = self.poster(self.url, batch, token=self.token)
        if 200 <= status < 300:
            self.sent += len(batch)
            return True

        # Failed: re-spool for the next attempt (bounded ring drops oldest).
        self._respool(batch)
        return True

    def _respool(self, batch: list[dict[str, Any]]) -> None:
        # Called only after the spool was cleared, so it is empty here.
        cap = self._spool.maxlen or len(batch)
        incoming = len(batch)
        if incoming > cap:
            self.dropped += incoming - cap
            batch = batch[incoming - cap:]  # keep the newest, drop oldest
        for ev in batch:
            self._spool.append(ev)

    def spool_to_disk(self, path: str) -> int:
        """Persist the spool + pending to a JSONL file (best-effort). Returns
        the number of events written. Used on shutdown so an outage that
        outlives the process survives a restart."""
        rows = list(self._spool) + self._pending
        if not rows:
            return 0
        import os

        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        return len(rows)

    def load_from_disk(self, path: str) -> int:
        """Re-load a spooled JSONL file into the ring (best-effort)."""
        import os

        if not os.path.exists(path):
            return 0
        loaded = 0
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    self._spool.append(json.loads(line))
                    loaded += 1
                except (json.JSONDecodeError, ValueError):
                    continue
        return loaded
