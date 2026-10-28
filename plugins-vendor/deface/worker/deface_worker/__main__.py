"""
Entrypoint: `python -m deface_worker --app <app>`.

Config comes from the environment (set by the core plugin's worker.spawn plus
the framework-injected STREAMHUB_INGEST_* vars); the only CLI arg is `--app`,
purely so the process line is self-describing in `ps` and the plugin logs. A
SIGTERM (how the core worker-hook stops workers) is turned into a clean
shutdown.
"""
from __future__ import annotations

import argparse
import signal
import sys

from .config import Config
from .runner import log, run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="deface_worker")
    parser.add_argument("--app", default=None, help="App slug (overrides DEFACE_APP).")
    args = parser.parse_args(argv)

    config = Config.from_env()
    if args.app:
        config.app = args.app

    reader_holder: dict[str, object] = {}

    def _handle_term(signum, _frame):
        log("signal", signal=int(signum))
        reader = reader_holder.get("reader")
        if reader is not None and hasattr(reader, "stop"):
            reader.stop()  # type: ignore[attr-defined]

    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    # Build the reader up-front so the signal handler can stop it mid-loop.
    source = config.stream_source()
    reader = None
    if source:
        from .stream import HlsFrameReader

        reader = HlsFrameReader(source, config.fps)
        reader_holder["reader"] = reader

    return run(config, reader=reader)


if __name__ == "__main__":
    sys.exit(main())
