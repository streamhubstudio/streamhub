#!/bin/sh
# StreamHub core entrypoint: prepare the data dir layout and publish the browser
# SDK into <DATA_DIR>/sdk (served at /sdk/...), then exec the core.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/data" "$DATA_DIR/apps" "$DATA_DIR/logs" "$DATA_DIR/sdk"

# Copy the streamhub-adaptor IIFE(s) so /sdk/streamhub-adaptor.global.js resolves.
if [ -d /app/adaptor-dist ]; then
  for f in /app/adaptor-dist/*.global.js; do
    [ -f "$f" ] && cp -f "$f" "$DATA_DIR/sdk/" || true
  done
fi

exec "$@"
