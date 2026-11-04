/*
 * Platform abstraction — Windows (MinGW-w64) implementation
 *
 * Uses Win32 API for process management, system info, disk, etc.
 * Sockets use Winsock2 (WSAPoll, recv/send, closesocket).
 */

#ifdef _WIN32

#include "platform.h"
#include "log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <direct.h>

/* ── Signal / exit handling ──────────────────────────────────────── */

static volatile long g_exit_requested = 0;

static BOOL WINAPI console_ctrl_handler(DWORD dwType)
{
    if (dwType == CTRL_C_EVENT || dwType == CTRL_BREAK_EVENT ||
        dwType == CTRL_CLOSE_EVENT) {
        InterlockedExchange(&g_exit_requested, 1);
        return TRUE;
    }
    return FALSE;
}

void plat_signal_init(void)
{
    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
}

int plat_should_exit(void)
{
    return InterlockedCompareExchange(&g_exit_requested, 0, 0) != 0;
}

void plat_request_exit(void)
{
    InterlockedExchange(&g_exit_requested, 1);
}

/* ── Process management ──────────────────────────────────────────── */

/*
 * Build a flat command line from argv.
 * Quotes each argument that contains spaces.
 */
static char *build_cmdline(const char *prog, char *const argv[])
{
    /* Calculate total length needed */
    size_t total = 0;
    for (int i = 0; argv[i]; i++)
        total += strlen(argv[i]) + 3; /* space + potential quotes */
    total += 1;

    char *cmd = malloc(total);
    if (!cmd) return NULL;
    cmd[0] = '\0';

    for (int i = 0; argv[i]; i++) {
        if (i > 0) strcat(cmd, " ");
        /* Quote if contains spaces */
        if (strchr(argv[i], ' ')) {
            strcat(cmd, "\"");
            strcat(cmd, argv[i]);
            strcat(cmd, "\"");
        } else {
            strcat(cmd, argv[i]);
        }
    }
    return cmd;
}

int plat_spawn(platform_proc_t *p, const char *prog, char *const argv[],
               int devnull_stdout, int devnull_stderr)
{
    memset(p, 0, sizeof(*p));

    char *cmdline = build_cmdline(prog, argv);
    if (!cmdline) return -1;

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    memset(&pi, 0, sizeof(pi));

    if (devnull_stdout || devnull_stderr) {
        SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
        HANDLE hNullW = CreateFileA("NUL", GENERIC_WRITE, FILE_SHARE_WRITE,
                                    &sa, OPEN_EXISTING, 0, NULL);
        HANDLE hNullR = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ,
                                    &sa, OPEN_EXISTING, 0, NULL);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = hNullR;
        si.hStdOutput = devnull_stdout ? hNullW : GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = devnull_stderr ? hNullW : GetStdHandle(STD_ERROR_HANDLE);
    }

    BOOL ok = CreateProcessA(
        NULL, cmdline, NULL, NULL, TRUE,
        CREATE_NO_WINDOW, NULL, NULL, &si, &pi);

    free(cmdline);

    if (!ok) {
        LOG_E("plat_spawn: CreateProcess failed for %s (err=%lu)", prog, GetLastError());
        return -1;
    }

    CloseHandle(pi.hThread);
    p->hProcess = pi.hProcess;
    p->dwProcessId = pi.dwProcessId;
    p->exited = 0;
    return 0;
}

int plat_proc_alive(platform_proc_t *p)
{
    if (p->exited || !p->hProcess) return 0;

    DWORD rc = WaitForSingleObject(p->hProcess, 0);
    if (rc == WAIT_TIMEOUT) return 1; /* still running */

    GetExitCodeProcess(p->hProcess, &p->dwExitCode);
    p->exited = 1;
    return 0;
}

int plat_proc_wait(platform_proc_t *p, int timeout_sec)
{
    if (p->exited) return 0;
    if (!p->hProcess) return -1;

    DWORD rc = WaitForSingleObject(p->hProcess, timeout_sec * 1000);
    if (rc == WAIT_OBJECT_0) {
        GetExitCodeProcess(p->hProcess, &p->dwExitCode);
        p->exited = 1;
        return 0;
    }
    return -1; /* timeout */
}

int plat_proc_exit_ok(platform_proc_t *p)
{
    if (!p->exited) return 0;
    return (p->dwExitCode == 0) ? 1 : 0;
}

void plat_proc_terminate(platform_proc_t *p)
{
    if (p->hProcess && !p->exited)
        TerminateProcess(p->hProcess, 1);
}

void plat_proc_kill(platform_proc_t *p)
{
    if (p->hProcess && !p->exited) {
        TerminateProcess(p->hProcess, 1);
        WaitForSingleObject(p->hProcess, 2000);
        GetExitCodeProcess(p->hProcess, &p->dwExitCode);
        CloseHandle(p->hProcess);
        p->hProcess = NULL;
        p->exited = 1;
    }
}

void plat_reap_zombies(void)
{
    /* No-op on Windows: processes are cleaned up via CloseHandle */
}

/* ── Background workers (thread-based) ──────────────────────────── */

typedef struct {
    plat_worker_fn fn;
    void *arg;
} worker_trampoline_t;

static unsigned __stdcall worker_thread_proc(void *param)
{
    worker_trampoline_t *t = (worker_trampoline_t *)param;
    t->fn(t->arg);
    free(t);
    return 0;
}

int plat_worker_start(platform_worker_t *w, plat_worker_fn fn, void *arg)
{
    memset(w, 0, sizeof(*w));

    worker_trampoline_t *t = malloc(sizeof(*t));
    if (!t) return -1;
    t->fn = fn;
    t->arg = arg;

    w->hThread = (HANDLE)_beginthreadex(NULL, 0, worker_thread_proc, t, 0, &w->threadId);
    if (!w->hThread) {
        free(t);
        return -1;
    }
    w->finished = 0;
    return 0;
}

int plat_worker_alive(platform_worker_t *w)
{
    if (w->finished || !w->hThread) return 0;

    DWORD rc = WaitForSingleObject(w->hThread, 0);
    if (rc == WAIT_TIMEOUT) return 1;

    w->finished = 1;
    return 0;
}

void plat_worker_kill(platform_worker_t *w)
{
    if (w->hThread && !w->finished) {
        /* Wait briefly, then terminate if still running */
        if (WaitForSingleObject(w->hThread, 1000) == WAIT_TIMEOUT)
            TerminateThread(w->hThread, 0);
        CloseHandle(w->hThread);
        w->hThread = NULL;
        w->finished = 1;
    }
}

/* ── System info ─────────────────────────────────────────────────── */

int64_t plat_total_ram_mb(void)
{
    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms))
        return (int64_t)(ms.ullTotalPhys / (1024 * 1024));
    return -1;
}

int64_t plat_free_ram_mb(void)
{
    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms))
        return (int64_t)(ms.ullAvailPhys / (1024 * 1024));
    return -1;
}

int64_t plat_uptime_sec(void)
{
    return (int64_t)(GetTickCount64() / 1000);
}

void plat_load_avg(double out[3])
{
    /* No direct equivalent on Windows */
    out[0] = out[1] = out[2] = 0.0;
}

/* ── Disk ────────────────────────────────────────────────────────── */

int64_t plat_disk_free_mb(const char *path)
{
    ULARGE_INTEGER free_bytes, total_bytes, total_free_bytes;

    /* Extract root from path (e.g. "C:\\" from "C:\\Users\\...") */
    char root[MAX_PATH];
    if (path[0] && path[1] == ':') {
        snprintf(root, sizeof(root), "%c:\\", path[0]);
    } else if (path[0] == '/' || path[0] == '.') {
        /* MSYS2/MinGW path — use current drive */
        snprintf(root, sizeof(root), "C:\\");
    } else {
        snprintf(root, sizeof(root), "%s", path);
    }

    if (GetDiskFreeSpaceExA(root, &free_bytes, &total_bytes, &total_free_bytes))
        return (int64_t)(free_bytes.QuadPart / (1024 * 1024));
    return -1;
}

int64_t plat_disk_total_mb(const char *path)
{
    ULARGE_INTEGER free_bytes, total_bytes, total_free_bytes;
    char root[MAX_PATH];
    if (path[0] && path[1] == ':')
        snprintf(root, sizeof(root), "%c:\\", path[0]);
    else
        snprintf(root, sizeof(root), "C:\\");

    if (GetDiskFreeSpaceExA(root, &free_bytes, &total_bytes, &total_free_bytes))
        return (int64_t)(total_bytes.QuadPart / (1024 * 1024));
    return -1;
}

int64_t plat_disk_used_mb(const char *path)
{
    int64_t total = plat_disk_total_mb(path);
    int64_t free_mb = plat_disk_free_mb(path);
    if (total < 0 || free_mb < 0) return -1;
    return total - free_mb;
}

/* ── Drive enumeration ───────────────────────────────────────────── */

int plat_enumerate_drives(plat_drive_info_t *out, int max_drives)
{
    DWORD mask = GetLogicalDrives();
    int count = 0;
    for (int i = 0; i < 26 && count < max_drives; i++) {
        if (!(mask & (1 << i))) continue;
        char root[4];
        snprintf(root, sizeof(root), "%c:\\", 'A' + i);
        UINT dtype = GetDriveTypeA(root);
        if (dtype == DRIVE_NO_ROOT_DIR) continue;

        plat_drive_info_t *d = &out[count];
        memset(d, 0, sizeof(*d));
        d->letter = 'A' + i;
        snprintf(d->path, sizeof(d->path), "%c:\\", 'A' + i);

        switch (dtype) {
            case DRIVE_REMOVABLE: d->drive_type = 2; break;
            case DRIVE_FIXED:     d->drive_type = 3; break;
            case DRIVE_REMOTE:    d->drive_type = 4; break;
            case DRIVE_CDROM:     d->drive_type = 5; break;
            default:              d->drive_type = 0; break;
        }

        /* Volume label and filesystem type */
        char label[64] = "", fstype[32] = "";
        GetVolumeInformationA(root, label, sizeof(label),
                              NULL, NULL, NULL, fstype, sizeof(fstype));
        snprintf(d->label, sizeof(d->label), "%s", label);
        snprintf(d->fstype, sizeof(d->fstype), "%s", fstype);

        /* Disk space */
        ULARGE_INTEGER free_bytes, total_bytes, total_free;
        if (GetDiskFreeSpaceExA(root, &free_bytes, &total_bytes, &total_free)) {
            d->total_mb = (int64_t)(total_bytes.QuadPart / (1024 * 1024));
            d->free_mb  = (int64_t)(free_bytes.QuadPart / (1024 * 1024));
        }
        count++;
    }
    return count;
}

/* ── OS info ─────────────────────────────────────────────────────── */

void plat_get_os_info(plat_os_info_t *info)
{
    memset(info, 0, sizeof(*info));

    /* Hostname */
    DWORD sz = sizeof(info->hostname);
    GetComputerNameA(info->hostname, &sz);

    /* Username */
    sz = sizeof(info->username);
    GetUserNameA(info->username, &sz);

    /* RAM */
    info->total_ram_mb = plat_total_ram_mb();
    info->free_ram_mb  = plat_free_ram_mb();

    /* CPU count */
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    info->cpu_count = (int)si.dwNumberOfProcessors;

    /* OS version from registry */
    HKEY hKey;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
            0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        char product[128] = "";
        DWORD bufsz = sizeof(product);
        DWORD type = REG_SZ;
        RegQueryValueExA(hKey, "ProductName", NULL, &type, (LPBYTE)product, &bufsz);

        char build[32] = "";
        bufsz = sizeof(build);
        RegQueryValueExA(hKey, "CurrentBuildNumber", NULL, &type, (LPBYTE)build, &bufsz);

        char display_ver[32] = "";
        bufsz = sizeof(display_ver);
        RegQueryValueExA(hKey, "DisplayVersion", NULL, &type, (LPBYTE)display_ver, &bufsz);

        DWORD major = 0, minor = 0;
        bufsz = sizeof(DWORD);
        type = REG_DWORD;
        RegQueryValueExA(hKey, "CurrentMajorVersionNumber", NULL, &type, (LPBYTE)&major, &bufsz);
        bufsz = sizeof(DWORD);
        RegQueryValueExA(hKey, "CurrentMinorVersionNumber", NULL, &type, (LPBYTE)&minor, &bufsz);

        snprintf(info->os_name, sizeof(info->os_name), "%s", product);
        snprintf(info->os_version, sizeof(info->os_version), "%lu.%lu.%s", major, minor, build);
        snprintf(info->os_build, sizeof(info->os_build), "%s", build);

        RegCloseKey(hKey);
    }

    /* CPU name from registry */
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
            "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
            0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        DWORD bufsz = sizeof(info->cpu_name);
        DWORD type = REG_SZ;
        RegQueryValueExA(hKey, "ProcessorNameString", NULL, &type,
                         (LPBYTE)info->cpu_name, &bufsz);

        DWORD mhz = 0;
        bufsz = sizeof(DWORD);
        type = REG_DWORD;
        RegQueryValueExA(hKey, "~MHz", NULL, &type, (LPBYTE)&mhz, &bufsz);
        info->cpu_freq_mhz = (int)mhz;

        RegCloseKey(hKey);
    }
}

/* ── File streaming ──────────────────────────────────────────────── */

ssize_t plat_sendfile(int out_sock, int in_fd, size_t count)
{
    /* No zero-copy on Windows — use read+send loop */
    char buf[8192];
    size_t remain = count;
    ssize_t total = 0;
    while (remain > 0) {
        size_t chunk = remain < sizeof(buf) ? remain : sizeof(buf);
        int nr = _read(in_fd, buf, (unsigned int)chunk);
        if (nr <= 0) break;
        int nw = send((SOCKET)out_sock, buf, nr, 0);
        if (nw <= 0) break;
        total += nw;
        remain -= nw;
    }
    return total > 0 ? total : -1;
}

void plat_fadvise_sequential(int fd) { (void)fd; }
void plat_fadvise_noreuse(int fd) { (void)fd; }
void plat_fadvise_dontneed(int fd, int64_t offset, int64_t len)
{
    (void)fd; (void)offset; (void)len;
}

/* ── Networking ──────────────────────────────────────────────────── */

void plat_net_init(void)
{
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
}

void plat_net_cleanup(void)
{
    WSACleanup();
}

int plat_set_nonblock(int fd)
{
    u_long flag = 1;
    return ioctlsocket((SOCKET)fd, FIONBIO, &flag) == 0 ? 0 : -1;
}

int plat_set_blocking(int fd)
{
    u_long flag = 0;
    return ioctlsocket((SOCKET)fd, FIONBIO, &flag) == 0 ? 0 : -1;
}

/* ── Watchdog (no-op on Windows) ─────────────────────────────────── */

int plat_watchdog_open(int timeout_sec)
{
    (void)timeout_sec;
    LOG_I("watchdog: not available on Windows");
    return -1;
}

void plat_watchdog_feed(int fd) { (void)fd; }
void plat_watchdog_close(int fd) { (void)fd; }

/* ── Misc ────────────────────────────────────────────────────────── */

void plat_set_oom_killable(void)
{
    /* No-op on Windows */
}

int plat_ping(const char *ip)
{
    if (!ip || !ip[0]) return 0;
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "ping -n 1 -w 2000 %s >NUL 2>&1", ip);
    return system(cmd) == 0 ? 1 : 0;
}

const char *plat_find_ffmpeg(void)
{
    static char found[MAX_PATH] = {0};

    /* 1. Same directory as the exe */
    char exe_dir[MAX_PATH];
    if (plat_get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
        snprintf(found, sizeof(found), "%s\\ffmpeg.exe", exe_dir);
        if (_access(found, 0) == 0)
            return found;
    }

    /* 2. Current working directory */
    if (_access("ffmpeg.exe", 0) == 0) {
        /* Get full path */
        if (GetFullPathNameA("ffmpeg.exe", sizeof(found), found, NULL))
            return found;
        snprintf(found, sizeof(found), "ffmpeg.exe");
        return found;
    }

    /* 3. Well-known locations */
    static const char *paths[] = {
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        NULL
    };
    for (int i = 0; paths[i]; i++) {
        if (_access(paths[i], 0) == 0) {
            snprintf(found, sizeof(found), "%s", paths[i]);
            return found;
        }
    }

    /* 4. Search PATH via "where" command */
    FILE *f = _popen("where ffmpeg.exe 2>NUL", "r");
    if (f) {
        if (fgets(found, sizeof(found), f)) {
            char *nl = strchr(found, '\n');
            if (nl) *nl = '\0';
            char *cr = strchr(found, '\r');
            if (cr) *cr = '\0';
            _pclose(f);
            if (found[0] && _access(found, 0) == 0)
                return found;
        } else {
            _pclose(f);
        }
    }

    return NULL;
}

int plat_mkdirs(const char *path)
{
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s", path);

    /* Normalize slashes */
    for (char *p = tmp; *p; p++)
        if (*p == '/') *p = '\\';

    for (char *p = tmp + 1; *p; p++) {
        if (*p == '\\') {
            *p = '\0';
            /* Skip drive letter (e.g. C:) */
            if (p - tmp == 2 && tmp[1] == ':') {
                *p = '\\';
                continue;
            }
            _mkdir(tmp);
            *p = '\\';
        }
    }
    int rc = _mkdir(tmp);
    return (rc == 0 || errno == EEXIST) ? 0 : -1;
}

int plat_sleep_ms(int ms)
{
    Sleep(ms);
    return 0;
}

int plat_copy_file(const char *src, const char *dst)
{
    return CopyFileA(src, dst, FALSE) ? 0 : -1;
}

char *plat_get_local_ip(void)
{
    /* Use gethostname + getaddrinfo to find local IP */
    char hostname[256];
    if (gethostname(hostname, sizeof(hostname)) != 0)
        return NULL;

    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(hostname, NULL, &hints, &res) != 0 || !res)
        return NULL;

    char *ip = malloc(64);
    if (!ip) { freeaddrinfo(res); return NULL; }

    struct sockaddr_in *addr = (struct sockaddr_in *)res->ai_addr;
    snprintf(ip, 64, "%s", inet_ntoa(addr->sin_addr));
    freeaddrinfo(res);
    return ip;
}

char *plat_run_cmd(const char *cmd)
{
    FILE *f = _popen(cmd, "r");
    if (!f) return NULL;
    size_t cap = 4096;
    char *buf = malloc(cap);
    if (!buf) { _pclose(f); return NULL; }
    size_t len = 0;
    size_t n;
    while ((n = fread(buf + len, 1, cap - len - 1, f)) > 0) {
        len += n;
        if (len + 1 >= cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) break;
            buf = nb;
        }
    }
    buf[len] = '\0';
    _pclose(f);
    return buf;
}

const char *plat_devnull(void)
{
    return "NUL";
}

int plat_get_link_speed_mbps(const char *iface)
{
    (void)iface;
    /* Use wmic or PowerShell to get link speed */
    char *out = plat_run_cmd(
        "wmic nic where NetEnabled=true get Speed /value 2>NUL");
    if (out && out[0]) {
        char *eq = strstr(out, "Speed=");
        if (eq) {
            long long speed = atoll(eq + 6);
            free(out);
            if (speed > 0) return (int)(speed / 1000000); /* bps to Mbps */
        } else {
            free(out);
        }
    } else {
        free(out);
    }
    return 0;
}

/* ── Directory removal ────────────────────────────────────────────── */

int plat_remove_dir_recursive(const char *path)
{
    char search[MAX_PATH];
    snprintf(search, sizeof(search), "%s\\*", path);

    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA(search, &fd);
    if (h == INVALID_HANDLE_VALUE) return -1;

    do {
        if (fd.cFileName[0] == '.' &&
            (fd.cFileName[1] == '\0' ||
             (fd.cFileName[1] == '.' && fd.cFileName[2] == '\0')))
            continue;

        char child[MAX_PATH];
        snprintf(child, sizeof(child), "%s\\%s", path, fd.cFileName);

        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            plat_remove_dir_recursive(child);
        else
            DeleteFileA(child);
    } while (FindNextFileA(h, &fd));

    FindClose(h);
    return RemoveDirectoryA(path) ? 0 : -1;
}

/* ── Exe directory ───────────────────────────────────────────────── */

int plat_get_exe_dir(char *buf, size_t len)
{
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(NULL, path, sizeof(path));
    if (n == 0 || n >= sizeof(path)) return -1;

    /* Strip filename to get directory */
    char *last = strrchr(path, '\\');
    if (!last) last = strrchr(path, '/');
    if (last) *last = '\0';

    snprintf(buf, len, "%s", path);
    return 0;
}

void plat_console_init(void)
{
    /* Enable ANSI escape processing on Windows 10+ */
    HANDLE hOut = GetStdHandle(STD_ERROR_HANDLE);
    if (hOut != INVALID_HANDLE_VALUE) {
        DWORD mode = 0;
        if (GetConsoleMode(hOut, &mode)) {
            mode |= 0x0004; /* ENABLE_VIRTUAL_TERMINAL_PROCESSING */
            SetConsoleMode(hOut, mode);
        }
    }
}

#endif /* _WIN32 */
