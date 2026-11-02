# Restricciones de publicación por app

> 3.4.0 — quick wins de la [matriz AntMedia](ANTMEDIA-APP-SETTINGS-MATRIX.md) §5
> (`allowedPublisherCIDR`, `maxBitrateAccept`). Las dos están **apagadas por
> defecto**: una app sin las claves se comporta exactamente como antes.

```yaml
# apps/<app>/config.yaml
features:
  allowed_publisher_cidr: ["203.0.113.0/24", "2001:db8::/32"]   # ↔ allowedPublisherCIDR
  max_bitrate_accept: 6000000                                   # bits/s ↔ maxBitrateAccept
```

Las dos se editan desde el dashboard (**Integraciones → Funciones → Restricciones
de publicación**; el tope se carga en kbps) o con
`PATCH /api/v1/apps/{app}/config`:

```json
{ "features": { "allowedPublisherCidr": ["203.0.113.0/24"], "maxBitrateAccept": 6000000 } }
```

`[]` / `0` las apagan (y borran la clave del YAML). `GET /apps/{app}/config`
devuelve `features.allowedPublisherCidr` / `features.maxBitrateAccept` solo
cuando están puestas.

## `allowed_publisher_cidr` — desde dónde se puede publicar

Lista de direcciones IPv4/IPv6 o CIDRs (una IP suelta es `/32` / `/128`). En el
YAML también se acepta el formato AntMedia: un string separado por comas. Por
PATCH cada entrada se valida (400 si alguna no parsea, máximo 64); una entrada
inválida escrita a mano en el YAML **no matchea nada** (falla cerrado: un typo
nunca abre la app).

Dónde se aplica:

| Camino de publicación | Qué IP se mira | Resultado fuera de la lista |
|---|---|---|
| `POST /apps/{app}/tokens` con permiso de publicar (`canPublish` ausente o `true`; WebRTC, SDK/adaptor) | la del **caller** del endpoint (`X-Forwarded-For` que pone Caddy/nginx, si no la del socket) | **403** `publishing to app <app> is not allowed from <ip> (allowedPublisherCidr)` |
| RTMP/SRT por el front MediaMTX de puerto único `:1935` ([rtmp-single-port.md](rtmp-single-port.md)) — plano passthrough y plano LiveKit (`live/<streamKey>`) | la del **encoder** (campo `ip` del hook `authHTTPAddress`) | el hook responde 401 y MediaMTX corta el push antes de que fluya media |

Límites (por arquitectura, documentados a propósito):

- **Push directo al ingress de LiveKit** (modelo multi-puerto, sin
  `STREAMHUB_MEDIAMTX_ENABLE`) y **WHIP** (`:8080`): el encoder habla con LiveKit
  sin pasar por el core, y ni el ingress ni sus webhooks exponen la IP de
  origen, así que no hay dónde aplicar la lista. Para cerrar esos puertos usá
  el firewall del host (o activá el front MediaMTX para RTMP).
- **Tokens minteados server-side**: si tu backend mintea el token de
  publicación y se lo pasa al navegador, la IP que se valida es la de **tu
  backend** — tiene que estar en la lista (o mintealo desde el cliente con el
  adaptor para que se valide la del publisher).
- Los tokens de solo lectura (viewers, `recorder`, `play-token`) nunca se
  restringen.
- La lista no reemplaza a la [seguridad de red global](network-security.md)
  (allow/blocklist + auto-ban de toda la API): se suma.

## `max_bitrate_accept` — tope de bitrate de ingest

Bits por segundo (video + audio). Aplica a los **ingress de LiveKit** (RTMP,
WHIP, URL pull): cuando el bitrate medido que reporta LiveKit
(`IngressState.video/audio.averageBitrate`) supera el tope, el core:

1. saca al participante del ingress de la sala (`RemoveParticipant`) — **el
   stream key se conserva**: el encoder puede reconectar y vuelve a evaluarse;
2. loguea `cut ingress publishing above maxBitrateAccept` (fuente
   `livekit-webhook`);
3. manda el callback `stream_ended` con
   `{ streamId, room, ingressId, reason: "max_bitrate_exceeded", bitrate, maxBitrateAccept }`.

El corte es **reactivo**, no una admisión: LiveKit no tiene hook previo ni
webhook de actualización de estado del ingress, así que el core barre el estado
cada **15 s** (`ListIngress`, solo si alguna app tiene tope) y además lo mira en
`ingress_started` por si ya trae el bitrate. Un stream por encima del tope puede
llegar a publicar unos segundos. Una misma sesión cortada no se vuelve a cortar
durante 30 s (estado viejo de LiveKit); una reconexión (sesión nueva) se evalúa
enseguida.

No cubre: publishers WebRTC (el bitrate lo elige el cliente; usá las capas de
simulcast) ni el plano passthrough (remux `-c copy`, sin medición).

## Prueba manual con media (srv03)

Los tests Go cubren la lógica con fakes (ver
[UNIT-TESTS.md](../testing/UNIT-TESTS.md)); queda para la prueba con media real:

- `max_bitrate_accept: 2000000` en una app, push RTMP con OBS a 6 Mbps → el
  participante del ingress sale de la sala en ≤ ~15 s, llega el `stream_ended`
  con `reason: max_bitrate_exceeded`, OBS reconecta y se vuelve a cortar; a
  1.5 Mbps sigue publicando. Confirmar que sacar al participante corta la
  sesión del ingress (si LiveKit lo re-uniera, documentarlo y cambiar a
  `DeleteIngress`).
- Con el front MediaMTX: `allowed_publisher_cidr` con la IP de la oficina →
  push desde ahí OK; desde otra red (4G) MediaMTX rechaza el publish.
