#!/usr/bin/env bash
#
# ssl.sh — genera (o renueva) el SSL de un dominio para StreamHub, en un
# server con nginx + certbot (deploy "plain-server" / bare-metal).
#
# Crea un server-block nginx de reverse-proxy (SPA/API en :CORE_PORT +
# signaling WebRTC de LiveKit en /rtc -> :LK_PORT) y pide el certificado
# Let's Encrypt con certbot --nginx (que además programa la auto-renovación).
#
# Requisitos: nginx y certbot instalados, correr con sudo/root, y que el
# DNS A/AAAA del dominio ya apunte a este server (puerto 80 alcanzable).
#
# Uso:
#   sudo ./ssl.sh <dominio> [email] [core_port] [livekit_port]
#
# Ejemplos:
#   sudo ./ssl.sh app.streamhub.studio admin@midominio.com
#   sudo ./ssl.sh media.midominio.com admin@midominio.com 3020 7880
#
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
CORE_PORT="${3:-3020}"
LK_PORT="${4:-7880}"

if [[ -z "$DOMAIN" ]]; then
  echo "uso: sudo $0 <dominio> [email] [core_port] [livekit_port]" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "error: correlo con sudo/root." >&2
  exit 1
fi
command -v nginx   >/dev/null || { echo "error: nginx no está instalado." >&2; exit 1; }
command -v certbot >/dev/null || { echo "error: certbot no está instalado (apt install certbot python3-certbot-nginx)." >&2; exit 1; }

AVAIL="/etc/nginx/sites-available/$DOMAIN"
ENABLED="/etc/nginx/sites-enabled/$DOMAIN"

echo "==> escribiendo server-block nginx para $DOMAIN (core :$CORE_PORT, livekit :$LK_PORT)"
cat > "$AVAIL" <<NGINX
server {
    listen 80; listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 50m;

    # LiveKit signaling (WebRTC) — WebSocket
    location /rtc {
        proxy_pass http://127.0.0.1:$LK_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
    }

    # API + SPA + HLS + SDK + samples -> streamhub-core (Node)
    location / {
        proxy_pass http://127.0.0.1:$CORE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
    }
}
NGINX

ln -sf "$AVAIL" "$ENABLED"
echo "==> nginx -t"
nginx -t
systemctl reload nginx

echo "==> certbot --nginx para $DOMAIN"
CERTBOT_ARGS=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
if [[ -n "$EMAIL" ]]; then
  CERTBOT_ARGS+=(-m "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
certbot "${CERTBOT_ARGS[@]}"

echo "==> verificación"
sleep 2
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/v1/health" || true)
echo "    https://$DOMAIN/api/v1/health -> HTTP $CODE"
echo "==> listo. El cert se renueva solo (certbot.timer). Repetí este comando para otros dominios."
