"""
Locate the shared `streamhub_sdk` (the StreamHub app SDK) from wherever it lives
and re-export the bits this worker uses. Importing this module makes
`apply_migrations` available in BOTH deployment shapes:

  1. Composed app bundle — `apps-pack.mjs` vendors `streamhub_sdk/` next to
     `lpr_worker/` inside `worker/`, so a plain import resolves off PYTHONPATH.
  2. Monorepo checkout — the SDK lives at `<repo>/streamhub-app-sdk/streamhub_sdk`;
     we walk up from here to find it and add it to sys.path (dev + repo-root
     pytest). No install / PYTHONPATH juggling required.
"""
from __future__ import annotations

import os
import sys


def _ensure_sdk_on_path() -> None:
    try:
        import streamhub_sdk  # noqa: F401

        return
    except ImportError:
        pass
    # Walk up looking for a monorepo `streamhub-app-sdk/streamhub_sdk` package.
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        cand = os.path.join(d, "streamhub-app-sdk")
        if os.path.isdir(os.path.join(cand, "streamhub_sdk")):
            sys.path.insert(0, cand)
            return
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent


_ensure_sdk_on_path()

from streamhub_sdk.migrations import (  # noqa: E402
    MigrationError,
    apply_migrations,
)

__all__ = ["apply_migrations", "MigrationError"]
