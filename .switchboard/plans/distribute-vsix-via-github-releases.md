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

1. **Channel:** GitHub Releases. `*.vsix` stays gitignored; `.gitignore` is **not** modified. The binary is never committed.
2. **Tag scheme:** `v<package.json version>` (e.g. `v1.7.5`, `v1.7.6`). One tag per shipped version.
3. **Asset name:** the native `vsce` output name `switchboard-<version>.vsix` — keeps the versioned direct link meaningful. The `/releases/latest` link is the stable "always newest" entry point for the README.
4. **Seed release:** cut the **first** release from the VSIX that already exists on disk today — `switchboard-1.7.5.vsix`, tagged `v1.7.5` — so the channel is live immediately. Version `1.7.6` and beyond go out through the reusable script below (this dovetails with `release-version-bump-1.7.6-propagate-skill-changes.md`).
5. **Scope boundary:** this plan does **not** touch VS Code Marketplace publishing (publisher `TurnZero`). GitHub Releases is an additional sideload/download channel, not a replacement for however the extension is currently published.

## Metadata

- **Tags:** devops, docs
- **Complexity:** 4

## User Review Required

- **None.** Every product decision is locked in the *Decisions* block above (channel, tag scheme, asset name, seed source, scope boundary). The one live wrinkle — the on-disk `switchboard-1.7.5.vsix` may predate current uncommitted source — is handled as an edge case below (repackage path already offered), not a decision to escalate.

## Complexity Audit

### Routine
- Writing a ~35-line bash wrapper around `gh` + `vsce` using the standard release recipe.
- Adding one npm script alias to `package.json` alongside the existing `catalog:*` / `parity:*` helpers.
- Adding an **Install** section to `README.md`.
- Confirming `.gitignore` is unchanged (a read-only check, not an edit).

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
- Runs `vsce package`, which triggers `vscode:prepublish` → `npm run package` (webpack production build), overwriting `dist/extension.js` and (re)producing `switchboard-<version>.vsix` in the repo root. Both remain gitignored; neither gets staged.

### Dependencies & Conflicts
- **`gh` CLI** — installed (v2.95.0) and authenticated. Hard prerequisite.
- **`@vscode/vsce`** — pulled on demand via `npx --yes`; no repo devDependency added.
- **`node`** — used to read the version from `package.json` (single source of truth).
- **Coordination with `release-version-bump-1.7.6-propagate-skill-changes.md`** — that plan bumps the version to 1.7.6; the *first* release cut via `npm run release` will be v1.7.6. Order is not strict, but cleanest is: seed v1.7.5 now, then let the 1.7.6 bump ride the script. No hard blocking dependency.

## Dependencies

- None — no cross-session (`sess_…`) dependencies. (Related, non-blocking: the 1.7.6 version-bump plan noted above.)

## Adversarial Synthesis

**Risk Summary.** The design is sound and low-risk: release assets live outside git object history, so the "no repo bloat" goal is genuinely met (0 bytes added to clones). The one real defect in the original draft was a **blanket `git status --porcelain` dirty-tree guard** that would false-positive constantly — this repo self-hosts Switchboard, so `.switchboard/` is almost always dirty, making the guard fire on runtime churn that never enters the VSIX. Mitigation: scope the guard to exclude `.switchboard/` (verified working) so it still protects real source. Secondary watch-item: the seed's on-disk VSIX may predate current uncommitted source — accept it as a valid 1.7.5 build, or repackage for clean provenance via the script.

## Proposed Changes

### `scripts/publish-release.sh` — **new**

**Context.** There is no package-to-VSIX or release script today (the existing `package` script is webpack-only). This is the reusable one-command release path so future releases can't drift. It reads the version from `package.json` (single source of truth), packages the VSIX, and creates the tagged GitHub Release with the asset attached.

**Logic.** `version → tag (v$version) → asset name (switchboard-$version.vsix)`, guarded by: (0) gh authenticated, (1) no uncommitted **source** changes, (2) tag not already released. Then package and create the release with auto-generated notes.

**Implementation.**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Publish a GitHub Release for the current package.json version, with the VSIX attached.
# Prereqs: `gh auth status` logged in; working tree committed & pushed; @vscode/vsce available via npx.

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
VSIX="switchboard-${VERSION}.vsix"

# 0. Guard: fail fast if gh is not authenticated (clearer than a mid-run upload failure).
#    Clarification — implied by the existing "gh auth status logged in" prereq comment.
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# 1. Guard: refuse to release uncommitted SOURCE (the VSIX should reflect pushed source).
if [[ -n "$(git status --porcelain -- . ':!.switchboard')" ]]; then
  echo "ERROR: working tree has uncommitted source changes. Commit & push before releasing." >&2
  exit 1
fi

# 2. Guard: don't silently re-release an existing tag.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "ERROR: release $TAG already exists. Bump the version in package.json first," >&2
  echo "       or run: gh release upload $TAG $VSIX --clobber   (to replace just the asset)." >&2
  exit 1
fi

# 3. Package (produces switchboard-<version>.vsix in repo root; stays gitignored).
npx --yes @vscode/vsce package

# 4. Create the release, attach the VSIX, auto-generate notes from commits since the last tag.
gh release create "$TAG" "$VSIX" \
  --title "Switchboard ${VERSION}" \
  --generate-notes

echo "Released $TAG → https://github.com/TentacleOpera/switchboard/releases/tag/$TAG"
```

Make it executable: `chmod +x scripts/publish-release.sh`.

> **Superseded:** Guard 1 was `if [[ -n "$(git status --porcelain)" ]]; then … exit 1` — a *blanket* dirty-tree check over the whole working tree.
> **Reason:** This repo **self-hosts Switchboard**, so `.switchboard/` (plans, features, runtime state) is almost always dirty — and that state never enters the VSIX. A blanket check would make `npm run release` fail with "working tree is dirty" on churn that has nothing to do with the build, turning a safety guard into a near-permanent block. (Confirmed live: `git status --porcelain` shows 32 entries right now; only 3 are `.switchboard/`.)
> **Replaced with:** `git status --porcelain -- . ':!.switchboard'` — checks everything **except** `.switchboard/`, so it still blocks on genuinely dirty source (`src/`, `package.json`, `webpack.config.js`, etc.) while ignoring runtime churn. Pathspec exclusion verified working in this repo.

**Edge Cases.**
- `vsce package` re-runs the webpack production build via `vscode:prepublish`, so the released VSIX is always built from current committed `src/` (satisfies the repo rule that the VSIX — not `dist/` — is the source of truth for testing).
- The bash script is invoked explicitly as `bash scripts/…` by the npm alias, so it works regardless of the exec bit; it is a macOS/Linux single-maintainer tool (not intended to run on Windows shells). This mirrors intent, not a defect.

### `package.json` — add `release` npm-script alias

**Context / Logic.** Make the script discoverable next to the existing `catalog:*` / `parity:*` / `push-routing:*` helpers.

**Implementation.** Add to `scripts`:

```json
"release": "bash scripts/publish-release.sh"
```

**Edge Cases.** No new dependencies added; the alias just shells out. Alphabetical placement not required (existing scripts are grouped by concern).

### `README.md` — add an **Install** section

**Context.** README (22 KB) currently has **no** Install/Releases section (verified). Add one near the top pointing at the stable links.

**Implementation.**

```markdown
## Install

Download the latest packaged extension from the **[Releases page](https://github.com/TentacleOpera/switchboard/releases/latest)**, then install it:

- **VS Code UI:** Extensions panel → `…` menu → **Install from VSIX…** → pick the downloaded `.vsix`.
- **CLI:** `code --install-extension switchboard-<version>.vsix`

Direct link to the current build:
`https://github.com/TentacleOpera/switchboard/releases/download/v1.7.5/switchboard-1.7.5.vsix`
```

**Edge Cases.** Keep `/releases/latest` as the primary reference so the README never needs editing per release. The hard-coded versioned direct link goes stale on each bump — treat it as optional/bonus, or update it only when a fixed pointer is wanted. For a monotonic version sequence released in order, `/releases/latest` always resolves to the newest tag, so the primary link stays correct with no maintenance.

### `.gitignore` — **no change** (verify only)

**Context.** `*.vsix` (`.gitignore:11`) already ignores all local builds so `vsce package` output never gets staged. This is a check, not an edit. Do not modify `.gitignore`.

### Seed release (v1.7.5) — operational action (not a file edit)

`switchboard-1.7.5.vsix` already exists on disk and matches the current `package.json` version, so the seed release does not need a repackage. Create it directly (this raw `gh` command bypasses the script's dirty-tree guard, so it works even while source is mid-edit):

```bash
gh release create v1.7.5 switchboard-1.7.5.vsix \
  --title "Switchboard 1.7.5" \
  --notes "First published VSIX build. Install via the Extensions panel → 'Install from VSIX…', or: code --install-extension switchboard-1.7.5.vsix"
```

**Provenance note.** The on-disk `switchboard-1.7.5.vsix` was built Jul 9 10:06 and may predate current uncommitted source (`src/services/ClaudeCodeMirrorService.ts`, `AGENTS.md`, and staged skill renames are dirty right now). Per locked Decision #4 this is acceptable — it is a valid 1.7.5 build. If byte-for-byte provenance against pushed source is wanted instead, commit & push first, then run `scripts/publish-release.sh` (it repackages from source and yields the same `v1.7.5` tag + asset).

## Verification Plan

### Automated Tests
- **None applicable.** This is release tooling + docs with no runtime code surface; there is nothing unit/integration-testable, and the session directive skips compilation and tests. Verification is the manual checklist below.

### Manual Verification
1. **Release exists & asset attached:** `gh release view v1.7.5` lists `switchboard-1.7.5.vsix` under assets.
2. **Stable links resolve:**
   - `https://github.com/TentacleOpera/switchboard/releases/latest` redirects to the `v1.7.5` release.
   - The direct asset URL downloads a ~23 MB file: `gh release download v1.7.5 -p '*.vsix' -D /tmp/sbrel && ls -la /tmp/sbrel`.
3. **Installable:** `code --install-extension /tmp/sbrel/switchboard-1.7.5.vsix` succeeds, or the Extensions panel "Install from VSIX" accepts it.
4. **No repo bloat:** `git ls-files '*.vsix'` still returns empty; the VSIX is not tracked. `git status` shows the new VSIX as ignored, not untracked.
5. **Script guards behave:**
   - Re-running `npm run release` on the same version exits with the "release already exists" guard instead of erroring mid-upload.
   - With only `.switchboard/` files dirty, the script proceeds past the dirty-tree guard (does **not** false-fail). With a dirty `src/` file, it blocks. (This is the behavior the scoped guard exists to produce.)

## Out of scope

- VS Code Marketplace publishing (`vsce publish`) — unchanged; separate channel.
- Automating releases in CI (e.g. a GitHub Action on tag push) — the manual `npm run release` is sufficient for a single-maintainer repo; a CI workflow can be added later if release cadence grows.
- Rewriting git history to purge any previously committed binaries — none exist (no `.vsix` has ever been tracked), so there is nothing to purge.

## Uncertain Assumptions

Both open questions were confirmed by web research (docs.github.com / cli.github.com). Neither blocks implementation:

1. **`gh release create --generate-notes` with no prior tag — CONFIRMED SAFE.** GitHub calls `POST /repos/{owner}/{repo}/releases/generate-notes`; `previous_tag_name` is optional. With no previous tag it falls back to the **repository history root** and compiles notes from all commits/PRs — it does **not** error. (The `--fail-on-no-commits` flag is explicitly documented as having no effect on a first/only release.) The seed uses manual `--notes` anyway, so this path only occurs if the very first release is cut via the script.
2. **`/releases/latest` selection — CONFIRMED SAFE for the planned flow.** A standard `gh release create` (no `--draft`, no `--prerelease`) publishes with `make_latest` defaulting to **`"true"`**, so the most recently published stable release claims the "Latest" badge and the `/releases/latest` redirect. In the plan's monotonic, in-order flow (v1.7.5 → v1.7.6 → …), the newest release is always latest. **Coder note / edge case:** GitHub's automatic `/releases/latest` also sorts by `created_at`, which is the **commit date** of the tagged commit — not the publish date. This only matters if you ever backfill an *older* version as a stable release *after* a newer one (it might not auto-claim "latest"); pass `--latest` explicitly in that rare case. Not a concern for normal forward releases.

*(The dirty-tree pathspec exclusion `git status --porcelain -- . ':!.switchboard'` was verified live in this repo and was never uncertain.)*

---

**Recommendation: Send to Coder** (complexity 4). Mechanically straightforward, but it publishes a public, externally-visible GitHub Release on first real run — a coder should confirm the guards behave and the seed provenance is acceptable before pointing it at the live repo.
