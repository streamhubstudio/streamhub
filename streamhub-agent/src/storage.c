#include "storage.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
  #ifdef __linux__
    #include <sys/mount.h>
  #endif
#endif

int storage_detect_sd(agent_config_t *cfg)
{
    cfg->sd_available = false;
    cfg->sd_mount[0] = '\0';

#ifdef PLAT_WINDOWS
    /* Check for removable drives (USB, SD card reader) */
    {
        plat_drive_info_t drives[26];
        int ndrive = plat_enumerate_drives(drives, 26);
        for (int i = 0; i < ndrive; i++) {
            if (drives[i].drive_type == 2 && drives[i].total_mb > 100) {
                /* Found removable drive with >100MB */
                snprintf(cfg->sd_mount, sizeof(cfg->sd_mount), "%s", drives[i].path);
                cfg->sd_available = true;
                LOG_I("storage: found removable drive %s (%s, %lld MB)",
                      drives[i].path, drives[i].label,
                      (long long)drives[i].total_mb);
                return 0;
            }
        }
    }
    LOG_I("storage: Windows mode — no removable drive, using configurable directory");
    return 0;
#elif defined(__APPLE__)
    LOG_I("storage: macOS mode — using configurable directory (no SD card)");
    return 0;
#else
    /* Linux: check for SD block devices (Luckfox Pico) */
    static const char *SD_DEVICES[] = {
        "/dev/mmcblk0p1", "/dev/mmcblk0",
        "/dev/mmcblk1p1", "/dev/mmcblk1",
        NULL
    };
    static const char *SD_MOUNT_POINT = "/mnt/sdcard";

    /* Check if any SD block device exists */
    const char *dev = NULL;
    for (int i = 0; SD_DEVICES[i]; i++) {
        if (file_exists(SD_DEVICES[i])) {
            dev = SD_DEVICES[i];
            break;
        }
    }

    if (!dev) {
        LOG_I("storage: no SD card detected");
        return 0;
    }

    LOG_I("storage: found SD card at %s", dev);

    /* Create mount point and try mounting */
    mkdirs(SD_MOUNT_POINT);

    /* Check if already mounted */
    FILE *fp = fopen("/proc/mounts", "r");
    if (fp) {
        char line[512];
        while (fgets(line, sizeof(line), fp)) {
            if (strstr(line, SD_MOUNT_POINT)) {
                fclose(fp);
                snprintf(cfg->sd_mount, sizeof(cfg->sd_mount),
                         "%s", SD_MOUNT_POINT);
                cfg->sd_available = true;
                LOG_I("storage: SD already mounted at %s", SD_MOUNT_POINT);
                return 0;
            }
        }
        fclose(fp);
    }

    /* Try mounting with common filesystems */
    const char *fstypes[] = { "ext4", "vfat", "exfat", "ext2", NULL };
    for (int i = 0; fstypes[i]; i++) {
        if (mount(dev, SD_MOUNT_POINT, fstypes[i], 0, NULL) == 0) {
            snprintf(cfg->sd_mount, sizeof(cfg->sd_mount),
                     "%s", SD_MOUNT_POINT);
            cfg->sd_available = true;
            LOG_I("storage: mounted %s (%s) at %s",
                  dev, fstypes[i], SD_MOUNT_POINT);
            return 0;
        }
    }

    LOG_W("storage: SD detected at %s but could not mount", dev);
    return -1;
#endif
}

const char *storage_record_path(const agent_config_t *cfg)
{
    return cfg->record_base;
}

/* Delete the oldest finished .mp4 under <record_base>/<cam>/<date>/video/
 * across all cameras. Files written in the last 2 minutes (the active
 * segment) are never picked. Returns 0 if a file was removed, -1 if none. */
static int remove_oldest_recording(const agent_config_t *cfg)
{
    char oldest[MAX_PATH_LEN] = "";
    time_t oldest_mtime = 0;
    time_t cutoff = time(NULL) - 120;

    for (int i = 0; i < cfg->camera_count; i++) {
        char cam_dir[MAX_PATH_LEN];
        snprintf(cam_dir, sizeof(cam_dir), "%s/%s",
                 cfg->record_base, cfg->cameras[i].id);
        DIR *d = opendir(cam_dir);
        if (!d) continue;
        struct dirent *ent;
        while ((ent = readdir(d)) != NULL) {
            if (ent->d_name[0] == '.') continue;
            char vdir[MAX_PATH_LEN];
            snprintf(vdir, sizeof(vdir), "%s/%s/video", cam_dir, ent->d_name);
            DIR *vd = opendir(vdir);
            if (!vd) continue;
            struct dirent *f;
            while ((f = readdir(vd)) != NULL) {
                const char *dot = strrchr(f->d_name, '.');
                if (!dot || strcmp(dot, ".mp4") != 0) continue;
                char full[MAX_PATH_LEN];
                snprintf(full, sizeof(full), "%s/%s", vdir, f->d_name);
                struct stat st;
                if (stat(full, &st) != 0 || st.st_mtime > cutoff) continue;
                if (!oldest[0] || st.st_mtime < oldest_mtime) {
                    oldest_mtime = st.st_mtime;
                    snprintf(oldest, sizeof(oldest), "%s", full);
                }
            }
            closedir(vd);
        }
        closedir(d);
    }

    if (!oldest[0] || remove(oldest) != 0)
        return -1;
    LOG_I("storage: removed %s", oldest);
    return 0;
}

int storage_rotate(const agent_config_t *cfg)
{
    int total_removed = 0;

    for (int i = 0; i < cfg->camera_count; i++) {
        const camera_t *cam = &cfg->cameras[i];
        if (!cam->enabled) continue;

        char cam_dir[MAX_PATH_LEN];
        snprintf(cam_dir, sizeof(cam_dir), "%s/%s",
                 cfg->record_base, cam->id);

        /* Determine max age based on storage type */
        int max_age_sec;
#if defined(PLAT_WINDOWS) || defined(__APPLE__)
        /* Desktop: always use configured TTL (no internal flash concern) */
        max_age_sec = cfg->records_ttl * 86400;
#else
        if (cfg->sd_available) {
            max_age_sec = cfg->records_ttl * 86400; /* TTL in days */
        } else {
            max_age_sec = 30 * 60; /* 30 minutes on internal flash */
        }
#endif

        /* Walk date directories */
        DIR *d = opendir(cam_dir);
        if (!d) continue;

        struct dirent *ent;
        while ((ent = readdir(d)) != NULL) {
            if (ent->d_name[0] == '.') continue;

            char date_dir[MAX_PATH_LEN];
            snprintf(date_dir, sizeof(date_dir), "%s/%s/video",
                     cam_dir, ent->d_name);

            int removed = remove_old_files(date_dir, max_age_sec, "mp4");
            if (removed > 0) {
                total_removed += removed;
                LOG_I("storage: rotated %d files from %s", removed, date_dir);
            }

            /* Remove empty directories */
            snprintf(date_dir, sizeof(date_dir), "%s/%s/video",
                     cam_dir, ent->d_name);
#ifdef PLAT_WINDOWS
            _rmdir(date_dir);
            snprintf(date_dir, sizeof(date_dir), "%s/%s",
                     cam_dir, ent->d_name);
            _rmdir(date_dir);
#else
            rmdir(date_dir);
            snprintf(date_dir, sizeof(date_dir), "%s/%s",
                     cam_dir, ent->d_name);
            rmdir(date_dir); /* only succeeds if empty */
#endif
        }
        closedir(d);
    }

    /* Pressure cleanup: at >= 90% usage, delete the oldest segments (any
     * camera) until usage is back under 85%. With stream-copy recording a
     * 2 Mbps camera writes ~21 GB/day, so a TTL cut would not keep up. */
    int64_t total_mb = plat_disk_total_mb(cfg->record_base);
    int64_t free_mb = disk_free_mb(cfg->record_base);
    if (total_mb > 0 && free_mb >= 0
        && (total_mb - free_mb) * 100 >= total_mb * 90) {
        LOG_W("storage: disk at %lld%% usage (%lld MB free), deleting oldest recordings",
              (long long)((total_mb - free_mb) * 100 / total_mb), (long long)free_mb);
        int removed = 0;
        while ((total_mb - free_mb) * 100 > total_mb * 85 && removed < 500
               && remove_oldest_recording(cfg) == 0) {
            removed++;
            free_mb = disk_free_mb(cfg->record_base);
        }
        total_removed += removed;
        LOG_I("storage: pressure-removed %d files, %lld MB free", removed,
              (long long)free_mb);
    }

    /* Emergency cleanup if disk is critically full (<50 MB free) */
    if (free_mb >= 0 && free_mb < 50) {
        LOG_W("storage: disk critically low (%lld MB free), aggressive cleanup",
              (long long)free_mb);
        /* Remove ALL recordings older than 10 minutes */
        for (int i = 0; i < cfg->camera_count; i++) {
            char cam_dir[MAX_PATH_LEN];
            snprintf(cam_dir, sizeof(cam_dir), "%s/%s",
                     cfg->record_base, cfg->cameras[i].id);
            DIR *d = opendir(cam_dir);
            if (!d) continue;
            struct dirent *ent;
            while ((ent = readdir(d)) != NULL) {
                if (ent->d_name[0] == '.') continue;
                char vdir[MAX_PATH_LEN];
                snprintf(vdir, sizeof(vdir), "%s/%s/video",
                         cam_dir, ent->d_name);
                total_removed += remove_old_files(vdir, 600, "mp4");
            }
            closedir(d);
        }
    }

    return total_removed;
}

int64_t storage_free_mb(const char *path)
{
    return disk_free_mb(path);
}

int storage_scan_pending(const agent_config_t *cfg, const camera_t *cam,
                         char paths[][MAX_PATH_LEN], int max_files)
{
    char cam_dir[MAX_PATH_LEN];
    snprintf(cam_dir, sizeof(cam_dir), "%s/%s", cfg->record_base, cam->id);

    DIR *d = opendir(cam_dir);
    if (!d) return 0;

    int count = 0;
    struct dirent *date_ent;
    time_t now = time(NULL);

    while ((date_ent = readdir(d)) != NULL && count < max_files) {
        if (date_ent->d_name[0] == '.') continue;

        char vdir[MAX_PATH_LEN];
        snprintf(vdir, sizeof(vdir), "%s/%s/video",
                 cam_dir, date_ent->d_name);

        DIR *vd = opendir(vdir);
        if (!vd) continue;

        struct dirent *ent;
        while ((ent = readdir(vd)) != NULL && count < max_files) {
            if (ent->d_name[0] == '.') continue;
            const char *dot = strrchr(ent->d_name, '.');
            if (!dot || strcmp(dot, ".mp4") != 0) continue;

            char full[MAX_PATH_LEN];
            snprintf(full, sizeof(full), "%s/%s", vdir, ent->d_name);

            /* Skip files that already have an .uploaded marker */
            char marker[MAX_PATH_LEN];
            snprintf(marker, sizeof(marker), "%s.uploaded", full);
            if (file_exists(marker)) continue;

            /* Only pick up files that are complete (older than 10s) */
            struct stat st;
            if (stat(full, &st) != 0) continue;
            if (now - st.st_mtime < 10) continue;
            if (st.st_size < 512 * 1024) continue;

            snprintf(paths[count], MAX_PATH_LEN, "%s", full);
            count++;
        }
        closedir(vd);
    }
    closedir(d);
    return count;
}
