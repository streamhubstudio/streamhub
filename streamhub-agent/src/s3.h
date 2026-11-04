#ifndef AGENT_S3_H
#define AGENT_S3_H

#include "config.h"
#include <stddef.h>

/*
 * Upload a file to S3-compatible storage (Wasabi) using AWS Signature V4.
 * Returns 0 on success, -1 on failure.
 *
 * object_key: full key, e.g. "storarmega/records/c00623/2024-01-15/video/clip.mp4"
 * content_type: MIME type, e.g. "video/mp4"
 */
int s3_upload_file(const agent_config_t *cfg,
                   const char *file_path,
                   const char *object_key,
                   const char *content_type);

/* Build the S3 object key for a recording segment */
void s3_build_record_key(const agent_config_t *cfg, const camera_t *cam,
                         const char *date, const char *filename,
                         char *key, size_t key_len);

/* Build the S3 object key for a snapshot */
void s3_build_snapshot_key(const agent_config_t *cfg, const camera_t *cam,
                           const char *date, const char *filename,
                           char *key, size_t key_len);

/* Build the S3 object key for a recording preview/thumbnail */
void s3_build_preview_key(const agent_config_t *cfg, const camera_t *cam,
                          const char *date, const char *filename,
                          char *key, size_t key_len);

#endif
