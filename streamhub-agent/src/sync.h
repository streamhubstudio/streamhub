#ifndef AGENT_SYNC_H
#define AGENT_SYNC_H

#include <stdint.h>

/*
 * Sync log for S3 uploads.
 *
 * Uses `.uploaded` marker files as the source of truth for whether a
 * recording has been successfully uploaded.  A human-readable sync.log
 * file is maintained for diagnostics.
 */

/* Rotate sync.log: keep only entries from the last max_days days. */
void sync_init(const char *record_base, int max_days);

/* Check whether an .uploaded marker exists for the given mp4 path. */
int  sync_is_uploaded(const char *mp4_path);

/* Create .uploaded marker + append OK line to sync.log. */
void sync_mark_uploaded(const char *record_base,
                        const char *relpath, int64_t size);

/* Append FAIL line to sync.log. */
void sync_mark_failed(const char *record_base,
                      const char *relpath, int64_t size,
                      const char *error);

#endif
