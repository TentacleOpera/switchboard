#!/usr/bin/env bash
set -euo pipefail

# Build the platform-specific VSIX matrix plus the universal fallback.
#
# WHY THIS SCRIPT EXISTS
# node-pty is a native module: it cannot be webpack-bundled, so it ships in
# node_modules and loads `prebuilds/<platform>-<arch>/` at runtime. Its prebuilds
# directory carries ALL four supported platforms (58 MB). `.vscodeignore` is static
# and cannot vary per package run, so without staging every VSIX would carry every
# platform — +58 MB on a darwin build that needs 136 KB of it.
#
# This script stages only the current target's prebuild directory for the duration
# of each `vsce package --target` run, then restores the tree.
#
# THE MATRIX
#   darwin-arm64, darwin-x64, win32-x64, win32-arm64  → node-pty included
#   universal (no --target)                           → no prebuilds at all
#
# `universal` is NOT a valid --target value; the fallback artifact is produced by
# omitting the flag. The Marketplace serves platform-specific builds preferentially
# and falls back to the target-less VSIX for anything unlisted (Linux, alpine, web),
# where `isPtyAvailable()` fails the load and every PTY surface gates itself off.
#
# Usage:  bash scripts/package-targets.sh
# Output: releases/switchboard-<version>-<target>.vsix  (+ switchboard-<version>.vsix)

cd "$(dirname "$0")/.."

RELEASES_DIR="releases"
PREBUILDS_DIR="node_modules/node-pty/prebuilds"
# The stash MUST live inside node_modules/ (which .vscodeignore excludes wholesale).
# A repo-root stash is itself packaged by vsce, so the VSIX ends up carrying the very
# platforms the staging just moved out of the way — the exact bug this line prevents.
STASH_DIR="node_modules/.switchboard-prebuild-stash"
TARGETS=(darwin-arm64 darwin-x64 win32-x64 win32-arm64)

# Conservative floor of the documented Marketplace per-VSIX upload cap (25-50 MB).
# Asserting against the floor means a build fails here rather than as an HTTP 413
# halfway through a five-artifact publish.
MAX_VSIX_BYTES=$((25 * 1024 * 1024))

VERSION=$(node -p "require('./package.json').version")

# --- vsce resolution -------------------------------------------------------
# Prefer a local devDependency; otherwise pin @vscode/vsce through npx. A stale
# GLOBAL `vsce` (the deprecated pre-2022 package) may not support --target at all,
# so it is deliberately not consulted.
if [[ -x "node_modules/.bin/vsce" ]]; then
  VSCE=(node_modules/.bin/vsce)
else
  VSCE=(npx --yes @vscode/vsce)
fi

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- guards ----------------------------------------------------------------
# vsce refuses to run when package.json carries a `files` array AND a .vscodeignore
# exists ("VSCE does not support combining both strategies"). The `files` array was
# added by the standalone/npx work; npm publishing is an explicit non-goal of this
# feature and nothing is published to npm (the `switchboard` name there belongs to a
# third party), so `.vscodeignore` is the operative mechanism and `files` was removed.
# If npm packaging is ever revived, express it through an `.npmignore`, not `files`.
if node -e "process.exit(Array.isArray(require('./package.json').files) && require('./package.json').files.length ? 0 : 1)"; then
  fail "package.json has a 'files' array and .vscodeignore exists — vsce refuses to combine them. Remove 'files' (see comment above) or delete .vscodeignore."
fi
[[ -d dist ]] || fail "dist/ is missing — run 'npm run package' first."
[[ -d "$PREBUILDS_DIR" ]] || fail "$PREBUILDS_DIR is missing — run 'npm install' (node-pty is an optionalDependency)."
[[ -e "$STASH_DIR" ]] && fail "$STASH_DIR already exists — a previous run died mid-stage. Inspect it, move its contents back under $PREBUILDS_DIR, and remove it."

mkdir -p "$RELEASES_DIR"

# --- staging ---------------------------------------------------------------
# Restore is a trap, not a trailing line: an interrupted or failed package run must
# never leave the developer's node_modules missing three platforms' prebuilds.
restore_prebuilds() {
  if [[ -d "$STASH_DIR" ]]; then
    mkdir -p "$PREBUILDS_DIR"
    for d in "$STASH_DIR"/*; do
      [[ -e "$d" ]] || continue
      mv "$d" "$PREBUILDS_DIR/"
    done
    rmdir "$STASH_DIR" 2>/dev/null || true
  fi
}
trap restore_prebuilds EXIT INT TERM

stage_only() {
  # Move every prebuild dir into the stash, then move back just the one requested
  # (none, if called with no argument — the universal build).
  local keep="${1:-}"
  mkdir -p "$STASH_DIR"
  for d in "$PREBUILDS_DIR"/*; do
    [[ -e "$d" ]] || continue
    mv "$d" "$STASH_DIR/"
  done
  if [[ -n "$keep" ]]; then
    [[ -d "$STASH_DIR/$keep" ]] || fail "node-pty ships no prebuild for '$keep' — the matrix and the installed node-pty disagree."
    mv "$STASH_DIR/$keep" "$PREBUILDS_DIR/"
  fi
}

# --- artifact verification -------------------------------------------------
# The tripwire the plan calls for, run as a build gate rather than as manual UAT:
# a wrong artifact fails the build instead of reaching the Marketplace.
verify_vsix() {
  local vsix="$1" kind="$2"
  local listing
  listing=$(unzip -Z1 "$vsix")

  local bytes
  bytes=$(wc -c < "$vsix" | tr -d ' ')
  if (( bytes > MAX_VSIX_BYTES )); then
    fail "$vsix is $((bytes / 1024 / 1024)) MB, over the ${MAX_VSIX_BYTES} byte assertion. Something re-included debug symbols or extra platforms."
  fi

  # No debug symbols, ever, in any artifact. `.pdb` files are 28 of node-pty's
  # 30 MB win32 directory and the loader never touches them.
  if grep -qi '\.pdb$' <<<"$listing"; then
    fail "$vsix contains .pdb debug symbols. Check the .vscodeignore negations — a blanket '!node_modules/node-pty/**' overrides '**/*.pdb'."
  fi

  case "$kind" in
    darwin)
      grep -q 'prebuilds/darwin-[^/]*/pty\.node$' <<<"$listing" || fail "$vsix is missing prebuilds/darwin-*/pty.node"
      grep -q 'prebuilds/darwin-[^/]*/spawn-helper$' <<<"$listing" || fail "$vsix is missing prebuilds/darwin-*/spawn-helper (node-pty cannot fork without it)"
      ;;
    win32)
      grep -q 'prebuilds/win32-[^/]*/conpty\.node$'             <<<"$listing" || fail "$vsix is missing conpty.node"
      grep -q 'prebuilds/win32-[^/]*/pty\.node$'                <<<"$listing" || fail "$vsix is missing pty.node"
      grep -q 'prebuilds/win32-[^/]*/conpty_console_list\.node$' <<<"$listing" || fail "$vsix is missing conpty_console_list.node"
      grep -q 'prebuilds/win32-[^/]*/winpty\.dll$'              <<<"$listing" || fail "$vsix is missing winpty.dll"
      grep -q 'prebuilds/win32-[^/]*/winpty-agent\.exe$'        <<<"$listing" || fail "$vsix is missing winpty-agent.exe"
      grep -q 'prebuilds/win32-[^/]*/conpty/'                   <<<"$listing" || fail "$vsix is missing the conpty/ directory"
      ;;
    universal)
      if grep -q '\.node$' <<<"$listing"; then
        fail "$vsix is the universal fallback but contains a native .node binary. Staging failed — it must carry no prebuild at all."
      fi
      ;;
  esac

  # Exactly one platform per artifact: a build that carries two has defeated the
  # whole point of the matrix.
  local platform_count
  platform_count=$(grep -oE 'prebuilds/[a-z0-9]+-[a-z0-9]+/' <<<"$listing" | sort -u | wc -l | tr -d ' ')
  if [[ "$kind" != "universal" && "$platform_count" != "1" ]]; then
    fail "$vsix carries $platform_count prebuild platforms; expected exactly 1."
  fi

  printf '    verified: %s (%s KB)\n' "$(basename "$vsix")" "$((bytes / 1024))"
}

# --- build the matrix ------------------------------------------------------
BUILT=()

for target in "${TARGETS[@]}"; do
  log "Packaging $target"
  stage_only "$target"
  out="$RELEASES_DIR/switchboard-$VERSION-$target.vsix"
  rm -f "$out"
  "${VSCE[@]}" package --target "$target" --out "$out"
  restore_prebuilds
  case "$target" in
    darwin-*) verify_vsix "$out" darwin ;;
    win32-*)  verify_vsix "$out" win32 ;;
  esac
  BUILT+=("$out")
done

log "Packaging universal fallback (no --target)"
stage_only
out="$RELEASES_DIR/switchboard-$VERSION.vsix"
rm -f "$out"
"${VSCE[@]}" package --out "$out"
restore_prebuilds
verify_vsix "$out" universal
BUILT+=("$out")

log "Built ${#BUILT[@]} artifacts"
for f in "${BUILT[@]}"; do printf '  %s\n' "$f"; done
printf '\nPublish with: bash scripts/publish-marketplace.sh\n'
