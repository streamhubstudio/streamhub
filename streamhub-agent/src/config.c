#include "config.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
#endif

/*
 * Minimal YAML parser for the agent config.
 * Handles the flat structure used by streamhub config.yml:
 *   section:
 *     key: value
 *     - id: ...
 */

typedef enum { S_ROOT, S_AGENT, S_MQTT, S_STORAGE, S_CAMERAS, S_CAMERA_ITEM, S_CAMERA_DETECT, S_YOLO, S_WEBUI, S_ONVIF, S_FLEET } section_t;

static void set_value(char *dst, size_t sz, const char *val)
{
    /* strip quotes */
    if (val[0] == '\'' || val[0] == '"') {
        size_t len = strlen(val);
        if (len >= 2) {
            snprintf(dst, sz, "%.*s", (int)(len - 2), val + 1);
            return;
        }
    }
    snprintf(dst, sz, "%s", val);
}

/* Append one raw line to the preserved `onvif:` block (see config.h). The
 * block is owned/parsed by scripts/onvif.py; the C side only extracts
 * rescan_interval and must round-trip the rest through config_save(). */
static void append_onvif_raw(agent_config_t *cfg, const char *raw)
{
    size_t used = strlen(cfg->onvif_raw);
    if (used + strlen(raw) + 2 > sizeof(cfg->onvif_raw)) {
        LOG_W("config: onvif block too large, truncating (max %d bytes)",
              (int)sizeof(cfg->onvif_raw));
        return;
    }
    snprintf(cfg->onvif_raw + used, sizeof(cfg->onvif_raw) - used, "%s\n", raw);
}

/* Append one raw line to the preserved `fleet:` block (see config.h). Owned/
 * parsed by scripts/fleet_agent.py; the C side only extracts `interval` and
 * round-trips the rest through config_save(). */
static void append_fleet_raw(agent_config_t *cfg, const char *raw)
{
    size_t used = strlen(cfg->fleet_raw);
    if (used + strlen(raw) + 2 > sizeof(cfg->fleet_raw)) {
        LOG_W("config: fleet block too large, truncating (max %d bytes)",
              (int)sizeof(cfg->fleet_raw));
        return;
    }
    snprintf(cfg->fleet_raw + used, sizeof(cfg->fleet_raw) - used, "%s\n", raw);
}

int config_load(const char *path, agent_config_t *cfg)
{
    FILE *f = fopen(path, "r");
    if (!f) {
        LOG_E("config: cannot open %s", path);
        return -1;
    }

    memset(cfg, 0, sizeof(*cfg));
    cfg->mqtt_port       = 1883;
    cfg->records_ttl     = 30;
    cfg->records_enabled = true;
    cfg->webui_port      = 80;
    snprintf(cfg->webui_user, sizeof(cfg->webui_user), "admin");
    snprintf(cfg->webui_pass, sizeof(cfg->webui_pass), "admin");

    section_t sec = S_ROOT;
    camera_t *cur_cam = NULL;
    char line[1024];

    while (fgets(line, sizeof(line), f)) {
        /* strip newline */
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';

        /* untouched copy — raw-block preservation for the onvif: section */
        char raw[sizeof(line)];
        snprintf(raw, sizeof(raw), "%s", line);

        /* detect indentation BEFORE trimming */
        int indent = 0;
        for (const char *p = line; *p == ' ' || *p == '\t'; p++)
            indent++;

        str_trim(line);

        if (line[0] == '\0' || line[0] == '#') {
            /* keep indented comments living inside the onvif/fleet blocks */
            if (sec == S_ONVIF && indent > 0)
                append_onvif_raw(cfg, raw);
            else if (sec == S_FLEET && indent > 0)
                append_fleet_raw(cfg, raw);
            continue;
        }

        /* Section detection: top-level keys have no indentation */
        if (indent == 0) {
            if (strncmp(line, "agent:", 6) == 0)          sec = S_AGENT;
            else if (strncmp(line, "mqtt:", 5) == 0)       sec = S_MQTT;
            else if (strncmp(line, "storage:", 8) == 0)    sec = S_STORAGE;
            else if (strncmp(line, "cameras:", 8) == 0)    sec = S_CAMERAS;
            else if (strncmp(line, "yolo:", 5) == 0)       sec = S_YOLO;
            else if (strncmp(line, "webui:", 6) == 0)      sec = S_WEBUI;
            else if (strncmp(line, "onvif:", 6) == 0)      sec = S_ONVIF;
            else if (strncmp(line, "fleet:", 6) == 0)      sec = S_FLEET;
            else                                           sec = S_ROOT;
            if (sec == S_ONVIF) {
                cfg->onvif_raw[0] = '\0';
                append_onvif_raw(cfg, "onvif:");
            }
            if (sec == S_FLEET) {
                cfg->fleet_raw[0] = '\0';
                append_fleet_raw(cfg, "fleet:");
            }
            continue;
        }

        /* Preserve every indented line of the onvif/fleet blocks verbatim (they
         * are parsed by the Python tools; only their interval keys matter here). */
        if (sec == S_ONVIF)
            append_onvif_raw(cfg, raw);
        if (sec == S_FLEET)
            append_fleet_raw(cfg, raw);

        /* key: value parsing */
        char *trimmed = line;
        while (isspace((unsigned char)*trimmed)) trimmed++;

        /* Camera list item start: "- id: xxx" */
        if ((sec == S_CAMERAS || sec == S_CAMERA_ITEM || sec == S_CAMERA_DETECT) && trimmed[0] == '-') {
            if (cfg->camera_count < MAX_CAMERAS) {
                cur_cam = &cfg->cameras[cfg->camera_count++];
                memset(cur_cam, 0, sizeof(*cur_cam));
                cur_cam->enabled = true;
                config_detect_defaults(&cur_cam->detect);
            }
            trimmed += 1;
            while (isspace((unsigned char)*trimmed)) trimmed++;
            sec = S_CAMERA_ITEM;
        }

        char *colon = strchr(trimmed, ':');
        if (!colon)
            continue;

        *colon = '\0';
        char *key = trimmed;
        char *val = colon + 1;
        str_trim(key);
        str_trim(val);

        /* Handle sub-section keys (empty value means new sub-section) */
        if (val[0] == '\0') {
            if (sec == S_CAMERA_ITEM && cur_cam && strcmp(key, "detect") == 0)
                sec = S_CAMERA_DETECT;
            continue;
        }

        /* Return from S_CAMERA_DETECT to S_CAMERA_ITEM if indent drops */
        if (sec == S_CAMERA_DETECT && indent <= 4) {
            sec = S_CAMERA_ITEM;
        }

        /* Dispatch based on current section */
        switch (sec) {
        case S_AGENT:
            if (strcmp(key, "id") == 0)
                set_value(cfg->id, sizeof(cfg->id), val);
            else if (strcmp(key, "timezone") == 0)
                set_value(cfg->timezone, sizeof(cfg->timezone), val);
            else if (strcmp(key, "records_enabled") == 0)
                cfg->records_enabled = strcmp(val, "true") == 0;
            else if (strcmp(key, "records_ttl") == 0)
                cfg->records_ttl = atoi(val);
            else if (strcmp(key, "records_transcode") == 0)
                cfg->records_transcode = strcmp(val, "true") == 0;
            else if (strcmp(key, "rtmps") == 0)
                cfg->rtmps = strcmp(val, "true") == 0;
            else if (strcmp(key, "stream_server") == 0)
                set_value(cfg->stream_server, sizeof(cfg->stream_server), val);
            else if (strcmp(key, "snapshots") == 0)
                set_value(cfg->snapshots_url, sizeof(cfg->snapshots_url), val);
            else if (strcmp(key, "callback_url") == 0 || strcmp(key, "server") == 0)
                set_value(cfg->callback_url, sizeof(cfg->callback_url), val);
            else if (strcmp(key, "tenant") == 0 || strcmp(key, "app") == 0)
                set_value(cfg->tenant, sizeof(cfg->tenant), val);
            else if (strcmp(key, "encryption_key") == 0)
                set_value(cfg->encryption_key, sizeof(cfg->encryption_key), val);
            else if (strcmp(key, "store_id") == 0)
                set_value(cfg->store_id, sizeof(cfg->store_id), val);
            else if (strcmp(key, "alias") == 0)
                set_value(cfg->alias, sizeof(cfg->alias), val);
            else if (strcmp(key, "latitude") == 0)
                cfg->latitude = atof(val);
            else if (strcmp(key, "longitude") == 0)
                cfg->longitude = atof(val);
            break;

        case S_MQTT:
            if (strcmp(key, "host") == 0)
                set_value(cfg->mqtt_host, sizeof(cfg->mqtt_host), val);
            else if (strcmp(key, "port") == 0)
                cfg->mqtt_port = atoi(val);
            break;

        case S_STORAGE:
            if (strcmp(key, "endpoint") == 0)
                set_value(cfg->s3_endpoint, sizeof(cfg->s3_endpoint), val);
            else if (strcmp(key, "bucket") == 0)
                set_value(cfg->s3_bucket, sizeof(cfg->s3_bucket), val);
            else if (strcmp(key, "region") == 0)
                set_value(cfg->s3_region, sizeof(cfg->s3_region), val);
            break;

        case S_CAMERA_ITEM:
            if (!cur_cam) break;
            /* "detect:" sub-section (value is empty, key == "detect") */
            if (strcmp(key, "detect") == 0 && val[0] == '\0') {
                sec = S_CAMERA_DETECT;
                break;
            }
            if (strcmp(key, "id") == 0)
                set_value(cur_cam->id, sizeof(cur_cam->id), val);
            else if (strcmp(key, "ip") == 0)
                set_value(cur_cam->ip, sizeof(cur_cam->ip), val);
            else if (strcmp(key, "status") == 0)
                cur_cam->enabled = strcmp(val, "true") == 0;
            else if (strcmp(key, "record_path") == 0)
                set_value(cur_cam->record_path, sizeof(cur_cam->record_path), val);
            else if (strcmp(key, "rtsp") == 0)
                set_value(cur_cam->rtsp, sizeof(cur_cam->rtsp), val);
            else if (strcmp(key, "resolution") == 0)
                set_value(cur_cam->resolution, sizeof(cur_cam->resolution), val);
            else if (strcmp(key, "room") == 0)
                set_value(cur_cam->room, sizeof(cur_cam->room), val);
            else if (strcmp(key, "stream_key") == 0)
                set_value(cur_cam->stream_key, sizeof(cur_cam->stream_key), val);
            break;

        case S_CAMERA_DETECT:
            if (!cur_cam) { sec = S_CAMERA_ITEM; break; }
            {
                cam_detect_t *d = &cur_cam->detect;
                if (strcmp(key, "enabled") == 0)
                    d->enabled = strcmp(val, "true") == 0;
                else if (strcmp(key, "mode") == 0)
                    d->mode = detect_mode_parse(val);
                else if (strcmp(key, "plugin") == 0)
                    set_value(d->plugin, sizeof(d->plugin), val);
                else if (strcmp(key, "poll_interval") == 0)
                    d->poll_interval = atoi(val);
                else if (strcmp(key, "model") == 0)
                    set_value(d->model, sizeof(d->model), val);
                else if (strcmp(key, "confidence") == 0)
                    d->confidence = (float)atof(val);
                else if (strcmp(key, "notify_mqtt") == 0)
                    d->notify_mqtt = strcmp(val, "true") == 0;
                else if (strcmp(key, "tracker") == 0)
                    set_value(d->tracker, sizeof(d->tracker), val);
                else if (strcmp(key, "fps") == 0)
                    d->fps = atoi(val);
                else if (strcmp(key, "track_high_thresh") == 0)
                    d->track_high_thresh = (float)atof(val);
                else if (strcmp(key, "track_low_thresh") == 0)
                    d->track_low_thresh = (float)atof(val);
                else if (strcmp(key, "new_track_thresh") == 0)
                    d->new_track_thresh = (float)atof(val);
                else if (strcmp(key, "track_buffer") == 0)
                    d->track_buffer = atoi(val);
                else if (strcmp(key, "match_thresh") == 0)
                    d->match_thresh = (float)atof(val);
                else if (strcmp(key, "targets") == 0) {
                    d->target_count = 0;
                    char tmp[512];
                    snprintf(tmp, sizeof(tmp), "%s", val);
                    char *t = strtok(tmp, ",");
                    while (t && d->target_count < MAX_YOLO_TARGETS) {
                        str_trim(t);
                        if (t[0])
                            set_value(d->targets[d->target_count++],
                                      MAX_TARGET_LEN, t);
                        t = strtok(NULL, ",");
                    }
                }
            }
            break;

        case S_YOLO:
            /* Legacy agent-level yolo section — apply to all cameras */
            if (strcmp(key, "enabled") == 0) {
                bool v = strcmp(val, "true") == 0;
                for (int i = 0; i < cfg->camera_count; i++)
                    cfg->cameras[i].detect.enabled = v;
            } else if (strcmp(key, "model") == 0) {
                for (int i = 0; i < cfg->camera_count; i++)
                    set_value(cfg->cameras[i].detect.model,
                              sizeof(cfg->cameras[i].detect.model), val);
            } else if (strcmp(key, "confidence") == 0) {
                float v = (float)atof(val);
                for (int i = 0; i < cfg->camera_count; i++)
                    cfg->cameras[i].detect.confidence = v;
            } else if (strcmp(key, "notify_mqtt") == 0) {
                bool v = strcmp(val, "true") == 0;
                for (int i = 0; i < cfg->camera_count; i++)
                    cfg->cameras[i].detect.notify_mqtt = v;
            } else if (strcmp(key, "targets") == 0) {
                for (int i = 0; i < cfg->camera_count; i++) {
                    cam_detect_t *d = &cfg->cameras[i].detect;
                    d->target_count = 0;
                    char tmp[512];
                    snprintf(tmp, sizeof(tmp), "%s", val);
                    char *t = strtok(tmp, ",");
                    while (t && d->target_count < MAX_YOLO_TARGETS) {
                        str_trim(t);
                        if (t[0])
                            set_value(d->targets[d->target_count++],
                                      MAX_TARGET_LEN, t);
                        t = strtok(NULL, ",");
                    }
                }
            }
            break;

        case S_WEBUI:
            if (strcmp(key, "port") == 0)
                cfg->webui_port = atoi(val);
            else if (strcmp(key, "user") == 0)
                set_value(cfg->webui_user, sizeof(cfg->webui_user), val);
            else if (strcmp(key, "pass") == 0)
                set_value(cfg->webui_pass, sizeof(cfg->webui_pass), val);
            break;

        case S_ONVIF:
            /* only the daemon-relevant key; the rest is onvif_raw territory
             * (nested onvif.cameras/default_credentials keys don't collide —
             * they arrive here as "- user"-style keys and are ignored). */
            if (strcmp(key, "rescan_interval") == 0)
                cfg->onvif_rescan_interval = atoi(val);
            break;

        case S_FLEET:
            /* only the daemon-relevant key (enable + telemetry cadence); the
             * rest (broker creds, ota paths) is fleet_raw territory, parsed by
             * scripts/fleet_agent.py. */
            if (strcmp(key, "interval") == 0)
                cfg->fleet_interval = atoi(val);
            break;

        default:
            break;
        }
    }

    fclose(f);

    /* Strip mqtt:// prefix from host */
    if (strncmp(cfg->mqtt_host, "mqtt://", 7) == 0) {
        memmove(cfg->mqtt_host, cfg->mqtt_host + 7,
                strlen(cfg->mqtt_host + 7) + 1);
    }

    LOG_I("config: loaded %s — agent=%s tenant=%s cameras=%d",
          path, cfg->id, cfg->tenant, cfg->camera_count);
    return 0;
}

int config_load_secrets(const char *path, agent_config_t *cfg)
{
    FILE *f = fopen(path, "r");
    if (!f) {
        LOG_E("config: cannot open secrets file %s", path);
        return -1;
    }

    /* Simple INI parser for secrets.ini:
     * [section]
     * key = value
     */
    enum { SEC_NONE, SEC_STREAMHUB, SEC_S3 } sec = SEC_NONE;
    char line[512];

    while (fgets(line, sizeof(line), f)) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';
        str_trim(line);

        if (line[0] == '\0' || line[0] == '#')
            continue;

        if (strcmp(line, "[streamhub]") == 0)  { sec = SEC_STREAMHUB; continue; }
        if (strcmp(line, "[s3]") == 0)         { sec = SEC_S3;   continue; }
        if (line[0] == '[')                    { sec = SEC_NONE;  continue; }

        char *eq = strchr(line, '=');
        if (!eq) continue;

        *eq = '\0';
        char *key = line;
        char *val = eq + 1;
        str_trim(key);
        str_trim(val);

        switch (sec) {
        case SEC_STREAMHUB:
            if (strcmp(key, "api_token") == 0)
                set_value(cfg->api_token, sizeof(cfg->api_token), val);
            break;
        case SEC_S3:
            if (strcmp(key, "access_key") == 0)
                set_value(cfg->s3_key, sizeof(cfg->s3_key), val);
            else if (strcmp(key, "secret_key") == 0)
                set_value(cfg->s3_secret, sizeof(cfg->s3_secret), val);
            break;
        default:
            break;
        }
    }

    fclose(f);
    LOG_I("config: loaded secrets from %s", path);
    return 0;
}

void config_resolve_paths(agent_config_t *cfg)
{
#ifdef PLAT_WINDOWS
    /* Windows: use current directory based paths */
    if (cfg->record_base[0] == '\0')
        snprintf(cfg->record_base, sizeof(cfg->record_base), "./records");
    if (cfg->snapshot_dir[0] == '\0')
        snprintf(cfg->snapshot_dir, sizeof(cfg->snapshot_dir), "./snapshots");
#else
    /* POSIX: Try SD card first, fall back to /userdata (embedded) or ./records (desktop) */
    if (cfg->sd_available) {
        snprintf(cfg->record_base, sizeof(cfg->record_base),
                 "%s/records", cfg->sd_mount);
    } else if (cfg->record_base[0] == '\0') {
        /* Check if we're on embedded (Luckfox) or desktop Linux */
        if (file_exists("/userdata"))
            snprintf(cfg->record_base, sizeof(cfg->record_base),
                     "/userdata/records");
        else
            snprintf(cfg->record_base, sizeof(cfg->record_base),
                     "./records");
    }
    if (cfg->snapshot_dir[0] == '\0') {
        if (file_exists("/tmp"))
            snprintf(cfg->snapshot_dir, sizeof(cfg->snapshot_dir),
                     "/tmp/snapshots");
        else
            snprintf(cfg->snapshot_dir, sizeof(cfg->snapshot_dir),
                     "./snapshots");
    }
#endif

    /* Override record_base from camera record_path if available.
     * record_path is like "/userdata/records/c05579" — strip the cam_id
     * suffix to get the common base ("/userdata/records"). */
    for (int i = 0; i < cfg->camera_count; i++) {
        if (cfg->cameras[i].record_path[0]) {
            char *last = strrchr(cfg->cameras[i].record_path, '/');
#ifdef PLAT_WINDOWS
            if (!last) last = strrchr(cfg->cameras[i].record_path, '\\');
#endif
            if (last && last != cfg->cameras[i].record_path) {
                int blen = (int)(last - cfg->cameras[i].record_path);
                snprintf(cfg->record_base, sizeof(cfg->record_base),
                         "%.*s", blen, cfg->cameras[i].record_path);
                LOG_I("config: record_base derived from record_path: %s",
                      cfg->record_base);
                break;
            }
        }
    }

    mkdirs(cfg->record_base);
    mkdirs(cfg->snapshot_dir);
}

int config_save(const char *path, const agent_config_t *cfg)
{
    char tmp[MAX_PATH_LEN];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);

    FILE *f = fopen(tmp, "w");
    if (!f) {
        LOG_E("config: cannot write %s", tmp);
        return -1;
    }

    fprintf(f, "agent:\n");
    fprintf(f, "  id: %s\n", cfg->id);
    fprintf(f, "  timezone: %s\n", cfg->timezone);
    fprintf(f, "  records_enabled: %s\n", cfg->records_enabled ? "true" : "false");
    fprintf(f, "  records_ttl: %d\n", cfg->records_ttl);
    fprintf(f, "  records_transcode: %s\n", cfg->records_transcode ? "true" : "false");
    fprintf(f, "  rtmps: %s\n", cfg->rtmps ? "true" : "false");
    fprintf(f, "  stream_server: %s\n", cfg->stream_server);
    fprintf(f, "  snapshots: %s\n", cfg->snapshots_url);
    fprintf(f, "  callback_url: %s\n", cfg->callback_url);
    fprintf(f, "  tenant: %s\n", cfg->tenant);
    if (cfg->encryption_key[0])
        fprintf(f, "  encryption_key: %s\n", cfg->encryption_key);
    if (cfg->store_id[0])
        fprintf(f, "  store_id: %s\n", cfg->store_id);
    if (cfg->alias[0])
        fprintf(f, "  alias: %s\n", cfg->alias);
    if (cfg->latitude != 0.0 || cfg->longitude != 0.0) {
        fprintf(f, "  latitude: %.6f\n", cfg->latitude);
        fprintf(f, "  longitude: %.6f\n", cfg->longitude);
    }

    fprintf(f, "mqtt:\n");
    fprintf(f, "  host: %s\n", cfg->mqtt_host);
    fprintf(f, "  port: %d\n", cfg->mqtt_port);

    fprintf(f, "storage:\n");
    fprintf(f, "  endpoint: %s\n", cfg->s3_endpoint);
    fprintf(f, "  bucket: %s\n", cfg->s3_bucket);
    fprintf(f, "  region: %s\n", cfg->s3_region);

    fprintf(f, "cameras:\n");
    for (int i = 0; i < cfg->camera_count; i++) {
        const camera_t *c = &cfg->cameras[i];
        fprintf(f, "  - id: %s\n", c->id);
        fprintf(f, "    ip: %s\n", c->ip);
        fprintf(f, "    status: %s\n", c->enabled ? "true" : "false");
        fprintf(f, "    record_path: %s\n", c->record_path);
        fprintf(f, "    rtsp: %s\n", c->rtsp);
        fprintf(f, "    resolution: '%s'\n", c->resolution);
        if (c->room[0])
            fprintf(f, "    room: %s\n", c->room);
        if (c->stream_key[0])
            fprintf(f, "    stream_key: %s\n", c->stream_key);
        /* Per-camera detection config */
        const cam_detect_t *d = &c->detect;
        if (d->enabled || d->model[0]) {
            fprintf(f, "    detect:\n");
            fprintf(f, "      enabled: %s\n", d->enabled ? "true" : "false");
            fprintf(f, "      mode: %s\n", detect_mode_str(d->mode));
            fprintf(f, "      plugin: %s\n", d->plugin[0] ? d->plugin : "yolo");
            fprintf(f, "      poll_interval: %d\n",
                    d->poll_interval > 0 ? d->poll_interval : 2);
            fprintf(f, "      model: %s\n", d->model[0] ? d->model : "yolo11n");
            fprintf(f, "      confidence: %.2f\n", d->confidence);
            fprintf(f, "      notify_mqtt: %s\n", d->notify_mqtt ? "true" : "false");
            fprintf(f, "      tracker: %s\n", d->tracker[0] ? d->tracker : "bytetrack");
            fprintf(f, "      fps: %d\n", d->fps > 0 ? d->fps : 2);
            if (d->target_count > 0) {
                fprintf(f, "      targets: ");
                for (int t = 0; t < d->target_count; t++) {
                    if (t > 0) fprintf(f, ",");
                    fprintf(f, "%s", d->targets[t]);
                }
                fprintf(f, "\n");
            }
        }
    }

    if (cfg->webui_port) {
        fprintf(f, "webui:\n");
        fprintf(f, "  port: %d\n", cfg->webui_port);
        fprintf(f, "  user: %s\n", cfg->webui_user);
        fprintf(f, "  pass: %s\n", cfg->webui_pass);
    }

    /* ONVIF block — preserved verbatim (owned by scripts/onvif.py). Without
     * this a webui save would silently drop onvif credentials/settings. */
    if (cfg->onvif_raw[0])
        fputs(cfg->onvif_raw, f);

    /* FLEET block — preserved verbatim (owned by scripts/fleet_agent.py). */
    if (cfg->fleet_raw[0])
        fputs(cfg->fleet_raw, f);

    fclose(f);

    /* On Windows, rename() fails if dest exists — remove it first */
#ifdef PLAT_WINDOWS
    remove(path);
#endif
    if (rename(tmp, path) != 0) {
        LOG_E("config: rename %s -> %s failed: %s", tmp, path, strerror(errno));
        portable_unlink(tmp);
        return -1;
    }

    LOG_I("config: saved to %s", path);
    return 0;
}

int config_save_secrets(const char *path, const agent_config_t *cfg)
{
    char tmp[MAX_PATH_LEN];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);

    FILE *f = fopen(tmp, "w");
    if (!f) {
        LOG_E("config: cannot write %s", tmp);
        return -1;
    }

    fprintf(f, "[streamhub]\n");
    fprintf(f, "api_token = %s\n", cfg->api_token);
    fprintf(f, "\n");
    fprintf(f, "[s3]\n");
    fprintf(f, "access_key = %s\n", cfg->s3_key);
    fprintf(f, "secret_key = %s\n", cfg->s3_secret);

    fclose(f);

#ifdef PLAT_WINDOWS
    remove(path);
#endif
    if (rename(tmp, path) != 0) {
        LOG_E("config: rename %s -> %s failed: %s", tmp, path, strerror(errno));
        portable_unlink(tmp);
        return -1;
    }

    LOG_I("config: saved secrets to %s", path);
    return 0;
}

/* ── Zones & Lines persistence (JSON file, per-camera) ───────────── */

#include <cJSON.h>

int config_save_zones(const char *dir, const agent_config_t *cfg)
{
    char path[MAX_PATH_LEN];
    snprintf(path, sizeof(path), "%s/zones.json", dir);
    char tmp[MAX_PATH_LEN];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);

    FILE *f = fopen(tmp, "w");
    if (!f) return -1;

    /* Per-camera format: { "cam_id": { "zones": [...], "lines": [...] }, ... } */
    fprintf(f, "{\n");
    for (int c = 0; c < cfg->camera_count; c++) {
        const camera_t *cam = &cfg->cameras[c];
        const cam_detect_t *d = &cam->detect;
        if (c > 0) fprintf(f, ",\n");
        fprintf(f, "\"%s\":{\n\"zones\":[\n", cam->id);
        for (int i = 0; i < d->zone_count; i++) {
            const detect_zone_t *z = &d->zones[i];
            fprintf(f, "%s{\"name\":\"%s\",\"enabled\":%s,\"points\":[",
                    i > 0 ? ",\n" : "", z->name, z->enabled ? "true" : "false");
            for (int p = 0; p < z->point_count; p++) {
                fprintf(f, "%s[%.4f,%.4f]", p > 0 ? "," : "",
                        z->points[p][0], z->points[p][1]);
            }
            fprintf(f, "]}");
        }
        fprintf(f, "\n],\n\"lines\":[\n");
        for (int i = 0; i < d->line_count; i++) {
            const detect_line_t *l = &d->lines[i];
            fprintf(f, "%s{\"name\":\"%s\",\"enabled\":%s,"
                    "\"x1\":%.4f,\"y1\":%.4f,\"x2\":%.4f,\"y2\":%.4f}",
                    i > 0 ? ",\n" : "", l->name, l->enabled ? "true" : "false",
                    l->x1, l->y1, l->x2, l->y2);
        }
        fprintf(f, "\n]\n}");
    }
    fprintf(f, "\n}\n");
    fclose(f);

#ifdef PLAT_WINDOWS
    remove(path);
#endif
    if (rename(tmp, path) != 0) { portable_unlink(tmp); return -1; }
    return 0;
}

int config_load_zones(const char *dir, agent_config_t *cfg)
{
    char path[MAX_PATH_LEN];
    snprintf(path, sizeof(path), "%s/zones.json", dir);

    FILE *f = fopen(path, "r");
    if (!f) return 0; /* no zones file is OK */

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 32768) { fclose(f); return -1; }

    char *buf = malloc(sz + 1);
    if (!buf) { fclose(f); return -1; }
    fread(buf, 1, sz, f);
    buf[sz] = '\0';
    fclose(f);

    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (!root) return -1;

    /* Detect format: per-camera (keys are cam IDs) or flat (has "zones" array at root) */
    cJSON *flat_zones = cJSON_GetObjectItem(root, "zones");
    if (flat_zones && cJSON_IsArray(flat_zones)) {
        /* Legacy flat format — apply to all cameras */
        for (int c = 0; c < cfg->camera_count; c++) {
            cam_detect_t *d = &cfg->cameras[c].detect;
            d->zone_count = 0;
            int n = cJSON_GetArraySize(flat_zones);
            for (int i = 0; i < n && i < MAX_ZONES; i++) {
                cJSON *z = cJSON_GetArrayItem(flat_zones, i);
                detect_zone_t *dz = &d->zones[d->zone_count];
                memset(dz, 0, sizeof(*dz));
                cJSON *v;
                if ((v = cJSON_GetObjectItem(z, "name")) && v->valuestring)
                    snprintf(dz->name, sizeof(dz->name), "%s", v->valuestring);
                if ((v = cJSON_GetObjectItem(z, "enabled")))
                    dz->enabled = cJSON_IsTrue(v);
                cJSON *pts = cJSON_GetObjectItem(z, "points");
                if (pts && cJSON_IsArray(pts)) {
                    int np = cJSON_GetArraySize(pts);
                    for (int p = 0; p < np && p < MAX_ZONE_POINTS; p++) {
                        cJSON *pt = cJSON_GetArrayItem(pts, p);
                        if (cJSON_IsArray(pt) && cJSON_GetArraySize(pt) >= 2) {
                            dz->points[p][0] = (float)cJSON_GetArrayItem(pt, 0)->valuedouble;
                            dz->points[p][1] = (float)cJSON_GetArrayItem(pt, 1)->valuedouble;
                            dz->point_count++;
                        }
                    }
                }
                d->zone_count++;
            }
            /* Lines */
            cJSON *flat_lines = cJSON_GetObjectItem(root, "lines");
            d->line_count = 0;
            if (flat_lines && cJSON_IsArray(flat_lines)) {
                int n2 = cJSON_GetArraySize(flat_lines);
                for (int i = 0; i < n2 && i < MAX_LINES; i++) {
                    cJSON *l = cJSON_GetArrayItem(flat_lines, i);
                    detect_line_t *dl = &d->lines[d->line_count];
                    memset(dl, 0, sizeof(*dl));
                    cJSON *v;
                    if ((v = cJSON_GetObjectItem(l, "name")) && v->valuestring)
                        snprintf(dl->name, sizeof(dl->name), "%s", v->valuestring);
                    if ((v = cJSON_GetObjectItem(l, "enabled")))
                        dl->enabled = cJSON_IsTrue(v);
                    if ((v = cJSON_GetObjectItem(l, "x1"))) dl->x1 = (float)v->valuedouble;
                    if ((v = cJSON_GetObjectItem(l, "y1"))) dl->y1 = (float)v->valuedouble;
                    if ((v = cJSON_GetObjectItem(l, "x2"))) dl->x2 = (float)v->valuedouble;
                    if ((v = cJSON_GetObjectItem(l, "y2"))) dl->y2 = (float)v->valuedouble;
                    d->line_count++;
                }
            }
        }
    } else {
        /* Per-camera format: keys are camera IDs */
        for (int c = 0; c < cfg->camera_count; c++) {
            cJSON *cam_obj = cJSON_GetObjectItem(root, cfg->cameras[c].id);
            if (!cam_obj) continue;
            cam_detect_t *d = &cfg->cameras[c].detect;

            cJSON *zones = cJSON_GetObjectItem(cam_obj, "zones");
            d->zone_count = 0;
            if (zones && cJSON_IsArray(zones)) {
                int n = cJSON_GetArraySize(zones);
                for (int i = 0; i < n && i < MAX_ZONES; i++) {
                    cJSON *z = cJSON_GetArrayItem(zones, i);
                    detect_zone_t *dz = &d->zones[d->zone_count];
                    memset(dz, 0, sizeof(*dz));
                    cJSON *v;
                    if ((v = cJSON_GetObjectItem(z, "name")) && v->valuestring)
                        snprintf(dz->name, sizeof(dz->name), "%s", v->valuestring);
                    if ((v = cJSON_GetObjectItem(z, "enabled")))
                        dz->enabled = cJSON_IsTrue(v);
                    cJSON *pts = cJSON_GetObjectItem(z, "points");
                    if (pts && cJSON_IsArray(pts)) {
                        int np = cJSON_GetArraySize(pts);
                        for (int p = 0; p < np && p < MAX_ZONE_POINTS; p++) {
                            cJSON *pt = cJSON_GetArrayItem(pts, p);
                            if (cJSON_IsArray(pt) && cJSON_GetArraySize(pt) >= 2) {
                                dz->points[p][0] = (float)cJSON_GetArrayItem(pt, 0)->valuedouble;
                                dz->points[p][1] = (float)cJSON_GetArrayItem(pt, 1)->valuedouble;
                                dz->point_count++;
                            }
                        }
                    }
                    d->zone_count++;
                }
            }

            cJSON *lines = cJSON_GetObjectItem(cam_obj, "lines");
            d->line_count = 0;
            if (lines && cJSON_IsArray(lines)) {
                int n = cJSON_GetArraySize(lines);
                for (int i = 0; i < n && i < MAX_LINES; i++) {
                    cJSON *l = cJSON_GetArrayItem(lines, i);
                    detect_line_t *dl = &d->lines[d->line_count];
                    memset(dl, 0, sizeof(*dl));
                    cJSON *v;
                    if ((v = cJSON_GetObjectItem(l, "name")) && v->valuestring)
                        snprintf(dl->name, sizeof(dl->name), "%s", v->valuestring);
                    if ((v = cJSON_GetObjectItem(l, "enabled")))
                        dl->enabled = cJSON_IsTrue(v);
                    if ((v = cJSON_GetObjectItem(l, "x1"))) dl->x1 = (float)v->valuedouble;
                    if ((v = cJSON_GetObjectItem(l, "y1"))) dl->y1 = (float)v->valuedouble;
                    if ((v = cJSON_GetObjectItem(l, "x2"))) dl->x2 = (float)v->valuedouble;
                    if ((v = cJSON_GetObjectItem(l, "y2"))) dl->y2 = (float)v->valuedouble;
                    d->line_count++;
                }
            }
        }
    }

    cJSON_Delete(root);
    LOG_I("config: loaded zones from %s", path);
    return 0;
}

/* ── Factory Reset ───────────────────────────────────────────────── */

void config_factory_reset(agent_config_t *cfg)
{
    /* Preserve agent ID and tenant for re-identification */
    char saved_id[MAX_ID_LEN];
    char saved_tenant[MAX_ID_LEN];
    snprintf(saved_id, sizeof(saved_id), "%s", cfg->id);
    snprintf(saved_tenant, sizeof(saved_tenant), "%s", cfg->tenant);

    memset(cfg, 0, sizeof(*cfg));

    /* Restore identity */
    snprintf(cfg->id, sizeof(cfg->id), "%s", saved_id);
    snprintf(cfg->tenant, sizeof(cfg->tenant), "%s", saved_tenant);

    /* Apply defaults */
    cfg->mqtt_port       = 1883;
    cfg->records_ttl     = 30;
    cfg->records_enabled = true;
    cfg->webui_port      = 80;
    snprintf(cfg->webui_user, sizeof(cfg->webui_user), "admin");
    snprintf(cfg->webui_pass, sizeof(cfg->webui_pass), "admin");
    snprintf(cfg->timezone, sizeof(cfg->timezone), "America/Argentina/Buenos_Aires");

    LOG_I("config: factory reset applied (id=%s tenant=%s preserved)",
          cfg->id, cfg->tenant);
}

void config_dump(const agent_config_t *cfg)
{
    LOG_I("config: agent_id=%s tenant=%s", cfg->id, cfg->tenant);
    LOG_I("config: mqtt=%s:%d", cfg->mqtt_host, cfg->mqtt_port);
    LOG_I("config: s3=%s/%s", cfg->s3_endpoint, cfg->s3_bucket);
    LOG_I("config: records_enabled=%d ttl=%d days",
          cfg->records_enabled, cfg->records_ttl);
    LOG_I("config: record_base=%s (sd=%d)",
          cfg->record_base, cfg->sd_available);

    for (int i = 0; i < cfg->camera_count; i++) {
        const camera_t *c = &cfg->cameras[i];
        LOG_I("config: camera[%d] id=%s ip=%s enabled=%d",
              i, c->id, c->ip, c->enabled);
    }
    for (int i = 0; i < cfg->camera_count; i++) {
        const cam_detect_t *d = &cfg->cameras[i].detect;
        if (d->enabled && d->mode == DETECT_MODE_EDGE)
            LOG_I("config: camera[%d] detect: mode=edge model=%s fps=%d (on-device)",
                  i, d->model, d->fps);
        else if (d->enabled && d->mode == DETECT_MODE_REMOTE)
            LOG_I("config: camera[%d] detect: mode=remote plugin=%s poll=%ds (on %s)",
                  i, d->plugin, d->poll_interval, cfg->callback_url);
        if (d->zone_count > 0 || d->line_count > 0)
            LOG_I("config: camera[%d] %d zones, %d lines",
                  i, d->zone_count, d->line_count);
    }
}

detect_mode_t detect_mode_parse(const char *s)
{
    if (!s || !s[0])                return DETECT_MODE_REMOTE;
    if (strcmp(s, "edge") == 0)     return DETECT_MODE_EDGE;
    if (strcmp(s, "off")  == 0 ||
        strcmp(s, "none") == 0 ||
        strcmp(s, "false") == 0)    return DETECT_MODE_OFF;
    /* "remote", "server", anything else → remote (safe default) */
    return DETECT_MODE_REMOTE;
}

const char *detect_mode_str(detect_mode_t m)
{
    switch (m) {
    case DETECT_MODE_EDGE: return "edge";
    case DETECT_MODE_OFF:  return "off";
    default:               return "remote";
    }
}

void config_detect_defaults(cam_detect_t *d)
{
    d->mode = DETECT_MODE_REMOTE;
    snprintf(d->plugin, sizeof(d->plugin), "yolo");
    d->poll_interval    = 2;
    d->confidence       = 0.5f;
    d->fps              = 2;
    snprintf(d->model, sizeof(d->model), "yolo11n");
    snprintf(d->tracker, sizeof(d->tracker), "bytetrack");
    d->track_high_thresh = 0.5f;
    d->track_low_thresh  = 0.1f;
    d->new_track_thresh  = 0.6f;
    d->track_buffer      = 30;
    d->match_thresh      = 0.8f;
}
