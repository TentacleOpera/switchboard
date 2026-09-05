#!/bin/bash
# package-deb.sh — build an arm64 .deb package for Raspberry Pi OS.
#
# Prerequisites:
#   - Run on an arm64 host (Pi 4/5 or arm64 runner). Native modules
#     cannot be cross-compiled reliably.
#   - Node >= 22, npm, debhelper, dh-make
#
# Output:
#   switchboard_<version>_arm64.deb
#
# The package vendors node_modules with better-sqlite3 and node-pty built
# for arm64 at package-build time, so no target Pi ever needs a compiler.
# See raspberry-pi-installs-switchboard-with-apt.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Extract version from package.json
VERSION=$(node -p "require('./package.json').version")
PKG_NAME="switchboard"
DEB_NAME="${PKG_NAME}_${VERSION}_arm64.deb"

echo "Building ${DEB_NAME}..."

# 1. Compile the TypeScript
echo "Compiling TypeScript..."
npm run compile || { echo "Compile failed"; exit 1; }

# 2. Install/verify native modules for arm64
echo "Verifying native modules..."
node -e "require('better-sqlite3')" || { echo "FAILED: better-sqlite3 not loadable"; exit 1; }
node -e "require('node-pty')" || { echo "FAILED: node-pty not loadable — terminals will not work"; exit 1; }
echo "Native modules verified."

# 3. Build the .deb using dpkg-deb directly (simpler than full debhelper)
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

INSTALL_DIR="$BUILD_DIR/deb"
mkdir -p "$INSTALL_DIR/DEBIAN"
mkdir -p "$INSTALL_DIR/usr/lib/switchboard"
mkdir -p "$INSTALL_DIR/usr/bin"
mkdir -p "$INSTALL_DIR/etc/switchboard"
mkdir -p "$INSTALL_DIR/lib/systemd/system"

# Copy built dist
cp -a dist/* "$INSTALL_DIR/usr/lib/switchboard/"

# Copy vendored node_modules
cp -a node_modules "$INSTALL_DIR/usr/lib/switchboard/node_modules"

# Entry point
ln -s /usr/lib/switchboard/standalone/cli.js "$INSTALL_DIR/usr/bin/switchboard"

# Config file (conffile)
cp packaging/debian/switchboard.env "$INSTALL_DIR/etc/switchboard/switchboard.env"
echo "/etc/switchboard/switchboard.env" > "$INSTALL_DIR/DEBIAN/conffiles"

# Systemd unit
cp packaging/debian/switchboard.service "$INSTALL_DIR/lib/systemd/system/switchboard.service"

# Control file
cat > "$INSTALL_DIR/DEBIAN/control" << EOF
Package: switchboard
Version: ${VERSION}
Architecture: arm64
Maintainer: Switchboard <noreply@switchboard.ai>
Depends: nodejs (>= 22)
Recommends: tailscale
Section: utils
Priority: optional
Description: Switchboard — plan-driven agent orchestration board
 Switchboard is a standalone board and fleet manager for AI coding agents.
 It runs a local web board, dispatches work to agent CLIs, and tracks plans
 through a kanban workflow. This package installs the standalone host,
 a systemd service, and the switchboard CLI.
 .
 On a Raspberry Pi 4/5 (arm64, 4 GB), it runs two agent seats comfortably.
 The package vendors better-sqlite3 and node-pty built for arm64, so no
 compiler is needed on the target.
EOF

# Maintainer scripts
cp packaging/debian/postinst "$INSTALL_DIR/DEBIAN/postinst"
cp packaging/debian/prerm "$INSTALL_DIR/DEBIAN/prerm"
cp packaging/debian/postrm "$INSTALL_DIR/DEBIAN/postrm"
chmod 755 "$INSTALL_DIR/DEBIAN/postinst" "$INSTALL_DIR/DEBIAN/prerm" "$INSTALL_DIR/DEBIAN/postrm"

# 4. Build the .deb
echo "Building .deb..."
dpkg-deb --build --root-owner-group "$INSTALL_DIR" "$DEB_NAME"

echo ""
echo "Built: ${DEB_NAME}"
echo "Install with: sudo apt install ./${DEB_NAME}"
echo "Then run:     switchboard setup host"
