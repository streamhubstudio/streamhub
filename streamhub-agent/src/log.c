#include "log.h"
#include "platform.h"
#include <stdio.h>
#include <stdarg.h>
#include <time.h>
#include <string.h>

#ifdef PLAT_POSIX
  #include <sys/stat.h>
  #include <unistd.h>
#endif

static log_level_t g_min_level = LOG_INFO;
static const char *g_ident     = "agent";

/* File-based logging (Windows service mode) */
static FILE *g_log_file = NULL;
static char  g_log_path[260] = {0};

/* Optional callback (e.g. MQTT forwarding) */
static log_callback_fn g_callback = NULL;
static void           *g_callback_ctx = NULL;
static int             g_in_callback = 0; /* recursion guard */

static const char *level_str[] = {
    "DEBUG", "INFO", "WARN", "ERROR", "FATAL"
};

static const char *level_color[] = {
    "\033[36m", "\033[32m", "\033[33m", "\033[31m", "\033[35m"
};

void log_init(const char *ident, log_level_t min_level)
{
    g_ident    = ident;
    g_min_level = min_level;
    plat_console_init();
}

void log_init_file(const char *path)
{
    if (g_log_file) {
        fclose(g_log_file);
        g_log_file = NULL;
    }
    snprintf(g_log_path, sizeof(g_log_path), "%s", path);
    g_log_file = fopen(path, "a");
    if (g_log_file)
        setvbuf(g_log_file, NULL, _IOLBF, 0); /* line-buffered */
}

void log_close_file(void)
{
    if (g_log_file) {
        fclose(g_log_file);
        g_log_file = NULL;
    }
    g_log_path[0] = '\0';
}

void log_msg(log_level_t level, const char *fmt, ...)
{
    if (level < g_min_level)
        return;

    time_t    t  = time(NULL);
    struct tm tm_buf;
#ifdef _WIN32
    struct tm *tm = localtime(&t);
    tm_buf = *tm;
#else
    localtime_r(&t, &tm_buf);
#endif
    char ts[20];
    strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &tm_buf);

    /* Always write to stderr with ANSI colors */
    fprintf(stderr, "%s %s%-5s\033[0m [%s] ",
            ts, level_color[level], level_str[level], g_ident);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);

    /* Also write to log file (no ANSI colors) */
    if (g_log_file) {
        fprintf(g_log_file, "%s %-5s [%s] ", ts, level_str[level], g_ident);
        va_list ap2;
        va_start(ap2, fmt);
        vfprintf(g_log_file, fmt, ap2);
        va_end(ap2);
        fputc('\n', g_log_file);
    }

    /* Forward to callback (recursion-safe) */
    if (g_callback && !g_in_callback) {
        char msg[512];
        int pos = snprintf(msg, sizeof(msg), "%s %-5s ", ts, level_str[level]);
        va_list ap3;
        va_start(ap3, fmt);
        vsnprintf(msg + pos, sizeof(msg) - pos, fmt, ap3);
        va_end(ap3);

        g_in_callback = 1;
        g_callback(level, msg, g_callback_ctx);
        g_in_callback = 0;
    }
}

void log_set_callback(log_callback_fn cb, void *ctx)
{
    g_callback = cb;
    g_callback_ctx = ctx;
}

#define LOG_MAX_SIZE  (1024 * 1024)  /* 1 MB */

void log_rotate(void)
{
#ifdef PLAT_WINDOWS
    if (g_log_file && g_log_path[0]) {
        /* Check file size */
        long pos = ftell(g_log_file);
        if (pos < 0) {
            fseek(g_log_file, 0, SEEK_END);
            pos = ftell(g_log_file);
        }
        if (pos > LOG_MAX_SIZE) {
            fclose(g_log_file);
            /* Rename current to .old */
            char old_path[264];
            snprintf(old_path, sizeof(old_path), "%s.old", g_log_path);
            remove(old_path);
            rename(g_log_path, old_path);
            /* Reopen fresh */
            g_log_file = fopen(g_log_path, "a");
            if (g_log_file)
                setvbuf(g_log_file, NULL, _IOLBF, 0);
        }
    }
#else
    struct stat st;
    int fd = fileno(stderr);
    if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
        if (st.st_size > LOG_MAX_SIZE) {
            ftruncate(fd, 0);
            lseek(fd, 0, SEEK_SET);
        }
    }
#endif
}
