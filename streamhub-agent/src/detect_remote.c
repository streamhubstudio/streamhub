/*
 * Remote detection backend — the StreamHub plugin live-data subscriber.
 *
 * Inference runs server-side (yolo/deface plugin over the camera's ingested
 * stream); this backend only polls the plugin's /live endpoint and translates
 * the payload into the unified events shape. No process is spawned on the box.
 * See detect.h for the endpoint contract and the events shape.
 */

#include "detect.h"
#include "detect_internal.h"
#include "http.h"
#include "log.h"
#include "util.h"

#include <cJSON.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Start / stop subscription ───────────────────────────────────── */

int detect_remote_start(detect_ctx_t *ctx, const agent_config_t *cfg,
                        const camera_t *cam)
{
    if (!cfg->callback_url[0] || !cfg->tenant[0]) {
        LOG_E("detect: no StreamHub server/app configured, cannot subscribe for %s",
              cam->id);
        return -1;
    }

    const cam_detect_t *d = &cam->detect;
    char room[64];
    detect_room(cfg, cam, room, sizeof(room));

    memset(ctx, 0, sizeof(*ctx));
    ctx->cam = cam;
    ctx->mode = DETECT_MODE_REMOTE;
    ctx->running = true;

    LOG_I("detect: subscribed %s -> %s plugin=%s room=%s poll=%ds",
          cam->id, cfg->callback_url,
          d->plugin[0] ? d->plugin : "yolo", room,
          d->poll_interval > 0 ? d->poll_interval : 2);
    return 0;
}

void detect_remote_stop(detect_ctx_t *ctx)
{
    LOG_I("detect: unsubscribed %s", ctx->cam ? ctx->cam->id : "?");
    ctx->running = false;
}

/* ── Fetch latest events from StreamHub (worker thread only) ─────── */

int detect_fetch_events(const agent_config_t *cfg, const camera_t *cam,
                        char *buf, int buf_size,
                        long long *ts_ms, int *count)
{
    const cam_detect_t *d = &cam->detect;
    const char *plugin = d->plugin[0] ? d->plugin : "yolo";

    char room[64];
    detect_room(cfg, cam, room, sizeof(room));

    char url[MAX_URL_LEN];
    snprintf(url, sizeof(url),
        "https://%s/api/v1/apps/%s/plugins/%s/live?room=%s",
        cfg->callback_url, cfg->tenant, plugin, room);

    char auth[256] = "";
    if (cfg->api_token[0])
        snprintf(auth, sizeof(auth), "Authorization: Bearer %s", cfg->api_token);

    http_response_t resp;
    int rc = http_get(url, auth[0] ? auth : NULL, &resp);
    if (rc != 0) {
        http_response_free(&resp);
        return -1;
    }
    if (resp.status == 404 || resp.status == 204) {
        /* Plugin not enabled / no live data pushed yet — not an error */
        http_response_free(&resp);
        return 0;
    }
    if (resp.status < 200 || resp.status >= 300 || !resp.body) {
        LOG_D("detect: live fetch failed for %s (status=%d)", cam->id, resp.status);
        http_response_free(&resp);
        return -1;
    }

    cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
    http_response_free(&resp);
    if (!root) return -1;

    /* Unwrap {"data":{...}} if present */
    cJSON *data_wrap = cJSON_GetObjectItem(root, "data");
    cJSON *live = (data_wrap && cJSON_IsObject(data_wrap)) ? data_wrap : root;

    cJSON *v;
    long long ingest_ms = 0;
    long long age_ms = 0;
    if ((v = cJSON_GetObjectItem(live, "ts")))
        ingest_ms = (long long)v->valuedouble;
    if ((v = cJSON_GetObjectItem(live, "ageMs")))
        age_ms = (long long)v->valuedouble;

    cJSON *payload = cJSON_GetObjectItem(live, "payload");
    if (!payload || !cJSON_IsObject(payload)) {
        cJSON_Delete(root);
        return 0; /* no payload yet */
    }

    double payload_ts = 0;
    if ((v = cJSON_GetObjectItem(payload, "ts")))
        payload_ts = v->valuedouble;

    /* Translate to the unified events shape */
    cJSON *out = cJSON_CreateObject();
    cJSON_AddNumberToObject(out, "timestamp", payload_ts);
    cJSON *out_dets = cJSON_AddArrayToObject(out, "detections");

    int n = 0;
    cJSON *dets = cJSON_GetObjectItem(payload, "detections");
    if (dets && cJSON_IsArray(dets)) {
        cJSON *det;
        cJSON_ArrayForEach(det, dets) {
            cJSON *o = cJSON_CreateObject();
            if ((v = cJSON_GetObjectItem(det, "class")) && v->valuestring)
                cJSON_AddStringToObject(o, "class", v->valuestring);
            if ((v = cJSON_GetObjectItem(det, "conf")))
                cJSON_AddNumberToObject(o, "confidence", v->valuedouble);
            else if ((v = cJSON_GetObjectItem(det, "confidence")))
                cJSON_AddNumberToObject(o, "confidence", v->valuedouble);
            cJSON *bbox = cJSON_GetObjectItem(det, "bbox");
            if (bbox && cJSON_IsArray(bbox))
                cJSON_AddItemToObject(o, "bbox", cJSON_Duplicate(bbox, 1));
            /* The live feed carries no tracker ids (server-side seam) */
            cJSON_AddNumberToObject(o, "track_id", -1);
            cJSON_AddItemToArray(out_dets, o);
            n++;
        }
    }

    cJSON_AddNumberToObject(out, "count", n);
    cJSON_AddItemToObject(out, "line_counts", cJSON_CreateObject());
    cJSON_AddNumberToObject(out, "age_ms", (double)age_ms);

    char *printed = cJSON_PrintUnformatted(out);
    cJSON_Delete(out);
    cJSON_Delete(root);
    if (!printed) return -1;

    int len = (int)strlen(printed);
    if (len >= buf_size) len = buf_size - 1;
    memcpy(buf, printed, len);
    buf[len] = '\0';
    free(printed);

    if (ts_ms) *ts_ms = ingest_ms;
    if (count) *count = n;
    return len;
}
