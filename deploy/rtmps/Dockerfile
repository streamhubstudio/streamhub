# RTMPS front — a tiny stunnel that TLS-terminates RTMP ingest.
#
# WHY: LiveKit ingress (the images this stack pins) listens on PLAIN rtmp:1935
# only — it has no native RTMPS listener. The supported pattern for encrypted
# RTMP ingest is a transparent TLS front: stunnel accepts TLS on :1936 and
# forwards the decrypted RTMP stream to 127.0.0.1:1935 unchanged. Because the
# wrapper is byte-transparent, the rtmps:// URL is the rtmp:// URL with only the
# scheme and port swapped (same /live/<key> path, same stream key).
#
# This image is OFF by default: only the `rtmps` compose profile starts it.
FROM alpine:3.20
RUN apk add --no-cache stunnel
COPY deploy/rtmps/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
