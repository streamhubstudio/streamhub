#include "webui.h"
#include "api.h"
#include "log.h"
#include "util.h"
#include "snapshot.h"
#include "platform.h"

#include <cJSON.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <sys/stat.h>
#include <dirent.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
  #include <sys/utsname.h>
#endif

/* WWW root: embedded Linux uses /userdata/www, desktop uses ./www */
#ifdef PLAT_WINDOWS
  #define WEBUI_WWW_ROOT  "./www"
#else
  #define WEBUI_WWW_ROOT  "/userdata/www"
#endif

#define REQ_BUF_SZ       4096
#define RESP_BUF_SZ      8192
#define IDLE_TIMEOUT_SEC  30
#define UPLOAD_BUF_SZ     4096
#define MAX_FIRMWARE_SZ   (2 * 1024 * 1024) /* 2 MB max firmware */

/* ── Base64 lookup table ──────────────────────────────────────────── */

static const char b64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void base64_encode(const char *in, size_t len, char *out, size_t out_sz)
{
    size_t i = 0, o = 0;
    while (i < len && o + 4 < out_sz) {
        uint32_t v = (uint8_t)in[i++] << 16;
        if (i < len) v |= (uint8_t)in[i++] << 8;
        if (i < len) v |= (uint8_t)in[i++];
        out[o++] = b64[(v >> 18) & 0x3F];
        out[o++] = b64[(v >> 12) & 0x3F];
        out[o++] = (i > len + 1) ? '=' : b64[(v >> 6) & 0x3F];
        out[o++] = (i > len)     ? '=' : b64[v & 0x3F];
    }
    out[o] = '\0';
}

static int base64_decode_char(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static int base64_decode(const char *in, char *out, size_t out_sz)
{
    size_t len = strlen(in), o = 0;
    for (size_t i = 0; i < len && o < out_sz - 1; i += 4) {
        int a = base64_decode_char(in[i]);
        int b = (i+1 < len) ? base64_decode_char(in[i+1]) : 0;
        int c = (i+2 < len) ? base64_decode_char(in[i+2]) : 0;
        int d = (i+3 < len) ? base64_decode_char(in[i+3]) : 0;
        if (a < 0 || b < 0) break;
        out[o++] = (a << 2) | (b >> 4);
        if (in[i+2] != '=' && c >= 0 && o < out_sz - 1)
            out[o++] = ((b & 0x0F) << 4) | (c >> 2);
        if (in[i+3] != '=' && d >= 0 && o < out_sz - 1)
            out[o++] = ((c & 0x03) << 6) | d;
    }
    out[o] = '\0';
    return (int)o;
}

/* ── Client state ─────────────────────────────────────────────────── */

typedef enum {
    CS_IDLE,
    CS_READING,
    CS_RECEIVING_UPLOAD,  /* streaming body to file */
    CS_WRITING
} client_state_t;

typedef struct {
    int            fd;
    client_state_t state;
    time_t         last_active;
    char           req_buf[REQ_BUF_SZ];
    int            req_len;
    char          *resp_buf;
    int            resp_len;
    int            resp_sent;
    int            file_fd;
    off_t          file_remaining;
    /* upload state */
    int            upload_fd;      /* temp file for upload */
    int            upload_remaining; /* bytes still to receive */
    char           upload_path[MAX_PATH_LEN];
    char           upload_endpoint[64]; /* which endpoint initiated upload */
} webui_client_t;

struct webui {
    int             listen_fd;
    app_context_t  *app;
    webui_client_t  clients[WEBUI_MAX_CLIENTS];
    char            auth_expected[128];
};

/* ── Helpers ──────────────────────────────────────────────────────── */

static void set_nonblocking(int fd)
{
    plat_set_nonblock(fd);
}

static void client_reset(webui_client_t *cl)
{
    if (cl->fd >= 0) sock_close(cl->fd);
    if (cl->file_fd >= 0) close(cl->file_fd);
    if (cl->upload_fd >= 0) { close(cl->upload_fd); cl->upload_fd = -1; }
    if (cl->resp_buf) { free(cl->resp_buf); cl->resp_buf = NULL; }
    cl->fd = -1;
    cl->file_fd = -1;
    cl->state = CS_IDLE;
    cl->req_len = 0;
    cl->resp_len = 0;
    cl->resp_sent = 0;
    cl->file_remaining = 0;
    cl->upload_remaining = 0;
    cl->upload_path[0] = '\0';
    cl->upload_endpoint[0] = '\0';
}

static const char *content_type_for(const char *path)
{
    const char *ext = strrchr(path, '.');
    if (!ext) return "application/octet-stream";
    if (strcmp(ext, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(ext, ".js") == 0)   return "application/javascript; charset=utf-8";
    if (strcmp(ext, ".css") == 0)  return "text/css; charset=utf-8";
    if (strcmp(ext, ".json") == 0) return "application/json";
    if (strcmp(ext, ".jpg") == 0 || strcmp(ext, ".jpeg") == 0) return "image/jpeg";
    if (strcmp(ext, ".png") == 0)  return "image/png";
    if (strcmp(ext, ".svg") == 0)  return "image/svg+xml";
    if (strcmp(ext, ".ico") == 0)  return "image/x-icon";
    if (strcmp(ext, ".mp4") == 0)  return "video/mp4";
    return "application/octet-stream";
}

/* ── HTTP response builders ───────────────────────────────────────── */

static void send_response(webui_client_t *cl, int code, const char *status,
                          const char *content_type, const char *body, int body_len)
{
    char header[512];
    int hlen = snprintf(header, sizeof(header),
        "HTTP/1.0 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n",
        code, status, content_type, body_len);

    cl->resp_buf = malloc(hlen + body_len);
    if (!cl->resp_buf) { client_reset(cl); return; }
    memcpy(cl->resp_buf, header, hlen);
    if (body_len > 0) memcpy(cl->resp_buf + hlen, body, body_len);
    cl->resp_len = hlen + body_len;
    cl->resp_sent = 0;
    cl->state = CS_WRITING;
}

static void send_json(webui_client_t *cl, int code, const char *status, cJSON *json)
{
    char *body = cJSON_PrintUnformatted(json);
    if (!body) body = strdup("{}");
    send_response(cl, code, status, "application/json", body, strlen(body));
    free(body);
}

static void send_error(webui_client_t *cl, int code, const char *msg)
{
    char body[256];
    int len = snprintf(body, sizeof(body), "{\"error\":\"%s\"}", msg);
    send_response(cl, code, msg, "application/json", body, len);
}

static void send_ok(webui_client_t *cl, const char *message)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "ok", true);
    if (message) cJSON_AddStringToObject(j, "message", message);
    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

static void send_401(webui_client_t *cl)
{
    const char *body = "{\"error\":\"Unauthorized\"}";
    char header[512];
    int body_len = strlen(body);
    int hlen = snprintf(header, sizeof(header),
        "HTTP/1.0 401 Unauthorized\r\n"
        "WWW-Authenticate: Basic realm=\"StreamHub Agent\"\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n"
        "\r\n",
        body_len);

    cl->resp_buf = malloc(hlen + body_len);
    if (!cl->resp_buf) { client_reset(cl); return; }
    memcpy(cl->resp_buf, header, hlen);
    memcpy(cl->resp_buf + hlen, body, body_len);
    cl->resp_len = hlen + body_len;
    cl->resp_sent = 0;
    cl->state = CS_WRITING;
}

/* ── File streaming with Range support ─────────────────────────────── */

static void send_file_range(webui_client_t *cl, const char *filepath,
                            off_t range_start, off_t range_end)
{
    struct stat st;
    if (stat(filepath, &st) != 0 || !S_ISREG(st.st_mode)) {
        send_error(cl, 404, "File not found");
        return;
    }

    int fd = open(filepath, O_RDONLY | O_BINARY);
    if (fd < 0) {
        send_error(cl, 500, "Cannot open file");
        return;
    }

    /* Hint kernel: sequential access, don't keep in page cache.
     * Critical on low-RAM devices to prevent OOM during video streaming.
     * Note: fadvise values are NOT bitmask flags — call separately. */
    plat_fadvise_sequential(fd);
    plat_fadvise_noreuse(fd);

    off_t file_size = st.st_size;
    off_t start = 0, end = file_size - 1;
    int code = 200;

    if (range_start >= 0) {
        start = range_start;
        end = (range_end >= 0 && range_end < file_size) ? range_end : file_size - 1;
        if (start >= file_size || start > end) {
            close(fd);
            char body[128];
            int blen = snprintf(body, sizeof(body),
                "{\"error\":\"Range not satisfiable\"}");
            char header[256];
            int hlen = snprintf(header, sizeof(header),
                "HTTP/1.0 416 Range Not Satisfiable\r\n"
                "Content-Range: bytes */%lld\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: %d\r\n"
                "Connection: close\r\n\r\n",
                (long long)file_size, blen);
            cl->resp_buf = malloc(hlen + blen);
            if (cl->resp_buf) {
                memcpy(cl->resp_buf, header, hlen);
                memcpy(cl->resp_buf + hlen, body, blen);
                cl->resp_len = hlen + blen;
                cl->resp_sent = 0;
                cl->state = CS_WRITING;
            }
            return;
        }
        code = 206;
    }

    off_t content_length = end - start + 1;
    lseek(fd, start, SEEK_SET);

    char header[512];
    int hlen;
    if (code == 206) {
        hlen = snprintf(header, sizeof(header),
            "HTTP/1.0 206 Partial Content\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %lld\r\n"
            "Content-Range: bytes %lld-%lld/%lld\r\n"
            "Accept-Ranges: bytes\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n\r\n",
            content_type_for(filepath),
            (long long)content_length,
            (long long)start, (long long)end, (long long)file_size);
    } else {
        hlen = snprintf(header, sizeof(header),
            "HTTP/1.0 200 OK\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %lld\r\n"
            "Accept-Ranges: bytes\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n\r\n",
            content_type_for(filepath),
            (long long)content_length);
    }

    cl->resp_buf = malloc(hlen);
    if (!cl->resp_buf) { close(fd); return; }
    memcpy(cl->resp_buf, header, hlen);
    cl->resp_len = hlen;
    cl->resp_sent = 0;
    cl->file_fd = fd;
    cl->file_remaining = content_length;
    cl->state = CS_WRITING;
}

/* ── Auth check ───────────────────────────────────────────────────── */

static bool check_auth(webui_t *w, const char *req_buf)
{
    const char *auth = strstr(req_buf, "Authorization: Basic ");
    if (!auth) return false;
    auth += 21;

    char token[256];
    int i = 0;
    while (auth[i] && auth[i] != '\r' && auth[i] != '\n' && i < (int)sizeof(token) - 1) {
        token[i] = auth[i];
        i++;
    }
    token[i] = '\0';

    char decoded[256];
    base64_decode(token, decoded, sizeof(decoded));

    char expected[256];
    snprintf(expected, sizeof(expected), "%s:%s",
             w->app->cfg->webui_user, w->app->cfg->webui_pass);

    return strcmp(decoded, expected) == 0;
}

/* ── Request parsing ──────────────────────────────────────────────── */

typedef struct {
    char method[8];
    char path[512];
    char query[256];    /* query string after ? */
    const char *body;
    int body_len;
    int content_length;
    off_t range_start;  /* -1 = not specified */
    off_t range_end;    /* -1 = not specified */
} http_request_t;

static bool parse_request(const char *buf, int len, http_request_t *req)
{
    memset(req, 0, sizeof(*req));
    req->content_length = -1;
    req->range_start = -1;
    req->range_end = -1;

    const char *sp = strchr(buf, ' ');
    if (!sp) return false;
    int mlen = sp - buf;
    if (mlen >= (int)sizeof(req->method)) mlen = sizeof(req->method) - 1;
    memcpy(req->method, buf, mlen);
    req->method[mlen] = '\0';

    sp++;
    const char *sp2 = strchr(sp, ' ');
    if (!sp2) return false;
    int plen = sp2 - sp;
    if (plen >= (int)sizeof(req->path)) plen = sizeof(req->path) - 1;
    memcpy(req->path, sp, plen);
    req->path[plen] = '\0';

    char *qs = strchr(req->path, '?');
    if (qs) {
        *qs = '\0';
        snprintf(req->query, sizeof(req->query), "%s", qs + 1);
    }

    /* Parse Content-Length */
    const char *cl_hdr = strstr(buf, "Content-Length: ");
    if (!cl_hdr) cl_hdr = strstr(buf, "content-length: ");
    if (cl_hdr) req->content_length = atoi(cl_hdr + 16);

    /* Parse Range: bytes=START-END */
    const char *range_hdr = strstr(buf, "Range: bytes=");
    if (!range_hdr) range_hdr = strstr(buf, "range: bytes=");
    if (range_hdr) {
        range_hdr += 13; /* skip "Range: bytes=" */
        if (*range_hdr != '-')
            req->range_start = strtoll(range_hdr, NULL, 10);
        const char *dash = strchr(range_hdr, '-');
        if (dash && dash[1] >= '0' && dash[1] <= '9')
            req->range_end = strtoll(dash + 1, NULL, 10);
    }

    const char *body_start = strstr(buf, "\r\n\r\n");
    if (body_start) {
        body_start += 4;
        req->body = body_start;
        req->body_len = len - (body_start - buf);
    }

    return true;
}

/* Helper: extract query param value */
static int hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
}

static void url_decode(char *s)
{
    char *r = s, *w = s;
    while (*r) {
        if (*r == '%' && hex_digit(r[1]) >= 0 && hex_digit(r[2]) >= 0) {
            *w++ = (char)(hex_digit(r[1]) << 4 | hex_digit(r[2]));
            r += 3;
        } else if (*r == '+') {
            *w++ = ' ';
            r++;
        } else {
            *w++ = *r++;
        }
    }
    *w = '\0';
}

static const char *query_param(const char *query, const char *key, char *out, size_t out_sz)
{
    if (!query[0]) return NULL;
    size_t klen = strlen(key);
    const char *p = query;
    while (*p) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *val = p + klen + 1;
            int i = 0;
            while (val[i] && val[i] != '&' && i < (int)out_sz - 1) {
                out[i] = val[i]; i++;
            }
            out[i] = '\0';
            url_decode(out);
            return out;
        }
        p = strchr(p, '&');
        if (!p) break;
        p++;
    }
    return NULL;
}

/* ── Shell command helper ─────────────────────────────────────────── */

static char *run_cmd(const char *cmd)
{
    char *result = plat_run_cmd(cmd);
    return result ? result : strdup("");
}

/* ── Static file serving ──────────────────────────────────────────── */

static void serve_static(webui_client_t *cl, const char *url_path)
{
    if (strcmp(url_path, "/") == 0)
        url_path = "/index.html";

    if (strstr(url_path, "..")) {
        send_error(cl, 403, "Forbidden");
        return;
    }

    char filepath[MAX_PATH_LEN];
    snprintf(filepath, sizeof(filepath), "%s%s", WEBUI_WWW_ROOT, url_path);

    struct stat st;
    if (stat(filepath, &st) != 0 || !S_ISREG(st.st_mode)) {
        snprintf(filepath, sizeof(filepath), "%s/index.html", WEBUI_WWW_ROOT);
        if (stat(filepath, &st) != 0) {
            send_error(cl, 404, "Not Found");
            return;
        }
    }

    int fd = open(filepath, O_RDONLY | O_BINARY);
    if (fd < 0) {
        send_error(cl, 500, "Internal Server Error");
        return;
    }

    char *body = malloc(st.st_size);
    if (!body) { close(fd); send_error(cl, 500, "Out of memory"); return; }
    ssize_t n = read(fd, body, st.st_size);
    close(fd);
    if (n < 0) { free(body); send_error(cl, 500, "Read error"); return; }

    send_response(cl, 200, "OK", content_type_for(filepath), body, (int)n);
    free(body);
}

/* ── API: GET /api/status ─────────────────────────────────────────── */

/* Forward declarations for helpers defined later */
static cJSON *detect_config_to_json(const cam_detect_t *d);

static void api_get_status(webui_client_t *cl, webui_t *w)
{
    cJSON *j = cJSON_CreateObject();

    cJSON_AddStringToObject(j, "agent_id", w->app->cfg->id);
    cJSON_AddStringToObject(j, "version", w->app->version);
    cJSON_AddStringToObject(j, "tenant", w->app->cfg->tenant);
    cJSON_AddStringToObject(j, "store_id", w->app->cfg->store_id);
    cJSON_AddStringToObject(j, "alias", w->app->cfg->alias);
    cJSON_AddBoolToObject(j, "mqtt_connected", mqttc_connected(w->app->mqtt));
    cJSON_AddBoolToObject(j, "online", w->app->online);
    cJSON_AddNumberToObject(j, "upload_fail_count",
        (double)w->app->upload_fail_count);
    cJSON_AddStringToObject(j, "stream_server", w->app->cfg->stream_server);
    cJSON_AddNumberToObject(j, "agent_uptime",
        (double)(time(NULL) - w->app->started_at));

    cJSON_AddNumberToObject(j, "uptime", (double)plat_uptime_sec());
    cJSON_AddNumberToObject(j, "mem_total_mb", (double)plat_total_ram_mb());
    cJSON_AddNumberToObject(j, "mem_free_mb", (double)plat_free_ram_mb());
    cJSON_AddNumberToObject(j, "mem_buffers_mb", 0);
    {
        double load[3];
        plat_load_avg(load);
        cJSON_AddNumberToObject(j, "load", load[0]);
    }

    /* Disk info */
    int64_t disk = disk_free_mb(w->app->cfg->record_base);
    cJSON_AddNumberToObject(j, "disk_free_mb", (double)disk);
    cJSON_AddBoolToObject(j, "sd_available", w->app->cfg->sd_available);

    /* Temperature (Linux sysfs only) */
#ifdef PLAT_POSIX
    {
        FILE *tf = fopen("/sys/class/thermal/thermal_zone0/temp", "r");
        if (tf) {
            int temp_mc = 0;
            if (fscanf(tf, "%d", &temp_mc) == 1)
                cJSON_AddNumberToObject(j, "temperature", temp_mc / 1000.0);
            fclose(tf);
        }
    }
#endif

    /* Camera count */
    cJSON_AddNumberToObject(j, "camera_count", w->app->cfg->camera_count);

    /* Per-camera stream status */
    cJSON *cameras = cJSON_AddArrayToObject(j, "cameras");
    for (int i = 0; i < w->app->cfg->camera_count; i++) {
        cJSON *cam = cJSON_CreateObject();
        cJSON_AddStringToObject(cam, "id", w->app->cfg->cameras[i].id);
        cJSON_AddBoolToObject(cam, "enabled", w->app->cfg->cameras[i].enabled);
        cJSON_AddBoolToObject(cam, "streaming", w->app->streams[i].running);
        if (w->app->streams[i].running && w->app->streams[i].rtmp_url[0])
            cJSON_AddStringToObject(cam, "rtmp_url", w->app->streams[i].rtmp_url);
        cJSON_AddBoolToObject(cam, "detecting",
            w->app->detectors && w->app->detectors[i].running);
        cJSON_AddBoolToObject(cam, "detect_enabled",
            w->app->cfg->cameras[i].detect.enabled);
        cJSON_AddItemToArray(cameras, cam);
    }

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: GET /api/storage/info ───────────────────────────────────── */

static void add_storage_info(cJSON *parent, const char *name, const char *path)
{
    cJSON *s = cJSON_AddObjectToObject(parent, name);
    int64_t total = plat_disk_total_mb(path);
    int64_t free_mb = plat_disk_free_mb(path);
    if (total > 0 && free_mb >= 0) {
        double used = (double)(total - free_mb);
        cJSON_AddNumberToObject(s, "total_mb", (double)total);
        cJSON_AddNumberToObject(s, "used_mb", used);
        cJSON_AddNumberToObject(s, "free_mb", (double)free_mb);
        cJSON_AddNumberToObject(s, "percent", total > 0 ? (used / (double)total * 100.0) : 0);
        cJSON_AddStringToObject(s, "path", path);
    } else {
        cJSON_AddNumberToObject(s, "total_mb", 0);
        cJSON_AddNumberToObject(s, "used_mb", 0);
        cJSON_AddNumberToObject(s, "free_mb", 0);
        cJSON_AddNumberToObject(s, "percent", 0);
        cJSON_AddStringToObject(s, "path", path);
    }
}

static void api_get_storage_info(webui_client_t *cl, webui_t *w)
{
    cJSON *j = cJSON_CreateObject();

#ifdef PLAT_WINDOWS
    /* Enumerate all drives on Windows */
    plat_drive_info_t drives[26];
    int ndrive = plat_enumerate_drives(drives, 26);
    cJSON *arr = cJSON_AddArrayToObject(j, "drives");
    for (int i = 0; i < ndrive; i++) {
        cJSON *d = cJSON_CreateObject();
        char letter_str[4];
        snprintf(letter_str, sizeof(letter_str), "%c:", drives[i].letter);
        cJSON_AddStringToObject(d, "drive", letter_str);
        cJSON_AddStringToObject(d, "path", drives[i].path);
        cJSON_AddStringToObject(d, "label", drives[i].label);
        cJSON_AddStringToObject(d, "filesystem", drives[i].fstype);
        const char *dtype = "unknown";
        switch (drives[i].drive_type) {
            case 2: dtype = "removable"; break;
            case 3: dtype = "fixed";     break;
            case 4: dtype = "network";   break;
            case 5: dtype = "cdrom";     break;
        }
        cJSON_AddStringToObject(d, "type", dtype);
        cJSON_AddNumberToObject(d, "total_mb", (double)drives[i].total_mb);
        int64_t used = drives[i].total_mb - drives[i].free_mb;
        cJSON_AddNumberToObject(d, "used_mb", (double)(used > 0 ? used : 0));
        cJSON_AddNumberToObject(d, "free_mb", (double)drives[i].free_mb);
        double pct = drives[i].total_mb > 0
            ? (double)used / (double)drives[i].total_mb * 100.0 : 0;
        cJSON_AddNumberToObject(d, "percent", pct);
        cJSON_AddItemToArray(arr, d);
    }
    /* Also add a "internal" key for backward compatibility (first fixed drive) */
    for (int i = 0; i < ndrive; i++) {
        if (drives[i].drive_type == 3) {
            add_storage_info(j, "internal", drives[i].path);
            break;
        }
    }
#else
    add_storage_info(j, "internal", file_exists("/userdata") ? "/userdata" : "/");
#endif

    if (w->app->cfg->sd_available && w->app->cfg->sd_mount[0])
        add_storage_info(j, "external", w->app->cfg->sd_mount);
    else {
        cJSON *ext = cJSON_AddObjectToObject(j, "external");
        cJSON_AddBoolToObject(ext, "available", false);
    }

    cJSON_AddBoolToObject(j, "sd_available", w->app->cfg->sd_available);
    if (w->app->cfg->sd_mount[0])
        cJSON_AddStringToObject(j, "sd_mount", w->app->cfg->sd_mount);

    /* Expose runtime paths so the frontend can use them in the file browser */
    cJSON_AddStringToObject(j, "record_base", w->app->cfg->record_base);
    cJSON_AddStringToObject(j, "snapshot_dir", w->app->cfg->snapshot_dir);

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: POST /api/storage/sdcard/format ─────────────────────────── */

static void api_post_sdcard_format(webui_client_t *cl, const char *body, int body_len)
{
#ifdef PLAT_WINDOWS
    (void)body; (void)body_len;
    send_error(cl, 501, "SD card format not supported on Windows");
#else
    cJSON *j = body_len > 0 ? cJSON_ParseWithLength(body, body_len) : NULL;
    const char *fstype = "ext4";
    if (j) {
        cJSON *v = cJSON_GetObjectItem(j, "filesystem");
        if (v && v->valuestring) fstype = v->valuestring;
    }

    /* Find SD device */
    const char *devs[] = {"/dev/mmcblk0p1", "/dev/mmcblk0",
                          "/dev/mmcblk1p1", "/dev/mmcblk1", NULL};
    const char *dev = NULL;
    for (int i = 0; devs[i]; i++) {
        if (file_exists(devs[i])) { dev = devs[i]; break; }
    }

    if (!dev) {
        send_error(cl, 404, "No SD card detected");
        if (j) cJSON_Delete(j);
        return;
    }

    /* Unmount first */
    system("umount /mnt/sdcard 2>/dev/null");

    char cmd[256];
    if (strcmp(fstype, "vfat") == 0 || strcmp(fstype, "fat32") == 0)
        snprintf(cmd, sizeof(cmd), "mkfs.vfat %s 2>&1", dev);
    else
        snprintf(cmd, sizeof(cmd), "mkfs.ext4 -F %s 2>&1", dev);

    char *result = run_cmd(cmd);

    /* Re-mount */
    snprintf(cmd, sizeof(cmd), "mount %s /mnt/sdcard 2>/dev/null", dev);
    system(cmd);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", true);
    cJSON_AddStringToObject(resp, "output", result ? result : "");
    send_json(cl, 200, "OK", resp);
    cJSON_Delete(resp);
    free(result);
    if (j) cJSON_Delete(j);
#endif
}

/* ── API: POST /api/storage/sdcard/erase ──────────────────────────── */

static void api_post_sdcard_erase(webui_client_t *cl, webui_t *w)
{
#ifdef PLAT_WINDOWS
    (void)w;
    send_error(cl, 501, "SD card erase not supported on Windows");
#else
    if (!w->app->cfg->sd_available || !w->app->cfg->sd_mount[0]) {
        send_error(cl, 404, "No SD card mounted");
        return;
    }

    char cmd[MAX_PATH_LEN + 32];
    snprintf(cmd, sizeof(cmd), "rm -rf %s/records %s/snapshots",
             w->app->cfg->sd_mount, w->app->cfg->sd_mount);
    system(cmd);

    send_ok(cl, "SD card contents erased");
#endif
}

/* ── API: GET/POST /api/config ────────────────────────────────────── */

static void api_get_config(webui_client_t *cl, webui_t *w)
{
    agent_config_t *cfg = w->app->cfg;
    cJSON *j = cJSON_CreateObject();

    cJSON *agent = cJSON_AddObjectToObject(j, "agent");
    cJSON_AddStringToObject(agent, "id", cfg->id);
    cJSON_AddStringToObject(agent, "timezone", cfg->timezone);
    cJSON_AddBoolToObject(agent, "records_enabled", cfg->records_enabled);
    cJSON_AddNumberToObject(agent, "records_ttl", cfg->records_ttl);
    cJSON_AddBoolToObject(agent, "rtmps", cfg->rtmps);
    cJSON_AddStringToObject(agent, "stream_server", cfg->stream_server);
    cJSON_AddStringToObject(agent, "snapshots_url", cfg->snapshots_url);
    cJSON_AddStringToObject(agent, "callback_url", cfg->callback_url);
    cJSON_AddStringToObject(agent, "tenant", cfg->tenant);
    cJSON_AddStringToObject(agent, "store_id", cfg->store_id);
    cJSON_AddStringToObject(agent, "alias", cfg->alias);
    cJSON_AddNumberToObject(agent, "latitude", cfg->latitude);
    cJSON_AddNumberToObject(agent, "longitude", cfg->longitude);

    cJSON *mqtt = cJSON_AddObjectToObject(j, "mqtt");
    cJSON_AddStringToObject(mqtt, "host", cfg->mqtt_host);
    cJSON_AddNumberToObject(mqtt, "port", cfg->mqtt_port);

    cJSON *storage = cJSON_AddObjectToObject(j, "storage");
    cJSON_AddStringToObject(storage, "endpoint", cfg->s3_endpoint);
    cJSON_AddStringToObject(storage, "bucket", cfg->s3_bucket);
    cJSON_AddStringToObject(storage, "region", cfg->s3_region);
    cJSON_AddStringToObject(storage, "access_key", cfg->s3_key[0] ? "****" : "");
    cJSON_AddStringToObject(storage, "secret_key", cfg->s3_secret[0] ? "****" : "");

    cJSON *cams = cJSON_AddArrayToObject(j, "cameras");
    for (int i = 0; i < cfg->camera_count; i++) {
        cJSON *cam = cJSON_CreateObject();
        cJSON_AddStringToObject(cam, "id", cfg->cameras[i].id);
        cJSON_AddStringToObject(cam, "ip", cfg->cameras[i].ip);
        cJSON_AddBoolToObject(cam, "enabled", cfg->cameras[i].enabled);
        cJSON_AddStringToObject(cam, "record_path", cfg->cameras[i].record_path);
        cJSON_AddStringToObject(cam, "rtsp", cfg->cameras[i].rtsp);
        cJSON_AddStringToObject(cam, "resolution", cfg->cameras[i].resolution);
        /* Per-camera detection config */
        cJSON *det = detect_config_to_json(&cfg->cameras[i].detect);
        cJSON_AddItemToObject(cam, "detect", det);
        cJSON_AddItemToArray(cams, cam);
    }

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

static void api_post_config(webui_client_t *cl, webui_t *w,
                            const char *body, int body_len)
{
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    agent_config_t *cfg = w->app->cfg;

    cJSON *agent = cJSON_GetObjectItem(j, "agent");
    if (agent) {
        cJSON *v;
        if ((v = cJSON_GetObjectItem(agent, "id")))
            snprintf(cfg->id, sizeof(cfg->id), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "timezone")))
            snprintf(cfg->timezone, sizeof(cfg->timezone), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "records_enabled")))
            cfg->records_enabled = cJSON_IsTrue(v);
        if ((v = cJSON_GetObjectItem(agent, "records_ttl")))
            cfg->records_ttl = v->valueint;
        if ((v = cJSON_GetObjectItem(agent, "rtmps")))
            cfg->rtmps = cJSON_IsTrue(v);
        if ((v = cJSON_GetObjectItem(agent, "stream_server")))
            snprintf(cfg->stream_server, sizeof(cfg->stream_server), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "snapshots_url")))
            snprintf(cfg->snapshots_url, sizeof(cfg->snapshots_url), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "callback_url")))
            snprintf(cfg->callback_url, sizeof(cfg->callback_url), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "tenant")))
            snprintf(cfg->tenant, sizeof(cfg->tenant), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "store_id")))
            snprintf(cfg->store_id, sizeof(cfg->store_id), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "alias")))
            snprintf(cfg->alias, sizeof(cfg->alias), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(agent, "latitude")))
            cfg->latitude = v->valuedouble;
        if ((v = cJSON_GetObjectItem(agent, "longitude")))
            cfg->longitude = v->valuedouble;
    }

    cJSON *mqtt = cJSON_GetObjectItem(j, "mqtt");
    if (mqtt) {
        cJSON *v;
        if ((v = cJSON_GetObjectItem(mqtt, "host")))
            snprintf(cfg->mqtt_host, sizeof(cfg->mqtt_host), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(mqtt, "port")))
            cfg->mqtt_port = v->valueint;
    }

    cJSON *storage = cJSON_GetObjectItem(j, "storage");
    if (storage) {
        cJSON *v;
        if ((v = cJSON_GetObjectItem(storage, "endpoint")))
            snprintf(cfg->s3_endpoint, sizeof(cfg->s3_endpoint), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(storage, "bucket")))
            snprintf(cfg->s3_bucket, sizeof(cfg->s3_bucket), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(storage, "region")))
            snprintf(cfg->s3_region, sizeof(cfg->s3_region), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(storage, "access_key")) &&
            strcmp(v->valuestring, "****") != 0)
            snprintf(cfg->s3_key, sizeof(cfg->s3_key), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(storage, "secret_key")) &&
            strcmp(v->valuestring, "****") != 0)
            snprintf(cfg->s3_secret, sizeof(cfg->s3_secret), "%s", v->valuestring);
    }

    /* Cameras */
    cJSON *cams = cJSON_GetObjectItem(j, "cameras");
    if (cams && cJSON_IsArray(cams)) {
        int n = cJSON_GetArraySize(cams);
        if (n > MAX_CAMERAS) n = MAX_CAMERAS;
        cfg->camera_count = n;
        for (int i = 0; i < n; i++) {
            cJSON *cam = cJSON_GetArrayItem(cams, i);
            camera_t *c = &cfg->cameras[i];
            cJSON *v;
            if ((v = cJSON_GetObjectItem(cam, "id")))
                snprintf(c->id, sizeof(c->id), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "ip")))
                snprintf(c->ip, sizeof(c->ip), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "enabled")))
                c->enabled = cJSON_IsTrue(v);
            if ((v = cJSON_GetObjectItem(cam, "record_path")))
                snprintf(c->record_path, sizeof(c->record_path), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "rtsp")))
                snprintf(c->rtsp, sizeof(c->rtsp), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "resolution")))
                snprintf(c->resolution, sizeof(c->resolution), "%s", v->valuestring);
        }
    }

    config_save(w->app->config_path, cfg);
    config_save_secrets(w->app->secrets_path, cfg);

    cJSON_Delete(j);
    send_ok(cl, "Configuration saved");
}

/* ── API: GET/POST /api/network ───────────────────────────────────── */

static void api_get_network(webui_client_t *cl)
{
    cJSON *j = cJSON_CreateObject();

#ifdef PLAT_WINDOWS
    char *ifcfg = run_cmd("ipconfig /all");
    char ip[64] = "", mask[64] = "", gw[64] = "", dns_server[64] = "";

    if (ifcfg) {
        /* Parse IPv4 Address — locale-agnostic: look for "IPv4" keyword */
        char *p = strstr(ifcfg, "IPv4");
        if (!p) p = strstr(ifcfg, "IP Address");
        if (p) {
            p = strchr(p, ':');
            if (p) { p++; while (*p == ' ') p++; sscanf(p, "%63[^\r\n(]", ip); str_trim(ip); }
        }
        /* Parse Subnet Mask — locale-agnostic: look for line with "255." after the IPv4 line */
        p = strstr(ifcfg, "Subnet Mask");
        if (!p) p = strstr(ifcfg, "scara de subred");  /* Spanish */
        if (!p) p = strstr(ifcfg, "ubnet");             /* partial match */
        if (p) {
            p = strchr(p, ':');
            if (p) { p++; while (*p == ' ') p++; sscanf(p, "%63s", mask); }
        }
        /* Parse Default Gateway — locale-agnostic */
        p = strstr(ifcfg, "Default Gateway");
        if (!p) p = strstr(ifcfg, "uerta de enlace");   /* Spanish */
        if (!p) p = strstr(ifcfg, "ateway");             /* partial match */
        if (p) {
            p = strchr(p, ':');
            if (p) {
                p++; while (*p == ' ' || *p == '\r' || *p == '\n') p++;
                /* Skip IPv6 entries: scan lines until we find one with a digit followed by dot */
                for (int tries = 0; tries < 5 && *p; tries++) {
                    char token[64] = "";
                    sscanf(p, "%63[^\r\n ]", token);
                    /* IPv4 has dots and no colons */
                    if (strchr(token, '.') && !strchr(token, ':')) {
                        snprintf(gw, sizeof(gw), "%s", token);
                        break;
                    }
                    char *nl = strchr(p, '\n');
                    if (!nl) break;
                    p = nl + 1; while (*p == ' ') p++;
                }
            }
        }
        /* Parse DNS Servers — locale-agnostic */
        p = strstr(ifcfg, "DNS Servers");
        if (!p) p = strstr(ifcfg, "ervidores DNS");     /* Spanish */
        if (!p) p = strstr(ifcfg, "DNS");
        if (p) {
            p = strchr(p, ':');
            if (p) {
                p++; while (*p == ' ') p++;
                /* Skip IPv6 entries */
                for (int tries = 0; tries < 5 && *p; tries++) {
                    char token[64] = "";
                    sscanf(p, "%63[^\r\n ]", token);
                    if (strchr(token, '.') && !strchr(token, ':')) {
                        snprintf(dns_server, sizeof(dns_server), "%s", token);
                        break;
                    }
                    char *nl = strchr(p, '\n');
                    if (!nl) break;
                    p = nl + 1; while (*p == ' ') p++;
                }
            }
        }
    }

    cJSON_AddStringToObject(j, "ip", ip);
    cJSON_AddStringToObject(j, "netmask", mask);
    cJSON_AddStringToObject(j, "gateway", gw);
    cJSON_AddStringToObject(j, "dns", dns_server);
    cJSON_AddStringToObject(j, "raw_ifconfig", ifcfg ? ifcfg : "");
    cJSON_AddStringToObject(j, "raw_route", "");
    free(ifcfg);
#else
    char *ifcfg = run_cmd("ifconfig eth0 2>/dev/null || ifconfig 2>/dev/null");
    char *route = run_cmd("route -n 2>/dev/null || ip route 2>/dev/null");
    char *dns   = run_cmd("cat /etc/resolv.conf 2>/dev/null");

    char ip[64] = "", mask[64] = "", gw[64] = "", dns_server[64] = "";
    char *p = strstr(ifcfg, "inet addr:");
    if (p) sscanf(p + 10, "%63s", ip);
    else {
        p = strstr(ifcfg, "inet ");
        if (p) sscanf(p + 5, "%63s", ip);
    }
    p = strstr(ifcfg, "Mask:");
    if (p) sscanf(p + 5, "%63s", mask);
    else {
        p = strstr(ifcfg, "netmask ");
        if (p) sscanf(p + 8, "%63s", mask);
    }

    char *gw_line = strstr(route, "default");
    if (!gw_line) gw_line = strstr(route, "0.0.0.0");
    if (gw_line) {
        char *tok = gw_line;
        while (*tok && *tok != ' ' && *tok != '\t') tok++;
        while (*tok == ' ' || *tok == '\t') tok++;
        sscanf(tok, "%63s", gw);
    }

    char *ns = strstr(dns, "nameserver ");
    if (ns) sscanf(ns + 11, "%63s", dns_server);

    cJSON_AddStringToObject(j, "ip", ip);
    cJSON_AddStringToObject(j, "netmask", mask);
    cJSON_AddStringToObject(j, "gateway", gw);
    cJSON_AddStringToObject(j, "dns", dns_server);
    cJSON_AddStringToObject(j, "raw_ifconfig", ifcfg);
    cJSON_AddStringToObject(j, "raw_route", route);

    free(ifcfg); free(route); free(dns);
#endif

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

static void api_post_network(webui_client_t *cl, const char *body, int body_len)
{
#ifdef PLAT_WINDOWS
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cJSON *ip   = cJSON_GetObjectItem(j, "ip");
    cJSON *mask = cJSON_GetObjectItem(j, "netmask");
    cJSON *gw   = cJSON_GetObjectItem(j, "gateway");
    cJSON *dns  = cJSON_GetObjectItem(j, "dns");

    char cmd[512];
    if (ip && ip->valuestring && mask && mask->valuestring) {
        if (gw && gw->valuestring && gw->valuestring[0]) {
            snprintf(cmd, sizeof(cmd),
                "netsh interface ip set address \"Ethernet\" static %s %s %s >NUL 2>&1",
                ip->valuestring, mask->valuestring, gw->valuestring);
        } else {
            snprintf(cmd, sizeof(cmd),
                "netsh interface ip set address \"Ethernet\" static %s %s >NUL 2>&1",
                ip->valuestring, mask->valuestring);
        }
        system(cmd);
    }
    if (dns && dns->valuestring && dns->valuestring[0]) {
        snprintf(cmd, sizeof(cmd),
            "netsh interface ip set dns \"Ethernet\" static %s >NUL 2>&1",
            dns->valuestring);
        system(cmd);
    }

    cJSON_Delete(j);
    send_ok(cl, "Network settings applied");
#else
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cJSON *ip   = cJSON_GetObjectItem(j, "ip");
    cJSON *mask = cJSON_GetObjectItem(j, "netmask");
    cJSON *gw   = cJSON_GetObjectItem(j, "gateway");
    cJSON *dns  = cJSON_GetObjectItem(j, "dns");

    if (ip && ip->valuestring) {
        struct in_addr addr;
        if (inet_pton(AF_INET, ip->valuestring, &addr) != 1) {
            send_error(cl, 400, "Invalid IP address");
            cJSON_Delete(j);
            return;
        }
    }

    char cmd[512];
    if (ip && ip->valuestring && mask && mask->valuestring) {
        snprintf(cmd, sizeof(cmd), "ifconfig eth0 %s netmask %s",
                 ip->valuestring, mask->valuestring);
        system(cmd);
    }
    if (gw && gw->valuestring) {
        system("route del default 2>/dev/null");
        snprintf(cmd, sizeof(cmd), "route add default gw %s", gw->valuestring);
        system(cmd);
    }
    if (dns && dns->valuestring) {
        FILE *f = fopen("/etc/resolv.conf", "w");
        if (f) {
            fprintf(f, "nameserver %s\n", dns->valuestring);
            fclose(f);
        }
    }

    cJSON_Delete(j);
    send_ok(cl, "Network settings applied");
#endif
}

/* ── API: GET /api/camera/snapshot?cam=<id> ───────────────────────── */

static void api_get_snapshot(webui_client_t *cl, webui_t *w, const char *query)
{
    char cam_filter[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_filter, sizeof(cam_filter));

    /* Use configured snapshot_dir as primary, keep rkipc fallback on Linux */
    const char *cfg_dir = w->app->cfg->snapshot_dir;
#ifdef PLAT_WINDOWS
    const char *snap_dirs[] = { cfg_dir, NULL };
#else
    const char *snap_dirs[] = {
        cfg_dir, "/userdata/snapshot", NULL
    };
#endif

    char best[MAX_PATH_LEN] = "";
    time_t best_time = 0;

    for (int d = 0; snap_dirs[d]; d++) {
        DIR *dir = opendir(snap_dirs[d]);
        if (!dir) continue;
        struct dirent *ent;
        while ((ent = readdir(dir))) {
            const char *ext = strrchr(ent->d_name, '.');
            if (!ext || (strcmp(ext, ".jpg") != 0 && strcmp(ext, ".jpeg") != 0))
                continue;
            /* Filter by camera ID prefix if requested */
            if (cam_filter[0] && strncmp(ent->d_name, cam_filter, strlen(cam_filter)) != 0)
                continue;
            char path[MAX_PATH_LEN];
            snprintf(path, sizeof(path), "%s/%s", snap_dirs[d], ent->d_name);
            struct stat st;
            if (stat(path, &st) == 0 && st.st_mtime > best_time) {
                best_time = st.st_mtime;
                snprintf(best, sizeof(best), "%s", path);
            }
        }
        closedir(dir);
    }

    if (best[0] == '\0') {
        send_error(cl, 404, "No snapshot available");
        return;
    }

    struct stat st;
    if (stat(best, &st) != 0) { send_error(cl, 404, "Snapshot not found"); return; }

    int fd = open(best, O_RDONLY | O_BINARY);
    if (fd < 0) { send_error(cl, 500, "Cannot read snapshot"); return; }

    char *body = malloc(st.st_size);
    if (!body) { close(fd); send_error(cl, 500, "Out of memory"); return; }
    ssize_t n = read(fd, body, st.st_size);
    close(fd);

    if (n > 0) send_response(cl, 200, "OK", "image/jpeg", body, (int)n);
    else send_error(cl, 500, "Read error");
    free(body);
}

/* ── API: GET /api/hardware ──────────────────────────────────────── */

static int read_int_file(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    int v = 0;
    if (fscanf(f, "%d", &v) != 1) v = -1;
    fclose(f);
    return v;
}

static void read_str_file(const char *path, char *buf, size_t sz)
{
    FILE *f = fopen(path, "r");
    if (!f) { buf[0] = '\0'; return; }
    if (!fgets(buf, sz, f)) buf[0] = '\0';
    fclose(f);
    /* trim newline */
    size_t len = strlen(buf);
    while (len > 0 && (buf[len-1] == '\n' || buf[len-1] == '\r'))
        buf[--len] = '\0';
}

static void api_get_hardware(webui_client_t *cl)
{
    cJSON *j = cJSON_CreateObject();

#ifdef PLAT_WINDOWS
    {
        plat_os_info_t osi;
        plat_get_os_info(&osi);

        /* OS info */
        cJSON_AddStringToObject(j, "os_name", osi.os_name);
        cJSON_AddStringToObject(j, "os_version", osi.os_version);
        cJSON_AddStringToObject(j, "os_build", osi.os_build);
        cJSON_AddStringToObject(j, "hostname", osi.hostname);
        cJSON_AddStringToObject(j, "username", osi.username);

        /* CPU info */
        cJSON_AddStringToObject(j, "cpu_name", osi.cpu_name);
        cJSON_AddNumberToObject(j, "cpu_count", osi.cpu_count);
        if (osi.cpu_freq_mhz > 0)
            cJSON_AddNumberToObject(j, "cpu_freq_mhz", osi.cpu_freq_mhz);

        /* Memory */
        cJSON_AddNumberToObject(j, "mem_total_kb", (double)(osi.total_ram_mb * 1024));
        cJSON_AddNumberToObject(j, "mem_free_kb", (double)(osi.free_ram_mb * 1024));

        /* Drives */
        plat_drive_info_t drives[26];
        int ndrive = plat_enumerate_drives(drives, 26);
        cJSON *darr = cJSON_AddArrayToObject(j, "drives");
        for (int i = 0; i < ndrive; i++) {
            cJSON *d = cJSON_CreateObject();
            char letter_str[4];
            snprintf(letter_str, sizeof(letter_str), "%c:", drives[i].letter);
            cJSON_AddStringToObject(d, "drive", letter_str);
            cJSON_AddStringToObject(d, "label", drives[i].label);
            cJSON_AddStringToObject(d, "filesystem", drives[i].fstype);
            cJSON_AddNumberToObject(d, "total_mb", (double)drives[i].total_mb);
            cJSON_AddNumberToObject(d, "free_mb", (double)drives[i].free_mb);
            cJSON_AddItemToArray(darr, d);
        }

        /* Uptime */
        cJSON_AddNumberToObject(j, "uptime_sec", (double)plat_uptime_sec());

        /* Network link speed */
        {
            int link_speed = plat_get_link_speed_mbps(NULL);
            if (link_speed > 0)
                cJSON_AddNumberToObject(j, "link_speed_mbps", link_speed);
        }
    }
    cJSON_AddBoolToObject(j, "npu_available", false);
    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
    return;
#endif

    /* CPU frequency */
    int cur_freq = read_int_file("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq");
    int max_freq = read_int_file("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq");
    if (cur_freq > 0) cJSON_AddNumberToObject(j, "cpu_freq_mhz", cur_freq / 1000.0);
    if (max_freq > 0) cJSON_AddNumberToObject(j, "cpu_max_freq_mhz", max_freq / 1000.0);

    char gov[64];
    read_str_file("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", gov, sizeof(gov));
    if (gov[0]) cJSON_AddStringToObject(j, "cpu_governor", gov);

    /* CPU online */
    char online[32];
    read_str_file("/sys/devices/system/cpu/online", online, sizeof(online));
    if (online[0]) cJSON_AddStringToObject(j, "cpu_online", online);

    /* CPU usage from /proc/stat (snapshot — client computes delta) */
    FILE *sf = fopen("/proc/stat", "r");
    if (sf) {
        char line[256];
        if (fgets(line, sizeof(line), sf)) {
            unsigned long user, nice, sys, idle, iowait, irq, softirq;
            if (sscanf(line, "cpu %lu %lu %lu %lu %lu %lu %lu",
                       &user, &nice, &sys, &idle, &iowait, &irq, &softirq) == 7) {
                cJSON_AddNumberToObject(j, "cpu_user", (double)user);
                cJSON_AddNumberToObject(j, "cpu_nice", (double)nice);
                cJSON_AddNumberToObject(j, "cpu_system", (double)sys);
                cJSON_AddNumberToObject(j, "cpu_idle", (double)idle);
                cJSON_AddNumberToObject(j, "cpu_iowait", (double)iowait);
                cJSON_AddNumberToObject(j, "cpu_irq", (double)(irq + softirq));
            }
        }
        fclose(sf);
    }

    /* Memory from /proc/meminfo */
    FILE *mf = fopen("/proc/meminfo", "r");
    if (mf) {
        char line[128];
        while (fgets(line, sizeof(line), mf)) {
            unsigned long val;
            if (sscanf(line, "MemTotal: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "mem_total_kb", (double)val);
            else if (sscanf(line, "MemFree: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "mem_free_kb", (double)val);
            else if (sscanf(line, "MemAvailable: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "mem_available_kb", (double)val);
            else if (sscanf(line, "Buffers: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "mem_buffers_kb", (double)val);
            else if (sscanf(line, "Cached: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "mem_cached_kb", (double)val);
            else if (sscanf(line, "SwapTotal: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "swap_total_kb", (double)val);
            else if (sscanf(line, "SwapFree: %lu kB", &val) == 1)
                cJSON_AddNumberToObject(j, "swap_free_kb", (double)val);
        }
        fclose(mf);
    }

    /* NPU status */
    char npu_gov[64] = "";
    read_str_file("/sys/class/devfreq/fdab0000.npu/governor", npu_gov, sizeof(npu_gov));
    if (!npu_gov[0])
        read_str_file("/sys/class/devfreq/rknn/governor", npu_gov, sizeof(npu_gov));
    if (npu_gov[0]) {
        cJSON_AddStringToObject(j, "npu_governor", npu_gov);
        int npu_freq = read_int_file("/sys/class/devfreq/fdab0000.npu/cur_freq");
        if (npu_freq < 0)
            npu_freq = read_int_file("/sys/class/devfreq/rknn/cur_freq");
        if (npu_freq > 0) cJSON_AddNumberToObject(j, "npu_freq_mhz", npu_freq / 1000000.0);

        char npu_load[32] = "";
        read_str_file("/sys/class/devfreq/fdab0000.npu/load", npu_load, sizeof(npu_load));
        if (npu_load[0]) cJSON_AddStringToObject(j, "npu_load", npu_load);
    }
    cJSON_AddBoolToObject(j, "npu_available", npu_gov[0] != '\0');

    /* Network link speed */
    {
        int link_speed = plat_get_link_speed_mbps("eth0");
        if (link_speed > 0)
            cJSON_AddNumberToObject(j, "link_speed_mbps", link_speed);
    }

    /* Temperatures */
    cJSON *temps = cJSON_AddArrayToObject(j, "temperatures");
    for (int z = 0; z < 4; z++) {
        char path[64];
        snprintf(path, sizeof(path), "/sys/class/thermal/thermal_zone%d/temp", z);
        int temp = read_int_file(path);
        if (temp >= 0) {
            cJSON *t = cJSON_CreateObject();
            cJSON_AddNumberToObject(t, "zone", z);
            cJSON_AddNumberToObject(t, "temp_c", temp / 1000.0);
            cJSON_AddItemToArray(temps, t);
        }
    }

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: GET /api/network/traffic ───────────────────────────────── */

static void api_get_network_traffic(webui_client_t *cl)
{
    cJSON *j = cJSON_CreateObject();
    cJSON *ifaces = cJSON_AddArrayToObject(j, "interfaces");
    (void)ifaces;

#ifdef PLAT_WINDOWS
    /* Parse netstat -e output for total bytes */
    char *out = run_cmd("netstat -e");
    if (out) {
        /* Format:                   Received      Sent
         * Bytes              123456789  987654321 */
        char *line = strstr(out, "Bytes");
        if (line) {
            unsigned long long rx = 0, tx = 0;
            if (sscanf(line, "Bytes %llu %llu", &rx, &tx) == 2) {
                cJSON *iface = cJSON_CreateObject();
                cJSON_AddStringToObject(iface, "name", "Ethernet");
                cJSON_AddNumberToObject(iface, "rx_bytes", (double)rx);
                cJSON_AddNumberToObject(iface, "rx_packets", 0);
                cJSON_AddNumberToObject(iface, "rx_errors", 0);
                cJSON_AddNumberToObject(iface, "tx_bytes", (double)tx);
                cJSON_AddNumberToObject(iface, "tx_packets", 0);
                cJSON_AddNumberToObject(iface, "tx_errors", 0);
                cJSON_AddItemToArray(ifaces, iface);
            }
        }
        free(out);
    }
#else
    FILE *f = fopen("/proc/net/dev", "r");
    if (f) {
        char line[256];
        /* skip 2 header lines */
        if (fgets(line, sizeof(line), f)) {}
        if (fgets(line, sizeof(line), f)) {}
        while (fgets(line, sizeof(line), f)) {
            char name[32];
            unsigned long rx_bytes, rx_packets, rx_errs, rx_drop;
            unsigned long tx_bytes, tx_packets, tx_errs, tx_drop;
            unsigned long dummy;
            char *colon = strchr(line, ':');
            if (!colon) continue;
            *colon = ' ';
            if (sscanf(line, " %31s %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu %lu",
                       name,
                       &rx_bytes, &rx_packets, &rx_errs, &rx_drop,
                       &dummy, &dummy, &dummy, &dummy,
                       &tx_bytes, &tx_packets, &tx_errs, &tx_drop,
                       &dummy, &dummy, &dummy, &dummy) >= 13) {
                if (strcmp(name, "lo") == 0) continue;
                cJSON *iface = cJSON_CreateObject();
                cJSON_AddStringToObject(iface, "name", name);
                cJSON_AddNumberToObject(iface, "rx_bytes", (double)rx_bytes);
                cJSON_AddNumberToObject(iface, "rx_packets", (double)rx_packets);
                cJSON_AddNumberToObject(iface, "rx_errors", (double)rx_errs);
                cJSON_AddNumberToObject(iface, "tx_bytes", (double)tx_bytes);
                cJSON_AddNumberToObject(iface, "tx_packets", (double)tx_packets);
                cJSON_AddNumberToObject(iface, "tx_errors", (double)tx_errs);
                cJSON_AddItemToArray(ifaces, iface);
            }
        }
        fclose(f);
    }
#endif

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── Helper: find camera by id ───────────────────────────────────── */

static camera_t *find_camera(agent_config_t *cfg, const char *cam_id)
{
    for (int i = 0; i < cfg->camera_count; i++) {
        if (strcmp(cfg->cameras[i].id, cam_id) == 0)
            return &cfg->cameras[i];
    }
    return NULL;
}

static int find_camera_index(const agent_config_t *cfg, const char *cam_id)
{
    for (int i = 0; i < cfg->camera_count; i++) {
        if (strcmp(cfg->cameras[i].id, cam_id) == 0)
            return i;
    }
    return -1;
}

/* ── Build detect config JSON for a single camera ────────────────── */

static cJSON *detect_config_to_json(const cam_detect_t *d)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "enabled", d->enabled);
    cJSON_AddStringToObject(j, "mode", detect_mode_str(d->mode));
    cJSON_AddStringToObject(j, "plugin", d->plugin[0] ? d->plugin : "yolo");
    cJSON_AddNumberToObject(j, "poll_interval",
                            d->poll_interval > 0 ? d->poll_interval : 2);
    cJSON_AddStringToObject(j, "model", d->model);
    cJSON_AddNumberToObject(j, "confidence", d->confidence);
    cJSON_AddBoolToObject(j, "notify_mqtt", d->notify_mqtt);
    cJSON_AddStringToObject(j, "tracker", d->tracker);
    cJSON_AddNumberToObject(j, "fps", d->fps);
    cJSON_AddNumberToObject(j, "track_high_thresh", d->track_high_thresh);
    cJSON_AddNumberToObject(j, "track_low_thresh", d->track_low_thresh);
    cJSON_AddNumberToObject(j, "new_track_thresh", d->new_track_thresh);
    cJSON_AddNumberToObject(j, "track_buffer", d->track_buffer);
    cJSON_AddNumberToObject(j, "match_thresh", d->match_thresh);

    cJSON *targets = cJSON_AddArrayToObject(j, "targets");
    for (int i = 0; i < d->target_count; i++)
        cJSON_AddItemToArray(targets, cJSON_CreateString(d->targets[i]));

    return j;
}

/* ── API: GET/POST /api/yolo/config?cam=<id> ──────────────────────── */

static void api_get_yolo(webui_client_t *cl, webui_t *w, const char *query)
{
    agent_config_t *cfg = w->app->cfg;
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));

    if (cam_id[0]) {
        /* Single camera */
        camera_t *cam = find_camera(cfg, cam_id);
        if (!cam) { send_error(cl, 404, "Camera not found"); return; }
        cJSON *j = detect_config_to_json(&cam->detect);
        cJSON_AddStringToObject(j, "cam_id", cam->id);
        send_json(cl, 200, "OK", j);
        cJSON_Delete(j);
    } else {
        /* All cameras */
        cJSON *arr = cJSON_CreateArray();
        for (int i = 0; i < cfg->camera_count; i++) {
            cJSON *item = detect_config_to_json(&cfg->cameras[i].detect);
            cJSON_AddStringToObject(item, "cam_id", cfg->cameras[i].id);
            cJSON_AddItemToArray(arr, item);
        }
        cJSON *j = cJSON_CreateObject();
        cJSON_AddItemToObject(j, "cameras", arr);
        send_json(cl, 200, "OK", j);
        cJSON_Delete(j);
    }
}

static void api_post_yolo(webui_client_t *cl, webui_t *w,
                          const char *query, const char *body, int body_len)
{
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));
    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    camera_t *cam = find_camera(w->app->cfg, cam_id);
    if (!cam) { send_error(cl, 404, "Camera not found"); return; }

    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cam_detect_t *d = &cam->detect;
    cJSON *v;

    if ((v = cJSON_GetObjectItem(j, "enabled")))
        d->enabled = cJSON_IsTrue(v);
    if ((v = cJSON_GetObjectItem(j, "mode")) && v->valuestring)
        d->mode = detect_mode_parse(v->valuestring);
    if ((v = cJSON_GetObjectItem(j, "plugin")) && v->valuestring)
        snprintf(d->plugin, sizeof(d->plugin), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(j, "poll_interval")))
        d->poll_interval = v->valueint;
    if ((v = cJSON_GetObjectItem(j, "model")) && v->valuestring)
        snprintf(d->model, sizeof(d->model), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(j, "confidence")))
        d->confidence = (float)v->valuedouble;
    if ((v = cJSON_GetObjectItem(j, "notify_mqtt")))
        d->notify_mqtt = cJSON_IsTrue(v);
    if ((v = cJSON_GetObjectItem(j, "tracker")) && v->valuestring)
        snprintf(d->tracker, sizeof(d->tracker), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(j, "fps")))
        d->fps = v->valueint;
    if ((v = cJSON_GetObjectItem(j, "track_high_thresh")))
        d->track_high_thresh = (float)v->valuedouble;
    if ((v = cJSON_GetObjectItem(j, "track_low_thresh")))
        d->track_low_thresh = (float)v->valuedouble;
    if ((v = cJSON_GetObjectItem(j, "new_track_thresh")))
        d->new_track_thresh = (float)v->valuedouble;
    if ((v = cJSON_GetObjectItem(j, "track_buffer")))
        d->track_buffer = v->valueint;
    if ((v = cJSON_GetObjectItem(j, "match_thresh")))
        d->match_thresh = (float)v->valuedouble;

    cJSON *targets = cJSON_GetObjectItem(j, "targets");
    if (targets && cJSON_IsArray(targets)) {
        d->target_count = 0;
        int n = cJSON_GetArraySize(targets);
        for (int i = 0; i < n && i < MAX_YOLO_TARGETS; i++) {
            cJSON *t = cJSON_GetArrayItem(targets, i);
            if (t && t->valuestring)
                snprintf(d->targets[d->target_count++], MAX_TARGET_LEN,
                         "%s", t->valuestring);
        }
    }

    config_save(w->app->config_path, w->app->cfg);
    cJSON_Delete(j);
    send_ok(cl, "Detection settings saved");
}

/* ── API: GET/POST /api/yolo/zones?cam=<id> ──────────────────────── */

static void api_get_zones(webui_client_t *cl, webui_t *w, const char *query)
{
    agent_config_t *cfg = w->app->cfg;
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));

    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    camera_t *cam = find_camera(cfg, cam_id);
    if (!cam) { send_error(cl, 404, "Camera not found"); return; }

    const cam_detect_t *d = &cam->detect;
    cJSON *j = cJSON_CreateObject();

    cJSON *zones = cJSON_AddArrayToObject(j, "zones");
    for (int i = 0; i < d->zone_count; i++) {
        const detect_zone_t *z = &d->zones[i];
        cJSON *zone = cJSON_CreateObject();
        cJSON_AddStringToObject(zone, "name", z->name);
        cJSON_AddBoolToObject(zone, "enabled", z->enabled);
        cJSON *pts = cJSON_AddArrayToObject(zone, "points");
        for (int p = 0; p < z->point_count; p++) {
            cJSON *pt = cJSON_CreateArray();
            cJSON_AddItemToArray(pt, cJSON_CreateNumber(z->points[p][0]));
            cJSON_AddItemToArray(pt, cJSON_CreateNumber(z->points[p][1]));
            cJSON_AddItemToArray(pts, pt);
        }
        cJSON_AddItemToArray(zones, zone);
    }

    cJSON *lines = cJSON_AddArrayToObject(j, "lines");
    for (int i = 0; i < d->line_count; i++) {
        const detect_line_t *l = &d->lines[i];
        cJSON *line = cJSON_CreateObject();
        cJSON_AddStringToObject(line, "name", l->name);
        cJSON_AddBoolToObject(line, "enabled", l->enabled);
        cJSON_AddNumberToObject(line, "x1", l->x1);
        cJSON_AddNumberToObject(line, "y1", l->y1);
        cJSON_AddNumberToObject(line, "x2", l->x2);
        cJSON_AddNumberToObject(line, "y2", l->y2);
        cJSON_AddNumberToObject(line, "entry_count", l->entry_count);
        cJSON_AddNumberToObject(line, "exit_count", l->exit_count);
        cJSON_AddItemToArray(lines, line);
    }

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

static void api_post_zones(webui_client_t *cl, webui_t *w,
                           const char *query, const char *body, int body_len)
{
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));
    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    camera_t *cam = find_camera(w->app->cfg, cam_id);
    if (!cam) { send_error(cl, 404, "Camera not found"); return; }

    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cam_detect_t *d = &cam->detect;

    cJSON *zones = cJSON_GetObjectItem(j, "zones");
    if (zones && cJSON_IsArray(zones)) {
        d->zone_count = 0;
        int n = cJSON_GetArraySize(zones);
        for (int i = 0; i < n && i < MAX_ZONES; i++) {
            cJSON *z = cJSON_GetArrayItem(zones, i);
            detect_zone_t *dz = &d->zones[d->zone_count];
            memset(dz, 0, sizeof(*dz));

            cJSON *v;
            if ((v = cJSON_GetObjectItem(z, "name")) && v->valuestring)
                snprintf(dz->name, sizeof(dz->name), "%s", v->valuestring);
            else
                snprintf(dz->name, sizeof(dz->name), "Zone %d", i + 1);
            if ((v = cJSON_GetObjectItem(z, "enabled")))
                dz->enabled = cJSON_IsTrue(v);
            else
                dz->enabled = true;

            cJSON *pts = cJSON_GetObjectItem(z, "points");
            if (pts && cJSON_IsArray(pts)) {
                int np = cJSON_GetArraySize(pts);
                for (int p = 0; p < np && p < MAX_ZONE_POINTS; p++) {
                    cJSON *pt = cJSON_GetArrayItem(pts, p);
                    if (pt && cJSON_IsArray(pt) && cJSON_GetArraySize(pt) >= 2) {
                        dz->points[p][0] = (float)cJSON_GetArrayItem(pt, 0)->valuedouble;
                        dz->points[p][1] = (float)cJSON_GetArrayItem(pt, 1)->valuedouble;
                        dz->point_count++;
                    }
                }
            }
            d->zone_count++;
        }
    }

    cJSON *lines = cJSON_GetObjectItem(j, "lines");
    if (lines && cJSON_IsArray(lines)) {
        d->line_count = 0;
        int n = cJSON_GetArraySize(lines);
        for (int i = 0; i < n && i < MAX_LINES; i++) {
            cJSON *l = cJSON_GetArrayItem(lines, i);
            detect_line_t *dl = &d->lines[d->line_count];
            memset(dl, 0, sizeof(*dl));

            cJSON *v;
            if ((v = cJSON_GetObjectItem(l, "name")) && v->valuestring)
                snprintf(dl->name, sizeof(dl->name), "%s", v->valuestring);
            else
                snprintf(dl->name, sizeof(dl->name), "Line %d", i + 1);
            if ((v = cJSON_GetObjectItem(l, "enabled")))
                dl->enabled = cJSON_IsTrue(v);
            else
                dl->enabled = true;
            if ((v = cJSON_GetObjectItem(l, "x1"))) dl->x1 = (float)v->valuedouble;
            if ((v = cJSON_GetObjectItem(l, "y1"))) dl->y1 = (float)v->valuedouble;
            if ((v = cJSON_GetObjectItem(l, "x2"))) dl->x2 = (float)v->valuedouble;
            if ((v = cJSON_GetObjectItem(l, "y2"))) dl->y2 = (float)v->valuedouble;
            d->line_count++;
        }
    }

    /* Save zones to file */
#ifdef PLAT_WINDOWS
    config_save_zones(".", w->app->cfg);
#else
    config_save_zones("/userdata/streamhub", w->app->cfg);
#endif

    cJSON_Delete(j);
    send_ok(cl, "Detection zones saved");
}

/* ── API: detection preview/events/start/stop ────────────────────── */

#include "detect.h"

static void api_get_detection_preview(webui_client_t *cl, webui_t *w,
                                       const char *query)
{
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));
    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    int idx = find_camera_index(w->app->cfg, cam_id);
    if (idx < 0) { send_error(cl, 404, "Camera not found"); return; }

    detect_ctx_t *dc = w->app->detectors ? &w->app->detectors[idx] : NULL;
    if (!dc || !dc->running) {
        send_error(cl, 404, "Detection not running");
        return;
    }

    /* Only edge mode produces a locally annotated frame. In remote mode the
     * annotated view is the plugin's player-overlay on the StreamHub player. */
    if (dc->mode != DETECT_MODE_EDGE) {
        send_error(cl, 404,
            "No local preview: detection runs on the StreamHub instance "
            "(enable edge mode for an on-device preview)");
        return;
    }

    const char *path = detect_preview_path(dc);
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size <= 0) {
        send_error(cl, 404, "No preview available yet");
        return;
    }

    FILE *f = fopen(path, "rb");
    if (!f) { send_error(cl, 500, "Cannot read preview"); return; }

    char *buf = malloc(st.st_size);
    if (!buf) { fclose(f); send_error(cl, 500, "OOM"); return; }
    size_t got = fread(buf, 1, st.st_size, f);
    fclose(f);
    if (got != (size_t)st.st_size) { free(buf); send_error(cl, 500, "Short read"); return; }

    char hdr[256];
    int hlen = snprintf(hdr, sizeof(hdr),
        "HTTP/1.0 200 OK\r\n"
        "Content-Type: image/jpeg\r\n"
        "Content-Length: %ld\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: close\r\n\r\n", (long)st.st_size);
    sock_write(cl->fd, hdr, hlen);
    sock_write(cl->fd, buf, (int)st.st_size);
    free(buf);
    cl->state = CS_IDLE;
}

static void api_get_detection_events(webui_client_t *cl, webui_t *w,
                                      const char *query)
{
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));
    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    int idx = find_camera_index(w->app->cfg, cam_id);
    if (idx < 0) { send_error(cl, 404, "Camera not found"); return; }

    if (!w->app->detectors) {
        send_error(cl, 404, "Detection not initialized");
        return;
    }

    char buf[4096];
    int n = detect_read_events(&w->app->detectors[idx], buf, sizeof(buf));
    if (n <= 0) {
        /* Return empty object */
        snprintf(buf, sizeof(buf), "{\"count\":0,\"detections\":[],\"line_counts\":{}}");
        n = (int)strlen(buf);
    }

    char hdr[256];
    int hlen = snprintf(hdr, sizeof(hdr),
        "HTTP/1.0 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: close\r\n\r\n", n);
    sock_write(cl->fd, hdr, hlen);
    sock_write(cl->fd, buf, n);
    cl->state = CS_IDLE;
}

static void api_post_detection_start(webui_client_t *cl, webui_t *w,
                                      const char *query)
{
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));
    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    int idx = find_camera_index(w->app->cfg, cam_id);
    if (idx < 0) { send_error(cl, 404, "Camera not found"); return; }

    if (!w->app->detectors) {
        send_error(cl, 500, "Detection not initialized");
        return;
    }

    if (w->app->detectors[idx].running) {
        send_ok(cl, "Detection already running");
        return;
    }

    if (detect_start(&w->app->detectors[idx], w->app->cfg,
                     &w->app->cfg->cameras[idx]) == 0)
        send_ok(cl, "Detection started");
    else
        send_error(cl, 500, "Failed to start detection");
}

static void api_post_detection_stop(webui_client_t *cl, webui_t *w,
                                     const char *query)
{
    char cam_id[MAX_ID_LEN] = "";
    query_param(query, "cam", cam_id, sizeof(cam_id));
    if (!cam_id[0]) { send_error(cl, 400, "Missing cam parameter"); return; }

    int idx = find_camera_index(w->app->cfg, cam_id);
    if (idx < 0) { send_error(cl, 404, "Camera not found"); return; }

    if (!w->app->detectors) {
        send_error(cl, 500, "Detection not initialized");
        return;
    }

    detect_stop(&w->app->detectors[idx]);
    send_ok(cl, "Detection stopped");
}

/* ── API: POST /api/system/password ───────────────────────────────── */

static void api_post_password(webui_client_t *cl, webui_t *w,
                               const char *body, int body_len)
{
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cJSON *cur = cJSON_GetObjectItem(j, "current");
    cJSON *new_pass = cJSON_GetObjectItem(j, "new");

    if (!cur || !cur->valuestring || !new_pass || !new_pass->valuestring) {
        send_error(cl, 400, "Missing current or new password");
        cJSON_Delete(j);
        return;
    }

    /* Verify current password */
    if (strcmp(cur->valuestring, w->app->cfg->webui_pass) != 0) {
        send_error(cl, 403, "Current password is incorrect");
        cJSON_Delete(j);
        return;
    }

    if (strlen(new_pass->valuestring) < 3) {
        send_error(cl, 400, "Password too short (min 3 chars)");
        cJSON_Delete(j);
        return;
    }

    snprintf(w->app->cfg->webui_pass, sizeof(w->app->cfg->webui_pass),
             "%s", new_pass->valuestring);
    config_save(w->app->config_path, w->app->cfg);

    cJSON_Delete(j);
    send_ok(cl, "Password changed. Please re-login.");
}

/* ── API: POST /api/camera/snapshot/live ──────────────────────────── */

static void api_post_snapshot_live(webui_client_t *cl, webui_t *w,
                                    const char *body, int body_len)
{
    cJSON *j = body_len > 0 ? cJSON_ParseWithLength(body, body_len) : NULL;
    const char *cam_id = NULL;
    if (j) {
        cJSON *v = cJSON_GetObjectItem(j, "camera_id");
        if (v && v->valuestring) cam_id = v->valuestring;
    }

    /* Find the camera (or use first available) */
    camera_t *cam = NULL;
    for (int i = 0; i < w->app->cfg->camera_count; i++) {
        if (!w->app->cfg->cameras[i].enabled) continue;
        if (!cam_id || strcmp(w->app->cfg->cameras[i].id, cam_id) == 0) {
            cam = &w->app->cfg->cameras[i];
            break;
        }
    }

    if (!cam) {
        send_error(cl, 404, "Camera not found");
        if (j) cJSON_Delete(j);
        return;
    }

    /* Capture snapshot to temp file */
    char path[MAX_PATH_LEN];
#ifdef PLAT_WINDOWS
    snprintf(path, sizeof(path), "live_%s_%d.jpg", cam->id, (int)time(NULL));
#else
    snprintf(path, sizeof(path), "/tmp/live_%s_%d.jpg", cam->id, (int)time(NULL));
#endif

    if (snapshot_capture(w->app->cfg, cam, path) != 0) {
        send_error(cl, 500, "Snapshot capture failed");
        if (j) cJSON_Delete(j);
        return;
    }

    /* Read and serve the JPEG */
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size == 0) {
        send_error(cl, 500, "Captured file is empty");
        remove(path);
        if (j) cJSON_Delete(j);
        return;
    }

    int fd = open(path, O_RDONLY | O_BINARY);
    if (fd < 0) { send_error(cl, 500, "Cannot read snapshot"); remove(path); if (j) cJSON_Delete(j); return; }
    char *img = malloc(st.st_size);
    if (!img) { close(fd); remove(path); send_error(cl, 500, "Out of memory"); if (j) cJSON_Delete(j); return; }
    ssize_t n = read(fd, img, st.st_size);
    close(fd);
    remove(path);

    if (n > 0) send_response(cl, 200, "OK", "image/jpeg", img, (int)n);
    else send_error(cl, 500, "Read error");
    free(img);
    if (j) cJSON_Delete(j);
}

/* ── API: GET /api/speedtest ─────────────────────────────────────── */

static void api_get_speedtest(webui_client_t *cl, webui_t *w)
{
    cJSON *j = cJSON_CreateObject();
    int cam_count = w->app->cfg->camera_count;
    cJSON_AddNumberToObject(j, "camera_count", cam_count);

    /* Ping test to Wasabi S3 endpoint */
#ifdef PLAT_WINDOWS
    char *ping_out = run_cmd("ping -n 3 -w 2000 s3.us-east-1.wasabisys.com");
    /* Windows ping output: "Average = 25ms" */
    if (ping_out && ping_out[0]) {
        float rtt_avg = 0;
        char *avg_str = strstr(ping_out, "Average = ");
        if (avg_str) sscanf(avg_str + 10, "%f", &rtt_avg);
        char *min_str = strstr(ping_out, "Minimum = ");
        char *max_str = strstr(ping_out, "Maximum = ");
        float rtt_min = rtt_avg, rtt_max = rtt_avg;
        if (min_str) sscanf(min_str + 10, "%f", &rtt_min);
        if (max_str) sscanf(max_str + 10, "%f", &rtt_max);
        cJSON_AddNumberToObject(j, "ping_min_ms", rtt_min);
        cJSON_AddNumberToObject(j, "ping_avg_ms", rtt_avg);
        cJSON_AddNumberToObject(j, "ping_max_ms", rtt_max);
    } else {
        cJSON_AddNumberToObject(j, "ping_avg_ms", -1);
    }
    free(ping_out);

    /* General latency */
    char *gping = run_cmd("ping -n 3 -w 2000 8.8.8.8");
    if (gping && gping[0]) {
        float avg = 0;
        char *avg_str = strstr(gping, "Average = ");
        if (avg_str) sscanf(avg_str + 10, "%f", &avg);
        cJSON_AddNumberToObject(j, "latency_ms", avg);
    }
    free(gping);

    /* Download speed: use curl (ships with Windows 10+)
     * 30s max-time gives enough time for TCP to ramp up on slow links */
    char *dl_out = run_cmd(
        "curl -s -o NUL -w \"%%{speed_download}\" --connect-timeout 10 --max-time 30 "
        "\"https://s3.us-east-1.wasabisys.com/my-bucket/archivo_100mb.zip\" 2>NUL");
    double dl_mbps = 0;
    if (dl_out && dl_out[0]) {
        double bytes_sec = atof(dl_out);
        if (bytes_sec > 0) dl_mbps = bytes_sec * 8.0 / 1000000.0;
    }
    free(dl_out);
    cJSON_AddNumberToObject(j, "download_mbps", dl_mbps);

    /* Upload speed: create 10MB temp file and upload via curl
     * 10MB is enough for TCP slow-start to finish and measure real throughput */
    char *ul_out = run_cmd(
        "powershell -Command \"$f=[IO.Path]::GetTempFileName();"
        "[IO.File]::WriteAllBytes($f,(New-Object byte[] 10485760));"
        "$r=curl.exe -s -o NUL -w '%{speed_upload}' --connect-timeout 10 --max-time 30 "
        "-X PUT -T $f 'https://s3.us-east-1.wasabisys.com/my-bucket/speedtest-tmp' 2>$null;"
        "Remove-Item $f; $r\"");
    double ul_mbps = 0;
    if (ul_out && ul_out[0]) {
        double bytes_sec = atof(ul_out);
        if (bytes_sec > 0) ul_mbps = bytes_sec * 8.0 / 1000000.0;
    }
    free(ul_out);
    cJSON_AddNumberToObject(j, "upload_mbps", ul_mbps);

#else
    char *ping_out = run_cmd("ping -c3 -W2 s3.us-east-1.wasabisys.com 2>/dev/null | tail -1");
    if (ping_out && ping_out[0]) {
        float rtt_min=0, rtt_avg=0, rtt_max=0;
        char *eq = strchr(ping_out, '=');
        if (eq) sscanf(eq+2, "%f/%f/%f", &rtt_min, &rtt_avg, &rtt_max);
        cJSON_AddNumberToObject(j, "ping_min_ms", rtt_min);
        cJSON_AddNumberToObject(j, "ping_avg_ms", rtt_avg);
        cJSON_AddNumberToObject(j, "ping_max_ms", rtt_max);
    } else {
        cJSON_AddNumberToObject(j, "ping_avg_ms", -1);
    }
    free(ping_out);

    char *gping = run_cmd("ping -c3 -W2 8.8.8.8 2>/dev/null | tail -1");
    if (gping && gping[0]) {
        float avg = 0;
        char *eq = strchr(gping, '=');
        if (eq) { float a; sscanf(eq+2, "%f/%f", &a, &avg); (void)a; }
        cJSON_AddNumberToObject(j, "latency_ms", avg);
    }
    free(gping);

    /* Download speed test — 30s timeout for accurate measurement */
    char *dl_out = run_cmd(
        "wget --timeout=30 -O /dev/null "
        "'https://s3.us-east-1.wasabisys.com/my-bucket/archivo_100mb.zip' "
        "2>&1 | tail -1");
    double dl_mbps = 0;
    if (dl_out && dl_out[0]) {
        char *p = dl_out;
        char *last_speed = NULL;
        while (*p) {
            if ((*p >= '0' && *p <= '9') || *p == '.') {
                char *end = p;
                while (*end && ((*end >= '0' && *end <= '9') || *end == '.')) end++;
                if (*end == 'M' || *end == 'K') { last_speed = p; }
                p = end;
            } else p++;
        }
        if (last_speed) {
            double speed = atof(last_speed);
            char *unit = last_speed;
            while (*unit && *unit != 'M' && *unit != 'K') unit++;
            if (*unit == 'M') dl_mbps = speed * 8.0;
            else if (*unit == 'K') dl_mbps = speed * 8.0 / 1024.0;
        }
    }
    free(dl_out);
    cJSON_AddNumberToObject(j, "download_mbps", dl_mbps);

    /* Upload speed — 10MB payload for accurate measurement */
    char *ul_out = run_cmd(
        "dd if=/dev/zero bs=1024 count=10240 2>/dev/null | "
        "wget --timeout=30 --post-file=- -O /dev/null "
        "'https://s3.us-east-1.wasabisys.com/my-bucket/' "
        "2>&1 | tail -1");
    double ul_mbps = 0;
    if (ul_out && ul_out[0]) {
        char *p = ul_out;
        char *last_speed = NULL;
        while (*p) {
            if ((*p >= '0' && *p <= '9') || *p == '.') {
                char *end = p;
                while (*end && ((*end >= '0' && *end <= '9') || *end == '.')) end++;
                if (*end == 'M' || *end == 'K') { last_speed = p; }
                p = end;
            } else p++;
        }
        if (last_speed) {
            double speed = atof(last_speed);
            char *unit = last_speed;
            while (*unit && *unit != 'M' && *unit != 'K') unit++;
            if (*unit == 'M') ul_mbps = speed * 8.0;
            else if (*unit == 'K') ul_mbps = speed * 8.0 / 1024.0;
        }
    }
    free(ul_out);
    cJSON_AddNumberToObject(j, "upload_mbps", ul_mbps);
#endif

    /* Star rating: 2 Mbps per camera required for both upload and download */
    double min_mbps = dl_mbps < ul_mbps ? dl_mbps : ul_mbps;
    double required = cam_count > 0 ? (2.0 * cam_count) : 2.0;
    int stars = (int)((min_mbps / required) * 5.0);
    if (stars > 5) stars = 5;
    if (stars < 0) stars = 0;
    if (ul_mbps <= 0 && dl_mbps > 0) {
        stars = (int)((dl_mbps / required) * 5.0);
        if (stars > 5) stars = 5;
    }

    cJSON_AddNumberToObject(j, "stars", stars);
    cJSON_AddNumberToObject(j, "required_mbps", required);

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: POST /api/system/reboot ─────────────────────────────────── */

static void api_post_reboot(webui_client_t *cl, webui_t *w)
{
    w->app->reboot_requested = true;
    send_ok(cl, "Rebooting in 3 seconds...");
}

/* ── API: POST /api/stream/start ──────────────────────────────────── */

static void api_post_stream_start(webui_client_t *cl, webui_t *w,
                                   const char *body, int body_len)
{
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cJSON *cam_id = cJSON_GetObjectItem(j, "camera_id");
    if (!cam_id || !cam_id->valuestring) {
        send_error(cl, 400, "Missing camera_id");
        cJSON_Delete(j);
        return;
    }

    for (int i = 0; i < w->app->cfg->camera_count; i++) {
        if (strcmp(w->app->cfg->cameras[i].id, cam_id->valuestring) == 0) {
            if (w->app->streams[i].running) {
                send_ok(cl, "Stream already running");
            } else {
                if (stream_start(&w->app->streams[i], w->app->cfg,
                                 &w->app->cfg->cameras[i]) == 0)
                    send_ok(cl, "Stream started");
                else
                    send_error(cl, 500, "Failed to start stream");
            }
            cJSON_Delete(j);
            return;
        }
    }

    send_error(cl, 404, "Camera not found");
    cJSON_Delete(j);
}

/* ── API: POST /api/stream/stop ──────────────────────────────────── */

static void api_post_stream_stop(webui_client_t *cl, webui_t *w,
                                  const char *body, int body_len)
{
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    cJSON *cam_id = cJSON_GetObjectItem(j, "camera_id");
    if (!cam_id || !cam_id->valuestring) {
        send_error(cl, 400, "Missing camera_id");
        cJSON_Delete(j);
        return;
    }

    for (int i = 0; i < w->app->cfg->camera_count; i++) {
        if (strcmp(w->app->cfg->cameras[i].id, cam_id->valuestring) == 0) {
            if (!w->app->streams[i].running) {
                send_ok(cl, "Stream not running");
            } else {
                stream_stop(&w->app->streams[i]);
                send_ok(cl, "Stream stopped");
            }
            cJSON_Delete(j);
            return;
        }
    }

    send_error(cl, 404, "Camera not found");
    cJSON_Delete(j);
}

/* ── API: POST /api/system/factory-reset ──────────────────────────── */

static void api_post_factory_reset(webui_client_t *cl, webui_t *w)
{
    config_factory_reset(w->app->cfg);
    config_save(w->app->config_path, w->app->cfg);
    config_save_secrets(w->app->secrets_path, w->app->cfg);

    /* Remove zones file */
#ifdef PLAT_WINDOWS
    remove("zones.json");
#else
    remove("/userdata/streamhub/zones.json");
#endif

    send_ok(cl, "Factory reset applied. Reboot recommended.");
}

/* ── API: GET /api/system/info ────────────────────────────────────── */

static void api_get_system_info(webui_client_t *cl, webui_t *w)
{
    cJSON *j = cJSON_CreateObject();

#ifdef PLAT_WINDOWS
    {
        plat_os_info_t osi;
        plat_get_os_info(&osi);
        cJSON_AddStringToObject(j, "sysname", "Windows");
        cJSON_AddStringToObject(j, "nodename", osi.hostname);
        cJSON_AddStringToObject(j, "release", osi.os_version);
        cJSON_AddStringToObject(j, "machine", "x86_64");
        cJSON_AddStringToObject(j, "os_name", osi.os_name);
        cJSON_AddStringToObject(j, "os_build", osi.os_build);
        cJSON_AddStringToObject(j, "username", osi.username);
        cJSON_AddStringToObject(j, "cpu_name", osi.cpu_name);
        cJSON_AddNumberToObject(j, "cpu_count", osi.cpu_count);
        cJSON_AddNumberToObject(j, "uptime_sec", (double)plat_uptime_sec());
    }
#else
    {
        struct utsname un;
        if (uname(&un) == 0) {
            cJSON_AddStringToObject(j, "sysname", un.sysname);
            cJSON_AddStringToObject(j, "nodename", un.nodename);
            cJSON_AddStringToObject(j, "release", un.release);
            cJSON_AddStringToObject(j, "machine", un.machine);
        }
    }
#endif

    cJSON_AddStringToObject(j, "version", w->app->version);
    cJSON_AddStringToObject(j, "agent_id", w->app->cfg->id);

    /* Network link speed */
    {
        int link_speed = plat_get_link_speed_mbps("eth0");
        if (link_speed > 0)
            cJSON_AddNumberToObject(j, "link_speed_mbps", link_speed);
    }

#ifdef PLAT_POSIX
    {
        char *kver = run_cmd("cat /proc/version 2>/dev/null");
        if (kver && kver[0]) {
            size_t len = strlen(kver);
            while (len > 0 && (kver[len-1] == '\n' || kver[len-1] == '\r'))
                kver[--len] = '\0';
            cJSON_AddStringToObject(j, "kernel_version", kver);
        }
        free(kver);
    }

    /* Temperature */
    {
        FILE *tf = fopen("/sys/class/thermal/thermal_zone0/temp", "r");
        if (tf) {
            int temp_mc = 0;
            if (fscanf(tf, "%d", &temp_mc) == 1)
                cJSON_AddNumberToObject(j, "temperature", temp_mc / 1000.0);
            fclose(tf);
        }
    }
#endif

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: GET /api/system/logs ────────────────────────────────────── */

static void api_get_logs(webui_client_t *cl)
{
#ifdef PLAT_WINDOWS
    char *logs = run_cmd(
        "powershell -Command \"Get-Content agent.log -Tail 200 -ErrorAction SilentlyContinue\"");
#else
    char *logs = run_cmd("tail -100 /var/log/messages 2>/dev/null || "
                         "tail -100 /tmp/agent.log 2>/dev/null || "
                         "dmesg | tail -50 2>/dev/null");
#endif
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "logs", logs ? logs : "");
    free(logs);
    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: GET /api/system/temperature ─────────────────────────────── */

static void api_get_temperature(webui_client_t *cl)
{
    cJSON *j = cJSON_CreateObject();

#ifdef PLAT_WINDOWS
    /* Try WMI via wmic for thermal zone */
    char *out = run_cmd(
        "wmic /namespace:\\\\root\\wmi path MSAcpi_ThermalZoneTemperature "
        "get CurrentTemperature /value 2>NUL");
    if (out && strstr(out, "CurrentTemperature=")) {
        char *eq = strstr(out, "CurrentTemperature=");
        int tenths_k = atoi(eq + 19);
        if (tenths_k > 0) {
            /* WMI returns temperature in tenths of Kelvin */
            double celsius = (tenths_k / 10.0) - 273.15;
            cJSON_AddNumberToObject(j, "cpu_temp", celsius);
        } else {
            cJSON_AddNumberToObject(j, "cpu_temp", -1);
        }
    } else {
        cJSON_AddNumberToObject(j, "cpu_temp", -1);
    }
    free(out);
#else
    FILE *tf = fopen("/sys/class/thermal/thermal_zone0/temp", "r");
    if (tf) {
        int temp_mc = 0;
        if (fscanf(tf, "%d", &temp_mc) == 1) {
            cJSON_AddNumberToObject(j, "cpu_temp", temp_mc / 1000.0);
        }
        fclose(tf);
    } else {
        cJSON_AddNumberToObject(j, "cpu_temp", -1);
    }

    /* Try additional thermal zones */
    for (int z = 1; z < 4; z++) {
        char path[64];
        snprintf(path, sizeof(path), "/sys/class/thermal/thermal_zone%d/temp", z);
        FILE *f = fopen(path, "r");
        if (f) {
            int t = 0;
            if (fscanf(f, "%d", &t) == 1) {
                char key[32];
                snprintf(key, sizeof(key), "zone%d_temp", z);
                cJSON_AddNumberToObject(j, key, t / 1000.0);
            }
            fclose(f);
        }
    }
#endif

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: GET /api/files?path=... ─────────────────────────────────── */

static void api_get_files(webui_client_t *cl, webui_t *w, const char *url_path)
{
    const agent_config_t *cfg = w->app->cfg;

    /* Extract path from URL after /api/files */
    const char *browse_path = cfg->record_base;

    /* browse_path sits inside url_path after "/api/files" */
    char resolved[MAX_PATH_LEN];
    if (strlen(url_path) > 11) {
        /* Skip "/api/files/" — the leading slash before the path */
        const char *raw = url_path + 11;
        snprintf(resolved, sizeof(resolved), "%s", raw);
    } else {
        snprintf(resolved, sizeof(resolved), "%s", cfg->record_base);
    }
    browse_path = resolved;

    /* Safety: prevent directory traversal */
    if (strstr(browse_path, "..")) {
        send_error(cl, 403, "Forbidden");
        return;
    }

    /* Helper: check if browse_path starts with allowed_dir,
     * accounting for "./" prefix that HTTP normalizes away */
    #define PATH_UNDER(bp, dir) ( \
        (strncmp((bp), (dir), strlen(dir)) == 0) || \
        ((dir)[0] == '.' && (dir)[1] == '/' && \
         strncmp((bp), (dir) + 2, strlen(dir) - 2) == 0) )

    /* Validate path is within allowed directories */
    int allowed = 0;
    if (cfg->record_base[0] && PATH_UNDER(browse_path, cfg->record_base))
        allowed = 1;
    if (cfg->snapshot_dir[0] && PATH_UNDER(browse_path, cfg->snapshot_dir))
        allowed = 1;
    if (cfg->sd_available && cfg->sd_mount[0] &&
        strncmp(browse_path, cfg->sd_mount, strlen(cfg->sd_mount)) == 0)
        allowed = 1;
#ifndef PLAT_WINDOWS
    if (strncmp(browse_path, "/userdata", 9) == 0)
        allowed = 1;
#endif
    #undef PATH_UNDER

    if (!allowed) {
        send_error(cl, 403, "Access denied");
        return;
    }

    /* Prepend "./" if record_base/snapshot_dir uses it and path doesn't */
    if (browse_path[0] != '.' && browse_path[0] != '/') {
        char tmp[MAX_PATH_LEN];
        snprintf(tmp, sizeof(tmp), "./%s", browse_path);
        snprintf(resolved, sizeof(resolved), "%s", tmp);
    }

    struct stat st;
    if (stat(browse_path, &st) != 0) {
        send_error(cl, 404, "Path not found");
        return;
    }

    /* If it's a file, serve it */
    if (S_ISREG(st.st_mode)) {
        int fd = open(browse_path, O_RDONLY | O_BINARY);
        if (fd < 0) { send_error(cl, 500, "Cannot read file"); return; }

        /* Cap file serving at 2MB */
        off_t sz = st.st_size > (2 * 1024 * 1024) ? (2 * 1024 * 1024) : st.st_size;
        char *body = malloc(sz);
        if (!body) { close(fd); send_error(cl, 500, "Out of memory"); return; }
        ssize_t n = read(fd, body, sz);
        close(fd);
        if (n > 0) send_response(cl, 200, "OK", content_type_for(browse_path), body, (int)n);
        else send_error(cl, 500, "Read error");
        free(body);
        return;
    }

    /* Directory listing */
    DIR *dir = opendir(browse_path);
    if (!dir) {
        send_error(cl, 500, "Cannot open directory");
        return;
    }

    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "path", browse_path);
    cJSON *entries = cJSON_AddArrayToObject(j, "entries");

    struct dirent *ent;
    while ((ent = readdir(dir))) {
        if (ent->d_name[0] == '.') continue;

        char full[MAX_PATH_LEN];
        snprintf(full, sizeof(full), "%s/%s", browse_path, ent->d_name);

        struct stat fst;
        if (stat(full, &fst) != 0) continue;

        cJSON *e = cJSON_CreateObject();
        cJSON_AddStringToObject(e, "name", ent->d_name);
        cJSON_AddBoolToObject(e, "is_dir", S_ISDIR(fst.st_mode));
        cJSON_AddNumberToObject(e, "size", (double)fst.st_size);
        cJSON_AddNumberToObject(e, "mtime", (double)fst.st_mtime);

        char fullpath[MAX_PATH_LEN];
        snprintf(fullpath, sizeof(fullpath), "%s/%s", browse_path, ent->d_name);
        cJSON_AddStringToObject(e, "path", fullpath);

        cJSON_AddItemToArray(entries, e);
    }
    closedir(dir);

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: POST /api/setup ─────────────────────────────────────────── */

static void api_post_setup(webui_client_t *cl, webui_t *w,
                           const char *body, int body_len)
{
    cJSON *j = cJSON_ParseWithLength(body, body_len);
    if (!j) { send_error(cl, 400, "Invalid JSON"); return; }

    /* New mode: {"domain":"media.example.com","agent_id":"agent-0001"} */
    cJSON *domain_j = cJSON_GetObjectItem(j, "domain");
    cJSON *agent_id_j = cJSON_GetObjectItem(j, "agent_id");

    if (domain_j && domain_j->valuestring && domain_j->valuestring[0] &&
        agent_id_j && agent_id_j->valuestring && agent_id_j->valuestring[0]) {

        agent_config_t *cfg = w->app->cfg;
        int rc = api_setup_import(domain_j->valuestring, agent_id_j->valuestring,
                                  cfg, w->app->config_path, w->app->secrets_path);
        cJSON_Delete(j);

        if (rc == 0) {
            /* Resolve runtime paths after config change */
            config_resolve_paths(cfg);
            send_ok(cl, "Setup imported from backend API. Reboot recommended.");
        } else {
            send_error(cl, 502, "Failed to import setup from backend API");
        }
        return;
    }

    /* Legacy mode: {"url":"https://..."} */
    cJSON *url = cJSON_GetObjectItem(j, "url");
    if (!url || !url->valuestring || !url->valuestring[0]) {
        send_error(cl, 400, "Missing 'domain'+'agent_id' or 'url' field");
        cJSON_Delete(j);
        return;
    }

    /* Fetch the setup URL using wget */
    char cmd[1024];
    snprintf(cmd, sizeof(cmd),
             "wget -q -O - '%s' 2>/dev/null || curl -s '%s' 2>/dev/null",
             url->valuestring, url->valuestring);
    char *response = run_cmd(cmd);
    cJSON_Delete(j);

    if (!response || !response[0]) {
        send_error(cl, 502, "Failed to fetch setup URL");
        free(response);
        return;
    }

    /* Parse the JSON response from setup URL */
    cJSON *setup = cJSON_Parse(response);
    free(response);
    if (!setup) {
        send_error(cl, 502, "Invalid JSON from setup URL");
        return;
    }

    /* Apply config from setup JSON */
    agent_config_t *cfg = w->app->cfg;
    cJSON *v;

    if ((v = cJSON_GetObjectItem(setup, "id")))
        snprintf(cfg->id, sizeof(cfg->id), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(setup, "tenant")))
        snprintf(cfg->tenant, sizeof(cfg->tenant), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(setup, "timezone")))
        snprintf(cfg->timezone, sizeof(cfg->timezone), "%s", v->valuestring);

    /* MQTT */
    cJSON *mqtt = cJSON_GetObjectItem(setup, "mqtt");
    if (mqtt) {
        if ((v = cJSON_GetObjectItem(mqtt, "host")))
            snprintf(cfg->mqtt_host, sizeof(cfg->mqtt_host), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(mqtt, "port")))
            cfg->mqtt_port = v->valueint;
    }

    /* S3 */
    cJSON *s3 = cJSON_GetObjectItem(setup, "s3");
    if (!s3) s3 = cJSON_GetObjectItem(setup, "storage");
    if (s3) {
        if ((v = cJSON_GetObjectItem(s3, "endpoint")))
            snprintf(cfg->s3_endpoint, sizeof(cfg->s3_endpoint), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "bucket")))
            snprintf(cfg->s3_bucket, sizeof(cfg->s3_bucket), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "region")))
            snprintf(cfg->s3_region, sizeof(cfg->s3_region), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "access_key")))
            snprintf(cfg->s3_key, sizeof(cfg->s3_key), "%s", v->valuestring);
        if ((v = cJSON_GetObjectItem(s3, "secret_key")))
            snprintf(cfg->s3_secret, sizeof(cfg->s3_secret), "%s", v->valuestring);
    }

    /* Callbacks */
    if ((v = cJSON_GetObjectItem(setup, "callback_url")))
        snprintf(cfg->callback_url, sizeof(cfg->callback_url), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(setup, "snapshots")))
        snprintf(cfg->snapshots_url, sizeof(cfg->snapshots_url), "%s", v->valuestring);
    if ((v = cJSON_GetObjectItem(setup, "stream_server"))) {
        snprintf(cfg->stream_server, sizeof(cfg->stream_server), "%s", v->valuestring);
        char *p8443 = strstr(cfg->stream_server, ":8443");
        if (p8443) { memmove(p8443 + 4, p8443 + 5, strlen(p8443 + 5) + 1); memcpy(p8443, ":443", 4); }
    }

    /* StreamHub API token */
    cJSON *sh = cJSON_GetObjectItem(setup, "streamhub");
    if (sh) {
        if ((v = cJSON_GetObjectItem(sh, "api_token")))
            snprintf(cfg->api_token, sizeof(cfg->api_token), "%s", v->valuestring);
    }

    /* Cameras */
    cJSON *cams = cJSON_GetObjectItem(setup, "cameras");
    if (cams && cJSON_IsArray(cams)) {
        cfg->camera_count = 0;
        int n = cJSON_GetArraySize(cams);
        for (int i = 0; i < n && i < MAX_CAMERAS; i++) {
            cJSON *cam = cJSON_GetArrayItem(cams, i);
            camera_t *c = &cfg->cameras[cfg->camera_count++];
            memset(c, 0, sizeof(*c));
            c->enabled = true;
            if ((v = cJSON_GetObjectItem(cam, "id")))
                snprintf(c->id, sizeof(c->id), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "ip")))
                snprintf(c->ip, sizeof(c->ip), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "rtsp")))
                snprintf(c->rtsp, sizeof(c->rtsp), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "resolution")))
                snprintf(c->resolution, sizeof(c->resolution), "%s", v->valuestring);
            if ((v = cJSON_GetObjectItem(cam, "record_path")))
                snprintf(c->record_path, sizeof(c->record_path), "%s", v->valuestring);
        }
    }

    cJSON_Delete(setup);

    /* Save both config and secrets */
    config_save(w->app->config_path, cfg);
    config_save_secrets(w->app->secrets_path, cfg);

    send_ok(cl, "Setup applied from URL. Reboot recommended.");
}

/* ── API: POST /api/system/firmware ───────────────────────────────── */

static void finish_firmware_upload(webui_client_t *cl, webui_t *w)
{
    (void)w;
    LOG_I("webui: firmware upload complete: %s", cl->upload_path);

#ifdef PLAT_WINDOWS
    /* Save as .new next to current exe */
    char new_path[MAX_PATH];
    snprintf(new_path, sizeof(new_path), "streamhub-agent.exe.new");
    if (rename(cl->upload_path, new_path) != 0) {
        /* Try copy + delete if rename fails (cross-volume) */
        if (plat_copy_file(cl->upload_path, new_path) != 0) {
            send_error(cl, 500, "Failed to save firmware update");
            return;
        }
        _unlink(cl->upload_path);
    }
    send_ok(cl, "Firmware uploaded as streamhub-agent.exe.new. Use apply to install.");
#else
    /* Make executable and move to binary location */
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "chmod +x %s", cl->upload_path);
    system(cmd);

    /* Move to the streamhub binary location */
    snprintf(cmd, sizeof(cmd), "mv %s /userdata/streamhub/streamhub-agent.new",
             cl->upload_path);
    if (system(cmd) != 0) {
        send_error(cl, 500, "Failed to install firmware");
        return;
    }

    /* Create upgrade script that runs on next boot or can be triggered */
    FILE *f = fopen("/userdata/streamhub/upgrade.sh", "w");
    if (f) {
        fprintf(f, "#!/bin/sh\n"
                "cp /userdata/streamhub/streamhub-agent /userdata/streamhub/streamhub-agent.bak\n"
                "mv /userdata/streamhub/streamhub-agent.new /userdata/streamhub/streamhub-agent\n"
                "rm -f /userdata/streamhub/upgrade.sh\n"
                "reboot\n");
        fclose(f);
        system("chmod +x /userdata/streamhub/upgrade.sh");
    }

    send_ok(cl, "Firmware uploaded. Run upgrade script or reboot to apply.");
#endif
}

/* ── API: GET /api/system/firmware/versions ────────────────────────── */

static void api_get_firmware_versions(webui_client_t *cl)
{
    cJSON *j = cJSON_CreateObject();

    cJSON_AddStringToObject(j, "current", "streamhub-agent");

#ifdef PLAT_WINDOWS
    {
        struct stat st;
        cJSON_AddBoolToObject(j, "has_backup",
            stat("streamhub-agent.exe.bak", &st) == 0);
        cJSON_AddBoolToObject(j, "has_pending",
            stat("streamhub-agent.exe.new", &st) == 0);
        cJSON_AddBoolToObject(j, "has_upgrade_script", 0);
    }
#else
    /* Check for backup */
    struct stat st;
    cJSON_AddBoolToObject(j, "has_backup",
        stat("/userdata/streamhub/streamhub-agent.bak", &st) == 0);
    cJSON_AddBoolToObject(j, "has_pending",
        stat("/userdata/streamhub/streamhub-agent.new", &st) == 0);
    cJSON_AddBoolToObject(j, "has_upgrade_script",
        stat("/userdata/streamhub/upgrade.sh", &st) == 0);
#endif

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: POST /api/system/firmware/rollback ──────────────────────── */

static void api_post_firmware_rollback(webui_client_t *cl, webui_t *w)
{
#ifdef PLAT_WINDOWS
    struct stat st;
    if (stat("streamhub-agent.exe.bak", &st) != 0) {
        send_error(cl, 404, "No backup firmware found");
        return;
    }
    /* Swap current <-> bak: current→.tmp, bak→current, .tmp→bak */
    rename("streamhub-agent.exe", "streamhub-agent.exe.tmp");
    rename("streamhub-agent.exe.bak", "streamhub-agent.exe");
    rename("streamhub-agent.exe.tmp", "streamhub-agent.exe.bak");
    w->app->reboot_requested = true;
    send_ok(cl, "Rolled back. Service will restart with previous version.");
    return;
#else
    struct stat st;
    if (stat("/userdata/streamhub/streamhub-agent.bak", &st) != 0) {
        send_error(cl, 404, "No backup firmware found");
        return;
    }

    system("cp /userdata/streamhub/streamhub-agent /userdata/streamhub/streamhub-agent.new");
    system("mv /userdata/streamhub/streamhub-agent.bak /userdata/streamhub/streamhub-agent");
    system("mv /userdata/streamhub/streamhub-agent.new /userdata/streamhub/streamhub-agent.bak");

    w->app->reboot_requested = true;
    send_ok(cl, "Rolled back to previous firmware. Rebooting...");
#endif
}

/* ── API: POST /api/system/firmware/apply ─────────────────────────── */

static void api_post_firmware_apply(webui_client_t *cl, webui_t *w)
{
#ifdef PLAT_WINDOWS
    {
        struct stat st;
        if (stat("streamhub-agent.exe.new", &st) != 0) {
            send_error(cl, 404, "No pending firmware update");
            return;
        }
        /* current→.bak, .new→current */
        _unlink("streamhub-agent.exe.bak");
        rename("streamhub-agent.exe", "streamhub-agent.exe.bak");
        rename("streamhub-agent.exe.new", "streamhub-agent.exe");
        send_ok(cl, "Firmware applied. Service will restart with new version.");
        w->app->reboot_requested = true;
    }
#else
    struct stat st;
    if (stat("/userdata/streamhub/upgrade.sh", &st) != 0) {
        send_error(cl, 404, "No pending firmware upgrade");
        return;
    }

    send_ok(cl, "Applying firmware upgrade and rebooting...");

    /* Schedule the upgrade */
    w->app->reboot_requested = true;
#endif
}

/* ── API: GET /api/recordings?cam=X&date=YYYY-MM-DD ───────────────── */

static void api_get_recordings(webui_client_t *cl, webui_t *w, const char *query)
{
    const char *base = w->app->cfg->record_base;
    char cam_filter[MAX_ID_LEN] = "";
    char date_filter[16] = "";
    query_param(query, "cam", cam_filter, sizeof(cam_filter));
    query_param(query, "date", date_filter, sizeof(date_filter));

    /* Security: block traversal */
    if (strstr(cam_filter, "..") || strstr(date_filter, "..")) {
        send_error(cl, 403, "Forbidden");
        return;
    }

    cJSON *j = cJSON_CreateObject();

    /* Always list cameras (subdirectories of record_base) */
    cJSON *cameras = cJSON_AddArrayToObject(j, "cameras");
    DIR *dbase = opendir(base);
    if (dbase) {
        struct dirent *ent;
        while ((ent = readdir(dbase))) {
            if (ent->d_name[0] == '.') continue;
            char cpath[MAX_PATH_LEN];
            snprintf(cpath, sizeof(cpath), "%s/%s", base, ent->d_name);
            struct stat st;
            if (stat(cpath, &st) == 0 && S_ISDIR(st.st_mode)) {
                cJSON *cam = cJSON_CreateObject();
                cJSON_AddStringToObject(cam, "id", ent->d_name);
                cJSON_AddItemToArray(cameras, cam);
            }
        }
        closedir(dbase);
    }

    /* If cam given, list dates */
    if (cam_filter[0]) {
        char cam_path[MAX_PATH_LEN];
        snprintf(cam_path, sizeof(cam_path), "%s/%s", base, cam_filter);
        struct stat cst;
        if (stat(cam_path, &cst) != 0 || !S_ISDIR(cst.st_mode)) {
            send_json(cl, 200, "OK", j);
            cJSON_Delete(j);
            return;
        }

        cJSON *dates = cJSON_AddArrayToObject(j, "dates");
        DIR *dcam = opendir(cam_path);
        if (dcam) {
            struct dirent *ent;
            /* Collect date dirs, then sort descending */
            char date_list[365][16];
            int date_count = 0;
            while ((ent = readdir(dcam)) && date_count < 365) {
                if (ent->d_name[0] == '.') continue;
                /* Validate date-like name: YYYY-MM-DD */
                if (strlen(ent->d_name) == 10 && ent->d_name[4] == '-' && ent->d_name[7] == '-') {
                    char dpath[MAX_PATH_LEN];
                    snprintf(dpath, sizeof(dpath), "%s/%s", cam_path, ent->d_name);
                    struct stat dst;
                    if (stat(dpath, &dst) == 0 && S_ISDIR(dst.st_mode)) {
                        snprintf(date_list[date_count], sizeof(date_list[0]), "%s", ent->d_name);
                        date_count++;
                    }
                }
            }
            closedir(dcam);

            /* Sort descending (newest first) */
            for (int i = 0; i < date_count - 1; i++)
                for (int k = i + 1; k < date_count; k++)
                    if (strcmp(date_list[i], date_list[k]) < 0) {
                        char tmp[16];
                        memcpy(tmp, date_list[i], 16);
                        memcpy(date_list[i], date_list[k], 16);
                        memcpy(date_list[k], tmp, 16);
                    }
            for (int i = 0; i < date_count; i++)
                cJSON_AddItemToArray(dates, cJSON_CreateString(date_list[i]));
        }

        /* If cam+date given, list files */
        if (date_filter[0]) {
            char vid_path[MAX_PATH_LEN];
            snprintf(vid_path, sizeof(vid_path), "%s/%s/%s/video",
                     base, cam_filter, date_filter);

            cJSON *files = cJSON_AddArrayToObject(j, "files");
            DIR *dvid = opendir(vid_path);
            if (dvid) {
                struct dirent *ent;
                while ((ent = readdir(dvid))) {
                    if (ent->d_name[0] == '.') continue;
                    const char *ext = strrchr(ent->d_name, '.');
                    if (!ext || strcmp(ext, ".mp4") != 0) continue;

                    char fpath[MAX_PATH_LEN];
                    snprintf(fpath, sizeof(fpath), "%s/%s", vid_path, ent->d_name);
                    struct stat fst;
                    if (stat(fpath, &fst) != 0 || fst.st_size == 0) continue;

                    cJSON *f = cJSON_CreateObject();
                    cJSON_AddStringToObject(f, "name", ent->d_name);
                    cJSON_AddNumberToObject(f, "size", (double)fst.st_size);
                    cJSON_AddNumberToObject(f, "mtime", (double)fst.st_mtime);

                    char relpath[MAX_PATH_LEN];
                    snprintf(relpath, sizeof(relpath), "%s/%s/video/%s",
                             cam_filter, date_filter, ent->d_name);
                    cJSON_AddStringToObject(f, "path", relpath);
                    cJSON_AddItemToArray(files, f);
                }
                closedir(dvid);
            }
        }
    }

    send_json(cl, 200, "OK", j);
    cJSON_Delete(j);
}

/* ── API: GET /api/recordings/play?path=... ───────────────────────── */

static void api_get_recordings_play(webui_client_t *cl, webui_t *w,
                                     const char *query,
                                     off_t range_start, off_t range_end)
{
    char relpath[MAX_PATH_LEN] = "";
    query_param(query, "path", relpath, sizeof(relpath));

    if (!relpath[0]) {
        send_error(cl, 400, "Missing path parameter");
        return;
    }

    /* Security: block traversal */
    if (strstr(relpath, "..")) {
        send_error(cl, 403, "Forbidden");
        return;
    }

    /* Require .mp4 extension */
    const char *ext = strrchr(relpath, '.');
    if (!ext || strcmp(ext, ".mp4") != 0) {
        send_error(cl, 403, "Only .mp4 files allowed");
        return;
    }

    char fullpath[MAX_PATH_LEN];
    snprintf(fullpath, sizeof(fullpath), "%s/%s", w->app->cfg->record_base, relpath);

    /* Validate resolved path still starts with record_base */
    if (strncmp(fullpath, w->app->cfg->record_base,
                strlen(w->app->cfg->record_base)) != 0) {
        send_error(cl, 403, "Forbidden");
        return;
    }

    send_file_range(cl, fullpath, range_start, range_end);
}

/* ── Request dispatch ─────────────────────────────────────────────── */

static void handle_request(webui_t *w, webui_client_t *cl)
{
    http_request_t req;
    if (!parse_request(cl->req_buf, cl->req_len, &req)) {
        send_error(cl, 400, "Bad Request");
        return;
    }

    /* CORS preflight */
    if (strcmp(req.method, "OPTIONS") == 0) {
        char header[256];
        int hlen = snprintf(header, sizeof(header),
            "HTTP/1.0 204 No Content\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Authorization, Content-Type\r\n"
            "Connection: close\r\n\r\n");
        cl->resp_buf = malloc(hlen);
        if (cl->resp_buf) {
            memcpy(cl->resp_buf, header, hlen);
            cl->resp_len = hlen;
            cl->resp_sent = 0;
            cl->state = CS_WRITING;
        }
        return;
    }

    /* Auth check (skip for snapshot/video to allow <img>/<video> tags) */
    bool is_api = strncmp(req.path, "/api/", 5) == 0;
    bool skip_auth = strcmp(req.path, "/api/camera/snapshot") == 0 ||
                     strcmp(req.path, "/api/recordings/play") == 0;

    if (is_api && !skip_auth) {
        if (!check_auth(w, cl->req_buf)) { send_401(cl); return; }
    } else if (!is_api) {
        if (!check_auth(w, cl->req_buf)) { send_401(cl); return; }
    }

    /* Check if this is a firmware upload (needs special streaming handling) */
    if (strcmp(req.path, "/api/system/firmware") == 0 &&
        strcmp(req.method, "POST") == 0) {
        if (req.content_length <= 0 || req.content_length > MAX_FIRMWARE_SZ) {
            send_error(cl, 400, "Invalid firmware size");
            return;
        }

        /* Open temp file for upload */
#ifdef PLAT_WINDOWS
        snprintf(cl->upload_path, sizeof(cl->upload_path),
                 "firmware_%d.bin", (int)time(NULL));
#else
        snprintf(cl->upload_path, sizeof(cl->upload_path),
                 "/tmp/firmware_%d.bin", (int)time(NULL));
#endif
        cl->upload_fd = open(cl->upload_path, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY, 0755);
        if (cl->upload_fd < 0) {
            send_error(cl, 500, "Cannot create temp file");
            return;
        }

        snprintf(cl->upload_endpoint, sizeof(cl->upload_endpoint), "firmware");

        /* Write any body data already received */
        if (req.body_len > 0) {
            write(cl->upload_fd, req.body, req.body_len);
        }

        cl->upload_remaining = req.content_length - req.body_len;

        if (cl->upload_remaining <= 0) {
            /* All data received in one read */
            close(cl->upload_fd);
            cl->upload_fd = -1;
            finish_firmware_upload(cl, w);
        } else {
            cl->state = CS_RECEIVING_UPLOAD;
        }
        return;
    }

    /* API routing */
    if (strcmp(req.path, "/api/status") == 0 && strcmp(req.method, "GET") == 0)
        api_get_status(cl, w);
    else if (strcmp(req.path, "/api/config") == 0 && strcmp(req.method, "GET") == 0)
        api_get_config(cl, w);
    else if (strcmp(req.path, "/api/config") == 0 && strcmp(req.method, "POST") == 0)
        api_post_config(cl, w, req.body, req.body_len);
    else if (strcmp(req.path, "/api/network") == 0 && strcmp(req.method, "GET") == 0)
        api_get_network(cl);
    else if (strcmp(req.path, "/api/network") == 0 && strcmp(req.method, "POST") == 0)
        api_post_network(cl, req.body, req.body_len);
    else if (strcmp(req.path, "/api/camera/snapshot") == 0 && strcmp(req.method, "GET") == 0)
        api_get_snapshot(cl, w, req.query);
    else if (strcmp(req.path, "/api/yolo/config") == 0 && strcmp(req.method, "GET") == 0)
        api_get_yolo(cl, w, req.query);
    else if (strcmp(req.path, "/api/yolo/config") == 0 && strcmp(req.method, "POST") == 0)
        api_post_yolo(cl, w, req.query, req.body, req.body_len);
    else if (strcmp(req.path, "/api/yolo/zones") == 0 && strcmp(req.method, "GET") == 0)
        api_get_zones(cl, w, req.query);
    else if (strcmp(req.path, "/api/yolo/zones") == 0 && strcmp(req.method, "POST") == 0)
        api_post_zones(cl, w, req.query, req.body, req.body_len);
    else if (strcmp(req.path, "/api/camera/detection/preview") == 0 && strcmp(req.method, "GET") == 0)
        api_get_detection_preview(cl, w, req.query);
    else if (strcmp(req.path, "/api/camera/detection/events") == 0 && strcmp(req.method, "GET") == 0)
        api_get_detection_events(cl, w, req.query);
    else if (strcmp(req.path, "/api/camera/detection/start") == 0 && strcmp(req.method, "POST") == 0)
        api_post_detection_start(cl, w, req.query);
    else if (strcmp(req.path, "/api/camera/detection/stop") == 0 && strcmp(req.method, "POST") == 0)
        api_post_detection_stop(cl, w, req.query);
    else if (strcmp(req.path, "/api/stream/start") == 0 && strcmp(req.method, "POST") == 0)
        api_post_stream_start(cl, w, req.body, req.body_len);
    else if (strcmp(req.path, "/api/stream/stop") == 0 && strcmp(req.method, "POST") == 0)
        api_post_stream_stop(cl, w, req.body, req.body_len);
    else if (strcmp(req.path, "/api/system/reboot") == 0 && strcmp(req.method, "POST") == 0)
        api_post_reboot(cl, w);
    else if (strcmp(req.path, "/api/system/factory-reset") == 0 && strcmp(req.method, "POST") == 0)
        api_post_factory_reset(cl, w);
    else if (strcmp(req.path, "/api/system/info") == 0 && strcmp(req.method, "GET") == 0)
        api_get_system_info(cl, w);
    else if (strcmp(req.path, "/api/system/logs") == 0 && strcmp(req.method, "GET") == 0)
        api_get_logs(cl);
    else if (strcmp(req.path, "/api/system/temperature") == 0 && strcmp(req.method, "GET") == 0)
        api_get_temperature(cl);
    else if (strcmp(req.path, "/api/system/firmware/versions") == 0 && strcmp(req.method, "GET") == 0)
        api_get_firmware_versions(cl);
    else if (strcmp(req.path, "/api/system/firmware/rollback") == 0 && strcmp(req.method, "POST") == 0)
        api_post_firmware_rollback(cl, w);
    else if (strcmp(req.path, "/api/system/firmware/apply") == 0 && strcmp(req.method, "POST") == 0)
        api_post_firmware_apply(cl, w);
    else if (strcmp(req.path, "/api/storage/info") == 0 && strcmp(req.method, "GET") == 0)
        api_get_storage_info(cl, w);
    else if (strcmp(req.path, "/api/storage/sdcard/format") == 0 && strcmp(req.method, "POST") == 0)
        api_post_sdcard_format(cl, req.body, req.body_len);
    else if (strcmp(req.path, "/api/storage/sdcard/erase") == 0 && strcmp(req.method, "POST") == 0)
        api_post_sdcard_erase(cl, w);
    else if (strncmp(req.path, "/api/files", 10) == 0 && strcmp(req.method, "GET") == 0)
        api_get_files(cl, w, req.path);
    else if (strcmp(req.path, "/api/setup") == 0 && strcmp(req.method, "POST") == 0)
        api_post_setup(cl, w, req.body, req.body_len);
    else if (strcmp(req.path, "/api/hardware") == 0 && strcmp(req.method, "GET") == 0)
        api_get_hardware(cl);
    else if (strcmp(req.path, "/api/network/traffic") == 0 && strcmp(req.method, "GET") == 0)
        api_get_network_traffic(cl);
    else if (strcmp(req.path, "/api/system/password") == 0 && strcmp(req.method, "POST") == 0)
        api_post_password(cl, w, req.body, req.body_len);
    else if (strcmp(req.path, "/api/camera/snapshot/live") == 0 && strcmp(req.method, "POST") == 0)
        api_post_snapshot_live(cl, w, req.body, req.body_len);
    else if (strcmp(req.path, "/api/speedtest") == 0 && strcmp(req.method, "GET") == 0)
        api_get_speedtest(cl, w);
    else if (strcmp(req.path, "/api/recordings") == 0 && strcmp(req.method, "GET") == 0)
        api_get_recordings(cl, w, req.query);
    else if (strcmp(req.path, "/api/recordings/play") == 0 && strcmp(req.method, "GET") == 0)
        api_get_recordings_play(cl, w, req.query, req.range_start, req.range_end);
    else if (strncmp(req.path, "/api/", 5) == 0)
        send_error(cl, 404, "API endpoint not found");
    else
        serve_static(cl, req.path);
}

/* ── Public API ───────────────────────────────────────────────────── */

webui_t *webui_create(app_context_t *app)
{
    webui_t *w = calloc(1, sizeof(*w));
    if (!w) return NULL;

    w->app = app;

    char cred[256];
    snprintf(cred, sizeof(cred), "%s:%s", app->cfg->webui_user, app->cfg->webui_pass);
    base64_encode(cred, strlen(cred), w->auth_expected, sizeof(w->auth_expected));

    for (int i = 0; i < WEBUI_MAX_CLIENTS; i++) {
        w->clients[i].fd = -1;
        w->clients[i].file_fd = -1;
        w->clients[i].upload_fd = -1;
        w->clients[i].state = CS_IDLE;
    }

    w->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (w->listen_fd < 0) {
        LOG_E("webui: socket() failed: %s", strerror(errno));
        free(w);
        return NULL;
    }

    int opt = 1;
    setsockopt(w->listen_fd, SOL_SOCKET, SO_REUSEADDR, (const char *)&opt, sizeof(opt));
    set_nonblocking(w->listen_fd);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(app->cfg->webui_port);
    addr.sin_addr.s_addr = INADDR_ANY;

    if (bind(w->listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        LOG_E("webui: bind port %d failed: %s", app->cfg->webui_port, strerror(errno));
        sock_close(w->listen_fd);
        free(w);
        return NULL;
    }

    if (listen(w->listen_fd, 5) < 0) {
        LOG_E("webui: listen failed: %s", strerror(errno));
        sock_close(w->listen_fd);
        free(w);
        return NULL;
    }

    LOG_I("webui: listening on port %d", app->cfg->webui_port);
    return w;
}

void webui_destroy(webui_t *w)
{
    if (!w) return;
    for (int i = 0; i < WEBUI_MAX_CLIENTS; i++)
        client_reset(&w->clients[i]);
    if (w->listen_fd >= 0) sock_close(w->listen_fd);
    free(w);
}

int webui_fill_pollfds(webui_t *w, struct pollfd *fds, int offset)
{
    int n = 0;

    fds[offset + n].fd = w->listen_fd;
    fds[offset + n].events = POLLIN;
    fds[offset + n].revents = 0;
    n++;

    for (int i = 0; i < WEBUI_MAX_CLIENTS; i++) {
        if (w->clients[i].fd >= 0) {
            fds[offset + n].fd = w->clients[i].fd;
            fds[offset + n].events =
                (w->clients[i].state == CS_WRITING) ? POLLOUT : POLLIN;
            fds[offset + n].revents = 0;
            n++;
        }
    }

    return n;
}

void webui_process(webui_t *w, struct pollfd *fds, int offset)
{
    int idx = offset;
    time_t now = time(NULL);

    /* ── Accept new connections ─────────────────────────────────── */
    if (fds[idx].revents & POLLIN) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);
        int cfd = accept(w->listen_fd, (struct sockaddr *)&client_addr, &addr_len);
        if (cfd >= 0) {
            int slot = -1;
            for (int i = 0; i < WEBUI_MAX_CLIENTS; i++) {
                if (w->clients[i].fd < 0) { slot = i; break; }
            }
            if (slot < 0) {
                sock_close(cfd);
            } else {
                set_nonblocking(cfd);
                w->clients[slot].fd = cfd;
                w->clients[slot].state = CS_READING;
                w->clients[slot].last_active = now;
                w->clients[slot].req_len = 0;
                w->clients[slot].resp_buf = NULL;
                w->clients[slot].resp_len = 0;
                w->clients[slot].resp_sent = 0;
                w->clients[slot].file_fd = -1;
                w->clients[slot].upload_fd = -1;
                w->clients[slot].file_remaining = 0;
                w->clients[slot].upload_remaining = 0;
            }
        }
    }
    idx++;

    /* ── Process active clients ─────────────────────────────────── */
    for (int i = 0; i < WEBUI_MAX_CLIENTS; i++) {
        webui_client_t *cl = &w->clients[i];
        if (cl->fd < 0) continue;

        if (now - cl->last_active > IDLE_TIMEOUT_SEC) {
            client_reset(cl);
            continue;
        }

        bool found = false;
        for (int f = idx; f < idx + WEBUI_MAX_CLIENTS; f++) {
            if (fds[f].fd == cl->fd) {
                found = true;

                if (cl->state == CS_READING && (fds[f].revents & POLLIN)) {
                    int space = REQ_BUF_SZ - cl->req_len - 1;
                    if (space <= 0) {
                        send_error(cl, 413, "Request too large");
                        continue;
                    }
                    ssize_t n = sock_read(cl->fd, cl->req_buf + cl->req_len, space);
                    if (n <= 0) {
                        client_reset(cl);
                        continue;
                    }
                    cl->req_len += n;
                    cl->req_buf[cl->req_len] = '\0';
                    cl->last_active = now;

                    char *hdr_end = strstr(cl->req_buf, "\r\n\r\n");
                    if (hdr_end) {
                        const char *cl_hdr = strstr(cl->req_buf, "Content-Length: ");
                        if (!cl_hdr) cl_hdr = strstr(cl->req_buf, "content-length: ");
                        if (cl_hdr) {
                            int clen = atoi(cl_hdr + 16);
                            int body_received = cl->req_len - (hdr_end + 4 - cl->req_buf);
                            if (body_received < clen && clen < REQ_BUF_SZ)
                                continue; /* Need more data */
                        }
                        handle_request(w, cl);
                    }
                }
                else if (cl->state == CS_RECEIVING_UPLOAD && (fds[f].revents & POLLIN)) {
                    char buf[UPLOAD_BUF_SZ];
                    ssize_t n = sock_read(cl->fd, buf,
                        cl->upload_remaining < UPLOAD_BUF_SZ ?
                            cl->upload_remaining : UPLOAD_BUF_SZ);
                    if (n <= 0) {
                        if (cl->upload_fd >= 0) close(cl->upload_fd);
                        cl->upload_fd = -1;
                        remove(cl->upload_path);
                        client_reset(cl);
                        continue;
                    }
                    write(cl->upload_fd, buf, n);
                    cl->upload_remaining -= n;
                    cl->last_active = now;

                    if (cl->upload_remaining <= 0) {
                        close(cl->upload_fd);
                        cl->upload_fd = -1;
                        if (strcmp(cl->upload_endpoint, "firmware") == 0)
                            finish_firmware_upload(cl, w);
                    }
                }
                else if (cl->state == CS_WRITING && (fds[f].revents & POLLOUT)) {
                    int remaining = cl->resp_len - cl->resp_sent;
                    if (remaining > 0) {
                        ssize_t n = sock_write(cl->fd, cl->resp_buf + cl->resp_sent, remaining);
                        if (n <= 0) {
                            client_reset(cl);
                            continue;
                        }
                        cl->resp_sent += n;
                        cl->last_active = now;
                    }
                    /* Phase 2: stream file body via sendfile (zero-copy on Linux) */
                    else if (cl->file_fd >= 0 && cl->file_remaining > 0) {
                        size_t chunk = cl->file_remaining < 4096
                                       ? (size_t)cl->file_remaining : 4096;
                        int64_t offset = lseek(cl->file_fd, 0, SEEK_CUR);
                        ssize_t nw = plat_sendfile(cl->fd, cl->file_fd, chunk);
                        if (nw <= 0) { client_reset(cl); continue; }
                        cl->file_remaining -= nw;
                        /* Drop sent pages from page cache to prevent OOM */
                        plat_fadvise_dontneed(cl->file_fd, offset, nw);
                        cl->last_active = now;
                    }
                    else {
                        client_reset(cl);
                    }
                }
                else if (fds[f].revents & (POLLHUP | POLLERR)) {
                    client_reset(cl);
                }
                break;
            }
        }
        if (!found) continue;
    }
}
