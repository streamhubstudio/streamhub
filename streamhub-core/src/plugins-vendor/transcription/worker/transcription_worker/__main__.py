"""
Entrypoint: `python -m transcription_worker --app <app>`.

Config comes from the environment (set by the core plugin's worker.spawn);
the only CLI arg is `--app`, purely so the process line is self-describing in
`ps` and the plugin logs. A SIGTERM (how the core worker-hook stops workers)
flips the stop flag so the loop exits after the current job.
"""
from __future__ import annotations

import argparse
import signal
import sys

from .config import Config
from .runner import log, run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="transcription_worker")
    parser.add_argument(
        "--app", default=None, help="App slug (overrides TRANSCRIBE_APP)."
    )
    args = parser.parse_args(argv)

    config = Config.from_env()
    if args.app:
        config.app = args.app

    stop = {"flag": False}

    def _handle_term(signum, _frame):
        log("signal", signal=int(signum))
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _handle_term)
    signal.signal(signal.SIGINT, _handle_term)

    return run(config, should_stop=lambda: stop["flag"])


if __name__ == "__main__":
    sys.exit(main())
