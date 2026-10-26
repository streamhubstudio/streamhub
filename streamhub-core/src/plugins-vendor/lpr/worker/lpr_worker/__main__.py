"""
Entrypoint: `python -m lpr_worker --app <app> [--config <file.json>]`.

Config comes from the environment (set by the core plugin's worker.spawn plus
the framework-injected STREAMHUB_* vars), optionally overlaid by a JSON blob
(LPR_CONFIG_JSON env or a --config file — handy for edge boxes provisioned by
config management). The only positional-ish CLI arg is `--app`, purely so the
process line is self-describing in `ps` and the plugin logs. A SIGTERM (how
the core worker-hook stops workers) is turned into a clean shutdown.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys

from .config import Config, merge_json_config
from .runner import log, run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lpr_worker")
    parser.add_argument("--app", default=None, help="App slug (overrides LPR_APP).")
    parser.add_argument(
        "--config",
        default=None,
        help="Path to a JSON config override (same keys as the plugin config).",
    )
    args = parser.parse_args(argv)

    config = Config.from_env()
    json_text = os.environ.get("LPR_CONFIG_JSON", "")
    if args.config:
        try:
            with open(args.config, "r", encoding="utf-8") as fh:
                json_text = fh.read()
        except OSError as exc:
            log("config_error", message=f"cannot read --config file: {exc}")
            return 2
    try:
        config = merge_json_config(config, json_text)
    except ValueError as exc:
        log("config_error", message=str(exc))
        return 2
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
