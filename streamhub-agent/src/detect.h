#ifndef AGENT_DETECT_H
#define AGENT_DETECT_H

#include "config.h"
#include "platform.h"
#include <stdbool.h>
#include <time.h>

/*
 * Detection — per-camera, one of three modes (cam->detect.mode, see config.h):
 *
 *   remote  Server-side detection. The camera is streamed to the StreamHub
 *           instance (see stream.c) and a plugin (yolo/deface) runs inference
 *           there; the agent SUBSCRIBES to the results by polling the plugin
 *           live-data endpoint. No inference on the device. See detect_remote.c.
 *
 *             GET https://<callback_url>/api/v1/apps/<app>/plugins/<plugin>/live?room=<room>
 *
 *           where <app> = cfg->tenant, <plugin> = cam->detect.plugin and
 *           <room> = cam->room, falling back to "<tenant>-<cam_id>".
 *
 *   edge    On-device detection. A local worker (scripts/detect.py, ultralytics
 *           + opencv) reads the camera's RTSP feed, runs inference and writes
 *           annotated frames + detection events to <output_dir>. No continuous
 *           upload to a server is required. See detect_edge.c. Requires the ML
 *           deps installed on the device.
 *
 *   off     No detection.
 *
 * Regardless of mode, the latest detections are exposed to the WebUI/MQTT
 * consumers in ONE shape (detect_read_events serves ctx->events):
 *
 *   { "timestamp": <sec>, "count": N,
 *     "detections": [ { "class", "confidence", "bbox", "track_id" } ],
 *     "line_counts": { ... } }
 *
 * (remote adds "age_ms" and reports track_id -1 / empty line_counts, since the
 * plugin live feed carries no tracker ids or zone/line state — those are
 * server-side seams; edge fills them in locally.)
 *
 * The remote HTTP fetch (detect_fetch_events) is BLOCKING and must run off the
 * main event loop — main.c drives it from a background worker thread and copies
 * results into the ctx on the main thread. The edge worker is a spawned child
 * process whose health is polled on the main thread via detect_tick.
 */

#define DETECT_EVENTS_MAX 4096

typedef struct {
    const camera_t *cam;
    detect_mode_t   mode;                 /* resolved from cam->detect.mode at start */
    bool       running;

    /* Latest detections in the unified events shape (both modes write here) */
    char       events[DETECT_EVENTS_MAX];
    int        events_len;
    long long  last_ts_ms;                /* ts of stored payload (server ingest / local) */
    int        last_count;                /* detections in stored payload */
    time_t     last_notify;               /* MQTT notify debounce */

    /* ── remote mode (subscriber) ── */
    time_t     last_poll;                 /* main-thread poll gate */
    int        fail_count;                /* consecutive fetch failures */

    /* ── edge mode (local worker process) ── */
    platform_proc_t proc;
    char       output_dir[MAX_PATH_LEN];  /* <base>/detections/<cam_id> */
    time_t     last_event_check;          /* events-file read throttle */
    int        restart_count;
    time_t     restart_at;                /* deferred restart (0 = none pending) */
    int        restart_delay;             /* current backoff (seconds) */
} detect_ctx_t;

/*
 * Start/stop detection for a camera. Dispatches on cam->detect.mode:
 *   remote → validate config + mark the subscription active (no process);
 *   edge   → spawn the local worker;
 *   off    → no-op.
 */
int  detect_start(detect_ctx_t *ctx, const agent_config_t *cfg,
                  const camera_t *cam);
void detect_stop(detect_ctx_t *ctx);

/*
 * Periodic tick (MAIN THREAD, non-blocking). Only edge mode does work here:
 * checks worker health, refreshes the events file into ctx and schedules
 * restarts with backoff. Remote mode is driven by main.c's fetch worker and
 * this is a no-op. Safe to call every loop.
 */
int  detect_tick(detect_ctx_t *ctx, const agent_config_t *cfg);

/*
 * Resolve the StreamHub room for a camera:
 * cam->room when set, else "<tenant>-<cam_id>".
 */
void detect_room(const agent_config_t *cfg, const camera_t *cam,
                 char *out, size_t out_len);

/*
 * Fetch the latest detection events from StreamHub (REMOTE mode only, BLOCKING
 * — worker thread only). On success writes the translated unified-shape JSON
 * into buf, sets *ts_ms to the server ingest timestamp and *count to the number
 * of detections. Returns bytes written, 0 when no live data exists yet, or -1
 * on transport/parse error.
 */
int  detect_fetch_events(const agent_config_t *cfg, const camera_t *cam,
                         char *buf, int buf_size,
                         long long *ts_ms, int *count);

/*
 * Read the latest stored events JSON into buf (main thread). Same shape for
 * both modes. Returns bytes copied, or -1 when none are stored yet.
 */
int  detect_read_events(const detect_ctx_t *ctx, char *buf, int buf_size);

/*
 * Path to the locally annotated preview frame (EDGE mode only; remote has no
 * local frame). Returns a static-within-ctx path; the file may not exist yet.
 */
const char *detect_preview_path(const detect_ctx_t *ctx);

#endif
