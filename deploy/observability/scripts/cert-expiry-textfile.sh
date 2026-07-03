#!/usr/bin/env bash
# Escribe el vencimiento del certificado TLS como métrica Prometheus para el
# textfile collector de node_exporter (alerta TlsCertExpiringSoon, alerts.yml).
#
# Uso típico: hook de renovación de certbot.
#   /etc/letsencrypt/renewal-hooks/deploy/cert-expiry-textfile.sh
#
# También se puede correr por cron (p. ej. diario) para no depender sólo de
# que certbot renueve — así la métrica se refresca aunque la renovación no
# dispare el hook ese día:
#   0 6 * * * /ruta/al/repo/deploy/observability/scripts/cert-expiry-textfile.sh
#
# Variables (ajustar al dominio real del nodo):
#   CERT_PATH   ruta al fullchain.pem (default: Let's Encrypt del dominio en $1
#               o la variable de entorno CERT_DOMAIN)
#   TEXTFILE_DIR directorio del textfile collector (default: deploy/observability/textfile)

set -euo pipefail

CERT_DOMAIN="${1:-${CERT_DOMAIN:-}}"
if [ -z "${CERT_DOMAIN}" ] && [ -z "${CERT_PATH:-}" ]; then
  echo "Uso: $0 <dominio>  (o exportar CERT_PATH=/ruta/a/fullchain.pem)" >&2
  exit 1
fi

CERT_PATH="${CERT_PATH:-/etc/letsencrypt/live/${CERT_DOMAIN}/fullchain.pem}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXTFILE_DIR="${TEXTFILE_DIR:-${SCRIPT_DIR}/../textfile}"
OUT_FILE="${TEXTFILE_DIR}/node_cert_not_after_seconds.prom"
TMP_FILE="${OUT_FILE}.$$"

if [ ! -r "${CERT_PATH}" ]; then
  echo "No se puede leer ${CERT_PATH}" >&2
  exit 1
fi

NOT_AFTER_EPOCH="$(openssl x509 -enddate -noout -in "${CERT_PATH}" | cut -d= -f2 | xargs -I{} date -d {} +%s 2>/dev/null \
  || openssl x509 -enddate -noout -in "${CERT_PATH}" | cut -d= -f2 | xargs -I{} date -j -f "%b %d %T %Y %Z" {} +%s)"

mkdir -p "${TEXTFILE_DIR}"
{
  echo "# HELP node_cert_not_after_seconds Unix time del vencimiento del certificado TLS."
  echo "# TYPE node_cert_not_after_seconds gauge"
  echo "node_cert_not_after_seconds{domain=\"${CERT_DOMAIN:-unknown}\"} ${NOT_AFTER_EPOCH}"
} > "${TMP_FILE}"
mv "${TMP_FILE}" "${OUT_FILE}"
