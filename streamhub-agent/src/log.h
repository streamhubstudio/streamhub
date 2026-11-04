#ifndef AGENT_LOG_H
#define AGENT_LOG_H

typedef enum {
    LOG_DEBUG,
    LOG_INFO,
    LOG_WARN,
    LOG_ERROR,
    LOG_FATAL
} log_level_t;

void log_init(const char *ident, log_level_t min_level);

#ifdef __GNUC__
void log_msg(log_level_t level, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));
#else
void log_msg(log_level_t level, const char *fmt, ...);
#endif

#define LOG_D(fmt, ...) log_msg(LOG_DEBUG, fmt, ##__VA_ARGS__)
#define LOG_I(fmt, ...) log_msg(LOG_INFO,  fmt, ##__VA_ARGS__)
#define LOG_W(fmt, ...) log_msg(LOG_WARN,  fmt, ##__VA_ARGS__)
#define LOG_E(fmt, ...) log_msg(LOG_ERROR, fmt, ##__VA_ARGS__)
#define LOG_F(fmt, ...) log_msg(LOG_FATAL, fmt, ##__VA_ARGS__)

/* Truncate stderr log file if it exceeds ~1MB (prevents tmpfs OOM) */
void log_rotate(void);

/* File-based logging (used by Windows service mode) */
void log_init_file(const char *path);
void log_close_file(void);

/* Optional callback for forwarding log messages (e.g. to MQTT).
 * The callback receives level and the fully formatted message line.
 * Recursion-safe: callbacks that trigger logging won't re-enter. */
typedef void (*log_callback_fn)(log_level_t level, const char *msg, void *ctx);
void log_set_callback(log_callback_fn cb, void *ctx);

#endif
