/*
 * streamhub-agent
 *
 * Lightweight surveillance agent. Originally for Luckfox Pico Max (RV1106),
 * now also runs on Windows x64 and Linux x64.
 *
 * Features:
 *   - JPEG snapshot capture + HTTP upload (every 30s)
 *   - Video recording in 30-minute segments
 *   - S3 upload of recordings (Wasabi)
 *   - MQTT telemetry (heartbeat, status, commands)
 *   - Hardware watchdog (auto-reset on hang, embedded only)
 *   - SD card support with fallback to configurable directory
 *   - Automatic storage rotation
 *   - Embedded web configuration portal (port 80)
 */

#include "config.h"
#include "log.h"
#include "util.h"
#include "watchdog.h"
#include "mqtt_client.h"
#include "snapshot.h"
#include "recorder.h"
#include "stream.h"
#include "storage.h"
#include "s3.h"
#include "api.h"
#include "http.h"
#include "webui.h"
#include "detect.h"
#include "onvif.h"
#include "fleet.h"
#include "sync.h"
#include "platform.h"

#ifdef PLAT_WINDOWS
  #include "service_win32.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>

#include <openssl/ssl.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
  #include <pthread.h>
#endif

#ifndef VERSION
#define VERSION          "1.10"
#endif

#ifdef PLAT_WINDOWS
  #define DEFAULT_CONFIG_PATH   "config.yml"
  #define DEFAULT_SECRETS_PATH  "secrets.ini"
#else
  #define DEFAULT_CONFIG_PATH   "/userdata/streamhub/config.yml"
  #define DEFAULT_SECRETS_PATH  "/userdata/streamhub/secrets.ini"
#endif

#define WATCHDOG_TIMEOUT 30

/* ── Intervals (seconds) ──────────────────────────────────────────── */
#define INTERVAL_SNAPSHOT     60
#define INTERVAL_HEARTBEAT    60
#define INTERVAL_MQTT_STATUS  60
#define INTERVAL_UPLOAD_SYNC  600
#define INTERVAL_STORAGE_ROT  600     /* 10 min: stream-copy segments fill an SD in hours */
#define INTERVAL_DISK_REPORT  1800    /* 30 min */
#define INTERVAL_RECORDER_CHK 5
#define INTERVAL_MQTT_RECONN  10
#define INTERVAL_SNAP_CLEANUP 300     /* 5 min — purge snapshots older than 30 min */
#define SNAPSHOT_TTL_SEC      1800    /* 30 minutes */
#define INTERVAL_DETECT_CHK   1       /* remote-detection poll dispatch (per-cam
                                         cadence is detect.poll_interval) */
#define INTERVAL_EDGE_TICK    1       /* edge-detection worker health + events refresh */
#define DETECT_NOTIFY_MIN_SEC 10      /* MQTT detect-notify debounce */

/* Max poll fds: 1 MQTT + 1 webui listen + WEBUI_MAX_CLIENTS */
#define MAX_POLL_FDS (1 + 1 + WEBUI_MAX_CLIENTS)

/* forward declarations */
static void publish_status(mqttc_t *mqtt, const agent_config_t *cfg);
static void publish_storage_info(mqttc_t *mqtt, const agent_config_t *cfg);
static void cleanup_old_snapshots(const char *dir);

/* ── Log → MQTT callback ─────────────────────────────────────────── */

/* Main thread ID — log_to_mqtt must only publish from the main thread
 * because the MQTT socket is not thread-safe. Worker threads (snapshot,
 * upload, heartbeat) share the address space and would interleave TCP
 * writes, corrupting the MQTT protocol stream. */
#ifdef PLAT_WINDOWS
static DWORD main_thread_id;
#else
static pthread_t main_thread_id;
#endif

static void log_to_mqtt(log_level_t level, const char *msg, void *ctx)
{
    (void)level;
    /* Prevent recursion: if an MQTT send fails and logs an error,
     * that error would trigger this callback again → infinite loop. */
    static volatile int in_callback = 0;
    if (in_callback) return;
#ifdef PLAT_WINDOWS
    if (GetCurrentThreadId() != main_thread_id) return;
#else
    if (!pthread_equal(pthread_self(), main_thread_id)) return;
#endif
    app_context_t *app = ctx;
    if (!app->mqtt || !mqttc_connected(app->mqtt))
        return;
    in_callback = 1;
    mqttc_pub_action(app->mqtt, app->cfg->id, "log", msg);
    in_callback = 0;
}

/* ── MQTT message handler ─────────────────────────────────────────── */

static void on_mqtt_message(const char *topic, const char *payload, void *ctx)
{
    app_context_t *app = ctx;

    LOG_D("mqtt: recv [%s] %s", topic, payload);

    /* Parse topic: /<tenant>/<device_id>/<action> */
    char buf[MAX_TOPIC_LEN];
    snprintf(buf, sizeof(buf), "%s", topic);

    char *parts[4];
    int nparts = 0;
    char *tok = strtok(buf, "/");
    while (tok && nparts < 4) {
        parts[nparts++] = tok;
        tok = strtok(NULL, "/");
    }

    if (nparts < 3) return;

    const char *action = parts[2];

    if (strcmp(action, "version") == 0) {
        mqttc_pub_action(app->mqtt, app->cfg->id, "version", VERSION);
    }
    else if (strcmp(action, "restart") == 0) {
        LOG_I("mqtt: restart requested, exiting");
        plat_request_exit();
    }
    else if (strcmp(action, "ping") == 0) {
        mqttc_pub_action(app->mqtt, app->cfg->id, "pong", "1");
    }
    else if (strcmp(action, "start") == 0) {
        /* Start or keep-alive streaming for a camera.
         * This command is sent every ~60s as a keepalive — if not received
         * for 30 minutes the stream auto-stops. So we must NOT restart
         * ffmpeg if streaming is already active. */
        for (int i = 0; i < app->cfg->camera_count; i++) {
            if (strcmp(app->cfg->cameras[i].id, parts[1]) == 0) {
                if (!app->streams[i].running && !recorder_is_streaming(&app->recorders[i])) {
                    if (app->recorders[i].running) {
                        /* Recorder active: use tee muxer (single RTSP connection) */
                        char rtmp_url[MAX_URL_LEN];
                        stream_build_rtmp_url(app->cfg, &app->cfg->cameras[i],
                                              rtmp_url, sizeof(rtmp_url));
                        recorder_set_stream(&app->recorders[i], app->cfg, rtmp_url);
                        LOG_I("stream: using tee muxer via recorder for %s",
                              app->cfg->cameras[i].id);
                    } else {
                        /* No recorder: standalone stream */
                        stream_start(&app->streams[i], app->cfg, &app->cfg->cameras[i]);
                    }
                }
                /* Reset auto-stop timer (keepalive): payload value or 30 min default */
                int timeout = 1800;
                if (payload[0] && atoi(payload) > 0)
                    timeout = atoi(payload);
                app->stream_timeout[i] = timeout;
                break;
            }
        }
    }
    else if (strcmp(action, "stop") == 0) {
        /* Stop streaming for a camera */
        for (int i = 0; i < app->cfg->camera_count; i++) {
            if (strcmp(app->cfg->cameras[i].id, parts[1]) == 0) {
                if (recorder_is_streaming(&app->recorders[i])) {
                    recorder_clear_stream(&app->recorders[i], app->cfg);
                } else if (app->streams[i].running) {
                    stream_stop(&app->streams[i]);
                }
                app->stream_timeout[i] = 0;
                break;
            }
        }
    }
    else if (strcmp(action, "info") == 0) {
        /* Respond with full device info */
        int64_t total_mb = plat_total_ram_mb();
        int64_t free_mb = plat_free_ram_mb();
        int64_t uptime = plat_uptime_sec();
        double load[3];
        plat_load_avg(load);

        int link_speed = plat_get_link_speed_mbps("eth0");
        char p[512];
        snprintf(p, sizeof(p),
            "{\"agent_id\":\"%s\",\"tenant\":\"%s\",\"version\":\"%s\","
            "\"store_id\":\"%s\",\"alias\":\"%s\","
            "\"lat\":%.6f,\"lng\":%.6f,"
            "\"uptime\":%lld,\"mem_total_mb\":%lld,\"mem_free_mb\":%lld,"
            "\"load\":%.2f,\"cameras\":%d,\"sd\":%s,\"link_speed_mbps\":%d}",
            app->cfg->id, app->cfg->tenant, VERSION,
            app->cfg->store_id, app->cfg->alias,
            app->cfg->latitude, app->cfg->longitude,
            (long long)uptime,
            (long long)total_mb,
            (long long)free_mb,
            load[0],
            app->cfg->camera_count,
            app->cfg->sd_available ? "true" : "false",
            link_speed);
        mqttc_pub_action(app->mqtt, app->cfg->id, "info", p);
    }
    else if (strcmp(action, "config") == 0) {
        /* Respond with config summary */
        char p[512];
        snprintf(p, sizeof(p),
            "{\"agent_id\":\"%s\",\"tenant\":\"%s\",\"store_id\":\"%s\","
            "\"alias\":\"%s\",\"timezone\":\"%s\","
            "\"stream_server\":\"%s\",\"mqtt_host\":\"%s\","
            "\"records_enabled\":%s,\"records_ttl\":%d,"
            "\"camera_count\":%d}",
            app->cfg->id, app->cfg->tenant, app->cfg->store_id,
            app->cfg->alias, app->cfg->timezone,
            app->cfg->stream_server, app->cfg->mqtt_host,
            app->cfg->records_enabled ? "true" : "false", app->cfg->records_ttl,
            app->cfg->camera_count);
        mqttc_pub_action(app->mqtt, app->cfg->id, "config", p);
    }
    else if (strcmp(action, "status") == 0) {
        publish_status(app->mqtt, app->cfg);
    }
    else if (strcmp(action, "cameras") == 0) {
        /* Respond with per-camera info */
        for (int i = 0; i < app->cfg->camera_count; i++) {
            const camera_t *c = &app->cfg->cameras[i];
            int online = plat_ping(c->ip);
            char p[256];
            snprintf(p, sizeof(p),
                "{\"id\":\"%s\",\"ip\":\"%s\",\"enabled\":%s,"
                "\"online\":%s,\"streaming\":%s,\"recording\":%s}",
                c->id, c->ip,
                c->enabled ? "true" : "false",
                online ? "true" : "false",
                (app->streams[i].running || recorder_is_streaming(&app->recorders[i]))
                    ? "true" : "false",
                app->recorders[i].running ? "true" : "false");
            mqttc_pub_action(app->mqtt, c->id, "status", p);
        }
    }
    else if (strcmp(action, "network") == 0) {
        /* Respond with basic network info */
        char *ip = plat_get_local_ip();
        char p[128];
        snprintf(p, sizeof(p), "{\"ip\":\"%s\"}", ip ? ip : "");
        free(ip);
        mqttc_pub_action(app->mqtt, app->cfg->id, "network", p);
    }
    else if (strcmp(action, "storage") == 0) {
        publish_storage_info(app->mqtt, app->cfg);
    }
    else if (strcmp(action, "force_upload") == 0) {
        LOG_I("mqtt: force_upload requested");
        /* Trigger is handled by the main loop upload worker */
    }
    else if (strcmp(action, "reboot") == 0) {
        /* Camera reboot: send HTTP request to camera (embedded only) */
#ifdef PLAT_POSIX
        for (int i = 0; i < app->cfg->camera_count; i++) {
            if (strcmp(app->cfg->cameras[i].id, parts[1]) == 0) {
                LOG_I("mqtt: reboot requested for camera %s at %s",
                      parts[1], app->cfg->cameras[i].ip);
                char reboot_url[256];
                snprintf(reboot_url, sizeof(reboot_url),
                    "http://%s/cgi-bin/reboot", app->cfg->cameras[i].ip);
                char *wget_argv[] = {
                    "wget", "-q", "-O", "/dev/null", reboot_url, NULL
                };
                platform_proc_t wget_proc;
                plat_spawn(&wget_proc, "wget", wget_argv, 1, 1);
                /* fire and forget */
                break;
            }
        }
#endif
    }
    else if (strcmp(action, "sync_datetime") == 0) {
        LOG_I("mqtt: sync_datetime requested for %s", parts[1]);
    }
}

/* ── Telemetry ────────────────────────────────────────────────────── */

static void publish_status(mqttc_t *mqtt, const agent_config_t *cfg)
{
    int64_t uptime = plat_uptime_sec();
    int64_t free_ram = plat_free_ram_mb();
    int64_t total_ram = plat_total_ram_mb();
    double load[3];
    plat_load_avg(load);

    double uptime_days = (double)uptime / 86400.0;
    double free_gb  = (double)free_ram / 1024.0;
    double total_gb = (double)total_ram / 1024.0;

    char payload[256];
    snprintf(payload, sizeof(payload),
        "{\"uptime\":\"%.2f\",\"fm\":\"%.2f\",\"tm\":\"%.2f\","
        "\"load\":[%.2f,%.2f,%.2f]}",
        uptime_days, free_gb, total_gb, load[0], load[1], load[2]);

    mqttc_pub_action(mqtt, cfg->id, "monitor", payload);
}

static void publish_storage_info(mqttc_t *mqtt, const agent_config_t *cfg)
{
    char payload[512];
    int pos = 0;

#ifdef PLAT_WINDOWS
    /* List all drives on Windows */
    plat_drive_info_t drives[26];
    int ndrive = plat_enumerate_drives(drives, 26);
    for (int i = 0; i < ndrive; i++) {
        if (drives[i].total_mb <= 0) continue;
        double total_gb = (double)drives[i].total_mb / 1024.0;
        double avail_gb = (double)drives[i].free_mb / 1024.0;
        double used_gb  = total_gb - avail_gb;
        int pct = total_gb > 0 ? (int)(used_gb / total_gb * 100.0) : 0;
        if (pos > 0 && pos < (int)sizeof(payload) - 1)
            pos += snprintf(payload + pos, sizeof(payload) - pos, "|");
        pos += snprintf(payload + pos, sizeof(payload) - pos,
            "%s,%.2f,%.2f,%d%%", drives[i].path, used_gb, avail_gb, pct);
    }
#else
    /* Root partition */
    int64_t total = plat_disk_total_mb("/");
    int64_t free_mb = plat_disk_free_mb("/");
    if (total > 0 && free_mb >= 0) {
        double total_gb = (double)total / 1024.0;
        double avail_gb = (double)free_mb / 1024.0;
        double used_gb  = total_gb - avail_gb;
        int pct = (int)(used_gb / total_gb * 100.0);
        pos += snprintf(payload + pos, sizeof(payload) - pos,
            "/,%.2f,%.2f,%d%%", used_gb, avail_gb, pct);
    }

    if (cfg->sd_available && cfg->sd_mount[0]) {
        int64_t sd_total = plat_disk_total_mb(cfg->sd_mount);
        int64_t sd_free = plat_disk_free_mb(cfg->sd_mount);
        if (sd_total > 0 && sd_free >= 0) {
            double total_gb = (double)sd_total / 1024.0;
            double avail_gb = (double)sd_free / 1024.0;
            double used_gb  = total_gb - avail_gb;
            int pct = (int)(used_gb / total_gb * 100.0);
            pos += snprintf(payload + pos, sizeof(payload) - pos,
                "|%s,%.2f,%.2f,%d%%", cfg->sd_mount, used_gb, avail_gb, pct);
        }
    }
#endif

    mqttc_pub_action(mqtt, cfg->id, "storage", payload);
}

/* ── Snapshot cleanup: remove files older than SNAPSHOT_TTL_SEC ───── */

static void cleanup_old_snapshots(const char *dir)
{
    DIR *d = opendir(dir);
    if (!d) return;

    time_t now = time(NULL);
    struct dirent *ent;
    struct stat st;
    int removed = 0;

    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.') continue;
        const char *ext = strrchr(ent->d_name, '.');
        if (!ext || (strcmp(ext, ".jpg") != 0 && strcmp(ext, ".jpeg") != 0))
            continue;

        char path[MAX_PATH_LEN];
        snprintf(path, sizeof(path), "%s/%s", dir, ent->d_name);
        if (stat(path, &st) == 0 && (now - st.st_mtime) > SNAPSHOT_TTL_SEC) {
            portable_unlink(path);
            removed++;
        }
    }
    closedir(d);
    if (removed > 0)
        LOG_I("snapshot: cleaned %d old snapshots from %s", removed, dir);
}

/* ── Upload pending recordings ────────────────────────────────────── */

static void upload_pending_records(const agent_config_t *cfg,
                                    const camera_t *cam,
                                    int *ok_count, int *fail_count)
{
    char paths[10][MAX_PATH_LEN];
    int count = storage_scan_pending(cfg, cam, paths, 10);

    for (int i = 0; i < count; i++) {
        /* Extract date and filename from path */
        /* Path format: <base>/<cam_id>/<date>/video/<filename>.mp4 */
        const char *fname = strrchr(paths[i], '/');
#ifdef PLAT_WINDOWS
        if (!fname) fname = strrchr(paths[i], '\\');
#endif
        fname = fname ? fname + 1 : paths[i];

        /* Find date in path */
        char date[16] = {0};
        const char *p = paths[i];
        while ((p = strchr(p, '/')) != NULL) {
            p++;
            if (strlen(p) >= 10 && p[4] == '-' && p[7] == '-') {
                snprintf(date, sizeof(date), "%.10s", p);
                break;
            }
        }

        if (date[0] == '\0')
            now_date(date, sizeof(date));

        /* Build relative path for sync log: cam_id/date/video/filename */
        char relpath[MAX_PATH_LEN];
        snprintf(relpath, sizeof(relpath), "%s/%s/video/%s",
                 cam->id, date, fname);

        /* Build S3 video key */
        char video_key[MAX_URL_LEN];
        s3_build_record_key(cfg, cam, date, fname, video_key, sizeof(video_key));

        /* Generate preview thumbnail (426x240 JPEG from 1s into video) */
        char preview_path[MAX_PATH_LEN];
        snprintf(preview_path, sizeof(preview_path), "%s.preview.jpg", paths[i]);

        const char *ffmpeg = find_ffmpeg();
        int has_preview = 0;
        if (ffmpeg) {
            char *preview_argv[] = {
                (char *)ffmpeg,
                "-y", "-i", (char *)paths[i],
                "-ss", "00:00:01", "-vframes", "1",
                "-vf", "scale=426:240", "-q:v", "2",
                "-threads", "1",
                (char *)preview_path, NULL
            };
            platform_proc_t preview_proc;
            if (plat_spawn(&preview_proc, ffmpeg, preview_argv, 1, 1) == 0) {
                if (plat_proc_wait(&preview_proc, 30) == 0
                    && plat_proc_exit_ok(&preview_proc)
                    && file_exists(preview_path))
                    has_preview = 1;
                else
                    plat_proc_kill(&preview_proc);
            }
        }

        /* Build S3 preview key */
        char preview_key[MAX_URL_LEN];
        char preview_fname[64];
        snprintf(preview_fname, sizeof(preview_fname), "%s", fname);
        char *dot = strrchr(preview_fname, '.');
        if (dot) *dot = '\0';
        snprintf(preview_fname + strlen(preview_fname),
                 sizeof(preview_fname) - strlen(preview_fname), ".jpg");
        s3_build_preview_key(cfg, cam, date, preview_fname, preview_key, sizeof(preview_key));

        int64_t fsize = file_size(paths[i]);
        LOG_I("upload: uploading %s (%lld bytes)", fname, (long long)fsize);

        if (s3_upload_file(cfg, paths[i], video_key, "video/mp4") == 0) {
            /* Upload preview if generated */
            if (has_preview)
                s3_upload_file(cfg, preview_path, preview_key, "image/jpeg");

            /* Notify backend with both URLs */
            api_record_store(cfg, cam, video_key,
                             has_preview ? preview_key : NULL);

            /* Mark as uploaded (creates .uploaded marker + sync.log entry) */
            sync_mark_uploaded(cfg->record_base, relpath, fsize);
            if (ok_count) (*ok_count)++;

            /* Delete local file only if disk space is low */
            int64_t free_mb = disk_free_mb(cfg->record_base);
            if (free_mb >= 0 && free_mb < 500) {
                portable_unlink(paths[i]);
                if (has_preview) portable_unlink(preview_path);
                LOG_I("upload: completed and cleaned %s (disk low: %lld MB)",
                      fname, (long long)free_mb);
            } else {
                LOG_I("upload: completed %s (keeping local, %lld MB free)",
                      fname, (long long)free_mb);
            }
        } else {
            sync_mark_failed(cfg->record_base, relpath, fsize, "s3 upload failed");
            if (fail_count) (*fail_count)++;
            LOG_W("upload: failed for %s, will retry later", fname);
        }
    }
}

/* ── MQTT subscriptions ───────────────────────────────────────────── */

static void subscribe_topics(mqttc_t *mqtt, const agent_config_t *cfg)
{
    char topic[MAX_TOPIC_LEN];

    /* Use wildcard subscriptions instead of per-topic to reduce
     * SUBSCRIBE packet flood (18+ packets → 3 packets). */

    /* Agent-level: /{tenant}/{agent_id}/# */
    snprintf(topic, sizeof(topic), "/%s/%s/#", cfg->tenant, cfg->id);
    mqttc_subscribe(mqtt, topic);

    /* Camera-level: /{tenant}/{cam_id}/# */
    for (int c = 0; c < cfg->camera_count; c++) {
        snprintf(topic, sizeof(topic), "/%s/%s/#",
                 cfg->tenant, cfg->cameras[c].id);
        mqttc_subscribe(mqtt, topic);
    }
}

/* ── Worker callbacks (run in forked process / thread) ────────────── */

typedef struct {
    agent_config_t cfg;
    int wd_fd;
    int upload_ok;     /* results from upload worker */
    int upload_fail;
    int cam_online[MAX_CAMERAS];  /* ping results (written by hb worker, read by main thread) */
} worker_ctx_t;

static void snap_worker_fn(void *arg)
{
    worker_ctx_t *wc = (worker_ctx_t *)arg;
    agent_config_t *cfg = &wc->cfg;

    for (int i = 0; i < cfg->camera_count; i++) {
        if (!cfg->cameras[i].enabled) continue;

        char path[MAX_PATH_LEN];
        char fname[64];
        now_filename(fname, sizeof(fname));
        snprintf(path, sizeof(path), "%s/%s_%s.jpg",
                 cfg->snapshot_dir, cfg->cameras[i].id, fname);

        if (snapshot_capture(cfg, &cfg->cameras[i], path) == 0) {
            /* Save a copy to SD card for local retention (30 min) */
            char sd_snap_dir[MAX_PATH_LEN];
            if (cfg->sd_available && cfg->sd_mount[0]) {
                snprintf(sd_snap_dir, sizeof(sd_snap_dir), "%s/snapshots", cfg->sd_mount);
                char sd_path[MAX_PATH_LEN];
                snprintf(sd_path, sizeof(sd_path), "%s/%s_%s.jpg",
                         sd_snap_dir, cfg->cameras[i].id, fname);
                plat_copy_file(path, sd_path);
            }

            /* Upload snapshot to S3 */
            char date[16], s3key[MAX_URL_LEN];
            now_date(date, sizeof(date));
            char s3fname[80];
            snprintf(s3fname, sizeof(s3fname), "%s.jpg", fname);
            s3_build_snapshot_key(cfg, &cfg->cameras[i], date, s3fname, s3key, sizeof(s3key));
            s3_upload_file(cfg, path, s3key, "image/jpeg");

            /* Upload to HTTP endpoint (file kept for WebUI display) */
            snapshot_upload(cfg, &cfg->cameras[i], path);
        }
    }
}

static void hb_worker_fn(void *arg)
{
    worker_ctx_t *wc = (worker_ctx_t *)arg;
    agent_config_t *cfg = &wc->cfg;

    api_heartbeat(cfg, NULL);
    for (int i = 0; i < cfg->camera_count; i++) {
        if (!cfg->cameras[i].enabled) continue;
        wc->cam_online[i] = plat_ping(cfg->cameras[i].ip);
        if (wc->cam_online[i])
            api_heartbeat(cfg, &cfg->cameras[i]);
    }
}

static void upload_worker_fn(void *arg)
{
    worker_ctx_t *wc = (worker_ctx_t *)arg;
    agent_config_t *cfg = &wc->cfg;

    wc->upload_ok = 0;
    wc->upload_fail = 0;

    for (int i = 0; i < cfg->camera_count; i++) {
        if (!cfg->cameras[i].enabled) continue;
        upload_pending_records(cfg, &cfg->cameras[i],
                               &wc->upload_ok, &wc->upload_fail);
    }
}

/* Remote-detection poll worker: fetches the latest detection events from the
 * StreamHub instance for each flagged camera. Blocking HTTP — must not run
 * on the main thread (would starve the MQTT keepalive). Results are copied
 * into the detect contexts by the main thread after the worker is reaped. */
typedef struct {
    agent_config_t cfg;
    int       fetch[MAX_CAMERAS];   /* set by main thread before start */
    int       len[MAX_CAMERAS];     /* result: bytes, 0 = no data, -1 = error */
    long long ts_ms[MAX_CAMERAS];
    int       count[MAX_CAMERAS];
    char      events[MAX_CAMERAS][DETECT_EVENTS_MAX];
} detect_wctx_t;

static void detect_worker_fn(void *arg)
{
    detect_wctx_t *wc = (detect_wctx_t *)arg;
    agent_config_t *cfg = &wc->cfg;

    for (int i = 0; i < cfg->camera_count; i++) {
        if (!wc->fetch[i]) continue;
        wc->ts_ms[i] = 0;
        wc->count[i] = 0;
        wc->len[i] = detect_fetch_events(cfg, &cfg->cameras[i],
                                         wc->events[i], DETECT_EVENTS_MAX,
                                         &wc->ts_ms[i], &wc->count[i]);
    }
}

/* Emit a compact, debounced MQTT alert for the latest detections in dc. Shared
 * by the remote reap and the edge tick so both modes notify identically. The
 * full payload stays available via /api/camera/detection/events. */
static void detect_emit_mqtt(mqttc_t *mqtt, const agent_config_t *cfg,
                             detect_ctx_t *dc, int i)
{
    if (!cfg->cameras[i].detect.notify_mqtt || dc->last_count <= 0)
        return;
    if (!mqttc_connected(mqtt))
        return;
    if (time(NULL) - dc->last_notify < DETECT_NOTIFY_MIN_SEC)
        return;

    dc->last_notify = time(NULL);
    char room[64], p[192];
    detect_room(cfg, &cfg->cameras[i], room, sizeof(room));
    snprintf(p, sizeof(p),
        "{\"count\":%d,\"ts_ms\":%lld,\"room\":\"%s\"}",
        dc->last_count, dc->last_ts_ms, room);
    mqttc_pub_action(mqtt, cfg->cameras[i].id, "detect", p);
}

/* ── Agent core (called from main or from service) ────────────────── */

int agent_run(int argc, char **argv)
{
    const char *config_path  = DEFAULT_CONFIG_PATH;
    const char *secrets_path = DEFAULT_SECRETS_PATH;
    if (argc > 1) config_path  = argv[1];
    if (argc > 2) secrets_path = argv[2];

    /* Save main thread ID for log_to_mqtt thread safety */
#ifdef PLAT_WINDOWS
    main_thread_id = GetCurrentThreadId();
#else
    main_thread_id = pthread_self();
#endif

    /* Platform init */
    plat_net_init();
    plat_signal_init();

    /* Init OpenSSL before any threads are created */
    OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS |
                     OPENSSL_INIT_LOAD_CRYPTO_STRINGS, NULL);

    log_init("agent-mini", LOG_INFO);
#ifdef PLAT_WINDOWS
    /* Always log to file on Windows (for /api/system/logs and diagnostics) */
    log_init_file("agent.log");
#endif
    LOG_I("streamhub-agent v%s starting", VERSION);

    /* ── 1. Config ──────────────────────────────────────────────── */
    agent_config_t cfg;
    if (config_load(config_path, &cfg) != 0) {
        LOG_F("failed to load config from %s", config_path);
        plat_net_cleanup();
        return 1;
    }

    if (config_load_secrets(secrets_path, &cfg) != 0) {
        LOG_F("failed to load secrets from %s", secrets_path);
        plat_net_cleanup();
        return 1;
    }

    /* ── 2. Storage detection ───────────────────────────────────── */
    storage_detect_sd(&cfg);
    config_resolve_paths(&cfg);

    /* Load zones from config dir */
    char zones_dir[MAX_PATH_LEN];
#ifdef PLAT_WINDOWS
    snprintf(zones_dir, sizeof(zones_dir), ".");
#else
    snprintf(zones_dir, sizeof(zones_dir), "/userdata/streamhub");
#endif
    config_load_zones(zones_dir, &cfg);
    config_dump(&cfg);

    /* ── 2b. Sync log init ─────────────────────────────────────── */
    sync_init(cfg.record_base, 30);

    /* ── 3. Watchdog ────────────────────────────────────────────── */
    int wd_fd = watchdog_open(WATCHDOG_TIMEOUT);

    /* ── 4. Application context ─────────────────────────────────── */
    app_context_t app;
    memset(&app, 0, sizeof(app));
    app.cfg          = &cfg;
    app.mqtt         = NULL;
    app.config_path  = config_path;
    app.secrets_path = secrets_path;
    app.version      = VERSION;
    app.reboot_requested = false;
    app.wd_fd        = wd_fd;
    app.started_at   = time(NULL);
    app.online       = true;
    app.upload_fail_count = 0;

    /* ── 5. MQTT ────────────────────────────────────────────────── */
    app.mqtt = mqttc_create(&cfg, on_mqtt_message, &app);
    if (!app.mqtt) {
        LOG_F("failed to create MQTT client");
        watchdog_close(wd_fd);
        plat_net_cleanup();
        return 1;
    }

    int mqtt_retry = 0;
    while (!plat_should_exit() && mqttc_connect(app.mqtt) != 0) {
        mqtt_retry++;
        LOG_W("mqtt: connect failed, retry %d in 5s...", mqtt_retry);
        plat_sleep_ms(5000);
        watchdog_feed(wd_fd);
        if (mqtt_retry > 12) {
            LOG_E("mqtt: giving up after %d retries", mqtt_retry);
            break;
        }
    }

    if (mqttc_connected(app.mqtt))
        subscribe_topics(app.mqtt, &cfg);

    /* Forward logs to MQTT */
    log_set_callback(log_to_mqtt, &app);

    /* ── 6. Web UI ──────────────────────────────────────────────── */
    webui_t *webui = webui_create(&app);
    if (!webui) {
        LOG_W("webui: failed to start (continuing without web UI)");
    }

    /* ── 7. Recorders ──────────────────────────────────────────── */
    recorder_ctx_t recorders[MAX_CAMERAS];
    memset(recorders, 0, sizeof(recorders));
    app.recorders = recorders;

    if (cfg.records_enabled) {
        for (int i = 0; i < cfg.camera_count; i++) {
            if (!cfg.cameras[i].enabled) continue;
            recorder_start(&recorders[i], &cfg, &cfg.cameras[i]);
        }
    }

    /* ── 7b. Remote-detection subscriptions ───────────────────── */
    detect_ctx_t detectors[MAX_CAMERAS];
    memset(detectors, 0, sizeof(detectors));
    app.detectors = detectors;

    for (int i = 0; i < cfg.camera_count; i++) {
        if (cfg.cameras[i].enabled && cfg.cameras[i].detect.enabled)
            detect_start(&detectors[i], &cfg, &cfg.cameras[i]);
    }

    /* ── 8. Timers ──────────────────────────────────────────────── */
    int64_t last_snapshot     = 0;
    int64_t last_heartbeat    = 0;
    int64_t last_upload_sync  = 0;
    int64_t last_rotation     = 0;
    int64_t last_disk_report  = 0;
    int64_t last_recorder_chk = 0;
    int64_t last_mqtt_reconn  = 0;
    int64_t last_snap_cleanup = 0;
    int64_t last_detect_chk   = 0;
    int64_t last_edge_tick    = 0;

    /* SD snapshot directory */
    char sd_snap_dir[MAX_PATH_LEN] = "";
    if (cfg.sd_available && cfg.sd_mount[0]) {
        snprintf(sd_snap_dir, sizeof(sd_snap_dir), "%s/snapshots", cfg.sd_mount);
        mkdirs(sd_snap_dir);
    }

    /* Worker contexts — each worker gets its own copy to avoid race
     * conditions on Windows where workers are threads (not forks). */
    worker_ctx_t snap_wctx, hb_wctx, upload_wctx;
    memcpy(&snap_wctx.cfg, &cfg, sizeof(cfg));
    snap_wctx.wd_fd = wd_fd;
    memcpy(&hb_wctx.cfg, &cfg, sizeof(cfg));
    hb_wctx.wd_fd = wd_fd;
    memcpy(&upload_wctx.cfg, &cfg, sizeof(cfg));
    upload_wctx.wd_fd = wd_fd;

    /* Workers */
    platform_worker_t snap_worker;
    memset(&snap_worker, 0, sizeof(snap_worker));
    snap_worker.finished = 1; /* not running */
    time_t snap_worker_start = 0;

    platform_worker_t upload_worker;
    memset(&upload_worker, 0, sizeof(upload_worker));
    upload_worker.finished = 1;
    time_t upload_worker_start = 0;

    platform_worker_t hb_worker;
    memset(&hb_worker, 0, sizeof(hb_worker));
    hb_worker.finished = 1;
    time_t hb_worker_start = 0;

    /* Remote-detection poll worker */
    static detect_wctx_t detect_wctx; /* static: ~64KB, keep off the stack */
    memset(&detect_wctx, 0, sizeof(detect_wctx));
    platform_worker_t detect_worker;
    memset(&detect_worker, 0, sizeof(detect_worker));
    detect_worker.finished = 1;
    time_t detect_worker_start = 0;

    LOG_I("entering main loop");

    /* ── 9. Main event loop (unified poll) ────────────────────────── */
    struct pollfd fds[MAX_POLL_FDS];

    while (!plat_should_exit()) {
        int64_t now = now_ms() / 1000;

        /* Feed the watchdog */
        watchdog_feed(wd_fd);

        /* Build poll fd set */
        int nfds = 0;
        int mqtt_fd_idx = -1;
        int webui_offset = -1;

        /* MQTT fd */
        int mfd = mqttc_get_fd(app.mqtt);
        if (mfd >= 0 && mqttc_connected(app.mqtt)) {
            memset(&fds[nfds], 0, sizeof(fds[nfds]));
            fds[nfds].fd = mfd;
            fds[nfds].events = POLLIN;
            mqtt_fd_idx = nfds;
            nfds++;
        }

        /* WebUI fds */
        if (webui) {
            webui_offset = nfds;
            nfds += webui_fill_pollfds(webui, fds, webui_offset);
        }

        /* Poll with 100ms timeout (keeps timers responsive) */
        int poll_rc = poll(fds, nfds, 100);
        (void)poll_rc;

        /* Process MQTT events.
         * Handle POLLIN, POLLHUP, and POLLERR — all may contain readable
         * data or indicate connection close. mqttc_process() handles all
         * cases: data, EOF (recv=0), and errors. */
        if (mqtt_fd_idx >= 0 &&
            (fds[mqtt_fd_idx].revents & (POLLIN | POLLHUP | POLLERR))) {
            mqttc_process(app.mqtt);
        }

        /* MQTT keepalive ping (runs regardless of poll events) */
        if (mqttc_connected(app.mqtt)) {
            mqttc_keepalive(app.mqtt);
        }

        /* Process WebUI events */
        if (webui && webui_offset >= 0) {
            webui_process(webui, fds, webui_offset);
        }

        /* MQTT reconnect (non-blocking, every 10s) */
        if (!mqttc_connected(app.mqtt) && now - last_mqtt_reconn >= INTERVAL_MQTT_RECONN) {
            last_mqtt_reconn = now;
            if (mqttc_connect(app.mqtt) == 0)
                subscribe_topics(app.mqtt, &cfg);
        }

        /* ── Reap snapshot worker ──────────────────────────────── */
        if (!snap_worker.finished && !plat_worker_alive(&snap_worker)) {
            snap_worker.finished = 1;
        } else if (!snap_worker.finished && time(NULL) - snap_worker_start > 180) {
            LOG_W("snapshot: worker stuck >180s, killing");
            plat_worker_kill(&snap_worker);
        }

        /* ── Snapshots (every 60s, background worker) ────────── */
        if (now - last_snapshot >= INTERVAL_SNAPSHOT && snap_worker.finished) {
            last_snapshot = now;
            /* Update worker config (in case cfg changed) */
            memcpy(&snap_wctx.cfg, &cfg, sizeof(cfg));
            if (plat_worker_start(&snap_worker, snap_worker_fn, &snap_wctx) == 0)
                snap_worker_start = time(NULL);
        }

        /* ── Reap heartbeat worker ────────────────────────────── */
        if (!hb_worker.finished && !plat_worker_alive(&hb_worker)) {
            hb_worker.finished = 1;
        } else if (!hb_worker.finished && time(NULL) - hb_worker_start > 60) {
            LOG_W("heartbeat: worker stuck >60s, killing");
            plat_worker_kill(&hb_worker);
        }

        /* ── Heartbeat + MQTT ping (every 60s) ─────────────────── */
        if (now - last_heartbeat >= INTERVAL_HEARTBEAT) {
            last_heartbeat = now;

            /* Per-camera MQTT ping: use cached results from heartbeat worker
             * (plat_ping blocks 1-2s per camera — must not run on main thread
             * or it starves MQTT keepalive). */
            for (int i = 0; i < cfg.camera_count; i++) {
                if (!cfg.cameras[i].enabled) continue;
                if (mqttc_connected(app.mqtt)) {
                    mqttc_pub_action(app.mqtt, cfg.cameras[i].id, "ping",
                                     hb_wctx.cam_online[i] ? "true" : "false");
                }
            }

            /* Agent-level MQTT ping + telemetry */
            if (mqttc_connected(app.mqtt)) {
                mqttc_pub_action(app.mqtt, cfg.id, "ping", "true");
                publish_status(app.mqtt, &cfg);
            }

            /* Background heartbeat HTTP calls */
            if (hb_worker.finished) {
                memcpy(&hb_wctx.cfg, &cfg, sizeof(cfg));
                if (plat_worker_start(&hb_worker, hb_worker_fn, &hb_wctx) == 0)
                    hb_worker_start = time(NULL);
            }

            /* Stream auto-stop timer: decrement by heartbeat interval (60s) */
            for (int i = 0; i < cfg.camera_count; i++) {
                if (app.stream_timeout[i] <= 0) continue;
                int is_streaming = app.streams[i].running ||
                                   recorder_is_streaming(&recorders[i]);
                if (!is_streaming) continue;
                app.stream_timeout[i] -= INTERVAL_HEARTBEAT;
                if (app.stream_timeout[i] <= 0) {
                    LOG_I("stream: auto-stop timer expired for %s",
                          cfg.cameras[i].id);
                    if (recorder_is_streaming(&recorders[i]))
                        recorder_clear_stream(&recorders[i], &cfg);
                    else if (app.streams[i].running)
                        stream_stop(&app.streams[i]);
                    app.stream_timeout[i] = 0;
                }
            }
        }

        /* ── Recorder + stream check (every 5s) ────────────────── */
        if (now - last_recorder_chk >= INTERVAL_RECORDER_CHK) {
            last_recorder_chk = now;
            if (cfg.records_enabled) {
                for (int i = 0; i < cfg.camera_count; i++) {
                    if (!cfg.cameras[i].enabled) continue;
                    recorder_tick(&recorders[i], &cfg);
                }
            }
            /* Check standalone stream health (skip if using tee via recorder) */
            for (int i = 0; i < cfg.camera_count; i++) {
                if (app.streams[i].running && !recorder_is_streaming(&recorders[i]))
                    stream_tick(&app.streams[i], &cfg);
            }
            /* Reap zombie child processes (ffmpeg, previews, etc.) */
            plat_reap_zombies();
        }

        /* ── Reap remote-detection worker ──────────────────────── */
        if (!detect_worker.finished && !plat_worker_alive(&detect_worker)) {
            detect_worker.finished = 1;
            for (int i = 0; i < cfg.camera_count; i++) {
                if (!detect_wctx.fetch[i]) continue;
                detect_wctx.fetch[i] = 0;

                detect_ctx_t *dc = &detectors[i];
                if (!dc->running) continue; /* stopped while worker ran */

                if (detect_wctx.len[i] < 0) {
                    dc->fail_count++;
                    if (dc->fail_count == 5)
                        LOG_W("detect: %d consecutive fetch failures for %s",
                              dc->fail_count, cfg.cameras[i].id);
                    continue;
                }
                dc->fail_count = 0;
                if (detect_wctx.len[i] == 0) continue;          /* no live data yet */
                if (detect_wctx.ts_ms[i] == dc->last_ts_ms) continue; /* unchanged */

                memcpy(dc->events, detect_wctx.events[i], detect_wctx.len[i] + 1);
                dc->events_len = detect_wctx.len[i];
                dc->last_ts_ms = detect_wctx.ts_ms[i];
                dc->last_count = detect_wctx.count[i];

                detect_emit_mqtt(app.mqtt, &cfg, dc, i);
            }
        } else if (!detect_worker.finished &&
                   time(NULL) - detect_worker_start > 60) {
            LOG_W("detect: worker stuck >60s, killing");
            plat_worker_kill(&detect_worker);
        }

        /* ── Edge-detection tick (mode=edge, MAIN THREAD, non-blocking) ──
         * Worker health + restart + events-file refresh + MQTT notify. Runs
         * independently of the remote fetch worker's state. */
        if (now - last_edge_tick >= INTERVAL_EDGE_TICK) {
            last_edge_tick = now;
            for (int i = 0; i < cfg.camera_count; i++) {
                if (cfg.cameras[i].detect.mode != DETECT_MODE_EDGE) continue;
                if (!cfg.cameras[i].enabled) continue;
                long long prev_ts = detectors[i].last_ts_ms;
                detect_tick(&detectors[i], &cfg);
                if (detectors[i].running && detectors[i].last_ts_ms != prev_ts)
                    detect_emit_mqtt(app.mqtt, &cfg, &detectors[i], i);
            }
        }

        /* ── ONVIF periodic re-scan (onvif.rescan_interval, 0 = off) ──
         * Non-blocking: spawns `scripts/onvif.py sync` in the background;
         * rate limiting + single-instance guard live in onvif_tick(). */
        onvif_tick(&cfg, config_path, secrets_path);

        /* ── StreamHub fleet management companion (fleet.interval, 0 = off) ──
         * Non-blocking: spawns + supervises scripts/fleet_agent.py, which
         * publishes telemetry + handles restart/ota/config/ping over MQTT.
         * Lifecycle (start + respawn-on-crash) lives in fleet_tick(). */
        fleet_tick(&cfg, config_path, secrets_path);

        /* ── Remote-detection poll dispatch (mode=remote) ──────────
         * Blocking HTTP fetch runs on the background worker thread. */
        if (now - last_detect_chk >= INTERVAL_DETECT_CHK && detect_worker.finished) {
            last_detect_chk = now;
            int any = 0;
            for (int i = 0; i < cfg.camera_count; i++) {
                detect_wctx.fetch[i] = 0;
                if (!detectors[i].running || !cfg.cameras[i].enabled) continue;
                if (detectors[i].mode != DETECT_MODE_REMOTE) continue;
                int iv = cfg.cameras[i].detect.poll_interval;
                if (iv <= 0) iv = 2;
                if (time(NULL) - detectors[i].last_poll < iv) continue;
                detectors[i].last_poll = time(NULL);
                detect_wctx.fetch[i] = 1;
                any = 1;
            }
            if (any) {
                memcpy(&detect_wctx.cfg, &cfg, sizeof(cfg));
                if (plat_worker_start(&detect_worker, detect_worker_fn,
                                      &detect_wctx) == 0)
                    detect_worker_start = time(NULL);
            }
        }

        /* ── Reap upload worker ────────────────────────────────── */
        if (!upload_worker.finished && !plat_worker_alive(&upload_worker)) {
            upload_worker.finished = 1;

            /* Connectivity detection based on upload results */
            int ok = upload_wctx.upload_ok;
            int fail = upload_wctx.upload_fail;

            if (ok > 0) {
                if (!app.online)
                    LOG_I("connectivity: internet restored (%d uploads OK)", ok);
                app.upload_fail_count = 0;
                app.online = true;
            } else if (fail > 0) {
                app.upload_fail_count += fail;
                if (app.upload_fail_count >= 3 && app.online) {
                    app.online = false;
                    LOG_W("connectivity: going offline after %d consecutive failures",
                          app.upload_fail_count);
                    /* Stop all RTMP streams — no internet means no point streaming */
                    for (int i = 0; i < cfg.camera_count; i++) {
                        if (recorder_is_streaming(&recorders[i])) {
                            recorder_clear_stream(&recorders[i], &cfg);
                            LOG_I("connectivity: stopped tee stream for %s",
                                  cfg.cameras[i].id);
                        } else if (app.streams[i].running) {
                            stream_stop(&app.streams[i]);
                            LOG_I("connectivity: stopped stream for %s",
                                  cfg.cameras[i].id);
                        }
                        app.stream_timeout[i] = 0;
                    }
                }
            }
        } else if (!upload_worker.finished && time(NULL) - upload_worker_start > 600) {
            LOG_W("upload: worker stuck >600s, killing");
            plat_worker_kill(&upload_worker);
        }

        /* ── Upload sync (background worker) ─────────────────────
         *    Online: every 10 min.  Offline: every 2 min (detect reconnection). */
        {
            int upload_interval = app.online ? INTERVAL_UPLOAD_SYNC : 120;
            if (now - last_upload_sync >= upload_interval && upload_worker.finished) {
                last_upload_sync = now;
                memcpy(&upload_wctx.cfg, &cfg, sizeof(cfg));
                upload_wctx.upload_ok = 0;
                upload_wctx.upload_fail = 0;
                if (plat_worker_start(&upload_worker, upload_worker_fn, &upload_wctx) == 0)
                    upload_worker_start = time(NULL);
            }
        }

        /* ── Storage rotation + disk-pressure cleanup (every 10 min) */
        if (now - last_rotation >= INTERVAL_STORAGE_ROT) {
            last_rotation = now;
            storage_rotate(&cfg);
        }

        /* ── Disk usage report (every 30 min) ──────────────────── */
        if (now - last_disk_report >= INTERVAL_DISK_REPORT) {
            last_disk_report = now;
            if (mqttc_connected(app.mqtt))
                publish_storage_info(app.mqtt, &cfg);
        }

        /* ── Snapshot TTL cleanup (every 5 min) ────────────────── */
        if (now - last_snap_cleanup >= INTERVAL_SNAP_CLEANUP) {
            last_snap_cleanup = now;
            cleanup_old_snapshots(cfg.snapshot_dir);
            if (sd_snap_dir[0])
                cleanup_old_snapshots(sd_snap_dir);
            /* Rotate log file if stderr points to a >1MB file (tmpfs OOM prevention) */
            log_rotate();
        }

        /* ── Reboot check ──────────────────────────────────────── */
        if (app.reboot_requested) {
            LOG_I("reboot requested via web UI, stopping in 3s...");
            plat_sleep_ms(3000);
#ifdef PLAT_WINDOWS
            {
                /* Enable shutdown privilege and initiate reboot */
                HANDLE hToken;
                if (OpenProcessToken(GetCurrentProcess(),
                        TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken)) {
                    TOKEN_PRIVILEGES tp;
                    LookupPrivilegeValueA(NULL, "SeShutdownPrivilege",
                                          &tp.Privileges[0].Luid);
                    tp.PrivilegeCount = 1;
                    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
                    AdjustTokenPrivileges(hToken, FALSE, &tp, 0, NULL, NULL);
                    CloseHandle(hToken);
                }
                InitiateSystemShutdownExA(NULL, "StreamHub Agent reboot",
                    0, TRUE, TRUE, SHTDN_REASON_FLAG_PLANNED);
            }
#else
            /* Check for firmware upgrade script */
            if (file_exists("/userdata/streamhub/upgrade.sh")) {
                LOG_I("running firmware upgrade script before reboot");
                char *ug_argv[] = { "/bin/sh", "/userdata/streamhub/upgrade.sh", NULL };
                platform_proc_t ug_proc;
                if (plat_spawn(&ug_proc, "/bin/sh", ug_argv, 0, 0) == 0)
                    plat_proc_wait(&ug_proc, 120);
            } else {
                char *rb_argv[] = { "reboot", NULL };
                platform_proc_t rb_proc;
                plat_spawn(&rb_proc, "reboot", rb_argv, 0, 0);
            }
#endif
            plat_request_exit();
        }
    }

    /* ── Shutdown ───────────────────────────────────────────────── */
    LOG_I("shutting down...");

    webui_destroy(webui);

    /* Stop the fleet-management companion (scripts/fleet_agent.py). */
    fleet_stop();

    for (int i = 0; i < cfg.camera_count; i++) {
        recorder_stop(&recorders[i]);  /* also clears tee streaming */
        if (app.streams[i].running)
            stream_stop(&app.streams[i]);  /* standalone streams */
        if (detectors[i].running)
            detect_stop(&detectors[i]);
    }

    /* Kill any lingering workers */
    if (!snap_worker.finished)
        plat_worker_kill(&snap_worker);
    if (!upload_worker.finished)
        plat_worker_kill(&upload_worker);
    if (!hb_worker.finished)
        plat_worker_kill(&hb_worker);
    if (!detect_worker.finished)
        plat_worker_kill(&detect_worker);

    mqttc_destroy(app.mqtt);
    watchdog_close(wd_fd);
    plat_net_cleanup();

    LOG_I("streamhub-agent stopped");
    return 0;
}

/* ── Main entry point ─────────────────────────────────────────────── */

int main(int argc, char **argv)
{
    /* `streamhub-agent onvif scan|sync ...` — one-shot ONVIF discovery /
     * StreamHub registration tool (scripts/onvif.py), not the agent daemon. */
    if (argc > 1 && strcmp(argv[1], "onvif") == 0)
        return onvif_cli(argc, argv, DEFAULT_CONFIG_PATH, DEFAULT_SECRETS_PATH);
#ifdef PLAT_WINDOWS
    if (service_handle_args(argc, argv))
        return 0;
    if (service_try_start(argc, argv))
        return 0;
#endif
    return agent_run(argc, argv);
}
