#include "stream.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Build the RTMP URL with hostname resolved to IP.
 * Input:  rtmp://media.example.com/live/myapp-c001
 * Output: rtmp://203.0.113.10/live/myapp-c001
 */
int stream_build_rtmp_url(const agent_config_t *cfg, const camera_t *cam,
                          char *out, size_t out_len)
{
    /* RTMP URL = stream_server + stream key.
     * StreamHub mints the key per ingress (POST /api/v1/apps/{app}/ingress)
     * — configure it per camera as `stream_key`. When unset, fall back to
     * the legacy "<tenant>-<cam_id>" suffix.
     * e.g. rtmp://streamhub.example.com:1935/live/ + abc123 */
    char full[MAX_URL_LEN];
    if (cam->stream_key[0])
        snprintf(full, sizeof(full), "%s%s", cfg->stream_server, cam->stream_key);
    else
        snprintf(full, sizeof(full), "%s%s-%s", cfg->stream_server, cfg->tenant, cam->id);

    /* Extract hostname from rtmp://hostname/path or rtmps://hostname/path */
    const char *p = full;
    const char *scheme = "rtmp";
    int default_port = 1935;
    if (strncmp(p, "rtmps://", 8) == 0) {
        scheme = "rtmps";
        default_port = 443;
        p += 8;
    } else if (strncmp(p, "rtmp://", 7) == 0) {
        p += 7;
    } else {
        snprintf(out, out_len, "%s", full);
        return 0;
    }

    const char *slash = strchr(p, '/');
    const char *colon = strchr(p, ':');

    char hostname[256];
    int port = default_port;

    if (colon && (!slash || colon < slash)) {
        snprintf(hostname, sizeof(hostname), "%.*s", (int)(colon - p), p);
        port = atoi(colon + 1);
    } else if (slash) {
        snprintf(hostname, sizeof(hostname), "%.*s", (int)(slash - p), p);
    } else {
        snprintf(hostname, sizeof(hostname), "%s", p);
    }

    /* Resolve hostname to IP */
    char ip[64];
    if (resolve_hostname(hostname, ip, sizeof(ip)) != 0) {
        LOG_W("stream: cannot resolve %s, using as-is", hostname);
        snprintf(out, out_len, "%s", full);
        return 0;
    }

    /* Rebuild URL with IP, preserving scheme */
    const char *path = slash ? slash : "";
    if (port != default_port)
        snprintf(out, out_len, "%s://%s:%d%s", scheme, ip, port, path);
    else
        snprintf(out, out_len, "%s://%s%s", scheme, ip, path);

    LOG_D("stream: resolved %s -> %s", hostname, ip);
    return 0;
}

int stream_start(stream_ctx_t *ctx, const agent_config_t *cfg,
                 const camera_t *cam)
{
    /* Preserve restart_count and restart_delay across restarts */
    int saved_count = ctx->restart_count;
    int saved_delay = ctx->restart_delay;

    memset(ctx, 0, sizeof(*ctx));
    ctx->cam = cam;
    ctx->restart_count = saved_count;
    ctx->restart_delay = saved_delay > 0 ? saved_delay : 3;

    const char *ffmpeg = find_ffmpeg();
    if (!ffmpeg) {
        LOG_W("stream: ffmpeg not found, cannot stream %s", cam->id);
        return -1;
    }

    if (!cam->rtsp[0]) {
        LOG_W("stream: no RTSP URL for %s", cam->id);
        return -1;
    }

    if (!cfg->stream_server[0]) {
        LOG_W("stream: no stream_server configured");
        return -1;
    }

    /* Build resolved RTMP URL */
    stream_build_rtmp_url(cfg, cam, ctx->rtmp_url, sizeof(ctx->rtmp_url));

    char *argv[] = {
        (char *)ffmpeg,
        "-probesize", "32768",
        "-analyzeduration", "1000000",
        "-rtsp_transport", "tcp",
        "-timeout", "5000000",
        "-i", (char *)cam->rtsp,
        "-c", "copy",
        "-threads", "1",
        "-f", "flv",
        "-max_muxing_queue_size", "8",
        ctx->rtmp_url,
        NULL
    };

    if (plat_spawn(&ctx->proc, ffmpeg, argv, 1, 1) != 0)
        return -1;

    ctx->running = true;
    ctx->started_at = time(NULL);
    ctx->restart_at = 0;

    LOG_I("stream: started cam=%s -> %s", cam->id, ctx->rtmp_url);
    return 0;
}

void stream_stop(stream_ctx_t *ctx)
{
    if (plat_proc_alive(&ctx->proc)) {
        LOG_I("stream: stopping cam=%s", ctx->cam->id);
        plat_proc_terminate(&ctx->proc);

        /* Wait up to 3 seconds */
        if (plat_proc_wait(&ctx->proc, 3) != 0)
            plat_proc_kill(&ctx->proc);
    }
    ctx->running = false;
}

#define MAX_STREAM_RESTART     10
#define STREAM_STABLE_SEC      60  /* if alive > 60s, reset backoff */

void stream_tick(stream_ctx_t *ctx, const agent_config_t *cfg)
{
    if (!ctx->running)
        return;

    /* Deferred restart after process death */
    if (!plat_proc_alive(&ctx->proc) && ctx->proc.exited &&
        ctx->restart_at > 0) {
        if (time(NULL) >= ctx->restart_at) {
            const camera_t *cam = ctx->cam; /* save before memset in start */
            ctx->restart_at = 0;
            stream_start(ctx, cfg, cam);
        }
        return;
    }

    if (plat_proc_alive(&ctx->proc)) {
        /* Still running — if stable for >60s, reset backoff counters */
        if (ctx->restart_count > 0 &&
            time(NULL) - ctx->started_at > STREAM_STABLE_SEC) {
            LOG_I("stream: %s stable for >%ds, resetting backoff",
                  ctx->cam->id, STREAM_STABLE_SEC);
            ctx->restart_count = 0;
            ctx->restart_delay = 3;
        }
        return;
    }

    /* Process died (plat_proc_alive returned 0 and set exited) */
    if (!ctx->proc.exited)
        return; /* never started */

    ctx->restart_count++;

    /* Give up after too many consecutive failures */
    if (ctx->restart_count >= MAX_STREAM_RESTART) {
        LOG_E("stream: max restarts (%d) reached for %s, giving up",
              MAX_STREAM_RESTART, ctx->cam->id);
        ctx->running = false;
        ctx->restart_count = 0;
        ctx->restart_delay = 3;
        return;
    }

    if (ctx->restart_delay < 3) ctx->restart_delay = 3;

    LOG_W("stream: process died for %s, restarting in %ds (attempt %d/%d)",
          ctx->cam->id, ctx->restart_delay, ctx->restart_count, MAX_STREAM_RESTART);
    ctx->restart_at = time(NULL) + ctx->restart_delay;

    /* Exponential backoff: 3 -> 6 -> 12 -> 24 -> 60 -> 60... */
    ctx->restart_delay *= 2;
    if (ctx->restart_delay > 60) ctx->restart_delay = 60;
}
