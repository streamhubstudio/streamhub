/*
 * Edge detection backend — on-device inference via the local Python worker.
 *
 * Restored from the pre-remote agent (git ae4a30c^:src/detect.c), rebranded and
 * kept behind detect.mode=edge. Spawns scripts/detect.py (ultralytics + opencv)
 * per camera; the worker reads the RTSP feed, runs YOLO + ByteTrack and writes:
 *   <output_dir>/frame.jpg        annotated preview (served by the WebUI)
 *   <output_dir>/detections.json  latest detection events (unified shape)
 * detect_edge_tick reaps the child, restarts it with backoff, and mirrors the
 * events file into ctx->events so the WebUI/MQTT path is identical to remote.
 *
 * The ML dependencies are only needed here — remote/off modes never spawn this,
 * so a remote-only install does not need ultralytics/opencv/torch.
 */

#include "detect.h"
#include "detect_internal.h"
#include "log.h"
#include "util.h"

#include <cJSON.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ── Find Python interpreter ─────────────────────────────────────── */

const char *detect_find_python(void)
{
    static char found[MAX_PATH_LEN] = {0};

#ifdef PLAT_WINDOWS
    /* 1. Portable Python alongside exe */
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
        snprintf(found, sizeof(found), "%s\\python\\python.exe", exe_dir);
        if (file_exists(found)) return found;
    }
    /* 2. Portable Python in CWD */
    if (file_exists("python\\python.exe")) {
        snprintf(found, sizeof(found), "python\\python.exe");
        return found;
    }
    /* 3. System Python */
    static const char *win_names[] = { "python3", "python", NULL };
    for (int i = 0; win_names[i]; i++) {
        char cmd[64];
        snprintf(cmd, sizeof(cmd), "where %s >NUL 2>&1", win_names[i]);
        if (system(cmd) == 0) {
            snprintf(found, sizeof(found), "%s", win_names[i]);
            return found;
        }
    }
#else
    /* 1. Portable Python alongside exe */
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
        snprintf(found, sizeof(found), "%s/python/bin/python3", exe_dir);
        if (file_exists(found)) return found;
    }
    /* 2. Portable in CWD */
    if (file_exists("./python/bin/python3")) {
        snprintf(found, sizeof(found), "./python/bin/python3");
        return found;
    }
    /* 3. System Python */
    static const char *paths[] = {
        "/usr/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python",
        NULL
    };
    for (int i = 0; paths[i]; i++) {
        if (file_exists(paths[i])) {
            snprintf(found, sizeof(found), "%s", paths[i]);
            return found;
        }
    }
#endif

    return NULL;
}

/* ── Locate the worker script ────────────────────────────────────── */

static int find_script(char *script, size_t len)
{
#ifdef PLAT_WINDOWS
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0)
        snprintf(script, len, "%s\\scripts\\detect.py", exe_dir);
    else
        snprintf(script, len, "scripts\\detect.py");
#else
    snprintf(script, len, "scripts/detect.py");
    /* Prefer a copy next to the exe when present */
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
        char alt[MAX_PATH_LEN];
        snprintf(alt, sizeof(alt), "%s/scripts/detect.py", exe_dir);
        if (file_exists(alt))
            snprintf(script, len, "%s", alt);
    }
#endif
    return file_exists(script) ? 0 : -1;
}

/* ── Start ───────────────────────────────────────────────────────── */

int detect_edge_start(detect_ctx_t *ctx, const agent_config_t *cfg,
                      const camera_t *cam)
{
    ctx->cam  = cam;
    ctx->mode = DETECT_MODE_EDGE;

    const char *python = detect_find_python();
    if (!python) {
        LOG_E("detect: python not found, cannot start edge detection for %s "
              "(install the edge ML deps: pip install -r scripts/requirements.txt)",
              cam->id);
        return -1;
    }

    const cam_detect_t *d = &cam->detect;

    /* Output dir for this camera's frames + events */
    snprintf(ctx->output_dir, sizeof(ctx->output_dir), "./detections/%s", cam->id);
    mkdirs(ctx->output_dir);

    char script[MAX_PATH_LEN];
    if (find_script(script, sizeof(script)) != 0) {
        LOG_E("detect: worker script not found (scripts/detect.py) for %s", cam->id);
        return -1;
    }

    /* Targets → comma-separated string */
    char targets_str[512] = "";
    for (int i = 0; i < d->target_count; i++) {
        if (i > 0)
            strncat(targets_str, ",", sizeof(targets_str) - strlen(targets_str) - 1);
        strncat(targets_str, d->targets[i], sizeof(targets_str) - strlen(targets_str) - 1);
    }

    char conf_str[16], fps_str[8];
    snprintf(conf_str, sizeof(conf_str), "%.2f", d->confidence);
    snprintf(fps_str, sizeof(fps_str), "%d", d->fps > 0 ? d->fps : 2);

    /* Zones file — same location the WebUI writes to (config_save_zones) */
    char zones_file[MAX_PATH_LEN];
#ifdef PLAT_WINDOWS
    snprintf(zones_file, sizeof(zones_file), "zones.json");
#else
    snprintf(zones_file, sizeof(zones_file), "/userdata/streamhub/zones.json");
    if (!file_exists(zones_file))
        snprintf(zones_file, sizeof(zones_file), "zones.json");
#endif

    char *argv[] = {
        (char *)python,
        script,
        "--rtsp", (char *)cam->rtsp,
        "--model", (char *)(d->model[0] ? d->model : "yolo11n"),
        "--confidence", conf_str,
        "--targets", targets_str,
        "--tracker", (char *)(d->tracker[0] ? d->tracker : "bytetrack"),
        "--fps", fps_str,
        "--output-dir", ctx->output_dir,
        "--zones-file", zones_file,
        "--cam-id", (char *)cam->id,
        NULL
    };

    if (plat_spawn(&ctx->proc, python, argv, 0, 0) != 0) {
        LOG_E("detect: failed to spawn edge worker for %s", cam->id);
        return -1;
    }

    ctx->running          = true;
    ctx->restart_count    = 0;
    ctx->restart_delay    = 0;
    ctx->restart_at       = 0;
    ctx->last_event_check = 0;
    ctx->events_len       = 0;
    ctx->last_ts_ms       = 0;
    ctx->last_count       = 0;

    LOG_I("detect: started edge worker for %s (model=%s fps=%s)",
          cam->id, d->model[0] ? d->model : "yolo11n", fps_str);
    (void)cfg;
    return 0;
}

/* ── Stop ────────────────────────────────────────────────────────── */

void detect_edge_stop(detect_ctx_t *ctx)
{
    LOG_I("detect: stopping edge worker for %s", ctx->cam ? ctx->cam->id : "?");
    plat_proc_terminate(&ctx->proc);

    /* Wait up to 3 seconds for graceful exit */
    if (plat_proc_wait(&ctx->proc, 3) != 0) {
        LOG_W("detect: killing stuck edge worker for %s",
              ctx->cam ? ctx->cam->id : "?");
        plat_proc_kill(&ctx->proc);
    }

    ctx->running    = false;
    ctx->restart_at = 0;   /* explicit stop — do not auto-restart */
}

/* ── Mirror the events file into ctx (unified events shape) ──────── */

static void load_events(detect_ctx_t *ctx)
{
    char path[MAX_PATH_LEN];
    snprintf(path, sizeof(path), "%s/detections.json", ctx->output_dir);

    FILE *f = fopen(path, "r");
    if (!f) return;
    int n = (int)fread(ctx->events, 1, DETECT_EVENTS_MAX - 1, f);
    fclose(f);
    if (n <= 0) return;
    ctx->events[n] = '\0';
    ctx->events_len = n;

    /* Parse count + timestamp for the MQTT-notify path (best-effort) */
    cJSON *root = cJSON_ParseWithLength(ctx->events, n);
    if (root) {
        cJSON *c = cJSON_GetObjectItem(root, "count");
        if (c) ctx->last_count = (int)c->valuedouble;
        cJSON *t = cJSON_GetObjectItem(root, "timestamp");
        if (t) ctx->last_ts_ms = (long long)(t->valuedouble * 1000.0);
        cJSON_Delete(root);
    }
}

/* ── Tick: health, restart with backoff, refresh events ──────────── */

int detect_edge_tick(detect_ctx_t *ctx, const agent_config_t *cfg)
{
    if (!ctx->cam) return 0;

    /* Not running — fire a pending restart when due */
    if (!ctx->running) {
        if (ctx->restart_at > 0 && time(NULL) >= ctx->restart_at) {
            LOG_I("detect: restarting edge worker for %s (attempt %d)",
                  ctx->cam->id, ctx->restart_count + 1);
            ctx->restart_at = 0;
            return detect_edge_start(ctx, cfg, ctx->cam);
        }
        return 0;
    }

    /* Worker died — schedule a restart with exponential backoff */
    if (!plat_proc_alive(&ctx->proc)) {
        LOG_W("detect: edge worker exited for %s", ctx->cam->id);
        ctx->running = false;

        ctx->restart_count++;
        if (ctx->restart_delay < 3)       ctx->restart_delay = 3;
        else if (ctx->restart_delay < 60) ctx->restart_delay *= 2;
        if (ctx->restart_delay > 60)      ctx->restart_delay = 60;

        ctx->restart_at = time(NULL) + ctx->restart_delay;
        LOG_I("detect: will restart %s in %ds", ctx->cam->id, ctx->restart_delay);
        return 0;
    }

    /* Alive — refresh the events snapshot for the WebUI/MQTT path (~1 Hz) */
    if (time(NULL) - ctx->last_event_check >= 1) {
        ctx->last_event_check = time(NULL);
        load_events(ctx);
    }
    return 0;
}

/* ── Preview path (annotated frame written by the worker) ────────── */

const char *detect_preview_path(const detect_ctx_t *ctx)
{
    static char path[MAX_PATH_LEN];
    snprintf(path, sizeof(path), "%s/frame.jpg", ctx->output_dir);
    return path;
}
