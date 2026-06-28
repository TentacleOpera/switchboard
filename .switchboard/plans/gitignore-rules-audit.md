# Audit and Trim Switchboard's Managed Gitignore Rules

## Goal

Review whether Switchboard's `TARGETED_RULES` gitignore block is still appropriate now that the project has moved to a SQLite DB model for runtime state. Remove rules that are no longer needed, fix gaps (epics folder — covered in a separate plan), and reduce noise for users who wonder why so much of `.switchboard/` is excluded.

**Background:** Switchboard originally wrote many files to `.switchboard/` — `state.json`, `kanban-state.json`, `sessions/activity.jsonl`, etc. These justified the blanket `.switchboard/*` exclusion. Most of that file spam has been migrated to `kanban.db`. But the exclusion rules have never been revisited post-migration, so the current rule set may be overly broad or contain redundant entries.

## Metadata

**Complexity:** 3
**Tags:** infrastructure, devops, docs, reliability

## ⚠️ Reviewer Note: Inspect the Live `.switchboard/` Directory

**This audit was written from a remote clone where the Switchboard extension has never run.** The remote `.switchboard/` only contains committed files (`plans/`, `sessions/`, `kanban-board.md`, etc.). None of the extension-generated directories exist in this environment.

Before finalising the recommendations below, the implementer must **inspect `.switchboard/` on a local machine where the extension has been running** (ideally the primary dev machine). Some directories that were categorised as "cache" from code inspection alone may in practice contain real, durable artifacts — for example, `docs/` holds imported documents that users may want committed and visible to remote agents, not regenerated on every clone.

**Action required before implementation:** Run `find .switchboard -maxdepth 3 | sort` on a live local workspace and review each directory with the owner. Revise the recommendations table below based on actual observed content before touching `TARGETED_RULES`.

---

## Findings from Audit

### What still legitimately writes files (recommendations are provisional — see note above)

| Path | Status | Provisional Recommendation |
|:---|:---|:---|
| `.switchboard/kanban.db` / `*.db-shm` / `*.db-wal` | Machine-local DB | **Keep excluded** — never commit |
| `.switchboard/docs/` | Imported docs from Linear/ClickUp/Notion | **Needs review** — may be real artifacts worth committing for remote agents, not pure cache |
| `.switchboard/tickets/` | Ticket cache hierarchy | **Needs review** — may contain curated content vs. raw API cache |
| `.switchboard/planning-cache/` | Doc ID mappings cache | **Keep excluded** — internal ID mapping, regenerable |
| `.switchboard/archive/` | Archived plans/reviews | **Needs review** — archived plans are durable history; remote agents may benefit from seeing them |
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

### [MODIFY] `src/test/git-ignore-custom-default-regression.test.js` — Update snapshot

Remove `!.switchboard/sessions/` and `.switchboard/notion-cache.md` from the expected rules. Add `!.switchboard/epics/`. The test must pass after changes.

### [CHECK] `.gitignore` (repo-level, non-managed section)

The repo's `.gitignore` (above the managed block) also manually lists some entries:
- `.switchboard/clickup-config.json`
- `.switchboard/linear-config.json`
- `.switchboard/linear-sync.json`
- `.switchboard/notion-config.json`
- `.switchboard/notion-cache.md`

These are outside the managed block and cover the case where users have `custom` or `none` strategy. They should stay. No changes needed here.

## Migration Consideration

Removing `!.switchboard/sessions/` from `TARGETED_RULES` does NOT delete already-committed session files. It only means the gitignore stops carving out an exception for new ones. Users who have committed session files and want to clean up can run `git rm --cached .switchboard/sessions/*.json`. This is optional and can be mentioned in release notes.

The `WorkspaceExcludeService.apply()` method rewrites only the managed block on next run — it will remove the old exception and add the new epics one atomically.

## Verification Plan

1. Run regression test — must pass with updated snapshot.
2. Confirm `!.switchboard/sessions/` is no longer in the managed block written to `.gitignore`.
3. Confirm `!.switchboard/epics/` IS in the managed block.
4. Confirm `git status` does not show `.switchboard/sessions/*.json` as newly untracked (they stay committed; gitignore only affects untracked files).

## Success Criteria

1. `TARGETED_RULES` has: epics exception added, sessions exception removed, notion-cache.md redundant entry removed.
2. Regression test passes.
3. Managed gitignore block written to disk matches the new rules exactly.
4. No existing committed files are deleted or newly ignored.
