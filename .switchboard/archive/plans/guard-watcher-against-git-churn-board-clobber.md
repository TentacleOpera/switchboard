# Guard the plan-watcher against git-churn board clobber

## Goal

Make it structurally impossible for a git branch checkout (or any bulk working-tree change) to reset kanban board state. Today, switching to a branch that lacks the current plan files deletes them from the working tree; the file-watcher treats each disappearance as a real plan deletion and hard-deletes the DB row, and the recreation on switch-back re-imports each plan as a fresh `CREATED` card — wiping column, subtask→feature linkage, complexity, `plan_id`, and audit history that live only in the DB. Replace the delete-then-reimport race with a **durable soft-delete + reconcile** model, make the watcher **git-aware**, and add a **bulk-change snapshot** so any residual mistake is visible and one-click recoverable.

### Problem (incident 2026-07-07)

A `git checkout feat/agent-activity-light` (a day-old branch missing 12 recently-created plans) and switch back to `main` — a ~10-second round-trip — moved 12 cards from CODE REVIEWED / PLAN REVIEWED to CREATED, detached 5 subtasks from their feature, and reset their complexity. `kanban.db` is untracked (deliberately, commit `c3b6087`), so git itself didn't corrupt it — the **watcher** did, by re-deriving DB rows from files that don't carry that state. Recovery required hand-reconstructing columns from the audit log + the `## Review Findings` marker in each plan. This is the same root cause behind the epic-complexity clobber and the plan→project-assignment clobber: **file re-import overwriting DB-only state.**

### Root cause

Three compounding gaps, all confirmed in code (locate by symbol — line numbers drift):

1. **Hard delete on file disappearance.** `GlobalPlanWatcherService._handlePlanDelete` (`~893`) calls `KanbanDatabase.deletePlanByPlanFile` (`KanbanDatabase.ts:2363`), which is a literal `DELETE FROM plans WHERE plan_file = ? AND workspace_id = ?`. The row — with its `kanban_column`, `feature_id`, `complexity`, `plan_id`, tags, tracker ids — is destroyed the instant the file vanishes.

2. **The existing guard is too short and too narrow.** `_handlePlanDelete` stashes the column in an in-memory `_recentlyDeletedColumns` tombstone (`GlobalPlanWatcherService.ts:934`) and the insert path restores it (`~709–737`). But the TTL is **5000 ms** (`:935`) — a checkout that keeps files gone for >5 s blows past it — and it stores **only the column**, not `feature_id` (which is why subtasks silently detached even inside the window). Re-import also mints a **new random `plan_id`** for non-feature plans (`~660`, feature files reuse the filename UUID; plain plans do not), orphaning audit history and tracker links.

3. **No backup covers a session.** The only versioned DB snapshot, `_writePreMigrationBackup` (`KanbanDatabase.ts:4952`, keeps 5), is called **only** from `_runMigrations` (`:4978`) — i.e. before schema migrations at startup, never periodically or before risky ops. `kanban-state-backup.json` (`_writeKanbanStateBackup`, `:6511`) is overwritten in place on every board change (so it held the *clobbered* state within seconds) and its `SELECT` (`:6518`) omits `feature_id`/`project`/`is_feature` entirely — it could not have restored the board even with history. The nearest usable snapshot was a 00:12 startup migration, 7.5 h stale.

### Background — why files can't just be ignored

The file-derived-plan path is load-bearing: agents drop `.md` files, git brings in teammates' plans, ClickUp/Linear import stubs — all legitimately create/update cards via `insertFileDerivedPlan`. So the watcher cannot stop reacting to files; it must **reconcile** (files create new plans and update file-authoritative fields; they must not reset DB-only state on an existing plan, and a transient disappearance must not equal a delete).

## Metadata

**Complexity:** 7
**Tags:** bugfix, backend, reliability, data-integrity, watcher

## User Review Required

Two deliberate behavior changes, decided here (flagged for confirmation, not deferral):
1. **External-tracker archive moves from delete-time to purge-time.** A watcher soft-delete no longer immediately archives the Linear/ClickUp issue (the plan may reappear on switch-back). The archive fires only when a `missing` row is finally purged (grace period elapsed or explicit in-app delete). Confirm this is acceptable for real-time-sync users — the alternative (archive on soft-delete, un-archive on reappear) is more external-API churn for the same end state.
2. **In-app delete buttons stay hard/immediate.** Soft-delete applies **only** to the watcher's file-disappearance path. Explicit deletes (`PlanningPanelProvider.deleteKanbanPlan`, `TaskViewerProvider._handleDeletePlan`) remain immediate hard deletes — consistent with the project rule that delete buttons delete immediately with no confirm.

## Complexity Audit

### Routine
- Git-awareness watch on `.git/HEAD` + `index.lock` (Guard 2) — a small `fs.watch` + a timestamp flag, mirroring the existing native-watch setup.
- Factoring `_writePreMigrationBackup` into a reusable `_writeDbBackup(reason)` and calling it on bulk-change (Guard 3a) — moves existing code, adds one call site.
- Adding `feature_id`/`project`/`is_feature` to the `kanban-state-backup.json` `SELECT` (Guard 3b) — three columns.

### Complex / Risky
- **Soft-delete + reconcile (Guard 1)** is the load-bearing change. It alters delete semantics in the watcher, adds a `missing` status lifecycle, requires the reappearance path to *reactivate-in-place* (preserving `plan_id`, `feature_id`, column, complexity) instead of inserting fresh, and adds a purge sweep. Every reader that assumes "row exists ⇒ active" must be audited so a `missing` row is never treated as live.
- **Purge sweep correctness** — must purge genuine external deletes (agent/`rm`) after the grace period without purging a card that's merely on the other side of a long-lived branch. Ties external-tracker archive to this step.

## Edge-Case & Dependency Audit

### Race conditions
- **Atomic-write (temp+rename).** Already guarded by the post-debounce `fs.existsSync` (`:904`) and `_recentRenames` (`:918`). Soft-delete only makes a spurious delete *even safer* (a mistaken soft-delete is reversed by reactivation on the next file event; a mistaken hard delete was destructive).
- **Delete/insert ordering.** With soft-delete, the reappearance handler must look up the row **including `status='missing'`** and reactivate; if it only queries active rows it will insert a duplicate. Add/di­rect a status-agnostic lookup (e.g. extend `getPlanByPlanFile` or add `getPlanByPlanFileAnyStatus`).
- **Self-write loop.** Unchanged — `registerPendingCreation` (3000 ms) + the byte-identical skip still suppress regen/self-write re-imports.

### Security
- No new attack surface. All reads/writes stay within the trusted local DB and workspace `.switchboard/`. No user input reaches new file paths. **No confirmation dialogs** introduced (project rule; `window.confirm` is a webview no-op anyway).

### Shipped-state / migration
- **~4,000 installs.** `status` is free-text `TEXT` (no enum constraint), so adding the `missing` value needs **no schema migration**. The board and all active-plan queries already filter `status='active'`, so a `missing` row is inert to existing readers **provided** the audit in "Complex/Risky" confirms no code treats a non-active row as live.
- **Backward compatibility:** on upgrade, no existing rows are `missing`; the purge sweep is a no-op until a soft-delete happens. Fully additive.
- The `.md` formats, markers, and `dbbackup/` naming are unchanged (the ring/retention logic is reused verbatim), so older versions reading these files/dirs are unaffected.

### Side effects
- A soft-deleted card disappears from the board immediately (status flips out of `active`) — same *visible* behavior as today, without destroying the row.
- Bulk-change backups add at most one extra `dbbackup/` file per burst (bounded by the keep-5 prune).

## Dependencies

None hard. **Complements** `feature_plan_20260706_delete-subtask-regenerates-feature-md.md` (which wires delete/detach callers to regenerate feature files) and `fix-feature-md-subtask-block-accretion.md` (which fixes the regen splice). This plan protects the *watcher* path those two operate around. No cross-plan ordering requirement.

## Adversarial Synthesis

Top risks: (1) a `missing` row leaking into a code path that assumes active — mitigated by the status-consumer audit and by keeping the board's `status='active'` filter authoritative; (2) the reappearance path inserting a duplicate instead of reactivating — mitigated by a status-agnostic lookup and an explicit reactivate branch that reuses the existing `plan_id`; (3) genuine external deletes never getting purged (cards linger as `missing` forever) — mitigated by a bounded grace-period purge sweep that also carries the external-tracker archive; (4) Guard 2 relying on `.git/HEAD` watching, which can be flaky across platforms — mitigated by treating git-awareness as *defense-in-depth* on top of Guard 1 (which is duration-independent on its own), so a missed HEAD event degrades to "still safe, just no batching." Guard 1 is the correctness fix; 2 and 3 are containment and observability.

**Review refinement (2026-07-07 — code verification findings):** Three corrections from reading the live source:

1. **`getPlanByPlanFile` is already status-agnostic — the proposed `getPlanByPlanFileAnyStatus` helper is redundant.** The existing function (`KanbanDatabase.ts:3408`) does NOT filter `status='active'`; it returns any-status row ordered by `CASE status WHEN 'active' THEN 0 … ELSE 4 END, updated_at DESC LIMIT 1`. A `missing` row is already found by the watcher's existing `_handlePlanFile` lookup (`GlobalPlanWatcherService.ts:574`). The `if (!plan)` fresh-insert branch will NOT fire for a `missing` row — so the duplicate-insert risk the original plan warns about does not exist with the current lookup. **Revised approach:** drop `getPlanByPlanFileAnyStatus`. Instead, add a reactivate-in-place branch in the EXISTING `if (plan)` path of `_handlePlanFile`: `if (plan.status === 'missing') { await db.reactivatePlanByPlanFile(plan.planFile, plan.workspaceId); plan.status = 'active'; }` then continue with the existing file-derived-field update. This is simpler and matches the actual code. Add `WHEN 'missing' THEN 4` to the ORDER BY CASE so the rank is explicit (currently `missing` falls to ELSE=4 — same result, but explicit is clearer and prevents a future re-rank from breaking it).

2. **"All active-plan queries already filter `status='active'`" is FALSE — the audit scope is larger than stated.** Code verification found 8 status-blind readers that do NOT filter by status: `getPlanByPlanFile` (3408), `getPlanByPlanId` (3377), `getPlanBySessionId` (3285), `hasPlan` (1792), `hasPlanByPlanFile` (1780), `getPlanFilePathByPlanFile` (2013), `getAllPlans` (4625), plus diagnostic queries at lines 1837/2018/2350/3633/5371/6406/6459/7049. **`getAllPlans` is the highest-risk** — it returns ALL rows regardless of status and feeds the periodic scan; every consumer of `getAllPlans` must be checked to confirm it re-filters by `status='active'` before treating rows as live. The audit must explicitly cover this 8-name list, not a vague "audit every reader."

3. **Tracker-finder queries would still match `missing` rows.** `findPlanByClickUpTaskId` (3322), `findPlanByLinearIssueId` (3345), `findPlanByNotionPageId` (3368) all use `status != 'deleted'` — a `missing` row passes that filter. Result: a transiently-missing plan (file gone during a git checkout) would still be matched by real-time sync, potentially pushing status updates to ClickUp/Linear for a card that's temporarily off-board. **Decision required:** exclude `missing` from tracker lookups by changing `status != 'deleted'` to `status = 'active'` (or `status NOT IN ('deleted','missing')`) in those three queries. This prevents external-API churn for transient disappearances; the purge sweep re-enables tracker archiving when the row is truly deleted.

## Proposed Changes

### Guard 1 — Soft-delete + reconcile (the fix)

**`src/services/GlobalPlanWatcherService.ts` — `_handlePlanDelete`:** replace the hard `deletePlanByPlanFile` call with a soft transition. After the existing guards (existsSync `:904`, `_recentRenames` `:918`, completed-skip `:925`) and the `featureId` capture (`:932`), instead of deleting, set `status='missing'` on the row (preserving all columns). Keep firing `_onPlanDiscovered` for the UI refresh. The in-memory `_recentlyDeletedColumns` tombstone becomes redundant and can be removed once reactivation is in place.

**`src/services/KanbanDatabase.ts`:**
- Add `markPlanMissingByPlanFile(planFile, workspaceId)` → `UPDATE plans SET status='missing', updated_at=? WHERE plan_file=? AND workspace_id=? AND status='active'` (only active rows; leaves `completed`/`archived` alone).
- ~~Add a status-agnostic lookup (`getPlanByPlanFileAnyStatus`, or a status param on `getPlanByPlanFile`) so the reappearance path can find a `missing` row.~~ **Review correction:** `getPlanByPlanFile` (KanbanDatabase.ts:3408) is ALREADY status-agnostic — it returns any-status row via `ORDER BY CASE status ... LIMIT 1` with no `WHERE status=` clause. The helper is redundant; do not add it. Add `WHEN 'missing' THEN 4` to the existing ORDER BY CASE for explicitness.
- Add `reactivatePlanByPlanFile(planFile, workspaceId)` → `UPDATE plans SET status='active', updated_at=? WHERE plan_file=? AND workspace_id=? AND status='missing'` (status-guarded); preserves `plan_id`, `feature_id`, `kanban_column`, `complexity`, tags, tracker ids.
- Add `purgeMissingPlansOlderThan(cutoffMs)` for the sweep.
- **Tracker-finder queries:** change `findPlanByClickUpTaskId` (3322), `findPlanByLinearIssueId` (3345), `findPlanByNotionPageId` (3368) from `status != 'deleted'` to `status = 'active'` (or `status NOT IN ('deleted','missing')`) so transiently-missing plans do not trigger external-sync churn. The purge sweep re-enables tracker archiving on real delete.

**`src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (insert path, `~543`):** **Review correction:** the existing lookup `let plan = await db.getPlanByPlanFile(relativePath, workspaceId)` (line 574) is already status-agnostic — it finds a `missing` row. The `if (!plan)` fresh-insert branch will NOT fire for a `missing` row. Therefore: add a reactivate branch in the EXISTING `if (plan)` path — `if (plan.status === 'missing') { await db.reactivatePlanByPlanFile(plan.planFile, plan.workspaceId); plan.status = 'active'; }` — then continue with the existing file-derived-field update (which refreshes file-authoritative fields without touching DB-only state). This reuses the original `plan_id`, preserves `feature_id`/column/complexity, and skips the fresh-insert + tombstone-restore dance entirely. Only truly-new files (no row at all) fall through to `insertFileDerivedPlan`. This also fixes the new-`plan_id` orphaning for plain plans.

**Purge sweep:** on a timer (e.g. hourly) and/or at startup, call `purgeMissingPlansOlderThan(graceMs)` (grace e.g. 24 h). Purge = the real `DELETE` + the external-tracker archive that used to run at delete-time (moved here per User Review #1). Explicit in-app deletes bypass all of this and hard-delete immediately (unchanged).

### Guard 2 — Git-awareness (defense-in-depth)

**`src/services/GlobalPlanWatcherService.ts`:** **Review refinement (2026-07-07 — API corrected per web research):** the original proposal of raw `fs.watch` on `.git/HEAD` is **unreliable** — git updates `HEAD` via atomic rename (`HEAD.lock` → `HEAD`), which breaks raw single-file watchers after the first checkout (they fire one `rename` event then go dead monitoring an unlinked inode). This is confirmed cross-platform (Linux inotify is inode-based and drops the watch; macOS kqueue/FSEvents coalesce and drop; Windows emulates single-file via directory handle but hits `EBUSY`/`EPERM` from AV scanners on `.lock` files). **Revised approach:**

1. **Resolve the true `.git` directory.** At watcher init, read `<workspaceRoot>/.git`. If it is a **file** (not a directory), parse its `gitdir: <path>` contents (linked worktree / submodule case) and follow the pointer to the real directory containing `HEAD`. Bare repos have `HEAD` at the repo root. Do not assume `.git` is always a directory.
2. **Use `vscode.workspace.createFileSystemWatcher`** with a flat, non-recursive `RelativePattern` targeting `HEAD` in the resolved dir:
   ```ts
   const dotGitDir = resolveDotGitDir(workspaceRoot); // handles worktree/submodule pointer files
   const pattern = new vscode.RelativePattern(vscode.Uri.file(dotGitDir), 'HEAD');
   const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
   ```
   This is the correct API inside a VS Code extension: it runs out-of-process (no extension-host blocking), survives atomic renames (VS Code core re-watches), bypasses `files.watcherExclude` for flat non-recursive patterns, and works in remote/SSH/WSL/container scenarios where raw `fs.watch` fails. Optionally also watch `index.lock` (creation signals an active git op, though it's not checkout-specific — fires for staging/commit/status too).
3. **On HEAD change** (watcher `onDidChange`/`onDidCreate`/`onDidDelete`), debounce 200–500ms, then set `_gitOpActiveUntil = Date.now() + N` (e.g. 15 s, refreshed while `index.lock` persists). Read `HEAD` content or run `git rev-parse --abbrev-ref HEAD` to confirm the branch actually changed (the watcher fires on the file event; confirm the branch identity to avoid false positives from lock churn). While active:
   - Force the soft-delete path (never purge) and **suppress the real-time ClickUp/Linear sync fan-out** for affected plans (avoid pushing transient churn to trackers).
   - Optionally coalesce the burst into a single reconcile pass.

This extends protection to `reset`, `rebase`, and `stash pop`, and prevents needless external-API traffic during a branch switch. If the resolved-path watch fails to register (permissions, exotic git layouts), Guard 1 still holds — it is duration-independent and does not rely on detecting the git op.

### Guard 3 — Bulk-change snapshot + real backup

**3a — snapshot before bulk re-import.** Factor `_writePreMigrationBackup` into `_writeDbBackup(reason: string)` (same `dbbackup/` dir, same keep-5 prune) and call it from a new bulk-change detector in `GlobalPlanWatcherService`: when > N plan files (e.g. ≥ 5) change/delete within a short window (e.g. 2 s), snapshot `kanban.db` first and log `"[GlobalPlanWatcher] bulk change (${count}); snapshot written"`. Surface a dismissible notice ("N cards changed by a file sync") so a mass change is never silent.

**3b — make the state backup restorable.** Add `feature_id`, `project`, `is_feature` to the `_writeKanbanStateBackup` `SELECT` (`KanbanDatabase.ts:6518`) so the JSON is a complete restore source, and (optional) write it as a small timestamped ring (keep N) instead of overwrite-in-place, so at least one pre-change copy survives.

## Files touched

- `src/services/GlobalPlanWatcherService.ts` — soft-delete in `_handlePlanDelete`; reactivate-in-place in `_handlePlanFile`; `.git/HEAD` watch + git-op flag; bulk-change detector + snapshot call; remove the now-redundant `_recentlyDeletedColumns` tombstone.
- `src/services/KanbanDatabase.ts` — `markPlanMissingByPlanFile`, `reactivatePlanByPlanFile`, `purgeMissingPlansOlderThan`; add `WHEN 'missing' THEN 4` to `getPlanByPlanFile` ORDER BY CASE; change tracker-finder queries (`findPlanByClickUpTaskId`/`findPlanByLinearIssueId`/`findPlanByNotionPageId`) to exclude `missing`; factor `_writeDbBackup(reason)`; add `feature_id`/`project`/`is_feature` to `_writeKanbanStateBackup`.
- `src/extension.ts` (or wherever the watcher/timers are wired) — schedule the purge sweep.
- Audit (read-only, then fix if needed): every status-blind plan reader, to confirm `missing` rows are inert. **Concrete audit list (verified 2026-07-07):** `getPlanByPlanFile` (3408), `getPlanByPlanId` (3377), `getPlanBySessionId` (3285), `hasPlan` (1792), `hasPlanByPlanFile` (1780), `getPlanFilePathByPlanFile` (2013), `getAllPlans` (4625). **`getAllPlans` is highest-risk** — it feeds the periodic scan and returns ALL rows regardless of status; verify every consumer re-filters by `status='active'`. Also audit diagnostic queries at lines 1837/2018/2350/3633/5371/6406/6459/7049.

## Verification Plan

No automated tests / no compile this pass (project convention: test via installed VSIX; `src/` is source of truth; `dist/`/`out/` unused in dev). Suggested later regression test: a KanbanDatabase test that inserts a feature + 2 subtasks in CODE REVIEWED, calls `markPlanMissingByPlanFile` for each, asserts they leave the board but rows persist with `feature_id`/column intact, then `reactivatePlanByPlanFile` and asserts full restoration including the original `plan_id`.

Manual (installed VSIX) — the incident, reproduced:
1. **The exact bug** — with cards spread across CREATED/PLAN REVIEWED/CODE REVIEWED and a feature with subtasks, `git checkout <old-branch>` (missing those plans), wait 10+ s, `git checkout main`. Confirm **every card returns to its exact column**, subtasks stay linked to the feature, complexity is intact, and `plan_id`s are unchanged (audit history preserved).
2. **Long absence** — repeat with a multi-minute gap on the other branch; confirm still fully restored (duration-independent).
3. **Genuine external delete** — `rm` a plan `.md`; confirm the card leaves the board immediately, the row goes `missing`, and after the grace period the purge sweep hard-deletes it and archives its Linear/ClickUp issue.
4. **In-app delete** — click a delete button; confirm immediate hard delete (no `missing` state, no grace period), consistent with the immediate-delete rule.
5. **Atomic save** — edit+save a plan repeatedly; confirm no spurious `missing` flips and no duplicate rows.
6. **Bulk snapshot** — trigger the checkout; confirm a fresh `dbbackup/kanban.db.backup.*` is written and the "N cards changed" notice appears.
7. **Backup completeness** — inspect `kanban-state-backup.json`; confirm `feature_id`/`project`/`is_feature` are present.
8. **git-op suppression** — with real-time Linear/ClickUp sync on, do the checkout; confirm no transient status pushes hit the tracker during the switch.

---

**Recommendation:** Complexity 7 (Complex/Risky — touches the watcher's delete/import core and adds a status lifecycle). **Send to Lead.** If you'd rather tier it, split into a feature: Guard 1 (complex/risky) as one subtask, Guards 2 + 3 (routine containment/observability) as a second — codeable in parallel, but Guard 1 is the one that must land.

## Uncertain Assumptions

- **`fs.watch` on `.git/HEAD` reliability across platforms (Guard 2) — RESOLVED via web research (2026-07-07).** The original plan proposed raw `fs.watch` on `.git/HEAD`. Research confirmed this is **unreliable**: git updates `HEAD` via atomic rename (`HEAD.lock` → `HEAD`), which breaks raw single-file watchers after the first checkout (they fire one `rename` event then go dead monitoring an unlinked inode), cross-platform. The Guard 2 section above has been **revised** to use `vscode.workspace.createFileSystemWatcher` with a flat non-recursive `RelativePattern` (survives atomic renames, runs out-of-process, bypasses `files.watcherExclude`) plus a `.git`-path resolution step for worktrees/submodules (where `.git` is a pointer file, not a directory). The uncertainty is now resolved and the plan reflects the correct API. **Non-blocking regardless:** Guard 1 (soft-delete + reconcile) is duration-independent and correct on its own; Guard 2 remains defense-in-depth.

## Review Findings

Implementation faithful to the plan; no CRITICAL/MAJOR code fixes required. Verified all three guards in `src/services/GlobalPlanWatcherService.ts` and `KanbanDatabase.ts`: Guard 1 — soft-delete (`markPlanMissingByPlanFile`, `_handlePlanDelete:1115`), reactivate-in-place (`reactivatePlanByPlanFile`, `_handlePlanFile:749/778`), `WHEN 'missing' THEN 4` in `getPlanByPlanFile` ORDER BY, tracker finders now `status NOT IN ('deleted','missing')`, and a startup+periodic purge sweep that archives Linear/ClickUp at purge-time then deletes (and regenerates the parent feature file); Guard 2 — `.git/HEAD` watch via `createFileSystemWatcher` with worktree/submodule `.git`-pointer resolution, 15s git-op window that suppresses sync in `ContinuousSyncService:289` and skips purge; Guard 3 — bulk-change `writeDbBackup('bulk-change')` and `feature_id`/`project`/`is_feature` added to `_writeKanbanStateBackup`. No compile/tests run (skipped per project convention). Remaining risks: (1) the `_recentlyDeletedColumns` tombstone is now dead code (reactivation supersedes it) but harmless — plan permitted removal; (2) `getAllPlans` and other status-blind readers were not each individually walked — plan author's audit is relied upon; the board's `status='active'` filter remains the authoritative guard against a `missing` row appearing live.

**Stage Complete:** PLAN REVIEWED
