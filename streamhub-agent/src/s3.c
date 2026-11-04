#include "s3.h"
#include "http.h"
#include "util.h"
#include "log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/*
 * AWS Signature V4 for S3 PUT uploads.
 * Implements the signing algorithm used by Wasabi (S3-compatible).
 */

static void sign_key(const char *secret, const char *date,
                     const char *region, const char *service,
                     unsigned char *out)
{
    char full_secret[128];
    snprintf(full_secret, sizeof(full_secret), "AWS4%s", secret);

    unsigned char k_date[32], k_region[32], k_service[32];

    hmac_sha256(full_secret, strlen(full_secret),
                date, strlen(date), k_date);
    hmac_sha256(k_date, 32, region, strlen(region), k_region);
    hmac_sha256(k_region, 32, service, strlen(service), k_service);
    hmac_sha256(k_service, 32, "aws4_request", 12, out);
}

int s3_upload_file(const agent_config_t *cfg,
                   const char *file_path,
                   const char *object_key,
                   const char *content_type)
{
    /* Get file size without loading into RAM */
    FILE *fp = fopen(file_path, "rb");
    if (!fp) {
        LOG_E("s3: cannot open %s", file_path);
        return -1;
    }
    fseek(fp, 0, SEEK_END);
    long fsize = ftell(fp);
    fclose(fp);

    /* Pass 1: streaming SHA-256 hash (reads file in 64KB chunks) */
    char payload_hash[65];
    if (sha256_file_hex(file_path, payload_hash) != 0) {
        LOG_E("s3: hash failed for %s", file_path);
        return -1;
    }

    /* Timestamp */
    char iso_time[32], date_short[16];
    now_iso8601(iso_time, sizeof(iso_time));
    snprintf(date_short, sizeof(date_short), "%.8s", iso_time);

    /* Host — use path-style (s3ForcePathStyle: true, like Node.js agent) */
    const char *host = cfg->s3_endpoint;

    /* Full path = /bucket/key */
    char full_path[MAX_URL_LEN];
    snprintf(full_path, sizeof(full_path), "/%s/%s", cfg->s3_bucket, object_key);

    /* Canonical request */
    char canonical[4096];
    snprintf(canonical, sizeof(canonical),
        "PUT\n"
        "%s\n"
        "\n"
        "content-type:%s\n"
        "host:%s\n"
        "x-amz-content-sha256:%s\n"
        "x-amz-date:%s\n"
        "\n"
        "content-type;host;x-amz-content-sha256;x-amz-date\n"
        "%s",
        full_path, content_type, host, payload_hash, iso_time, payload_hash);

    char canonical_hash[65];
    sha256_hex(canonical, strlen(canonical), canonical_hash);

    /* String to sign */
    char scope[128];
    snprintf(scope, sizeof(scope), "%s/%s/s3/aws4_request",
             date_short, cfg->s3_region);

    char string_to_sign[512];
    snprintf(string_to_sign, sizeof(string_to_sign),
        "AWS4-HMAC-SHA256\n%s\n%s\n%s",
        iso_time, scope, canonical_hash);

    /* Signing key */
    unsigned char signing_key[32];
    sign_key(cfg->s3_secret, date_short, cfg->s3_region, "s3", signing_key);

    /* Signature */
    unsigned char sig_raw[32];
    hmac_sha256(signing_key, 32,
                string_to_sign, strlen(string_to_sign), sig_raw);

    char signature[65];
    for (int i = 0; i < 32; i++)
        sprintf(signature + i * 2, "%02x", sig_raw[i]);
    signature[64] = '\0';

    /* Authorization header */
    char auth[512];
    snprintf(auth, sizeof(auth),
        "Authorization: AWS4-HMAC-SHA256 Credential=%s/%s, "
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, "
        "Signature=%s",
        cfg->s3_key, scope, signature);

    /* Build URL (path-style) */
    char url[MAX_URL_LEN];
    snprintf(url, sizeof(url), "https://%s%s", host, full_path);

    char hdr_ct[128], hdr_hash[128], hdr_date[64];
    snprintf(hdr_ct, sizeof(hdr_ct), "Content-Type: %s", content_type);
    snprintf(hdr_hash, sizeof(hdr_hash), "x-amz-content-sha256: %s", payload_hash);
    snprintf(hdr_date, sizeof(hdr_date), "x-amz-date: %s", iso_time);

    const char *headers[] = { auth, hdr_ct, hdr_hash, hdr_date };

    /* Pass 2: streaming upload (reads file in 64KB chunks) */
    http_response_t resp;
    int rc = http_put_file(url, headers, 4, file_path, fsize, &resp);

    if (rc == 0 && resp.status == 200) {
        LOG_I("s3: uploaded %s (%ld bytes)", object_key, fsize);
        http_response_free(&resp);
        return 0;
    }

    LOG_E("s3: upload failed status=%d for %s", resp.status, object_key);
    if (resp.body)
        LOG_E("s3: response: %.200s", resp.body);
    http_response_free(&resp);
    return -1;
}

void s3_build_record_key(const agent_config_t *cfg, const camera_t *cam,
                         const char *date, const char *filename,
                         char *key, size_t key_len)
{
    snprintf(key, key_len, "%s/records/%s/%s/video/%s",
             cfg->tenant, cam->id, date, filename);
}

void s3_build_snapshot_key(const agent_config_t *cfg, const camera_t *cam,
                           const char *date, const char *filename,
                           char *key, size_t key_len)
{
    snprintf(key, key_len, "%s/records/%s/%s/snapshots/%s",
             cfg->tenant, cam->id, date, filename);
}

void s3_build_preview_key(const agent_config_t *cfg, const camera_t *cam,
                          const char *date, const char *filename,
                          char *key, size_t key_len)
{
    snprintf(key, key_len, "%s/records/%s/%s/preview/%s",
             cfg->tenant, cam->id, date, filename);
}
