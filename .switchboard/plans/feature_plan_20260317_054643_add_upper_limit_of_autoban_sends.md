# Add upper limit of autoban sends

## Notebook Plan

Add the limit of autoban sends before the system will stop autoban. for example, if I have 100 plans in the coded column, I may not want to leave it running to do all 100, sincei t may exceed my quota. So I might want to limit it to 10 this session.

We should add this as an option to the autoban controls tab, but also have a hardcoded limit of 10 before a terminal is considered 'exhausted' for a single autoban session.

In addition, we should add a roundrobin options to the autoban control panel. Allow the user to create new terminals in that terminal for each role, up to 5 terminals per role. The autoban will then rotate its sends for that role beteween each terminal up to a limit of 10 sends per terminal. So if the user adds 4 more reviewer terminals, they have 50 autoban sends, which will rotate its sends between the 5 different review terminals. 

The system should not automatically clear terminals. That wil lbe for the user. But there should be a control to clear and reset the backup temrinals in the autoban tab.

## Goal
Three features bundled into one plan:
1. **Send limit per terminal**: Hard cap of 10 sends per terminal per autoban session (user-configurable, hardcoded floor of 10). When a terminal hits its limit, mark it "exhausted" — autoban skips it.
2. **Round-robin multi-terminal pools**: Allow up to 5 terminals per role. Autoban rotates dispatches across the pool. Total capacity = terminals × per-terminal limit (e.g., 5 × 10 = 50).
3. **Pool management UI**: In the Autoban tab (`implementation.html`), add controls to register backup terminals per role and a "Clear & Reset" button to remove all backup terminals and reset send counters.

## Source Analysis

**Autoban engine** in `src/services/TaskViewerProvider.ts`:
- `_autobanState` (~line 107): `{ enabled, batchSize, rules }` — no send counters or terminal pools.
- `_autobanTickColumn()` (~line 1245): dispatches to a single role via `handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot)`. No concept of rotating between multiple terminals.
- `_activeDispatchSessions` Map tracks in-flight sessions to prevent double-sends.
- `_autobanColumnToRole()` (~line 1179): returns a single role string per column.

**Terminal registry** in MCP state (`register-tools.js`):
- `state.terminals` is a flat map of `{ name → { role, status, ... } }`.
- Multiple terminals can share the same role already — e.g., two terminals both with `role: 'reviewer'`.

**Autoban UI** in `src/webview/implementation.html`:
- `createAutobanPanel()` (~line 2912): master toggle, batch size select, column rules. No terminal pool controls.

## Proposed Changes

### Step 1: Extend autoban state with send counters and pool config (Moderate)
**File:** `src/services/TaskViewerProvider.ts`
- Add to `_autobanState`:
  ```ts
  maxSendsPerTerminal: number; // default 10, user-configurable
  sendCounts: Record<string, number>; // keyed by terminal name
  terminalPools: Record<string, string[]>; // keyed by role → array of terminal names
  ```
- In `_startAutobanEngine()`, reset `sendCounts` to `{}`.
- In `_stopAutobanEngine()`, reset `sendCounts`.

### Step 2: Implement round-robin dispatch logic (Complex)
**File:** `src/services/TaskViewerProvider.ts`
- New method `_selectAutobanTerminal(role: string): string | null`:
  - Get pool for role from `terminalPools[role]` (fallback: find all terminals in `state.terminals` with matching role).
  - Filter out terminals where `sendCounts[name] >= maxSendsPerTerminal`.
  - From remaining, pick the one with the lowest `sendCounts[name]` (round-robin by least-used).
  - If all exhausted, return null → autoban skips this column.
- Modify `_autobanTickColumn()`: before dispatching, call `_selectAutobanTerminal(role)`. If null, log "All terminals exhausted for {role}" and return.
- After successful dispatch, increment `sendCounts[terminalName] += batchSize`.
- When all terminals for all enabled columns are exhausted, auto-stop the engine.

### Step 3: Add terminal pool management to autoban UI (Moderate)
**File:** `src/webview/implementation.html`
- Below the column rules section in `createAutobanPanel()`:
  - Add a "TERMINAL POOLS" header.
  - For each role (planner, coder/lead, reviewer), show registered terminals with send count badges.
  - "Add Terminal" button per role (max 5) — opens a simple name input.
  - "Clear & Reset" button — removes all backup terminals and resets send counters.
- Add a "MAX SENDS PER TERMINAL" numeric input (default 10, min 1, max 100).

### Step 4: Add message handlers for pool management (Routine)
**File:** `src/services/TaskViewerProvider.ts`
- Handle new webview messages: `updateAutobanMaxSends`, `addAutobanTerminal`, `removeAutobanTerminal`, `resetAutobanPools`.
- Persist pool config to `workspaceState`.

### Step 5: Broadcast pool state to kanban webview (Routine)
**File:** `src/services/KanbanProvider.ts`
- Extend `AutobanConfigState` type to include `maxSendsPerTerminal`, `sendCounts`, `terminalPools`.
- Kanban column status bars can optionally show "3/10 sends used" per column.

## Dependencies
- **Plan 2 (countdown timer):** Both extend `AutobanConfigState`. Coordinate type changes. Merge order doesn't matter as long as both add their fields.
- **Plan 1 (live feed logging):** No conflict — different code paths.
- No blocking dependencies.

## Verification Plan
1. Set `maxSendsPerTerminal` to 3 for quick testing.
2. Enable autoban with one terminal per role.
3. Confirm autoban stops after 3 dispatches per terminal.
4. Add a second terminal for the same role.
5. Confirm round-robin: sends alternate between terminals.
6. Confirm total capacity is now 6 (2 × 3).
7. Click "Clear & Reset" — confirm send counters reset and backup terminals removed.
8. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- State type extensions (~5 lines).
- UI message handlers (~20 lines).
- Kanban broadcast extensions (~5 lines).

### Band B (Complex/Risky)
- Round-robin terminal selection logic — must handle: terminals going offline mid-session, race conditions between concurrent ticks, accurate send counting when batch size > 1.
- Terminal pool management UI — new interactive section with add/remove/reset.
- Auto-stop engine when all terminals exhausted — must not leave timers running.

## Adversarial Review

### Grumpy Critique
- "This is three features crammed into one plan. The round-robin pool system is a significant architectural addition." → Valid. Consider splitting: Phase 1 = send limit + auto-stop (Coder), Phase 2 = round-robin pools (Lead Coder).
- "What if a terminal crashes mid-session? Its send count is consumed but it did no work." → Valid. The send count tracks dispatches, not completions. This is acceptable — the user can "Clear & Reset" to recover.
- "5 terminals per role × 10 sends = 50 API calls. Is there no global hard cap?" → Worth adding a global session cap (e.g., 200) as a safety net.
- "How does `handleKanbanBatchTrigger` know which specific terminal to use? It currently routes by role." → This is the key integration point. The dispatch method needs to accept an optional terminal name override.

### Balanced Synthesis
- Split into two phases: **Phase 1** (send limit + auto-stop) is straightforward and delivers immediate value. **Phase 2** (round-robin pools + UI) is a follow-up.
- Add a global session cap of 200 sends as a safety backstop.
- The terminal-name override for dispatch is the only risky integration point — verify `handleKanbanBatchTrigger` can accept it cleanly.
- "Clear & Reset" must also reset the engine timers, not just counters.

## Agent Recommendation
Send it to the **Lead Coder** — the round-robin dispatch logic and terminal pool management are architecturally significant. Consider splitting Phase 1 (send limit) as a Coder task first.

## Reviewer Pass Update

### Fixed Items
- Fixed autoban send accounting so the per-terminal cap and global session cap now count **dispatches/API sends**, not the number of plans packed into a batch. This matches the plan language around "10 sends" and "50 API calls" and prevents a batch of 5 plans from incorrectly consuming 5 send slots in one dispatch.

### Files Changed During Reviewer Pass
- `src/services/TaskViewerProvider.ts`
- `src/test/autoban-state-regression.test.js`

### Validation Results
- `npm run compile-tests` ✅
- `npm run compile` ✅
- `node src/test/autoban-state-regression.test.js` ✅
- `node src/test/direct-create-ticket-regression.test.js` ⚠️ Fails in the current worktree due to an unrelated direct-plan-ticket regression (`airlock flow should still retain the initiate plan modal helper`). This reviewer pass did not modify that flow because it is outside this autoban plan's scope.

### Remaining Risks
- Exhaustion checks currently treat a role with no eligible live terminals the same as a fully exhausted pool and may auto-stop autoban. That is defensible for safety, but if the desired behavior is "pause and resume when terminals come back" instead of "stop", that behavior should be clarified.
- The sidebar pool UI surfaces terminal-level usage and readiness, but the optional Kanban per-column usage badges mentioned in the plan are not called out or verified here.

### Reviewer Verdict
- The send-limit / round-robin implementation is materially aligned with the plan after the dispatch-accounting fix above.
- No remaining CRITICAL or MAJOR defects were found in the autoban implementation itself during this pass.
