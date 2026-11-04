#ifndef AGENT_STREAM_H
#define AGENT_STREAM_H

#include "config.h"
#include "platform.h"
#include <stdbool.h>

typedef struct {
    const camera_t *cam;
    platform_proc_t proc;
    bool            running;
    char            rtmp_url[MAX_URL_LEN]; /* with IP resolved */
    time_t          started_at;
    time_t          restart_at;     /* deferred restart time (0 = no pending) */
    int             restart_count;  /* consecutive failure count */
    int             restart_delay;  /* current backoff delay (seconds) */
} stream_ctx_t;

/*
 * Build the resolved RTMP URL (hostname → IP) for a camera.
 * Output: rtmp://1.2.3.4/StreamHub/tenant-camid
 */
int  stream_build_rtmp_url(const agent_config_t *cfg, const camera_t *cam,
                           char *out, size_t out_len);

/*
 * Start RTMP streaming for a camera.
 * Spawns ffmpeg: RTSP -> RTMP (copy codec, no transcoding).
 * The RTMP hostname is resolved to IP to work around static ffmpeg DNS issues.
 */
int  stream_start(stream_ctx_t *ctx, const agent_config_t *cfg,
                  const camera_t *cam);

/*
 * Stop streaming for a camera.
 */
void stream_stop(stream_ctx_t *ctx);

/*
 * Check if the stream process is still alive. Restart if it died.
 */
void stream_tick(stream_ctx_t *ctx, const agent_config_t *cfg);

#endif
