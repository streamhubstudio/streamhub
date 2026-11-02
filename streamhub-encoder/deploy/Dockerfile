# StreamHub Encoder — encoderd + GStreamer engine image.
# Build context: streamhub-encoder/
#   docker build -f deploy/Dockerfile -t streamhub-encoder:dev .
# NVENC: run with `--runtime nvidia --gpus all -e NVIDIA_DRIVER_CAPABILITIES=video,compute,utility`
# (the nvcodec plugin dlopens libcuda/libnvidia-encode injected by the NVIDIA runtime).
# Licensing: x264 and x265 are GPLv2; HEVC/AAC carry patent pools. fdk-aac is NOT installed.

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG VERSION=0.0.1-dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOFLAGS=-buildvcs=false go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/encoderd ./cmd/encoderd

FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-fallbackswitch gstreamer1.0-x \
      gstreamer1.0-vaapi gstreamer1.0-alsa gstreamer1.0-nice \
      ffmpeg fonts-dejavu-core ca-certificates tini iproute2 procps \
    && rm -rf /var/lib/apt/lists/*
# The GStreamer registry is (re)built at first start on purpose: the nvcodec
# plugin only registers NVENC elements when the NVIDIA runtime injected the driver.
COPY --from=build /out/encoderd /usr/bin/encoderd
ENV ENCODERD_DATA_DIR=/var/lib/streamhub-encoder \
    ENCODERD_LISTEN=:8090 \
    NVIDIA_DRIVER_CAPABILITIES=video,compute,utility
VOLUME /var/lib/streamhub-encoder
EXPOSE 8090
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/encoderd"]
CMD ["serve"]
