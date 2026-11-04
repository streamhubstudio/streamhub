#ifndef AGENT_STORAGE_H
#define AGENT_STORAGE_H

#include "config.h"
#include <stdbool.h>
#include <stdint.h>

/*
 * Detect and mount the SD card if present.
 * Sets cfg->sd_available and cfg->sd_mount.
 */
int  storage_detect_sd(agent_config_t *cfg);

/*
 * Get the active recording base path.
 * Returns SD card path if available, otherwise /userdata with limited retention.
 */
const char *storage_record_path(const agent_config_t *cfg);

/*
 * Rotate old recordings to stay within retention limits.
 * On internal flash: keeps max 30 minutes of recordings.
 * On SD card: keeps records_ttl days of recordings.
 */
int  storage_rotate(const agent_config_t *cfg);

/*
 * Get free space in MB at the given path.
 */
int64_t storage_free_mb(const char *path);

/*
 * Scan for completed recording files that haven't been uploaded yet.
 * Returns count of files found; fills paths array up to max_files.
 */
int  storage_scan_pending(const agent_config_t *cfg, const camera_t *cam,
                          char paths[][MAX_PATH_LEN], int max_files);

#endif
