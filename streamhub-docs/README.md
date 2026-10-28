# StreamHub documentation

The documentation is published at **https://streamhub.studio/docs** (architecture, operations,
API reference, features, integrations, testing).

This folder only keeps machine-readable artifacts referenced by the code:

- `api/openapi.json` — OpenAPI snapshot of the REST API (the contract the Go core's routes are checked against; a running core serves the live spec at `/api/v1/openapi.json`).
- `development/streamhub.app.schema.json` — JSON schema of the `streamhub.app.json` Studio App manifest.
- `integrations/esp32cam_ws_ingest.ino` — example ESP32-CAM WebSocket ingest firmware.
