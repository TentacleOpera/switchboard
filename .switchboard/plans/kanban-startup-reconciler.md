# Kanban Startup Reconciler for Remote Plan Status Changes

## Goal

Add a startup reconciliation step to the Switchboard extension that queries Linear/Notion on IDE load, detects plan statuses updated by a remote agent since the last sync, and advances the corresponding kanban cards in `kanban.db` — without requiring a manual card move or a git pull.

### Problem & Background

When a remote agent uses `/improve-remote-plan`, it writes improved content and updates the plan status in Linear/Notion. But the Switchboard extension only processes Linear/Notion status changes in "active polling" mode — which assumes the local machine is running and the user is actively working. When the machine was off, those status changes accumulate unprocessed. On next IDE startup, the extension loads `kanban.db` from disk, which has stale column state — the cards are still in their pre-remote-session column.

There is no timing problem with a startup reconciler (unlike a local `pending-moves.json` file) because the extension queries Linear/Notion directly during startup, not from the filesystem. The remote state is always available regardless of git pull order.

The natural insertion point is `initializeKanbanDbOnStartup()` in `src/services/TaskViewerProvider.ts` (line 2491), which already runs after the kanban DB is loaded and before the webview renders.

### Codebase Findings — Correction of Original Plan Assumptions

**The original plan (Implementation Tasks below) was written without reading the actual remote-control code.** Several of its core assumptions are incorrect. The corrected approach reuses existing infrastructure rather than building a parallel pipeline. Key findings:

1. **`last_remote_sync` key does NOT exist.** The plan's Step 1 references "the `last_remote_sync` timestamp from `kanban.db` config table (key already used by the existing polling sync)." This key does not exist anywhere in the codebase. The real cursors are `remote.stateCursor.${kind}` and `remote.commentCursor.${kind}` (where `kind` is `'linear'` or `'notion'`), managed by `RemoteControlService` (`src/services/RemoteControlService.ts` lines 58–59). These are ISO-timestamp high-watermarks stored via `db.getConfig(key)` / `db.setConfig(key, value)`.

2. **The "last 7 days" fallback is wrong and dangerous.** The existing code has an explicit "seed-on-first-poll: baseline to `now` and process nothing" guard (`RemoteControlService.ts` lines 259–264) that EXISTS to prevent replaying an existing board's history as a burst of agent runs. A 7-day fallback would blast 7 days of accumulated status changes through the dispatch pipeline on first run — exactly what the design fights to prevent.

3. **`RemoteControlService._poll()` already does everything the plan describes** — and more. A single `_poll()` cycle (line 192): fetches state deltas + comment deltas since the cursor, imports new remote plans that have no local card, maps remote state → kanban column, moves the card, **dispatches the destination column's agent**, refreshes the local plan file from the remote body, and advances the cursor. All with echo guards (line 295), seed-on-first-poll (line 260), overlap protection (`_polling` flag, line 193), and processed-comment de-dup.

4. **The REAL gap is narrow:** In `manual` ping mode (the **default** — `DEFAULT_REMOTE_CONFIG.pingMode = 'manual'`), `restoreFromConfig()` (`RemoteControlService.ts` line 183) does NOT auto-start polling. It is called from `KanbanProvider`'s webview `'ready'` handler (`src/services/KanbanProvider.ts` line 5162) but only starts the timer in `constant` mode. So in manual mode, accumulated remote changes are never processed at startup. In `constant` mode, `start()` schedules the timer but the first poll is delayed by `pingFrequencySeconds` (30–120s). A one-shot reconcile at startup closes both gaps.

5. **"Filter to status changes only" is already handled** — but not via a separate filter. `fetchStateDeltas()` returns ALL issues with `updatedAt > cursor` (including description edits). The echo guard `targetColumn === plan.kanbanColumn` (`RemoteControlService.ts` line 295) no-ops a description-only edit because the state key didn't change. No new filtering logic is needed.

6. **"Card not found → skip" is wrong.** The existing `_pollState()` (line 272) calls `provider.importRemotePlan(d.remoteId)` to CREATE the local plan + DB record for remotely-authored plans. It does not skip them. The plan's "skip, let the file watcher handle it" policy would lose plans authored remotely.

7. **"Apply latest status only" is already handled.** The delta query returns each issue's current state (not historical transitions), so the latest status is inherently what's applied.

8. **Insertion point is correct but the wiring must go through `KanbanProvider`.** `initializeKanbanDbOnStartup()` (line 2491) is a good insertion point — it runs during `activate()` (`src/extension.ts` line 798) before the webview loads, so it always executes. But `RemoteControlService` is owned by `KanbanProvider` (`_getRemoteControl()`, `KanbanProvider.ts` line 1438), not `TaskViewerProvider`. The call must go through `this._kanbanProvider`.

**Clarification — dispatch behavior:** Reusing `_poll()` means the startup reconciler will also DISPATCH the destination column's agent (via `onColumnMove` → `_remoteApplyColumnMove` → `_remoteDispatchColumnAgent`), not just move the card. This is consistent with existing `constant`-mode behavior (where the first poll also dispatches). See **## User Review Required** for the decision point.

---

## Metadata

**Complexity:** 4
**Tags:** backend, infrastructure, reliability, feature

## User Review Required

**Decision: Should the startup reconciler dispatch column agents, or only move cards?**

Reusing the existing `_poll()` path means every remotely-moved card triggers an agent dispatch at startup (identical to constant-mode behavior). The alternative — card-move-only without dispatch — would require a NEW code path that bypasses `_applyStateMirror()`, which contradicts the plan's own "do not duplicate" principle and breaks consistency between startup and active polling.

- **Recommended (default):** Reuse `_poll()` → dispatch agents. Consistent, minimal code, echo-guarded. A user who opens their IDE after a weekend gets agents running for cards that genuinely moved — same as if they'd been in constant mode.
- **Alternative (more work):** Card-move-only. Requires a new `_applyStateMirrorNoDispatch()` variant or a flag on `_poll()`. Only justified if dispatch storms are a demonstrated problem.

The plan proceeds with the recommended approach. **Flag for user confirmation before implementation.**

## Complexity Audit

### Routine
- Adding a public `reconcileOnce()` wrapper around the existing private `_poll()` — ~3 lines, no new logic.
- Adding a public passthrough on `KanbanProvider` that gets the `RemoteControlService` and calls `reconcileOnce()` — ~8 lines.
- Calling the passthrough from `initializeKanbanDbOnStartup()` inside the existing per-root loop, wrapped in try/catch — ~5 lines.
- All three changes delegate to existing, tested infrastructure (cursors, delta queries, echo guards, import logic, state→column mapping).

### Complex / Risky
- **Agent dispatch at startup** — reusing `_poll()` inherits the dispatch behavior. If many remote changes accumulated while the machine was off, multiple agents may start simultaneously on next IDE load. Mitigated by the echo guard (only cards whose column ACTUALLY changed get dispatched) and seed-on-first-poll (fresh installs process nothing).
- **Interaction with the existing 'ready' handler restore** — `restoreFromConfig()` runs later (when the webview opens) and may start the timer in constant mode. Must ensure `reconcileOnce()` (early, in `activate()`) and `restoreFromConfig()` (later, in 'ready') don't conflict. They don't: `reconcileOnce()` doesn't set `_active` or start a timer, and `restoreFromConfig()` only starts a timer (no immediate poll in constant mode).

## Edge-Case & Dependency Audit

- **Race Conditions:** The `_polling` flag (`RemoteControlService.ts` line 193) prevents overlapping poll cycles. If the user manually clicks "start pinging" while `reconcileOnce()` is running, the second `_poll()` returns early — changes are picked up on the next timer tick. Safe.
- **Security:** No new credentials or API surface. Reuses the existing provider clients (`LinearRemoteProvider`, `NotionRemoteProvider`) and their existing auth. No new network endpoints.
- **Side Effects:** Agent dispatch at startup (see User Review Required). Card column transitions in `kanban.db`. Local plan files refreshed from remote bodies via `refreshLocalPlanFromRemote()`. Cursor advancement in the DB config table. All identical to a normal polling cycle.
- **Dependencies & Conflicts:**
  - Depends on the existing `RemoteControlService` / `RemoteProvider` infrastructure being intact.
  - The `improve-remote-plan` skill (`improve-remote-plan-skill.md`) is the primary consumer — it writes status changes to Linear/Notion that this reconciler picks up. The reconciler does NOT depend on the skill being deployed; it processes any remote status change regardless of source.
  - `NotionBackupService.setupRemoteControl()` (`src/services/NotionBackupService.ts` line 312) seeds the Notion cursors to `now` during initial setup. The reconciler respects these cursors — no conflict.

## Dependencies

- `improve-remote-plan-skill.md` — the remote skill that produces the status changes this reconciler consumes. Not a hard dependency (reconciler processes any remote status change), but the two are designed as a pair.

## Adversarial Synthesis

Key risks: (1) the original plan fabricated a `last_remote_sync` key and a parallel reconciliation pipeline that duplicates 100% of the existing `_poll()` infrastructure; (2) reusing `_poll()` inherits agent-dispatch-at-startup behavior that the plan never acknowledged. Mitigations: the corrected plan reduces to a ~16-line thin wrapper (`reconcileOnce()` + passthrough + call site) that delegates entirely to the existing, echo-guarded, seed-on-first-poll-protected delta-polling path; the dispatch behavior is flagged as a User Review decision with the consistent default (reuse `_poll()` → dispatch).

## Proposed Changes

### [MODIFY] `src/services/RemoteControlService.ts` — Add `reconcileOnce()` public method

**Context:** The class already has `start()` (line 151) which in manual mode runs a one-time `_poll()` before scheduling the timer, and `restoreFromConfig()` (line 183) which only auto-starts in constant mode. The gap is that nothing triggers a one-shot `_poll()` at startup in manual mode.

**Logic:** Add a public method that runs a single `_poll()` cycle without setting `_active = true` and without starting the timer. Place it near `restoreFromConfig()` (after line 188).

```typescript
/**
 * One-shot reconciliation: run a single poll cycle (state + comments) without
 * starting the polling timer or marking the service active. Called at IDE startup
 * so cards advance from remote status changes that accumulated while the machine
 * was off — regardless of ping mode. Reuses the existing cursor, echo-guard, and
 * seed-on-first-poll logic; no parallel pipeline.
 */
public async reconcileOnce(): Promise<void> {
    await this._poll();
}
```

**Edge Cases:**
- No config / no boards → `_poll()` returns early at line 200 (`config.boards.length === 0`). Clean no-op.
- No provider available → `_poll()` logs and returns at line 203. Clean no-op.
- No cursor yet → seed-on-first-poll (line 260) baselines to `now`, processes nothing. No history replay.
- Network failure → `_poll()` catch block (line 212) logs the error. Call-site try/catch prevents startup blocking.
- Overlap with an active poll → `_polling` guard (line 193) returns early.

### [MODIFY] `src/services/KanbanProvider.ts` — Add `reconcileRemoteOnStartup()` public method

**Context:** `_getRemoteControl()` (line 1438) constructs and caches `RemoteControlService` instances per workspace root. The 'ready' handler (line 5162) calls `restoreFromConfig()` but only for the current workspace root, and only starts the timer in constant mode.

**Logic:** Add a public method that gets the `RemoteControlService` for a workspace root and calls `reconcileOnce()`. Place it near `_getRemoteControl()` (after line 1471).

```typescript
/**
 * §10 — One-shot remote reconciliation at startup. Runs a single poll cycle for
 * the given workspace root so cards advance from remote status changes that
 * accumulated while the machine was off. Does NOT start the polling timer.
 * Safe to call regardless of ping mode; no-op if remote control is unconfigured.
 */
public async reconcileRemoteOnStartup(workspaceRoot: string): Promise<void> {
    try {
        const rc = this._getRemoteControl(workspaceRoot);
        await rc.reconcileOnce();
    } catch (e) {
        this._outputChannel?.appendLine(`[RemoteControl] Startup reconcile failed for ${workspaceRoot}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
```

**Edge Cases:**
- `_getRemoteControl()` constructs the service lazily (line 1442) — safe even if remote control was never configured (the service's `getConfig()` returns defaults, `_poll()` no-ops).
- The try/catch ensures a failure in one workspace root doesn't block others.

### [MODIFY] `src/services/TaskViewerProvider.ts` — Call reconciler in `initializeKanbanDbOnStartup()`

**Context:** `initializeKanbanDbOnStartup()` (line 2491) loops over workspace roots (line 2508), bootstraps the DB (lines 2514–2534), and defers orphan detection (lines 2536–2540). It runs during `activate()` (`src/extension.ts` line 798) before the webview loads.

**Logic:** After the DB bootstrap block (after line 2534, before the orphan-detection comment at line 2536), call the reconciler via `this._kanbanProvider`. This is inside the existing per-root try/catch (line 2509–2543), so failures are caught per-root.

```typescript
// Inside the `for (const workspaceRoot of rootsToBootstrap)` loop,
// after the DB bootstrap if/else block (line 2534), before orphan detection:

// §10 — Reconcile remote status changes that accumulated while the machine was off.
// One-shot poll; does not start the polling timer. No-op if remote control is unconfigured.
if (this._kanbanProvider) {
    try {
        await this._kanbanProvider.reconcileRemoteOnStartup(workspaceRoot);
    } catch (e) {
        console.error(`[TaskViewerProvider] Remote reconcile failed for ${workspaceRoot}:`, e);
    }
}
```

**Edge Cases:**
- `this._kanbanProvider` may be undefined in edge cases — guarded by the `if` check.
- The call is inside the per-root try/catch, so a reconcile failure in one root doesn't abort the loop.
- The reconcile runs AFTER the DB is bootstrapped (line 2534), so `kanban.db` is populated before the poll queries it.

## Verification Plan

### Automated Tests

> Per session directives: compilation and automated tests are NOT run in this session. The following documents what tests would verify the change; the user will run the suite separately.

1. **Unit test — `reconcileOnce()` delegates to `_poll()`:** In `src/test/integrations/shared/remote-control-service.test.js`, add a case that calls `reconcileOnce()` on a service backed by a fake provider + fake DB, and asserts: (a) state deltas are fetched and applied, (b) `_active` remains `false` after the call, (c) no timer is scheduled. The existing test harness (`makeDb` / `makeService` / fake provider) supports this directly.
2. **Unit test — no-op when unconfigured:** Assert `reconcileOnce()` with empty `boards` config does not call `fetchStateDeltas` and does not throw.
3. **Unit test — seed-on-first-poll respected:** Assert that with no existing cursor, `reconcileOnce()` baselines the cursor to `now` and processes zero deltas (no history replay).
4. **Integration check (manual):** In a workspace with Linear/Notion remote control configured in manual mode, change a linked issue's status remotely, restart the IDE, and confirm the kanban card advances without manually starting pinging.

## Uncertain Assumptions

No uncertain assumptions. All findings are verified against the actual source code (`RemoteControlService.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `RemoteProvider.ts`, `LinearRemoteProvider.ts`, `NotionRemoteProvider.ts`, `extension.ts`). No web research is needed for this plan.

---

## Original Plan Content (Preserved — Superseded by Codebase Findings Above)

> The following is the original plan text, preserved per the content-preservation rule. The **Codebase Findings** section above corrects the assumptions here. Implementers should follow **## Proposed Changes**, not the tasks below.

### 1. Identify the sync timestamp

The reconciler needs to know what "since last sync" means. Options:
- Read the `last_remote_sync` timestamp from `kanban.db` config table (key already used by the existing polling sync)
- Fall back to "last 7 days" if no timestamp exists (covers the case where polling was never run)

Use whichever timestamp the existing polling sync already writes — do not create a new timestamp key unless one doesn't exist.

> **CORRECTION:** `last_remote_sync` does not exist. The real cursors are `remote.stateCursor.${kind}` / `remote.commentCursor.${kind}`. The 7-day fallback is wrong — the existing seed-on-first-poll guard baselines to `now` to avoid history replay. The corrected approach reuses `_poll()` which already manages these cursors.

### 2. Add `reconcileRemoteStatusChanges()` to TaskViewerProvider

**Location:** `src/services/TaskViewerProvider.ts`

**Call site:** At the end of `initializeKanbanDbOnStartup()`, after the existing plan import logic.

**Logic:**
```
reconcileRemoteStatusChanges(db, workspaceRoot):
  1. Check if remote control is configured and enabled for this workspace
     - Read remote config from kanban.db (key: remote.config)
     - If not configured or disabled: return immediately (no-op)
  2. Determine since-timestamp (last_remote_sync or 7-day fallback)
  3. Query Linear/Notion for issues in the mapped project updated since that timestamp
     - Use the existing remote control service/client (do not create new API wrappers)
     - Filter to issues whose status changed (not just description edits)
  4. For each changed issue:
     a. Find matching kanban card by Linear issue ID or plan file path stored in the card's metadata
     b. If found: move card to the column mapped to the new Linear/Notion status
     c. If not found: log a warning, skip (do not create a new card — that's the file watcher's job)
  5. Update last_remote_sync timestamp in kanban.db
  6. Log a summary: "Startup reconciler: N cards advanced from remote status changes"
```

> **CORRECTION:** This entire pseudo-code pipeline is replaced by a single `reconcileOnce()` → `_poll()` delegation. Steps 1–6 are all already implemented inside `_poll()`. The "skip not-found cards" policy (4c) is wrong — the existing code imports new remote plans. The "filter to status changes" (step 3) is handled by the echo guard. The "update last_remote_sync" (step 5) is the cursor advancement already in `_pollState()` (line 284).

### 3. Reuse existing remote control client

The extension already has a Linear/Notion client used by the polling sync. The reconciler must use the same client and the same status→column mapping logic — do not duplicate it. Identify the service class handling remote polling (likely in `src/services/` or `src/remote/`) and call it from the reconciler.

> **CORRECTED DETAIL:** The service is `RemoteControlService` (`src/services/RemoteControlService.ts`), with providers in `src/services/remote/` (`LinearRemoteProvider.ts`, `NotionRemoteProvider.ts`). It is owned by `KanbanProvider` (`_getRemoteControl()`, line 1438), not `TaskViewerProvider`.

### 4. Startup mode flag

The reconciler runs once at startup and then stops. It must not start a polling interval. Add a clear comment distinguishing it from the active polling mode.

> **CONFIRMED:** The corrected `reconcileOnce()` method does exactly this — it calls `_poll()` without setting `_active` or scheduling a timer.

### Original Edge Cases & Risks

- **Remote control not configured**: Must be a clean no-op — no error, no warning, just skip
- **Network unavailable at startup**: Wrap the Linear/Notion query in a try/catch; log the failure but do not block the rest of startup
- **Card not found for a changed issue**: This can happen if the plan was created remotely and hasn't been imported to kanban.db yet. Log it, skip it — the file watcher or next polling cycle will handle import
- **Multiple status changes since last sync**: Apply the latest status only (the issue's current state), not intermediate transitions
- **Timestamp drift**: If the local machine clock differs significantly from Linear/Notion server time, the since-timestamp filter may miss changes. Use a small buffer (e.g. subtract 5 minutes from last_remote_sync)
- **Rate limits**: The startup query is a single list call per workspace — well within Linear/Notion limits. Do not paginate unnecessarily; limit to recently updated issues

> **CORRECTIONS:** "Card not found → skip" is wrong (existing code imports). "Timestamp drift / 5-minute buffer" is already handled by the providers' inclusive `on_or_after` / `gt` cursor semantics plus the echo guard. "Rate limits" — the existing `fetchStateDeltas` already limits to 100 issues (Linear) / 500 pages (Notion) per query. All other edge cases are handled by `_poll()`'s existing try/catch and the call-site try/catch.

### Original Out of Scope

- Creating new kanban cards for remotely-created plans (handled by the existing file watcher / plan import)
- Syncing plan content changes back to `.md` files (the remote plan stays in Linear/Notion)
- ClickUp support (follow-on)
- Changing the active polling mode

> **CORRECTION:** "Creating new kanban cards for remotely-created plans" is NOT out of scope for the reconciler — the existing `_pollState()` (line 272) already imports them via `importRemotePlan()`. The corrected plan inherits this behavior. "Syncing plan content changes back to `.md` files" is also already handled — `_applyStateMirror()` calls `refreshLocalPlanFromRemote()` (line 301) before dispatch.

---

**Recommendation:** Complexity 4 → **Send to Coder**. The corrected implementation is a ~16-line thin wrapper across 3 files, all delegating to existing tested infrastructure. The primary risk (agent dispatch at startup) is a User Review decision, not an implementation complexity.
