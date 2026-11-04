# NetBird VPN Integration for Luckfox Pico Max

> **LEGACY / OPTIONAL.** The StreamHub Agent reaches its StreamHub instance
> **directly** over HTTPS/RTMPS, so a VPN mesh is **not** required for normal
> operation. This guide is retained only for fleets that want an out-of-band
> mesh for remote SSH/HTTP administration. All keys/secrets below are
> placeholders — supply your own via the environment; never commit real values.

## Overview

Optionally, a streamhub-agent device can connect to a NetBird mesh VPN during boot, enabling remote SSH/HTTP access from anywhere. The VPN client runs alongside the agent on the Luckfox Pico Max.

## Architecture

```
Device Boot Sequence:
  S90netbird (VPN)  →  S95streamhub (Agent)
       ↓                     ↓
  NetBird mesh         MQTT, RTMP, HTTP
  100.64.x.x          Camera streaming
```

## Device Specs (Luckfox Pico Max)

| Spec | Value |
|------|-------|
| SoC | Rockchip RV1106 (ARM Cortex-A7, ARMv7) |
| RAM | 256 MB (55 MB usable after kernel/ISP) |
| Storage | SD card + 256 MB NAND |
| Kernel | Linux 5.10 (WireGuard built-in) |
| Init | BusyBox init (no systemd) |

**Memory budget**: NetBird client uses ~20-30 MB. With ~55 MB usable and the agent using ~8-12 MB, this is tight but feasible. Monitor with `free -m`.

## Binary

NetBird provides a static `armv6` binary that runs on ARMv7 (Cortex-A7):

```
https://github.com/netbirdio/netbird/releases/download/v0.65.3/netbird_0.65.3_linux_armv6.tar.gz
```

Install location: `/userdata/streamhub/netbird`

## Quick Setup (New Device)

```bash
# On the Luckfox device:
scp setup-vpn.sh root@<device-ip>:/tmp/
ssh root@<device-ip> "sh /tmp/setup-vpn.sh"
```

Or use the Makefile:

```bash
make deploy-vpn DEVICE_IP=<ip>
```

## File Layout on Device

```
/userdata/streamhub/
├── streamhub-agent    # Agent binary
├── config.yml             # Agent config
├── secrets.ini            # Agent secrets
├── netbird                # NetBird VPN binary (17 MB)
└── netbird-config/        # NetBird state
    └── config.json        # Generated on first run

/etc/init.d/
├── S90netbird             # VPN init script (starts first)
└── S95streamhub            # Agent init script (starts after VPN)
```

## Init Script: S90netbird

The VPN init script starts NetBird in `--foreground-mode` (required on BusyBox/no-systemd systems). It runs before S95streamhub so the VPN is connected before the agent starts.

Key configuration in the init script:

```sh
NETBIRD_SETUP_KEY="<SETUP_KEY>"
NETBIRD_MGMT_URL="https://vpn.streamhub.cloud:443"
```

Commands:
```bash
/etc/init.d/S90netbird start
/etc/init.d/S90netbird stop
/etc/init.d/S90netbird status
/etc/init.d/S90netbird restart
```

## DNS Hostname Convention

Each device gets a hostname in the `streamhub.local` DNS zone:

```
agent.{tenant_id}.{device_id}.streamhub.local
```

Examples:
- `agent.<tenant>.<device_id>.streamhub.local` → 100.64.x.x
- `agent.<tenant>.<other_device>.streamhub.local` → 100.64.x.y

Servers use simpler names:
- `media.streamhub.local` → media server
- `mqtt.streamhub.local` → MQTT broker
- `vpn.streamhub.local` → VPN server itself

## Adding DNS Records via API

After a device registers and receives its NetBird IP, add a DNS record:

```bash
# Get API token
TOKEN=$(curl -s -X POST "https://vpn.streamhub.cloud/oauth/v2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=netbird-service-account" \
  -d "client_secret=<CLIENT_SECRET>" \
  -d "scope=openid+urn:zitadel:iam:org:project:id:<PROJECT_ID>:aud" \
  | jq -r '.access_token')

# List peers to find the device's NetBird IP
curl -s "https://vpn.streamhub.cloud/api/peers" \
  -H "Authorization: Bearer $TOKEN" | jq '.[] | {name, ip}'
```

## Checking VPN Status from the Agent

The agent can check VPN connectivity:

```bash
# Check if NetBird is running
/userdata/streamhub/netbird status --config /userdata/streamhub/netbird-config/config.json

# Get the NetBird IP
ip addr show wt0 | grep "inet " | awk '{print $2}'

# Ping another peer
ping -c 1 100.64.0.1  # a VPN peer (your server's NetBird IP)
```

## Provisioning Flow for New Device

1. **Flash firmware** on Luckfox Pico Max
2. **Deploy agent** via `make deploy-all DEVICE_IP=<ip>`
3. **Deploy VPN** via `make deploy-vpn DEVICE_IP=<ip>` (or run `setup-vpn.sh`)
4. **Reboot device** — S90netbird starts VPN, S95streamhub starts agent
5. **Verify in dashboard** — device appears at `https://vpn.streamhub.cloud` in the `iot-devices` group
6. **Add DNS record** (optional) — via API or dashboard

## Memory Considerations

With 55 MB usable RAM on Luckfox:

| Process | RAM Usage |
|---------|-----------|
| NetBird client | ~20-30 MB |
| streamhub-agent | ~8-12 MB |
| System + kernel | ~10 MB |
| **Total** | ~38-52 MB |

This is tight. If memory pressure is observed:

- NetBird uses WireGuard kernel module (built into Linux 5.10), avoiding userspace wireguard-go overhead
- The NetBird client's memory usage may increase with more peers; with <50 peers it should be manageable
- Monitor with: `cat /proc/meminfo | grep -E 'MemTotal|MemAvailable'`
- If OOM occurs, consider using `oom_score_adj` to protect the agent (already done in S95streamhub for ffmpeg)

## WireGuard

Linux 5.10 on Luckfox has WireGuard built into the kernel. NetBird will use the kernel module automatically (`Interface type: Kernel` in status output). No additional kernel modules or wireguard-go needed.

## Troubleshooting

### VPN won't connect
```bash
# Check logs
cat /tmp/netbird.log

# Check if management URL is reachable
wget -q -O- https://vpn.streamhub.cloud/api/health 2>&1

# Try manual connection
/userdata/streamhub/netbird up \
  --setup-key <SETUP_KEY> \
  --management-url https://vpn.streamhub.cloud:443 \
  --config /userdata/streamhub/netbird-config/config.json \
  --foreground-mode
```

### Can't resolve streamhub.local names
```bash
# Check if NetBird DNS is active
/userdata/streamhub/netbird status --config /userdata/streamhub/netbird-config/config.json
# Look for "Nameservers: 1/1 Available"

# Check resolv.conf
cat /etc/resolv.conf
# NetBird adds its DNS resolver (127.0.0.53 or similar)
```

### High memory usage
```bash
# Check memory
free -m

# Check NetBird memory specifically
ps aux | grep netbird
cat /proc/$(pidof netbird)/status | grep VmRSS
```

### Device not appearing in dashboard
```bash
# Check setup key validity
# Keys expire after 1 year (2027-02-20)
# Check usage count hasn't exceeded limit (500 for IoT)

# Verify network connectivity to vpn.streamhub.cloud:443
wget -q --spider https://vpn.streamhub.cloud && echo "OK" || echo "FAIL"
```
