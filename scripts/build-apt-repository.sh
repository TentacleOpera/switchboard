#!/usr/bin/env bash
set -euo pipefail

# build-apt-repository.sh — build a signed apt repository from two validated
# native .deb artifacts (one amd64, one arm64) of the same application version.
#
# This script consumes COMPLETED native package artifacts produced by
# scripts/package-deb.sh. It does NOT invoke remote builds, hold host
# credentials, or touch the private signing key beyond asking GPG to sign with
# the key identified by --signing-fingerprint.
#
# Layout produced in the output directory:
#
#   pool/main/s/switchboard/switchboard_<version>_<arch>.deb
#   dists/stable/main/binary-amd64/Packages
#   dists/stable/main/binary-amd64/Packages.gz
#   dists/stable/main/binary-arm64/Packages
#   dists/stable/main/binary-arm64/Packages.gz
#   dists/stable/Release
#   dists/stable/InRelease
#   dists/stable/Release.gpg
#   switchboard-archive-keyring.gpg
#   release-manifest.json
#
# See amd64-package-and-an-apt-repository.md.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Arguments ─────────────────────────────────────────────────────────────
VERSION=""
RELEASES_ROOT="$ROOT_DIR/releases/deb"
OUT_DIR=""
SIGNING_FINGERPRINT=""
SUITE="stable"
COMPONENT="main"
VALID_UNTIL_DAYS="14"
RETAIN_PRIOR=""
PAGES_ORIGIN=""

usage() {
  cat <<'USAGE'
build-apt-repository.sh --version <ver> [--releases-root <dir>] --out <dir> \
  --signing-fingerprint <40-char-fp> [--suite stable] [--component main] \
  [--valid-until-days 14] [--retain-prior <prior-repo-dir>] \
  [--pages-origin <https url>]

Consumes releases/deb/<version>/<arch>/*.deb + *.manifest.json for amd64 and
arm64 of the SAME version, builds a signed apt repository in --out, and emits
release-manifest.json. --retain-prior copies forward every object referenced
by a prior signed repository so apt upgrade keeps working for clients that
have not yet refreshed. --pages-origin is recorded in the manifest so the
publisher can refuse to publish to a different origin.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --releases-root) RELEASES_ROOT="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --signing-fingerprint) SIGNING_FINGERPRINT="$2"; shift 2 ;;
    --suite) SUITE="$2"; shift 2 ;;
    --component) COMPONENT="$2"; shift 2 ;;
    --valid-until-days) VALID_UNTIL_DAYS="$2"; shift 2 ;;
    --retain-prior) RETAIN_PRIOR="$2"; shift 2 ;;
    --pages-origin) PAGES_ORIGIN="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$VERSION" ]]             || { echo "ERROR: --version is required" >&2; exit 2; }
[[ -n "$OUT_DIR" ]]             || { echo "ERROR: --out is required" >&2; exit 2; }
[[ -n "$SIGNING_FINGERPRINT" ]] || { echo "ERROR: --signing-fingerprint is required" >&2; exit 2; }

# Normalise the fingerprint: strip spaces, upper-case. Must be 40 hex chars
# (no key IDs — the plan requires the FULL fingerprint).
FP_CLEAN="$(printf '%s' "$SIGNING_FINGERPRINT" | tr -d ' ' | tr 'a-f' 'A-F')"
if [[ ! "$FP_CLEAN" =~ ^[A-F0-9]{40}$ ]]; then
  echo "ERROR: --signing-fingerprint must be a full 40-character OpenPGP fingerprint." >&2
  echo "       Got: '$SIGNING_FINGERPRINT'" >&2
  exit 2
fi
SIGNING_FINGERPRINT="$FP_CLEAN"

# ── Tool checks ───────────────────────────────────────────────────────────
for tool in dpkg-deb dpkg-scanpackages apt-ftparchive gpg sha256sum gzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found" >&2; exit 1; }
done

# ── Resolve the two validated artifacts ───────────────────────────────────
# Require exactly one amd64 and one arm64 .deb for the requested version,
# each with a sidecar manifest. Compare package control version, source
# revision, application metadata, architecture, and sidecar hashes before
# generating any repository output.
AMD64_DIR="$RELEASES_ROOT/$VERSION/amd64"
ARM64_DIR="$RELEASES_ROOT/$VERSION/arm64"
[[ -d "$AMD64_DIR" ]] || { echo "ERROR: $AMD64_DIR not found — build the amd64 package first" >&2; exit 1; }
[[ -d "$ARM64_DIR" ]] || { echo "ERROR: $ARM64_DIR not found — build the arm64 package first" >&2; exit 1; }

AMD64_DEB="$(find "$AMD64_DIR" -maxdepth 1 -name "switchboard_${VERSION}_amd64.deb" -type f | head -1)"
ARM64_DEB="$(find "$ARM64_DIR" -maxdepth 1 -name "switchboard_${VERSION}_arm64.deb" -type f | head -1)"
[[ -n "$AMD64_DEB" ]] || { echo "ERROR: switchboard_${VERSION}_amd64.deb not found in $AMD64_DIR" >&2; exit 1; }
[[ -n "$ARM64_DEB" ]] || { echo "ERROR: switchboard_${VERSION}_arm64.deb not found in $ARM64_DIR" >&2; exit 1; }
AMD64_MANIFEST="${AMD64_DEB}.manifest.json"
ARM64_MANIFEST="${ARM64_DEB}.manifest.json"
[[ -f "$AMD64_MANIFEST" ]] || { echo "ERROR: $AMD64_MANIFEST not found" >&2; exit 1; }
[[ -f "$ARM64_MANIFEST" ]] || { echo "ERROR: $ARM64_MANIFEST not found" >&2; exit 1; }

# Compare control version, architecture, source revision, and application
# version across both sidecars. A mixed-version or mixed-revision release set
# is rejected before any repository output is generated.
compare_manifests() {
  local m1="$1" m2="$2" label1="$3" label2="$4"
  local v1 v2 r1 r2 a1 a2 sr1 sr2
  v1="$(node -p "require('$m1').applicationVersion" 2>/dev/null || echo '')"
  v2="$(node -p "require('$m2').applicationVersion" 2>/dev/null || echo '')"
  [[ "$v1" == "$VERSION" ]] || { echo "ERROR: $label1 manifest applicationVersion '$v1' != requested '$VERSION'" >&2; exit 1; }
  [[ "$v2" == "$VERSION" ]] || { echo "ERROR: $label2 manifest applicationVersion '$v2' != requested '$VERSION'" >&2; exit 1; }
  [[ "$v1" == "$v2" ]]       || { echo "ERROR: applicationVersion mismatch: $label1='$v1' vs $label2='$v2'" >&2; exit 1; }
  a1="$(node -p "require('$m1').packageArchitecture" 2>/dev/null || echo '')"
  a2="$(node -p "require('$m2').packageArchitecture" 2>/dev/null || echo '')"
  [[ "$a1" == "amd64" ]]     || { echo "ERROR: $label1 manifest packageArchitecture '$a1' != amd64" >&2; exit 1; }
  [[ "$a2" == "arm64" ]]     || { echo "ERROR: $label2 manifest packageArchitecture '$a2' != arm64" >&2; exit 1; }
  sr1="$(node -p "require('$m1').sourceRevision||''" 2>/dev/null || echo '')"
  sr2="$(node -p "require('$m2').sourceRevision||''" 2>/dev/null || echo '')"
  # Both must be present and equal. An empty revision (non-git checkout) is
  # rejected for a release — the repository builder needs a stable identity.
  [[ -n "$sr1" && -n "$sr2" ]] || { echo "ERROR: both manifests must record a sourceRevision for a release" >&2; exit 1; }
  [[ "$sr1" == "$sr2" ]]       || { echo "ERROR: sourceRevision mismatch: $label1='$sr1' vs $label2='$sr2'" >&2; exit 1; }
  # Reject a dirty build for a release.
  local d1 d2
  d1="$(node -p "require('$m1').sourceDirty===true" 2>/dev/null || echo 'false')"
  d2="$(node -p "require('$m2').sourceDirty===true" 2>/dev/null || echo 'false')"
  [[ "$d1" == "false" && "$d2" == "false" ]] || { echo "ERROR: refusing to release a package built from a dirty tree" >&2; exit 1; }
}
compare_manifests "$AMD64_MANIFEST" "$ARM64_MANIFEST" "amd64" "arm64"

# Verify each .deb's control metadata matches its sidecar.
verify_deb_control() {
  local deb="$1" manifest="$2" label="$3"
  local ctrl_ver ctrl_arch m_ver m_arch
  ctrl_ver="$(dpkg-deb -f "$deb" Version 2>/dev/null || echo '')"
  ctrl_arch="$(dpkg-deb -f "$deb" Architecture 2>/dev/null || echo '')"
  m_ver="$(node -p "require('$manifest').applicationVersion" 2>/dev/null || echo '')"
  m_arch="$(node -p "require('$manifest').packageArchitecture" 2>/dev/null || echo '')"
  [[ "$ctrl_ver" == "$m_ver" ]]  || { echo "ERROR: $label control Version '$ctrl_ver' != manifest '$m_ver'" >&2; exit 1; }
  [[ "$ctrl_arch" == "$m_arch" ]]|| { echo "ERROR: $label control Architecture '$ctrl_arch' != manifest '$m_arch'" >&2; exit 1; }
}
verify_deb_control "$AMD64_DEB" "$AMD64_MANIFEST" "amd64"
verify_deb_control "$ARM64_DEB" "$ARM64_MANIFEST" "arm64"

# Verify each .deb's SHA-256 matches its sidecar. A changed artifact at an
# existing version is a hard failure (the plan: same version + different bytes
# is rejected).
verify_deb_hash() {
  local deb="$1" manifest="$2" label="$3"
  local actual expected
  actual="$(sha256sum "$deb" | awk '{print $1}')"
  expected="$(node -p "require('$manifest').packageSha256" 2>/dev/null || echo '')"
  [[ -n "$expected" ]] || { echo "ERROR: $label manifest has no packageSha256" >&2; exit 1; }
  [[ "$actual" == "$expected" ]] || { echo "ERROR: $label .deb SHA-256 '$actual' != manifest '$expected' — artifact changed after build" >&2; exit 1; }
}
verify_deb_hash "$AMD64_DEB" "$AMD64_MANIFEST" "amd64"
verify_deb_hash "$ARM64_DEB" "$ARM64_MANIFEST" "arm64"

SOURCE_REVISION="$(node -p "require('$AMD64_MANIFEST').sourceRevision")"

# ── Resolve the signing key ───────────────────────────────────────────────
# Verify the full fingerprint against GPG's resolved signing key. Never
# select a key by email substring or implicit default.
GPG=(gpg --batch --yes --local-user "$SIGNING_FINGERPRINT")
# Confirm the key is present and exactly matches the requested fingerprint.
RESOLVED_FP="$(gpg --batch --list-keys --with-colons "$SIGNING_FINGERPRINT" 2>/dev/null | awk -F: '/^fpr:/ {print $10}' | head -1)"
if [[ -z "$RESOLVED_FP" ]]; then
  echo "ERROR: no GPG key found for fingerprint $SIGNING_FINGERPRINT" >&2
  echo "       Import or restore the signing key into the local keyring first." >&2
  exit 1
fi
if [[ "$RESOLVED_FP" != "$SIGNING_FINGERPRINT" ]]; then
  echo "ERROR: GPG resolved fingerprint '$RESOLVED_FP' != requested '$SIGNING_FINGERPRINT'" >&2
  exit 1
fi

# ── Build the repository in a temporary directory ─────────────────────────
# Build and sign into a temporary tree. Publish (the publisher script) only
# after both packages, all indexes, Release, InRelease, and Release.gpg have
# passed validation. On any failure here, the prior repository tree is left
# untouched.
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

POOL_DIR="$WORK_DIR/pool/main/s/switchboard"
DIST_DIR="$WORK_DIR/dists/$SUITE"
mkdir -p "$POOL_DIR"
mkdir -p "$DIST_DIR/main/binary-amd64"
mkdir -p "$DIST_DIR/main/binary-arm64"

# Copy the two new packages into the pool.
cp "$AMD64_DEB" "$POOL_DIR/"
cp "$ARM64_DEB" "$POOL_DIR/"

# Retain prior versions needed for upgrades. Copy forward every .deb from the
# prior repository's pool so dpkg-scanpackages --multiversion includes them.
if [[ -n "$RETAIN_PRIOR" ]]; then
  [[ -d "$RETAIN_PRIOR/pool/main/s/switchboard" ]] || { echo "ERROR: --retain-prior '$RETAIN_PRIOR' has no pool/main/s/switchboard" >&2; exit 1; }
  # Copy any prior .deb that is NOT the same version+arch we are publishing
  # (those are already in the pool). Same version + same hash is idempotent;
  # same version + different hash is rejected below.
  for prior_deb in "$RETAIN_PRIOR"/pool/main/s/switchboard/*.deb; do
    [[ -f "$prior_deb" ]] || continue
    prior_name="$(basename "$prior_deb")"
    # If a same-named deb already exists in the new pool, verify the hash
    # matches (idempotent) or fail (changed bytes at same version).
    if [[ -f "$POOL_DIR/$prior_name" ]]; then
      prior_hash="$(sha256sum "$prior_deb" | awk '{print $1}')"
      new_hash="$(sha256sum "$POOL_DIR/$prior_name" | awk '{print $1}')"
      if [[ "$prior_hash" != "$new_hash" ]]; then
        echo "ERROR: $prior_name exists at the same version with different bytes (prior=$prior_hash, new=$new_hash)" >&2
        echo "       Publish changed bytes only under a higher package version." >&2
        exit 1
      fi
      # Same bytes — idempotent, already in pool.
      continue
    fi
    cp "$prior_deb" "$POOL_DIR/"
  done
fi

# ── Generate per-architecture indexes ─────────────────────────────────────
# dpkg-scanpackages --arch <arch> --multiversion includes all discovered
# package versions. Reject duplicate version/architecture entries with
# differing hashes (the --multiversion flag allows same-version dupes, so we
# check explicitly).
build_index() {
  local arch="$1"
  local idx_dir="$DIST_DIR/main/binary-$arch"
  local idx="$idx_dir/Packages"
  local gz="$idx_dir/Packages.gz"
  # --arch restricts to packages matching the architecture; --multiversion
  # keeps all versions (needed for apt upgrade).
  ( cd "$WORK_DIR" && dpkg-scanpackages --arch "$arch" --multiversion pool /dev/null > "$idx" )
  # Reject duplicate Version+Architecture with differing hashes.
  dup_check="$(node -e '
    const fs = require("fs");
    const txt = fs.readFileSync(0, "utf8");
    const blocks = txt.split(/\n\n+/).filter(b => b.trim());
    const seen = new Map();
    const dups = [];
    for (const b of blocks) {
      const get = (k) => { const m = b.match(new RegExp("^" + k + ":\\s*(.+)$", "m")); return m ? m[1].trim() : null; };
      const ver = get("Version"); const arch = get("Architecture");
      const fn = get("Filename"); const sz = get("Size"); const md5 = get("MD5sum");
      if (!ver || !arch || !fn) continue;
      const key = ver + "|" + arch;
      const sig = fn + "|" + sz + "|" + (md5 || "");
      if (seen.has(key)) {
        if (seen.get(key) !== sig) dups.push(key);
      } else {
        seen.set(key, sig);
      }
    }
    if (dups.length) { console.log(dups.join(";")); process.exit(1); }
  ' < "$idx" 2>/dev/null || true)"
  if [[ -n "$dup_check" ]]; then
    echo "ERROR: duplicate Version+Architecture with differing hashes in $arch index: $dup_check" >&2
    exit 1
  fi
  # Deterministic compression: gzip -n strips the embedded filename + mtime
  # so the .gz is reproducible across builds.
  gzip -n -c "$idx" > "$gz"
}
build_index amd64
build_index arm64

# Verify each architecture index references only its own architecture.
assert_index_arch() {
  local arch="$1" idx="$DIST_DIR/main/binary-$arch/Packages"
  local bad
  bad="$(awk '/^Architecture: / {print $2}' "$idx" | sort -u | grep -v "^${arch}$" || true)"
  if [[ -n "$bad" ]]; then
    echo "ERROR: binary-$arch/Packages references non-$arch entries: $bad" >&2
    exit 1
  fi
}
assert_index_arch amd64
assert_index_arch arm64

# ── Generate the suite-root Release ───────────────────────────────────────
# Generate Release only after all indexes exist. apt-ftparchive fills the
# index hashes (SHA256, MD5sum, etc.) automatically.
# Valid-Until is tied to the configured release cadence; expiration must be
# monitored because a missed release otherwise blocks updates by design.
RELEASE_DATE="$(date -u +%Y-%m-%d)"
VALID_UNTIL="$(date -u -d "+${VALID_UNTIL_DAYS} days" +%Y-%m-%d 2>/dev/null || date -u -v+${VALID_UNTIL_DAYS}d +%Y-%m-%d 2>/dev/null || echo '')"
if [[ -z "$VALID_UNTIL" ]]; then
  echo "ERROR: could not compute Valid-Until date" >&2; exit 1
fi

# Acquire-By-Hash: yes is advertised only when the builder also materializes
# every referenced index at by-hash/SHA256/<digest>. We do materialize them
# (below), so advertise it.
ACQUIRE_BY_HASH="yes"

( cd "$WORK_DIR" && apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="Switchboard" \
  -o APT::FTPArchive::Release::Label="Switchboard" \
  -o APT::FTPArchive::Release::Suite="$SUITE" \
  -o APT::FTPArchive::Release::Codename="$SUITE" \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
  -o APT::FTPArchive::Release::Components="$COMPONENT" \
  -o APT::FTPArchive::Release::Date="$RELEASE_DATE" \
  -o APT::FTPArchive::Release::Valid-Until="$VALID_UNTIL" \
  -o APT::FTPArchive::Release::Acquire-By-Hash="$ACQUIRE_BY_HASH" \
  release "dists/$SUITE" > "$DIST_DIR/Release" )

# ── Materialize by-hash objects ───────────────────────────────────────────
# For every index referenced in Release, copy it to
# dists/<suite>/main/binary-<arch>/by-hash/SHA256/<digest>. Publication
# retains these so clients holding the previous InRelease keep resolving.
materialize_by_hash() {
  local arch="$1"
  local idx_dir="$DIST_DIR/main/binary-$arch"
  local by_hash_dir="$idx_dir/by-hash/SHA256"
  mkdir -p "$by_hash_dir"
  for f in Packages Packages.gz; do
    local src="$idx_dir/$f"
    local digest
    digest="$(sha256sum "$src" | awk '{print $1}')"
    cp "$src" "$by_hash_dir/$digest"
  done
}
materialize_by_hash amd64
materialize_by_hash arm64

# Verify Release hashes cover every generated index. Parse Release and confirm
# every index file under dists/$SUITE has a matching SHA256 entry.
verify_release_coverage() {
  local rel="$DIST_DIR/Release"
  local missing=0
  while IFS= read -r idx_file; do
    local rel_path="dists/$SUITE/${idx_file#$DIST_DIR/}"
    rel_path="${rel_path#dists/$SUITE/}"
    # apt-ftparchive lists paths relative to the suite root.
    local digest
    digest="$(sha256sum "$idx_file" | awk '{print $1}')"
    if ! grep -q "$digest" "$rel"; then
      echo "ERROR: Release does not cover index $rel_path (sha256 $digest)" >&2
      missing=1
    fi
  done < <(find "$DIST_DIR" -name 'Packages' -o -name 'Packages.gz' | sort)
  [[ "$missing" -eq 0 ]] || exit 1
}
verify_release_coverage

# ── Sign: InRelease (clear-signed) + Release.gpg (detached) ───────────────
# Create both signature forms. Use an OpenPGP signing profile accepted by
# every target apt version: SHA-256 hash, no weak digest. Do not conflate
# proposed apt-sign Ed25519 signatures with OpenPGP key algorithm support.

# Clear-signed InRelease.
gpg --batch --yes --local-user "$SIGNING_FINGERPRINT" \
  --digest-algo SHA256 --cert-digest-algo SHA256 --clearsign \
  --output "$DIST_DIR/InRelease" "$DIST_DIR/Release" \
  || { echo "ERROR: InRelease signing failed" >&2; exit 1; }

# Detached Release.gpg.
gpg --batch --yes --local-user "$SIGNING_FINGERPRINT" \
  --digest-algo SHA256 --cert-digest-algo SHA256 --detach-sign \
  --output "$DIST_DIR/Release.gpg" "$DIST_DIR/Release" \
  || { echo "ERROR: Release.gpg signing failed" >&2; exit 1; }

# Export the minimal public key (unarmored .gpg for the keyring file).
gpg --batch --yes --export "$SIGNING_FINGERPRINT" > "$WORK_DIR/switchboard-archive-keyring.gpg" \
  || { echo "ERROR: public key export failed" >&2; exit 1; }
# Also an ASCII-armored copy for operator download.
gpg --batch --yes --armor --export "$SIGNING_FINGERPRINT" > "$WORK_DIR/switchboard-archive-keyring.asc" \
  || { echo "ERROR: armored public key export failed" >&2; exit 1; }

# ── Isolated signature verification ───────────────────────────────────────
# Verify both signatures in an isolated temporary GPG home containing ONLY
# the exported public key. This proves the signatures are verifiable with the
# public key alone, not because the private key is present.
VERIFY_GNUPGHOME=$(mktemp -d)
cleanup_verify() { rm -rf "$VERIFY_GNUPGHOME"; }
trap 'cleanup_verify; cleanup' EXIT
chmod 700 "$VERIFY_GNUPGHOME"
gpg --batch --yes --homedir "$VERIFY_GNUPGHOME" --import "$WORK_DIR/switchboard-archive-keyring.gpg" >/dev/null 2>&1 \
  || { echo "ERROR: isolated keyring import failed" >&2; exit 1; }
# Verify InRelease (clear-signed).
gpg --batch --yes --homedir "$VERIFY_GNUPGHOME" --verify "$DIST_DIR/InRelease" >/dev/null 2>&1 \
  || { echo "ERROR: InRelease signature verification failed in isolated keyring" >&2; exit 1; }
# Verify Release.gpg (detached) against Release.
gpg --batch --yes --homedir "$VERIFY_GNUPGHOME" --verify "$DIST_DIR/Release.gpg" "$DIST_DIR/Release" >/dev/null 2>&1 \
  || { echo "ERROR: Release.gpg signature verification failed in isolated keyring" >&2; exit 1; }
# Confirm the isolated keyring contains ONLY the intended public key.
VERIFY_FP="$(gpg --batch --homedir "$VERIFY_GNUPGHOME" --list-keys --with-colons 2>/dev/null | awk -F: '/^fpr:/ {print $10}' | head -1)"
[[ "$VERIFY_FP" == "$SIGNING_FINGERPRINT" ]] \
  || { echo "ERROR: isolated keyring fingerprint '$VERIFY_FP' != '$SIGNING_FINGERPRINT'" >&2; exit 1; }
echo "Both signatures verified in an isolated keyring containing only the public key."

# ── release-manifest.json ─────────────────────────────────────────────────
# Tool versions, source revision, package hashes, index hashes, signing
# fingerprint, repository suite/component/architectures, generation time.
# No secret paths or key material enter it.
AMD64_SHA="$(sha256sum "$AMD64_DEB" | awk '{print $1}')"
ARM64_SHA="$(sha256sum "$ARM64_DEB" | awk '{print $1}')"
AMD64_IDX_SHA="$(sha256sum "$DIST_DIR/main/binary-amd64/Packages" | awk '{print $1}')"
ARM64_IDX_SHA="$(sha256sum "$DIST_DIR/main/binary-arm64/Packages" | awk '{print $1}')"
AMD64_IDX_GZ_SHA="$(sha256sum "$DIST_DIR/main/binary-amd64/Packages.gz" | awk '{print $1}')"
ARM64_IDX_GZ_SHA="$(sha256sum "$DIST_DIR/main/binary-arm64/Packages.gz" | awk '{print $1}')"
RELEASE_SHA="$(sha256sum "$DIST_DIR/Release" | awk '{print $1}')"
INRELEASE_SHA="$(sha256sum "$DIST_DIR/InRelease" | awk '{print $1}')"
RELEASE_GPG_SHA="$(sha256sum "$DIST_DIR/Release.gpg" | awk '{print $1}')"
KEYRING_SHA="$(sha256sum "$WORK_DIR/switchboard-archive-keyring.gpg" | awk '{print $1}')"
KEYRING_ASC_SHA="$(sha256sum "$WORK_DIR/switchboard-archive-keyring.asc" | awk '{print $1}')"
TOOL_VERSIONS="dpkg-deb=$(dpkg-deb --version 2>&1 | head -1),dpkg-scanpackages=$(dpkg-scanpackages --version 2>&1 | head -1),apt-ftparchive=$(apt-ftparchive --version 2>&1 | head -1),gpg=$(gpg --version 2>&1 | head -1)"

node - <<NODE "$WORK_DIR/release-manifest.json" "$VERSION" "$SOURCE_REVISION" "$SUITE" "$COMPONENT" "$SIGNING_FINGERPRINT" "$RELEASE_DATE" "$VALID_UNTIL" "$VALID_UNTIL_DAYS" "$AMD64_SHA" "$ARM64_SHA" "$AMD64_IDX_SHA" "$ARM64_IDX_SHA" "$AMD64_IDX_GZ_SHA" "$ARM64_IDX_GZ_SHA" "$RELEASE_SHA" "$INRELEASE_SHA" "$RELEASE_GPG_SHA" "$KEYRING_SHA" "$KEYRING_ASC_SHA" "$TOOL_VERSIONS" "$PAGES_ORIGIN" "$ACQUIRE_BY_HASH"
const fs = require('fs');
const file = process.argv[2];
const m = {
  schemaVersion: 1,
  applicationVersion: process.argv[3],
  sourceRevision: process.argv[4],
  suite: process.argv[5],
  component: process.argv[6],
  architectures: ['amd64', 'arm64'],
  signingFingerprint: process.argv[7],
  date: process.argv[8],
  validUntil: process.argv[9],
  validUntilDays: Number(process.argv[10]),
  pagesOrigin: process.argv[11] || null,
  acquireByHash: process.argv[12] === 'yes',
  packages: {
    amd64: { sha256: process.argv[13] },
    arm64: { sha256: process.argv[14] },
  },
  indexes: {
    'binary-amd64/Packages': { sha256: process.argv[15] },
    'binary-arm64/Packages': { sha256: process.argv[16] },
    'binary-amd64/Packages.gz': { sha256: process.argv[17] },
    'binary-arm64/Packages.gz': { sha256: process.argv[18] },
  },
  release: { sha256: process.argv[19] },
  inRelease: { sha256: process.argv[20] },
  releaseGpg: { sha256: process.argv[21] },
  keyringGpg: { sha256: process.argv[22] },
  keyringAsc: { sha256: process.argv[23] },
  toolVersions: process.argv[24],
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
NODE

# ── Final guard: no private key in the output tree ────────────────────────
# Scan the generated tree for any file that looks like a GPG private key
# export. This is a defense-in-depth check; the signing step never writes the
# private key to disk, but a regression here is catastrophic if it ships.
PRIVATE_KEY_HITS="$(find "$WORK_DIR" -type f \( -name '*.gpg' -o -name '*.asc' \) -exec grep -l 'PRIVATE KEY' {} \; 2>/dev/null || true)"
if [[ -n "$PRIVATE_KEY_HITS" ]]; then
  echo "ERROR: a file containing 'PRIVATE KEY' was found in the generated tree:" >&2
  echo "$PRIVATE_KEY_HITS" >&2
  exit 1
fi

# ── Move the validated tree to the output directory ───────────────────────
# Only after every validation has passed do we materialize the output. A
# failure above leaves the prior repository tree untouched.
mkdir -p "$OUT_DIR"
# If OUT_DIR already has content, refuse to clobber unless the manifest hashes
# match exactly (idempotent retry).
if [[ -n "$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
  if [[ -f "$OUT_DIR/release-manifest.json" ]]; then
    existing_sha="$(node -p "require('$OUT_DIR/release-manifest.json').inRelease?.sha256 || ''" 2>/dev/null || echo '')"
    if [[ "$existing_sha" == "$INRELEASE_SHA" ]]; then
      echo "Repository at $OUT_DIR already has this exact release (idempotent retry). Nothing to do."
      exit 0
    fi
  fi
  echo "ERROR: $OUT_DIR is not empty and does not match this release. Refusing to overwrite." >&2
  echo "       Publish changed bytes only under a higher package version, or remove the stale output." >&2
  exit 1
fi
# Copy the validated tree into OUT_DIR.
cp -a "$WORK_DIR/." "$OUT_DIR/"

echo ""
echo "Repository built at: $OUT_DIR"
echo "Suite: $SUITE  Component: $COMPONENT  Architectures: amd64 arm64"
echo "Signing fingerprint: $SIGNING_FINGERPRINT"
echo "Valid-Until: $VALID_UNTIL (${VALID_UNTIL_DAYS} days)"
echo "Manifest: $OUT_DIR/release-manifest.json"
echo "Public key (keyring): $OUT_DIR/switchboard-archive-keyring.gpg"
echo "Public key (armored): $OUT_DIR/switchboard-archive-keyring.asc"
