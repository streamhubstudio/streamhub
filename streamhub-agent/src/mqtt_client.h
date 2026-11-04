#ifndef AGENT_MQTT_CLIENT_H
#define AGENT_MQTT_CLIENT_H

#include "config.h"
#include <stdbool.h>

/* Callback for inbound messages */
typedef void (*mqttc_msg_cb)(const char *topic, const char *payload, void *ctx);

typedef struct mqttc mqttc_t;

mqttc_t *mqttc_create(const agent_config_t *cfg, mqttc_msg_cb cb, void *ctx);
void     mqttc_destroy(mqttc_t *c);
int      mqttc_connect(mqttc_t *c);
void     mqttc_disconnect(mqttc_t *c);
bool     mqttc_connected(mqttc_t *c);
int      mqttc_poll(mqttc_t *c, int timeout_ms);
int      mqttc_publish(mqttc_t *c, const char *topic, const char *payload);
int      mqttc_subscribe(mqttc_t *c, const char *topic);

/* Convenience: publish to /<tenant>/<id>/<action> */
int      mqttc_pub_action(mqttc_t *c, const char *id,
                          const char *action, const char *payload);

/* For unified poll() integration */
int      mqttc_get_fd(mqttc_t *c);
int      mqttc_process(mqttc_t *c);   /* call when POLLIN is set */
void     mqttc_keepalive(mqttc_t *c); /* call every loop iteration */

#endif
