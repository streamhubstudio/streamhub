#ifndef AGENT_FLEET_H
#define AGENT_FLEET_H

/*
 * StreamHub fleet management — C side.
 *
 * The MQTT fleet plane (telemetry + online/offline + remote control: restart /
 * OTA / config / ping) lives in scripts/fleet_agent.py, which speaks the
 * StreamHub fleet protocol on the SAME per-app broker the app already uses
 * (streamhub/<app>/agents/<id>/...; mirrors streamhub-core modules/fleet). This
 * module is the thin C supervisor: it spawns the Python companion and keeps it
 * alive from the agent main loop (mirroring onvif_tick / the edge worker),
 * passing --config/--secrets and the compiled-in agent VERSION so telemetry's
 * agentVersion is always accurate.
 *
 * Gated on config.yml `fleet.interval` (seconds, 0 = disabled). See
 * streamhub-docs/features/fleet.md.
 */

#include "config.h"

/* Periodic supervision from the agent main loop (non-blocking). No-op unless
 * cfg->fleet_interval > 0 and python3 + scripts/fleet_agent.py exist. Starts
 * the companion, and respawns it with capped backoff if it dies. */
void fleet_tick(const agent_config_t *cfg,
                const char *config_path, const char *secrets_path);

/* Stop the companion on agent shutdown (SIGTERM, then SIGKILL if stuck). */
void fleet_stop(void);

#endif
