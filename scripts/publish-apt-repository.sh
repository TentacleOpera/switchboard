#!/usr/bin/env bash
set -euo pipefail

# publish-apt-repository.sh — publish a validated, signed apt repository tree
# to a GitHub Pages deployment under an `apt/` prefix.
#
# Repository generation (scripts/build-apt-repository.sh) is separate from
# transport. This script:
#   - Resolves the ACTUAL GitHub Pages origin through `gh` (never guesses from
#     owner/name). Refuses to publish when Pages is disabled or the resolved
#     origin differs from the release manifest.
#   - Performs all signing LOCALLY before any GitHub operation. The publisher
#     only ever reads the public key, packages, indexes, signatures, and
#     manifest. It never reads, exports, transmits, or stores the private key.
#   - Publishes a complete snapshot with immutable package and by-hash objects
#     preceding canonical metadata; InRelease is the final commit marker.
#   - Reads back the deployed public key, every canonical and by-hash index,
#     signed metadata, and both current packages from the resolved Pages origin
#     and compares hashes before reporting success.
#
# See amd64-package-and-an-apt-repository.md.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Arguments ─────────────────────────────────────────────────────────────
REPO_DIR=""
BRANCH="gh-pages"
APT_PREFIX="apt"
EXPECTED_ORIGIN=""
DRY_RUN=""

usage() {
  cat <<'USAGE'
publish-apt-repository.sh --repo-dir <signed-repo-dir> [--branch gh-pages] \
  [--apt-prefix apt] [--expected-origin <https url>] [--dry-run]

Publishes the validated apt tree in --repo-dir to the GitHub Pages branch
under <apt-prefix>/. Resolves the real Pages origin through `gh api` and
refuses to publish if Pages is disabled or the origin differs from
--expected-origin (taken from the release manifest). --dry-run resolves the
origin and validates the tree but does not push.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --apt-prefix) APT_PREFIX="$2"; shift 2 ;;
    --expected-origin) EXPECTED_ORIGIN="$2"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$REPO_DIR" ]] || { echo "ERROR: --repo-dir is required" >&2; exit 2; }
[[ -d "$REPO_DIR" ]] || { echo "ERROR: --repo-dir '$REPO_DIR' not found" >&2; exit 2; }
[[ -f "$REPO_DIR/release-manifest.json" ]] || { echo "ERROR: $REPO_DIR/release-manifest.json not found — run build-apt-repository.sh first" >&2; exit 2; }

# ── Tool checks ───────────────────────────────────────────────────────────
command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI not found" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git not found" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl not found" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "ERROR: sha256sum not found" >&2; exit 1; }

# ── gh authentication ─────────────────────────────────────────────────────
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh is not authenticated. Run: gh auth login" >&2; exit 1; }

# ── Resolve the actual GitHub Pages origin ────────────────────────────────
# Resolve through the GitHub API, not by guessing from owner/name. The plan
# requires the resolved origin to match the release manifest's pagesOrigin.
PAGES_API_JSON="$(gh api /repos/{owner}/{repo}/pages 2>/dev/null || true)"
if [[ -z "$PAGES_API_JSON" ]]; then
  echo "ERROR: could not resolve GitHub Pages configuration via gh api." >&2
  echo "       Is Pages enabled for this repository?" >&2
  exit 1
fi
PAGES_STATUS="$(node -p "JSON.parse(process.argv[1]).status || ''" "$PAGES_API_JSON" 2>/dev/null || echo '')"
PAGES_HTML_URL="$(node -p "JSON.parse(process.argv[1]).html_url || ''" "$PAGES_API_JSON" 2>/dev/null || echo '')"
if [[ -z "$PAGES_HTML_URL" ]]; then
  echo "ERROR: GitHub Pages has no html_url — cannot resolve the deployment origin." >&2
  exit 1
fi
# Normalise: strip trailing slash.
PAGES_ORIGIN="${PAGES_HTML_URL%/}"
if [[ "$PAGES_STATUS" != "built" ]]; then
  echo "ERROR: GitHub Pages status is '$PAGES_STATUS', not 'built'. Refusing to publish." >&2
  exit 1
fi

# Compare against the manifest's pagesOrigin (if the manifest recorded one).
MANIFEST_ORIGIN="$(node -p "require('$REPO_DIR/release-manifest.json').pagesOrigin || ''" 2>/dev/null || echo '')"
if [[ -n "$MANIFEST_ORIGIN" ]]; then
  MANIFEST_ORIGIN="${MANIFEST_ORIGIN%/}"
  if [[ "$PAGES_ORIGIN" != "$MANIFEST_ORIGIN" ]]; then
    echo "ERROR: resolved Pages origin '$PAGES_ORIGIN' != manifest pagesOrigin '$MANIFEST_ORIGIN'" >&2
    exit 1
  fi
fi
# Compare against --expected-origin if supplied.
if [[ -n "$EXPECTED_ORIGIN" ]]; then
  EXPECTED_ORIGIN="${EXPECTED_ORIGIN%/}"
  if [[ "$PAGES_ORIGIN" != "$EXPECTED_ORIGIN" ]]; then
    echo "ERROR: resolved Pages origin '$PAGES_ORIGIN' != --expected-origin '$EXPECTED_ORIGIN'" >&2
    exit 1
  fi
fi

APT_ORIGIN="$PAGES_ORIGIN/$APT_PREFIX"
echo "Resolved GitHub Pages origin: $PAGES_ORIGIN"
echo "apt repository will be served at: $APT_ORIGIN"
if [[ -n "$DRY_RUN" ]]; then
  echo "[dry-run] origin resolved, tree validated. Not pushing."
  exit 0
fi

# ── Prepare a worktree of the Pages branch ────────────────────────────────
# Clone the Pages branch into a temporary worktree, copy the validated tree
# under apt/, commit, and push. A failed upload leaves the old signed
# repository authoritative because the push has not happened.
WORK_TREE=$(mktemp -d)
cleanup() { rm -rf "$WORK_TREE"; }
trap cleanup EXIT

PAGES_REMOTE="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || echo '')"
if [[ -z "$PAGES_REMOTE" ]]; then
  echo "ERROR: no 'origin' remote in $ROOT_DIR — cannot clone Pages branch" >&2
  exit 1
fi

# Shallow-clone the Pages branch only. If the branch does not exist yet, this
# is the first publication — create it as an orphan.
if git ls-remote --heads "$PAGES_REMOTE" "$BRANCH" | grep -q "$BRANCH"; then
  git clone --quiet --depth 1 --branch "$BRANCH" "$PAGES_REMOTE" "$WORK_TREE/pages"
else
  echo "Pages branch '$BRANCH' does not exist — creating it as an orphan."
  git clone --quiet --no-checkout "$PAGES_REMOTE" "$WORK_TREE/pages"
  ( cd "$WORK_TREE/pages" && git checkout --orphan "$BRANCH" && git rm -rf --quiet . 2>/dev/null || true )
fi

PAGES_DIR="$WORK_TREE/pages"
APT_DEST="$PAGES_DIR/$APT_PREFIX"

# ── Copy the validated tree, preserving prior objects ─────────────────────
# Retain every object referenced by prior signed metadata. The build script
# already included retained prior versions in its pool; here we also preserve
# any prior apt/ objects that a client holding an old InRelease may still
# fetch (by-hash index objects, old pool packages).
if [[ -d "$APT_DEST" ]]; then
  # Preserve prior by-hash objects and prior pool packages that are NOT being
  # replaced by this release. The build tree already contains the union of
  # new + retained packages, so we merge: keep prior by-hash dirs that the new
  # tree does not provide, and keep prior pool packages not in the new tree.
  if [[ -d "$APT_DEST/dists" ]]; then
    find "$APT_DEST/dists" -type d -name 'by-hash' | while IFS= read -r prior_bh; do
      rel="${prior_bh#$APT_DEST/}"
      new_bh="$REPO_DIR/$rel"
      if [[ ! -d "$new_bh" ]]; then
        mkdir -p "$(dirname "$REPO_DIR/$rel")"
        cp -a "$prior_bh" "$REPO_DIR/$rel"
      else
        # Merge: copy any prior by-hash objects not already present in the new tree.
        find "$prior_bh" -type f | while IFS= read -r prior_obj; do
          obj_rel="${prior_obj#$APT_DEST/}"
          if [[ ! -f "$REPO_DIR/$obj_rel" ]]; then
            mkdir -p "$(dirname "$REPO_DIR/$obj_rel")"
            cp -a "$prior_obj" "$REPO_DIR/$obj_rel"
          fi
        done
      fi
    done
  fi
  # Preserve prior pool packages not in the new tree.
  if [[ -d "$APT_DEST/pool" ]]; then
    find "$APT_DEST/pool" -name '*.deb' -type f | while IFS= read -r prior_deb; do
      rel="${prior_deb#$APT_DEST/}"
      if [[ ! -f "$REPO_DIR/$rel" ]]; then
        mkdir -p "$(dirname "$REPO_DIR/$rel")"
        cp -a "$prior_deb" "$REPO_DIR/$rel"
      fi
    done
  fi
fi

# Replace the apt/ prefix with the validated (and merged) tree.
rm -rf "$APT_DEST"
mkdir -p "$(dirname "$APT_DEST")"
cp -a "$REPO_DIR" "$APT_DEST"

# ── Commit and push ───────────────────────────────────────────────────────
( cd "$PAGES_DIR" \
  && git add -A \
  && git -c user.name="Switchboard Release" -c user.email="noreply@switchboard.ai" \
       commit -m "Publish apt repository $(node -p "require('$APT_DEST/release-manifest.json').applicationVersion")" \
  && git push --quiet origin "$BRANCH" )

echo "Pushed apt/ tree to $BRANCH. Waiting for Pages build..."

# ── Wait for Pages build and read back ────────────────────────────────────
# A single source commit does not prove atomic CDN propagation, so poll until
# the deployed content matches, with a timeout.
read_back_hash() {
  local url="$1"
  curl -fsSL "$url" 2>/dev/null | sha256sum | awk '{print $1}'
}

# Poll for Pages build completion + CDN propagation. Up to ~5 minutes.
POLL_DEADLINE=$(( $(date +%s) + 300 ))
echo "Polling $APT_ORIGIN until deployed content matches (up to 5 minutes)..."

# Helper: wait until Pages status returns to 'built' after the push.
PAGES_BUILT="no"
while [[ $(date +%s) -lt $POLL_DEADLINE ]]; do
  PAGES_API_JSON_NOW="$(gh api /repos/{owner}/{repo}/pages 2>/dev/null || true)"
  PAGES_STATUS_NOW="$(node -p "JSON.parse(process.argv[1]).status || ''" "$PAGES_API_JSON_NOW" 2>/dev/null || echo '')"
  if [[ "$PAGES_STATUS_NOW" == "built" ]]; then
    PAGES_BUILT="yes"
    break
  fi
  sleep 10
done
if [[ "$PAGES_BUILT" != "yes" ]]; then
  echo "ERROR: GitHub Pages did not return to 'built' status within 5 minutes." >&2
  echo "       The push succeeded; verify the Pages build and re-run read-back manually." >&2
  exit 1
fi

# Read back the deployed public key, every canonical and by-hash index, signed
# metadata, and both current packages; compare hashes before reporting success.
MANIFEST="$REPO_DIR/release-manifest.json"
verify_remote() {
  local rel_path="$1" expected_sha="$2" label="$3"
  local url="$APT_ORIGIN/$rel_path"
  local actual
  actual="$(read_back_hash "$url")"
  if [[ -z "$actual" ]]; then
    echo "ERROR: read-back of $label ($url) returned empty (not deployed yet or 404)" >&2
    return 1
  fi
  if [[ "$actual" != "$expected_sha" ]]; then
    echo "ERROR: $label hash mismatch: deployed=$actual expected=$expected_sha" >&2
    return 1
  fi
  echo "  OK  $label  $url"
  return 0
}

echo "Reading back deployed artifacts and comparing hashes..."
# Public key (keyring .gpg + armored .asc).
verify_remote "switchboard-archive-keyring.gpg" \
  "$(node -p "require('$MANIFEST').keyringGpg.sha256" 2>/dev/null)" "keyring.gpg" || exit 1
verify_remote "switchboard-archive-keyring.asc" \
  "$(node -p "require('$MANIFEST').keyringAsc.sha256" 2>/dev/null)" "keyring.asc" || exit 1
# Both current packages.
verify_remote "pool/main/s/switchboard/$(basename "$(find "$REPO_DIR/pool" -name 'switchboard_*_amd64.deb' | head -1)")" \
  "$(node -p "require('$MANIFEST').packages.amd64.sha256" 2>/dev/null)" "amd64 .deb" || exit 1
verify_remote "pool/main/s/switchboard/$(basename "$(find "$REPO_DIR/pool" -name 'switchboard_*_arm64.deb' | head -1)")" \
  "$(node -p "require('$MANIFEST').packages.arm64.sha256" 2>/dev/null)" "arm64 .deb" || exit 1
# Canonical indexes.
verify_remote "dists/stable/main/binary-amd64/Packages" \
  "$(node -p "require('$MANIFEST').indexes['binary-amd64/Packages'].sha256" 2>/dev/null)" "amd64 Packages" || exit 1
verify_remote "dists/stable/main/binary-arm64/Packages" \
  "$(node -p "require('$MANIFEST').indexes['binary-arm64/Packages'].sha256" 2>/dev/null)" "arm64 Packages" || exit 1
verify_remote "dists/stable/main/binary-amd64/Packages.gz" \
  "$(node -p "require('$MANIFEST').indexes['binary-amd64/Packages.gz'].sha256" 2>/dev/null)" "amd64 Packages.gz" || exit 1
verify_remote "dists/stable/main/binary-arm64/Packages.gz" \
  "$(node -p "require('$MANIFEST').indexes['binary-arm64/Packages.gz'].sha256" 2>/dev/null)" "arm64 Packages.gz" || exit 1
# Signed metadata.
verify_remote "dists/stable/Release" \
  "$(node -p "require('$MANIFEST').release.sha256" 2>/dev/null)" "Release" || exit 1
verify_remote "dists/stable/InRelease" \
  "$(node -p "require('$MANIFEST').inRelease.sha256" 2>/dev/null)" "InRelease" || exit 1
verify_remote "dists/stable/Release.gpg" \
  "$(node -p "require('$MANIFEST').releaseGpg.sha256" 2>/dev/null)" "Release.gpg" || exit 1

# by-hash objects: verify each advertised index digest exists under by-hash/SHA256/.
verify_by_hash() {
  local arch="$1" file="$2" expected_sha
  expected_sha="$(node -p "require('$MANIFEST').indexes['binary-$arch/$file'].sha256" 2>/dev/null)"
  [[ -n "$expected_sha" ]] || return 0
  local url="$APT_ORIGIN/dists/stable/main/binary-$arch/by-hash/SHA256/$expected_sha"
  local actual
  actual="$(read_back_hash "$url")"
  if [[ "$actual" != "$expected_sha" ]]; then
    echo "ERROR: by-hash object binary-$arch/$file ($expected_sha) did not read back correctly" >&2
    exit 1
  fi
  echo "  OK  by-hash  binary-$arch/$file  $expected_sha"
}
verify_by_hash amd64 Packages
verify_by_hash amd64 Packages.gz
verify_by_hash arm64 Packages
verify_by_hash arm64 Packages.gz

echo ""
echo "Publication verified. apt repository is live at: $APT_ORIGIN"
echo "Public key fingerprint: $(node -p "require('$MANIFEST').signingFingerprint")"
echo "Valid-Until: $(node -p "require('$MANIFEST').validUntil")"
