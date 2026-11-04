#ifndef AGENT_ONVIF_H
#define AGENT_ONVIF_H

/*
 * ONVIF camera discovery + StreamHub auto-registration.
 *
 * The heavy lifting (WS-Discovery multicast, ONVIF Profile S SOAP calls,
 * POST /api/v1/apps/<app>/ingress) lives in scripts/onvif.py — stdlib-only
 * Python, no pip deps. This module is the thin C side:
 *
 *   - onvif_cli():  `streamhub-agent onvif scan|sync [...]` — dispatched from
 *     main() before the agent starts; spawns the Python tool and waits.
 *   - onvif_tick(): optional periodic re-scan from the agent main loop,
 *     driven by config.yml `onvif.rescan_interval` (seconds, 0 = disabled).
 *     Spawns `onvif.py sync --quiet` in the background, never blocks the
 *     event loop, and keeps at most one instance running.
 */

#include "config.h"

/* Run the onvif subcommand: argv = {"streamhub-agent", "onvif", ...}.
 * config/secrets defaults are appended unless the caller passed --config /
 * --secrets explicitly. Returns the tool's exit status (0 = ok). */
int onvif_cli(int argc, char **argv,
              const char *default_config, const char *default_secrets);

/* Periodic re-scan (main loop, non-blocking). No-op unless
 * cfg->onvif_rescan_interval > 0 and python3 + scripts/onvif.py exist. */
void onvif_tick(const agent_config_t *cfg,
                const char *config_path, const char *secrets_path);

#endif
