# Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets

## Goal

Remove `generateClaudeMirror` and its manifest, commit the eight `.claude/skills/<name>/SKILL.md`
files as real source, and deliver them with the same `seedBundleSurface` call that already delivers
`.agents/skills` and `.agents/workflows`. Net effect: ~300 lines of derivation logic deleted, one
runtime-written ledger removed from user repos, and `.claude/` delivery becomes the same mechanism as
every other bundle asset instead of a bespoke second pass.

### Problem Analysis

**The generator produces a two-line diff.** `ClaudeCodeMirrorService.ts` is 476 lines. The entire
transform it applies to `/switchboard` is two lines of YAML frontmatter:

```
name: switchboard
allowed-tools: Bash, Read, Write, Glob, Grep
```

`diff .agents/workflows/switchboard.md .claude/skills/switchboard/SKILL.md` returns exactly those two
insertions. The rest is byte-identical.

**It runs over content that arrived seconds earlier.** `generateClaudeMirror(rootDir, extensionVersion)`
takes no `extensionUri` — it reads the *workspace's* `.agents/`, which `seedBundleSurface` populated
moments before at `extension.ts:344-347`, and writes the workspace's `.claude/`. So activation copies
bundle → workspace, then re-derives workspace → workspace. The frontmatter it computes could simply
have been in the shipped file.

**The surface it was built for no longer exists.** `MIRROR_MANIFEST` has **8 entries** — four
workflows (`switchboard`, `switchboard-cloud`, `switchboard-remote`, `switchboard-memo`) and four
skills (`manage-features`, `query-kanban`, `kanban_operations`, `worktree-cleanup`). A manifest plus
six derivation helpers is the right shape for ~91 discoverable skills; it is not the right shape for
eight. The managed CLAUDE.md block was already cut 14,826 → 611 chars (`843bae45`) and AGENTS.md
14,296 → 616 (`248cf309`). The generator is what did not shrink with them.

**It writes a second ledger into the user's repo.** `.claude/.switchboard-generated.json`
(`GENERATED_MANIFEST_FILE`, `:96`) exists so regeneration only touches generated dirs. It is exactly
the bookkeeping that `the-bundle-ledger-belongs-in-the-database-not-the-users-repo.md` argues does not
belong in a version-controlled tree. Static committed files need no such discriminator: the bundle
ledger `seedBundleSurface` already consults covers them.

**It doubles every content change.** The same launcher body exists at
`.agents/workflows/switchboard.md` (121L) and `.claude/skills/switchboard/SKILL.md` (123L). That
duplication exists on disk today regardless of how the second copy is produced — the generator does
not remove it, it only makes one copy derived and therefore invisible in review. Committing both makes
the duplication explicit and testable.

**And it is wired into one host only.** `src/standalone/` never calls `generateClaudeMirror`,
`seedBundleSurface`, or `pruneRetiredBundleFiles`. `seedBundleSurface`'s own docstring asserts it is
"Shared between the extension host and the standalone host so the deletion guard cannot diverge" —
the code is host-agnostic (it uses `fs`, not `vscode.workspace.fs`), but the standalone composition
root does not invoke it. This is the composition-root divergence `CLAUDE.md` describes: a
verb-reachability audit comes back green while no seam is wired. **Fixing that wiring is a separate,
larger plan** (see Dependencies); this plan must not deepen it.

## Metadata

**Complexity:** 5
**Tags:** refactor, infrastructure, reliability

## Dependencies

- **`.claude/` packaging must be confirmed first.** `.vscodeignore` is a blocklist and never mentions
  `.claude`; its `*.md` rule at line 64 matches the repo root only (the file documents that trap at
  line 41). So `.claude/` may already ship in the VSIX unremarked. `vsix-packaging-contract.test.js`
  contains zero `.claude` assertions, so this is currently unverified in either direction. Resolve it
  before step 2 — if it already ships, step 2 is a no-op plus a test.
- **Standalone seed wiring is a separate plan.** This plan keeps parity no worse than today and adds
  the new surface to the shared function so a later standalone wiring picks it up for free. It does
  not attempt to wire the standalone root.

## Implementation

1. **Commit the eight files as source.** They already exist on disk at `.claude/skills/<name>/SKILL.md`
   with correct frontmatter. Keep them verbatim — no regeneration, no reformatting — so the diff is
   provably content-neutral.
2. **Ensure they ship.** Per Dependencies, confirm whether `.claude/skills/**` is already packaged. If
   not, add an explicit `!.claude/skills/**` negation, and read the `.vscodeignore` header first: vsce's
   filter is `!ignore.some(...) || negate.some(...)`, so a negation wins unconditionally over every
   ignore pattern regardless of line order. Scope the negation to `SKILL.md` files rather than blanket
   `.claude/**`, which would re-include `settings.json` and `.switchboard-generated.json`.
3. **Add a third seed surface.** Widen `seedBundleSurface`'s `surface` parameter beyond
   `'skills' | 'workflows'` to cover the `.claude/skills` tree, and call it from `extension.ts`
   alongside the existing two. The destination path is currently hardcoded as
   `path.join(workspaceRoot, '.agents', surface, relativePath)` — this needs a destination root
   parameter, since the new surface lands under `.claude/`, not `.agents/`. Keep the ledger key format
   `<surface>/<posix-rel>` intact: the Windows `path.sep` normalisation documented in the docstring is
   load-bearing, and a naive key build silently no-ops the deletion guard.
4. **Delete the generator.** Remove `MIRROR_MANIFEST`, `parseSource`, `stripQuotes`, `firstH1`,
   `escapeYamlValue`, `resolveSourceFile`, `buildSkillMd`, `generateClaudeMirror`, and the
   `GENERATED_MANIFEST_FILE` writer. Drop the `generateClaudeMirror` import at `extension.ts:32` and
   its call site at `:4106`.
5. **Keep what is not mirroring.** `buildManagedInner` and `stripProtocolMarkers` serve the
   AGENTS.md/CLAUDE.md managed block and are unrelated to skill mirroring. `mergePermissionsAllowList`
   (38 lines) performs a non-destructive merge into `.claude/settings.json`, a file the user owns —
   that is genuinely not a file copy and must survive. Retain the module for these three, or relocate
   them and retire the file.
6. **Handle the existing generated ledger.** `.claude/.switchboard-generated.json` exists in ~4,000
   installs. Per `CLAUDE.md`, this shipped, so it must be migrated rather than orphaned: on first
   activation after upgrade, archive it as `.switchboard-generated.json.migrated.bak` rather than
   unlinking, and do not assume the migration already ran.

## Verification Plan

1. **Content neutrality.** Before deleting anything, snapshot all eight generated
   `.claude/skills/*/SKILL.md` files. After the change, assert byte-identical output. Any difference is
   a regression, not a cleanup.
2. **New drift test.** Add a test asserting each `.claude/skills/<name>/SKILL.md` body matches its
   `.agents/` counterpart modulo the frontmatter block. This is the guard that replaces the generator —
   without it, the two committed copies can drift silently, which is the one real argument the
   generator had.
3. **Packaging assertion.** Extend `vsix-packaging-contract.test.js` to assert the eight
   `.claude/skills/*/SKILL.md` paths are not excluded by `.vscodeignore` — the same guarantee line 206
   already provides for `.agents/`. It currently makes zero `.claude` assertions.
4. **Deletion guard still holds on the new surface.** Delete one `.claude/skills/<name>/` from a test
   workspace, record it in the ledger, activate, and assert it is not resurrected. Then delete a
   *not*-in-ledger file and assert it IS created (fresh-workspace fail-safe).
5. **Windows ledger key.** Assert the ledger key for the new surface is built with
   `relativePath.split(path.sep).join('/')`. A `path.sep`-joined key makes the guard a silent no-op on
   Windows — the exact resurrection it exists to prevent.
6. **Fresh-install path.** Install the VSIX into an empty workspace and assert all eight
   `.claude/skills/` dirs and `.claude/settings.json` appear, with `settings.json` carrying the merged
   allow-list.
7. **Upgrade path.** Activate over a workspace that has a generator-produced `.claude/` plus a
   `.switchboard-generated.json`, and assert the skills are unchanged and the old ledger is archived as
   `.migrated.bak`, not deleted.
8. **Both hosts, explicitly.** Confirm the standalone host's behaviour is unchanged by this plan — it
   wires none of these seams today, so the correct result is "no regression", not "now works". Record
   that as the finding that motivates the separate standalone-wiring plan; do not let a green
   `npm run standalone-parity:check` stand in as evidence, since it is scoped to the browser read-back
   path, not the composition root.
