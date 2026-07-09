#!/usr/bin/env bash
set -euo pipefail

# Run from the repo root so paths are predictable regardless of where the script is invoked.
cd "$(dirname "$0")/.."

# Publish a GitHub Release for the prebuilt .vsix in the releases/ directory.
# The highest-versioned switchboard-*.vsix file is released automatically.
# To target a specific version, set VERSION, e.g. VERSION=1.7.6 npm run release.

RELEASES_DIR="releases"

# 0. Guard: fail fast if gh is not authenticated.
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# 1. Guard: releases/ directory must exist.
if [[ ! -d "$RELEASES_DIR" ]]; then
  echo "ERROR: $RELEASES_DIR directory not found. Create it and place the .vsix you want to publish." >&2
  exit 1
fi

# 2. Resolve the VSIX to publish.
VSIX=""
if [[ -n "${VERSION:-}" ]]; then
  VSIX="$RELEASES_DIR/switchboard-$VERSION.vsix"
  if [[ ! -f "$VSIX" ]]; then
    echo "ERROR: $VSIX not found" >&2
    exit 1
  fi
else
  VSIX=$(find "$RELEASES_DIR" -maxdepth 1 -type f -name 'switchboard-*.vsix' | sort -V | tail -n 1)
  if [[ -z "$VSIX" ]]; then
    echo "ERROR: no switchboard-*.vsix found in $RELEASES_DIR" >&2
    exit 1
  fi
fi

# 3. Derive tag from artifact filename.
VERSION=$(basename "$VSIX" .vsix | sed 's/^switchboard-//')
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not parse version from $VSIX" >&2
  exit 1
fi
TAG="v$VERSION"

# 4. Guard: don't silently re-release an existing tag.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "ERROR: release $TAG already exists. Remove it from $RELEASES_DIR, bump the version, or run:" >&2
  echo "       gh release upload $TAG $VSIX --clobber   (to replace just the asset)" >&2
  exit 1
fi

# 5. Create the release, attach the VSIX, and auto-generate notes.
echo "Publishing $TAG from $VSIX ..."
gh release create "$TAG" "$VSIX" \
  --title "Switchboard $VERSION" \
  --generate-notes

echo "Released $TAG → https://github.com/TentacleOpera/switchboard/releases/tag/$TAG"
