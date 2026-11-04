#ifndef AGENT_WEBUI_H
#define AGENT_WEBUI_H

#include "config.h"
#include "mqtt_client.h"
#include "recorder.h"
#include "stream.h"
#include "detect.h"
#include "platform.h"
#include <stdbool.h>

#define WEBUI_MAX_CLIENTS   3

/* Forward declaration */
typedef struct webui webui_t;

/* Application context passed into webui for API handlers */
typedef struct {
    agent_config_t *cfg;
    mqttc_t        *mqtt;
    const char     *config_path;
    const char     *secrets_path;
    const char     *version;
    bool            reboot_requested;
    int             wd_fd;           /* watchdog fd (for child processes to close) */
    recorder_ctx_t *recorders;       /* pointer to recorders array in main() */
    detect_ctx_t   *detectors;       /* pointer to detectors array in main() */
    stream_ctx_t    streams[MAX_CAMERAS];
    int             stream_timeout[MAX_CAMERAS]; /* seconds remaining, 0=no limit */
    time_t          started_at;      /* agent process start time (for app uptime) */
    bool            online;          /* internet connectivity OK */
    int             upload_fail_count; /* consecutive S3 upload failures */
} app_context_t;

webui_t *webui_create(app_context_t *app);
void     webui_destroy(webui_t *w);

/* Fill pollfds starting at fds[offset]. Returns number of fds added. */
int      webui_fill_pollfds(webui_t *w, struct pollfd *fds, int offset);

/* Process events after poll(). Pass the same fds/offset used in fill. */
void     webui_process(webui_t *w, struct pollfd *fds, int offset);

#endif
