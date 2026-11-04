#ifndef AGENT_RECORDER_H
#define AGENT_RECORDER_H

#include "config.h"
#include "platform.h"
#include <stdbool.h>

#define SEGMENT_DURATION_SEC  1800   /* 30 minutes, like the Node.js agent */

typedef struct {
    const camera_t *cam;
    platform_proc_t proc;           /* child process (rkipc handles this if built-in) */
    char            current_file[MAX_PATH_LEN];
    time_t          segment_start;
    time_t          next_start;     /* deferred start time (0 = no pending start) */
    int             reconnect_attempts;
    bool            running;
    /* Tee muxer: combined recording + RTMP streaming from single RTSP */
    char            stream_url[MAX_URL_LEN];  /* resolved RTMP URL (empty = record only) */
    bool            streaming;                /* true when tee muxer includes RTMP output */
    bool            tee_active;               /* true only when current ffmpeg uses tee */
    time_t          tee_fail_until;           /* if tee failed, don't retry until this time */
} recorder_ctx_t;

/*
 * Start recording for a camera.
 * Uses rkipc's built-in storage if available, otherwise
 * captures from the local RTSP sub-stream.
 */
int  recorder_start(recorder_ctx_t *ctx, const agent_config_t *cfg,
                    const camera_t *cam);

/*
 * Check if the current segment should be rotated.
 * If the segment is complete, finalizes it and starts the next one.
 * Returns 1 if a segment was finalized (ready for upload), 0 otherwise.
 */
int  recorder_tick(recorder_ctx_t *ctx, const agent_config_t *cfg);

/*
 * Stop recording gracefully.
 */
void recorder_stop(recorder_ctx_t *ctx);

/*
 * Get the path of the last completed segment (for upload).
 */
const char *recorder_last_segment(const recorder_ctx_t *ctx);

/*
 * Enable RTMP streaming via tee muxer (single RTSP connection for both).
 * Restarts ffmpeg with tee output if currently recording.
 * rtmp_url must be the resolved RTMP URL (IP, not hostname).
 */
int  recorder_set_stream(recorder_ctx_t *ctx, const agent_config_t *cfg,
                         const char *rtmp_url);

/*
 * Disable RTMP streaming, revert to record-only.
 * Restarts ffmpeg without tee if currently recording.
 */
void recorder_clear_stream(recorder_ctx_t *ctx, const agent_config_t *cfg);

/*
 * Check if recorder is currently handling RTMP streaming via tee.
 */
int  recorder_is_streaming(const recorder_ctx_t *ctx);

#endif
