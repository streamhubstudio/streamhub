#ifndef AGENT_WATCHDOG_H
#define AGENT_WATCHDOG_H

/*
 * Hardware watchdog using the kernel's /dev/watchdog.
 * If the process stops feeding, the SoC resets automatically.
 */

int  watchdog_open(int timeout_sec);
void watchdog_feed(int fd);
void watchdog_close(int fd);

#endif
