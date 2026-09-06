#!/usr/bin/env bash
set -euo pipefail

# Build the static Go switchboard client for all supported targets.
#
# The client owns argument parsing, endpoint resolution, HTTP transport, output
# formatting, exit codes, and Node-host handoff for non-client verbs. It never
# accesses the database, reimplements board logic, or searches PATH for a
# lookalike Node entry point.
#
# Usage: bash scripts/build-client.sh [output-dir]
# Default output: dist/

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/dist}"
mkdir -p "$OUT_DIR"

# Keep the target list explicit. Runtime selection must never search PATH or
# silently select a client built for a different platform. Windows/amd64 is
# included so the client can serve remote agents on Windows machines that have
# no Node installed.
targets=(
  "linux/arm64/linux-arm64"
  "linux/amd64/linux-amd64"
  "darwin/arm64/darwin-arm64"
  "darwin/amd64/darwin-amd64"
  "windows/amd64/windows-amd64"
)
for target in "${targets[@]}"; do
  IFS=/ read -r goos goarch directory <<< "$target"
  mkdir -p "$OUT_DIR/$directory"
  suffix=""
  [[ "$goos" == windows ]] && suffix=".exe"
  echo "building switchboard client $goos/$goarch"
  (cd "$ROOT_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags='-s -w' -o "$OUT_DIR/$directory/switchboard${suffix}" ./cmd/switchboard)
done

# Copy the artifact manifest so consumers can resolve the client binary by
# platform without guessing paths.
cp "$ROOT_DIR/client-artifacts.json" "$OUT_DIR/client-artifacts.json"

# Positive probe on the native build. Validates the executable bit and that
# `about` identifies as the Go client (not Node).
native="$OUT_DIR/linux-amd64/switchboard"
if [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]; then
  [[ -x "$native" ]] || { echo "ERROR: native switchboard client is not executable" >&2; exit 1; }
  # `about` must print the banner and the Go client host line.
  output="$("$native" about 2>&1)"
  echo "$output" | grep -q 'SWITCHBOARD' || { echo "ERROR: switchboard client about probe failed (no banner)" >&2; exit 1; }
  echo "$output" | grep -q 'Go Client' || { echo "ERROR: switchboard client about probe failed (no Go Client host line)" >&2; exit 1; }
  echo "native probe OK"
fi
