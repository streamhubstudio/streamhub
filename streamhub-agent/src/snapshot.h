#ifndef AGENT_SNAPSHOT_H
#define AGENT_SNAPSHOT_H

#include "config.h"

/*
 * Capture a JPEG snapshot from the camera and upload it.
 *
 * On the Luckfox, rkipc writes JPEG snapshots to the filesystem when
 * enable_cycle_snapshot=1. Alternatively, we grab a frame from the
 * RTSP sub-stream using the Rockchip sample tools.
 *
 * Returns 0 on success, -1 on failure.
 */
int snapshot_capture(const agent_config_t *cfg, const camera_t *cam,
                     const char *output_path);

/*
 * Upload a snapshot JPEG to the configured endpoint via HTTP POST multipart.
 * Mirrors the Node.js agent's behavior:
 *   POST snapshots_url with fields: tenant, id, snapshot (file)
 */
int snapshot_upload(const agent_config_t *cfg, const camera_t *cam,
                    const char *jpeg_path);

#endif
