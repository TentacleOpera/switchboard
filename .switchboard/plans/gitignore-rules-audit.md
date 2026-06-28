# Audit `.switchboard/` Git Tracking — Untrack Leaked State, Trim Dead Rules

## Goal

Establish, file-by-file, what in `.switchboard/` should and should not be in git, and fix the mismatches.

**The core problem (root cause).** The original audit framed this as "trim the managed gitignore rules now that we use SQLite." That framing is wrong and produced a plan that edited cosmetics while missing the actual exposure. Two facts reframe it:

1. **The managed block is a blanket-exclude-plus-allowlist** (`.switchboard/*` then `!` carve-outs). Under this design, *every new file the extension writes is excluded by default*. A full live inventory (see "Complete Inventory" below) confirms it: ~50 distinct machine-local files exist on disk (the SQLite DB + ~15 backup/temp variants, caches, pointers, PID files, migration `.bak`s, ad-hoc scripts) and **none of them leak** — the blanket catches all of it. So **there is no "missing exclude rule." Nothing needs to be added to be excluded.**

2. **gitignore cannot untrack already-committed files.** The real exposure is files committed *before* the rules existed, which the blanket is powerless to remove:
   - **`.switchboard/workspace-id` is tracked** and contains a machine-local UUID plus an absolute home path (`/Users/<user>/…/.switchboard/kanban.db`). It leaks the maintainer's local path into a public repo and collides per-developer. A regression test already asserts the *rule* must never re-include it — but the file itself was grandfathered into the repo and never untracked.
   - **`.switchboard/sessions/` (76 files)** are per-machine session archives, currently *kept* by a `!.switchboard/sessions/` carve-out. Useless to remote agents.
   - **`.switchboard/epics/` (14 files)** is the inverse gap: the carve-out exists (shipped in commit `f343a19`) but the files were never `git add`ed, so a shareable artifact class is missing from the repo.

**Background.** Switchboard originally wrote `state.json`, `kanban-state.json`, `sessions/activity.jsonl`, etc. to `.switchboard/`. Most of that moved into `kanban.db`. But the migration did **not** reduce the need for the managed block — it *created the single largest must-exclude artifact* (the DB). Secrets are **not** a factor: all API tokens live in VS Code SecretStorage (`context.secrets.store('switchboard.clickup.apiToken', …)` etc.), never in files. The `*-config.json` files hold only workspace IDs / sync maps and are themselves being migrated into the DB `config` table (`KanbanDatabase.ts:3323`).

## Metadata

**Complexity:** 3
**Tags:** infrastructure, devops, reliability

## Decisions Made (not deferred)

Per house rule "decide and state," these are resolved, not punted to review:

- **Managed-block design stays.** Keep `.switchboard/*` + carve-outs. The alternative (explicit denylist) is less safe and pointless given the blanket works.
- **Remove `!.switchboard/sessions/`** from the managed rules and from this repo's non-managed block. Sessions are per-machine and worthless remotely.
- **Remove the redundant `.switchboard/notion-cache.md`** explicit entry (already covered by the blanket; no documentary value).
- **Keep `kanban.db` / `*.db-shm` / `*.db-wal` explicit entries** — redundant with the blanket but kept as intentional documentation.
- **`docs/` and `archive/` stay excluded.** They are imported/regenerable copies and local history. (`docs/` is the *only* defensible future carve-out — if you ever want cloud agents to read project docs offline. Out of scope here.)

## Open Owner Decisions (genuine content calls only)

1. **Commit this repo's 14 `epics/` files?** The rule already allows it; this is purely whether *your* current epic content should be public in the switchboard repo. Default recommendation: yes (matches the carve-out's intent that remote agents see epics).
2. **`git rm --cached` is destructive and must be owner-initiated.** The commands are listed below but should be run deliberately, not automated by an implementer.

---

## Complete Inventory of `.switchboard/` (live, 2026-06-28)

> Review target. "In git now?" vs "Should be?" — every mismatch is an action item. Repetitive clusters collapsed with counts.

### A. Should be COMMITTED (shareable — remote/cloud agents need these)

| Entry | In git now? | Should be? | Why |
|:---|:---|:---|:---|
| `plans/` (811 files) | ✅ yes | ✅ yes | Implementation plans — the shareable core. Correct. |
| `epics/` (14 files) | ❌ **no** | ✅ **yes** | Epic definitions, same class as plans. Carve-out exists; never `git add`ed. **Gap → action.** |
| `reviews/` (empty) | ✅ carve-out | ✅ yes | Code-review outputs. Correct when populated. |
| `kanban-board.md` (284K) | ✅ yes | ✅ yes | Board snapshot for remote agents. Correct (churns hard — accepted). |
| `README.md`, `SWITCHBOARD_PROTOCOL.md` | ✅ yes | ✅ yes | Static shared docs. Correct. |
| `CLIENT_CONFIG.md`, `kanban-state-*.md` | n/a (absent) | ✅ yes | Carve-outs present; correct when files exist. |

### B. Wrongly in git — should be EXCLUDED (the actual bugs)

| Entry | In git now? | Should be? | Why |
|:---|:---|:---|:---|
| `workspace-id` | ✅ **TRACKED** | ❌ **no** | Machine-local UUID + absolute home path. Leaks local path to a public repo, collides per-developer. Rule already excludes it; grandfathered in. → `git rm --cached`. |
| `sessions/` (76 files) | ✅ **TRACKED** | ❌ **no** | Per-machine session archives (all `*.migrated`). No remote value. Carve-out re-includes them today. → remove carve-out **+** `git rm --cached`. |

### C. Correctly EXCLUDED (machine-local / cache / transient — blanket handles all)

| Entry | Why excluded |
|:---|:---|
| `kanban.db` (3.7M) + ~15 variants: `.tmp` ×7, `.backup.<ts>` ×4, `.bak-20260623`, `.before-cleanup`, `.pre-restore-…`, `.zombiecleanup-backup-…` | Live SQLite DB + backup/temp zoo (~25M). Per-machine, constant churn. |
| `dbbackup/` (5), `kanban-state-backup.json` (688K), `db-pointer`, `archive.duckdb` (780K) | DB backups / pointers / archive DB. Recovery + machine-local. |
| `*.migrated` / `*.migrated.bak` ×6 (clickup-config, linear-config, linear-sync, local-folder-config, state.json, imported-docs) | Legacy files renamed by the DB migration. Local history. |
| `clickup-docs-config.json` and other `*-config.json` | Workspace IDs / sync config (no secrets — tokens are in SecretStorage). Migrating into the DB. |
| `clickup-docs-cache.md`, `local-folder-cache.md`, `research-aggregate-cache.md`, `notion-cache.md`, `planning-cache/` | Regenerable caches of external data. |
| `NotebookLM/` (90 `.docx`), `integration/` (29 `.docx`), `stitch/` (37 `.png`) | Generated export bundles / design images. Regenerable artifacts. |
| `insights/` (empty) | Insights cache. |
| `.DS_Store`, `.agent_version.json`, `.mcp_server (1).pid`, `.mcp_server (2).pid`, `api-server-port.txt`, `workspace_identity.json`, `brain_plan_blacklist.json`, `memo.md` | OS junk, PID/port files, local agent/identity/dedup state, transient memo scratch. |
| `fetch_all_tasks.js`, `fetch_all_tasks_markdown.js`, `reformat_tickets.py`, `task_86d2xdgtc_raw.json`, `temp_tasks.json` | Ad-hoc scripts/data dropped in by hand — not extension-managed. (Could simply be deleted; exclude is correct regardless.) |

### D. Genuine judgment calls (excluded by default)

| Entry | Default | Trade-off |
|:---|:---|:---|
| `docs/` (35 imported `.md`) | exclude | Regenerable copies of Linear/ClickUp/Notion docs. The one folder worth a future `!.switchboard/docs/` carve-out if cloud agents need offline docs. Out of scope. |
| `archive/` (855 — old plans + sessions) | exclude | Local history of superseded plans/sessions. High churn, low remote value. Keep excluded. |

**Conclusion from the inventory:** every excluded entry is correctly excluded. The only changes that alter the repo are untracking `workspace-id` + `sessions/` and adding `epics/`. The rule edits are cosmetic by comparison.

---

## Proposed Changes

### [MODIFY] `src/services/WorkspaceExcludeService.ts` — trim `TARGETED_RULES`

Ships to all ~4000 installs. **Preserve `!.switchboard/epics/` and `!.switchboard/kanban-state-*.md`** — both are current, load-bearing carve-outs. Only two lines (plus a comment) are removed.

```typescript
// BEFORE (current source, lines 9–30):
private static readonly TARGETED_RULES: string[] = [
    '# Switchboard runtime state (per-session, not shareable)',
    '.switchboard/*',
    '!.switchboard/reviews/',
    '!.switchboard/plans/',
    '!.switchboard/epics/',
    '!.switchboard/sessions/',        // <-- REMOVE
    '!.switchboard/CLIENT_CONFIG.md',
    '!.switchboard/README.md',
    '!.switchboard/SWITCHBOARD_PROTOCOL.md',
    '!.switchboard/kanban-board.md',
    '!.switchboard/kanban-state-*.md',
    '',
    '# Notion page content cache',    // <-- REMOVE (comment for the entry below)
    '.switchboard/notion-cache.md',   // <-- REMOVE (redundant with blanket, no doc value)
    '',
    '# kanban.db is already excluded by .switchboard/* above — explicit entry for documentation clarity.',
    '# Never commit the kanban database: it contains machine-local state that differs per developer.',
    '.switchboard/kanban.db',
    '.switchboard/*.db-shm',
    '.switchboard/*.db-wal',
];

// AFTER:
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
    '!.switchboard/kanban-state-*.md',
    '',
    '# kanban.db is already excluded by .switchboard/* above — explicit entry for documentation clarity.',
    '# Never commit the kanban database: it contains machine-local state that differs per developer.',
    '.switchboard/kanban.db',
    '.switchboard/*.db-shm',
    '.switchboard/*.db-wal',
];
```

`apply()` rewrites only the delimited managed block on next activation, so existing users get the trimmed block automatically.

### [MODIFY] `.gitignore` (this repo's non-managed section) — remove the stale sessions exception

The repo's `.gitignore` carries a hand-maintained duplicate block (lines ~41–58) *above* the managed block. It contains `!.switchboard/sessions/`. Remove that single line for cleanliness. (The later managed `.switchboard/*` likely already overrides it, but leaving a contradictory re-include is confusing — delete it.) Leave the config-file entries; they are harmless and cover `custom`/`none` strategies.

### [MODIFY] `src/test/git-ignore-custom-default-regression.test.js` — add rule guards

The file has **no** snapshot of `TARGETED_RULES`; it only checks config defaults and the *absence* of `workspace-id` (lines 66–73). Add negative assertions next to those, matching the existing string-match pattern. (Do **not** add an epics-present assertion — it would pass trivially and guards nothing new.)

```js
assert.ok(
    !excludeServiceSource.includes("'!.switchboard/sessions/'"),
    'Expected targeted rules no longer to re-include .switchboard/sessions/.'
);
assert.ok(
    !excludeServiceSource.includes("'.switchboard/notion-cache.md'"),
    'Expected targeted rules no longer to list the redundant notion-cache.md entry.'
);
```

### [OWNER ACTION] Untrack grandfathered files (destructive — run deliberately, not automated)

These are the only changes that alter what is in the repo. They affect **this repo only** — not the shipped install base.

```bash
# Stop leaking the machine-local path pointer
git rm --cached .switchboard/workspace-id

# Stop tracking per-machine session archives (76 files)
git rm --cached -r .switchboard/sessions

# Add the shareable epics that were never committed (owner content decision)
git add .switchboard/epics
```

Neither `git rm --cached` deletes files from disk; it only removes them from the index going forward.

## Migration / Install-Base Safety (~4000 installs)

- **The only shipped change is the `TARGETED_RULES` edit.** Removing `!.switchboard/sessions/` does **not** untrack any user's already-committed session files — gitignore only affects untracked paths. It simply stops *new* session files from being added. No data loss; nothing to migrate.
- The `git rm --cached` and `git add` steps are local to this repo and ship to no one.
- No state files are deleted, unlinked, or rewritten. The `*.migrated.bak` archival convention is untouched.

## Verification Plan

> Session directive: compilation and automated tests are run separately by the user.

### Automated
- `node src/test/git-ignore-custom-default-regression.test.js` passes with the two new negative assertions.

### Manual
1. After `apply()` runs, the managed block in `.gitignore` contains **no** `!.switchboard/sessions/` and **no** `.switchboard/notion-cache.md`, and still contains `!.switchboard/epics/` and `!.switchboard/kanban-state-*.md`.
2. `git check-ignore .switchboard/sessions/<file>.json` → ignored (exit 0) after the rule change.
3. `git check-ignore .switchboard/epics/<file>.md` → not ignored (exit 1).
4. `git ls-files .switchboard/workspace-id` → empty after `git rm --cached`.
5. `git ls-files .switchboard/sessions | wc -l` → 0 after `git rm --cached`.
6. `git ls-files .switchboard/epics | wc -l` → 14 after `git add`.
7. `git ls-files .switchboard/ | git check-ignore --stdin --no-index` → returns nothing (no remaining tracked file is shadowed by an ignore rule).

## Success Criteria

1. `TARGETED_RULES`: sessions exception removed, notion-cache.md removed; epics and kanban-state-* preserved.
2. Regression test passes with the new guards.
3. `workspace-id` and `sessions/` no longer tracked; `epics/` tracked (pending owner decision).
4. No file deleted from disk; no existing user's committed files untracked by the shipped change.
5. `git check-ignore --no-index` over the tracked set returns empty.

## Recommendation

**Complexity: 3.** The shipped code change is a two-line array edit plus two test assertions — routine. The substance is the owner-run `git rm --cached` / `git add` cleanup, which is mechanically trivial but must be initiated by the owner because it mutates repo history. Resolve the two owner decisions, then implement in a single pass.
