#include "snapshot.h"
#include "http.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
#endif

/* An ffmpeg JPEG grab of a 1080p H.264 camera peaks at ~30 MB RSS
 * (-skip_frame nokey -an, measured on an RV1106) and ~20 MB scaled to
 * 640 px. Below SNAP_FULL_AVAIL_KB the grab is scaled; below
 * SNAP_MIN_AVAIL_KB it is skipped, so a 128 MB board (Luckfox Pico Pro)
 * never OOM-kills its own snapshot next to the stream relay. */
#define SNAP_FULL_AVAIL_KB  (36 * 1024)
#define SNAP_MIN_AVAIL_KB   (24 * 1024)

/* MemAvailable in kB, or -1 when unknown (non-Linux). */
static long mem_available_kb(void)
{
#ifdef PLAT_POSIX
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f) return -1;
    char line[128];
    long kb = -1;
    while (fgets(line, sizeof(line), f)) {
        if (sscanf(line, "MemAvailable: %ld kB", &kb) == 1)
            break;
    }
    fclose(f);
    return kb;
#else
    return -1;
#endif
}

/* Set per capture by snapshot_capture(): scale ffmpeg grabs to 640 px. */
static int g_snap_small;

/*
 * Snapshot capture strategy (ordered by preference):
 *
 * 1. rkipc cycle snapshot: if enable_cycle_snapshot=1 in rkipc.ini,
 *    JPEGs are saved to /userdata/snapshot/ — we just pick the latest.
 *
 * 2. simple_venc_jpeg: Rockchip sample tool that captures a single
 *    JPEG from the ISP/VENC pipeline. Available at /oem/usr/bin/.
 *
 * 3. Recording file extraction: extract a frame from the active
 *    recording MP4 — avoids opening a new RTSP connection.
 *
 * 4. RTSP grab: use ffmpeg (if available) to grab one frame from
 *    the RTSP stream (opens a new connection — fallback only).
 */

static int capture_via_venc_jpeg(const char *output_path)
{
#ifdef PLAT_WINDOWS
    (void)output_path;
    return -1;
#else
    if (!file_exists("/oem/usr/bin/simple_venc_jpeg"))
        return -1;

    char *argv[] = {
        "simple_venc_jpeg", "-o", (char *)output_path,
        "-w", "1920", "-h", "1080", NULL
    };

    platform_proc_t proc;
    if (plat_spawn(&proc, "/oem/usr/bin/simple_venc_jpeg", argv, 1, 1) != 0)
        return -1;

    return plat_proc_wait(&proc, 10) == 0 && plat_proc_exit_ok(&proc) ? 0 : -1;
#endif
}

static int capture_via_rkipc_snapshot(const agent_config_t *cfg,
                                      const char *output_path)
{
#ifdef PLAT_WINDOWS
    (void)cfg; (void)output_path;
    return -1;
#else
    /* rkipc saves snapshots to /userdata/snapshot/ when enabled */
    const char *snap_dir = "/userdata/snapshot";
    char latest[MAX_PATH_LEN] = {0};

    /* Find the most recent .jpg */
    DIR *d = opendir(snap_dir);
    if (!d) return -1;

    time_t newest = 0;
    struct dirent *ent;
    struct stat st;

    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;
        const char *dot = strrchr(ent->d_name, '.');
        if (!dot || strcmp(dot, ".jpg") != 0) continue;

        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s/%s", snap_dir, ent->d_name);
        if (stat(full, &st) == 0 && st.st_mtime > newest) {
            newest = st.st_mtime;
            snprintf(latest, sizeof(latest), "%s", full);
        }
    }
    closedir(d);

    if (latest[0] == '\0') return -1;

    /* Only use if the snapshot is recent (< 10 seconds old) */
    if (time(NULL) - newest > 10) return -1;

    /* Copy to output path */
    return plat_copy_file(latest, output_path);
#endif
}

/*
 * Extract a JPEG frame from the active recording file.
 * Avoids opening a new RTSP connection — reads from the MP4 on disk.
 */
static int capture_from_recording(const agent_config_t *cfg,
                                   const camera_t *cam,
                                   const char *output_path)
{
    const char *ffmpeg = find_ffmpeg();
    if (!ffmpeg) return -1;

    /* Find the newest MP4 in today's recording directory */
    char date[16];
    now_date(date, sizeof(date));
    char dir[MAX_PATH_LEN];
    snprintf(dir, sizeof(dir), "%s/%s/%s/video",
             cfg->record_base, cam->id, date);

    DIR *d = opendir(dir);
    if (!d) return -1;

    char newest[MAX_PATH_LEN] = {0};
    time_t newest_time = 0;
    struct dirent *ent;
    struct stat st;

    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;
        const char *dot = strrchr(ent->d_name, '.');
        if (!dot || strcmp(dot, ".mp4") != 0) continue;

        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s/%s", dir, ent->d_name);
        if (stat(full, &st) == 0 && st.st_size > 500 * 1024
            && st.st_mtime > newest_time) {
            newest_time = st.st_mtime;
            snprintf(newest, sizeof(newest), "%s", full);
        }
    }
    closedir(d);

    if (!newest[0]) return -1;

    /* Only use if recently modified (actively being written) */
    if (time(NULL) - newest_time > 30) return -1;

    /* Extract first frame from the recording */
    char *argv[] = {
        (char *)ffmpeg,
        "-nostdin",
        "-skip_frame", "nokey",
        "-i", newest,
        "-an",
        "-frames:v", "1", "-q:v", "2",
        "-threads", "1",
        "-update", "1", "-y",
        g_snap_small ? "-vf" : (char *)output_path,
        g_snap_small ? "scale=640:-2" : NULL,
        g_snap_small ? (char *)output_path : NULL,
        NULL
    };

    platform_proc_t proc;
    if (plat_spawn(&proc, ffmpeg, argv, 1, 1) == 0) {
        if (plat_proc_wait(&proc, 10) == 0 && plat_proc_exit_ok(&proc))
            return 0;
        plat_proc_kill(&proc);
    }
    return -1;
}

int snapshot_capture(const agent_config_t *cfg, const camera_t *cam,
                     const char *output_path)
{
    /* Strategy 1: rkipc cycle snapshot (embedded Linux only) */
    if (capture_via_rkipc_snapshot(cfg, output_path) == 0) {
        LOG_D("snapshot: captured via rkipc snapshot for %s", cam->id);
        return 0;
    }

    /* Strategy 2: simple_venc_jpeg tool (embedded Linux only) */
    if (capture_via_venc_jpeg(output_path) == 0) {
        LOG_D("snapshot: captured via venc_jpeg for %s", cam->id);
        return 0;
    }

    /* Strategies 3–4 spawn an ffmpeg decode: gate them on free memory. */
    static int skipping;
    long avail = mem_available_kb();
    if (avail >= 0 && avail < SNAP_MIN_AVAIL_KB) {
        if (!skipping)
            LOG_W("snapshot: skipping ffmpeg grabs — MemAvailable %ld kB < %d kB",
                  avail, SNAP_MIN_AVAIL_KB);
        skipping = 1;
        return -1;
    }
    if (skipping)
        LOG_I("snapshot: resuming ffmpeg grabs (MemAvailable %ld kB)", avail);
    skipping = 0;
    g_snap_small = avail >= 0 && avail < SNAP_FULL_AVAIL_KB;

    /* Strategy 3: Extract frame from active recording (no new RTSP conn) */
    if (capture_from_recording(cfg, cam, output_path) == 0) {
        LOG_D("snapshot: captured from recording file for %s", cam->id);
        return 0;
    }

    /* Strategy 4: RTSP grab with ffmpeg (fallback — opens new connection) */
    const char *ffmpeg = find_ffmpeg();
    if (ffmpeg) {
        const char *rtsp_url = cam->rtsp[0]
            ? cam->rtsp : "rtsp://127.0.0.1/live/1";

        char *argv[] = {
            (char *)ffmpeg,
            "-nostdin",
            "-probesize", "32768",
            "-analyzeduration", "1000000",
            "-rtsp_transport", "tcp",
            "-timeout", "5000000",
            "-skip_frame", "nokey",
            "-i", (char *)rtsp_url,
            "-an",
            "-frames:v", "1", "-q:v", "2",
            "-threads", "1",
            "-update", "1", "-y",
            g_snap_small ? "-vf" : (char *)output_path,
            g_snap_small ? "scale=640:-2" : NULL,
            g_snap_small ? (char *)output_path : NULL,
            NULL
        };

        platform_proc_t proc;
        if (plat_spawn(&proc, ffmpeg, argv, 1, 1) == 0) {
            if (plat_proc_wait(&proc, 15) == 0 && plat_proc_exit_ok(&proc)) {
                LOG_D("snapshot: captured via ffmpeg RTSP for %s", cam->id);
                return 0;
            }
            plat_proc_kill(&proc);
        }
    }

    LOG_W("snapshot: all capture methods failed for %s", cam->id);
    return -1;
}

int snapshot_upload(const agent_config_t *cfg, const camera_t *cam,
                    const char *jpeg_path)
{
    if (!file_exists(jpeg_path)) {
        LOG_W("snapshot: file not found: %s", jpeg_path);
        return -1;
    }

    int64_t sz = file_size(jpeg_path);
    if (sz < 1024) {
        LOG_W("snapshot: file too small (%lld bytes), skipping", (long long)sz);
        portable_unlink(jpeg_path);
        return -1;
    }

    /* Upload via HTTP POST multipart, same as Node.js agent:
     * fields: tenant, id, snapshot (file) */
    const char *fields[] = {
        "tenant", cfg->tenant,
        "id",     cam->id,
    };

    http_response_t resp;
    int rc = http_post_multipart(cfg->snapshots_url,
                                 "snapshot", jpeg_path,
                                 fields, 4, &resp);

    if (rc == 0 && (resp.status >= 200 && resp.status < 300)) {
        LOG_I("snapshot: uploaded %s for camera %s", jpeg_path, cam->id);
        http_response_free(&resp);
        /* Keep the file so WebUI can serve it via /api/camera/snapshot.
         * Periodic cleanup_old_snapshots() removes files older than 30 min. */
        return 0;
    }

    LOG_W("snapshot: upload failed (status=%d) for %s", resp.status, cam->id);
    http_response_free(&resp);
    return -1;
}
