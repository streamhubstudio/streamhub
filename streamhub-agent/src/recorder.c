#include "recorder.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
#endif

#define MAX_RECONNECT_DELAY  30   /* max seconds between reconnect attempts */
#define MIN_FILE_SIZE  (100 * 1024)  /* 100KB minimum valid segment */

/*
 * Recording strategy:
 *
 * 1. Preferred: rkipc built-in recording.
 *    Configure storage.0.enable=1 in rkipc.ini, and rkipc writes
 *    MP4 segments to /userdata/video0/. The agent just monitors.
 *
 * 2. Fallback: Spawn ffmpeg to record from the RTSP stream.
 *    Similar to the Node.js Recorder.js approach.
 */

static int start_ffmpeg(recorder_ctx_t *ctx, const agent_config_t *cfg)
{
    const char *ffmpeg = find_ffmpeg();
    if (!ffmpeg) {
        LOG_W("recorder: ffmpeg not found, cannot record %s", ctx->cam->id);
        return -1;
    }

    /* Build output path: <record_base>/<cam_id>/YYYY-MM-DD/video/ */
    char date[16], fname[64];
    now_date(date, sizeof(date));
    now_filename(fname, sizeof(fname));

    char dir[MAX_PATH_LEN];
    snprintf(dir, sizeof(dir), "%s/%s/%s/video",
             cfg->record_base, ctx->cam->id, date);
    mkdirs(dir);

    snprintf(ctx->current_file, sizeof(ctx->current_file),
             "%s/%s.mp4", dir, fname);

    /* RTSP URL: camera config or local rkipc */
    const char *rtsp_url = ctx->cam->rtsp[0]
        ? ctx->cam->rtsp : "rtsp://127.0.0.1/live/1";

    char duration[16];
    snprintf(duration, sizeof(duration), "%d", SEGMENT_DURATION_SEC);

    /* Video is copied by default: a software libx264 re-encode of a 1080p
     * IP camera needs ~155 MB of RSS on the RV1106 (it drove a Pico Max to
     * ~2 MB free; a 128 MB Pico Pro OOMs). Audio is still re-encoded to AAC
     * (cheap) so G.711 cameras fit MP4/FLV. records_transcode: true restores
     * the legacy 5 fps / 150 kbps re-encode for low-res sources (rkipc). */
    static const char *copy_args[] = {
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "32k",
        NULL
    };
    static const char *transcode_args[] = {
        "-r", "5",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "30",
        "-maxrate", "150k",
        "-bufsize", "300k",
        "-c:a", "aac",
        "-b:a", "32k",
        "-ar", "22050",
        NULL
    };
    const char **codec_args = cfg->records_transcode ? transcode_args : copy_args;

    bool tee = ctx->streaming && ctx->stream_url[0];
    char tee_output[MAX_PATH_LEN + MAX_URL_LEN + 128];
    if (tee) {
        /* Tee muxer: single RTSP → MP4 recording + FLV/RTMP stream */
        snprintf(tee_output, sizeof(tee_output),
            "[onfail=ignore:f=mp4:movflags=+faststart]%s"
            "|[onfail=ignore:f=flv]%s",
            ctx->current_file, ctx->stream_url);
    }

    char *argv[48];
    int n = 0;
    argv[n++] = (char *)ffmpeg;
    argv[n++] = "-nostdin";
    argv[n++] = "-probesize";        argv[n++] = "32768";
    argv[n++] = "-analyzeduration";  argv[n++] = "1000000";
    argv[n++] = "-rtsp_transport";   argv[n++] = "tcp";
    argv[n++] = "-timeout";          argv[n++] = "15000000";
    argv[n++] = "-i";                argv[n++] = (char *)rtsp_url;
    argv[n++] = "-t";                argv[n++] = duration;
    for (const char **a = codec_args; *a; a++)
        argv[n++] = (char *)*a;
    if (!tee) {
        argv[n++] = "-movflags";     argv[n++] = "+faststart";
    }
    argv[n++] = "-threads";          argv[n++] = "1";
    argv[n++] = "-max_muxing_queue_size"; argv[n++] = "8";
    if (tee) {
        argv[n++] = "-f";            argv[n++] = "tee";
    }
    argv[n++] = "-y";
    argv[n++] = tee ? tee_output : ctx->current_file;
    argv[n] = NULL;

    if (plat_spawn(&ctx->proc, ffmpeg, argv, 1, 1) != 0)
        return -1;

    ctx->segment_start = time(NULL);
    ctx->running = true;
    ctx->tee_active = tee;
    if (tee)
        LOG_I("recorder: started tee cam=%s file=%s stream=%s (%s)",
              ctx->cam->id, ctx->current_file, ctx->stream_url,
              cfg->records_transcode ? "transcode" : "copy");
    else
        LOG_I("recorder: started cam=%s file=%s (%s)", ctx->cam->id,
              ctx->current_file, cfg->records_transcode ? "transcode" : "copy");
    return 0;
}

/*
 * Check if rkipc built-in recording produced new files.
 * rkipc writes to <mount_path>/<folder_name>/*.mp4
 * (Only relevant on embedded Linux)
 */
static int check_rkipc_recording(recorder_ctx_t *ctx, const agent_config_t *cfg)
{
#ifdef PLAT_WINDOWS
    (void)ctx; (void)cfg;
    return 0;
#else
    char rkipc_dir[MAX_PATH_LEN];
    snprintf(rkipc_dir, sizeof(rkipc_dir), "/userdata/video0");

    DIR *d = opendir(rkipc_dir);
    if (!d) return 0;

    struct dirent *ent;
    time_t now = time(NULL);
    int found = 0;

    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;
        const char *dot = strrchr(ent->d_name, '.');
        if (!dot || strcmp(dot, ".mp4") != 0) continue;

        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s/%s", rkipc_dir, ent->d_name);

        struct stat st;
        if (stat(full, &st) != 0) continue;

        /* Only pick up files older than 5s (ensure writing is complete) */
        if (now - st.st_mtime < 5) continue;
        if (st.st_size < MIN_FILE_SIZE) continue;

        /* Move to our recording dir structure */
        char date[16];
        now_date(date, sizeof(date));
        char dest_dir[MAX_PATH_LEN];
        snprintf(dest_dir, sizeof(dest_dir), "%s/%s/%s/video",
                 cfg->record_base, ctx->cam->id, date);
        mkdirs(dest_dir);

        char dest[MAX_PATH_LEN];
        snprintf(dest, sizeof(dest), "%s/%s", dest_dir, ent->d_name);
        rename(full, dest);
        snprintf(ctx->current_file, sizeof(ctx->current_file), "%s", dest);
        found = 1;
        LOG_I("recorder: picked up rkipc segment %s", ent->d_name);
    }
    closedir(d);
    return found;
#endif
}

/* ── Public API ───────────────────────────────────────────────────── */

int recorder_start(recorder_ctx_t *ctx, const agent_config_t *cfg,
                   const camera_t *cam)
{
    /* Preserve streaming state across restart (tee muxer) */
    char saved_url[MAX_URL_LEN];
    bool saved_streaming = ctx->streaming;
    memcpy(saved_url, ctx->stream_url, sizeof(saved_url));

    memset(ctx, 0, sizeof(*ctx));
    ctx->cam = cam;

    /* Restore streaming state */
    ctx->streaming = saved_streaming;
    memcpy(ctx->stream_url, saved_url, sizeof(ctx->stream_url));

    /* Try ffmpeg recording */
    if (start_ffmpeg(ctx, cfg) == 0)
        return 0;

    /* If ffmpeg not available, rely on rkipc built-in recording.
     * The tick function will monitor for completed segments. */
    LOG_I("recorder: using rkipc built-in recording for %s", cam->id);
    ctx->running = true;
    return 0;
}

int recorder_tick(recorder_ctx_t *ctx, const agent_config_t *cfg)
{
    if (!ctx->running) {
        /* Safety net: if somehow stopped, recover */
        if (ctx->next_start > 0 && time(NULL) >= ctx->next_start) {
            LOG_I("recorder: recovery for %s", ctx->cam->id);
            ctx->next_start = 0;
            ctx->running = true;
            ctx->reconnect_attempts = 0;
            start_ffmpeg(ctx, cfg);
        }
        return 0;
    }

    /* Deferred start (reconnect backoff or inter-segment pause) */
    if (ctx->next_start > 0) {
        if (time(NULL) < ctx->next_start)
            return 0;
        ctx->next_start = 0;
        start_ffmpeg(ctx, cfg);
        return 0;
    }

    /* Check for rkipc segments (no process spawned) */
    if (!plat_proc_alive(&ctx->proc) && ctx->proc.exited == 0
        && ctx->segment_start == 0) {
        return check_rkipc_recording(ctx, cfg);
    }

    /* Check ffmpeg child process */
    if (plat_proc_alive(&ctx->proc)) {
        /* Still running — check if segment duration exceeded */
        time_t elapsed = time(NULL) - ctx->segment_start;
        if (elapsed > SEGMENT_DURATION_SEC + 120) {
            LOG_W("recorder: killing hung ffmpeg for %s", ctx->cam->id);
            plat_proc_kill(&ctx->proc);
            ctx->next_start = time(NULL) + 5;
        }
        return 0;
    }

    /* Child exited */
    int64_t sz = file_size(ctx->current_file);
    if (sz < MIN_FILE_SIZE) {
        LOG_W("recorder: segment too small (%lld bytes), discarding: %s",
              (long long)sz, ctx->current_file);
        portable_unlink(ctx->current_file);

        /* If tee mode failed, fall back to record-only so we don't keep
         * killing the recorder every time the RTMP destination is unreachable.
         * Set a 5-minute cooldown before allowing tee to be retried. */
        if (ctx->tee_active) {
            LOG_W("recorder: tee failed for %s, disabling tee for this segment cycle",
                  ctx->cam->id);
            ctx->stream_url[0] = '\0';
            ctx->streaming = false;
            ctx->tee_active = false;
            ctx->tee_fail_until = time(NULL) + SEGMENT_DURATION_SEC;
        }

        /* Reconnect with capped backoff — never stop trying */
        ctx->reconnect_attempts++;
        int delay = ctx->reconnect_attempts * 3;
        if (delay > MAX_RECONNECT_DELAY) delay = MAX_RECONNECT_DELAY;

        if (ctx->reconnect_attempts % 10 == 0) {
            LOG_E("recorder: %d consecutive failures for %s, retrying in %ds",
                  ctx->reconnect_attempts, ctx->cam->id, delay);
        } else {
            LOG_I("recorder: reconnecting in %ds (attempt %d) for %s",
                  delay, ctx->reconnect_attempts, ctx->cam->id);
        }
        ctx->next_start = time(NULL) + delay;
        return 0;
    }

    /* Valid segment completed */
    LOG_I("recorder: segment completed (%lld bytes): %s",
          (long long)sz, ctx->current_file);
    ctx->reconnect_attempts = 0;

    /* Schedule next segment after brief pause (non-blocking) */
    ctx->next_start = time(NULL) + 2;

    return 1; /* Signal: segment ready for upload */
}

void recorder_stop(recorder_ctx_t *ctx)
{
    if (plat_proc_alive(&ctx->proc)) {
        LOG_I("recorder: stopping ffmpeg for %s", ctx->cam->id);
        plat_proc_terminate(&ctx->proc);

        /* Wait up to 5 seconds */
        if (plat_proc_wait(&ctx->proc, 5) != 0)
            plat_proc_kill(&ctx->proc);
    }
    ctx->running = false;
    ctx->streaming = false;
    ctx->tee_active = false;
    ctx->stream_url[0] = '\0';
}

const char *recorder_last_segment(const recorder_ctx_t *ctx)
{
    return ctx->current_file[0] ? ctx->current_file : NULL;
}

int recorder_set_stream(recorder_ctx_t *ctx, const agent_config_t *cfg,
                        const char *rtmp_url)
{
    /* Already streaming to the same URL? */
    if (ctx->streaming && strcmp(ctx->stream_url, rtmp_url) == 0)
        return 0;

    /* Tee recently failed — don't retry yet, just keep recording */
    if (ctx->tee_fail_until > 0 && time(NULL) < ctx->tee_fail_until)
        return 0;

    snprintf(ctx->stream_url, sizeof(ctx->stream_url), "%s", rtmp_url);
    ctx->streaming = true;

    if (!ctx->running) {
        /* Recorder not active yet, URL saved for when it starts */
        LOG_I("recorder: tee queued for %s (recorder not running)", ctx->cam->id);
        return 0;
    }

    /* Never interrupt a running recording for tee — the RTMP destination
     * may be unreachable, and killing ffmpeg would destroy the current
     * segment for nothing.  Tee will be used on the next segment start. */
    if (plat_proc_alive(&ctx->proc)) {
        LOG_D("recorder: tee queued for %s -> %s (next segment)",
              ctx->cam->id, rtmp_url);
        return 0;
    }

    /* ffmpeg not running (deferred start) — start now with tee */
    LOG_I("recorder: starting tee for %s -> %s", ctx->cam->id, rtmp_url);
    return start_ffmpeg(ctx, cfg);
}

void recorder_clear_stream(recorder_ctx_t *ctx, const agent_config_t *cfg)
{
    if (!ctx->streaming)
        return;

    ctx->stream_url[0] = '\0';
    ctx->streaming = false;

    if (!ctx->running)
        return;

    /* Only restart if the current ffmpeg process actually uses tee.
     * If tee was merely queued (for next segment), just clear the flag. */
    if (ctx->tee_active && plat_proc_alive(&ctx->proc)) {
        LOG_I("recorder: switching from tee to record-only for %s", ctx->cam->id);
        plat_proc_terminate(&ctx->proc);
        if (plat_proc_wait(&ctx->proc, 3) != 0)
            plat_proc_kill(&ctx->proc);
        ctx->tee_active = false;
        start_ffmpeg(ctx, cfg);
    }
}

int recorder_is_streaming(const recorder_ctx_t *ctx)
{
    return ctx->streaming ? 1 : 0;
}
