#ifndef AGENT_CONFIG_H
#define AGENT_CONFIG_H

#include <stdbool.h>

#define MAX_CAMERAS      8
#define MAX_PATH_LEN     256
#define MAX_URL_LEN      512
#define MAX_ID_LEN       32
#define MAX_TOPIC_LEN    128
#define MAX_YOLO_TARGETS 16
#define MAX_TARGET_LEN   32
#define MAX_ZONES        8
#define MAX_ZONE_POINTS  16
#define MAX_LINES        4

/* Detection mode — WHERE inference runs for a camera.
 *
 *   remote  server-side detection: the camera is streamed to a StreamHub
 *           instance and its yolo/deface plugin runs inference; the agent
 *           only SUBSCRIBES to the results (see detect_remote.c). No edge GPU.
 *           Best for demos / low camera counts. (default, backward-compatible)
 *   edge    on-device detection: a local worker (scripts/detect.py, ultralytics
 *           + opencv) runs inference on the box (see detect_edge.c). No
 *           continuous upload to a server needed. Best for many cameras /
 *           bandwidth-constrained / privacy. Requires the ML deps installed.
 *   off     no detection.
 */
typedef enum {
    DETECT_MODE_REMOTE = 0,   /* default */
    DETECT_MODE_EDGE   = 1,
    DETECT_MODE_OFF    = 2,
} detect_mode_t;

/* Detection zone: polygon defined by normalized points (0.0–1.0) */
typedef struct {
    char name[32];
    float points[MAX_ZONE_POINTS][2]; /* [x,y] normalized */
    int   point_count;
    bool  enabled;
} detect_zone_t;

/* Line crossing: a line segment with direction for entry/exit counting */
typedef struct {
    char  name[32];
    float x1, y1, x2, y2; /* normalized 0.0–1.0 */
    bool  enabled;
    int   entry_count;
    int   exit_count;
} detect_line_t;

/* Per-camera detection configuration.
 *
 * `mode` selects WHERE inference runs (see detect_mode_t):
 *   - remote (default): the StreamHub instance runs the yolo/deface plugin over
 *     the camera's ingested stream and the agent SUBSCRIBES to the results.
 *     `plugin`, `room` and `poll_interval` drive that subscription; the
 *     model/confidence/targets/tracker fields are an advisory mirror of the
 *     server-side plugin config (shown in the WebUI, applied server-side).
 *   - edge: a local worker runs inference on the device. Here the
 *     model/confidence/targets/tracker/zones/lines fields ARE applied locally.
 *   - off: no detection.
 * See detect.h for the dispatch and per-mode contracts. */
typedef struct {
    bool  enabled;
    detect_mode_t mode;        /* remote (default) | edge | off — see detect_mode_t */
    char  plugin[24];          /* StreamHub plugin id: "yolo" | "deface" */
    int   poll_interval;       /* seconds between /live polls, default 2 */
    bool  notify_mqtt;
    /* Advisory mirror of the server-side plugin config */
    char  model[32];           /* yolo11n/s/m/l/x */
    float confidence;          /* 0.0-1.0, default 0.5 */
    char  targets[MAX_YOLO_TARGETS][MAX_TARGET_LEN];
    int   target_count;
    char  tracker[16];         /* "bytetrack" or "none" */
    int   fps;                 /* inference FPS: 1-5, default 2 */
    /* ByteTrack params */
    float track_high_thresh;   /* default 0.5 */
    float track_low_thresh;    /* default 0.1 */
    float new_track_thresh;    /* default 0.6 */
    int   track_buffer;        /* default 30 frames */
    float match_thresh;        /* default 0.8 */
    /* Zones and lines per-camera (kept locally; not yet applied server-side) */
    detect_zone_t zones[MAX_ZONES];
    int zone_count;
    detect_line_t lines[MAX_LINES];
    int line_count;
} cam_detect_t;

typedef struct {
    char id[MAX_ID_LEN];
    char ip[64];
    bool enabled;
    char record_path[MAX_PATH_LEN];
    char rtsp[MAX_URL_LEN];
    char resolution[16];
    /* StreamHub ingest identity: `room` is the StreamHub room this camera
     * publishes into (empty → "<tenant>-<cam_id>"); `stream_key` is the RTMP
     * stream key minted by POST /api/v1/apps/{app}/ingress (empty → legacy
     * "<tenant>-<cam_id>" suffix appended to stream_server). */
    char room[64];
    char stream_key[64];
    cam_detect_t detect;
} camera_t;

typedef struct {
    /* agent */
    char id[MAX_ID_LEN];
    char timezone[64];
    bool records_enabled;
    int  records_ttl;
    bool records_transcode;            /* false: record/tee with stream copy; true: legacy libx264 5 fps re-encode */
    bool rtmps;
    char stream_server[MAX_URL_LEN];   /* StreamHub RTMP(S) ingest base, e.g. rtmp://host:1935/live/ */
    char snapshots_url[MAX_URL_LEN];
    char callback_url[MAX_URL_LEN];    /* StreamHub host (no scheme) — REST API at https://<host>/api/v1 */
    char tenant[MAX_ID_LEN];           /* StreamHub app name (config also accepts `app:` as alias) */
    char encryption_key[128];
    char store_id[MAX_ID_LEN];
    char alias[64];
    double latitude;
    double longitude;

    /* mqtt */
    char mqtt_host[MAX_URL_LEN];
    int  mqtt_port;

    /* storage / s3 */
    char s3_endpoint[MAX_URL_LEN];
    char s3_bucket[64];
    char s3_region[32];
    char s3_key[64];
    char s3_secret[64];

    /* StreamHub REST API token (sk_..., Bearer) — from secrets.ini [streamhub] */
    char api_token[128];

    /* onvif — ONVIF discovery/registration (scripts/onvif.py). The C side only
     * needs the re-scan cadence; the FULL `onvif:` block (credentials, per-
     * camera overrides...) is parsed by the Python tool and preserved verbatim
     * in onvif_raw so config_save() round-trips it instead of dropping it. */
    int  onvif_rescan_interval;      /* seconds between `onvif sync` runs, 0 = off */
    char onvif_raw[4096];            /* raw `onvif:` YAML block, incl. header line */

    /* fleet — StreamHub fleet management (scripts/fleet_agent.py). Same deal as
     * onvif: the C side only needs the enable/cadence (`interval`); the FULL
     * `fleet:` block (broker username/password/tls, ota binary/unit) is parsed
     * by the Python companion and preserved verbatim in fleet_raw so
     * config_save() round-trips it. See streamhub-docs/features/fleet.md. */
    int  fleet_interval;             /* telemetry seconds; 0 = fleet disabled */
    char fleet_raw[2048];            /* raw `fleet:` YAML block, incl. header line */

    /* cameras */
    camera_t cameras[MAX_CAMERAS];
    int      camera_count;

    /* webui */
    int  webui_port;
    char webui_user[64];
    char webui_pass[128];

    /* paths (resolved at runtime) */
    char record_base[MAX_PATH_LEN];
    char snapshot_dir[MAX_PATH_LEN];
    char sd_mount[MAX_PATH_LEN];
    bool sd_available;
} agent_config_t;

int  config_load(const char *path, agent_config_t *cfg);
int  config_load_secrets(const char *path, agent_config_t *cfg);
int  config_save(const char *path, const agent_config_t *cfg);
int  config_save_secrets(const char *path, const agent_config_t *cfg);
int  config_save_zones(const char *dir, const agent_config_t *cfg);
int  config_load_zones(const char *dir, agent_config_t *cfg);
void config_detect_defaults(cam_detect_t *d);

/* Map between detect.mode strings and detect_mode_t. Unknown/empty → remote. */
detect_mode_t detect_mode_parse(const char *s);
const char   *detect_mode_str(detect_mode_t m);
void config_factory_reset(agent_config_t *cfg);
void config_resolve_paths(agent_config_t *cfg);
void config_dump(const agent_config_t *cfg);

#endif
