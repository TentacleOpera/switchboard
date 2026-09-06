#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/dist}"
mkdir -p "$OUT_DIR"

# Keep the target list explicit. Runtime selection must never search PATH or
# silently select a host built for a different platform.
targets=(
  "linux/arm64/linux-arm64"
  "linux/amd64/linux-amd64"
  "darwin/arm64/darwin-arm64"
  "darwin/amd64/darwin-amd64"
)
for target in "${targets[@]}"; do
  IFS=/ read -r goos goarch directory <<< "$target"
  mkdir -p "$OUT_DIR/$directory"
  suffix=""
  [[ "$goos" == windows ]] && suffix=".exe"
  echo "building $goos/$goarch"
  (cd "$ROOT_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags='-s -w' -o "$OUT_DIR/$directory/switchboard-pty-host${suffix}" ./cmd/switchboard-pty-host)
done
cp "$ROOT_DIR/pty-host-artifacts.json" "$OUT_DIR/pty-host-artifacts.json"

# Positive probe on the native build. It validates the executable bit and the
# versioned ready handshake before packaging can consume the artifact.
native="$OUT_DIR/linux-amd64/switchboard-pty-host"
if [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]; then
  [[ -x "$native" ]] || { echo "ERROR: native PTY host is not executable" >&2; exit 1; }
  probe=$(printf '' | "$native" --workspace "$ROOT_DIR")
  node -e 'const m=JSON.parse(process.argv[1]); if(m.t!=="ready"||m.version!==1||!Number.isInteger(m.port)||!m.token) process.exit(1)' "$probe" || {
    echo "ERROR: native PTY host handshake/version probe failed" >&2
    exit 1
  }
fi
