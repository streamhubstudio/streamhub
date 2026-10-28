# Shared settings of the e2e stack (sourced by up.sh / scenarios.sh / down.sh).
# Every port is distinct from the defaults so the stack can share a host.
E2E_DIR="${E2E_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
export E2E_PROJECT="${E2E_PROJECT:-$(basename "$E2E_DIR")}"
export E2E_DATA="$E2E_DIR/data"           # DATA_DIR (bind-mounted at the SAME path into egress)

export P_REDIS=26379
export P_LK=27880 P_LK_TCP=27881 P_LK_UDP=27882 P_LK_PROM=26789
export P_ING_RTMP=21935 P_ING_WHIP=28080 P_ING_RELAY=29090 P_ING_PROM=26790
export P_EG_PROM=26791 P_EG_TEMPLATE=27980
export P_MINIO=29000 P_S3_MASTER=29333 P_S3_VOLUME=29080 P_S3_FILER=29888
# E2E_EGRESS=0 skips the egress container (HLS / recording / snapshot / restream SKIP)
export E2E_EGRESS="${E2E_EGRESS:-1}"
export COMPOSE_PROFILES="$([ "$E2E_EGRESS" = 1 ] && echo egress)"
export P_RECV=28999 P_CORE=23020
export P_SINK_RTMP=31935 P_SINK_API=39997

export LK_KEY=e2ekey
export LK_SECRET=e2e-secret-0123456789abcdefghijklmnopqrstuv
export MINIO_USER=e2eadmin MINIO_PASS=e2e-minio-pass-0123 BUCKET=e2e-vods
export CB_SECRET=e2e-callback-secret
export ADMIN_USER=admin ADMIN_PASS=e2e-admin-pass-0123
export APP=live

export CORE="http://127.0.0.1:$P_CORE"
export E2E_UID="$(id -u)" E2E_GID="$(id -g)"
# E2E_SHAPE=compose (default): core as root with umask 002 + egress on its
# default uid 1001/gid 0, like the compose deploy (needs passwordless sudo).
# E2E_SHAPE=sameuid: core as the host user, egress as the same uid.
export E2E_SHAPE="${E2E_SHAPE:-compose}"
COMPOSE_FILES=(-f compose.yml)
if [ "$E2E_SHAPE" = sameuid ]; then COMPOSE_FILES+=(-f compose.sameuid.yml); fi
export CLUSTER_TOKEN=clt_e2e-cluster-token-0123456789abcdef
export P_CORE_B=23021   # second Go node (cluster scenarios)
