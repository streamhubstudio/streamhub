/*
 * Watchdog — thin wrapper around platform_* functions.
 * Kept for backward compatibility with existing callers.
 */

#include "watchdog.h"
#include "platform.h"

int watchdog_open(int timeout_sec)
{
    return plat_watchdog_open(timeout_sec);
}

void watchdog_feed(int fd)
{
    plat_watchdog_feed(fd);
}

void watchdog_close(int fd)
{
    plat_watchdog_close(fd);
}
