# Worktree State Must Hydrate Automatically After A Window Reload

**Plan ID:** 0d6e4f1a-3c5b-4d78-be9f-2a34b5c6d7e8

## Goal

After a VS Code window reload, the worktree state in the kanban board (the `wt-indicator` worktree badge and the WORKTREES tab list) must reappear without the user having to manually click into the WORKTREES tab. Today, after a reload the board shows no worktree indicator and the WORKTREES tab reads "No active worktrees" until the user clicks away and back — which reads as "my worktrees are gone."

### Problem analysis / root cause

Worktree rows **do persist** in the SQLite `worktrees` table (`status='active'`, `KanbanDatabase.ts:165-177`) and the on-disk git worktree directories survive a reload. There is no startup pruning/reconciliation that marks worktrees inactive (the only `_pruneWorktrees` / `updateWorktreeStatus` calls are inside merge/abandon/cleanup flows). So this is **not data loss** — it is a **UI hydration gap**.

The gap: worktree config is pushed to the webview **only reactively**, never proactively during a board refresh.

- `_sendWorktreeConfig(workspaceRoot)` (`KanbanProvider.ts:8921`) is the only thing that posts a `worktreeConfig` message. It is called from `getWorktreeConfig` (tab activation) and after every worktree mutation (create/merge/abandon/toggle) — 14 call sites (lines 7819, 7848, 7883, 7918, 7965, 7979, 7990, 7996, 8012, 8057, 8067, 8079, 8092, 8112), all reactive. It is **never** called from the active refresh path.
- **The active refresh path is `refreshWithData` (`KanbanProvider.ts:1237`), NOT `_refreshBoardImpl`.** `_refreshBoardImpl` (line 2220) is **DEAD CODE** — zero production call sites; the comment at line 2418 says "This method is currently dead code... Kept for potential future use." The original plan mistakenly targeted `_refreshBoardImpl`; the fix must target `refreshWithData`.
- `refreshWithData` is driven by `TaskViewerProvider._refreshRunSheetsImpl` (`TaskViewerProvider.ts:15399`), which is the path triggered on panel restore / reload (via `deserializeWebviewPanel` → webview 'ready' → `switchboard.fullSync`). It posts `updateBoard` (with a *partial* `epicWorktrees` map, lines 1400-1402) but **never** calls `_sendWorktreeConfig`. So after a reload, the full worktree list + indicator are not pushed.
- On the webview side, `lastWorktreeConfig` starts as `null` (`kanban.html:6069`) and is only set inside `case 'worktreeConfig'` (`kanban.html:6308-6317`). The worktree indicator (`updateWorktreeIndicator`, `kanban.html:5131`) is only updated from that same handler (`kanban.html:6311-6316`). The WORKTREES tab only fetches config when it is activated: `loadWorktreeConfig()` (defined at `kanban.html:9266`, called from the tab click handler at `kanban.html:3963`).

Net effect after a reload: the board refreshes its cards via `refreshWithData`, but `worktreeConfig` is never sent → `lastWorktreeConfig` stays `null` → indicator hidden → WORKTREES tab shows "No active worktrees" on first render. The moment the user clicks the WORKTREES tab, `loadWorktreeConfig()` round-trips and the worktrees reappear — but by then the user has already concluded the worktrees didn't persist.

The fix is to push worktree config as part of `refreshWithData` so it hydrates automatically.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, ui, refactor

## User Review Required

None. (If the team later prefers to avoid pushing `worktreeConfig` on every refresh, the alternative is a signature-based short-circuit — noted in §Edge-Case chattiness — but that is an optimization and not needed to fix the reload bug.)

## Current State

- `refreshWithData` already reads `db.getWorktrees()` once at line 1399 (to build the `epicWorktrees` map for `updateBoard`), so the data is already in hand — it just isn't shaped/sent as a full `worktreeConfig` message.
- `_sendWorktreeConfig` is self-contained: it re-reads `getWorktrees()` (line 8924), resolves epic topic/project, and posts `worktreeConfig` (with `suppressMainTerminals`, `epicWorktreeMode`, `projects`, `epics`, `availableRepos`, `activeRepoFilter`). It no-ops gracefully when the DB isn't ready (`KanbanProvider.ts:8923`) and when the panel is gone (posts via `this._panel?.webview.postMessage`, line 8980).
- The webview `worktreeConfig` handler (`kanban.html:6308-6317`) is idempotent (overwrites `lastWorktreeConfig = msg` at line 6309, calls `renderWorktreesTab()` which clears/rebuilds DOM, calls `updateWorktreeIndicator()`), so sending it on every refresh is safe.
- **Note:** calling `_sendWorktreeConfig` at the end of `refreshWithData` duplicates the `getWorktrees()` read already done at line 1399 (since `_sendWorktreeConfig` re-reads at line 8924). This is one extra SQLite read per refresh — cheap (indexed) and acceptable for correctness. Could be optimized later by passing the already-read worktrees into `_sendWorktreeConfig`, but that changes its signature and is out of scope for this fix.

## Complexity Audit

### Routine
- One additional `await this._sendWorktreeConfig(resolvedWorkspaceRoot)` call in `refreshWithData`, after the `updateBoard` postMessage block (after line 1420).
- (Optional, defensive) One `loadWorktreeConfig()` call in `kanban.html`'s DOMContentLoaded init.

### Complex / Risky
- None. No schema change, no webview change (the handler already exists and is idempotent), no new message type.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `refreshWithData` is async and sequential; the `_sendWorktreeConfig` call runs after `updateBoard` is posted, so cards are rendered before the worktree indicator updates.
- **Security:** No untrusted input; workspaceRoot is resolved via `path.resolve`.
- **Side Effects:** Each `refreshWithData` call (plan imports, column moves, workspace switches, file-watcher scans) will now also push `worktreeConfig`. The cost is one `getWorktrees()` read + O(active epic worktrees) `getPlanByPlanId` lookups + one postMessage + an idempotent webview re-render. This is cheap and keeps worktree state truthful (e.g. externally-deleted worktrees' indicator clears on the next refresh).
- **Dependencies & Conflicts:** None. This plan is independent of the other epic subtasks.
- **DB not ready** — `_sendWorktreeConfig` already guards on `db.ensureReady()` and returns silently (`KanbanProvider.ts:8923`), and `refreshWithData` already branches on `dbReady`. Calling it unconditionally at the end is safe.
- **No panel yet** — `_sendWorktreeConfig` posts via `this._panel?.webview.postMessage` (optional chaining, line 8980), so it no-ops if the panel is gone. (`refreshWithData` itself early-returns if `!this._panel` at line 1244, so this is belt-and-suspenders.)
- **Chattiness** — `refreshWithData` runs frequently. Each will now also push `worktreeConfig`. The cost is acceptable (see Side Effects). If profiling later shows it's too chatty, a `lastWorktreeConfigSignature` short-circuit (like `_lastBoardSnapshotHash` at `KanbanProvider.ts:1412-1418` in `refreshWithData`) can be added — but that is an optimization, not needed for the fix.
- **Workspace switch mid-refresh** — `_sendWorktreeConfig` is called with the same `resolvedWorkspaceRoot` used throughout `refreshWithData` (line 1250), so it stays consistent with the board being rendered.
- **Control-plane / multi-workspace** — `_sendWorktreeConfig` already handles control-plane mode and `availableRepos` (lines 8961-8978); no change needed.
- **Coexisting with the WORKTREES-tab hydration** — the tab's own `loadWorktreeConfig()` on activation (line 3963) still works; now it just re-confirms state that's already hydrated. No double-render bug (idempotent handler).
- **CRITICAL: target the live method, not the dead one** — `_refreshBoardImpl` (line 2220) is DEAD CODE (zero production call sites; comment at line 2418 confirms). The fix MUST go in `refreshWithData` (line 1237), which is the active path driven by `TaskViewerProvider._refreshRunSheetsImpl` (line 15399) on panel restore / reload.

## Dependencies

None. This plan is self-contained and does not depend on any other plan in the epic.

## Adversarial Synthesis

Key risk: the original plan targeted `_refreshBoardImpl` (line 2220), which is DEAD CODE with zero production call sites — the fix would have done nothing and the reload bug would have persisted. Mitigation: retarget to the active refresh path `refreshWithData` (line 1237), inserting after the `updateBoard` postMessage at line 1420. The diagnosis (worktreeConfig never pushed on refresh) was correct; only the insertion target was wrong. Secondary note: `_sendWorktreeConfig` re-reads `getWorktrees()` (line 8924), duplicating the read at `refreshWithData:1399` — acceptable (one extra indexed SQLite read) but noted for a future optimization.

## Proposed Changes

> **Implementer note:** Line numbers verified against current source. If shifted, grep for `public async refreshWithData` to find the active refresh method, and grep for `_sendWorktreeConfig` to confirm the call target. Do NOT use `_refreshBoardImpl` — it is dead code (line 2220, comment at 2418).

### 1. `KanbanProvider.refreshWithData` — push worktree config on every board refresh

`src/services/KanbanProvider.ts`, in `refreshWithData` (line 1237), after the `updateBoard` postMessage block (line 1420), alongside the other state-push calls (lines 1423-1474), add:

```ts
// Hydrate worktree state (indicator + WORKTREES tab) on every board refresh so it
// survives a window reload without requiring the user to click into the WORKTREES tab.
// _sendWorktreeConfig no-ops when the DB/panel aren't ready, and the webview handler
// is idempotent, so this is safe to run unconditionally here.
await this._sendWorktreeConfig(resolvedWorkspaceRoot);
```

**Exact insertion context** (verified lines):

```ts
// line 1419-1421 (existing):
if (!snapshotUnchanged) {
    this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig, epicWorktrees });
}

// INSERT HERE:
// Hydrate worktree state (indicator + WORKTREES tab) on every board refresh...
await this._sendWorktreeConfig(resolvedWorkspaceRoot);

// line 1423 (existing, continues with other state pushes):
this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
```

Placement rationale: after `updateBoard` so the cards are already rendered when the worktree indicator updates; alongside the other state-push calls (`cliTriggersState`, `updateAgentNames`, `visibleAgents`, etc.) that already run on every refresh.

### 2. (Defensive, optional) belt-and-suspenders on the webview init

Not strictly required once §1 lands, but to make the reload path robust independently of board-refresh timing: in `kanban.html`'s `DOMContentLoaded` init (where `initialTabBtn.click()` runs at line 3975-3978), also call `loadWorktreeConfig()` unconditionally (not only inside the `tabName === 'worktrees'` branch at line 3962) so the worktree indicator hydrates even if the board-refresh-driven `worktreeConfig` message is delayed or skipped. This is a one-line addition:

```js
// Always hydrate worktree state on load so the indicator survives a reload,
// independent of which tab is initially active.
loadWorktreeConfig();
```

(`loadWorktreeConfig` is defined at `kanban.html:9266`; the call site at 3963 is inside the `tabName === 'worktrees'` branch. Adding an unconditional call in the init block makes the webview request config on load regardless of active tab.)

If §1 is implemented and verified, §2 is redundant but harmless (idempotent). Implement §1 as the primary fix; include §2 only if verification shows any remaining reload edge case.

### 3. Tests

> **Session directive:** SKIP automated tests in this session. The tests below are for the implementer/user to run separately.

- `KanbanProvider` refresh test: spy/stub `webview.postMessage` and run a `refreshWithData` with a seeded active worktree row → assert a `worktreeConfig` message was posted (in addition to `updateBoard`) containing the seeded worktree.
- Reload-simulation test: with no `getWorktreeConfig` message from the webview (simulating a fresh webview that hasn't clicked the WORKTREES tab), a `refreshWithData` alone must still produce a `worktreeConfig` message.
- Existing-worktree-config tests (create/toggle/merge) must still pass unchanged (they post their own `worktreeConfig` in addition to the refresh-driven one — idempotent).

## Non-Goals

- No DB schema change (worktree rows already persist).
- No startup worktree-filesystem reconciliation / prune-on-load (not the bug; would risk real data loss if mis-implemented).
- No change to the WORKTREES tab's own activation hydration (kept as a fallback).
- No caching/throttling of `worktreeConfig` posts (premature; revisit only if profiling shows chattiness).
- No change to `_refreshBoardImpl` (it is dead code; leave it as-is).

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Tests from §3.
- (Run separately by user) Existing `KanbanProvider` refresh tests — confirm `refreshWithData` still posts `updateBoard` and that the new `worktreeConfig` post doesn't break existing assertions.

### Manual Verification
1. Manual reload (the reported scenario): create a worktree → confirm the indicator badge shows on the board → **Developer: Reload Window** → after the board re-renders, confirm the worktree indicator badge is **still visible without clicking the WORKTREES tab**.
2. Manual reload + tab: after reload, open the WORKTREES tab → confirm the active worktrees list is populated immediately (no "No active worktrees" flash, or only a sub-frame flash before the already-pushed config renders).
3. Manual: delete a worktree directory externally (outside the extension) → trigger any board refresh (e.g. move a card) → confirm the indicator reflects the remaining worktrees (the refresh-driven `worktreeConfig` keeps state truthful).
4. Manual regression: create / merge / abandon / toggle-grid on a worktree → confirm the board still updates correctly (no duplicate or stale worktree config).

## Review Findings

Implementation verified against plan: `await this._sendWorktreeConfig(resolvedWorkspaceRoot)` at `KanbanProvider.ts:1443` in the live `refreshWithData` method (NOT the dead `_refreshBoardImpl`), placed after `updateBoard` postMessage and before `cliTriggersState`. Optional §2 belt-and-suspenders also implemented: unconditional `loadWorktreeConfig()` at `kanban.html:3981` in DOMContentLoaded init. No code changes needed. No CRITICAL/MAJOR findings. NITs: `_sendWorktreeConfig` runs even on no-op refreshes (snapshotUnchanged=true) and duplicates the `getWorktrees()` read from `:1415` — both explicitly accepted by the plan as acceptable chattiness/cost. Double-trigger with WORKTREES-tab activation is safe (idempotent webview handler). Remaining risk: low — chattiness could be optimized later with a signature-based short-circuit if profiling shows it's excessive.

## Recommendation

Complexity 3 → **Send to Intern** (one-line addition to the active refresh method; the critical insight — targeting `refreshWithData` not the dead `_refreshBoardImpl` — is captured in this plan so the implementer won't misplace the fix).
