/*
 * ONVIF discovery/registration — C side (see onvif.h).
 *
 * Everything protocol-related is in scripts/onvif.py (stdlib-only Python);
 * this file only locates python3 + the script, spawns it and (for the
 * periodic re-scan) supervises the child from the main loop without blocking.
 */

#include "onvif.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

/* Reuse the edge-worker's python interpreter finder. */
#include "detect_internal.h"

#define ONVIF_MAX_ARGS 24

/* ── Locate scripts/onvif.py (same search order as the edge worker) ─ */

static int find_onvif_script(char *script, size_t len)
{
#ifdef PLAT_WINDOWS
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0)
        snprintf(script, len, "%s\\scripts\\onvif.py", exe_dir);
    else
        snprintf(script, len, "scripts\\onvif.py");
#else
    snprintf(script, len, "scripts/onvif.py");
    /* Prefer a copy next to the exe when present (installed layout:
     * /usr/local/bin/streamhub-agent + /usr/local/bin/scripts/onvif.py) */
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
        char alt[MAX_PATH_LEN];
        snprintf(alt, sizeof(alt), "%s/scripts/onvif.py", exe_dir);
        if (file_exists(alt))
            snprintf(script, len, "%s", alt);
    }
#endif
    return file_exists(script) ? 0 : -1;
}

/* ── CLI: streamhub-agent onvif scan|sync [...] ─────────────────────
 * Builds: python3 scripts/onvif.py <argv[2..]> [--config <def>] [--secrets
 * <def>] and runs it in the foreground (stdout/stderr inherited). */

int onvif_cli(int argc, char **argv,
              const char *default_config, const char *default_secrets)
{
    const char *python = detect_find_python();
    if (!python) {
        fprintf(stderr, "onvif: python3 not found — the onvif tool needs a "
                        "Python 3 interpreter (stdlib only, no pip deps)\n");
        return 1;
    }

    char script[MAX_PATH_LEN];
    if (find_onvif_script(script, sizeof(script)) != 0) {
        fprintf(stderr, "onvif: scripts/onvif.py not found (looked next to "
                        "the binary and in the current directory)\n");
        return 1;
    }

    char *args[ONVIF_MAX_ARGS];
    int n = 0;
    int has_config = 0, has_secrets = 0;

    args[n++] = (char *)python;
    args[n++] = script;
    for (int i = 2; i < argc && n < ONVIF_MAX_ARGS - 5; i++) {
        if (strcmp(argv[i], "--config") == 0)  has_config = 1;
        if (strcmp(argv[i], "--secrets") == 0) has_secrets = 1;
        args[n++] = argv[i];
    }
    /* Default to the daemon's config/secrets paths — but only when they
     * exist (desktop checkouts keep config.yml in the cwd, which is the
     * Python tool's own default). */
    if (!has_config && file_exists(default_config)) {
        args[n++] = "--config";
        args[n++] = (char *)default_config;
    }
    if (!has_secrets && file_exists(default_secrets)) {
        args[n++] = "--secrets";
        args[n++] = (char *)default_secrets;
    }
    args[n] = NULL;

    platform_proc_t proc;
    if (plat_spawn(&proc, python, args, 0, 0) != 0) {
        fprintf(stderr, "onvif: failed to spawn %s\n", python);
        return 1;
    }
    while (plat_proc_alive(&proc))
        plat_sleep_ms(100);
    return plat_proc_exit_ok(&proc) ? 0 : 1;
}

/* ── Periodic re-scan from the agent main loop ──────────────────────
 * Rate-limited by cfg->onvif_rescan_interval; at most one child at a time;
 * output goes to the agent's stdout/stderr (journal on systemd hosts). */

void onvif_tick(const agent_config_t *cfg,
                const char *config_path, const char *secrets_path)
{
    static platform_proc_t proc;
    static int    running = 0;
    static time_t last_run = 0;
    static int    warned = 0;

    if (cfg->onvif_rescan_interval <= 0)
        return;

    if (running) {
        if (plat_proc_alive(&proc))
            return;
        running = 0;
        if (plat_proc_exit_ok(&proc))
            LOG_I("onvif: periodic sync finished");
        else
            LOG_W("onvif: periodic sync exited with an error");
    }

    time_t now = time(NULL);
    if (last_run && now - last_run < cfg->onvif_rescan_interval)
        return;

    const char *python = detect_find_python();
    char script[MAX_PATH_LEN];
    if (!python || find_onvif_script(script, sizeof(script)) != 0) {
        if (!warned) {
            LOG_W("onvif: rescan_interval set but python3/scripts/onvif.py "
                  "missing — periodic ONVIF sync disabled");
            warned = 1;
        }
        last_run = now; /* don't re-stat every loop iteration */
        return;
    }

    char *args[] = {
        (char *)python, script, "sync", "--quiet",
        "--config",  (char *)config_path,
        "--secrets", (char *)secrets_path,
        NULL
    };
    last_run = now;
    if (plat_spawn(&proc, python, args, 0, 0) != 0) {
        LOG_W("onvif: failed to spawn periodic sync");
        return;
    }
    running = 1;
    LOG_I("onvif: periodic sync started (every %ds)", cfg->onvif_rescan_interval);
}
