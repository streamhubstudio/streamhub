"""Worker HTTP helpers — PLACEHOLDER (lands with the standalone phase, F3).

A decoupled app's worker talks back to the core over signed callbacks
(``X-StreamHub-Signature: sha256=<HMAC>``) and the framework live/events
channel. That helper (sign, post-with-retry, verify) will live here so both the
co-located and the standalone deployment share ONE implementation.

Intentionally empty for F0 — importing it must not pull any dependency.
"""

from __future__ import annotations

__all__: list[str] = []
