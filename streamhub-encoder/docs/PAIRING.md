# StreamHub Encoder ↔ StreamHub — protocolo de emparejamiento (lado encoder)

**Fuente de verdad del protocolo:** `streamhub-docs/features/devices.md` (rama `feat/encoder-core`, módulo
`streamhub-core-go/internal/devices`). Este documento describe **cómo lo implementa el encoder**
(`internal/streamhub/device.go` + `service.go`) y qué espera de cada respuesta. Si el core cambia un campo, frame o
código de estado, hay que cambiar el encoder en la misma release.

Hay dos formas de integrar el encoder con StreamHub:

| Modo | Qué necesita | Qué hace | Estado |
|---|---|---|---|
| **REST "funciona hoy"** | URL de StreamHub + token `sk_` con scope de app | el encoder crea/reusa el ingress con `POST /api/v1/apps/{app}/ingress` y publica RTMP o WHIP | funciona con cualquier core ≥ 3.4 |
| **Nativo (device plane)** | el core con `internal/devices` y `STREAMHUB_DEVICES_ENABLE=on` | código en pantalla → el operador lo reclama → el core empuja destinos y comandos por un WebSocket saliente | requiere el core de `feat/encoder-core` |

## 1. Modo REST (salida `type: "streamhub"`)

```json
{"id":"sh","type":"streamhub","enabled":true,
 "streamhub":{"baseUrl":"https://streamhub.example.com","app":"live","token":"sk_…","room":"cam1","protocol":"rtmp","deleteOnRemove":true}}
```

1. Si la salida ya tiene `ingressId`+`resolvedUrl` guardados, `GET /api/v1/apps/{app}/ingress/{id}`: si existe lo reusa
   (misma stream key tras reinicios); si da 404 (lo borraron en el dashboard) crea uno nuevo.
2. Crear: `POST /api/v1/apps/{app}/ingress` con `{inputType: rtmp|whip, room, participantIdentity:
   "encoder-<deviceId>-<canal>", participantName}`.
   - RTMP → publica en `rtmp_url` (incluye la key).
   - WHIP → publica en `url` (p. ej. `http://host:8080/w`) con `Authorization: Bearer <streamKey>`.
3. La resolución (`ingressId`, `resolvedUrl`, `streamKey`) se persiste en el config sin reiniciar la salida.
4. Errores de red/5xx se reintentan con backoff (2 s → 60 s); el error queda visible en el estado de la salida.
5. Al **quitar** la salida con `deleteOnRemove: true`, el encoder borra el ingress (`DELETE …/ingress/{id}`).

Requisito del plano LiveKit: video **H.264 progresivo** (el ingress de LiveKit no decodifica HEVC); WHIP además sin
B-frames. La validación lo exige. HEVC hacia StreamHub va por SRT passthrough (modo nativo, `protocol: srt`).

## 2. Modo nativo

### 2.1 Pairing (device code)

```
encoder                                         core
  POST /api/v1/devices/pair/start  {model, version, serial} ─▶
  ◀─ 201 {data:{deviceId, code, displayCode, pollToken, expiresAt, pollInterval}}
  (muestra displayCode "K7Q4-M2XP" en la UI local / API)
  GET /api/v1/devices/pair/{deviceId}?token=<pollToken>   cada pollInterval s
  ◀─ 200 {data:{status:"pending", expiresAt}}
  ◀─ 200 {data:{status:"claimed", deviceId, credential:"dk_…", wsUrl, app}}   (una sola vez)
```

- `serial` = `device.id` del encoder (`enc-<12 hex>`, generado en el primer arranque).
- El encoder **persiste la credencial apenas la recibe** (`encoderd.json`, 0600) y nunca la devuelve por la API
  (se redacta como `***`).
- `404` en el poll = código vencido/consumido → estado `unpaired` con "pairing code expired; start again".
- `429` en el poll → duplica el intervalo.

API local: `POST /api/v1/streamhub/pair {"baseUrl":"https://…"}` → `{state:"pending", displayCode, expiresAt}`;
`GET /api/v1/streamhub` → estado (`unpaired|pending|paired|connected|revoked`); `POST /api/v1/streamhub/unpair`.

### 2.2 Canal de control

`GET <wsUrl>` (WebSocket) con **`Authorization: Device <credential>`** (solo header, nunca query string).

| Situación | Acción del encoder |
|---|---|
| `401` en el upgrade o cierre **4401** | credencial revocada: borra credencial y salidas gestionadas, estado `revoked`, deja de reconectar |
| cierre **4409** | otra conexión con la misma credencial la reemplazó: espera 30 s antes de reintentar |
| cualquier otro corte / `503` | reconecta con backoff 1 s → 30 s (se resetea tras 1 min conectado) |
| ping WS del core cada 15 s | lo contesta la librería (coder/websocket) |

**Frames encoder → core**

- `hello` (al conectar): `{type, model:"StreamHub Encoder", version, serial, capabilities:{channels:[{id,name}],
  protocols:["rtmp","srt"], encoders:["x264_h264","nvenc_h265",…], gpus, v4l2, decklink}}`.
- `status` cada 10 s y justo después de aplicar un `config`: `{type, cpu, gpu|null, uptimeSec,
  channels:[{id, state, bitrateKbps, fps, error|null}], errors:[…]}`.
  `state` ∈ `idle|starting|live|reconnecting|error|stopped` (un canal `degraded` — vivo pero con una salida caída — se
  informa como `live` con `error: "output: …"`). Los problemas al aplicar el último `config` van en `errors[]`.
- `command_result`: `{type, id, ok, message}` para cada `command`.

**Frames core → encoder**

- `config` `{rev, device:{id,name,app}, channels:[{id, name, room, protocol, publishUrl, streamKey, ingressId}]}`:
  - se ignora un `rev` menor al último aplicado;
  - por cada canal del encoder cuyo `id` aparece: una salida **gestionada** `id:"streamhub"`, `managedBy:"streamhub"`:
    `rtmp` → salida RTMP a `publishUrl`; `srt` → salida SRT caller a `srt://host:port` con
    `streamid` sacado de la query (`publish:<app>/<ptk_key>`), latencia 500 ms; (`whip` también se acepta);
  - canal **ausente** del frame → se le quita la salida gestionada (deja de publicar);
  - las salidas del operador nunca se tocan; el operador no puede editar ni crear salidas `managedBy`;
  - el cambio se aplica **en caliente**: solo arranca/para la salida gestionada, el encode sigue;
  - el frame **no** cambia `enabled` del canal (para eso están `start`/`stop`).
- `command` `{id, action, channel?, preset?}`:

  | action | efecto | respuesta |
  |---|---|---|
  | `start` / `stop` | `enabled=true/false` del canal (persistido) | `ok:true "started"/"stopped"` |
  | `restart` | reinicia el engine del canal (las salidas siguen); si estaba parado, lo arranca | `ok:true "restarted"` |
  | `apply_preset` | aplica un perfil de encode incorporado (`GET /api/v1/presets` → `profiles[].id`) | `ok:true "preset … applied"` |
  | `reboot` | solo si `ENCODERD_ALLOW_REBOOT=true` (`systemctl reboot` a los 2 s) | si no: `ok:false "reboot is disabled…"` |
  | otro | — | `ok:false "unknown action …"` |

- `error` / `pong`: informativos, se ignoran.

## 3. Pruebas

- Unitarias (`internal/streamhub/streamhub_test.go`): servidor falso con httptest + coder/websocket que implementa
  pair/start, poll (pending→claimed), WS con header `Device`, `config` con RTMP y SRT, rev viejo ignorado, rotación de
  key, canal ausente, comandos (`start`, `apply_preset`, `reboot` rechazado, acción desconocida, `restart`) y revocación
  4401; 401 en el upgrade = revocado; 404 en el poll = vencido.
- Real (`test/real/streamhub-real.sh pairing`): contra el core de `feat/encoder-core` levantado con docker compose.
  Resultados en `docs/TEST-REPORT.md`.
