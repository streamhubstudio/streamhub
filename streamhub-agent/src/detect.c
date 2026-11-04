#include "detect.h"
#include "detect_internal.h"
#include "log.h"

#include <stdio.h>
#include <string.h>

/* ── Room resolution (shared by both modes) ──────────────────────── */

void detect_room(const agent_config_t *cfg, const camera_t *cam,
                 char *out, size_t out_len)
{
    if (cam->room[0])
        snprintf(out, out_len, "%s", cam->room);
    else
        snprintf(out, out_len, "%s-%s", cfg->tenant, cam->id);
}

/* ── Mode dispatch ───────────────────────────────────────────────── */

int detect_start(detect_ctx_t *ctx, const agent_config_t *cfg,
                 const camera_t *cam)
{
    if (ctx->running) return 0;

    switch (cam->detect.mode) {
    case DETECT_MODE_OFF:
        LOG_I("detect: %s mode=off (detection disabled)", cam->id);
        return 0;
    case DETECT_MODE_EDGE:
        return detect_edge_start(ctx, cfg, cam);
    case DETECT_MODE_REMOTE:
    default:
        return detect_remote_start(ctx, cfg, cam);
    }
}

void detect_stop(detect_ctx_t *ctx)
{
    if (!ctx->running) return;
    if (ctx->mode == DETECT_MODE_EDGE)
        detect_edge_stop(ctx);
    else
        detect_remote_stop(ctx);
}

int detect_tick(detect_ctx_t *ctx, const agent_config_t *cfg)
{
    /* Only edge mode has a main-thread lifecycle to service. Remote polling is
     * driven by main.c's background fetch worker. Edge is dispatched even when
     * !running so a pending restart (after a worker death) can fire. */
    if (ctx->mode == DETECT_MODE_EDGE)
        return detect_edge_tick(ctx, cfg);
    return 0;
}

/* ── Read stored events (main thread) ────────────────────────────── */
/* Unified across modes: both backends publish the latest events into
 * ctx->events, so consumers (WebUI, MQTT) never branch on the mode. */

int detect_read_events(const detect_ctx_t *ctx, char *buf, int buf_size)
{
    if (ctx->events_len <= 0) return -1;

    int len = ctx->events_len;
    if (len >= buf_size) len = buf_size - 1;
    memcpy(buf, ctx->events, len);
    buf[len] = '\0';
    return len;
}
