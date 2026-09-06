#!/usr/bin/env bash
set -euo pipefail

# Run from the repo root so paths are predictable regardless of where the script is invoked.
cd "$(dirname "$0")/.."

# Publish a GitHub Release for the prebuilt .vsix in the releases/ directory,
# and attach the two native .deb artifacts + the apt repository manifest when
# they exist for the same version.
# The highest-versioned switchboard-*.vsix file is released automatically.
# To target a specific version, set VERSION, e.g. VERSION=1.7.6 npm run release.

RELEASES_DIR="releases"
DEB_ROOT="$RELEASES_DIR/deb"

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

# 5. Collect the native .deb assets and the apt manifest for this version, if
#    they exist. The release lists both .deb assets, the resolved Pages apt
#    origin, signing fingerprint, Valid-Until, and the repository manifest
#    (plan: amd64-package-and-an-apt-repository). Missing debs are NOT fatal
#    here — a VSIX-only release is still valid — but the release notes call
#    out which native artifacts are absent so the operator notices.
ASSETS=("$VSIX")
AMD64_DEB=""
ARM64_DEB=""
APT_MANIFEST=""
APT_NOTES=""
if [[ -d "$DEB_ROOT/$VERSION" ]]; then
  AMD64_DEB="$(find "$DEB_ROOT/$VERSION/amd64" -maxdepth 1 -name "switchboard_${VERSION}_amd64.deb" -type f 2>/dev/null | head -1 || true)"
  ARM64_DEB="$(find "$DEB_ROOT/$VERSION/arm64" -maxdepth 1 -name "switchboard_${VERSION}_arm64.deb" -type f 2>/dev/null | head -1 || true)"
  # The apt manifest lives at the repository builder's output root, not under
  # deb/<version>/. Look for it in a sibling apt-repo directory.
  APT_REPO_DIR="$RELEASES_DIR/apt-repo/$VERSION"
  if [[ -f "$APT_REPO_DIR/release-manifest.json" ]]; then
    APT_MANIFEST="$APT_REPO_DIR/release-manifest.json"
    ASSETS+=("$APT_MANIFEST")
  fi
fi
if [[ -n "$AMD64_DEB" ]]; then ASSETS+=("$AMD64_DEB"); fi
if [[ -n "$ARM64_DEB" ]]; then ASSETS+=("$ARM64_DEB"); fi

# Build the release notes: auto-generated notes plus an apt repository section
# that names both .deb assets, the resolved Pages apt origin, signing
# fingerprint, and Valid-Until (when the manifest is present).
APT_NOTES_BODY=""
if [[ -n "$APT_MANIFEST" ]]; then
  APT_PAGES_ORIGIN="$(node -p "require('$APT_MANIFEST').pagesOrigin || '(not recorded — run publish-apt-repository.sh)'" 2>/dev/null || echo '(not recorded)')"
  APT_FP="$(node -p "require('$APT_MANIFEST').signingFingerprint || ''" 2>/dev/null || echo '')"
  APT_VALID_UNTIL="$(node -p "require('$APT_MANIFEST').validUntil || ''" 2>/dev/null || echo '')"
  APT_NOTES_BODY=$(cat <<NOTES

### apt repository

- **Origin:** ${APT_PAGES_ORIGIN}
- **Signing fingerprint:** ${APT_FP}
- **Valid-Until:** ${APT_VALID_UNTIL}
- **Architectures:** amd64, arm64
- Native packages attached: $( [[ -n "$AMD64_DEB" ]] && echo 'amd64 ✓' || echo 'amd64 ✗ (absent)' ), $( [[ -n "$ARM64_DEB" ]] && echo 'arm64 ✓' || echo 'arm64 ✗ (absent)' )

See \`packaging/debian/README.md\` for repository setup and direct \`.deb\` installation.
NOTES
)
elif [[ -n "$AMD64_DEB" || -n "$ARM64_DEB" ]]; then
  APT_NOTES_BODY=$'\n\n### Native packages\n\n'
  APT_NOTES_BODY+="Native .deb artifacts attached: $( [[ -n "$AMD64_DEB" ]] && echo 'amd64 ✓' || echo 'amd64 ✗' ), $( [[ -n "$ARM64_DEB" ]] && echo 'arm64 ✓' || echo 'arm64 ✗' )."
  APT_NOTES_BODY+=$'\n\nNo signed apt repository manifest was found alongside them — run scripts/build-apt-repository.sh to produce one.'
fi

# 6. Create the release with all assets, then append the apt notes.
echo "Publishing $TAG from $VSIX ..."
gh release create "$TAG" "${ASSETS[@]}" \
  --title "Switchboard $VERSION" \
  --generate-notes

if [[ -n "$APT_NOTES_BODY" ]]; then
  # Append the apt section to the auto-generated notes.
  EXISTING_NOTES="$(gh release view "$TAG" --json body -q .body 2>/dev/null || echo '')"
  printf '%s\n%s\n' "$EXISTING_NOTES" "$APT_NOTES_BODY" | gh release edit "$TAG" --notes-file -
fi

echo "Released $TAG → https://github.com/TentacleOpera/switchboard/releases/tag/$TAG"
if [[ -n "$APT_MANIFEST" ]]; then
  echo "apt origin: $(node -p "require('$APT_MANIFEST').pagesOrigin || '(not recorded)'" 2>/dev/null || echo '(not recorded)')"
  echo "Signing fingerprint: $(node -p "require('$APT_MANIFEST').signingFingerprint" 2>/dev/null || echo '')"
  echo "Valid-Until: $(node -p "require('$APT_MANIFEST').validUntil" 2>/dev/null || echo '')"
fi
