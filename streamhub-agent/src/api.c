#include "api.h"
#include "http.h"
#include "log.h"

#include <cJSON.h>

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/*
 * StreamHub REST API client.
 *
 * All calls go to https://<callback_url>/api/v1/... with a Bearer token
 * (sk_..., from secrets.ini [streamhub] api_token).
 *
 * ── ASSUMED CONTRACT (agent-management seam) ─────────────────────────
 * StreamHub core does not yet ship device-management routes. This client
 * targets the following assumed endpoints, which the server side must
 * provide (or an operator can front with a thin shim):
 *
 *   POST /api/v1/apps/{app}/agents/heartbeat        {"id": "<agent|cam id>"}
 *   POST /api/v1/apps/{app}/agents/records          {"id","record_url","record_thumbnail_url"}
 *   POST /api/v1/apps/{app}/agents/io-error         {"app","device_id","agent_id","error"}
 *   GET  /api/v1/agents/{agent_id}/setup            → config JSON (same shape
 *        as the legacy setup import: {agent:{...},mqtt:{...},s3:{...},
 *        streamhub:{api_token},cameras:[...]})
 *
 * The detection-events subscription does NOT depend on this seam — it uses
 * the real, existing plugin live-data endpoint (see detect.c).
 */

static void build_auth_header(const agent_config_t *cfg, char *buf, size_t len)
{
    if (cfg->api_token[0])
        snprintf(buf, len, "Authorization: Bearer %s", cfg->api_token);
    else
        buf[0] = '\0';
}

static void build_url(const agent_config_t *cfg, const char *path,
                      char *url, size_t len)
{
    snprintf(url, len, "https://%s/api/v1/apps/%s%s",
             cfg->callback_url, cfg->tenant, path);
}

int api_heartbeat(const agent_config_t *cfg, const camera_t *cam)
{
    char auth[256];
    build_auth_header(cfg, auth, sizeof(auth));

    char url[MAX_URL_LEN];
    build_url(cfg, "/agents/heartbeat", url, sizeof(url));

    /* cam == NULL means agent-level heartbeat */
    const char *device_id = cam ? cam->id : cfg->id;

    char body[256];
    snprintf(body, sizeof(body), "{\"id\":\"%s\"}", device_id);

    http_response_t resp;
    int rc = http_post_json(url, auth[0] ? auth : NULL, body, &resp);

    if (rc == 0 && resp.status >= 200 && resp.status < 300) {
        LOG_I("api: heartbeat OK for %s", device_id);
    } else {
        LOG_W("api: heartbeat failed for %s (status=%d)", device_id, resp.status);
    }

    http_response_free(&resp);
    return rc == 0 ? 0 : -1;
}

int api_record_store(const agent_config_t *cfg, const camera_t *cam,
                     const char *record_url, const char *record_thumbnail_url)
{
    char auth[256];
    build_auth_header(cfg, auth, sizeof(auth));

    char url[MAX_URL_LEN];
    build_url(cfg, "/agents/records", url, sizeof(url));

    char body[1024];
    snprintf(body, sizeof(body),
        "{\"id\":\"%s\",\"record_url\":\"%s\",\"record_thumbnail_url\":\"%s\"}",
        cam->id, record_url, record_thumbnail_url ? record_thumbnail_url : "");

    http_response_t resp;
    int rc = http_post_json(url, auth[0] ? auth : NULL, body, &resp);

    if (rc == 0 && resp.status >= 200 && resp.status < 300) {
        LOG_I("api: record stored for %s — %s", cam->id, record_url);
    } else {
        LOG_W("api: record store failed for %s (status=%d)", cam->id, resp.status);
    }

    http_response_free(&resp);
    return rc == 0 ? 0 : -1;
}

int api_io_error(const agent_config_t *cfg, const camera_t *cam,
                 const char *error_msg)
{
    char auth[256];
    build_auth_header(cfg, auth, sizeof(auth));

    char url[MAX_URL_LEN];
    build_url(cfg, "/agents/io-error", url, sizeof(url));

    char body[512];
    snprintf(body, sizeof(body),
        "{\"app\":\"%s\",\"device_id\":\"%s\",\"agent_id\":\"%s\","
        "\"error\":\"%s\"}",
        cfg->tenant, cam->id, cfg->id, error_msg);

    http_response_t resp;
    int rc = http_post_json(url, auth[0] ? auth : NULL, body, &resp);
    http_response_free(&resp);
    return rc == 0 ? 0 : -1;
}

int api_setup_import(const char *domain, const char *agent_id,
                     agent_config_t *cfg, const char *config_path,
                     const char *secrets_path)
{
    /* Build URL: GET https://{domain}/api/v1/agents/{agentId}/setup
     * (assumed agent-management seam — see the header comment) */
    char url[MAX_URL_LEN];
    snprintf(url, sizeof(url),
        "https://%s/api/v1/agents/%s/setup", domain, agent_id);

    /* Auth with whatever token we already have (bootstrap installs pass it
     * via the config template before the first setup import). */
    char auth[256];
    build_auth_header(cfg, auth, sizeof(auth));

    LOG_I("api: fetching setup from %s", url);

    http_response_t resp;
    int rc = http_get(url, auth[0] ? auth : NULL, &resp);
    if (rc != 0 || resp.status < 200 || resp.status >= 300) {
        LOG_E("api: setup import failed (status=%d)", resp.status);
        http_response_free(&resp);
        return -1;
    }

    if (!resp.body || !resp.body_len) {
        LOG_E("api: setup import returned empty response");
        http_response_free(&resp);
        return -1;
    }

    LOG_D("api: setup response (%lu bytes): %.500s", (unsigned long)resp.body_len, resp.body);

    /* Parse JSON response */
    cJSON *setup = cJSON_ParseWithLength(resp.body, resp.body_len);
    http_response_free(&resp);
    if (!setup) {
        LOG_E("api: setup import returned invalid JSON");
        return -1;
    }

    /* If response is wrapped in {"data":{...}}, unwrap it */
    cJSON *data_wrap = cJSON_GetObjectItem(setup, "data");
    cJSON *root = (data_wrap && cJSON_IsObject(data_wrap)) ? data_wrap : setup;

    /* Map fields to agent_config_t */
    cJSON *agent = cJSON_GetObjectItem(root, "agent");
    cJSON *v;

    if (!agent) {
        LOG_E("api: setup JSON missing 'agent' section");
        cJSON_Delete(setup);
        return -1;
    }

    {
        if ((v = cJSON_GetObjectItem(agent, "id")) && v->valuestring)
            snprintf(cfg->id, sizeof(cfg->id), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "timezone")) && v->valuestring)
            snprintf(cfg->timezone, sizeof(cfg->timezone), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "records_enabled")))
            cfg->records_enabled = cJSON_IsTrue(v);
        if ((v = cJSON_GetObjectItem(agent, "records_ttl")))
            cfg->records_ttl = v->valueint;
        if ((v = cJSON_GetObjectItem(agent, "rtmps")))
            cfg->rtmps = cJSON_IsTrue(v);
        if ((v = cJSON_GetObjectItem(agent, "stream_server")) && v->valuestring) {
            snprintf(cfg->stream_server, sizeof(cfg->stream_server), "%s", v->valuestring);
            /* Normalize: replace :8443 with :443 (default RTMPS port) */
            char *p8443 = strstr(cfg->stream_server, ":8443");
            if (p8443) {
                memmove(p8443 + 4, p8443 + 5, strlen(p8443 + 5) + 1);
                memcpy(p8443, ":443", 4);
            }
        }
        if ((v = cJSON_GetObjectItem(agent, "snapshots")) && v->valuestring)
            snprintf(cfg->snapshots_url, sizeof(cfg->snapshots_url), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "callback_url")) && v->valuestring)
            snprintf(cfg->callback_url, sizeof(cfg->callback_url), "%s", v->valuestring);
        if (((v = cJSON_GetObjectItem(agent, "tenant")) ||
             (v = cJSON_GetObjectItem(agent, "app"))) && v->valuestring)
            snprintf(cfg->tenant, sizeof(cfg->tenant), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "encryption_key")) && v->valuestring)
            snprintf(cfg->encryption_key, sizeof(cfg->encryption_key), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "store_id")) && v->valuestring)
            snprintf(cfg->store_id, sizeof(cfg->store_id), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "alias")) && v->valuestring)
            snprintf(cfg->alias, sizeof(cfg->alias), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "latitude")))
            cfg->latitude = v->valuedouble;
        if ((v = cJSON_GetObjectItem(agent, "longitude")))
            cfg->longitude = v->valuedouble;
    }

    /* MQTT */
    cJSON *mqtt = cJSON_GetObjectItem(root, "mqtt");
    if (mqtt) {
        if ((v = cJSON_GetObjectItem(mqtt, "host")) && v->valuestring) {
            const char *h = v->valuestring;
            if (strncmp(h, "mqtt://", 7) == 0) h += 7;
            snprintf(cfg->mqtt_host, sizeof(cfg->mqtt_host), "%s", h);
        }
        if ((v = cJSON_GetObjectItem(mqtt, "port")))
            cfg->mqtt_port = v->valueint;
    }

    /* S3/Storage */
    cJSON *s3 = cJSON_GetObjectItem(root, "s3");
    if (!s3) s3 = cJSON_GetObjectItem(root, "storage");
    if (s3) {
        if ((v = cJSON_GetObjectItem(s3, "endpoint")) && v->valuestring)
            snprintf(cfg->s3_endpoint, sizeof(cfg->s3_endpoint), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "bucket")) && v->valuestring)
            snprintf(cfg->s3_bucket, sizeof(cfg->s3_bucket), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "region")) && v->valuestring)
            snprintf(cfg->s3_region, sizeof(cfg->s3_region), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "access_key")) && v->valuestring)
            snprintf(cfg->s3_key, sizeof(cfg->s3_key), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "secret_key")) && v->valuestring)
            snprintf(cfg->s3_secret, sizeof(cfg->s3_secret), "%s", v->valuestring);
    }

    /* StreamHub API token */
    cJSON *sh = cJSON_GetObjectItem(root, "streamhub");
    if (sh) {
        if ((v = cJSON_GetObjectItem(sh, "api_token")) && v->valuestring)
            snprintf(cfg->api_token, sizeof(cfg->api_token), "%s", v->valuestring);
    }

    /* Cameras */
    cJSON *cams = cJSON_GetObjectItem(root, "cameras");
    if (cams && cJSON_IsArray(cams)) {
        cfg->camera_count = 0;
        int n = cJSON_GetArraySize(cams);
        for (int i = 0; i < n && i < MAX_CAMERAS; i++) {
            cJSON *cam = cJSON_GetArrayItem(cams, i);
            camera_t *c = &cfg->cameras[cfg->camera_count++];
            memset(c, 0, sizeof(*c));
            c->enabled = true;

            if ((v = cJSON_GetObjectItem(cam, "id")) && v->valuestring)
                snprintf(c->id, sizeof(c->id), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "ip")) && v->valuestring)
                snprintf(c->ip, sizeof(c->ip), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "status")))
                c->enabled = cJSON_IsTrue(v);
            if ((v = cJSON_GetObjectItem(cam, "rtsp")) && v->valuestring)
                snprintf(c->rtsp, sizeof(c->rtsp), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "resolution")) && v->valuestring)
                snprintf(c->resolution, sizeof(c->resolution), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "record_path")) && v->valuestring)
                snprintf(c->record_path, sizeof(c->record_path), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "room")) && v->valuestring)
                snprintf(c->room, sizeof(c->room), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "stream_key")) && v->valuestring)
                snprintf(c->stream_key, sizeof(c->stream_key), "%s", v->valuestring);
        }
    }

    cJSON_Delete(setup);

    /* Save both config and secrets */
    if (config_path)
        config_save(config_path, cfg);
    if (secrets_path)
        config_save_secrets(secrets_path, cfg);

    LOG_I("api: setup imported from %s for agent %s (app=%s, cameras=%d)",
          domain, cfg->id, cfg->tenant, cfg->camera_count);
    return 0;
}
