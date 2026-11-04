#!/bin/sh
#
# setup-vpn.sh — Download and install NetBird VPN client on Luckfox Pico Max
# Run once during device provisioning.
#
# LEGACY / OPTIONAL: the StreamHub Agent reaches its StreamHub instance directly
# over HTTPS/RTMPS — a VPN mesh is only needed for out-of-band SSH/HTTP admin
# access. Provide credentials via the environment; never hardcode them here.
#
# Usage: NETBIRD_SETUP_KEY=... NETBIRD_MGMT_URL=... sh setup-vpn.sh

NETBIRD_VERSION="${NETBIRD_VERSION:-0.65.3}"
NETBIRD_SETUP_KEY="${NETBIRD_SETUP_KEY:-}"
NETBIRD_MGMT_URL="${NETBIRD_MGMT_URL:-https://vpn.example.com:443}"

if [ -z "$NETBIRD_SETUP_KEY" ]; then
    echo "FAIL: set NETBIRD_SETUP_KEY in the environment before running." >&2
    exit 1
fi

INSTALL_DIR="/userdata/streamhub"
NETBIRD_BIN="$INSTALL_DIR/netbird"
NETBIRD_CONFIG="$INSTALL_DIR/netbird-config"
INIT_SCRIPT="/etc/init.d/S90netbird"

echo "=== StreamHub VPN Provisioning ==="
echo "NetBird version: $NETBIRD_VERSION"
echo "Management URL:  $NETBIRD_MGMT_URL"
echo ""

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$NETBIRD_CONFIG"

# Download NetBird ARM binary (armv6 is compatible with Luckfox's ARMv7 Cortex-A7)
echo "[1/4] Downloading NetBird $NETBIRD_VERSION (linux/armv6)..."
wget -q "https://github.com/netbirdio/netbird/releases/download/v${NETBIRD_VERSION}/netbird_${NETBIRD_VERSION}_linux_armv6.tar.gz" \
    -O /tmp/netbird.tar.gz

if [ $? -ne 0 ]; then
    echo "FAIL: Could not download NetBird binary"
    exit 1
fi

# Extract
echo "[2/4] Installing binary..."
cd /tmp && tar -xzf netbird.tar.gz netbird
mv /tmp/netbird "$NETBIRD_BIN"
chmod +x "$NETBIRD_BIN"
rm -f /tmp/netbird.tar.gz

echo "  Installed: $NETBIRD_BIN"
echo "  Version:   $($NETBIRD_BIN version 2>/dev/null || echo $NETBIRD_VERSION)"

# Install init script
echo "[3/4] Installing init script..."
if [ -f "$INIT_SCRIPT" ]; then
    echo "  Init script already exists, skipping"
else
    # The init script should be deployed via 'make deploy-init' or manually
    echo "  NOTE: Deploy S90netbird init script to $INIT_SCRIPT"
    echo "  Run: scp etc/S90netbird root@<device>:$INIT_SCRIPT && chmod +x $INIT_SCRIPT"
fi

# Test connection
echo "[4/4] Testing VPN connection..."
"$NETBIRD_BIN" up \
    --setup-key "$NETBIRD_SETUP_KEY" \
    --management-url "$NETBIRD_MGMT_URL" \
    --config "$NETBIRD_CONFIG/config.json" \
    --foreground-mode &

NETBIRD_PID=$!
sleep 10

if kill -0 "$NETBIRD_PID" 2>/dev/null; then
    "$NETBIRD_BIN" status --config "$NETBIRD_CONFIG/config.json" 2>/dev/null
    echo ""
    echo "=== VPN Connected Successfully ==="
    echo "NetBird is running (pid $NETBIRD_PID)"
    echo ""
    echo "To stop: kill $NETBIRD_PID"
    echo "To start on boot: install S90netbird to /etc/init.d/"
else
    echo "FAIL: NetBird did not start. Check /tmp/netbird.log"
    exit 1
fi
