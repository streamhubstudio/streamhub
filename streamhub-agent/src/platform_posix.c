/*
 * Platform abstraction — POSIX implementation
 *
 * Covers Linux (Luckfox embedded + desktop) and macOS.
 * Extracts fork/exec, sysinfo, statvfs, sendfile, signals, watchdog
 * into the platform_* API.
 */

#ifdef _WIN32
/* This file is not compiled on Windows */
#else

#include "platform.h"
#include "log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <time.h>
#include <dirent.h>
#include <pthread.h>
#include <spawn.h>

#ifdef __linux__
  #include <sys/sysinfo.h>
  #include <sys/statvfs.h>
  #include <sys/sendfile.h>
  #include <sys/ioctl.h>
  /* watchdog only on Linux with the header available */
  #if __has_include(<linux/watchdog.h>)
    #include <linux/watchdog.h>
    #define HAVE_LINUX_WATCHDOG 1
  #endif
#elif defined(__APPLE__)
  #include <sys/sysctl.h>
  #include <sys/statvfs.h>
  #include <mach/mach.h>
  #include <mach-o/dyld.h>
#endif

/* ── Signal handling ─────────────────────────────────────────────── */

static volatile sig_atomic_t g_exit_requested = 0;

static void posix_signal_handler(int sig)
{
    (void)sig;
    g_exit_requested = 1;
}

void plat_signal_init(void)
{
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = posix_signal_handler;
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
}

int plat_should_exit(void)
{
    return g_exit_requested != 0;
}

void plat_request_exit(void)
{
    g_exit_requested = 1;
}

/* ── Process management (posix_spawn — avoids fork address-space copy) ── */

extern char **environ;

int plat_spawn(platform_proc_t *p, const char *prog, char *const argv[],
               int devnull_stdout, int devnull_stderr)
{
    memset(p, 0, sizeof(*p));

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);

    if (devnull_stdout)
        posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO,
                                         "/dev/null", O_WRONLY, 0);
    if (devnull_stderr)
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO,
                                         "/dev/null", O_WRONLY, 0);

    pid_t pid;
    int rc = posix_spawnp(&pid, prog, &actions, NULL, argv, environ);
    posix_spawn_file_actions_destroy(&actions);

    if (rc != 0) return -1;

    /* Set OOM score from parent (child can't do it via posix_spawn) */
#ifdef __linux__
    {
        char oom_path[64];
        snprintf(oom_path, sizeof(oom_path), "/proc/%d/oom_score_adj", (int)pid);
        int ofd = open(oom_path, O_WRONLY);
        if (ofd >= 0) {
            write(ofd, "1000", 4);
            close(ofd);
        }
    }
#endif

    p->pid = pid;
    p->exited = 0;
    return 0;
}

int plat_proc_alive(platform_proc_t *p)
{
    if (p->exited || p->pid <= 0) return 0;

    int status;
    pid_t r = waitpid(p->pid, &status, WNOHANG);
    if (r == 0) return 1;  /* still running */

    /* r > 0: exited normally; r < 0 (ECHILD): already reaped */
    p->exited = 1;
    p->exit_status = (r > 0) ? status : 0;
    return 0;
}

int plat_proc_wait(platform_proc_t *p, int timeout_sec)
{
    if (p->exited) return 0;
    if (p->pid <= 0) return -1;

    time_t deadline = time(NULL) + timeout_sec;
    while (time(NULL) < deadline) {
        int status;
        pid_t r = waitpid(p->pid, &status, WNOHANG);
        if (r > 0) {
            p->exited = 1;
            p->exit_status = status;
            return 0;
        }
        if (r < 0) {
            /* ECHILD: already reaped by plat_reap_zombies() */
            p->exited = 1;
            p->exit_status = 0;
            return 0;
        }
        usleep(200000); /* 200ms */
    }
    return -1; /* timeout */
}

int plat_proc_exit_ok(platform_proc_t *p)
{
    if (!p->exited) return 0;
    return (WIFEXITED(p->exit_status) && WEXITSTATUS(p->exit_status) == 0) ? 1 : 0;
}

void plat_proc_terminate(platform_proc_t *p)
{
    if (p->pid > 0 && !p->exited)
        kill(p->pid, SIGTERM);
}

void plat_proc_kill(platform_proc_t *p)
{
    if (p->pid > 0 && !p->exited) {
        kill(p->pid, SIGKILL);
        /* Block until reaped (avoids zombie from race with WNOHANG) */
        int status;
        pid_t r = waitpid(p->pid, &status, 0);
        p->exited = 1;
        p->exit_status = (r > 0) ? status : 0;
    }
}

void plat_reap_zombies(void)
{
    int status;
    while (waitpid(-1, &status, WNOHANG) > 0)
        ;
}

/* ── Background workers (pthread-based — avoids fork address-space duplication) ── */

typedef struct {
    plat_worker_fn    fn;
    void             *arg;
    platform_worker_t *worker;
} worker_trampoline_t;

static void *worker_thread_fn(void *param)
{
    worker_trampoline_t t = *(worker_trampoline_t *)param;
    free(param);
    t.fn(t.arg);
    t.worker->finished = 1;
    return NULL;
}

int plat_worker_start(platform_worker_t *w, plat_worker_fn fn, void *arg)
{
    memset(w, 0, sizeof(*w));

    worker_trampoline_t *t = malloc(sizeof(*t));
    if (!t) return -1;
    t->fn     = fn;
    t->arg    = arg;
    t->worker = w;

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 256 * 1024);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

    int rc = pthread_create(&w->thread, &attr, worker_thread_fn, t);
    pthread_attr_destroy(&attr);

    if (rc != 0) {
        free(t);
        return -1;
    }

    w->started  = 1;
    w->finished = 0;
    return 0;
}

int plat_worker_alive(platform_worker_t *w)
{
    if (!w->started || w->finished) return 0;
    return 1;  /* thread sets finished=1 when done */
}

void plat_worker_kill(platform_worker_t *w)
{
    if (!w->started || w->finished) return;
    pthread_cancel(w->thread);
    w->finished = 1;
}

/* ── System info ─────────────────────────────────────────────────── */

#ifdef __linux__
int64_t plat_total_ram_mb(void)
{
    struct sysinfo si;
    if (sysinfo(&si) != 0) return -1;
    return (int64_t)si.totalram * si.mem_unit / (1024 * 1024);
}

int64_t plat_free_ram_mb(void)
{
    struct sysinfo si;
    if (sysinfo(&si) != 0) return -1;
    return (int64_t)si.freeram * si.mem_unit / (1024 * 1024);
}

int64_t plat_uptime_sec(void)
{
    struct sysinfo si;
    if (sysinfo(&si) != 0) return -1;
    return (int64_t)si.uptime;
}

void plat_load_avg(double out[3])
{
    struct sysinfo si;
    if (sysinfo(&si) == 0) {
        out[0] = si.loads[0] / 65536.0;
        out[1] = si.loads[1] / 65536.0;
        out[2] = si.loads[2] / 65536.0;
    } else {
        out[0] = out[1] = out[2] = 0.0;
    }
}
#elif defined(__APPLE__)
int64_t plat_total_ram_mb(void)
{
    int64_t memsize;
    size_t len = sizeof(memsize);
    if (sysctlbyname("hw.memsize", &memsize, &len, NULL, 0) == 0)
        return memsize / (1024 * 1024);
    return -1;
}

int64_t plat_free_ram_mb(void)
{
    /* Approximate: use vm_statistics */
    mach_port_t host = mach_host_self();
    vm_statistics64_data_t vm;
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    if (host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm, &count) == KERN_SUCCESS) {
        int64_t page_size = sysconf(_SC_PAGESIZE);
        return (int64_t)vm.free_count * page_size / (1024 * 1024);
    }
    return -1;
}

int64_t plat_uptime_sec(void)
{
    struct timeval boottime;
    size_t len = sizeof(boottime);
    int mib[2] = { CTL_KERN, KERN_BOOTTIME };
    if (sysctl(mib, 2, &boottime, &len, NULL, 0) == 0) {
        struct timeval now;
        gettimeofday(&now, NULL);
        return (int64_t)(now.tv_sec - boottime.tv_sec);
    }
    return -1;
}

void plat_load_avg(double out[3])
{
    double loadavg[3];
    if (getloadavg(loadavg, 3) == 3) {
        out[0] = loadavg[0];
        out[1] = loadavg[1];
        out[2] = loadavg[2];
    } else {
        out[0] = out[1] = out[2] = 0.0;
    }
}
#endif

/* ── Disk ────────────────────────────────────────────────────────── */

int64_t plat_disk_free_mb(const char *path)
{
    struct statvfs st;
    if (statvfs(path, &st) != 0) return -1;
    return (int64_t)st.f_bavail * st.f_frsize / (1024 * 1024);
}

int64_t plat_disk_total_mb(const char *path)
{
    struct statvfs st;
    if (statvfs(path, &st) != 0) return -1;
    return (int64_t)st.f_blocks * st.f_frsize / (1024 * 1024);
}

int64_t plat_disk_used_mb(const char *path)
{
    struct statvfs st;
    if (statvfs(path, &st) != 0) return -1;
    int64_t total = (int64_t)st.f_blocks * st.f_frsize;
    int64_t avail = (int64_t)st.f_bavail * st.f_frsize;
    return (total - avail) / (1024 * 1024);
}

/* ── Drive enumeration (POSIX: single root) ──────────────────────── */

int plat_enumerate_drives(plat_drive_info_t *out, int max_drives)
{
    if (max_drives < 1) return 0;
    memset(&out[0], 0, sizeof(out[0]));
    out[0].letter = '/';
    snprintf(out[0].path, sizeof(out[0].path), "/");
    snprintf(out[0].label, sizeof(out[0].label), "root");
    struct statvfs st;
    if (statvfs("/", &st) == 0) {
        out[0].total_mb = (int64_t)st.f_blocks * st.f_frsize / (1024 * 1024);
        out[0].free_mb  = (int64_t)st.f_bavail * st.f_frsize / (1024 * 1024);
    }
    out[0].drive_type = 3; /* fixed */
    return 1;
}

/* ── OS info (POSIX) ─────────────────────────────────────────────── */

void plat_get_os_info(plat_os_info_t *info)
{
    memset(info, 0, sizeof(*info));
    struct utsname un;
    if (uname(&un) == 0) {
        snprintf(info->os_name, sizeof(info->os_name), "%s", un.sysname);
        snprintf(info->os_version, sizeof(info->os_version), "%s", un.release);
        snprintf(info->hostname, sizeof(info->hostname), "%s", un.nodename);
    }
#ifdef __linux__
    /* CPU count */
    info->cpu_count = (int)sysconf(_SC_NPROCESSORS_ONLN);
    /* CPU name from /proc/cpuinfo */
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (f) {
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            if (strncmp(line, "model name", 10) == 0) {
                char *p = strchr(line, ':');
                if (p) {
                    p++;
                    while (*p == ' ') p++;
                    size_t len = strlen(p);
                    while (len > 0 && (p[len-1] == '\n' || p[len-1] == '\r'))
                        p[--len] = '\0';
                    snprintf(info->cpu_name, sizeof(info->cpu_name), "%s", p);
                }
                break;
            }
        }
        fclose(f);
    }
#endif
#ifdef __APPLE__
    info->cpu_count = (int)sysconf(_SC_NPROCESSORS_ONLN);
#endif
    info->total_ram_mb = plat_total_ram_mb();
    info->free_ram_mb  = plat_free_ram_mb();
}

/* ── File streaming ──────────────────────────────────────────────── */

ssize_t plat_sendfile(int out_sock, int in_fd, size_t count)
{
#ifdef __linux__
    return sendfile(out_sock, in_fd, NULL, count);
#else
    /* Fallback: read + write loop */
    char buf[4096];
    size_t remain = count;
    ssize_t total = 0;
    while (remain > 0) {
        size_t chunk = remain < sizeof(buf) ? remain : sizeof(buf);
        ssize_t nr = read(in_fd, buf, chunk);
        if (nr <= 0) break;
        ssize_t nw = write(out_sock, buf, nr);
        if (nw <= 0) break;
        total += nw;
        remain -= nw;
    }
    return total > 0 ? total : -1;
#endif
}

void plat_fadvise_sequential(int fd)
{
#ifdef __linux__
    posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#else
    (void)fd;
#endif
}

void plat_fadvise_noreuse(int fd)
{
#ifdef __linux__
    posix_fadvise(fd, 0, 0, POSIX_FADV_NOREUSE);
#else
    (void)fd;
#endif
}

void plat_fadvise_dontneed(int fd, int64_t offset, int64_t len)
{
#ifdef __linux__
    posix_fadvise(fd, offset, len, POSIX_FADV_DONTNEED);
#else
    (void)fd; (void)offset; (void)len;
#endif
}

/* ── Networking ──────────────────────────────────────────────────── */

void plat_net_init(void)
{
    /* No-op on POSIX */
}

void plat_net_cleanup(void)
{
    /* No-op on POSIX */
}

int plat_set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int plat_set_blocking(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
}

/* ── Watchdog ────────────────────────────────────────────────────── */

int plat_watchdog_open(int timeout_sec)
{
#if defined(HAVE_LINUX_WATCHDOG)
    int fd = open("/dev/watchdog", O_WRONLY);
    if (fd < 0) {
        LOG_W("watchdog: cannot open /dev/watchdog (running without hw watchdog)");
        return -1;
    }

    if (ioctl(fd, WDIOC_SETTIMEOUT, &timeout_sec) != 0)
        LOG_W("watchdog: failed to set timeout to %ds", timeout_sec);

    int actual = 0;
    if (ioctl(fd, WDIOC_GETTIMEOUT, &actual) == 0)
        LOG_I("watchdog: opened with %ds timeout", actual);

    return fd;
#else
    (void)timeout_sec;
    LOG_I("watchdog: not available on this platform");
    return -1;
#endif
}

void plat_watchdog_feed(int fd)
{
    if (fd >= 0)
        write(fd, "1", 1);
}

void plat_watchdog_close(int fd)
{
    if (fd >= 0) {
        write(fd, "V", 1);
        close(fd);
        LOG_I("watchdog: closed gracefully");
    }
}

/* ── Misc ────────────────────────────────────────────────────────── */

void plat_set_oom_killable(void)
{
#ifdef __linux__
    int ofd = open("/proc/self/oom_score_adj", O_WRONLY);
    if (ofd >= 0) {
        write(ofd, "1000", 4);
        close(ofd);
    }
#endif
}

int plat_ping(const char *ip)
{
    if (!ip || !ip[0]) return 0;
    char cmd[128];
#ifdef __APPLE__
    snprintf(cmd, sizeof(cmd), "ping -c1 -W2 %s >/dev/null 2>&1", ip);
#else
    snprintf(cmd, sizeof(cmd), "ping -c1 -W2 %s >/dev/null 2>&1", ip);
#endif
    return system(cmd) == 0 ? 1 : 0;
}

const char *plat_find_ffmpeg(void)
{
    static const char *paths[] = {
        "/mnt/sdcard/ffmpeg",
        "/usr/bin/ffmpeg",
        "/oem/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        NULL
    };
    for (int i = 0; paths[i]; i++) {
        if (access(paths[i], X_OK) == 0)
            return paths[i];
    }
    return NULL;
}

int plat_mkdirs(const char *path)
{
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s", path);

    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }
    return (mkdir(tmp, 0755) == 0 || errno == EEXIST) ? 0 : -1;
}

int plat_sleep_ms(int ms)
{
    usleep(ms * 1000);
    return 0;
}

int plat_copy_file(const char *src, const char *dst)
{
    FILE *in = fopen(src, "rb");
    if (!in) return -1;
    FILE *out = fopen(dst, "wb");
    if (!out) { fclose(in); return -1; }

    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0)
        fwrite(buf, 1, n, out);

    fclose(in);
    fclose(out);
    return 0;
}

char *plat_get_local_ip(void)
{
    FILE *f = popen("hostname -I 2>/dev/null || "
                     "ifconfig eth0 2>/dev/null | grep 'inet ' | awk '{print $2}'", "r");
    if (!f) return NULL;
    char *ip = malloc(64);
    if (!ip) { pclose(f); return NULL; }
    ip[0] = '\0';
    if (fgets(ip, 64, f)) {
        char *nl = strchr(ip, '\n');
        if (nl) *nl = '\0';
        char *sp = strchr(ip, ' ');
        if (sp) *sp = '\0';
    }
    pclose(f);
    return ip;
}

char *plat_run_cmd(const char *cmd)
{
    FILE *f = popen(cmd, "r");
    if (!f) return NULL;
    size_t cap = 4096;
    char *buf = malloc(cap);
    if (!buf) { pclose(f); return NULL; }
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
    pclose(f);
    return buf;
}

const char *plat_devnull(void)
{
    return "/dev/null";
}

int plat_get_link_speed_mbps(const char *iface)
{
    if (!iface || !iface[0]) iface = "eth0";
#ifdef __linux__
    /* Try /sys/class/net/<iface>/speed */
    char path[128];
    snprintf(path, sizeof(path), "/sys/class/net/%s/speed", iface);
    FILE *f = fopen(path, "r");
    if (f) {
        int speed = 0;
        if (fscanf(f, "%d", &speed) == 1 && speed > 0) {
            fclose(f);
            return speed;
        }
        fclose(f);
    }
    /* Fallback: parse MII PHY register 0 (Control Register)
     * Speed encoding: bit6=0,bit13=0 → 10M; bit6=0,bit13=1 → 100M; bit6=1 → 1000M */
    snprintf(path, sizeof(path), "/sys/class/net/%s/phydev/phy_registers", iface);
    f = fopen(path, "r");
    if (f) {
        unsigned int reg0 = 0;
        if (fscanf(f, " 0: 0x%x", &reg0) == 1) {
            fclose(f);
            int bit13 = (reg0 >> 13) & 1;
            int bit6  = (reg0 >> 6)  & 1;
            if (bit6)  return 1000;
            if (bit13) return 100;
            return 10;
        }
        fclose(f);
    }
    /* Fallback: parse dmesg for PHY link speed */
    char cmd[256];
    snprintf(cmd, sizeof(cmd),
        "dmesg 2>/dev/null | grep -oE '[0-9]+Mbps' | tail -1");
    char *out = plat_run_cmd(cmd);
    if (out && out[0]) {
        int speed = atoi(out);
        free(out);
        if (speed > 0) return speed;
    }
    free(out);
#else
    (void)iface;
#endif
    return 0;
}

/* ── Directory removal ────────────────────────────────────────────── */

int plat_remove_dir_recursive(const char *path)
{
    DIR *d = opendir(path);
    if (!d) return -1;

    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.' &&
            (ent->d_name[1] == '\0' ||
             (ent->d_name[1] == '.' && ent->d_name[2] == '\0')))
            continue;

        char child[4096];
        snprintf(child, sizeof(child), "%s/%s", path, ent->d_name);

        struct stat st;
        if (stat(child, &st) == 0 && S_ISDIR(st.st_mode))
            plat_remove_dir_recursive(child);
        else
            unlink(child);
    }
    closedir(d);
    return rmdir(path) == 0 ? 0 : -1;
}

/* ── Exe directory ───────────────────────────────────────────────── */

int plat_get_exe_dir(char *buf, size_t len)
{
#ifdef __linux__
    char path[4096];
    ssize_t n = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (n <= 0) return -1;
    path[n] = '\0';
    char *last = strrchr(path, '/');
    if (last) *last = '\0';
    snprintf(buf, len, "%s", path);
    return 0;
#elif defined(__APPLE__)
    char path[4096];
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) != 0) return -1;
    char *last = strrchr(path, '/');
    if (last) *last = '\0';
    snprintf(buf, len, "%s", path);
    return 0;
#else
    (void)buf; (void)len;
    return -1;
#endif
}

void plat_console_init(void)
{
    /* No-op on POSIX — terminals support ANSI natively */
}

#endif /* !_WIN32 */
