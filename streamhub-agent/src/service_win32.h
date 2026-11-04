#ifndef AGENT_SERVICE_WIN32_H
#define AGENT_SERVICE_WIN32_H

#ifdef _WIN32

/* Parse --install / --uninstall / --start / --stop.
 * Returns 1 if handled (caller should exit), 0 if not a service arg. */
int service_handle_args(int argc, char **argv);

/* If --service flag is present, enter SCM dispatcher.
 * Returns 1 if entered service mode (caller should exit), 0 otherwise. */
int service_try_start(int argc, char **argv);

#endif /* _WIN32 */
#endif /* AGENT_SERVICE_WIN32_H */
