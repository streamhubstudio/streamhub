# Cluster 2-nodos — prueba real + cómo funciona el balanceo

**Fecha:** 2026-07-02. **Nodos:** `node01` (203.0.113.11, 4c/8GB, docker-compose, origin de
prueba) y `media01-prod` (203.0.113.10, 8c/8GB, **producción con cámaras en vivo**, deploy
nativo systemd). IPs **contiguas en la misma subred VPS** → latencia inter-nodo mínima.

## Qué se probó (plano de control — SIN tocar la media de prod)

Se ejercitó **el módulo `cluster` end-to-end entre los dos servidores reales**, sin reiniciar
ni reconfigurar nada de producción (a media01 sólo le salió un `curl` saliente):

| Paso | Resultado |
|---|---|
| `POST /cluster/join` (X-Cluster-Token) desde media01 → node01 | 200, `nodeId`, devuelve las **LiveKit keys cluster-wide** + `publicWsUrl` |
| `POST /cluster/heartbeat` con `stats` reales (cpu/ram/cores) | `{ok:true}`, guardó los stats |
| node01 auto-registrado | registro de **2 nodos** |
| `GET /cluster/nodes` (Bearer sk_ global) | ambos `active`, `stale:false`, con stats |
| `PATCH /cluster/nodes/:id {status:'draining'}` | media01 → `draining` (deja de recibir rooms nuevos), verificado, restaurado a `active` |
| Staleness | `stale=true` automático si `last_seen_at` > 90s (nodo caído) |

**Conclusión:** el plano de control del cluster (alta por token, registry, heartbeat con
métricas, detección de nodo caído, administración drain/activar/borrar) **funciona con dos
nodos reales**. Es lo que el feature implementa hoy.

## Cómo funciona el balanceo

1. **Afinidad de sala por LiveKit + Redis compartido.** No hay un balanceador propio de
   StreamHub: **cada room lo sirve UN solo nodo LiveKit**, elegido por LiveKit vía el Redis
   compartido (correcto por construcción — una sesión WebRTC vive en un servidor). El cliente
   que cae en cualquier nodo de señalización es ruteado al nodo dueño del room; la **media
   (UDP 7882 / RTMP 1935 / WHIP 8080) va directa a la IP pública de ese nodo** (`use_external_ip`).
2. **Palanca de colocación = `status` del nodo** (registry StreamHub): `active` recibe rooms;
   `draining` no recibe nuevos pero mantiene los vivos; `disabled` fuera. Es el control que se
   demostró (drain/activar). El scheduler capacity/region-aware **todavía no está** (roadmap):
   hoy la colocación fina es 100% de LiveKit.
3. **Viewers masivos:** el techo WebRTC por nodo es la NIC (~300-400 viewers @2.5Mbps). Para
   masivo → HLS + CDN/P2P, no más nodos WebRTC (ver `DISTRIBUTION-CDN-P2P.md`).

## Qué falta para un mesh de MEDIA real (y por qué no se hizo contra prod)

El plano de **media** (que un room se sirva en node01 y media01 lo "vea") requiere:
1. **Redis compartido y alcanzable** entre nodos (hoy prod bindea `127.0.0.1` sin password).
2. **Mismas LiveKit keys** en todos los nodos (el `join` ya las reparte — ✔).
3. Ambos `livekit-server` apuntando al **mismo Redis** (prod usa `redis: address: localhost:6379`).

Hacer esto contra **media01 (prod)** implica **reiniciar su Redis y su LiveKit** →
**se cortan TODAS las cámaras en vivo** unos segundos, y activa dos **gaps conocidos**:

- **Grabación cross-node (bug real):** el egress de una grabación puede caer en el OTRO nodo y
  escribir el MP4 en el disco equivocado; el core del origin no lo encuentra → la grabación
  **falla silenciosa** (ver `PRODUCT-EVALUATION.md` / hallazgo de arquitectura). Meter node01 al
  cluster LiveKit de prod podría **romper grabaciones de prod**.
  **Mitigación (default desde el instalador):** los nodos `--join --node-type common` ya **no
  levantan egress** salvo `--with-egress` explícito (afinidad de egress al origin), así que
  todos los artefactos aterrizan en el disco del origin y esto deja de dispararse en un cluster
  instalado con defaults. El `--with-egress` re-abre el gap (warning ruidoso). **Fix definitivo:
  S3 como transporte** (egress escribe directo a S3, el core resuelve el objeto en vez de un path
  local) — Wave C en [../architecture/CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md).
- **Shape distinto:** media01 es nativo systemd; node01 es docker-compose. Funciona (coordinan
  por Redis+keys), pero conviene homogeneizar.
- **Sin router capacity/region-aware:** la colocación es la interna de LiveKit; no hay steering
  propio por carga/región todavía.

Por eso **no se melda node01 al LiveKit de prod**: protege las cámaras y las grabaciones vivas.

## Runbook — mesh de media real (2 nodos limpios, o ventana de mantenimiento)

Origin cluster-ready (en un nodo que se pueda reiniciar):

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --cluster-redis-bind <IP-privada-o-publica-del-origin>     # bindea Redis + password + advierte URL
ufw allow from <IP-del-edge> to any port 6379 proto tcp      # sólo el edge
```

Edge (nodo fresco):

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- --join \
  --master-token <clt_...> --master-ip <IP-origin> --master-url https://<origin>
# levanta sólo livekit/ingress/egress contra el Redis del origin, con sus keys
```

Con eso los rooms se reparten entre nodos por afinidad LiveKit. **Recomendación:** validar el
mesh de media en **dos cajas frescas** (ambas tipo node01), o en media01 sólo en una ventana de
mantenimiento con aceptación explícita del corte de cámaras + del gap de grabación cross-node.
El **plano de control** (lo probado acá) ya sirve para inventario/anuncio/salud/drain de nodos.

---

# Full media-mesh test node01+node02 (2026-07-03)

**Nodos (ambos NO-producción; media01/prod no se tocó):**

| Nodo | IP | Shape | Rol |
|---|---|---|---|
| `node01` (host `media02`) | 203.0.113.11 | Ubuntu 26.04, 4c/8GB, docker-compose | **origin/master** — core+redis+nginx+livekit+ingress+egress |
| `node02` (host `media03`) | 203.0.113.12 | Ubuntu 26.04, 8c/4GB, caja virgen | **edge** — sólo livekit+ingress+egress (join día-1) |

Todo por el **installer publicado** (`curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- ...`).
RTT inter-nodo: **0.22 ms** (misma subred VPS).

## Matriz de resultados

| # | Paso | Resultado |
|---|---|---|
| 1 | Preflight (DNS node02→.58, node02 limpio, node01 healthy) | ✅ PASS |
| 2 | Origin prep: re-run installer con `--cluster-redis-bind 203.0.113.11` | ✅ PASS — idempotente (apps/secretos/cert intactos); redis bindea 127.0.0.1 + IP pública con password generado; `STREAMHUB_CLUSTER_REDIS_URL` publicado; `ufw allow from 203.0.113.12 to any port 6379 proto tcp` (sólo el edge; host-networking ⇒ ufw sí aplica) |
| 3 | Join node02 (installer publicado, `--join --master-token/--master-ip/--master-url --node-name node02`) | ✅ PASS — registrado (`nodeId 67fbf296…`), recibe keys LiveKit idénticas + redis con password + webhook→core del origin; levanta SOLO livekit/ingress/egress; re-run del join idempotente (mismo nodeId) |
| 4 | **Media mesh**: publish RTMP + playback HLS/WebRTC | ✅ PASS (con fixes de installer, ver abajo) — 2 livekit en el hash `nodes` de redis; rooms cruzan nodos en ambos sentidos; WebRTC reproduce siempre; HLS sólo si el egress cae en el origin (gap) |
| 5 | Drain / caída de nodo | ⚠️ PARCIAL (esperado) — `draining` es SOLO registry (LiveKit lo ignora: room nuevo aterrizó en node02 estando draining). Caída dura de livekit-node02: degradación correcta (detalle abajo) |
| 6 | Gap de grabación cross-node | ✅ REPRODUCIDO (MP4 y HLS-live) con logs exactos |
| 7 | Load sanity: 7 streams simultáneos repartidos 4/3 | ✅ PASS — los 7 reproducen 640x360 en tiempo real (Δt=4.0s/4s, jitter 0–3 ms) |

## Fixes de installer aplicados (working tree, republicados en www.streamhub.studio)

El deploy docker tenía la grabación/HLS **muerta de fábrica** (aun single-node). Tres fixes,
validados end-to-end re-corriendo el installer publicado en ambos nodos:

1. **`install.sh`** — el data dir se creaba bajo `umask 077` ⇒ `data/` quedaba `700 root:root`
   y el egress (uid 1001 "egress", gid 0) no podía ni atravesarlo:
   `Local upload failed: mkdir /data/apps: permission denied`. Fix: `mkdir -p data/apps` +
   `chmod 755 data` + `chmod -R g+rwX data/apps` (g+w solo NO alcanza: sin `x` el grupo no
   atraviesa — se detectó como `drwx-w----`).
2. **`deploy/core-entrypoint.sh`** — `umask 002`: todo dir/archivo que crea el core (root)
   queda 775/664 (grupo 0), así el egress uid 1001/gid 0 escribe HLS/MP4 en los dirs que el
   core le pasa. (Intento descartado: `user: "0:0"` en el egress — su entrypoint arranca
   pulseaudio, que se niega a correr como root ⇒ crash-loop silencioso sin logs.)
3. **`docker-compose.yml`** — `EGRESS_CPUS` default **2 → 4**: livekit-egress rechaza
   room-composite (HLS/grabación) con <4 CPUs disponibles (`not enough cpu for some egress
   types, minimumCpu: 4`) ⇒ todo StartEgress moría con `twirp error unknown: no response
   from servers`. Nunca bajar el cap de 4.

Republicación: `install.sh` + `streamhub-src.tar.gz` (tarball del working tree, tracked files)
scp a `ploi@203.0.113.20:/home/ploi/streamhub.studio/{public,dist}/`. **Los fixes NO están
commiteados** — quedan en el working tree para revisión.

## Cómo distribuye LiveKit los rooms (comprobado)

- La verdad vive en redis compartido: hash `nodes` (livekit nodes) y hash **`room_node_map`**
  (room → nodeID). El log del allocator lo confirma: `roomallocator.go: selected node for room`.
- **El room NO se queda donde entra el RTMP**: mesh-a entró por node01 y aterrizó en node02;
  mesh-b entró por node02 y aterrizó en node01. El ingress publica cross-node por UDP 7882.
- El allocator elige el nodo **menos cargado** (sysload): con node01 cargando core+redis+nginx,
  los rooms nuevos sesgan al edge (llegó a 3:1). No hay steering propio de StreamHub.
- Señalización: el viewer entra por wss://node01/rtc; si el room vive en node02, la señal se
  relaya vía redis y **la media va directa** desde la IP pública del nodo dueño
  (verificado con el candidato ICE remoto del navegador: `203.0.113.12:7882 udp`).
- El `nodeID` de livekit es **por proceso**: al reiniciar livekit en node02 volvió con otro id
  (`ND_K7voDJZKEgRf` → `ND_k2t3TAtyQsKx`) y el viejo se limpia solo del hash.

## Drain / caída — comportamiento real

- `PATCH /cluster/nodes/:id {status:'draining'}` ✅ se refleja en el registry, los rooms vivos
  siguen, **pero un room nuevo aterrizó en node02 estando draining** ⇒ hoy `draining` es
  puramente administrativo; no hay plumbing al allocator de LiveKit (gap de roadmap ya
  documentado arriba: "scheduler capacity/region-aware todavía no está").
- **Caída dura** (`docker stop streamhub-livekit` en node02, 20:09):
  - Publishers que ingestaban por **node01** (rooms en node02): reconectan solos, sus rooms se
    **re-alocan a node01** (~60–90 s) y la reproducción vuelve (probe: media desde .57). ✅
  - Publishers que ingestaban por **node02**: mueren TODOS (`Conversion failed!`), incluso los
    de rooms hospedados en node01 — el ingress usa `ws_url: 127.0.0.1:7880` ⇒ **la sesión RTMP
    está atada al livekit LOCAL del nodo de ingesta**. No hay failover de sesiones de ingest;
    el publisher debe reconectar contra un nodo vivo (DNS/LB por delante en producción).
  - Publish nuevo durante la caída: ✅ room en node01, reproduce.
  - Registry: `stale=true` a los >90 s sin heartbeat. ✅ (ver gap de heartbeat abajo)
  - Recuperación: `docker start` ⇒ el livekit reaparece en el hash `nodes` (id nuevo) y vuelve
    a recibir rooms. ✅

## Gap de grabación cross-node — repro exacta

Cualquier egress worker del cluster puede reclamar un StartEgress (cola compartida en redis);
el que lo reclama **escribe en SU disco local**, y el core del origin busca el archivo en el
SUYO. Dos sabores reproducidos:

- **MP4** (`POST /apps/live/recording/start {"roomName":"live-mesh-d"}`, room en node02, lo
  reclamó el egress de node02): el MP4 quedó **sano en node02**
  (`/opt/streamhub/data/apps/live/recordings/live-mesh-d-1783109579630.mp4`, 18.6 MB) y el core
  en node01 falló el VOD:
  `{"source":"recording","meta":{"vodId":1,"detail":"/data/apps/live/recordings/live-mesh-d-1783109579630.mp4"},"msg":"local recording file missing"}`
  → VOD `failed`; sin callback configurado es **fallo silencioso** (la grabación en sí fue bien).
- **HLS en vivo** (`.../hls/start` de mesh-b, lo reclamó node02): segmentos escritos en node02,
  `https://node01…/hls/live/live-mesh-b/index.m3u8` → **404** mientras el egress reporta OK.
  El mismo start para mesh-a lo reclamó node01 → playlist y segmentos 200 OK.
- El claim es efectivamente aleatorio entre workers libres ⇒ ~50% de grabaciones rotas con 2
  nodos. **Mitigaciones posibles**: storage compartido (NFS/S3-direct del egress), o afinar el
  StartEgress al worker del nodo del room / del origin, o que el core busque el archivo vía el
  nodo que lo escribió.
- **Mitigación aplicada (afinidad de egress, default):** desde el instalador, un `--join
  --node-type common` **no arranca egress** salvo `--with-egress`. Con egress sólo en el origin,
  **todo** StartEgress lo reclama el egress del origin y escribe en el disco que el core mira →
  grabación + HLS vuelven a funcionar. El costo: la capacidad de egress queda **capada al
  origin** hasta el fix definitivo. El flag `--with-egress` re-habilita egress en el nodo (con
  warning) para quien acepte el gap. Ver [INSTALL-NODE.md](INSTALL-NODE.md#egress-affinity-default--the---with-egress-tradeoff).
- **Fix definitivo (Wave C): S3 como transporte** — el egress escribe directo al bucket de la
  app y el core resuelve el objeto S3 en vez de un path local (upload verifica el objeto,
  download por presigned). Con eso, egress en **cualquier** nodo vuelve a ser correcto. Diseño
  en [../architecture/CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md).
- Nota extra (no-mesh): con el room y el egress AMBOS en node01 la grabación local también
  terminó `failed` por `upload flow failed: S3 config: bucket is required` — sin S3 por-app no
  hay fallback local-only y el MP4 (intacto en disco) queda huérfano.

## Otros hallazgos

- **Heartbeat: el installer no provisiona agente** — un edge queda `stale=true` a los 90 s del
  join (el join es el único "latido"). Workaround dejado en AMBOS nodos:
  `/usr/local/bin/streamhub-heartbeat.sh` + `/etc/cron.d/streamhub-heartbeat` (cada 60 s,
  `POST /cluster/heartbeat` con X-Cluster-Token y stats cpu/ram/cores). TODO: que el installer
  lo ship-ee (systemd timer) o que un agente corra en el nodo.
- **Flake cross-node (1 de 7 sesiones)**: una sesión de ingress (mesh-c, ingest node01 → room
  node02) publicó SOLO el audio — la renegociación del track de video quedó colgada tras
  `have-local-offer → stable` (sin "published track" de video); el player mostraba "Audio
  only/Empty room" mientras el core reportaba `publishers:1` (sin señal de salud del video).
  Re-publicar el RTMP lo arregló. Vigilar si se repite.
- El puerto 6379 en la IP pública queda protegido por password + ufw allow-from (sólo el edge)
  + default-deny. Con `network_mode: host` ufw SÍ filtra a los contenedores (sin bypass
  DOCKER-chain). Igual: red privada/VPN recomendada para producción.

## Estado final (se deja así)

- node01: origin completo, healthy, 5 apps intactas; redis cluster-ready (127.0.0.1 +
  203.0.113.11, password); `EGRESS_CPUS=4` en `.env`.
- node02: edge unido (livekit+ingress+egress contra el redis del origin), healthy,
  `EGRESS_CPUS=4`; hostname del SO sigue siendo `media03` (se registró como `node02` vía
  `--node-name`).
- Registry: `node01` y `node02` **active / stale=false** (heartbeat cron activo en ambos); la
  fila vieja `media01-prod` del test de control-plane se borró.
- Streams de prueba (mesh-a…g) detenidos; los ingress quedan definidos (inactivos) en la app
  `live`; VODs 1 y 2 quedan como evidencia del gap (`failed`).
- Publicado en la landing: `install.sh` y `streamhub-src.tar.gz` con los 3 fixes (pendientes
  de commit en el repo).
