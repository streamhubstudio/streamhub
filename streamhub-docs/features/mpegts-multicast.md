# MPEG-TS over UDP (unicast + multicast) → HLS passthrough (PULL, no transcode)

**Status:** shipped (env-gated OFF by default, same switch as RTMP/SRT
passthrough). **Module:** `streamhub-core-go/internal/passthrough`.

Ingest a broadcast-style **MPEG-TS transport stream over UDP** — unicast or
**multicast** (incl. RFC 4607 source-specific multicast) — and serve it as HLS by
**remuxing** (`ffmpeg -c copy`), **bypassing LiveKit** entirely. No re-encode ⇒
near-zero CPU and no GPU. This is the natural next passthrough transport after
RTMP/SRT and closes the biggest ingest-protocol gap versus broadcast-oriented
media servers (RFC 4607 source-specific multicast over MPEG-TS/UDP).

Unlike RTMP/SRT passthrough, which are **push listeners** (an encoder connects
IN, the minted stream key gates the listener), an MPEG-TS ingress is a **PULL
source**: there is no client push and no stream key. The remux process connects
**OUT** to the multicast group / unicast port and reads the transport stream:

```
ffmpeg -hide_banner -loglevel warning \
       -f mpegts -i 'udp://@239.1.1.1:5000?sources=10.0.0.5&fifo_size=1000000&overrun_nonfatal=1' \
       -c copy -f hls -hls_time 4 -hls_list_size 6 \
       -hls_flags delete_segments+append_list \
       -hls_segment_filename <dir>/seg_%05d.ts <dir>/index.m3u8
```

The output HLS lands in the same `<DATA_DIR>/apps/<app>/hls/<room>/` that the
core already serves under `/hls/<app>/<room>/…`, so playback is free (no player
change). The source `MUST` be **H.264/AAC** inside the MPEG-TS (a `-c copy`
remux never re-encodes).

## When to use it

- An IPTV/OTT headend or broadcast encoder already emits **MPEG-TS over UDP**
  (multicast on the LAN, or unicast to this host) and you only need HLS playback.
- You want to bridge a **multicast** contribution/distribution feed into HLS for
  browsers/CDNs without a heavyweight transcoder.
- The source is one of many channels on a multicast group and you want a
  cheap per-channel remux (no per-channel CPU/GPU).

Not for: a browser/OBS publisher (use RTMP/WHIP), a lossy long-haul contribution
link that speaks SRT (use `inputType:'srt'`), or anything that needs WebRTC /
adaptive / recording / room features (those require the LiveKit path — see the
capabilities-lost block below).

## The udp:// source (ffmpeg option semantics, verified)

The operator supplies a `udp://@GROUP:PORT` source. StreamHub **never** hands the
raw string to ffmpeg: it parses it, allow-lists + validates every component, and
**rebuilds a canonical URL** (`internal/passthrough/mpegts.go`). Unknown query keys are
rejected, so nothing typed into the source can inject an arbitrary ffmpeg option.

| Form | Meaning |
|------|---------|
| `udp://@239.1.1.1:5000` | Join **multicast** group `239.1.1.1`, receive on port `5000`. |
| `udp://@:5000` | **Unicast** receive on port `5000`, all interfaces (INADDR_ANY). |
| `udp://@239.1.1.1:5000?sources=10.0.0.5` | **Source-specific multicast** (SSM, IGMPv3): only receive from source `10.0.0.5`. |

The leading `@` is ffmpeg's receive/bind convention (an empty userinfo delimiter
in the URL): the socket **binds locally** and, when the host is a class-D group,
**joins** that multicast group. A source without `@` (`udp://239.1.1.1:5000`) is
accepted and normalized to the `@` receive form.

Supported query params / structured fields (verified against ffmpeg's
`ffmpeg-protocols` "udp" section + `libavformat/udp.c`):

| Param / field | ffmpeg option | Meaning · default |
|---|---|---|
| `sources` | `sources=` | **SSM include** list (IGMPv3 `IP_ADD_SOURCE_MEMBERSHIP`): only receive/join traffic from these source IPs. Comma-separated IPv4s. Multicast only. |
| `block` | `block=` | SSM **exclude** list — exclude these source IPs from the subscription. Multicast only. |
| `localaddr` | `localaddr=` | Local interface **IPv4** used to send packets / join the group — the NIC-selection seam for **multi-homed hosts**. |
| `fifoSize` | `fifo_size=` | UDP receiving **circular buffer** size, in units of 188-byte packets (ffmpeg default `7*4096` = 28672 ≈ 5.4 MB). Raise it for bursty / high-bitrate multicast. Bounds: `1 … 100000000`. |
| `overrunNonfatal` | `overrun_nonfatal=` | **Survive** a receive-buffer overrun (drop packets) instead of aborting. ffmpeg default `0`; **StreamHub defaults it ON (`1`)** so a transient burst never kills the remux. |

Structured create-body fields (`sources`, `localaddr`, `fifoSize`,
`overrunNonfatal`) **override** the same key if it also appears in the `url`
query. The dashboard's create form sends the structured fields; API/`curl` users
can put everything in the `url`.

## Validation rules (each a 400)

- `url` must be a `udp://` URL with a **port** in `1 … 65535`.
- Host is either empty (unicast receive) or a valid **IPv4** — a multicast group
  must be in **224.0.0.0/4** (first octet 224–239); hostnames are rejected (a
  group is always a literal address).
- `sources` / `block` require a **multicast** host and must be comma-separated
  valid IPv4s (≤ 16 entries).
- `localaddr` must be a valid IPv4.
- `fifoSize` must be an integer in `1 … 100000000`.
- Any query key other than the allow-list above is rejected.

## API

MPEG-TS rides the existing ingress endpoints with the new type. It is
**passthrough-locked**: multicast ingest only makes sense as a remux, so
`inputType:'mpegts'` **requires** `mode:'passthrough'` (transcode mode / the
`enableTranscoding` flag are a 400).

```http
POST /apps/{app}/ingress
{
  "inputType": "mpegts",
  "mode": "passthrough",
  "room": "channel-7",
  "url": "udp://@239.1.1.1:5000",
  "sources": "10.0.0.5",          // optional — SSM include (multicast only)
  "localaddr": "192.168.1.10",     // optional — NIC to join on
  "fifoSize": 1000000,             // optional — bump the receive buffer
  "overrunNonfatal": true          // optional — default true
}
```

Response (no push URL, no stream key — it PULLS):

```json
{
  "data": {
    "mode": "passthrough",
    "ingressId": "pti_mpegts_…",
    "inputType": "mpegts",
    "source_url": "udp://@239.1.1.1:5000?sources=10.0.0.5&fifo_size=1000000&overrun_nonfatal=1",
    "hls_url": "/hls/{app}/{room}/index.m3u8",
    "player_url": "/play/{app}/{room}",
    "capabilities": { "mode": "passthrough", "remux": true, "…": "…", "lost": ["…"] }
  }
}
```

- `GET /apps/{app}/ingress` merges the MPEG-TS rows (`inputType:'mpegts'`,
  `source_url`) alongside the LiveKit + RTMP/SRT ingresses.
- `DELETE /apps/{app}/ingress/{id}` (id `pti_mpegts_…`) stops the remux, cleans
  the HLS dir and drops the ingress via the passthrough plane (never touches
  LiveKit).

## Lifecycle (desired-state, resumed at boot)

Because it is a pull, the remux is armed **immediately** on create (desired
`live`) and stays running, reading the group. The canonical `udp://` source is
persisted in `ingress_auth.source_url` (per-app `app.db`, APP migration 14), so a
**core restart re-arms** each MPEG-TS ingress with a byte-for-byte identical
ffmpeg input. A dead/absent source makes ffmpeg exit; the remux manager restarts
it with a capped backoff (same supervision as RTMP/SRT passthrough).

## Health

Reuses the passthrough stream-status plumbing: a fresh HLS playlist (written
within ~30 s) ⇒ the mirrored `streams` row is **active** (shows Live in the
dashboard); a stale/absent playlist ⇒ **Offline**. So a dead multicast source
surfaces as Offline like any other passthrough stream, with no extra wiring.

## Capabilities given up (media never enters LiveKit)

Same as RTMP/SRT passthrough — no WebRTC / sub-second playback (HLS only), no
adaptive bitrate, no server-side transcode safety net (source MUST be H.264/AAC),
no egress recording / VOD, no room features, no backup key, no GPU. The create
response carries the machine-readable `capabilities.lost` list the dashboard
renders as a warning.

## Operations

- Enable the plane server-wide: `STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on` (the same
  switch gates RTMP/SRT push and MPEG-TS pull). No MPEG-TS-specific env.
- Open **UDP** for the group/port on the host firewall, and make sure
  **IGMP/PIM** multicast routing actually delivers the group to this host (for
  SSM, IGMPv3 must be honoured end-to-end).
- On a **multi-homed** host, set `localaddr` to the NIC that faces the multicast
  network so the join happens on the right interface.
- For bursty / high-bitrate feeds, raise `fifoSize` (188-byte packets) and keep
  `overrunNonfatal` on.

## See also

- [rtmp-passthrough.md](rtmp-passthrough.md) — the RTMP/SRT push transports of the
  same plane (shared remux discipline + supervision).
- [ingress.md](ingress.md) — the full ingress endpoint surface.
