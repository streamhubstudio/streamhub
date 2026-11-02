#!/usr/bin/env bash
# Builds streamhub-encoder_<ver>_amd64.deb (Debian 13 / Ubuntu 24.04+ / 26.04)
# inside Docker: golang:1.26 compiles the static encoderd, dpkg-deb packs it
# with the systemd unit, defaults, sysctl and the GStreamer dependencies.
#   deploy/build-deb.sh [version]      → dist/streamhub-encoder_<ver>_amd64.deb
set -euo pipefail
cd "$(dirname "$0")/.."
VER=${1:-${VERSION:-0.0.1~beta}}
mkdir -p dist
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOFLAGS=-buildvcs=false -e CGO_ENABLED=0 \
  -v "$PWD:/src" -w /src golang:1.26 \
  go build -trimpath -ldflags "-s -w -X main.version=$VER" -o dist/encoderd ./cmd/encoderd
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" -w /src -e VER="$VER" ubuntu:26.04 bash -euc '
  R=$(mktemp -d)/pkg
  install -Dm0755 dist/encoderd              $R/usr/bin/encoderd
  install -Dm0644 deploy/encoderd.service     $R/lib/systemd/system/encoderd.service
  install -Dm0644 deploy/streamhub-encoder.default $R/etc/default/streamhub-encoder
  install -Dm0644 deploy/99-streamhub-encoder.conf $R/etc/sysctl.d/99-streamhub-encoder.conf
  install -Dm0644 README.md                   $R/usr/share/doc/streamhub-encoder/README.md
  install -Dm0644 docs/LICENSING.md           $R/usr/share/doc/streamhub-encoder/LICENSING.md
  mkdir -p $R/DEBIAN
  cat > $R/DEBIAN/control <<EOF
Package: streamhub-encoder
Version: $VER
Section: video
Priority: optional
Architecture: amd64
Maintainer: StreamHub <noreply@streamhub.local>
Depends: gstreamer1.0-tools (>= 1.24), gstreamer1.0-plugins-base, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad, gstreamer1.0-plugins-ugly, gstreamer1.0-libav, gstreamer1.0-fallbackswitch | gst-plugins-rs, gstreamer1.0-x, ffmpeg, fonts-dejavu-core, curl
Recommends: gstreamer1.0-vaapi, gstreamer1.0-alsa
Suggests: nvidia-driver, blackmagic-desktop-video
Description: StreamHub Encoder — Linux software/hardware live encoder appliance
 encoderd (REST API, web UI, Prometheus metrics, presets, supervisor) driving
 one GStreamer engine per channel: SDI/HDMI/IP inputs with failover, H.264/HEVC
 (x264, x265, NVENC, QSV, VA-API), SRT/RTMP(S)/UDP/RTP/WHIP/HLS outputs, native
 StreamHub pairing. x264/x265 are GPL; HEVC/AAC are patent-encumbered — see
 /usr/share/doc/streamhub-encoder/LICENSING.md.
EOF
  cat > $R/DEBIAN/conffiles <<EOF
/etc/default/streamhub-encoder
/etc/sysctl.d/99-streamhub-encoder.conf
EOF
  cat > $R/DEBIAN/postinst <<"EOF"
#!/bin/sh
set -e
if ! getent passwd encoder >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/streamhub-encoder --no-create-home --shell /usr/sbin/nologin encoder
fi
for g in video audio render; do getent group $g >/dev/null && usermod -aG $g encoder || true; done
sysctl -q -p /etc/sysctl.d/99-streamhub-encoder.conf 2>/dev/null || true
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable encoderd.service >/dev/null 2>&1 || true
  systemctl restart encoderd.service || true
fi
EOF
  cat > $R/DEBIAN/prerm <<"EOF"
#!/bin/sh
set -e
if [ -d /run/systemd/system ] && [ "$1" = remove ]; then systemctl stop encoderd.service || true; fi
EOF
  cat > $R/DEBIAN/postrm <<"EOF"
#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
EOF
  chmod 0755 $R/DEBIAN/postinst $R/DEBIAN/prerm $R/DEBIAN/postrm
  dpkg-deb --root-owner-group --build $R dist/streamhub-encoder_${VER}_amd64.deb
'
ls -la dist/*.deb
