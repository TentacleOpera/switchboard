# Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets

<!-- board-collapse-02 -->
> **SCOPE CONFIRMED AND WIDENED 2026-09-04 (Board Collapse 02).** Operator decision: the generator goes. This plan is the winner of decision 5 and now carries the whole mirror question. Two additions inherited from cards deleted alongside it:
> > 
> > 1. **The no-frontmatter invariant.** A skill deliberately hidden from Claude Code's slash menu carries no frontmatter in its `.agents/` source; Antigravity registers only `<dir>/SKILL.md` frontmatter, so the absence is the deliberate non-door convention. The drift test that replaces `mirror:check` must assert it, taking over from the deleted *`mirror:check` must assert that a gated skill carries no source frontmatter*.
> > 2. **Landing removes the CI step.** `npm run mirror:check` is wired at `.github/workflows/integration-tests.yml:71` and `package.json:967`. Deleting the generator deletes that step; the drift test replaces it in the same commit, so CI is never left without a control-plane check.
> > 
> > Also note: the manifest has **eight** entries and `.claude/skills/` holds **eight** directories. Verify that count at implementation time rather than trusting the plan's prose.


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
**Feature:** d84a2df3-59d5-4f57-a894-26291e9625ae

## User Review Required

No — the removal is a mechanical refactor with a content-neutrality guarantee. The one open
question (whether `.claude/` is already packaged) is resolved inside the packaging subtask, not
by the user.

## Complexity Audit

### Routine

- Committing eight existing on-disk files verbatim (no regeneration, no reformatting).
- Deleting `MIRROR_MANIFEST`, `parseSource`, `stripQuotes`, `firstH1`, `escapeYamlValue`,
  `resolveSourceFile`, `buildSkillMd`, and the `GENERATED_MANIFEST_FILE` writer.
- Dropping the `generateClaudeMirror` import and call sites.
- Archiving `.claude/.switchboard-generated.json` as `.migrated.bak` on first activation.

### Complex / Risky

- **Widening `seedBundleSurface` with a destination root parameter.** The current signature
  hardcodes `path.join(workspaceRoot, '.agents', surface, relativePath)`. The new surface lands
  under `.claude/`, so the destination root must be parameterised. The ledger key format must use
  a distinct surface name (e.g. `claude-skills/<rel>`) to avoid colliding with `skills/<rel>`.
  The Windows `path.sep` normalisation is load-bearing — a naive key build silently no-ops the
  deletion guard.
- **`mergePermissionsAllowList` is called ONLY from inside `generateClaudeMirror` (`:405`).**
  Deleting the generator orphans it — `.claude/settings.json` stops getting the Switchboard allow
  entries. This is a regression in ~4,000 installs. The function must be wired to a new call site
  after the generator is deleted. See proposed change 7.
- **`generateClaudeMirror` has TWO call sites, not one.** `extension.ts:4106` (inside
  `scaffoldProtocolLayers`) and `ControlPlaneMigrationService.ts:743` (inside the migration
  service's Claude Code layer scaffolding). Both must be removed. The plan originally listed only
  the first.
- **The drift test (verification 2) is the load-bearing safety net, not the byte-identity test
  (verification 1).** Byte-identity proves the committed files match the generator's output; the
  drift test proves the content is correct against the `.agents/` source. A coder who skips the
  drift test ships whatever the generator last produced, bugs included.

## Edge-Case & Dependency Audit

**Race conditions**
- None. The mirror removal is a one-time code change, not a runtime concurrency concern. The
  `seedBundleSurface` call for the new surface runs in the same activation sequence as the existing
  two, with no interleaving.

**Security**
- None. Deleting a generator and committing its output as source introduces no new surface.

**Side effects**
- `.claude/.switchboard-generated.json` is archived as `.migrated.bak` on first activation after
  upgrade. This is a one-time write to user workspaces. The file is tracked in git in the source
  repo and must be `git rm`'d as part of this change.
- `.claude/settings.json` continues to receive the Switchboard allow entries via
  `mergePermissionsAllowList`, but from a new call site. The merge is non-destructive (appends only
  absent entries), so the user's existing settings are preserved.
- The eight `.claude/skills/<name>/SKILL.md` files are now committed source, not generated. Any
  future edit to the `.agents/` counterpart must be manually mirrored in the `.claude/` copy. The
  drift test (verification 2) catches silent divergence.

**Dependencies & conflicts**
- **`.claude/` packaging must be confirmed first** (per Dependencies section). The packaging
  subtask adds a `.claude/` packaging assertion that verifies this.
- **The `generatedAt` removal in the packaging subtask is partially superseded by this plan.** If
  this plan lands first, the `ClaudeCodeMirrorService.ts:410` `generatedAt` line is deleted with
  the generator. The packaging subtask then only needs to remove `generatedAt` from
  `ControlPlaneMigrationService.ts:1410`.
- **No conflict with the downgrade guard or source-repo guard.** Both gate the call to
  `seedBundleSurface`; this plan widens what the call does when it runs.

## Dependencies

- **`.claude/` packaging must be confirmed first.** `.vscodeignore` is a blocklist and never mentions
  `.claude`; its `*.md` rule at line 64 matches the repo root only (the file documents that trap at
  line 41). So `.claude/` may already ship in the VSIX unremarked. `vsix-packaging-contract.test.js`
  contains zero `.claude` assertions, so this is currently unverified in either direction. Resolve it
  before step 2 — if it already ships, step 2 is a no-op plus a test.
- **Standalone seed wiring is a separate plan.** This plan keeps parity no worse than today and adds
  the new surface to the shared function so a later standalone wiring picks it up for free. It does
  not attempt to wire the standalone root.

## Adversarial Synthesis

Key risks: (1) `mergePermissionsAllowList` is called only from inside `generateClaudeMirror` (`:405`)
— deleting the generator orphans it and stops the `.claude/settings.json` allow-list merge in ~4,000
installs; mitigated by wiring it to a new call site (proposed change 7); (2) `generateClaudeMirror`
has two call sites (`extension.ts:4106` and `ControlPlaneMigrationService.ts:743`) — removing only the
first leaves the second calling a deleted function; mitigated by updating step 4 to list both; (3)
the ledger key for the new surface could collide with `skills/<rel>` if the surface name is not
distinct — mitigated by specifying `claude-skills/<rel>` as the key format; (4) the byte-identity test
passes on whatever the generator last produced, including bugs — mitigated by the drift test
(verification 2) as the load-bearing safety net. Mitigations are wired into the proposed changes, not
left as advice.

## Proposed Changes

1. **Commit the eight files as source.** They already exist on disk at `.claude/skills/<name>/SKILL.md`
   with correct frontmatter. Keep them verbatim — no regeneration, no reformatting — so the diff is
   provably content-neutral. The drift test (verification 2) is the safety net that proves the
   committed content is correct, not just unchanged.
2. **Ensure they ship.** Per Dependencies, confirm whether `.claude/skills/**` is already packaged. If
   not, add an explicit `!.claude/skills/**` negation, and read the `.vscodeignore` header first: vsce's
   filter is `!ignore.some(...) || negate.some(...)`, so a negation wins unconditionally over every
   ignore pattern regardless of line order. Scope the negation to `SKILL.md` files rather than blanket
   `.claude/**`, which would re-include `settings.json` and `.switchboard-generated.json`.
3. **Add a third seed surface.** Widen `seedBundleSurface`'s `surface` parameter beyond
   `'skills' | 'workflows'` to cover the `.claude/skills` tree, and call it from `extension.ts`
   alongside the existing two. The destination path is currently hardcoded as
   `path.join(workspaceRoot, '.agents', surface, relativePath)` — this needs a destination root
   parameter, since the new surface lands under `.claude/`, not `.agents/`. Use `claude-skills` as
   the surface name so the ledger key format `claude-skills/<posix-rel>` is distinct from
   `skills/<posix-rel>` and cannot collide. The Windows `path.sep` normalisation documented in the
   docstring is load-bearing, and a naive key build silently no-ops the deletion guard.
4. **Delete the generator.** Remove `MIRROR_MANIFEST`, `parseSource`, `stripQuotes`, `firstH1`,
   `escapeYamlValue`, `resolveSourceFile`, `buildSkillMd`, `generateClaudeMirror`, and the
   `GENERATED_MANIFEST_FILE` writer. Drop the `generateClaudeMirror` import at `extension.ts:32` and
   its call site at `:4106`. **Also drop the import at `ControlPlaneMigrationService.ts:13` and its
   call site at `:743`** — the migration service's Claude Code layer scaffolding path calls
   `generateClaudeMirror` independently of `scaffoldProtocolLayers`. Removing only the first call
   site leaves the second calling a deleted function.
5. **Keep what is not mirroring.** `buildManagedInner` and `stripProtocolMarkers` serve the
   AGENTS.md/CLAUDE.md managed block and are unrelated to skill mirroring. `mergePermissionsAllowList`
   (38 lines) performs a non-destructive merge into `.claude/settings.json`, a file the user owns —
   that is genuinely not a file copy and must survive. Retain the module for these three, or relocate
   them and retire the file.
6. **Handle the existing generated ledger.** `.claude/.switchboard-generated.json` exists in ~4,000
   installs. Per `CLAUDE.md`, this shipped, so it must be migrated rather than orphaned: on first
   activation after upgrade, archive it as `.switchboard-generated.json.migrated.bak` rather than
   unlinking, and do not assume the migration already ran. `git rm` the file from the source repo
   as part of this change — it is tracked and no longer written after the generator is deleted.

7. **Wire `mergePermissionsAllowList` to a new call site.** The function is called ONLY from inside
   `generateClaudeMirror` (`:405`). Deleting the generator orphans it — `.claude/settings.json`
   stops getting the Switchboard allow entries (`Bash(curl *)`, `Bash(node *)`, etc.), which breaks
   the Claude Code proxy skills in ~4,000 installs. Call `mergePermissionsAllowList` from
   `extension.ts` after the `seedBundleSurface` call for the `claude-skills` surface, or from
   `scaffoldProtocolLayers` where the generator used to live. The call must run on the same
   activation path that seeds `.claude/skills/`, so the allow list is present whenever the skills
   are. Export `mergePermissionsAllowList` from `ClaudeCodeMirrorService.ts` (it is currently
   module-private) so the new call site can reach it.

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
9. **`mergePermissionsAllowList` is called after the generator is deleted.** Activate in a fresh
   workspace, assert `.claude/settings.json` contains the Switchboard allow entries
   (`Bash(curl *)`, `Bash(node *)`, `Bash(source *)`, `Bash(sqlite3 *)`, `Bash(duckdb *)`). Then
   activate in a workspace with an existing `.claude/settings.json` containing user entries, and
   assert the user entries are preserved and the Switchboard entries are appended.
10. **Both `generateClaudeMirror` call sites are removed.** Grep the codebase for `generateClaudeMirror`
    and assert zero matches outside `ClaudeCodeMirrorService.ts` (where the function definition is
    deleted). Confirm `extension.ts:32` and `ControlPlaneMigrationService.ts:13` no longer import it,
    and `extension.ts:4106` and `ControlPlaneMigrationService.ts:743` no longer call it.
11. **Ledger key format is distinct.** Assert the ledger key for a `.claude/skills` file is
    `claude-skills/<posix-rel>`, not `skills/<posix-rel>`. A collision would make the deletion guard
    for `.agents/skills` gate `.claude/skills` creation.

### Goal Invariants

- Assert `generateClaudeMirror` is absent from `ClaudeCodeMirrorService.ts` (the function and all
  its helpers are deleted).
- Assert `generateClaudeMirror` is absent from the import list of both `extension.ts` and
  `ControlPlaneMigrationService.ts` (both call sites removed).
- Assert `mergePermissionsAllowList` is exported from `ClaudeCodeMirrorService.ts` and called from
  at least one site outside the deleted generator (the allow-list merge survives).
- Assert the eight `.claude/skills/<name>/SKILL.md` files are tracked in git (committed as source,
  not generated at runtime).
- Assert `.claude/.switchboard-generated.json` is absent from the committed tree (the ledger is
  retired, not just unwritten).
- Assert `seedBundleSurface` accepts a surface name other than `'skills' | 'workflows'` and writes
  to a destination root other than `.agents/` (the widening is real, not a type-only change).
