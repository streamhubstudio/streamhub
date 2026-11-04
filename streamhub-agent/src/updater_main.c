/*
 * streamhub-updater — Standalone updater/watchdog for streamhub-agent.
 *
 * Functions:
 *   1. Updater: Download new agent versions via MQTT command, binary swap, restart
 *   2. Watchdog: Monitor agent process, restart if crashed
 *   3. Remote control: start/stop/restart agent, config sync, version report
 *
 * Uses MQTT with updater ID: agent "b09994" → updater "u09994".
 * Download URL: https://assets.streamhub.cloud/builds/agent/{VERSION}/{binary}
 */

#include "config.h"
#include "log.h"
#include "util.h"
#include "mqtt_client.h"
#include "http.h"
#include "api.h"
#include "platform.h"

#ifdef PLAT_WINDOWS
  #include "updater_service_win32.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <openssl/ssl.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
  #include <sys/stat.h>
#endif

#ifndef UPDATER_VERSION
#define UPDATER_VERSION  "1.0"
#endif

#ifdef PLAT_WINDOWS
  #define DEFAULT_CONFIG_PATH   "config.yml"
  #define DEFAULT_SECRETS_PATH  "secrets.ini"
  #define AGENT_BINARY          "streamhub-agent.exe"
  #define AGENT_SERVICE_NAME    "StreamHubAgent"
#else
  #define DEFAULT_CONFIG_PATH   "/userdata/streamhub/config.yml"
  #define DEFAULT_SECRETS_PATH  "/userdata/streamhub/secrets.ini"
  #define AGENT_BINARY          "streamhub-agent"
  #define AGENT_INIT_SCRIPT     "/etc/init.d/S95streamhub"
#endif

#define DOWNLOAD_BASE_URL  "https://assets.streamhub.cloud/builds/agent"

/* ── Intervals (seconds) ──────────────────────────────────────────── */
#define INTERVAL_WATCHDOG     30
#define INTERVAL_MQTT_RECONN  10
#define INTERVAL_LOG_ROTATE   300   /* 5 min */

/* Watchdog restart limits */
#define WATCHDOG_MAX_RETRIES  5
#define WATCHDOG_OK_PERIOD    300   /* reset counter after 5 min running OK */
#define WATCHDOG_BACKOFF_BASE 10    /* seconds */
#define WATCHDOG_BACKOFF_MAX  60

/* ── Globals ─────────────────────────────────────────────────────── */

static volatile int g_agent_should_run = 1;
static volatile int g_update_in_progress = 0;
static int g_watchdog_retries = 0;
static time_t g_agent_started_at = 0;

/* Update request (set by MQTT handler, consumed by worker) */
static char g_update_version[64] = {0};

/* Config and MQTT for the updater */
static agent_config_t g_cfg;
static agent_config_t g_updater_cfg;  /* copy with updater ID */
static mqttc_t *g_mqtt = NULL;
static const char *g_config_path;
static const char *g_secrets_path;

/* ── Agent binary path ───────────────────────────────────────────── */

static void get_agent_binary_path(char *buf, size_t len)
{
#ifdef PLAT_WINDOWS
    char exe_dir[MAX_PATH_LEN];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0)
        snprintf(buf, len, "%s\\%s", exe_dir, AGENT_BINARY);
    else
        snprintf(buf, len, "%s", AGENT_BINARY);
#else
    snprintf(buf, len, "/userdata/streamhub/%s", AGENT_BINARY);
#endif
}

/* ── Agent process control ───────────────────────────────────────── */

#ifdef PLAT_WINDOWS

static int agent_is_running(void)
{
    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_CONNECT);
    if (!scm) return 0;

    SC_HANDLE svc = OpenServiceA(scm, AGENT_SERVICE_NAME, SERVICE_QUERY_STATUS);
    if (!svc) {
        CloseServiceHandle(scm);
        return 0;
    }

    SERVICE_STATUS status;
    int running = 0;
    if (QueryServiceStatus(svc, &status))
        running = (status.dwCurrentState == SERVICE_RUNNING);

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return running;
}

static int agent_start(void)
{
    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_CONNECT);
    if (!scm) {
        LOG_E("updater: cannot open SCM to start agent");
        return -1;
    }

    SC_HANDLE svc = OpenServiceA(scm, AGENT_SERVICE_NAME, SERVICE_START);
    if (!svc) {
        LOG_E("updater: cannot open agent service");
        CloseServiceHandle(scm);
        return -1;
    }

    int ok = StartServiceA(svc, 0, NULL) ? 0 : -1;
    if (ok != 0 && GetLastError() == ERROR_SERVICE_ALREADY_RUNNING)
        ok = 0;

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return ok;
}

static int agent_stop(void)
{
    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_CONNECT);
    if (!scm) {
        LOG_E("updater: cannot open SCM to stop agent");
        return -1;
    }

    SC_HANDLE svc = OpenServiceA(scm, AGENT_SERVICE_NAME, SERVICE_STOP);
    if (!svc) {
        LOG_E("updater: cannot open agent service");
        CloseServiceHandle(scm);
        return -1;
    }

    SERVICE_STATUS status;
    int ok = ControlService(svc, SERVICE_CONTROL_STOP, &status) ? 0 : -1;
    if (ok != 0 && GetLastError() == ERROR_SERVICE_NOT_ACTIVE)
        ok = 0;

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);

    /* Wait for it to actually stop */
    for (int i = 0; i < 10; i++) {
        plat_sleep_ms(1000);
        if (!agent_is_running()) return 0;
    }
    return ok;
}

#else /* PLAT_POSIX */

static int agent_is_running(void)
{
    /* Check pidfile first */
    FILE *f = fopen("/var/run/streamhub.pid", "r");
    if (f) {
        int pid = 0;
        if (fscanf(f, "%d", &pid) == 1 && pid > 0) {
            fclose(f);
            return (kill(pid, 0) == 0) ? 1 : 0;
        }
        fclose(f);
    }

    /* Fallback: pidof */
    FILE *pp = popen("pidof " AGENT_BINARY, "r");
    if (!pp) return 0;
    char buf[64] = {0};
    int got = (fgets(buf, sizeof(buf), pp) != NULL);
    pclose(pp);
    return (got && buf[0] != '\0') ? 1 : 0;
}

static int agent_start(void)
{
    if (file_exists(AGENT_INIT_SCRIPT)) {
        int rc = system(AGENT_INIT_SCRIPT " start");
        return (rc == 0) ? 0 : -1;
    }

    /* Fallback: direct spawn */
    char agent_path[MAX_PATH_LEN];
    get_agent_binary_path(agent_path, sizeof(agent_path));
    char *argv[] = {
        agent_path,
        (char *)g_config_path,
        (char *)g_secrets_path,
        NULL
    };
    platform_proc_t proc;
    return plat_spawn(&proc, agent_path, argv, 0, 0);
}

static int agent_stop(void)
{
    if (file_exists(AGENT_INIT_SCRIPT)) {
        int rc = system(AGENT_INIT_SCRIPT " stop");
        return (rc == 0) ? 0 : -1;
    }

    /* Fallback: killall */
    system("killall " AGENT_BINARY " 2>/dev/null");
    plat_sleep_ms(2000);
    system("killall -9 " AGENT_BINARY " 2>/dev/null");
    return 0;
}

#endif

static int agent_restart(void)
{
#ifdef PLAT_POSIX
    if (file_exists(AGENT_INIT_SCRIPT)) {
        int rc = system(AGENT_INIT_SCRIPT " restart");
        return (rc == 0) ? 0 : -1;
    }
#endif
    agent_stop();
    plat_sleep_ms(2000);
    return agent_start();
}

/* ── Update worker (runs in pthread) ─────────────────────────────── */

typedef struct {
    agent_config_t cfg;
    char version[64];
    char updater_id[MAX_ID_LEN];
} update_worker_ctx_t;

static void update_worker_fn(void *arg)
{
    update_worker_ctx_t *ctx = (update_worker_ctx_t *)arg;
    const char *version = ctx->version;
    const char *updater_id = ctx->updater_id;

    char agent_path[MAX_PATH_LEN];
    get_agent_binary_path(agent_path, sizeof(agent_path));

    char new_path[MAX_PATH_LEN];
    char bak_path[MAX_PATH_LEN];
    snprintf(new_path, sizeof(new_path), "%s.new", agent_path);
    snprintf(bak_path, sizeof(bak_path), "%s.bak", agent_path);

    /* Build download URL */
    char url[MAX_URL_LEN];
    snprintf(url, sizeof(url), "%s/%s/%s", DOWNLOAD_BASE_URL, version, AGENT_BINARY);

    LOG_I("updater: downloading %s", url);

    /* Publish status */
    if (g_mqtt) {
        char status_msg[256];
        snprintf(status_msg, sizeof(status_msg),
            "{\"status\":\"downloading\",\"version\":\"%s\"}", version);
        mqttc_pub_action(g_mqtt, updater_id, "update_log", status_msg);
    }

    /* Download binary */
    http_response_t resp;
    memset(&resp, 0, sizeof(resp));
    if (http_get(url, NULL, &resp) != 0 || resp.status != 200 || !resp.body || resp.body_len < 1000) {
        LOG_E("updater: download failed (status=%d, len=%lu)", resp.status, (unsigned long)resp.body_len);
        if (g_mqtt) {
            char err_msg[256];
            snprintf(err_msg, sizeof(err_msg),
                "{\"status\":\"error\",\"version\":\"%s\",\"error\":\"download failed (HTTP %d)\"}",
                version, resp.status);
            mqttc_pub_action(g_mqtt, updater_id, "update_log", err_msg);
        }
        http_response_free(&resp);
        g_update_in_progress = 0;
        return;
    }

    LOG_I("updater: downloaded %lu bytes", (unsigned long)resp.body_len);

    /* Write to .new file */
    FILE *f = fopen(new_path, "wb");
    if (!f) {
        LOG_E("updater: cannot create %s", new_path);
        http_response_free(&resp);
        g_update_in_progress = 0;
        return;
    }
    fwrite(resp.body, 1, resp.body_len, f);
    fclose(f);
    http_response_free(&resp);

#ifdef PLAT_POSIX
    chmod(new_path, 0755);
#endif

    /* Publish installing status */
    if (g_mqtt) {
        char status_msg[256];
        snprintf(status_msg, sizeof(status_msg),
            "{\"status\":\"installing\",\"version\":\"%s\"}", version);
        mqttc_pub_action(g_mqtt, updater_id, "update_log", status_msg);
    }

    /* Stop agent */
    LOG_I("updater: stopping agent for update");
    g_agent_should_run = 0;  /* prevent watchdog interference */
    agent_stop();
    plat_sleep_ms(2000);

    /* Swap binaries: current → .bak, .new → current */
    portable_unlink(bak_path);
#ifdef PLAT_WINDOWS
    /* Windows: rename fails if dest exists */
    remove(bak_path);
#endif
    if (rename(agent_path, bak_path) != 0) {
        LOG_W("updater: rename %s → .bak failed (errno=%d), trying direct overwrite",
              AGENT_BINARY, errno);
    }

#ifdef PLAT_WINDOWS
    remove(agent_path);
#endif
    if (rename(new_path, agent_path) != 0) {
        LOG_E("updater: rename .new → %s failed (errno=%d)", AGENT_BINARY, errno);
        /* Rollback: restore backup */
        if (file_exists(bak_path)) {
            rename(bak_path, agent_path);
            LOG_I("updater: rolled back to previous version");
        }
        if (g_mqtt) {
            char err_msg[256];
            snprintf(err_msg, sizeof(err_msg),
                "{\"status\":\"error\",\"version\":\"%s\",\"error\":\"file swap failed\"}",
                version);
            mqttc_pub_action(g_mqtt, updater_id, "update_log", err_msg);
        }
        g_agent_should_run = 1;
        agent_start();
        g_update_in_progress = 0;
        return;
    }

#ifdef PLAT_POSIX
    chmod(agent_path, 0755);
#endif

    /* Start agent with new binary */
    LOG_I("updater: starting agent with new version %s", version);
    g_agent_should_run = 1;
    agent_start();

    /* Wait up to 30s for agent to come up */
    int started = 0;
    for (int i = 0; i < 15; i++) {
        plat_sleep_ms(2000);
        if (agent_is_running()) {
            started = 1;
            break;
        }
    }

    if (!started) {
        /* Rollback */
        LOG_E("updater: agent failed to start with new version, rolling back");
        agent_stop();
        plat_sleep_ms(1000);

        portable_unlink(agent_path);
#ifdef PLAT_WINDOWS
        remove(agent_path);
#endif
        if (file_exists(bak_path)) {
            rename(bak_path, agent_path);
#ifdef PLAT_POSIX
            chmod(agent_path, 0755);
#endif
        }
        agent_start();

        if (g_mqtt) {
            char err_msg[256];
            snprintf(err_msg, sizeof(err_msg),
                "{\"status\":\"error\",\"version\":\"%s\",\"error\":\"agent failed to start, rolled back\"}",
                version);
            mqttc_pub_action(g_mqtt, updater_id, "update_log", err_msg);
        }
    } else {
        /* Success! Clean up backup */
        portable_unlink(bak_path);
        LOG_I("updater: agent updated to version %s successfully", version);

        if (g_mqtt) {
            char status_msg[256];
            snprintf(status_msg, sizeof(status_msg),
                "{\"status\":\"success\",\"version\":\"%s\"}", version);
            mqttc_pub_action(g_mqtt, updater_id, "update_log", status_msg);
        }
    }

    g_agent_started_at = time(NULL);
    g_watchdog_retries = 0;
    g_update_in_progress = 0;
}

/* ── MQTT message handler ─────────────────────────────────────────── */

static void on_mqtt_message(const char *topic, const char *payload, void *ctx)
{
    (void)ctx;

    LOG_D("updater mqtt: recv [%s] %s", topic, payload);

    /* Parse topic: /<tenant>/<updater_id>/<action> */
    char buf[MAX_TOPIC_LEN];
    snprintf(buf, sizeof(buf), "%s", topic);

    char *parts[4];
    int nparts = 0;
    char *tok = strtok(buf, "/");
    while (tok && nparts < 4) {
        parts[nparts++] = tok;
        tok = strtok(NULL, "/");
    }

    if (nparts < 3) return;
    const char *action = parts[2];

    if (strcmp(action, "ping") == 0) {
        mqttc_pub_action(g_mqtt, g_updater_cfg.id, "pong", "1");
    }
    else if (strcmp(action, "version") == 0) {
        mqttc_pub_action(g_mqtt, g_updater_cfg.id, "version", UPDATER_VERSION);
    }
    else if (strcmp(action, "update") == 0) {
        if (!payload || !payload[0]) {
            LOG_W("updater: update command with empty version");
            return;
        }
        if (g_update_in_progress) {
            LOG_W("updater: update already in progress, ignoring");
            return;
        }
        LOG_I("updater: update requested to version %s", payload);
        snprintf(g_update_version, sizeof(g_update_version), "%s", payload);
    }
    else if (strcmp(action, "agent_restart") == 0) {
        LOG_I("updater: agent restart requested");
        agent_restart();
        g_agent_started_at = time(NULL);
        g_watchdog_retries = 0;
    }
    else if (strcmp(action, "agent_start") == 0) {
        LOG_I("updater: agent start requested");
        g_agent_should_run = 1;
        agent_start();
        g_agent_started_at = time(NULL);
        g_watchdog_retries = 0;
    }
    else if (strcmp(action, "agent_stop") == 0) {
        LOG_I("updater: agent stop requested");
        g_agent_should_run = 0;
        agent_stop();
    }
    else if (strcmp(action, "agent_sync") == 0) {
        LOG_I("updater: config sync requested");
        /* Extract domain from callback_url */
        char domain[MAX_URL_LEN];
        snprintf(domain, sizeof(domain), "%s", g_cfg.callback_url);
        /* Strip https:// prefix and trailing path */
        char *d = domain;
        if (strncmp(d, "https://", 8) == 0) d += 8;
        else if (strncmp(d, "http://", 7) == 0) d += 7;
        char *slash = strchr(d, '/');
        if (slash) *slash = '\0';

        if (api_setup_import(d, g_cfg.id, &g_cfg,
                             g_config_path, g_secrets_path) == 0) {
            LOG_I("updater: config synced, restarting agent");
            agent_restart();
            g_agent_started_at = time(NULL);
        } else {
            LOG_E("updater: config sync failed");
        }
    }
}

/* ── MQTT subscriptions ───────────────────────────────────────────── */

static void subscribe_topics(mqttc_t *mqtt, const agent_config_t *cfg,
                             const char *updater_id)
{
    char topic[MAX_TOPIC_LEN];
    const char *actions[] = {
        "ping", "version", "update",
        "agent_restart", "agent_start", "agent_stop", "agent_sync",
        NULL
    };

    for (int i = 0; actions[i]; i++) {
        snprintf(topic, sizeof(topic), "/%s/%s/%s",
                 cfg->tenant, updater_id, actions[i]);
        mqttc_subscribe(mqtt, topic);
    }
}

/* ── Updater core ────────────────────────────────────────────────── */

int updater_run(int argc, char **argv)
{
    const char *config_path  = DEFAULT_CONFIG_PATH;
    const char *secrets_path = DEFAULT_SECRETS_PATH;
    if (argc > 1) config_path  = argv[1];
    if (argc > 2) secrets_path = argv[2];

    g_config_path  = config_path;
    g_secrets_path = secrets_path;

    /* Platform init */
    plat_net_init();
    plat_signal_init();

    OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS |
                     OPENSSL_INIT_LOAD_CRYPTO_STRINGS, NULL);

    log_init("updater", LOG_INFO);
#ifdef PLAT_WINDOWS
    log_init_file("updater.log");
#endif
    LOG_I("streamhub-updater v%s starting", UPDATER_VERSION);

    /* Load config */
    if (config_load(config_path, &g_cfg) != 0) {
        LOG_F("failed to load config from %s", config_path);
        plat_net_cleanup();
        return 1;
    }
    if (config_load_secrets(secrets_path, &g_cfg) != 0) {
        LOG_F("failed to load secrets from %s", secrets_path);
        plat_net_cleanup();
        return 1;
    }

    /* Create updater ID: b09994 → u09994 */
    char updater_id[MAX_ID_LEN];
    snprintf(updater_id, sizeof(updater_id), "%s", g_cfg.id);
    if (updater_id[0] == 'b')
        updater_id[0] = 'u';

    LOG_I("agent_id=%s  updater_id=%s  tenant=%s", g_cfg.id, updater_id, g_cfg.tenant);

    /* Create a copy of config with updater ID for MQTT */
    memcpy(&g_updater_cfg, &g_cfg, sizeof(g_cfg));
    snprintf(g_updater_cfg.id, sizeof(g_updater_cfg.id), "%s", updater_id);

    /* MQTT connect */
    g_mqtt = mqttc_create(&g_updater_cfg, on_mqtt_message, NULL);
    if (!g_mqtt) {
        LOG_F("failed to create MQTT client");
        plat_net_cleanup();
        return 1;
    }

    int mqtt_retry = 0;
    while (!plat_should_exit() && mqttc_connect(g_mqtt) != 0) {
        mqtt_retry++;
        LOG_W("mqtt: connect failed, retry %d in 5s...", mqtt_retry);
        plat_sleep_ms(5000);
        if (mqtt_retry > 12) {
            LOG_E("mqtt: giving up after %d retries", mqtt_retry);
            break;
        }
    }

    if (mqttc_connected(g_mqtt))
        subscribe_topics(g_mqtt, &g_cfg, updater_id);

    /* Publish version on connect */
    if (mqttc_connected(g_mqtt))
        mqttc_pub_action(g_mqtt, updater_id, "version", UPDATER_VERSION);

    /* Init watchdog state */
    g_agent_started_at = time(NULL);
    g_watchdog_retries = 0;

    /* Update worker */
    platform_worker_t update_worker;
    memset(&update_worker, 0, sizeof(update_worker));
    update_worker.finished = 1;
    update_worker_ctx_t update_wctx;

    /* Timers */
    int64_t last_watchdog   = 0;
    int64_t last_mqtt_reconn = 0;
    int64_t last_log_rotate  = 0;

    LOG_I("entering updater main loop");

    /* ── Main event loop ─────────────────────────────────────────── */
    struct pollfd fds[1];

    while (!plat_should_exit()) {
        int64_t now = now_ms() / 1000;

        /* Build poll set */
        int nfds = 0;
        int mqtt_fd_idx = -1;

        int mfd = mqttc_get_fd(g_mqtt);
        if (mfd >= 0 && mqttc_connected(g_mqtt)) {
            memset(&fds[0], 0, sizeof(fds[0]));
            fds[0].fd = mfd;
            fds[0].events = POLLIN;
            mqtt_fd_idx = 0;
            nfds = 1;
        }

        int poll_rc = poll(fds, nfds, 1000);
        (void)poll_rc;

        /* Process MQTT */
        if (mqtt_fd_idx >= 0 && (fds[mqtt_fd_idx].revents & POLLIN))
            mqttc_process(g_mqtt);

        if (mqtt_fd_idx >= 0 && (fds[mqtt_fd_idx].revents & (POLLHUP | POLLERR))) {
            LOG_W("mqtt: poll detected disconnect");
            mqttc_disconnect(g_mqtt);
        }

        if (mqttc_connected(g_mqtt))
            mqttc_keepalive(g_mqtt);

        /* MQTT reconnect */
        if (!mqttc_connected(g_mqtt) && now - last_mqtt_reconn >= INTERVAL_MQTT_RECONN) {
            last_mqtt_reconn = now;
            if (mqttc_connect(g_mqtt) == 0) {
                subscribe_topics(g_mqtt, &g_cfg, updater_id);
                mqttc_pub_action(g_mqtt, updater_id, "version", UPDATER_VERSION);
            }
        }

        /* ── Check for pending update ────────────────────────────── */
        if (g_update_version[0] && !g_update_in_progress && update_worker.finished) {
            g_update_in_progress = 1;
            memcpy(&update_wctx.cfg, &g_cfg, sizeof(g_cfg));
            snprintf(update_wctx.version, sizeof(update_wctx.version),
                     "%s", g_update_version);
            snprintf(update_wctx.updater_id, sizeof(update_wctx.updater_id),
                     "%s", updater_id);
            g_update_version[0] = '\0';

            if (plat_worker_start(&update_worker, update_worker_fn, &update_wctx) != 0) {
                LOG_E("updater: failed to start update worker");
                g_update_in_progress = 0;
            }
        }

        /* Reap update worker */
        if (!update_worker.finished && !plat_worker_alive(&update_worker))
            update_worker.finished = 1;

        /* ── Watchdog: check agent health ────────────────────────── */
        if (now - last_watchdog >= INTERVAL_WATCHDOG) {
            last_watchdog = now;

            if (g_agent_should_run && !g_update_in_progress) {
                if (agent_is_running()) {
                    /* Agent is alive. Reset retry counter after OK period. */
                    if (g_agent_started_at > 0 &&
                        (time(NULL) - g_agent_started_at) >= WATCHDOG_OK_PERIOD) {
                        if (g_watchdog_retries > 0) {
                            LOG_I("watchdog: agent stable for %ds, resetting retry counter",
                                  WATCHDOG_OK_PERIOD);
                        }
                        g_watchdog_retries = 0;
                    }
                } else {
                    /* Agent is down */
                    if (g_watchdog_retries < WATCHDOG_MAX_RETRIES) {
                        int backoff = WATCHDOG_BACKOFF_BASE * (1 << g_watchdog_retries);
                        if (backoff > WATCHDOG_BACKOFF_MAX)
                            backoff = WATCHDOG_BACKOFF_MAX;

                        g_watchdog_retries++;
                        LOG_W("watchdog: agent not running, restarting (attempt %d/%d, backoff %ds)",
                              g_watchdog_retries, WATCHDOG_MAX_RETRIES, backoff);

                        plat_sleep_ms(backoff * 1000);
                        agent_start();
                        g_agent_started_at = time(NULL);
                    } else {
                        LOG_E("watchdog: max retries reached (%d), giving up until manual intervention",
                              WATCHDOG_MAX_RETRIES);
                    }
                }
            }
        }

        /* ── Log rotation ────────────────────────────────────────── */
        if (now - last_log_rotate >= INTERVAL_LOG_ROTATE) {
            last_log_rotate = now;
            log_rotate();
            plat_reap_zombies();
        }
    }

    /* ── Shutdown ────────────────────────────────────────────────── */
    LOG_I("updater shutting down...");

    if (!update_worker.finished)
        plat_worker_kill(&update_worker);

    mqttc_destroy(g_mqtt);
    plat_net_cleanup();

    LOG_I("streamhub-updater stopped");
    return 0;
}

/* ── Main entry point ─────────────────────────────────────────────── */

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-v") == 0) {
            printf("streamhub-updater v%s\n", UPDATER_VERSION);
            return 0;
        }
    }
#ifdef PLAT_WINDOWS
    if (updater_service_handle_args(argc, argv))
        return 0;
    if (updater_service_try_start(argc, argv))
        return 0;
#endif
    return updater_run(argc, argv);
}
