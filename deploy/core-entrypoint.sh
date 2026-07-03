#!/bin/sh
# StreamHub core entrypoint: prepare the data dir layout and publish the browser
# SDK into <DATA_DIR>/sdk (served at /sdk/...), then exec the core.
set -e

# Group-writable everything under the shared data dir: core runs as root but
# the livekit/egress worker runs as uid 1001 (gid 0) on the SAME bind mount and
# must write HLS segments / MP4s into dirs the core creates. umask 002 makes
# every dir/file core creates 775/664 (root:root) so group 0 can write.
umask 002

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/data" "$DATA_DIR/apps" "$DATA_DIR/logs" "$DATA_DIR/sdk"

# Copy the streamhub-adaptor IIFE(s) so /sdk/streamhub-adaptor.global.js resolves.
if [ -d /app/adaptor-dist ]; then
  for f in /app/adaptor-dist/*.global.js; do
    [ -f "$f" ] && cp -f "$f" "$DATA_DIR/sdk/" || true
  done
fi

exec "$@"
