#include "util.h"
#include "config.h"
#include "log.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef PLAT_WINDOWS
  #include <io.h>
  #include <sys/timeb.h>
#else
  #include <unistd.h>
  #include <sys/time.h>
  #include <netdb.h>
  #include <arpa/inet.h>
#endif

#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <openssl/evp.h>

/* ── Clock helpers ────────────────────────────────────────────────── */

int64_t now_ms(void)
{
#ifdef PLAT_WINDOWS
    struct _timeb tb;
    _ftime(&tb);
    return (int64_t)tb.time * 1000 + tb.millitm;
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
#endif
}

void now_iso8601(char *buf, size_t len)
{
    time_t    t = time(NULL);
    struct tm tm_buf;
#ifdef PLAT_WINDOWS
    struct tm *tmp = gmtime(&t);
    tm_buf = *tmp;
#else
    gmtime_r(&t, &tm_buf);
#endif
    strftime(buf, len, "%Y%m%dT%H%M%SZ", &tm_buf);
}

void now_date(char *buf, size_t len)
{
    time_t    t = time(NULL);
    struct tm tm_buf;
#ifdef PLAT_WINDOWS
    struct tm *tmp = localtime(&t);
    tm_buf = *tmp;
#else
    localtime_r(&t, &tm_buf);
#endif
    strftime(buf, len, "%Y-%m-%d", &tm_buf);
}

void now_filename(char *buf, size_t len)
{
    time_t    t = time(NULL);
    struct tm tm_buf;
#ifdef PLAT_WINDOWS
    struct tm *tmp = localtime(&t);
    tm_buf = *tmp;
#else
    localtime_r(&t, &tm_buf);
#endif
    strftime(buf, len, "%Y-%m-%d_%H-%M-%S", &tm_buf);
}

/* ── Filesystem ───────────────────────────────────────────────────── */

int mkdirs(const char *path)
{
    return plat_mkdirs(path);
}

int64_t disk_free_mb(const char *path)
{
    return plat_disk_free_mb(path);
}

int file_exists(const char *path)
{
#ifdef PLAT_WINDOWS
    return _access(path, 0) == 0;
#else
    return access(path, F_OK) == 0;
#endif
}

int64_t file_size(const char *path)
{
    struct stat st;
    if (stat(path, &st) != 0)
        return -1;
    return st.st_size;
}

int remove_old_files(const char *dir, int max_age_sec, const char *ext)
{
    DIR *d = opendir(dir);
    if (!d)
        return -1;

    time_t cutoff = time(NULL) - max_age_sec;
    int    removed = 0;
    struct dirent *ent;

    while ((ent = readdir(d)) != NULL) {
        if (ent->d_name[0] == '.')
            continue;

        if (ext) {
            const char *dot = strrchr(ent->d_name, '.');
            if (!dot || strcmp(dot + 1, ext) != 0)
                continue;
        }

        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s/%s", dir, ent->d_name);

        struct stat st;
        if (stat(full, &st) == 0 && st.st_mtime < cutoff) {
            if (portable_unlink(full) == 0)
                removed++;
        }
    }
    closedir(d);
    return removed;
}

/* ── FFmpeg detection ─────────────────────────────────────────────── */

const char *find_ffmpeg(void)
{
    return plat_find_ffmpeg();
}

int resolve_hostname(const char *hostname, char *ip_out, size_t ip_len)
{
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(hostname, NULL, &hints, &res) != 0 || !res)
        return -1;

    struct sockaddr_in *addr = (struct sockaddr_in *)res->ai_addr;
    const char *ip = inet_ntoa(addr->sin_addr);
    snprintf(ip_out, ip_len, "%s", ip);
    freeaddrinfo(res);
    return 0;
}

/* ── Strings ──────────────────────────────────────────────────────── */

void str_trim(char *s)
{
    char *end = s + strlen(s) - 1;
    while (end > s && isspace((unsigned char)*end))
        *end-- = '\0';
    char *start = s;
    while (*start && isspace((unsigned char)*start))
        start++;
    if (start != s)
        memmove(s, start, strlen(start) + 1);
}

int str_starts_with(const char *s, const char *prefix)
{
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

/* ── Crypto ───────────────────────────────────────────────────────── */

void hmac_sha256(const void *key, int klen,
                 const void *data, int dlen,
                 unsigned char *out)
{
    unsigned int len = 32;
    HMAC(EVP_sha256(), key, klen, data, dlen, out, &len);
}

void sha256_hex(const void *data, size_t len, char *hex_out)
{
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256(data, len, hash);
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++)
        sprintf(hex_out + i * 2, "%02x", hash[i]);
    hex_out[SHA256_DIGEST_LENGTH * 2] = '\0';
}

int sha256_file_hex(const char *path, char *hex_out)
{
    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;

    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    if (!ctx) { fclose(fp); return -1; }

    EVP_DigestInit_ex(ctx, EVP_sha256(), NULL);

    unsigned char buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), fp)) > 0)
        EVP_DigestUpdate(ctx, buf, n);
    fclose(fp);

    unsigned char hash[SHA256_DIGEST_LENGTH];
    EVP_DigestFinal_ex(ctx, hash, NULL);
    EVP_MD_CTX_free(ctx);

    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++)
        sprintf(hex_out + i * 2, "%02x", hash[i]);
    hex_out[SHA256_DIGEST_LENGTH * 2] = '\0';

    return 0;
}
