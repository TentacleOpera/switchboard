#!/bin/bash
# build-launcher.sh — build the static Go launcher for Linux amd64 and arm64.
#
# The launcher is the static binary that can run before Node.js or Switchboard
# is installed (plan: go-launcher-static-binary). It is built with CGO_ENABLED=0
# and -trimpath so the binary is fully static and reproducible. Linux amd64 and
# arm64 only — macOS, Windows, and armhf are explicitly out of scope.
#
# Output:
#   dist/linux-amd64/switchboard-launcher
#   dist/linux-arm64/switchboard-launcher
#
# The arm64 artifact is also the Raspberry Pi 64-bit binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

LAUNCHER_SRC="cmd/switchboard-launcher"
[ -d "$LAUNCHER_SRC" ] || { echo "FAILED: $LAUNCHER_SRC missing — launcher source tree not found"; exit 1; }

VERSION=$(node -p "require('./package.json').version")

mkdir -p dist/linux-amd64 dist/linux-arm64

echo "Building switchboard-launcher ${VERSION} for linux/amd64..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -trimpath -ldflags "-s -w -X main.launcherVersion=${VERSION} -X main.buildArch=linux/amd64" \
  -o dist/linux-amd64/switchboard-launcher ./cmd/switchboard-launcher

echo "Building switchboard-launcher ${VERSION} for linux/arm64..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
  -trimpath -ldflags "-s -w -X main.launcherVersion=${VERSION} -X main.buildArch=linux/arm64" \
  -o dist/linux-arm64/switchboard-launcher ./cmd/switchboard-launcher

chmod 755 dist/linux-amd64/switchboard-launcher dist/linux-arm64/switchboard-launcher

# Verify both binaries answer `version`. A binary that cannot identify itself
# is treated as a build failure — the launcher must always report its version
# so a stale projection is visible (the fallback rule).
dist/linux-amd64/switchboard-launcher version || { echo "FAILED: amd64 launcher version probe failed"; exit 1; }
# arm64 cannot run on an amd64 host; verify it is at least a valid ELF.
file dist/linux-arm64/switchboard-launcher | grep -q 'ELF' || { echo "FAILED: arm64 launcher is not a valid ELF"; exit 1; }

echo ""
echo "Built:"
echo "  dist/linux-amd64/switchboard-launcher"
echo "  dist/linux-arm64/switchboard-launcher (also Raspberry Pi 64-bit)"
