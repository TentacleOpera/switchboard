#!/usr/bin/env bash
set -euo pipefail

# Package VSIX files with the explicit Go PTY host artifact matrix. Native Node
# staging is retired: every artifact contains small, static target binaries and
# the runtime manifest selects exactly one by OS/architecture.
cd "$(dirname "$0")/.."
RELEASES_DIR="releases"
VERSION=$(node -p "require('./package.json').version")
MAX_VSIX_BYTES=$((25 * 1024 * 1024))
TARGETS=(linux-arm64 linux-x64 darwin-arm64 darwin-x64)

if [[ -x "node_modules/.bin/vsce" ]]; then
  VSCE=(node_modules/.bin/vsce)
else
  VSCE=(npx --yes @vscode/vsce)
fi

[[ -f dist/pty-host-artifacts.json ]] || {
  echo "ERROR: dist/pty-host-artifacts.json missing — run scripts/build-pty-host.sh first" >&2
  exit 1
}
mkdir -p "$RELEASES_DIR"

host_uname="$(uname -s)-$(uname -m)"
verify_vsix() {
  local vsix="$1" target="$2" listing bytes relative extracted
  listing=$(unzip -Z1 "$vsix")
  bytes=$(wc -c < "$vsix" | tr -d ' ')
  (( bytes <= MAX_VSIX_BYTES )) || { echo "ERROR: $vsix exceeds VSIX size floor" >&2; exit 1; }
  manifest_target="$target"
  [[ "$manifest_target" == linux-x64 ]] && manifest_target=linux-amd64
  [[ "$manifest_target" == darwin-x64 ]] && manifest_target=darwin-amd64
  relative=$(node -p "JSON.parse(require('fs').readFileSync('dist/pty-host-artifacts.json','utf8')).targets['$manifest_target'] || ''")
  [[ -n "$relative" ]] || { echo "ERROR: manifest has no target $target" >&2; exit 1; }
  grep -q "dist/${relative}" <<< "$listing" || grep -q "${relative}" <<< "$listing" || {
    echo "ERROR: $vsix missing PTY host artifact ${relative}" >&2; exit 1;
  }
  grep -q 'better-sqlite3/build/Release/.*\.node' <<< "$listing" || grep -q 'better-sqlite3/.*/.*\.node' <<< "$listing" || {
    echo "ERROR: $vsix missing better-sqlite3 native addon" >&2; exit 1;
  }
  # better-sqlite3's native addon is required; reject any other .node binary.
  unexpected_node=$(grep -i '\.node$' <<< "$listing" | grep -vi 'better-sqlite3' || true)
  if [[ -n "$unexpected_node" ]]; then
    echo "ERROR: $vsix contains unexpected native Node addon:" >&2
    echo "$unexpected_node" >&2
    exit 1
  fi
  extracted=$(mktemp)
  unzip -p "$vsix" "extension/${relative}" > "$extracted" 2>/dev/null || unzip -p "$vsix" "${relative}" > "$extracted"
  chmod 755 "$extracted"
  [[ -x "$extracted" ]] || { echo "ERROR: packaged PTY host is not executable" >&2; rm -f "$extracted"; exit 1; }
  case "$manifest_target" in
    linux-amd64) grep -q 'x86-64' <<<"$(file -b "$extracted")" || { echo "ERROR: $vsix PTY host is not linux-amd64" >&2; rm -f "$extracted"; exit 1; } ;;
    linux-arm64) grep -q 'ARM aarch64\|ARM64\|aarch64' <<<"$(file -b "$extracted")" || { echo "ERROR: $vsix PTY host is not linux-arm64" >&2; rm -f "$extracted"; exit 1; } ;;
    darwin-amd64) grep -q 'Mach-O.*x86_64' <<<"$(file -b "$extracted")" || { echo "ERROR: $vsix PTY host is not darwin-amd64" >&2; rm -f "$extracted"; exit 1; } ;;
    darwin-arm64) grep -q 'Mach-O.*arm64' <<<"$(file -b "$extracted")" || { echo "ERROR: $vsix PTY host is not darwin-arm64" >&2; rm -f "$extracted"; exit 1; } ;;
  esac
  if [[ "$manifest_target" == linux-amd64 && "$host_uname" == Linux-x86_64 ]]; then
    probe=$(printf '' | "$extracted" --workspace "$(pwd)")
    node -e 'const m=JSON.parse(process.argv[1]); if(m.t!=="ready"||m.version!==1||!Number.isInteger(m.port)||!m.token) process.exit(1)' "$probe" || {
      echo "ERROR: packaged PTY host handshake/version probe failed" >&2
      rm -f "$extracted"
      exit 1
    }
  fi
  rm -f "$extracted"
  printf 'verified %s (%s KB)\n' "$vsix" "$((bytes / 1024))"
}

manifest_dir_for() {
  case "$1" in
    linux-x64) echo linux-amd64 ;;
    darwin-x64) echo darwin-amd64 ;;
    *) echo "$1" ;;
  esac
}

stash_other_hosts() {
  local keep="$1" stash="$2" dir
  mkdir -p "$stash"
  for dir in linux-arm64 linux-amd64 darwin-arm64 darwin-amd64; do
    if [[ "$dir" != "$keep" && -d "dist/$dir" ]]; then
      mv "dist/$dir" "$stash/$dir"
    fi
  done
}

restore_hosts() {
  local stash="$1"
  if [[ -d "$stash" ]]; then
    shopt -s nullglob
    for dir in "$stash"/*; do
      mv "$dir" dist/
    done
    shopt -u nullglob
    rmdir "$stash" 2>/dev/null || true
  fi
}

for target in "${TARGETS[@]}"; do
  out="$RELEASES_DIR/switchboard-$VERSION-$target.vsix"
  rm -f "$out"
  stash=$(mktemp -d)
  stash_other_hosts "$(manifest_dir_for "$target")" "$stash"
  if ! "${VSCE[@]}" package --target "$target" --out "$out"; then
    restore_hosts "$stash"
    exit 1
  fi
  restore_hosts "$stash"
  verify_vsix "$out" "$target"
done

out="$RELEASES_DIR/switchboard-$VERSION.vsix"
rm -f "$out"
stash=$(mktemp -d)
stash_other_hosts linux-arm64 "$stash"
if ! "${VSCE[@]}" package --out "$out"; then
  restore_hosts "$stash"
  exit 1
fi
restore_hosts "$stash"
verify_vsix "$out" linux-arm64
