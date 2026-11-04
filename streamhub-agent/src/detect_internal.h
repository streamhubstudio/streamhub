#ifndef AGENT_DETECT_INTERNAL_H
#define AGENT_DETECT_INTERNAL_H

/*
 * Internal seam between the detect.c dispatcher and the per-mode backends
 * (detect_remote.c, detect_edge.c). Not part of the public detect.h API —
 * only these three translation units include it (plus onvif.c, which reuses
 * the shared python-finder below to spawn scripts/onvif.py).
 */

#include "detect.h"

/* ── remote mode (detect_remote.c) ──────────────────────────────── */
int  detect_remote_start(detect_ctx_t *ctx, const agent_config_t *cfg,
                         const camera_t *cam);
void detect_remote_stop(detect_ctx_t *ctx);

/* ── edge mode (detect_edge.c) ──────────────────────────────────── */
int  detect_edge_start(detect_ctx_t *ctx, const agent_config_t *cfg,
                       const camera_t *cam);
void detect_edge_stop(detect_ctx_t *ctx);
int  detect_edge_tick(detect_ctx_t *ctx, const agent_config_t *cfg);

/* Locate a Python interpreter (portable-alongside-exe, then system). NULL if
 * none found. Shared helper used by the edge worker spawn. */
const char *detect_find_python(void);

#endif
