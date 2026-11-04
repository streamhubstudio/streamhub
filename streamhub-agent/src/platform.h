#ifndef AGENT_PLATFORM_H
#define AGENT_PLATFORM_H

/*
 * Platform abstraction layer for streamhub-agent.
 *
 * Provides a unified API for POSIX and Windows, covering:
 *   - Process management (spawn/kill/wait)
 *   - Background workers (fork on POSIX, threads on Windows)
 *   - Socket I/O compatibility
 *   - System info (RAM, uptime, load, disk)
 *   - File streaming (sendfile, fadvise)
 *   - Signals
 *   - Watchdog (embedded only)
 *   - Misc (ping, ffmpeg, mkdirs, sleep)
 */

#include <stdint.h>
#include <stddef.h>

/* ── Platform detection ──────────────────────────────────────────── */
#ifdef _WIN32
  #define PLAT_WINDOWS 1
#else
  #define PLAT_POSIX 1
#endif

/* ── Common includes ─────────────────────────────────────────────── */
#ifdef PLAT_WINDOWS
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  #include <io.h>
  #include <direct.h>
  #include <process.h>

  /* poll compat: WSAPoll has same signature as poll.
   * POLLIN/POLLOUT/POLLERR/POLLHUP already defined by winsock2.h */
  #define poll WSAPoll

  /* ssize_t not defined on MSVC/MinGW sometimes */
  #ifndef _SSIZE_T_DEFINED
    #ifdef _WIN64
      typedef long long ssize_t;
    #else
      typedef long ssize_t;
    #endif
    #define _SSIZE_T_DEFINED
  #endif

  /* POSIX compat for file I/O */
  #ifndef O_RDONLY
    #include <fcntl.h>
  #endif
  #include <sys/stat.h>
  #include <sys/types.h>

  /* Suppress deprecated warnings for POSIX names */
  #ifndef _CRT_NONSTDC_NO_DEPRECATE
    #define _CRT_NONSTDC_NO_DEPRECATE
  #endif

  /* access() mode flags */
  #ifndef F_OK
    #define F_OK 0
  #endif
  #ifndef X_OK
    #define X_OK 0  /* Windows doesn't distinguish X_OK, use F_OK */
  #endif

  /* socklen_t */
  #ifndef socklen_t
    typedef int socklen_t;
  #endif

#else /* PLAT_POSIX */
  #include <unistd.h>
  #include <fcntl.h>
  #include <signal.h>
  #include <errno.h>
  #include <sys/types.h>
  #include <sys/socket.h>
  #include <sys/stat.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <netdb.h>
  #include <poll.h>
  #include <pthread.h>

  /* O_BINARY is Windows-only; define as no-op on POSIX */
  #ifndef O_BINARY
    #define O_BINARY 0
  #endif
#endif

/* ── Socket compatibility macros ─────────────────────────────────── */
#ifdef PLAT_WINDOWS
  #define sock_read(fd,b,l)  recv((fd),(char*)(b),(int)(l),0)
  #define sock_write(fd,b,l) send((fd),(const char*)(b),(int)(l),0)
  #define sock_close(fd)     closesocket(fd)
  #define sock_errno         WSAGetLastError()
  #define SOCK_EAGAIN        WSAEWOULDBLOCK
  #define SOCK_EINPROGRESS   WSAEWOULDBLOCK
  typedef SOCKET sock_t;
  #define INVALID_SOCK       INVALID_SOCKET
#else
  #define sock_read(fd,b,l)  read((fd),(b),(l))
  #define sock_write(fd,b,l) write((fd),(b),(l))
  #define sock_close(fd)     close(fd)
  #define sock_errno         errno
  #define SOCK_EAGAIN        EAGAIN
  #define SOCK_EINPROGRESS   EINPROGRESS
  typedef int sock_t;
  #define INVALID_SOCK       (-1)
#endif

/* ── Process management ──────────────────────────────────────────── */

typedef struct {
#ifdef PLAT_WINDOWS
    HANDLE hProcess;
    DWORD  dwProcessId;
    DWORD  dwExitCode;
#else
    pid_t  pid;
    int    exit_status;
#endif
    int    exited;
} platform_proc_t;

int  plat_spawn(platform_proc_t *p, const char *prog, char *const argv[],
                int devnull_stdout, int devnull_stderr);
int  plat_proc_alive(platform_proc_t *p);      /* 1=alive, 0=exited */
int  plat_proc_wait(platform_proc_t *p, int timeout_sec);  /* 0=exited, -1=timeout/fail */
int  plat_proc_exit_ok(platform_proc_t *p);    /* 1=success exit, 0=fail */
void plat_proc_terminate(platform_proc_t *p);  /* SIGTERM / TerminateProcess */
void plat_proc_kill(platform_proc_t *p);       /* SIGKILL / TerminateProcess */
void plat_reap_zombies(void);                  /* waitpid(-1) to clean up zombie children */

/* ── Background worker (fork on POSIX, thread on Windows) ────────── */

typedef void (*plat_worker_fn)(void *arg);

typedef struct {
#ifdef PLAT_WINDOWS
    HANDLE hThread;
    unsigned threadId;
#else
    pthread_t thread;
    int       started;
#endif
    int finished;
} platform_worker_t;

int  plat_worker_start(platform_worker_t *w, plat_worker_fn fn, void *arg);
int  plat_worker_alive(platform_worker_t *w);  /* 1=alive, 0=finished */
void plat_worker_kill(platform_worker_t *w);

/* ── System info ─────────────────────────────────────────────────── */

int64_t plat_total_ram_mb(void);
int64_t plat_free_ram_mb(void);
int64_t plat_uptime_sec(void);
void    plat_load_avg(double out[3]);

/* ── Disk ────────────────────────────────────────────────────────── */

int64_t plat_disk_free_mb(const char *path);
int64_t plat_disk_total_mb(const char *path);
int64_t plat_disk_used_mb(const char *path);

/* Drive enumeration (Windows: C:\, D:\ etc.  POSIX: returns "/" only) */
typedef struct {
    char letter;        /* 'C', 'D', etc. (Windows) or '/' (POSIX) */
    char path[8];       /* "C:\\" or "/" */
    char label[64];     /* volume label (Windows) or "root" */
    char fstype[32];    /* "NTFS", "ext4", etc. */
    int64_t total_mb;
    int64_t free_mb;
    int  drive_type;    /* 0=unknown, 2=removable, 3=fixed, 4=network, 5=cdrom */
} plat_drive_info_t;

int plat_enumerate_drives(plat_drive_info_t *out, int max_drives);

/* ── Windows OS info ─────────────────────────────────────────────── */

typedef struct {
    char os_name[64];       /* "Windows 10 Pro", "Windows 11 Home", etc. */
    char os_version[32];    /* "10.0.19045" */
    char os_build[32];      /* "19045" */
    char hostname[128];
    char username[64];
    int  cpu_count;         /* logical processor count */
    char cpu_name[128];     /* "Intel Core i7-..." or "AMD Ryzen..." */
    int  cpu_freq_mhz;     /* max frequency */
    int64_t total_ram_mb;
    int64_t free_ram_mb;
} plat_os_info_t;

void plat_get_os_info(plat_os_info_t *info);

/* ── File streaming ──────────────────────────────────────────────── */

ssize_t plat_sendfile(int out_sock, int in_fd, size_t count);
void    plat_fadvise_sequential(int fd);
void    plat_fadvise_noreuse(int fd);
void    plat_fadvise_dontneed(int fd, int64_t offset, int64_t len);

/* ── Networking init ─────────────────────────────────────────────── */

void plat_net_init(void);       /* WSAStartup on Windows, no-op on POSIX */
void plat_net_cleanup(void);
int  plat_set_nonblock(int fd);
int  plat_set_blocking(int fd);

/* ── Signals / exit control ──────────────────────────────────────── */

void plat_signal_init(void);
int  plat_should_exit(void);    /* returns 1 if shutdown requested */
void plat_request_exit(void);   /* request shutdown */

/* ── Watchdog (embedded only, no-op on desktop) ──────────────────── */

int  plat_watchdog_open(int timeout_sec);
void plat_watchdog_feed(int fd);
void plat_watchdog_close(int fd);

/* ── Misc ────────────────────────────────────────────────────────── */

void plat_set_oom_killable(void);  /* no-op on non-Linux */
int  plat_ping(const char *ip);
const char *plat_find_ffmpeg(void);
int  plat_mkdirs(const char *path);
int  plat_sleep_ms(int ms);
int  plat_copy_file(const char *src, const char *dst);
char *plat_get_local_ip(void);     /* returns malloc'd string or NULL */
char *plat_run_cmd(const char *cmd); /* popen wrapper */
const char *plat_devnull(void);    /* "/dev/null" or "NUL" */
int  plat_get_link_speed_mbps(const char *iface);  /* negotiated link speed, 0 on failure */

/* ── Directory removal ────────────────────────────────────────────── */

int plat_remove_dir_recursive(const char *path);  /* rm -rf equivalent */

/* ── Exe directory ───────────────────────────────────────────────── */

int plat_get_exe_dir(char *buf, size_t len);  /* directory containing the exe */

/* ── Console / terminal ──────────────────────────────────────────── */

void plat_console_init(void);   /* Enable ANSI on Windows, no-op on POSIX */

#endif /* AGENT_PLATFORM_H */
