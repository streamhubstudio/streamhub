"""StreamHub presence worker — workstation-presence detection over live HLS.

Spawned per app by the StreamHub `presence` plugin (see
streamhub-core/src/plugins/presence/plugin.meta.ts). Pure edge-ready process:
every input arrives via environment variables / args, results leave via HTTP
(core live-data channel + plugin events endpoint + optional external webhook)
and a self-owned SQLite database. No core imports.
"""

__version__ = "1.0.0"
