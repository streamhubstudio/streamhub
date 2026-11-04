#include "http.h"
#include "log.h"
#include "util.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509.h>

#ifdef PLAT_POSIX
  #include <unistd.h>
#endif

#ifdef PLAT_WINDOWS
  #include <wincrypt.h>
  /* Avoid macro collision between wincrypt.h and OpenSSL */
  #undef X509_NAME
  #undef X509_EXTENSIONS
  #pragma comment(lib, "crypt32.lib")
#endif

#define READ_BUF        4096
#define CONNECT_TIMEOUT 10   /* seconds — max time to wait for TCP connect */

/* ── URL parsing ──────────────────────────────────────────────────── */

typedef struct {
    int   use_tls;
    char  host[256];
    int   port;
    char  path[1024];
} parsed_url_t;

static int parse_url(const char *url, parsed_url_t *u)
{
    memset(u, 0, sizeof(*u));

    if (strncmp(url, "https://", 8) == 0) {
        u->use_tls = 1;
        u->port = 443;
        url += 8;
    } else if (strncmp(url, "http://", 7) == 0) {
        u->use_tls = 0;
        u->port = 80;
        url += 7;
    } else {
        return -1;
    }

    const char *slash = strchr(url, '/');
    const char *colon = strchr(url, ':');

    if (colon && (!slash || colon < slash)) {
        snprintf(u->host, sizeof(u->host), "%.*s", (int)(colon - url), url);
        u->port = atoi(colon + 1);
        url = slash ? slash : url + strlen(url);
    } else if (slash) {
        snprintf(u->host, sizeof(u->host), "%.*s", (int)(slash - url), url);
        url = slash;
    } else {
        snprintf(u->host, sizeof(u->host), "%s", url);
        url = "";
    }

    snprintf(u->path, sizeof(u->path), "%s", *url ? url : "/");
    return 0;
}

/* ── Socket + TLS connection ──────────────────────────────────────── */

typedef struct {
    int       fd;
    SSL_CTX  *ssl_ctx;
    SSL      *ssl;
} conn_t;

static int conn_open(const parsed_url_t *u, conn_t *c)
{
    memset(c, 0, sizeof(*c));
    c->fd = -1;

    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", u->port);

    if (getaddrinfo(u->host, port_str, &hints, &res) != 0 || !res) {
        LOG_E("http: DNS failed for %s", u->host);
        return -1;
    }

    c->fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (c->fd < 0) {
        LOG_E("http: socket() failed");
        freeaddrinfo(res);
        return -1;
    }

    /* Non-blocking connect with timeout to avoid ~2min kernel default */
    plat_set_nonblock(c->fd);

    int rc = connect(c->fd, res->ai_addr, (int)res->ai_addrlen);
    freeaddrinfo(res);

#ifdef PLAT_WINDOWS
    int connect_pending = (rc < 0 && WSAGetLastError() == WSAEWOULDBLOCK);
#else
    int connect_pending = (rc < 0 && errno == EINPROGRESS);
#endif

    if (rc < 0 && !connect_pending) {
        LOG_E("http: connect to %s:%d failed", u->host, u->port);
        sock_close(c->fd); c->fd = -1;
        return -1;
    }

    if (connect_pending) {
        /* Connection in progress — wait with timeout */
        struct pollfd pfd;
        memset(&pfd, 0, sizeof(pfd));
        pfd.fd = c->fd;
        pfd.events = POLLOUT;
        int pr = poll(&pfd, 1, CONNECT_TIMEOUT * 1000);
        if (pr <= 0) {
            LOG_E("http: connect to %s:%d timed out (%ds)",
                  u->host, u->port, CONNECT_TIMEOUT);
            sock_close(c->fd); c->fd = -1;
            return -1;
        }
        /* Check if connection actually succeeded */
        int err = 0;
        socklen_t len = sizeof(err);
        getsockopt(c->fd, SOL_SOCKET, SO_ERROR, (char *)&err, &len);
        if (err != 0) {
            LOG_E("http: connect to %s:%d failed (err=%d)", u->host, u->port, err);
            sock_close(c->fd); c->fd = -1;
            return -1;
        }
    }

    /* Restore blocking mode for normal I/O */
    plat_set_blocking(c->fd);

    /* Set read/write timeout */
#ifdef PLAT_WINDOWS
    /* Winsock expects DWORD in milliseconds */
    DWORD timeout_ms = 30000;
    setsockopt(c->fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
    setsockopt(c->fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv;
    memset(&tv, 0, sizeof(tv));
    tv.tv_sec = 30;
    setsockopt(c->fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof(tv));
    setsockopt(c->fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&tv, sizeof(tv));
#endif

    if (u->use_tls) {
        c->ssl_ctx = SSL_CTX_new(TLS_client_method());
        if (!c->ssl_ctx) {
            LOG_E("http: SSL_CTX_new failed");
            sock_close(c->fd); c->fd = -1;
            return -1;
        }
        /* Load system CA certificates for peer verification */
#ifdef PLAT_WINDOWS
        /* Windows: load CA certs from the Windows certificate store */
        {
            HCERTSTORE h = CertOpenSystemStoreA(0, "ROOT");
            if (h) {
                X509_STORE *store = SSL_CTX_get_cert_store(c->ssl_ctx);
                PCCERT_CONTEXT ctx = NULL;
                while ((ctx = CertEnumCertificatesInStore(h, ctx)) != NULL) {
                    X509 *x509 = d2i_X509(NULL,
                        (const unsigned char **)&ctx->pbCertEncoded,
                        ctx->cbCertEncoded);
                    if (x509) {
                        X509_STORE_add_cert(store, x509);
                        X509_free(x509);
                    }
                }
                CertCloseStore(h, 0);
            }
        }
#else
        SSL_CTX_set_default_verify_paths(c->ssl_ctx);
#endif
        c->ssl = SSL_new(c->ssl_ctx);
        SSL_set_fd(c->ssl, c->fd);
        SSL_set_tlsext_host_name(c->ssl, u->host);
        int ssl_ret = SSL_connect(c->ssl);
        if (ssl_ret <= 0) {
            int ssl_err = SSL_get_error(c->ssl, ssl_ret);
            unsigned long e = ERR_get_error();
            LOG_E("http: TLS handshake failed for %s (ssl_err=%d ret=%d): %s",
                  u->host, ssl_err, ssl_ret,
                  e ? ERR_reason_error_string(e) : "unknown");
            SSL_free(c->ssl); SSL_CTX_free(c->ssl_ctx);
            sock_close(c->fd); c->fd = -1;
            return -1;
        }
    }
    return 0;
}

static int conn_write(conn_t *c, const void *buf, size_t len)
{
    if (c->ssl)
        return SSL_write(c->ssl, buf, (int)len);
    return sock_write(c->fd, buf, len);
}

static int conn_read(conn_t *c, void *buf, size_t len)
{
    if (c->ssl)
        return SSL_read(c->ssl, buf, (int)len);
    return sock_read(c->fd, buf, len);
}

static void conn_close(conn_t *c)
{
    if (c->ssl)  { SSL_shutdown(c->ssl); SSL_free(c->ssl); }
    if (c->ssl_ctx) SSL_CTX_free(c->ssl_ctx);
    if (c->fd >= 0) sock_close(c->fd);
}

/* ── Response parsing ─────────────────────────────────────────────── */

static int read_response(conn_t *c, http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));

    /* Read headers first */
    char hdr_buf[READ_BUF * 4];
    int  hdr_len = 0;
    int  body_start = -1;

    while (hdr_len < (int)sizeof(hdr_buf) - 1) {
        int n = conn_read(c, hdr_buf + hdr_len, sizeof(hdr_buf) - hdr_len - 1);
        if (n <= 0) break;
        hdr_len += n;
        hdr_buf[hdr_len] = '\0';

        char *end = strstr(hdr_buf, "\r\n\r\n");
        if (end) {
            body_start = (int)(end - hdr_buf) + 4;
            break;
        }
    }

    if (body_start < 0)
        return -1;

    /* Parse status line */
    if (sscanf(hdr_buf, "HTTP/%*d.%*d %d", &resp->status) != 1)
        return -1;

    /* Find Content-Length */
    int content_length = -1;
    /* Case-insensitive search (portable, no strcasestr dependency) */
    char *cl = NULL;
    for (char *p = hdr_buf; p < hdr_buf + body_start; p++) {
        if ((*p == 'C' || *p == 'c') &&
            strncasecmp(p, "Content-Length:", 15) == 0) {
            cl = p;
            break;
        }
    }
    if (cl)
        content_length = atoi(cl + 15);

    /* Detect Transfer-Encoding: chunked */
    int is_chunked = 0;
    for (char *p = hdr_buf; p < hdr_buf + body_start; p++) {
        if ((*p == 'T' || *p == 't') &&
            strncasecmp(p, "Transfer-Encoding:", 18) == 0) {
            char *v = p + 18;
            while (*v == ' ') v++;
            if (strncasecmp(v, "chunked", 7) == 0)
                is_chunked = 1;
            break;
        }
    }

    /* Collect body */
    int body_in_hdr = hdr_len - body_start;

    if (is_chunked) {
        /* Chunked transfer: read raw data, then dechunk */
        size_t cap = READ_BUF;
        char *raw = malloc(cap + 1);
        if (!raw) return -1;
        size_t raw_len = 0;

        if (body_in_hdr > 0) {
            memcpy(raw, hdr_buf + body_start, body_in_hdr);
            raw_len = body_in_hdr;
        }

        /* Read all raw chunked data until connection closes */
        while (raw_len < HTTP_MAX_BODY) {
            if (raw_len + READ_BUF > cap) {
                cap *= 2;
                if (cap > HTTP_MAX_BODY) cap = HTTP_MAX_BODY;
                raw = realloc(raw, cap + 1);
                if (!raw) return -1;
            }
            int n = conn_read(c, raw + raw_len, cap - raw_len);
            if (n <= 0) break;
            raw_len += n;
        }
        raw[raw_len] = '\0';

        /* Dechunk: parse "SIZE\r\n DATA \r\n SIZE\r\n DATA \r\n 0\r\n" */
        resp->body = malloc(raw_len + 1);  /* decoded is always <= raw */
        if (!resp->body) { free(raw); return -1; }
        resp->body_len = 0;

        char *rp = raw;
        char *rend = raw + raw_len;
        while (rp < rend) {
            /* Read chunk size (hex) */
            unsigned long chunk_sz = strtoul(rp, NULL, 16);
            if (chunk_sz == 0) break;  /* final chunk */

            /* Skip past size line (\r\n) */
            char *nl = strstr(rp, "\r\n");
            if (!nl) break;
            rp = nl + 2;

            /* Copy chunk data */
            size_t avail = rend - rp;
            size_t to_copy = chunk_sz < avail ? chunk_sz : avail;
            memcpy(resp->body + resp->body_len, rp, to_copy);
            resp->body_len += to_copy;
            rp += to_copy;

            /* Skip trailing \r\n after chunk data */
            if (rp + 2 <= rend && rp[0] == '\r' && rp[1] == '\n')
                rp += 2;
        }
        resp->body[resp->body_len] = '\0';
        free(raw);
    } else if (content_length >= 0) {
        if (content_length > HTTP_MAX_BODY) content_length = HTTP_MAX_BODY;
        resp->body = malloc(content_length + 1);
        if (!resp->body) return -1;

        if (body_in_hdr > 0)
            memcpy(resp->body, hdr_buf + body_start, body_in_hdr);

        int remaining = content_length - body_in_hdr;
        int offset = body_in_hdr;
        while (remaining > 0) {
            int n = conn_read(c, resp->body + offset, remaining);
            if (n <= 0) break;
            offset += n;
            remaining -= n;
        }
        resp->body[offset] = '\0';
        resp->body_len = offset;
    } else {
        /* No content-length: read until close, up to max */
        size_t cap = READ_BUF;
        resp->body = malloc(cap + 1);
        if (!resp->body) return -1;

        if (body_in_hdr > 0) {
            memcpy(resp->body, hdr_buf + body_start, body_in_hdr);
            resp->body_len = body_in_hdr;
        }

        while (resp->body_len < HTTP_MAX_BODY) {
            if (resp->body_len + READ_BUF > cap) {
                cap *= 2;
                if (cap > HTTP_MAX_BODY) cap = HTTP_MAX_BODY;
                resp->body = realloc(resp->body, cap + 1);
                if (!resp->body) return -1;
            }
            int n = conn_read(c, resp->body + resp->body_len,
                              cap - resp->body_len);
            if (n <= 0) break;
            resp->body_len += n;
        }
        resp->body[resp->body_len] = '\0';
    }
    return 0;
}

/* ── Public API ───────────────────────────────────────────────────── */

void http_response_free(http_response_t *resp)
{
    free(resp->body);
    resp->body = NULL;
    resp->body_len = 0;
}

int http_get(const char *url, const char *auth_header, http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));

    parsed_url_t u;
    if (parse_url(url, &u) != 0) return -1;

    conn_t c;
    if (conn_open(&u, &c) != 0) return -1;

    char req[2048];
    int len = snprintf(req, sizeof(req),
        "GET %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "%s%s"
        "\r\n",
        u.path, u.host,
        auth_header ? auth_header : "",
        auth_header ? "\r\n" : "");

    conn_write(&c, req, len);
    int rc = read_response(&c, resp);
    conn_close(&c);
    return rc;
}

int http_post_json(const char *url, const char *auth_header,
                   const char *json_body, http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));

    parsed_url_t u;
    if (parse_url(url, &u) != 0) return -1;

    conn_t c;
    if (conn_open(&u, &c) != 0) return -1;

    size_t body_len = json_body ? strlen(json_body) : 0;

    char req[2048];
    int len = snprintf(req, sizeof(req),
        "POST %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %zu\r\n"
        "%s%s"
        "\r\n",
        u.path, u.host, body_len,
        auth_header ? auth_header : "",
        auth_header ? "\r\n" : "");

    conn_write(&c, req, len);
    if (body_len > 0)
        conn_write(&c, json_body, body_len);

    int rc = read_response(&c, resp);
    conn_close(&c);
    return rc;
}

int http_post_multipart(const char *url,
                        const char *field_name, const char *file_path,
                        const char **extra_fields, int nfields,
                        http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));

    parsed_url_t u;
    if (parse_url(url, &u) != 0) return -1;

    /* Get file size without loading into RAM */
    FILE *fp = fopen(file_path, "rb");
    if (!fp) return -1;
    fseek(fp, 0, SEEK_END);
    long fsize = ftell(fp);
    fseek(fp, 0, SEEK_SET);

    const char *boundary = "----AgentMiniFormBoundary7x1b2c3d";

    /* Extract filename from path */
    const char *fname = strrchr(file_path, '/');
#ifdef PLAT_WINDOWS
    if (!fname) fname = strrchr(file_path, '\\');
#endif
    fname = fname ? fname + 1 : file_path;

    /* Pre-build text prefix (fields + file header) */
    char prefix[2048];
    size_t prefix_len = 0;

    for (int i = 0; i + 1 < nfields; i += 2) {
        prefix_len += snprintf(prefix + prefix_len, sizeof(prefix) - prefix_len,
            "--%s\r\n"
            "Content-Disposition: form-data; name=\"%s\"\r\n\r\n"
            "%s\r\n",
            boundary, extra_fields[i], extra_fields[i + 1]);
    }

    prefix_len += snprintf(prefix + prefix_len, sizeof(prefix) - prefix_len,
        "--%s\r\n"
        "Content-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
        "Content-Type: image/jpeg\r\n\r\n",
        boundary, field_name, fname);

    /* Suffix after file data */
    char suffix[64];
    size_t suffix_len = snprintf(suffix, sizeof(suffix), "\r\n--%s--\r\n", boundary);

    /* Total content length = prefix + file + suffix */
    size_t total_body = prefix_len + (size_t)fsize + suffix_len;

    /* Connect and send */
    conn_t c;
    if (conn_open(&u, &c) != 0) { fclose(fp); return -1; }

    char req[2048];
    int hdr_len = snprintf(req, sizeof(req),
        "POST %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "Content-Type: multipart/form-data; boundary=%s\r\n"
        "Content-Length: %zu\r\n"
        "\r\n",
        u.path, u.host, boundary, total_body);

    conn_write(&c, req, hdr_len);
    conn_write(&c, prefix, prefix_len);

    /* Stream file in 4KB chunks — never load entire file into RAM */
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), fp)) > 0)
        conn_write(&c, buf, n);
    fclose(fp);

    conn_write(&c, suffix, suffix_len);

    int rc = read_response(&c, resp);
    conn_close(&c);
    return rc;
}

int http_put(const char *url,
             const char **headers, int nheaders,
             const void *body, size_t body_len,
             http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));

    parsed_url_t u;
    if (parse_url(url, &u) != 0) return -1;

    conn_t c;
    if (conn_open(&u, &c) != 0) return -1;

    char req[4096];
    int len = snprintf(req, sizeof(req),
        "PUT %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "Content-Length: %zu\r\n",
        u.path, u.host, body_len);

    for (int i = 0; i < nheaders; i++)
        len += snprintf(req + len, sizeof(req) - len, "%s\r\n", headers[i]);

    len += snprintf(req + len, sizeof(req) - len, "\r\n");

    conn_write(&c, req, len);

    /* Write body in chunks for large files */
    const char *p = body;
    size_t remaining = body_len;
    while (remaining > 0) {
        size_t chunk = remaining > 32768 ? 32768 : remaining;
        int n = conn_write(&c, p, chunk);
        if (n <= 0) break;
        p += n;
        remaining -= n;
    }

    int rc = read_response(&c, resp);
    conn_close(&c);
    return rc;
}

int http_put_file(const char *url,
                  const char **headers, int nheaders,
                  const char *file_path, long file_size,
                  http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));

    parsed_url_t u;
    if (parse_url(url, &u) != 0) return -1;

    FILE *fp = fopen(file_path, "rb");
    if (!fp) return -1;

    conn_t c;
    if (conn_open(&u, &c) != 0) { fclose(fp); return -1; }

    char req[4096];
    int len = snprintf(req, sizeof(req),
        "PUT %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "Content-Length: %ld\r\n",
        u.path, u.host, file_size);

    for (int i = 0; i < nheaders; i++)
        len += snprintf(req + len, sizeof(req) - len, "%s\r\n", headers[i]);

    len += snprintf(req + len, sizeof(req) - len, "\r\n");

    conn_write(&c, req, len);

    /* Stream file body in 64KB chunks — never loads entire file into RAM */
    char buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), fp)) > 0) {
        const char *p = buf;
        size_t remaining = n;
        while (remaining > 0) {
            int nw = conn_write(&c, p, remaining);
            if (nw <= 0) { fclose(fp); conn_close(&c); return -1; }
            p += nw;
            remaining -= nw;
        }
    }
    fclose(fp);

    int rc = read_response(&c, resp);
    conn_close(&c);
    return rc;
}
