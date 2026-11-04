#include "sync.h"
#include "log.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>

/* ── Marker files ─────────────────────────────────────────────────── */

int sync_is_uploaded(const char *mp4_path)
{
    char marker[1024];
    snprintf(marker, sizeof(marker), "%s.uploaded", mp4_path);
    return file_exists(marker);
}

static void create_marker(const char *mp4_path)
{
    char marker[1024];
    snprintf(marker, sizeof(marker), "%s.uploaded", mp4_path);
    FILE *f = fopen(marker, "w");
    if (f) fclose(f);
}

/* ── sync.log append ──────────────────────────────────────────────── */

static void sync_log_append(const char *record_base, const char *status,
                            const char *relpath, int64_t size,
                            const char *error)
{
    char logpath[1024];
    snprintf(logpath, sizeof(logpath), "%s/sync.log", record_base);

    FILE *f = fopen(logpath, "a");
    if (!f) return;

    char ts[32];
    now_iso8601(ts, sizeof(ts));
    /* Trim the 'T' ISO format to space-separated for readability */
    char *t = strchr(ts, 'T');
    if (t) *t = ' ';
    /* Trim fractional seconds / timezone */
    if (strlen(ts) > 19) ts[19] = '\0';

    if (error && error[0])
        fprintf(f, "%s\t%s\t%s\t%lld\t%s\n",
                ts, status, relpath, (long long)size, error);
    else
        fprintf(f, "%s\t%s\t%s\t%lld\n",
                ts, status, relpath, (long long)size);

    fclose(f);
}

void sync_mark_uploaded(const char *record_base,
                        const char *relpath, int64_t size)
{
    /* Build full path from record_base + relpath to create marker */
    char full[1024];
    snprintf(full, sizeof(full), "%s/%s", record_base, relpath);
    create_marker(full);

    sync_log_append(record_base, "OK", relpath, size, NULL);
}

void sync_mark_failed(const char *record_base,
                      const char *relpath, int64_t size,
                      const char *error)
{
    sync_log_append(record_base, "FAIL", relpath, size, error);
}

/* ── sync.log rotation ────────────────────────────────────────────── */

void sync_init(const char *record_base, int max_days)
{
    char logpath[1024];
    snprintf(logpath, sizeof(logpath), "%s/sync.log", record_base);

    FILE *f = fopen(logpath, "r");
    if (!f) return;   /* no log yet, nothing to rotate */

    /* Read all lines, keep only those within max_days */
    time_t cutoff = time(NULL) - (max_days * 86400);

    /* Use a temp file for the rotated output */
    char tmppath[1024];
    snprintf(tmppath, sizeof(tmppath), "%s/sync.log.tmp", record_base);
    FILE *out = fopen(tmppath, "w");
    if (!out) {
        fclose(f);
        return;
    }

    char line[512];
    int kept = 0, dropped = 0;

    while (fgets(line, sizeof(line), f)) {
        /* Parse timestamp from beginning: "YYYY-MM-DD HH:MM:SS\t..." */
        struct tm tm;
        memset(&tm, 0, sizeof(tm));
        if (sscanf(line, "%d-%d-%d %d:%d:%d",
                   &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
                   &tm.tm_hour, &tm.tm_min, &tm.tm_sec) == 6) {
            tm.tm_year -= 1900;
            tm.tm_mon  -= 1;
            time_t entry_time = mktime(&tm);
            if (entry_time < cutoff) {
                dropped++;
                continue;
            }
        }
        fputs(line, out);
        kept++;
    }

    fclose(f);
    fclose(out);

    if (dropped > 0) {
        portable_unlink(logpath);
        rename(tmppath, logpath);
        LOG_I("sync: rotated sync.log — kept %d, dropped %d entries (>%d days)",
              kept, dropped, max_days);
    } else {
        portable_unlink(tmppath);
    }
}
