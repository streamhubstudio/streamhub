# plugins-vendor/ — composed decoupled Studio Apps (backend side)

In this public repository the 12 worker-backed Studio Apps pinned in
`apps.lock.json` ship **pre-composed**: `<id>/streamhub.app.json` plus the worker
source (`<id>/worker/**`) here, and the UI side in
`streamhub-web/src/plugins-vendor/<id>/`. The core discovers them at boot
(`$STREAMHUB_PLUGINS_VENDOR_DIR` › `<exe dir>/plugins-vendor` › `<repo>/plugins-vendor`);
`deploy/Dockerfile` and `deploy/make-core-bundle.sh` ship them next to the binary.
