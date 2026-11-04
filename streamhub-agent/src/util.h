#ifndef AGENT_UTIL_H
#define AGENT_UTIL_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

/* Portable unlink — avoids #ifdef PLAT_WINDOWS scattered everywhere */
#ifdef _WIN32
  #include <io.h>
  static inline int portable_unlink(const char *path) { return _unlink(path); }
#else
  #include <unistd.h>
  static inline int portable_unlink(const char *path) { return unlink(path); }
#endif

/* clock helpers */
int64_t now_ms(void);
void    now_iso8601(char *buf, size_t len);
void    now_date(char *buf, size_t len);        /* YYYY-MM-DD */
void    now_filename(char *buf, size_t len);     /* YYYY-MM-DD_HH-mm-ss */

/* filesystem */
int     mkdirs(const char *path);
int64_t disk_free_mb(const char *path);
int     file_exists(const char *path);
int64_t file_size(const char *path);
int     remove_old_files(const char *dir, int max_age_sec, const char *ext);

/* ffmpeg */
const char *find_ffmpeg(void);
int     resolve_hostname(const char *hostname, char *ip_out, size_t ip_len);

/* strings */
void    str_trim(char *s);
int     str_starts_with(const char *s, const char *prefix);

/* crypto (OpenSSL wrappers) */
void    hmac_sha256(const void *key, int klen,
                    const void *data, int dlen,
                    unsigned char *out);
void    sha256_hex(const void *data, size_t len, char *hex_out);
int     sha256_file_hex(const char *path, char *hex_out);

#endif
