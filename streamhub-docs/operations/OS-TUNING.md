# OS performance tuning — kernel & resource limits for a media server

StreamHub runs a LiveKit SFU plus the core API on one host. Under real load the
bottlenecks are almost never CPU — they are **kernel defaults** sized for a
generic web server: a ~208 KB UDP socket buffer drops WebRTC packets when a few
publishers saturate it, a low file-descriptor ceiling hits `EMFILE` under many
viewers, and a narrow ephemeral port range exhausts under many relay sockets.

This page lists every knob that matters, why it matters for media, its
recommended value, and the remedy to apply it. Most are **already applied on a
real host by [`install.sh`](../../install.sh)** — see [What install.sh does](#what-installsh-does).

> **Read-only reporting, never auto-apply.** The core inspects `/proc` and
> reports each knob's live value vs the recommendation vs an applied/not-applied
> verdict (`GET /api/v1/system/os-tuning`, and the **OS tuning** panel in
> Server settings). It **does not** change kernel params — applying sysctl from
> inside a container is unsafe and out of scope. Apply them on the host with the
> remedies below (which is what `install.sh` does).

## The knobs

| Knob | Recommended | Verdict rule | Why it matters for media |
|------|-------------|--------------|--------------------------|
| `net.core.rmem_max` | ≥ `16777216` (16 MiB) | value ≥ 16 MiB | UDP **receive** buffer ceiling. WebRTC/RTP arrives over UDP; the ~208 KB default drops packets when several publishers/subscribers saturate the socket. LiveKit recommends ≥ 16 MiB. |
| `net.core.wmem_max` | ≥ `16777216` (16 MiB) | value ≥ 16 MiB | UDP **send** buffer ceiling. Send-side counterpart: a small default throttles outbound RTP to subscribers under load. |
| `net.core.somaxconn` | ≥ `1024` | value ≥ 1024 | Cap on the `accept()` backlog for TCP signalling / HLS / API. A low backlog drops connections during viewer surges (everyone joining right after a broadcast starts). |
| `net.ipv4.udp_mem` | max column ≥ `262144` pages (~1 GiB) | 3rd field ≥ 262144 | System-wide UDP memory pressure thresholds `min pressure max` (in pages). A low **max** column throttles all UDP once media memory grows. |
| `net.ipv4.ip_local_port_range` | `1024 65535` (wide) | width ≥ 16384 **and** high ≥ 60999 | Ephemeral port range. A media server holds many relay/outbound sockets; a narrow range exhausts ports and refuses new connections. |
| `fs.file-max` | ≥ `1000000` | value ≥ 1,000,000 | System-wide file-descriptor cap. Every socket, HLS segment and recording is an fd; a low cap makes the kernel refuse new fds server-wide. |
| `ulimit -n` (process `Max open files`) | ≥ `65535` | soft limit ≥ 65535 (`unlimited` counts) | Per-process fd ceiling for the core/LiveKit. Too low ⇒ `EMFILE` under many concurrent viewers. Set via systemd `LimitNOFILE`. |
| `vm.swappiness` | ≤ `10` | value ≤ 10 | High swappiness lets the kernel swap out hot media / jitter buffers, spiking latency and causing stalls. Keep the media path in RAM. |
| `transparent_hugepage` *(optional)* | `madvise` or `never` (not `always`) | active mode ≠ `always` | `THP=always` causes latency spikes from background compaction — bad for real-time media. `madvise`/`never` avoids the stalls. |

A knob reads **unknown / n/a** when its value can't be read: a missing or blank
`/proc` file, an unparseable value, or a **non-Linux host** (the macOS dev/test
box has no `/proc`, so every knob degrades cleanly to n/a and the report's
`supported` flag is `false`).

## Remedies

Apply on the **host** (not in a container). Persist sysctl changes in a drop-in
so they survive reboots — the same file `install.sh` writes:

```bash
# /etc/sysctl.d/99-streamhub-webrtc.conf  (persisted; `sysctl -p <file>` to load)
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.core.somaxconn=1024
net.ipv4.udp_mem=65536 131072 262144
net.ipv4.ip_local_port_range=1024 65535
fs.file-max=1000000
vm.swappiness=10
```

```bash
# apply now, then persist as above
sudo sysctl -w net.core.rmem_max=16777216
sudo sysctl -w net.core.wmem_max=16777216

# transparent hugepages (optional; not persisted by sysctl)
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
```

Per-process open files is a **systemd** limit, not a sysctl — set on the units
(this is what `deploy/streamhub-core.service` and `deploy/livekit.service` ship):

```ini
# deploy/streamhub-core.service
LimitNOFILE=200000
# deploy/livekit.service
LimitNOFILE=500000
```

## What `install.sh` does

On an origin install [`install.sh`](../../install.sh) already:

- Raises the UDP buffers to 16 MiB when they are below it, by writing
  `/etc/sysctl.d/99-streamhub-webrtc.conf` (`net.core.rmem_max` /
  `net.core.wmem_max`) and loading it with `sysctl -p`.
- Ships the systemd units with a high `LimitNOFILE` (core 200000, LiveKit
  500000) so the process open-files ceiling is well above the default.

The remaining knobs (`somaxconn`, `udp_mem`, `ip_local_port_range`, `fs.file-max`,
`vm.swappiness`, THP) are **recommendations** — apply them with the drop-in above
when a deployment runs at high connection/viewer counts. The panel below tells
you, per knob, whether the running host already satisfies each one.

## Checking what's applied

- **Dashboard:** Server settings → **OS tuning** panel (superadmin). A table of
  knob → current → recommended → status badge (**applied ✓ / not applied ⚠ /
  n/a**) with the copy-paste sysctl line per row. Non-Linux hosts show every knob
  as n/a with an explanatory note.
- **API:** `GET /api/v1/system/os-tuning` (global-scope / superadmin bearer, same
  gate as `/system/settings`). Returns `{ data: { checkedAt, platform, supported,
  summary, knobs[], note } }`; each knob carries `current`, `recommended`,
  `status`, `why` and `remedy`. Read-only — it never writes.
- **CLI:** `sysctl net.core.rmem_max`, `cat /proc/sys/net/core/rmem_max`,
  `ulimit -n`, `cat /proc/self/limits`.

Related: [LATENCY-TUNING.md](./LATENCY-TUNING.md) (the empirical latency numbers
and the UDP-buffer lever in context), [ENV.md](./ENV.md),
[RUNBOOK.md](./RUNBOOK.md).
