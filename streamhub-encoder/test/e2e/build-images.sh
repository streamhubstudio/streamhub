#!/usr/bin/env bash
# Builds the encoder image and the e2e image (encoder + measurement tools).
# Run from streamhub-encoder/ on a Linux Docker host.
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION=${VERSION:-$(git describe --tags --always 2>/dev/null || echo 0.1.0-dev)}
export DOCKER_BUILDKIT=1
docker build -q --build-arg VERSION="$VERSION" -f deploy/Dockerfile -t "${ENC_IMAGE:-enc-encoder:dev}" .
docker build -q --build-arg BASE="${ENC_IMAGE:-enc-encoder:dev}" -f test/e2e/Dockerfile.e2e -t "${E2E_IMAGE:-enc-e2e:dev}" .
