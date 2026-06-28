# Audit and Trim Switchboard's Managed Gitignore Rules

## Goal

Review whether Switchboard's `TARGETED_RULES` gitignore block is still appropriate now that the project has moved to a SQLite DB model for runtime state. Remove rules that are no longer needed, fix gaps (epics folder — covered in a separate plan), and reduce noise for users who wonder why so much of `.switchboard/` is excluded.

**Background:** Switchboard originally wrote many files to `.switchboard/` — `state.json`, `kanban-state.json`, `sessions/activity.jsonl`, etc. These justified the blanket `.switchboard/*` exclusion. Most of that file spam has been migrated to `kanban.db`. But the exclusion rules have never been revisited post-migration, so the current rule set may be overly broad or contain redundant entries.

## Metadata

**Complexity:** 3
**Tags:** infrastructure, devops, docs, reliability

## User Review Required

Yes — before implementation, the implementer must confirm two decisions with the workspace owner:
1. **Non-managed `.gitignore` line 45** (`!.switchboard/sessions/`): should it be removed for consistency with the managed-block change, or left in place (which means sessions remain excepted in this repo)?
2. **`docs/` and `archive/` directories**: confirmed currently excluded and untracked (live inspection — see Reviewer Note below). Adding carve-out exceptions for them is **out of scope** for this trimming plan — flag for a separate plan if the owner wants remote agents to see them.

## Complexity Audit

### Routine
- Removing two entries (`!.switchboard/sessions/`, `.switchboard/notion-cache.md`) from a static string array (`TARGETED_RULES`, `src/services/WorkspaceExcludeService.ts` lines 9–28).
- Adding one entry (`!.switchboard/epics/`) from the companion plan.
- Adding string-match assertions to an existing Node.js test file (same pattern as the existing `workspace-id` assertions at `src/test/git-ignore-custom-default-regression.test.js` lines 66–73).
- The `WorkspaceExcludeService.apply()` method (lines 105–155) atomically rewrites only the managed block on next run — no manual `.gitignore` surgery needed for managed-block users.

### Complex / Risky
- The non-managed `.gitignore` section (lines 41–64) contains a manual duplicate of the managed rules, including `!.switchboard/sessions/` on line 45. Removing the managed-block exception does NOT remove line 45, so sessions stay excepted in this repo unless line 45 is also removed. This is a coordination risk, not a logic risk.
- 76 session files are currently git-tracked (all `*.migrated`). The gitignore change does not delete them, but future `git rm --cached` cleanup (if desired) is a destructive operation that must be user-initiated — never automated by the plan.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `WorkspaceExcludeService.apply()` is a sequential read-modify-write on `.gitignore`; the managed block is replaced atomically via `_replaceManagedBlock` (lines 64–85).
- **Security:** No secrets are exposed. The config files (`*-config.json`) remain excluded in both managed and non-managed sections. Removing `!.switchboard/sessions/` does not expose secrets — session files contain agent metadata, not credentials.
- **Side Effects:** Users on the `custom` or `none` strategy are unaffected (the managed block is not written for them — see `apply()` lines 138–152). Users on `targetedGitignore` get the trimmed block on next activation. Already-tracked session files remain tracked (gitignore only affects untracked files).
- **Dependencies & Conflicts:** This plan overlaps with `expose-epics-folder-in-gitignore.md`, which adds `!.switchboard/epics/` to the same `TARGETED_RULES` array. Both plans touch `WorkspaceExcludeService.ts` and the test file. They should be implemented in a single pass to avoid a stale intermediate state. The "AFTER" code block below shows the combined result.

## Dependencies

- `expose-epics-folder-in-gitignore.md` — adds `!.switchboard/epics/` to `TARGETED_RULES`. Implement together with this plan (same file, same test).
- No session-based (`sess_*`) dependencies.

## Adversarial Synthesis

Key risks: (1) both this plan and its companion hallucinate a "snapshot assertion" in the test file that does not exist — the test change must ADD new assertions, not edit a snapshot; (2) the non-managed `.gitignore` section retains `!.switchboard/sessions/` on line 45, silently defeating the sessions-removal goal for this repo unless also trimmed; (3) the "Needs review" items were unresolved. Mitigations: correct the test guidance to "add string-match assertions"; explicitly flag line 45 for owner decision; live inspection now resolves docs/archive/tickets (see updated Findings).

## ⚠️ Reviewer Note: Inspect the Live `.switchboard/` Directory

**This audit was written from a remote clone where the Switchboard extension has never run.** The remote `.switchboard/` only contains committed files (`plans/`, `sessions/`, `kanban-board.md`, etc.). None of the extension-generated directories exist in that environment.

**✅ LIVE INSPECTION PERFORMED (2026-06-28):** The plan has since been reviewed against a live local workspace where the extension runs. Findings, incorporated into the table below:
- `.switchboard/epics/` — **exists** with 13 real epic files; **0 git-tracked** (currently ignored by `.switchboard/*`). Confirms the companion plan's carve-out is needed.
- `.switchboard/sessions/` — 76 files git-tracked (all `*.migrated`); confirms removing the exception won't delete tracked content.
- `.switchboard/docs/` — 35 imported docs; **0 git-tracked** (ignored). Real artifacts but committing them requires a new carve-out — **out of scope** for this trimming plan.
- `.switchboard/archive/` — 2 subdirs (`plans/`, `sessions/`); **0 git-tracked**. Same as docs/ — out of scope.
- `.switchboard/tickets/` — **does NOT exist** on this machine. Row removed from the table below.
- `.switchboard/planning-cache/` — `clickup/`, `clickup-tasks.json`, `linear-tasks.json`. Confirmed cache — keep excluded.
- `.switchboard/insights/` — empty. Keep excluded.

If implementing on a **different** machine, still run `find .switchboard -maxdepth 3 | sort` and compare against the above before touching `TARGETED_RULES`.

---

## Findings from Audit

### What still legitimately writes files (recommendations are provisional — see note above)

| Path | Status | Provisional Recommendation |
|:---|:---|:---|
| `.switchboard/kanban.db` / `*.db-shm` / `*.db-wal` | Machine-local DB | **Keep excluded** — never commit |
| `.switchboard/docs/` | Imported docs from Linear/ClickUp/Notion (35 files, 0 tracked) | **Keep excluded** (out of scope) — real artifacts, but committing requires a new carve-out; defer to a separate plan if the owner wants remote agents to see them |
| `.switchboard/planning-cache/` | Doc ID mappings cache (`clickup/`, `*-tasks.json`) | **Keep excluded** — internal ID mapping, regenerable |
| `.switchboard/archive/` | Archived plans/sessions (2 subdirs, 0 tracked) | **Keep excluded** (out of scope) — same rationale as `docs/`; defer to a separate plan |
| `.switchboard/*-config.json` (clickup, linear, notion) | Encrypted credentials | **Keep excluded** — never commit secrets |
| `.switchboard/workspace-id` | Local DB path pointer | **Keep excluded** — machine-local |
| `.switchboard/notion-cache.md` | Notion page cache | **Keep excluded** (currently duplicated — see below) |
| `.switchboard/insights/`, `stitch/`, `NotebookLM/` | Caches/staging | **Keep excluded** |
| `.switchboard/inbox/`, `outbox/`, `cooldowns/`, `MCP/`, `handoff/` | Transient runtime | **Keep excluded** |
| `.switchboard/kanban-state-backup.json` | Recovery backup | **Keep excluded** — machine-local |

### What has been migrated to DB (rules are now redundant documentation)

| Path | Migration Status | Notes |
|:---|:---|:---|
| `.switchboard/state.json` | Fully bridged to DB | File never written — transparent bridge routes all calls to `kanban.db`. The explicit gitignore entry serves as documentation only. |
| `.switchboard/sessions/activity.jsonl` | Migrated to DB sessions table | Renamed to `activity.jsonl.migrated` on disk. New activity goes to DB. |

### The `sessions/` exception — questionable

`!.switchboard/sessions/` is a current exception (sessions are committed). But `sess_*.json` files are per-machine session archives — machine-local metadata that differs per developer. Committing them creates noise with zero benefit for remote agents (they don't read session archives). **Recommendation: remove this exception.** 

Migration note: existing users who have committed `sessions/` files should not have those deleted — just exclude new ones going forward. The gitignore change only affects untracked files; already-committed files require a separate `git rm --cached` by the user if they want to clean up.

### Redundant explicit entries

The managed block explicitly lists entries that are already covered by `.switchboard/*`:
- `.switchboard/notion-cache.md` — redundant (covered by `*`)
- `.switchboard/kanban.db`, `*.db-shm`, `*.db-wal` — redundant but kept as **intentional documentation** (the comment explains why the DB is excluded)

The notion-cache.md explicit entry has no documentary value beyond what the wildcard provides. It can be removed.

## Proposed Changes

### [MODIFY] `src/services/WorkspaceExcludeService.ts` — Trim TARGETED_RULES

```typescript
// BEFORE:
private static readonly TARGETED_RULES: string[] = [
    '# Switchboard runtime state (per-session, not shareable)',
    '.switchboard/*',
    '!.switchboard/reviews/',
    '!.switchboard/plans/',
    '!.switchboard/sessions/',       // <-- remove
    '!.switchboard/CLIENT_CONFIG.md',
    '!.switchboard/README.md',
    '!.switchboard/SWITCHBOARD_PROTOCOL.md',
    '!.switchboard/kanban-board.md',
    '',
    '# Notion page content cache',
    '.switchboard/notion-cache.md',  // <-- remove (covered by wildcard, no doc value)
    '',
    '# kanban.db is already excluded by .switchboard/* above — explicit entry for documentation clarity.',
    '# Never commit the kanban database: it contains machine-local state that differs per developer.',
    '.switchboard/kanban.db',
    '.switchboard/*.db-shm',
    '.switchboard/*.db-wal',
];

// AFTER (combined with the epics addition from the companion plan):
private static readonly TARGETED_RULES: string[] = [
    '# Switchboard runtime state (per-session, not shareable)',
    '.switchboard/*',
    '!.switchboard/reviews/',
    '!.switchboard/plans/',
    '!.switchboard/epics/',
    '!.switchboard/CLIENT_CONFIG.md',
    '!.switchboard/README.md',
    '!.switchboard/SWITCHBOARD_PROTOCOL.md',
    '!.switchboard/kanban-board.md',
    '',
    '# kanban.db is already excluded by .switchboard/* above — explicit entry for documentation clarity.',
    '# Never commit the kanban database: it contains machine-local state that differs per developer.',
    '.switchboard/kanban.db',
    '.switchboard/*.db-shm',
    '.switchboard/*.db-wal',
];
```

**Note:** This plan can be merged with `expose-epics-folder-in-gitignore.md` into a single implementation pass since both touch the same constant and test file.

### [MODIFY] `src/test/git-ignore-custom-default-regression.test.js` — Add rule-guard assertions

**⚠️ Correction (verified against source):** This test file does **NOT** currently contain a snapshot of `TARGETED_RULES`. It has no assertion checking for `!.switchboard/sessions/`, `.switchboard/notion-cache.md`, `!.switchboard/epics/`, or even `!.switchboard/plans/`. The existing assertions (lines 19–82) only verify config defaults and the *absence* of `workspace-id`. The companion plan `expose-epics-folder-in-gitignore.md` makes the same incorrect "update snapshot" claim — both must be corrected.

**Action:** Add new string-match assertions (matching the existing `workspace-id` pattern at lines 66–73) to lock down the expected `TARGETED_RULES` content. Insert after the existing `workspace-id` assertions:

```js
assert.ok(
    excludeServiceSource.includes("'!.switchboard/epics/'"),
    'Expected targeted rules to re-include .switchboard/epics/.'
);
assert.ok(
    !excludeServiceSource.includes("'!.switchboard/sessions/'"),
    'Expected targeted rules no longer to re-include .switchboard/sessions/.'
);
assert.ok(
    !excludeServiceSource.includes("'.switchboard/notion-cache.md'"),
    'Expected targeted rules no longer to list the redundant notion-cache.md entry.'
);
```

These guard against silent regressions — currently no test locks the exact rule set, so any edit to `TARGETED_RULES` would pass unchecked.

### [CHECK] `.gitignore` (repo-level, non-managed section) — ⚠️ contains a stale `sessions` exception

The repo's `.gitignore` (lines 41–64, above the managed block) is a **manual duplicate** of the managed rules. It contains:
- `.switchboard/*` and the same exception list (lines 42–48), **including `!.switchboard/sessions/` on line 45** and the `!kanban-board.md` exception is **missing** here (present only in the managed block).
- The config files: `clickup-config.json`, `linear-config.json`, `linear-sync.json`, `notion-config.json`, `notion-cache.md` (lines 49–58).

**⚠️ Gap (not in original plan):** Line 45 (`!.switchboard/sessions/`) was not mentioned. Even after removing `!.switchboard/sessions/` from the managed `TARGETED_RULES`, this repo will **continue to except sessions** via line 45. To fully stop tracking new session files in this repo, line 45 must also be removed.

**Owner decision required (see User Review Required):**
- Remove line 45 for consistency with the managed-block change, OR
- Leave it (sessions stay excepted in this repo only; the managed-block change still applies to all other users).

The config-file entries (lines 49–58) should stay — they cover `custom`/`none` strategies and are not part of the managed block.

## Migration Consideration

Removing `!.switchboard/sessions/` from `TARGETED_RULES` does NOT delete already-committed session files. It only means the gitignore stops carving out an exception for new ones. Users who have committed session files and want to clean up can run `git rm --cached .switchboard/sessions/*.json`. This is optional and can be mentioned in release notes.

The `WorkspaceExcludeService.apply()` method rewrites only the managed block on next run — it will remove the old exception and add the new epics one atomically.

## Verification Plan

> **Session directives:** Compilation and automated tests are skipped — the test suite will be run separately by the user.

### Automated Tests
- (Skipped per session directive.) When run separately, `node src/test/git-ignore-custom-default-regression.test.js` must pass with the new rule-guard assertions (epics present, sessions absent, notion-cache.md absent).

### Manual Checks
1. Confirm `!.switchboard/sessions/` is no longer in the managed block written to `.gitignore` (the block delimited by `# >>> Switchboard managed exclusions >>>` / `# <<< ... <<<`).
2. Confirm `!.switchboard/epics/` IS in the managed block.
3. Confirm `git status` does not show `.switchboard/sessions/*.json` as newly untracked (they stay committed; gitignore only affects untracked files).
4. Confirm `.switchboard/epics/*.md` now appears as untracked (no longer ignored) — run `git check-ignore .switchboard/epics/<file>.md` and expect no output (exit code 1).
5. If the owner approved removing non-managed line 45, confirm `git status` still does not show tracked session files as deleted (only untracked new ones would be affected).

## Success Criteria

1. `TARGETED_RULES` has: epics exception added, sessions exception removed, notion-cache.md redundant entry removed.
2. Regression test passes.
3. Managed gitignore block written to disk matches the new rules exactly.
4. No existing committed files are deleted or newly ignored.

## Recommendation

**Complexity: 3 → Send to Intern.** The code change is a single static array edit plus test-assertion additions. The owner-decision items (non-managed line 45, docs/archive scope) must be resolved first, but the implementation itself is routine and localized.
