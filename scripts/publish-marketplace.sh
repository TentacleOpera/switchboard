#!/usr/bin/env bash
set -euo pipefail

# Publish the platform VSIX matrix to the VS Code Marketplace.
#
# Run `bash scripts/package-targets.sh` first — this script only uploads artifacts
# that already exist and have already been content-verified there.
#
# TWO MECHANICS THAT ARE EASY TO GET WRONG (verified against vsce docs/issues):
#
#  1. Every artifact is published with `--packagePath`, sequentially. Publishing by
#     re-packaging per target would rebuild without the prebuild staging that
#     package-targets.sh performs, silently shipping all four platforms.
#
#  2. `--skip-duplicate` is NEVER passed. vsce issues #868/#1014: with multiple
#     targets under one version tag, the second and later targets are wrongly
#     treated as duplicates and skipped — you would publish darwin-arm64 and
#     believe the other four went out. If a target genuinely needs re-publishing,
#     bump the version.
#
# Platform targeting requires engines.vscode >= ^1.61.0; this extension is on
# ^1.93.0, so no manifest change is needed.
#
# Usage: bash scripts/publish-marketplace.sh          (publishes all five)
#        DRY_RUN=1 bash scripts/publish-marketplace.sh

cd "$(dirname "$0")/.."

RELEASES_DIR="releases"
TARGETS=(darwin-arm64 darwin-x64 win32-x64 win32-arm64)
VERSION=$(node -p "require('./package.json').version")

if [[ -x "node_modules/.bin/vsce" ]]; then
  VSCE=(node_modules/.bin/vsce)
else
  VSCE=(npx --yes @vscode/vsce)
fi

fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Collect the full set FIRST and bail if any is missing. A partial publish leaves
# the Marketplace serving some platforms at the new version and others at the old
# one — worse than not publishing at all.
ARTIFACTS=()
for target in "${TARGETS[@]}"; do
  f="$RELEASES_DIR/switchboard-$VERSION-$target.vsix"
  [[ -f "$f" ]] || fail "$f not found. Run: bash scripts/package-targets.sh"
  ARTIFACTS+=("$f")
done
UNIVERSAL="$RELEASES_DIR/switchboard-$VERSION.vsix"
[[ -f "$UNIVERSAL" ]] || fail "$UNIVERSAL (universal fallback) not found. Run: bash scripts/package-targets.sh"
ARTIFACTS+=("$UNIVERSAL")

printf 'Publishing %d artifacts for version %s:\n' "${#ARTIFACTS[@]}" "$VERSION"
for f in "${ARTIFACTS[@]}"; do printf '  %s\n' "$f"; done

if [[ -n "${DRY_RUN:-}" ]]; then
  printf '\nDRY_RUN set — nothing published.\n'
  exit 0
fi

for f in "${ARTIFACTS[@]}"; do
  printf '\n==> vsce publish --packagePath %s\n' "$f"
  "${VSCE[@]}" publish --packagePath "$f"
done

printf '\nPublished %d artifacts for %s.\n' "${#ARTIFACTS[@]}" "$VERSION"
printf 'Targets not in the matrix (Linux, alpine, web) receive the universal build,\n'
printf 'which carries no node-pty prebuild and degrades via isPtyAvailable(). State\n'
printf 'this in the release notes.\n'
