"""streamhub_sdk — the Python side of the StreamHub app contract.

Small, dependency-free helpers a decoupled Studio App's worker relies on so the
same code runs co-located inside a StreamHub install OR standalone on the
operator's own infra. F0 ships the migrations runner; the signed-callback HTTP
helper (:mod:`streamhub_sdk.http`) lands with the standalone phase.
"""

from .migrations import Migration, MigrationError, apply_migrations, discover_migrations

__all__ = [
    "Migration",
    "MigrationError",
    "apply_migrations",
    "discover_migrations",
]

__version__ = "0.1.0"
