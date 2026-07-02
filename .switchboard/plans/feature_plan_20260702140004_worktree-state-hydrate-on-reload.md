# Worktree State Must Hydrate Automatically After A Window Reload

## Goal

After a VS Code window reload, the worktree state in the kanban board (the `wt-indicator` worktree badge and the WORKTREES tab list) must reappear without the user having to manually click into the WORKTREES tab. Today, after a reload the board shows no worktree indicator and the WORKTREES tab reads "No active worktrees" until the user clicks away and back — which reads as "my worktrees are gone."

### Problem analysis / root cause

Worktree rows **do persist** in the SQLite `worktrees` table (`status='active'`, `KanbanDatabase.ts:165-177`) and the on-disk git worktree directories survive a reload. There is no startup pruning/reconciliation that marks worktrees inactive (the only `_pruneWorktrees` / `updateWorktreeStatus` calls are inside merge/abandon/cleanup flows). So this is **not data loss** — it is a **UI hydration gap**.

The gap: worktree config is pushed to the webview **only reactively**, never proactively during a board refresh.

- `_sendWorktreeConfig(workspaceRoot)` (`KanbanProvider.ts:8910`) is the only thing that posts a `worktreeConfig` message. It is called from `getWorktreeConfig` (tab activation) and after every worktree mutation (create/merge/abandon/toggle) — 15 call sites, all reactive. It is **never** called from `_refreshBoardImpl`.
- `_refreshBoardImpl` (`KanbanProvider.ts:2220-2398`) — which runs on panel restore (line 1202), on every plan import/column move/workspace switch, and on the initial load after a reload — posts `updateBoard` (with a *partial* `epicWorktrees` map, lines 2369-2380) but **never** calls `_sendWorktreeConfig`. So after a reload, the full worktree list + indicator are not pushed.
- On the webview side, `lastWorktreeConfig` starts as `null` (`kanban.html:6069`) and is only set inside `case 'worktreeConfig'` (`kanban.html:6308-6310`). The worktree indicator (`updateWorktreeIndicator`, `kanban.html:5131`) is only updated from that same handler (`kanban.html:6311-6316`). The WORKTREES tab only fetches config when it is activated: `loadWorktreeConfig()` at `kanban.html:3963`, fired from the tab click handler.

Net effect after a reload: the board refreshes its cards, but `worktreeConfig` is never sent → `lastWorktreeConfig` stays `null` → indicator hidden → WORKTREES tab shows "No active worktrees" on first render. The moment the user clicks the WORKTREES tab, `loadWorktreeConfig()` round-trips and the worktrees reappear — but by then the user has already concluded the worktrees didn't persist.

The fix is to push worktree config as part of the board refresh so it hydrates automatically.

## Metadata

**Complexity:** 3
**Tags:** backend, worktrees, bug, reload

## Current State

- `_refreshBoardImpl` already reads `db.getWorktrees()` once at line 2369 (to build the `epicWorktrees` map for `updateBoard`), so the data is already in hand — it just isn't shaped/sent as a full `worktreeConfig` message.
- `_sendWorktreeConfig` is self-contained: it re-reads `getWorktrees()`, resolves epic topic/project, and posts `worktreeConfig` (with `suppressMainTerminals`, `epicWorktreeMode`, `projects`, `epics`, `availableRepos`, `activeRepoFilter`). It no-ops gracefully when the DB isn't ready (`KanbanProvider.ts:8912`).
- The webview `worktreeConfig` handler is idempotent (overwrites `lastWorktreeConfig` and re-renders), so sending it on every refresh is safe.

## Complexity Audit

**Routine.** One additional `await this._sendWorktreeConfig(resolvedWorkspaceRoot)` call near the end of `_refreshBoardImpl`. No schema change, no webview change, no new message type — the webview already handles `worktreeConfig` and re-renders the indicator + tab. The only judgment call is the small extra work per board refresh (a `getWorktrees()` read already happens, plus a few `getPlanByPlanId` lookups for epic-topic resolution inside `_sendWorktreeConfig`), which is acceptable and keeps worktree state consistent (e.g., externally-deleted worktrees' indicator clears on the next refresh).

## Edge-Case & Dependency Audit

- **DB not ready** — `_sendWorktreeConfig` already guards on `db.ensureReady()` and returns silently (`KanbanProvider.ts:8912`), and `_refreshBoardImpl` already branches on `dbReady`. Calling it unconditionally at the end is safe.
- **No panel yet** — `_sendWorktreeConfig` posts via `this._panel?.webview.postMessage` (optional chaining, `KanbanProvider.ts:8969`), so it no-ops if the panel is gone.
- **Chattiness** — `_refreshBoardImpl` runs frequently (plan imports, column moves, workspace switches, file-watcher scans). Each will now also push `worktreeConfig`. The cost is one `getWorktrees()` read + O(active epic worktrees) `getPlanByPlanId` lookups + one postMessage + an idempotent webview re-render. This is cheap and keeps the indicator truthful. If profiling later shows it's too chatty, a `lastWorktreeConfigSignature` short-circuit (like `_lastColumnsSignature` at `KanbanProvider.ts:2340-2344`) can be added — but that is an optimization, not needed for the fix.
- **Workspace switch mid-refresh** — `_sendWorktreeConfig` is called with the same `resolvedWorkspaceRoot` used throughout `_refreshBoardImpl`, so it stays consistent with the board being rendered.
- **Control-plane / multi-workspace** — `_sendWorktreeConfig` already handles control-plane mode and `availableRepos`; no change needed.
- **Coexisting with the WORKTREES-tab hydration** — the tab's own `loadWorktreeConfig()` on activation still works; now it just re-confirms state that's already hydrated. No double-render bug (idempotent handler).

## Proposed Changes

### 1. `KanbanProvider._refreshBoardImpl` — push worktree config on every board refresh

`src/services/KanbanProvider.ts`, at the end of `_refreshBoardImpl`, after the `updateBoard` postMessage block (after line 2380, alongside the other `postMessage` calls at 2381-2394), add:

```ts
// Hydrate worktree state (indicator + WORKTREES tab) on every board refresh so it
// survives a window reload without requiring the user to click into the WORKTREES tab.
// _sendWorktreeConfig no-ops when the DB/panel aren't ready, and the webview handler
// is idempotent, so this is safe to run unconditionally here.
await this._sendWorktreeConfig(resolvedWorkspaceRoot);
```

Placement rationale: after `updateBoard` so the cards are already rendered when the worktree indicator updates; alongside the other state-push calls (`cliTriggersState`, `updateAgentNames`, `visibleAgents`, etc.) that already run on every refresh.

### 2. (Defensive, optional) belt-and-suspenders on the webview init

Not strictly required once §1 lands, but to make the reload path robust independently of board-refresh timing: in `kanban.html`'s `DOMContentLoaded` init (where `initialTabBtn.click()` runs at line 3975-3978), also call `loadWorktreeConfig()` unconditionally (not only inside the `tabName === 'worktrees'` branch at line 3962) so the worktree indicator hydrates even if the board-refresh-driven `worktreeConfig` message is delayed or skipped. This is a one-line addition:

```js
// Always hydrate worktree state on load so the indicator survives a reload,
// independent of which tab is initially active.
loadWorktreeConfig();
```

If §1 is implemented and verified, §2 is redundant but harmless (idempotent). Implement §1 as the primary fix; include §2 only if verification shows any remaining reload edge case.

### 3. Tests

- `KanbanProvider` refresh test: spy/stub `webview.postMessage` and run a board refresh with a seeded active worktree row → assert a `worktreeConfig` message was posted (in addition to `updateBoard`) containing the seeded worktree.
- Reload-simulation test: with no `getWorktreeConfig` message from the webview (simulating a fresh webview that hasn't clicked the WORKTREES tab), a board refresh alone must still produce a `worktreeConfig` message.
- Existing-worktree-config tests (create/toggle/merge) must still pass unchanged (they post their own `worktreeConfig` in addition to the refresh-driven one — idempotent).

## Non-Goals

- No DB schema change (worktree rows already persist).
- No startup worktree-filesystem reconciliation / prune-on-load (not the bug; would risk real data loss if mis-implemented).
- No change to the WORKTREES tab's own activation hydration (kept as a fallback).
- No caching/throttling of `worktreeConfig` posts (premature; revisit only if profiling shows chattiness).

## Verification Plan

1. Unit tests from §3.
2. Manual reload (the reported scenario): create a worktree → confirm the indicator badge shows on the board → **Developer: Reload Window** → after the board re-renders, confirm the worktree indicator badge is **still visible without clicking the WORKTREES tab**.
3. Manual reload + tab: after reload, open the WORKTREES tab → confirm the active worktrees list is populated immediately (no "No active worktrees" flash, or only a sub-frame flash before the already-pushed config renders).
4. Manual: delete a worktree directory externally (outside the extension) → trigger any board refresh (e.g. move a card) → confirm the indicator reflects the remaining worktrees (the refresh-driven `worktreeConfig` keeps state truthful).
5. Manual regression: create / merge / abandon / toggle-grid on a worktree → confirm the board still updates correctly (no duplicate or stale worktree config).

## User Review Required

None. (If the team later prefers to avoid pushing `worktreeConfig` on every refresh, the alternative is a signature-based short-circuit — noted in §Edge-Case chattiness — but that is an optimization and not needed to fix the reload bug.)
