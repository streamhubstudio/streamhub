#include "mqtt_client.h"
#include "log.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

#ifdef PLAT_POSIX
  #include <netinet/tcp.h>   /* TCP_NODELAY */
#endif

/*
 * Minimal MQTT 3.1.1 implementation.
 * Supports CONNECT, PUBLISH (QoS 0), SUBSCRIBE, PINGREQ/PINGRESP.
 * Uses platform-abstracted socket I/O.
 */

#define MQTT_BUF_SZ   4096
#define KEEPALIVE_SEC  60   /* broker timeout = 1.5x = 90s */
#define PING_INTERVAL  5    /* frequent pings — broker may have low max_keepalive */
#define MQTT_PASSWORD  "default"

/* Packet types */
#define MQTT_CONNECT     0x10
#define MQTT_CONNACK     0x20
#define MQTT_PUBLISH     0x30
#define MQTT_SUBSCRIBE   0x82
#define MQTT_SUBACK      0x90
#define MQTT_PINGREQ     0xC0
#define MQTT_PINGRESP    0xD0
#define MQTT_DISCONNECT  0xE0

struct mqttc {
    sock_t                fd;
    const agent_config_t *cfg;
    mqttc_msg_cb          cb;
    void                 *ctx;
    char                  client_id[64];
    bool                  connected;
    time_t                last_ping;
    time_t                last_data;  /* last time data was received */
    uint16_t              pkt_id;
    uint8_t               buf[MQTT_BUF_SZ];
    int                   buf_len;  /* bytes of valid data in buf */
};

/* ── Packet encoding helpers ──────────────────────────────────────── */

static int encode_remaining_length(uint8_t *buf, int len)
{
    int i = 0;
    do {
        uint8_t byte = len % 128;
        len /= 128;
        if (len > 0) byte |= 0x80;
        buf[i++] = byte;
    } while (len > 0);
    return i;
}

static int decode_remaining_length(const uint8_t *buf, int *bytes_used)
{
    int val = 0, shift = 0, i = 0;
    do {
        val |= (buf[i] & 0x7F) << shift;
        shift += 7;
    } while ((buf[i++] & 0x80) && i < 4);
    *bytes_used = i;
    return val;
}

static void write_u16(uint8_t *buf, uint16_t v)
{
    buf[0] = (v >> 8) & 0xFF;
    buf[1] = v & 0xFF;
}

static uint16_t read_u16(const uint8_t *buf)
{
    return (uint16_t)((buf[0] << 8) | buf[1]);
}

/* ── TCP ──────────────────────────────────────────────────────────── */

static sock_t tcp_connect(const char *host, int port)
{
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", port);

    if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res)
        return INVALID_SOCK;

    sock_t fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd == INVALID_SOCK) {
        freeaddrinfo(res);
        return INVALID_SOCK;
    }

    if (connect(fd, res->ai_addr, (int)res->ai_addrlen) < 0) {
        freeaddrinfo(res);
        sock_close(fd);
        return INVALID_SOCK;
    }
    freeaddrinfo(res);

    /* Disable Nagle's algorithm so small packets (PINGREQ = 2 bytes)
     * are sent immediately without waiting for outstanding ACKs. */
    int nodelay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, (const char *)&nodelay, sizeof(nodelay));

    /* Enable TCP keepalive with short idle timeout.
     * This ensures the OS sends probes even when the application event loop
     * is briefly blocked, keeping NAT/firewall mappings alive. */
    int keepalive = 1;
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, (const char *)&keepalive, sizeof(keepalive));
#ifdef PLAT_WINDOWS
    {
        /* struct tcp_keepalive: onoff, keepalivetime (ms), keepaliveinterval (ms) */
        DWORD ret;
        unsigned char ka[12];
        /* onoff = 1 */
        ka[0] = 1; ka[1] = 0; ka[2] = 0; ka[3] = 0;
        /* keepalivetime = 5000ms (5s before first probe) */
        ka[4] = 0x88; ka[5] = 0x13; ka[6] = 0; ka[7] = 0;
        /* keepaliveinterval = 3000ms (3s between probes) */
        ka[8] = 0xB8; ka[9] = 0x0B; ka[10] = 0; ka[11] = 0;
        WSAIoctl(fd, SIO_KEEPALIVE_VALS, ka, sizeof(ka), NULL, 0, &ret, NULL, NULL);
    }
#elif defined(__linux__)
    {
        int idle = 5;   /* 5s before first probe */
        int intvl = 3;  /* 3s between probes */
        int cnt = 3;    /* 3 failed probes before declaring dead */
        setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
        setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
        setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
    }
#endif
    /* macOS: SO_KEEPALIVE enabled above, system defaults used */

    return fd;
}

static int send_all(sock_t fd, const void *buf, size_t len)
{
    const uint8_t *p = buf;
    while (len > 0) {
        int n = sock_write(fd, p, len);
        if (n <= 0) return -1;
        p += n;
        len -= n;
    }
    return 0;
}

/* ── MQTT packets ─────────────────────────────────────────────────── */

static int send_connect(mqttc_t *c)
{
    uint8_t pkt[512];
    int pos = 0;

    /* Variable header: protocol name + level + flags + keepalive */
    uint8_t var[10] = {
        0x00, 0x04, 'M', 'Q', 'T', 'T',  /* Protocol name */
        0x04,                               /* Protocol level (3.1.1) */
        0xC2,                               /* Username + Password + Clean session */
        (KEEPALIVE_SEC >> 8) & 0xFF,
        KEEPALIVE_SEC & 0xFF
    };

    /* Payload: client_id, username, password */
    int cid_len = (int)strlen(c->client_id);
    const char *username = c->cfg->id;
    int uname_len = (int)strlen(username);
    const char *password = MQTT_PASSWORD;
    int pass_len = (int)strlen(password);

    /* Total remaining = var header + client_id + username + password (each with 2-byte len prefix) */
    int remaining = 10 + (2 + cid_len) + (2 + uname_len) + (2 + pass_len);

    pkt[pos++] = MQTT_CONNECT;
    pos += encode_remaining_length(pkt + pos, remaining);
    memcpy(pkt + pos, var, 10); pos += 10;
    write_u16(pkt + pos, (uint16_t)cid_len); pos += 2;
    memcpy(pkt + pos, c->client_id, cid_len); pos += cid_len;
    write_u16(pkt + pos, (uint16_t)uname_len); pos += 2;
    memcpy(pkt + pos, username, uname_len); pos += uname_len;
    write_u16(pkt + pos, (uint16_t)pass_len); pos += 2;
    memcpy(pkt + pos, password, pass_len); pos += pass_len;

    return send_all(c->fd, pkt, pos);
}

static int send_subscribe(mqttc_t *c, const char *topic)
{
    uint8_t pkt[512];
    int pos = 0;
    int topic_len = (int)strlen(topic);
    int remaining = 2 + 2 + topic_len + 1; /* pkt_id + string + qos */

    pkt[pos++] = MQTT_SUBSCRIBE;
    pos += encode_remaining_length(pkt + pos, remaining);
    write_u16(pkt + pos, ++c->pkt_id); pos += 2;
    write_u16(pkt + pos, (uint16_t)topic_len); pos += 2;
    memcpy(pkt + pos, topic, topic_len); pos += topic_len;
    pkt[pos++] = 0; /* QoS 0 */

    return send_all(c->fd, pkt, pos);
}

static int send_publish(mqttc_t *c, const char *topic, const void *payload, int plen)
{
    uint8_t pkt[MQTT_BUF_SZ];
    int pos = 0;
    int topic_len = (int)strlen(topic);
    int remaining = 2 + topic_len + plen;

    if (remaining + 5 > MQTT_BUF_SZ) {
        LOG_W("mqtt: message too large (%d bytes)", remaining);
        return -1;
    }

    pkt[pos++] = MQTT_PUBLISH; /* QoS 0, no retain */
    pos += encode_remaining_length(pkt + pos, remaining);
    write_u16(pkt + pos, (uint16_t)topic_len); pos += 2;
    memcpy(pkt + pos, topic, topic_len); pos += topic_len;
    memcpy(pkt + pos, payload, plen); pos += plen;

    return send_all(c->fd, pkt, pos);
}

static int send_pingreq(mqttc_t *c)
{
    uint8_t pkt[] = { MQTT_PINGREQ, 0x00 };
    return send_all(c->fd, pkt, 2);
}

static int send_disconnect(mqttc_t *c)
{
    uint8_t pkt[] = { MQTT_DISCONNECT, 0x00 };
    return send_all(c->fd, pkt, 2);
}

/* ── Inbound packet handling ──────────────────────────────────────── */

static void handle_publish(mqttc_t *c, const uint8_t *data, int len)
{
    if (len < 2) return;

    int topic_len = read_u16(data);
    if (topic_len + 2 > len) return;

    char topic[MAX_TOPIC_LEN];
    int tl = topic_len < (int)sizeof(topic) - 1 ? topic_len : (int)sizeof(topic) - 1;
    memcpy(topic, data + 2, tl);
    topic[tl] = '\0';

    int payload_off = 2 + topic_len;
    int payload_len = len - payload_off;

    char payload[1024];
    int pl = payload_len < (int)sizeof(payload) - 1 ? payload_len : (int)sizeof(payload) - 1;
    if (pl > 0) memcpy(payload, data + payload_off, pl);
    payload[pl] = '\0';

    if (c->cb)
        c->cb(topic, payload, c->ctx);
}

static int process_packet(mqttc_t *c, const uint8_t *buf, int buf_len, int *consumed)
{
    if (buf_len < 2) return 0; /* need more data */

    uint8_t type = buf[0] & 0xF0;
    int rl_bytes;
    int remaining = decode_remaining_length(buf + 1, &rl_bytes);
    int total = 1 + rl_bytes + remaining;

    if (buf_len < total) return 0; /* need more data */

    *consumed = total;
    const uint8_t *payload = buf + 1 + rl_bytes;

    switch (type) {
    case MQTT_CONNACK:
        if (remaining >= 2 && payload[1] == 0) {
            c->connected = true;
            LOG_I("mqtt: CONNACK received, connected");
        } else {
            LOG_E("mqtt: CONNACK rejected (code=%d)",
                  remaining >= 2 ? payload[1] : -1);
            return -1;
        }
        break;

    case MQTT_PUBLISH:
        handle_publish(c, payload, remaining);
        break;

    case MQTT_SUBACK:
        LOG_D("mqtt: SUBACK received");
        break;

    case MQTT_PINGRESP:
        LOG_D("mqtt: PINGRESP received");
        break;

    default:
        LOG_D("mqtt: unknown packet type 0x%02X", type);
        break;
    }
    return 1;
}

/* ── Public API ───────────────────────────────────────────────────── */

mqttc_t *mqttc_create(const agent_config_t *cfg, mqttc_msg_cb cb, void *ctx)
{
    mqttc_t *c = calloc(1, sizeof(*c));
    if (!c) return NULL;

    c->cfg  = cfg;
    c->cb   = cb;
    c->ctx  = ctx;
    c->fd   = INVALID_SOCK;
#ifdef PLAT_WINDOWS
    srand((unsigned)time(NULL) ^ (unsigned)GetCurrentProcessId());
#else
    srand((unsigned)time(NULL) ^ (unsigned)getpid());
#endif
    snprintf(c->client_id, sizeof(c->client_id), "%s_%04x",
             cfg->id, (unsigned)(rand() % 0xFFFF));

    return c;
}

void mqttc_destroy(mqttc_t *c)
{
    if (!c) return;
    mqttc_disconnect(c);
    free(c);
}

int mqttc_connect(mqttc_t *c)
{
    if (c->fd != INVALID_SOCK)
        mqttc_disconnect(c);

    c->fd = tcp_connect(c->cfg->mqtt_host, c->cfg->mqtt_port);
    if (c->fd == INVALID_SOCK) {
        LOG_E("mqtt: TCP connect to %s:%d failed",
              c->cfg->mqtt_host, c->cfg->mqtt_port);
        return -1;
    }

    if (send_connect(c) != 0) {
        LOG_E("mqtt: failed to send CONNECT");
        sock_close(c->fd); c->fd = INVALID_SOCK;
        return -1;
    }

    /* Wait for CONNACK (up to 5 seconds) */
    c->buf_len = 0;
    struct pollfd pfd;
    memset(&pfd, 0, sizeof(pfd));
    pfd.fd = (int)c->fd;
    pfd.events = POLLIN;
    if (poll(&pfd, 1, 5000) > 0 && (pfd.revents & POLLIN)) {
        int n = sock_read(c->fd, c->buf, sizeof(c->buf));
        if (n > 0) {
            c->buf_len = n;
            int offset = 0;
            while (offset < c->buf_len) {
                int consumed = 0;
                int rc = process_packet(c, c->buf + offset, c->buf_len - offset, &consumed);
                if (rc <= 0) break;
                offset += consumed;
            }
            /* Preserve unprocessed bytes */
            if (offset > 0 && offset < c->buf_len) {
                memmove(c->buf, c->buf + offset, c->buf_len - offset);
                c->buf_len -= offset;
            } else if (offset >= c->buf_len) {
                c->buf_len = 0;
            }
        }
    }

    if (!c->connected) {
        LOG_E("mqtt: no CONNACK received");
        sock_close(c->fd); c->fd = INVALID_SOCK;
        return -1;
    }

    c->last_ping = time(NULL);
    c->last_data = time(NULL);
    LOG_I("mqtt: connected to %s:%d as %s",
          c->cfg->mqtt_host, c->cfg->mqtt_port, c->client_id);
    return 0;
}

void mqttc_disconnect(mqttc_t *c)
{
    if (c->fd != INVALID_SOCK) {
        if (c->connected)
            send_disconnect(c);
        sock_close(c->fd);
        c->fd = INVALID_SOCK;
        c->connected = false;
    }
    c->buf_len = 0;
}

bool mqttc_connected(mqttc_t *c)
{
    return c && c->connected && c->fd != INVALID_SOCK;
}

int mqttc_poll(mqttc_t *c, int timeout_ms)
{
    if (c->fd == INVALID_SOCK)
        return -1;

    /* Keepalive ping */
    time_t now = time(NULL);
    if (now - c->last_ping >= PING_INTERVAL) {
        send_pingreq(c);
        c->last_ping = now;
    }

    struct pollfd pfd;
    memset(&pfd, 0, sizeof(pfd));
    pfd.fd = (int)c->fd;
    pfd.events = POLLIN;
    int ret = poll(&pfd, 1, timeout_ms);

    if (ret < 0) {
#ifdef PLAT_WINDOWS
        LOG_E("mqtt: poll error: %d", WSAGetLastError());
#else
        if (errno == EINTR) return 0;
        LOG_E("mqtt: poll error: %s", strerror(errno));
#endif
        c->connected = false;
        return -1;
    }

    if (ret > 0 && (pfd.revents & POLLIN)) {
        int space = MQTT_BUF_SZ - c->buf_len;
        if (space <= 0) { c->buf_len = 0; space = MQTT_BUF_SZ; }

        int n = sock_read(c->fd, c->buf + c->buf_len, space);
        if (n <= 0) {
            LOG_W("mqtt: connection closed by broker");
            c->connected = false;
            sock_close(c->fd); c->fd = INVALID_SOCK;
            return -1;
        }

        c->buf_len += n;
        c->last_data = time(NULL);
        int offset = 0;
        while (offset < c->buf_len) {
            int consumed = 0;
            int rc = process_packet(c, c->buf + offset, c->buf_len - offset, &consumed);
            if (rc < 0) { offset++; continue; }
            if (rc == 0) break;
            offset += consumed;
        }

        if (offset > 0 && offset < c->buf_len) {
            memmove(c->buf, c->buf + offset, c->buf_len - offset);
            c->buf_len -= offset;
        } else if (offset >= c->buf_len) {
            c->buf_len = 0;
        }
    }

    /* Don't check POLLHUP — on Windows, WSAPoll returns spurious POLLHUP.
     * Real disconnects are detected by recv() returning 0 above, or by
     * send_pingreq() failure in the keepalive path. */

    return 0;
}

int mqttc_publish(mqttc_t *c, const char *topic, const char *payload)
{
    if (!c->connected)
        return -1;
    return send_publish(c, topic, payload, (int)strlen(payload));
}

int mqttc_subscribe(mqttc_t *c, const char *topic)
{
    if (!c->connected)
        return -1;
    LOG_I("mqtt: subscribing to %s", topic);
    return send_subscribe(c, topic);
}

int mqttc_pub_action(mqttc_t *c, const char *id,
                     const char *action, const char *payload)
{
    char topic[MAX_TOPIC_LEN];
    snprintf(topic, sizeof(topic), "/%s/%s/%s", c->cfg->tenant, id, action);
    return mqttc_publish(c, topic, payload);
}

int mqttc_get_fd(mqttc_t *c)
{
    if (!c) return -1;
    return (int)c->fd;
}

void mqttc_keepalive(mqttc_t *c)
{
    if (!c || c->fd == INVALID_SOCK || !c->connected)
        return;
    time_t now = time(NULL);
    if (now - c->last_ping >= PING_INTERVAL) {
        LOG_D("mqtt: PINGREQ (last_ping %ds, last_data %ds)",
              (int)(now - c->last_ping),
              c->last_data > 0 ? (int)(now - c->last_data) : -1);
        if (send_pingreq(c) != 0) {
            LOG_W("mqtt: keepalive send failed, disconnecting");
            c->connected = false;
            sock_close(c->fd);
            c->fd = INVALID_SOCK;
            return;
        }
        c->last_ping = now;
        LOG_D("mqtt: PINGREQ sent OK");
    }
    /* No data received for 2x keepalive → connection is dead */
    if (c->last_data > 0 && now - c->last_data > KEEPALIVE_SEC * 2) {
        LOG_W("mqtt: no data for %ds, disconnecting", (int)(now - c->last_data));
        c->connected = false;
        sock_close(c->fd);
        c->fd = INVALID_SOCK;
    }
}

int mqttc_process(mqttc_t *c)
{
    if (!c || c->fd == INVALID_SOCK)
        return -1;

    /* Read new data after existing unprocessed bytes */
    int space = MQTT_BUF_SZ - c->buf_len;
    if (space <= 0) {
        LOG_W("mqtt: buffer full, resetting");
        c->buf_len = 0;
        space = MQTT_BUF_SZ;
    }

    int n = sock_read(c->fd, c->buf + c->buf_len, space);
    if (n < 0) {
#ifdef PLAT_WINDOWS
        int err = WSAGetLastError();
        if (err == WSAEWOULDBLOCK) return 0;
        LOG_E("mqtt: read error: %d", err);
#else
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return 0;
        LOG_E("mqtt: read error: %s", strerror(errno));
#endif
        c->connected = false;
        sock_close(c->fd); c->fd = INVALID_SOCK;
        return -1;
    }
    if (n == 0) {
        LOG_W("mqtt: connection closed by broker");
        c->connected = false;
        sock_close(c->fd); c->fd = INVALID_SOCK;
        return -1;
    }

    c->buf_len += n;
    c->last_data = time(NULL);

    int offset = 0;
    while (offset < c->buf_len) {
        int consumed = 0;
        int rc = process_packet(c, c->buf + offset, c->buf_len - offset, &consumed);
        if (rc < 0) {
            /* Parse error — skip one byte to try to re-sync */
            offset++;
            continue;
        }
        if (rc == 0) break;  /* need more data */
        offset += consumed;
    }

    /* Preserve unprocessed bytes for next read */
    if (offset > 0 && offset < c->buf_len) {
        memmove(c->buf, c->buf + offset, c->buf_len - offset);
        c->buf_len -= offset;
    } else if (offset >= c->buf_len) {
        c->buf_len = 0;
    }

    return 0;
}
