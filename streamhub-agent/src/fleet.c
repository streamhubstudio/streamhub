/*
 * StreamHub fleet management — C supervisor (see fleet.h).
 *
 * Everything protocol-related is in scripts/fleet_agent.py (paho-mqtt); this
 * file only locates python3 + the script, spawns the companion and keeps it
 * alive from the main loop without blocking — the same pattern as onvif.c and
 * the edge detection worker.
 */

#include "fleet.h"
#include "log.h"
#include "util.h"
#include "platform.h"

/* Reuse the edge-worker's python interpreter finder. */
#include "detect_internal.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#ifndef VERSION
#define VERSION "0.0"
#endif

/* File-scope supervision state so fleet_stop() can reach the child too. */
static platform_proc_t g_proc;
static int    g_running   = 0;
static time_t g_next_start = 0;   /* deferred (re)start time (0 = start now) */
static int    g_backoff    = 0;   /* current restart backoff, seconds */
static int    g_warned     = 0;

/* ── Locate scripts/fleet_agent.py (same search order as onvif/edge) ─ */

static int find_fleet_script(char *script, size_t len)
{
#ifdef PLAT_WINDOWS
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0)
        snprintf(script, len, "%s\\scripts\\fleet_agent.py", exe_dir);
    else
        snprintf(script, len, "scripts\\fleet_agent.py");
#else
    snprintf(script, len, "scripts/fleet_agent.py");
    /* Prefer a copy next to the exe when present (installed layout:
     * /usr/local/bin/streamhub-agent + /usr/local/bin/scripts/fleet_agent.py) */
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
        char alt[MAX_PATH_LEN];
        snprintf(alt, sizeof(alt), "%s/scripts/fleet_agent.py", exe_dir);
        if (file_exists(alt))
            snprintf(script, len, "%s", alt);
    }
#endif
    return file_exists(script) ? 0 : -1;
}

/* ── Periodic supervision from the agent main loop ──────────────────
 * Persistent companion: start it once, respawn with capped backoff if it dies.
 * Output goes to the agent's stdout/stderr (journal on systemd hosts). */

void fleet_tick(const agent_config_t *cfg,
                const char *config_path, const char *secrets_path)
{
    if (cfg->fleet_interval <= 0)
        return; /* fleet management disabled */

    if (g_running) {
        if (plat_proc_alive(&g_proc))
            return;
        g_running = 0;
        LOG_W("fleet: companion exited; scheduling respawn");
        if (g_backoff < 3) g_backoff = 3;
        else if (g_backoff < 60) g_backoff *= 2;
        if (g_backoff > 60) g_backoff = 60;
        g_next_start = time(NULL) + g_backoff;
        return;
    }

    time_t now = time(NULL);
    if (g_next_start && now < g_next_start)
        return;

    const char *python = detect_find_python();
    char script[MAX_PATH_LEN];
    if (!python || find_fleet_script(script, sizeof(script)) != 0) {
        if (!g_warned) {
            LOG_W("fleet: fleet.interval set but python3/scripts/fleet_agent.py "
                  "missing — fleet management disabled");
            g_warned = 1;
        }
        g_next_start = now + 60; /* don't re-stat every loop iteration */
        return;
    }

    char *args[] = {
        (char *)python, script,
        "--config",        (char *)config_path,
        "--secrets",       (char *)secrets_path,
        "--agent-version", (char *)VERSION,
        NULL
    };
    if (plat_spawn(&g_proc, python, args, 0, 0) != 0) {
        LOG_W("fleet: failed to spawn companion");
        g_next_start = now + 30;
        return;
    }
    g_running    = 1;
    g_backoff    = 0;
    g_next_start = 0;
    LOG_I("fleet: companion started (telemetry every %ds)", cfg->fleet_interval);
}

/* ── Stop on shutdown ───────────────────────────────────────────────*/

void fleet_stop(void)
{
    if (!g_running)
        return;
    LOG_I("fleet: stopping companion");
    plat_proc_terminate(&g_proc);
    if (plat_proc_wait(&g_proc, 3) != 0)
        plat_proc_kill(&g_proc);
    g_running = 0;
}
