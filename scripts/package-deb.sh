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

# The CLI is exec'd directly by /usr/bin/switchboard and by the systemd unit.
# webpack's BannerPlugin gives it a `#!/usr/bin/env node` shebang, but the
# emitted file is mode 0644 — systemd would fail the unit with 203/EXEC and the
# operator would see a unit that never starts and no reason why. Assert the
# shebang and set the exec bit here, where it costs a rebuild.
CLI_JS="$INSTALL_DIR/usr/lib/switchboard/standalone/cli.js"
[ -f "$CLI_JS" ] || { echo "FAILED: $CLI_JS missing — did npm run compile emit dist/standalone?"; exit 1; }
head -c 2 "$CLI_JS" | grep -q '#!' || {
  echo "FAILED: dist/standalone/cli.js has no shebang — /usr/bin/switchboard would fail with 203/EXEC"; exit 1;
}
chmod 755 "$CLI_JS"

# Copy vendored node_modules. Production only: the dev tree is hundreds of MB
# of build tooling no target Pi needs, and it would ship inside the package.
echo "Vendoring production node_modules..."
VENDOR_DIR="$BUILD_DIR/vendor"
mkdir -p "$VENDOR_DIR"
cp package.json package-lock.json "$VENDOR_DIR/"
( cd "$VENDOR_DIR" && npm ci --omit=dev --ignore-scripts=false )
cp -a "$VENDOR_DIR/node_modules" "$INSTALL_DIR/usr/lib/switchboard/node_modules"

# Verify the native modules resolve out of the VENDORED tree, not the repo's.
# node-pty sits in optionalDependencies, so npm SUCCEEDS when its build fails:
# the install looks clean, the board starts, and every terminal is dead.
node -e "require('$INSTALL_DIR/usr/lib/switchboard/node_modules/better-sqlite3')" \
  || { echo "FAILED: better-sqlite3 missing from the vendored tree"; exit 1; }
node -e "require('$INSTALL_DIR/usr/lib/switchboard/node_modules/node-pty')" \
  || { echo "FAILED: node-pty missing from the vendored tree — terminals will not work"; exit 1; }
echo "Vendored native modules verified."

# Entry point
ln -s /usr/lib/switchboard/standalone/cli.js "$INSTALL_DIR/usr/bin/switchboard"

# Desktop entry + icon (Linux desktop install; harmless on a headless Pi)
mkdir -p "$INSTALL_DIR/usr/share/applications"
cp packaging/switchboard.desktop "$INSTALL_DIR/usr/share/applications/switchboard.desktop"
# The .desktop file names Icon=switchboard, so an icon MUST land on the icon
# path or the launcher shows a generic placeholder. icon.png is the extension's
# own icon and the only one that ships in the repo root.
[ -f icon.png ] || { echo "FAILED: icon.png missing — the desktop entry names Icon=switchboard"; exit 1; }
mkdir -p "$INSTALL_DIR/usr/share/icons/hicolor/256x256/apps"
cp icon.png "$INSTALL_DIR/usr/share/icons/hicolor/256x256/apps/switchboard.png"

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
