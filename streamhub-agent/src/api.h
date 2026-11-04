#ifndef AGENT_API_H
#define AGENT_API_H

#include "config.h"

/*
 * Backend API client — mirrors Api.js from the Node.js agent.
 * All calls go to https://<callback_url>/api/management/devices/...
 * with HTTP Basic Auth (management_user / management_pass).
 */

int api_heartbeat(const agent_config_t *cfg, const camera_t *cam);

int api_record_store(const agent_config_t *cfg, const camera_t *cam,
                     const char *record_url, const char *record_thumbnail_url);

int api_io_error(const agent_config_t *cfg, const camera_t *cam,
                 const char *error_msg);

/*
 * Import agent setup from the backend API.
 * GET https://{domain}/api/management/devices/agents/setup/{agent_id}
 * Populates cfg and saves config/secrets files.
 */
int api_setup_import(const char *domain, const char *agent_id,
                     agent_config_t *cfg, const char *config_path,
                     const char *secrets_path);

#endif
