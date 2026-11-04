#ifndef AGENT_HTTP_H
#define AGENT_HTTP_H

#include <stddef.h>

#define HTTP_OK          200
#define HTTP_NO_CONTENT  204
#define HTTP_MAX_BODY    (512 * 1024)

typedef struct {
    int    status;
    char  *body;
    size_t body_len;
} http_response_t;

/* Low-level HTTP methods. Response body is malloc'd; caller must free. */
int http_get(const char *url, const char *auth_header, http_response_t *resp);

int http_post_json(const char *url, const char *auth_header,
                   const char *json_body, http_response_t *resp);

int http_post_multipart(const char *url,
                        const char *field_name, const char *file_path,
                        const char **extra_fields, int nfields,
                        http_response_t *resp);

int http_put(const char *url,
             const char **headers, int nheaders,
             const void *body, size_t body_len,
             http_response_t *resp);

/* PUT with streaming file body (never loads entire file into RAM) */
int http_put_file(const char *url,
                  const char **headers, int nheaders,
                  const char *file_path, long file_size,
                  http_response_t *resp);

void http_response_free(http_response_t *resp);

#endif
