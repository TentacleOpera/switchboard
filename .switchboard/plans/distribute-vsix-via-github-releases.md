# Distribute the Switchboard VSIX via GitHub Releases (not committed to the repo)

## Goal

Let people on GitHub grab the latest installable Switchboard extension (`.vsix`) with a stable, predictable download link — **without** committing the binary into the git repo.

### Problem / background

The user wants a one-click way for GitHub visitors to download the packaged extension. The obvious move — committing `switchboard-<version>.vsix` into the repo — was rejected for a concrete reason:

- The VSIX is **~20 MB** (`switchboard-1.7.5.vsix` is 23.2 MB on disk today).
- Git history is **immutable and append-only**. Committing a new 20 MB VSIX on every release adds a fresh ~20 MB blob to history **forever**, even if only one file is ever present in the working tree. "Keep only one in the repo" does not bound history growth — every clone re-downloads the entire accumulated blob history. Undoing it later requires a history rewrite (`git filter-repo` / BFG), which breaks every existing clone and the published commit SHAs.
- Currently `*.vsix` is gitignored (`.gitignore:11`) and `dist/` is gitignored (`.gitignore:8`); **no `.vsix` is tracked** today. This plan preserves that.

### Root cause of the "how do I share it" question

There is no distribution channel wired up. The repo has **zero git tags** (`git tag` returns nothing) and **zero GitHub Releases**. The only artifacts are three local, ignored VSIX builds on the user's machine. Nothing on the remote is downloadable by a third party.

GitHub Releases is the purpose-built solution: release **assets** are stored in GitHub's release storage, **separate from git object history**, so a 20 MB asset adds **0 bytes** to the repo clone. Releases also provide the two stable URL patterns the user wants:

- Newest release landing page: `https://github.com/TentacleOpera/switchboard/releases/latest`
- Direct versioned asset: `https://github.com/TentacleOpera/switchboard/releases/download/v<version>/switchboard-<version>.vsix`

### Decisions (locked — no open questions)

1. **Channel:** GitHub Releases. `*.vsix` stays gitignored; a new `releases/` directory is added to `.gitignore` so prebuilt `.vsix` files placed there are never committed. The binary is never committed to the repo.
2. **Tag scheme:** `v<artifact version>` (e.g. `v1.7.5`, `v1.7.6`), where the artifact version is parsed from the `switchboard-<version>.vsix` filename in `releases/`. One tag per shipped version.
3. **Asset name:** the native `vsce` output name `switchboard-<version>.vsix` — keeps the versioned direct link meaningful. The `/releases/latest` link is the stable "always newest" entry point for the README.
4. **Release workflow:** no seed release is cut now. The maintainer places the desired `.vsix` in `releases/` and runs `npm run release`. The script picks the highest-versioned `switchboard-*.vsix` in `releases/` by default, or honors the `VERSION` env var to target a specific file.
5. **Scope boundary:** this plan does **not** touch VS Code Marketplace publishing (publisher `TurnZero`). GitHub Releases is an additional sideload/download channel, not a replacement for however the extension is currently published.

## Metadata

- **Tags:** devops, docs
- **Complexity:** 4

## User Review Required

- **None.** Every product decision is locked in the *Decisions* block above (channel, tag scheme, asset name, release workflow, scope boundary). The one live wrinkle is which `.vsix` the maintainer places in `releases/` — the script picks the highest-versioned file by default, and the `VERSION` env var can override. The user can stage or remove files from `releases/` to control what is published, not a decision to escalate.

## Complexity Audit

### Routine
- Writing a ~40-line bash wrapper around `gh` plus `find`/`sort`/`sed` that picks the highest `switchboard-*.vsix` from `releases/`.
- Adding one npm script alias to `package.json` alongside the existing `catalog:*` / `parity:*` helpers.
- Adding an **Install** section to `README.md`.
- Adding `releases/` to `.gitignore` so the staging directory stays untracked.

### Complex / Risky
- **External, publicly-visible side effect.** `gh release create` publishes a real GitHub Release under `TentacleOpera/switchboard`. It is not a pure-local change; a botched tag/asset is visible to anyone and must be undone with `gh release delete` / `git push --delete origin <tag>`. This is the single moderate risk that lifts the score off "trivial."

## Edge-Case & Dependency Audit

### Race Conditions
- None meaningful. The script is a one-shot, single-maintainer CLI invocation. There is no concurrent writer to the release namespace. The `gh release view` existence check is TOCTOU-racy only against another maintainer releasing the identical tag at the same second — not a real scenario for a solo repo, and `gh release create` would fail server-side on a duplicate tag anyway.

### Security
- No secrets are introduced. Auth is delegated to the already-configured `gh` keyring token (confirmed logged in as `TentacleOpera`). The script never echoes the token.
- The published asset is a build artifact only; `.vscodeignore` (already present) governs what enters the VSIX, so `.switchboard/` runtime state and secrets are not packaged. (Distribution is downstream of packaging — this plan does not change what goes *into* the VSIX.)

### Side Effects
- Creates a git tag on the remote (`v<version>`) and a published GitHub Release with one attached asset.
- Reads the prebuilt `.vsix` from the `releases/` directory. It does not rebuild or touch `dist/`; the maintainer is responsible for placing the correct artifact in `releases/`. Files in `releases/` remain gitignored.

### Dependencies & Conflicts
- **`gh` CLI** — installed (v2.95.0) and authenticated. Hard prerequisite.
- **Standard Unix utilities** — `find`, `sort -V`, `sed`, `basename` are used by the script. The release is built and staged separately by the maintainer.
- **Coordination with `release-version-bump-1.7.6-propagate-skill-changes.md`** — that plan bumps the version to 1.7.6; the `releases/` folder may contain a `switchboard-1.7.6.vsix` ready for `npm run release` when the maintainer is ready. No hard blocking dependency.

## Dependencies

- None — no cross-session (`sess_…`) dependencies. (Related, non-blocking: the 1.7.6 version-bump plan noted above.)

## Adversarial Synthesis

**Risk Summary.** The design is sound and low-risk: release assets live outside git object history, so the "no repo bloat" goal is genuinely met (0 bytes added to clones). The source-dirty guard has been removed: the script now publishes whatever `.vsix` the maintainer stages in `releases/`, so the maintainer (not the script) is responsible for provenance. The main new failure mode is the wrong file being in `releases/` — `sort -V | tail` will always pick the highest-versioned filename, so an accidental newer file can cause an unintended release. Mitigation: the `VERSION` env var can target a specific file; the `gh release view` guard prevents re-releasing an existing tag. The `releases/` directory is ignored, so its contents can never be committed by mistake.

## Proposed Changes

### `scripts/publish-release.sh` — **new**

**Context.** There is no package-to-VSIX or release script today (the existing `package` script is webpack-only). This is the reusable one-command release path so future releases can't drift. It reads the desired version from the `switchboard-<version>.vsix` filename in `releases/` and creates the tagged GitHub Release with the artifact attached.

**Logic.** `highest-versioned .vsix in releases/ → tag (v$version) → asset name (switchboard-$version.vsix)`, guarded by: (0) `gh` authenticated, (1) `releases/` directory exists, (2) tag not already released. Then create the release with auto-generated notes.

**Implementation.**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Publish a GitHub Release for the prebuilt .vsix in the releases/ directory.
# The highest-versioned switchboard-*.vsix file is released automatically.
# To target a specific version, set VERSION, e.g. VERSION=1.7.6 npm run release.

RELEASES_DIR="releases"

# Run from the repo root so paths are predictable regardless of where the script is invoked.
cd "$(dirname "$0")/.."

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
```

Make it executable: `chmod +x scripts/publish-release.sh`.

**Edge Cases.**
- The script no longer builds the VSIX. The maintainer must build and place the desired `.vsix` in `releases/` before running `npm run release`. This removes the source-dirty guard and the `vsce` dependency.
- `sort -V` on the filename picks the highest version. If several `.vsix` files exist, the newest one is chosen; use `VERSION=...` to override.
- The bash script is invoked explicitly as `bash scripts/…` by the npm alias, so it works regardless of the exec bit; it is a macOS/Linux single-maintainer tool (not intended to run on Windows shells). This mirrors intent, not a defect.

### `package.json` — add `release` npm-script alias

**Context / Logic.** Make the script discoverable next to the existing `catalog:*` / `parity:*` / `push-routing:*` helpers.

**Implementation.** Add to `scripts`:

```json
"release": "bash scripts/publish-release.sh"
```

**Edge Cases.** No new dependencies added; the alias just shells out. The script does not build the VSIX, so the maintainer must stage it in `releases/` first. Alphabetical placement not required (existing scripts are grouped by concern).

### `README.md` — add an **Install** section

**Context.** README (22 KB) has an install step under `Getting Started` that only mentions the Marketplace. Add a top-level `## Install` section pointing at the stable GitHub Releases links, and update the `Getting Started` install step to mention sideloading from GitHub Releases.

**Implementation.**

```markdown
## Install

Download the latest packaged extension from the **[Releases page](https://github.com/TentacleOpera/switchboard/releases/latest)**, then install it:

- **VS Code UI:** Extensions panel → `…` menu → **Install from VSIX…** → pick the downloaded `.vsix`.
- **CLI:** `code --install-extension switchboard-<version>.vsix`

Direct link for the current build:
`https://github.com/TentacleOpera/switchboard/releases/download/v1.7.6/switchboard-1.7.6.vsix`
```

Also update `### 1. Install` under `## Getting Started` to:

```markdown
### 1. Install
Install **Switchboard** from the VS Code Marketplace, or sideload the latest `.vsix` from the [Releases page](https://github.com/TentacleOpera/switchboard/releases/latest).
```

**Edge Cases.** Keep `/releases/latest` as the primary reference so the README never needs editing per release. The hard-coded versioned direct link goes stale on each bump — treat it as optional/bonus, or update it only when a fixed pointer is wanted. For a monotonic version sequence released in order, `/releases/latest` always resolves to the newest tag, so the primary link stays correct with no maintenance.

### `.gitignore` — add `releases/`

**Context.** `*.vsix` (`.gitignore:11`) already ignores all local `.vsix` builds, but the new `releases/` staging directory should also be ignored so the maintainer can keep multiple prebuilt artifacts there without committing them.

**Implementation.** Add below the `# Packaged extensions` block:

```gitignore
# Release staging folder (prebuilt .vsix artifacts; ignored to keep release assets out of git history)
releases/
```

**Edge Cases.** The `releases/` directory itself is not tracked; only its contents are ignored. The maintainer can drop any `.vsix` there and run `npm run release` without touching the git index.

### First release — operational action (not a file edit)

No release is being cut now. When the maintainer is ready to publish, place the desired `.vsix` in `releases/` and run:

```bash
npm run release
```

The script will pick the highest-versioned `switchboard-*.vsix` in `releases/` and create the GitHub Release. To target a specific file instead of the highest, set `VERSION`:

```bash
VERSION=1.7.6 npm run release
```

**Provenance note.** Because the script no longer packages from source, the `.vsix` in `releases/` is exactly what gets published. The maintainer is responsible for ensuring it matches the desired source state (e.g., by running `npm run package` and `npx @vscode/vsce package` before copying the artifact into `releases/`).

## Verification Plan

### Automated Tests
- **None applicable.** This is release tooling + docs with no runtime code surface; there is nothing unit/integration-testable, and the session directive skips compilation and tests. Verification is the manual checklist below.

### Manual Verification
1. **Script syntax & JSON:** `bash -n scripts/publish-release.sh` passes and `package.json` parses as valid JSON.
2. **Release selection logic:** Place two dummy files (`releases/switchboard-1.7.5.vsix` and `releases/switchboard-1.7.6.vsix`) and run the script with a fake `gh` in PATH. Confirm it selects `v1.7.6` and invokes `gh release create` with the correct path and `--title`.
3. **No repo bloat:** `git ls-files '*.vsix'` still returns empty; `git status --porcelain -- releases/` returns nothing; the `releases/` directory and its contents are ignored.
4. **Script guards behave:**
   - Running `npm run release` with an empty `releases/` directory exits with "no switchboard-*.vsix found in releases".
   - Running `npm run release` with a `VERSION` that already has a release exits with "release already exists".
5. **Actual release (when ready):** After publishing, `gh release view v1.7.6` lists `switchboard-1.7.6.vsix` under assets, `https://github.com/TentacleOpera/switchboard/releases/latest` redirects to the newest release, and `code --install-extension` on the downloaded `.vsix` succeeds.

## Out of scope

- VS Code Marketplace publishing (`vsce publish`) — unchanged; separate channel.
- Automating releases in CI (e.g. a GitHub Action on tag push) — the manual `npm run release` is sufficient for a single-maintainer repo; a CI workflow can be added later if release cadence grows.
- Rewriting git history to purge any previously committed binaries — none exist (no `.vsix` has ever been tracked), so there is nothing to purge.

## Uncertain Assumptions

Both open questions were confirmed by web research (docs.github.com / cli.github.com). Neither blocks implementation:

1. **`gh release create --generate-notes` with no prior tag — CONFIRMED SAFE.** GitHub calls `POST /repos/{owner}/{repo}/releases/generate-notes`; `previous_tag_name` is optional. With no previous tag it falls back to the **repository history root** and compiles notes from all commits/PRs — it does **not** error. (The `--fail-on-no-commits` flag is explicitly documented as having no effect on a first/only release.) This is the default path for the first release cut via the script.
2. **`/releases/latest` selection — CONFIRMED SAFE for the planned flow.** A standard `gh release create` (no `--draft`, no `--prerelease`) publishes with `make_latest` defaulting to **`"true"`**, so the most recently published stable release claims the "Latest" badge and the `/releases/latest` redirect. In the plan's monotonic, in-order flow (v1.7.5 → v1.7.6 → …), the newest release is always latest. **Coder note / edge case:** GitHub's automatic `/releases/latest` also sorts by `created_at`, which is the **commit date** of the tagged commit — not the publish date. This only matters if you ever backfill an *older* version as a stable release *after* a newer one (it might not auto-claim "latest"); pass `--latest` explicitly in that rare case. Not a concern for normal forward releases.

---

**Recommendation: Send to Coder** (complexity 4). Mechanically straightforward, but it publishes a public, externally-visible GitHub Release on the first real run — a coder should confirm the guards behave and the correct `.vsix` is staged in `releases/` before pointing it at the live repo.

## Completion Summary

Implemented a `releases/` staging directory (ignored in `.gitignore`) and a `scripts/publish-release.sh` script that reads the highest-versioned `switchboard-*.vsix` from `releases/` (or the `VERSION` env var) and calls `gh release create` with the asset. Added the `release` npm alias in `package.json`, added a top-level `## Install` section to `README.md` pointing to `/releases/latest` and a `v1.7.6` direct link, and updated the `Getting Started` install step to mention GitHub Releases. The actual seed `v1.7.5` release was skipped because the user is not ready to publish; the script is ready to run once a `.vsix` is placed in `releases/`. Verification: `bash -n`, `package.json` JSON parse, and a fake `gh` run all passed, confirming the script selects the latest file and invokes `gh release create` correctly.
