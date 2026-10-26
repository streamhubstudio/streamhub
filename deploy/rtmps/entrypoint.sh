#!/bin/sh
# Render an stunnel config from the environment and run it in the foreground.
#
#   STREAMHUB_RTMPS_PORT   TLS listen port                       (default 1936)
#   STREAMHUB_RTMP_BACKEND host:port of the plaintext ingress    (default 127.0.0.1:1935)
#   STREAMHUB_RTMPS_CERT   PEM cert (fullchain)  inside /certs    (default /certs/fullchain.pem)
#   STREAMHUB_RTMPS_KEY    PEM private key       inside /certs    (default /certs/privkey.pem)
#
# The cert dir is bind-mounted read-only by compose (STREAMHUB_RTMPS_CERT_DIR).
# certbot's live dir already ships fullchain.pem + privkey.pem, so pointing at
# /etc/letsencrypt/live/<domain> works with zero copying.
set -eu

PORT="${STREAMHUB_RTMPS_PORT:-1936}"
BACKEND="${STREAMHUB_RTMP_BACKEND:-127.0.0.1:1935}"
CERT="${STREAMHUB_RTMPS_CERT:-/certs/fullchain.pem}"
KEY="${STREAMHUB_RTMPS_KEY:-/certs/privkey.pem}"

if [ ! -r "$CERT" ]; then
  echo "rtmps: cert not readable at $CERT — mount the domain cert into /certs" >&2
  echo "       (certbot: STREAMHUB_RTMPS_CERT_DIR=/etc/letsencrypt/live/<domain>)" >&2
  exit 1
fi
if [ ! -r "$KEY" ]; then
  echo "rtmps: key not readable at $KEY — mount the domain private key into /certs" >&2
  exit 1
fi

CONF="/tmp/stunnel-rtmps.conf"
cat > "$CONF" <<EOF
foreground = yes
output = /dev/stdout
pid =
; RTMP is a long-lived stream — do not time out idle-but-alive sessions.
TIMEOUTidle = 3600

[rtmps]
accept = $PORT
connect = $BACKEND
cert = $CERT
key = $KEY
EOF

echo "rtmps: TLS :$PORT -> $BACKEND (cert=$CERT)" >&2
exec stunnel "$CONF"
