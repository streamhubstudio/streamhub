#!/usr/bin/env bash
# Unit tests in the golang:1.26 container (no host Go needed, no network/GStreamer).
#   test/unit.sh            → vet + gofmt check + go test -race ./...
#   test/unit.sh -update    → also rewrite the pipeline golden files
set -euo pipefail
cd "$(dirname "$0")/.."
UPDATE=""
[[ "${1:-}" == "-update" ]] && UPDATE="go test ./internal/pipeline/ -update >/dev/null;"
mkdir -p "$HOME/go/pkg/mod" "$HOME/.cache/go-build-enc"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOFLAGS=-buildvcs=false -e GOCACHE=/gocache -e GOMODCACHE=/gomod \
  -v "$HOME/go/pkg/mod:/gomod" -v "$HOME/.cache/go-build-enc:/gocache" -v "$PWD:/src" -w /src golang:1.26 bash -c "
    set -e
    test -z \"\$(gofmt -l . | tee /dev/stderr)\" || { echo 'gofmt needed'; exit 1; }
    go vet ./...
    $UPDATE
    go test -race -count=1 ./...
  "
