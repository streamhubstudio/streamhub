#!/usr/bin/env bash
# =============================================================================
# build-ffmpeg-slim.sh — reproducible, minimal ffmpeg for the StreamHub core.
#
# Builds a purpose-built `ffmpeg` + `ffprobe` carrying ONLY the demuxers,
# muxers, codecs, filters and protocols the core actually uses (see the
# inventory in https://streamhub.studio/docs/operations/FFMPEG-SLIM). Result: one ~15-25 MB
# binary instead of the ~70-100 MB stock-Debian ffmpeg + its codec .so closure,
# with a much smaller attack surface. Transcode CPU is UNCHANGED (same encoders).
#
# NOT wired into deploy/Dockerfile yet — run standalone to evaluate first, then
# validate with the checklist in FFMPEG-SLIM.md before swapping the apt ffmpeg.
#
# Scope: this replaces the CORE image's own ffmpeg (snapshots + VOD transcode).
# It does NOT affect the LiveKit ingress/egress containers (they bundle their
# own ffmpeg) or the CV workers (OpenCV's bundled libav).
#
# Usage (Debian/Ubuntu — matches the node:20-bookworm-slim runtime base):
#   sudo apt-get install -y build-essential nasm pkg-config git curl \
#                           ca-certificates zlib1g-dev libssl-dev
#   deploy/build-ffmpeg-slim.sh                 # → $PREFIX/bin/{ffmpeg,ffprobe}
#   ENABLE_NVENC=1 deploy/build-ffmpeg-slim.sh  # also build h264_nvenc/hevc_nvenc
#
# Tunables (env; defaults shown):
#   PREFIX=/opt/ffmpeg-slim   BUILD_DIR=/tmp/ffmpeg-slim-build   JOBS=$(nproc)
#   FFMPEG_VERSION=7.1  X264_BRANCH=stable  LIBVPX_VERSION=1.14.1  OPUS_VERSION=1.5.2
#   ENABLE_NVENC=0
# =============================================================================
set -euo pipefail

PREFIX="${PREFIX:-/opt/ffmpeg-slim}"
BUILD_DIR="${BUILD_DIR:-/tmp/ffmpeg-slim-build}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
X264_BRANCH="${X264_BRANCH:-stable}"
LIBVPX_VERSION="${LIBVPX_VERSION:-1.14.1}"
OPUS_VERSION="${OPUS_VERSION:-1.5.2}"
ENABLE_NVENC="${ENABLE_NVENC:-0}"

# Where the static codec libs get installed for ffmpeg to link against.
DEPS="$BUILD_DIR/deps"
export PKG_CONFIG_PATH="$DEPS/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

log() { printf '\033[1;36m[ffmpeg-slim]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ffmpeg-slim] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

for tool in gcc make nasm pkg-config git curl; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build tool: $tool (see the apt-get line in the header)"
done

mkdir -p "$BUILD_DIR" "$DEPS"
cd "$BUILD_DIR"

# ---- 1. x264 (H.264 encoder, GPL) ------------------------------------------
if [ ! -f "$DEPS/lib/libx264.a" ]; then
  log "building x264 ($X264_BRANCH)"
  rm -rf x264
  git clone --depth 1 --branch "$X264_BRANCH" https://code.videolan.org/videolan/x264.git
  ( cd x264
    ./configure --prefix="$DEPS" --enable-static --disable-shared --enable-pic \
                --disable-cli --disable-opencl
    make -j"$JOBS" && make install )
fi

# ---- 2. libvpx (VP8/VP9 encoder, BSD) --------------------------------------
if [ ! -f "$DEPS/lib/libvpx.a" ]; then
  log "building libvpx $LIBVPX_VERSION"
  rm -rf libvpx
  git clone --depth 1 --branch "v$LIBVPX_VERSION" https://chromium.googlesource.com/webm/libvpx.git
  ( cd libvpx
    ./configure --prefix="$DEPS" --enable-static --disable-shared --enable-pic \
                --disable-examples --disable-tools --disable-docs --disable-unit-tests \
                --enable-vp8 --enable-vp9
    make -j"$JOBS" && make install )
fi

# ---- 3. libopus (Opus audio, BSD) ------------------------------------------
if [ ! -f "$DEPS/lib/libopus.a" ]; then
  log "building opus $OPUS_VERSION"
  rm -rf "opus-$OPUS_VERSION"
  curl -fsSL "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" | tar xz
  ( cd "opus-$OPUS_VERSION"
    ./configure --prefix="$DEPS" --enable-static --disable-shared --with-pic \
                --disable-doc --disable-extra-programs
    make -j"$JOBS" && make install )
fi

# ---- 4. (optional) nv-codec-headers for NVENC ------------------------------
NVENC_FLAGS=()
if [ "$ENABLE_NVENC" = "1" ]; then
  log "installing nv-codec-headers (NVENC)"
  if [ ! -f "$DEPS/lib/pkgconfig/ffnvcodec.pc" ]; then
    rm -rf nv-codec-headers
    git clone --depth 1 https://github.com/FFmpeg/nv-codec-headers.git
    ( cd nv-codec-headers && make PREFIX="$DEPS" install )
  fi
  # NVENC loads libnvidia-encode.so.1 via dlopen at runtime, so a build host
  # needs no NVIDIA driver — only the runtime node does (gpus: all + toolkit).
  # SC2054: the comma is part of the ffmpeg flag value (--enable-encoder takes a
  # comma-separated encoder list), not an array-element separator.
  # shellcheck disable=SC2054
  NVENC_FLAGS=( --enable-ffnvcodec --enable-encoder=h264_nvenc,hevc_nvenc )
fi

# ---- 5. ffmpeg — minimal surface -------------------------------------------
log "building ffmpeg $FFMPEG_VERSION → $PREFIX"
rm -rf "ffmpeg-$FFMPEG_VERSION"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" | tar xJ
cd "ffmpeg-$FFMPEG_VERSION"

# Static-link the codec libs we built; glibc/openssl/zlib stay dynamic (fine
# inside the Debian slim runtime). Set FULL_STATIC=1 to attempt a fully static
# binary (needs static system libs; not required for the container use case).
EXTRA_LDFLAGS="-L$DEPS/lib"
[ "${FULL_STATIC:-0}" = "1" ] && EXTRA_LDFLAGS="$EXTRA_LDFLAGS -static"

./configure \
  --prefix="$PREFIX" \
  --pkg-config-flags="--static" \
  --extra-cflags="-I$DEPS/include" \
  --extra-ldflags="$EXTRA_LDFLAGS" \
  --disable-everything --disable-doc --disable-debug \
  --disable-ffplay --disable-devices --disable-sdl2 --disable-autodetect \
  --enable-small \
  --enable-gpl --enable-version3 \
  --enable-network --enable-openssl \
  --enable-avfilter --enable-swscale --enable-swresample \
  --enable-libx264 --enable-libvpx --enable-libopus \
  --enable-protocol=file,pipe,tcp,udp,rtp,rtmp,http,https,tls,hls,crypto \
  --enable-demuxer=flv,live_flv,mov,mpegts,hls,matroska,image2,mjpeg,aac,h264,rtsp,rtp \
  --enable-muxer=image2,mjpeg,mov,mp4,hls,mpegts,matroska,webm,null,rtp \
  --enable-decoder=h264,aac,aac_latm,mp3,vp8,vp9,opus,mjpeg,pcm_s16le,rawvideo \
  --enable-encoder=libx264,aac,mjpeg,libvpx,libopus \
  --enable-filter=scale,format,aformat,aresample,anull,null,copy,fps,setpts,asetpts \
  --enable-parser=h264,aac,vp8,vp9,opus,mpegaudio \
  --enable-bsf=h264_mp4toannexb,aac_adtstoasc,extract_extradata \
  "${NVENC_FLAGS[@]}"

make -j"$JOBS"
make install
# strip debug symbols for the smallest binary
strip "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" 2>/dev/null || true

log "done:"
ls -lh "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe"
log "protocols:"; "$PREFIX/bin/ffmpeg" -hide_banner -protocols 2>/dev/null | grep -E 'file|rtmp|https|hls' || true
log "encoders:";  "$PREFIX/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -E 'libx264|libvpx|aac|mjpeg|libopus' || true
log "Validate every real invocation with the checklist in https://streamhub.studio/docs/operations/FFMPEG-SLIM §4."
