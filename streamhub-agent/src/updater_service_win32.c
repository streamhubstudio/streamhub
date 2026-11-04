/*
 * Windows Service implementation for streamhub-updater.
 *
 * Provides --install / --uninstall / --start / --stop CLI args
 * and SCM integration for running as a background service.
 *
 * Adapted from service_win32.c for the agent updater/watchdog.
 */

#ifdef _WIN32

#include "updater_service_win32.h"
#include "log.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

#define SERVICE_NAME        "StreamHubUpdater"
#define SERVICE_DISPLAY     "StreamHub Agent Updater"
#define SERVICE_DESCRIPTION "Agent updater and watchdog - remote updates, process monitoring, config sync"

/* Defined in updater_main.c */
extern int updater_run(int argc, char **argv);

/* ── SCM globals ─────────────────────────────────────────────────── */

static SERVICE_STATUS        g_svc_status;
static SERVICE_STATUS_HANDLE g_svc_status_handle = NULL;

/* ── Service install ─────────────────────────────────────────────── */

static int service_install(void)
{
    char exe_path[MAX_PATH];
    if (!GetModuleFileNameA(NULL, exe_path, sizeof(exe_path))) {
        fprintf(stderr, "Error: cannot determine exe path\n");
        return 1;
    }

    char svc_cmd[MAX_PATH + 32];
    snprintf(svc_cmd, sizeof(svc_cmd), "\"%s\" --service", exe_path);

    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_CREATE_SERVICE);
    if (!scm) {
        fprintf(stderr, "Error: cannot open SCM (run as Administrator)\n");
        return 1;
    }

    SC_HANDLE svc = CreateServiceA(
        scm,
        SERVICE_NAME,
        SERVICE_DISPLAY,
        SERVICE_ALL_ACCESS,
        SERVICE_WIN32_OWN_PROCESS,
        SERVICE_AUTO_START,
        SERVICE_ERROR_NORMAL,
        svc_cmd,
        NULL, NULL, NULL, NULL, NULL);

    if (!svc) {
        DWORD err = GetLastError();
        if (err == ERROR_SERVICE_EXISTS)
            fprintf(stderr, "Service already exists.\n");
        else
            fprintf(stderr, "Error: CreateService failed (%lu)\n", err);
        CloseServiceHandle(scm);
        return 1;
    }

    /* Set description */
    SERVICE_DESCRIPTIONA desc;
    desc.lpDescription = (LPSTR)SERVICE_DESCRIPTION;
    ChangeServiceConfig2A(svc, SERVICE_CONFIG_DESCRIPTION, &desc);

    /* Configure failure actions: restart after 10s, 10s, 30s */
    SC_ACTION actions[3];
    actions[0].Type = SC_ACTION_RESTART;
    actions[0].Delay = 10000;
    actions[1].Type = SC_ACTION_RESTART;
    actions[1].Delay = 10000;
    actions[2].Type = SC_ACTION_RESTART;
    actions[2].Delay = 30000;

    SERVICE_FAILURE_ACTIONSA fa;
    memset(&fa, 0, sizeof(fa));
    fa.dwResetPeriod = 86400;
    fa.cActions = 3;
    fa.lpsaActions = actions;
    ChangeServiceConfig2A(svc, SERVICE_CONFIG_FAILURE_ACTIONS, &fa);

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);

    /* No firewall rule needed — updater only makes outbound connections */

    printf("Service '%s' installed successfully.\n", SERVICE_NAME);
    printf("Start with: net start %s\n", SERVICE_NAME);
    return 0;
}

/* ── Service uninstall ───────────────────────────────────────────── */

static int service_uninstall(void)
{
    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_ALL_ACCESS);
    if (!scm) {
        fprintf(stderr, "Error: cannot open SCM (run as Administrator)\n");
        return 1;
    }

    SC_HANDLE svc = OpenServiceA(scm, SERVICE_NAME, SERVICE_ALL_ACCESS);
    if (!svc) {
        fprintf(stderr, "Error: service '%s' not found\n", SERVICE_NAME);
        CloseServiceHandle(scm);
        return 1;
    }

    /* Stop if running */
    SERVICE_STATUS status;
    ControlService(svc, SERVICE_CONTROL_STOP, &status);
    Sleep(2000);

    if (!DeleteService(svc)) {
        fprintf(stderr, "Error: DeleteService failed (%lu)\n", GetLastError());
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        return 1;
    }

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);

    printf("Service '%s' uninstalled.\n", SERVICE_NAME);
    return 0;
}

/* ── Service start/stop via SCM ──────────────────────────────────── */

static int service_start_cmd(void)
{
    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_CONNECT);
    if (!scm) {
        fprintf(stderr, "Error: cannot open SCM\n");
        return 1;
    }

    SC_HANDLE svc = OpenServiceA(scm, SERVICE_NAME, SERVICE_START);
    if (!svc) {
        fprintf(stderr, "Error: cannot open service\n");
        CloseServiceHandle(scm);
        return 1;
    }

    if (!StartServiceA(svc, 0, NULL)) {
        DWORD err = GetLastError();
        if (err == ERROR_SERVICE_ALREADY_RUNNING)
            printf("Service is already running.\n");
        else
            fprintf(stderr, "Error: StartService failed (%lu)\n", err);
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        return 1;
    }

    printf("Service started.\n");
    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return 0;
}

static int service_stop_cmd(void)
{
    SC_HANDLE scm = OpenSCManager(NULL, NULL, SC_MANAGER_CONNECT);
    if (!scm) {
        fprintf(stderr, "Error: cannot open SCM\n");
        return 1;
    }

    SC_HANDLE svc = OpenServiceA(scm, SERVICE_NAME, SERVICE_STOP);
    if (!svc) {
        fprintf(stderr, "Error: cannot open service\n");
        CloseServiceHandle(scm);
        return 1;
    }

    SERVICE_STATUS status;
    if (!ControlService(svc, SERVICE_CONTROL_STOP, &status)) {
        fprintf(stderr, "Error: cannot stop service (%lu)\n", GetLastError());
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        return 1;
    }

    printf("Service stop requested.\n");
    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return 0;
}

/* ── SCM control handler ─────────────────────────────────────────── */

static VOID WINAPI service_ctrl_handler(DWORD ctrl)
{
    switch (ctrl) {
    case SERVICE_CONTROL_STOP:
    case SERVICE_CONTROL_SHUTDOWN:
        g_svc_status.dwCurrentState = SERVICE_STOP_PENDING;
        SetServiceStatus(g_svc_status_handle, &g_svc_status);
        plat_request_exit();
        break;

    case SERVICE_CONTROL_INTERROGATE:
        SetServiceStatus(g_svc_status_handle, &g_svc_status);
        break;
    }
}

/* ── ServiceMain ─────────────────────────────────────────────────── */

static VOID WINAPI service_main(DWORD argc, LPSTR *argv)
{
    (void)argc; (void)argv;

    g_svc_status_handle = RegisterServiceCtrlHandlerA(SERVICE_NAME, service_ctrl_handler);
    if (!g_svc_status_handle) return;

    memset(&g_svc_status, 0, sizeof(g_svc_status));
    g_svc_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_svc_status.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
    g_svc_status.dwCurrentState = SERVICE_START_PENDING;
    SetServiceStatus(g_svc_status_handle, &g_svc_status);

    /* Set working directory to exe directory */
    char exe_dir[MAX_PATH];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0)
        SetCurrentDirectoryA(exe_dir);

    /* Init log to file */
    log_init_file("updater.log");

    /* Report running */
    g_svc_status.dwCurrentState = SERVICE_RUNNING;
    SetServiceStatus(g_svc_status_handle, &g_svc_status);

    /* Run the updater (blocks until exit requested) */
    char *run_argv[] = { "streamhub-updater.exe", "config.yml", "secrets.ini", NULL };
    updater_run(3, run_argv);

    log_close_file();

    g_svc_status.dwCurrentState = SERVICE_STOPPED;
    SetServiceStatus(g_svc_status_handle, &g_svc_status);
}

/* ── Public API ──────────────────────────────────────────────────── */

int updater_service_handle_args(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--install") == 0)
            exit(service_install());
        if (strcmp(argv[i], "--uninstall") == 0)
            exit(service_uninstall());
        if (strcmp(argv[i], "--start") == 0)
            exit(service_start_cmd());
        if (strcmp(argv[i], "--stop") == 0)
            exit(service_stop_cmd());
    }
    return 0;
}

int updater_service_try_start(int argc, char **argv)
{
    int is_service = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--service") == 0) {
            is_service = 1;
            break;
        }
    }

    if (!is_service) return 0;

    SERVICE_TABLE_ENTRYA table[] = {
        { (LPSTR)SERVICE_NAME, service_main },
        { NULL, NULL }
    };

    if (!StartServiceCtrlDispatcherA(table)) {
        fprintf(stderr, "Error: StartServiceCtrlDispatcher failed (%lu)\n",
                GetLastError());
        return 0;
    }

    return 1;
}

#endif /* _WIN32 */
