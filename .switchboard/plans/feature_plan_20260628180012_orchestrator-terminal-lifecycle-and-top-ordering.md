# Orchestrator Terminal Lifecycle and Top-of-List Ordering

## Goal

The Orchestrator terminal is not being created or destroyed properly, and it should appear at the very top of the VS Code terminal list (out of its current creation order at the bottom). This plan fixes three confirmed defects in the orchestrator terminal lifecycle: (1) it is never created because it is hidden by default, so the Orchestrate action silently fails; (2) closed terminals are not removed from the in-memory `registeredTerminals` map, leaving stale references; (3) the orchestrator is created last, so it appears at the bottom of the terminal panel instead of the top.

### Problem Analysis & Root Cause

**Background:** The Switchboard extension maintains an "agent grid" — a set of VS Code integrated terminals, one per agent role (Planner, Lead Coder, Coder, Intern, Reviewer, Analyst, Orchestrator, plus optional custom agents). The grid is created by `createAgentGrid()` in `src/extension.ts`. Each terminal is registered in two places: an in-memory `registeredTerminals` Map (extension.ts:249) and a persistent `state.json` via `taskViewerProvider.updateState()`. The Orchestrator role has no Kanban column of its own — it exists solely so the Epics-tab "Orchestrate" button can dispatch a prompt to a dedicated terminal via `dispatchCustomPromptToRole('orchestrator', ...)`.

**Defect 1 — Orchestrator terminal is never created (silent dispatch failure).**

The orchestrator is hidden by default in the agent visibility configuration:
- `getVisibleAgents()` in `src/services/TaskViewerProvider.ts` (lines 3705-3722) sets `orchestrator: false` as the default (line 3721).
- `createAgentGrid()` in `src/extension.ts` (lines 2651-2662) filters agents by visibility: `if (visibleAgents[builtIn.role] !== false)`. Since `visibleAgents.orchestrator === false`, the orchestrator is excluded from the `agents` array and its terminal is never created.
- When the user clicks "Orchestrate" on an epic card, the flow is: `KanbanProvider.dispatchEpicOrchestration()` (KanbanProvider.ts:3171-3192) → `taskViewerProvider.dispatchCustomPromptToRole('orchestrator', prompt, ...)` (TaskViewerProvider.ts:2709-2747) → `_resolveAgentTerminalForPlan('orchestrator', ...)` (line 2730) → `_getAgentNameForRole('orchestrator', ...)` (line 6104), which scans `state.json` for a terminal entry with `role === 'orchestrator'`. Since no such terminal was ever created or registered, this returns `undefined`.
- The dispatch then hits the guard at TaskViewerProvider.ts:2733-2735: `vscode.window.showErrorMessage("No agent assigned to role 'orchestrator'. Please assign a terminal first.")` and returns `false`.

This is the "not created properly" symptom. The user clicks Orchestrate and gets an error (or, if the error is dismissed, the epic moves to the ORCHESTRATING column but no terminal receives the prompt).

**Defect 2 — Closed terminals are not removed from the in-memory `registeredTerminals` map (stale references).**

- The `onDidCloseTerminal` handler (extension.ts:1657-1660) calls `taskViewerProvider.handleTerminalClosed(terminal)`, which cleans up the `state.json` entry (TaskViewerProvider.ts:15230-15273 — matches by PID or name, then `delete state.terminals[terminalName]` and `clearTerminalAgentInfo`).
- **However, the handler does NOT remove the terminal from the in-memory `registeredTerminals` Map** (extension.ts:249). There is no `registeredTerminals.delete(...)` call in the close handler.
- **Eventual cleanup exists but has a gap:** `syncTerminalRegistryWithState` (extension.ts:1744-1833) does an atomic swap — it clears `registeredTerminals` and rebuilds it from `state.json` + live `vscode.window.terminals`. Since `handleTerminalClosed` cleans `state.json`, the next state sync hook fire (extension.ts:1668) rebuilds `registeredTerminals` without the stale entry. **However**, the state sync hook has a re-entry guard at line 1669: `if (hookSyncOutstanding) return;`. If a sync is already in flight when `handleTerminalClosed`'s `updateState` fires, the cleanup sync is **skipped**, and the stale entry persists in `registeredTerminals` until the next state change triggers another sync — which could be indefinitely if the user doesn't interact with the board. Additionally, `handleTerminalClosed` is async (1s PID timeout) and not awaited by the `onDidCloseTerminal` handler, so there's a 1s+ window where the stale entry exists even without the re-entry guard.
- This means the Map can accumulate stale `vscode.Terminal` references for terminals the user has manually closed. Consequences:
  - `deactivate()` (extension.ts:3614-3624) iterates `registeredTerminals` and calls `.dispose()` on each — already-closed terminals throw (caught by the `catch {}` block, but it's wasted work and noisy in logs).
  - Any code path that looks up a terminal by name in `registeredTerminals` without checking `terminal.exitStatus === undefined` will get a dead reference. The `locateTerminal()` helper (extension.ts:364-385) and `createAgentGrid`'s reuse check (extension.ts:2772) both guard with `exitStatus === undefined`, so they currently survive — but the stale entries are a latent bug and a memory leak.
- This is the "not destroyed properly" symptom. The `state.json` cleanup is correct; the in-memory cleanup is missing. The proposed fix provides **immediate** synchronous cleanup at close time, closing both the 1s async window and the re-entry guard gap.

**Defect 3 — Orchestrator terminal appears at the bottom of the terminal list, not the top.**

- `allBuiltInAgents` in `src/extension.ts` (lines 2638-2649) lists Orchestrator **last** (line 2648).
- `createAgentGrid()` iterates `agents` in array order (line 2770: `for (let i = 0; i < agents.length; i++)`) and calls `vscode.window.createTerminal()` (line 2780) in that order.
- VS Code's `createTerminal()` API does **not** accept a position/ordering parameter. Terminals appear in the terminal panel in **creation order** — the first created is at the top, the last created is at the bottom. There is no programmatic "move to top" API (the user-facing "Move Terminal Tab Up/Down" commands added in recent VS Code versions are not exposed to the extension API).
- Therefore, because Orchestrator is last in the array, its terminal is created last and appears at the bottom of the list. The user wants it at the very top.
- **Root cause:** The only reliable, API-supported way to control terminal order is creation order. Moving Orchestrator to the front of the `allBuiltInAgents` array makes it the first terminal created, so it appears at the top of the panel.

## Metadata

- **Tags:** `bugfix`, `ui`, `reliability`
- **Complexity:** 4/10
- **Files touched:** 2 (`src/extension.ts`, `src/services/TaskViewerProvider.ts`)
- **Risk:** Medium — touches terminal creation order (visible to all users) and the default agent visibility (changes which terminals spawn by default). The `registeredTerminals` cleanup is low-risk. The visibility default change has a user-visible side effect (an extra terminal appears by default).
- **Recent commit interaction:** Commit 58a24a8 (2026-06-28) fixed the "ORCHESTRATING Column Never Appears" bug by making `markEpicOrchestrating` force-refresh the board and return a boolean `moved` result. The status messages in `KanbanProvider.ts:7099-7108` now distinguish `sent` vs `moved` outcomes. Defect 1's fix (making the orchestrator visible by default) will make `sent === true`, so users will see "Orchestrator prompt sent and copied. Epic moved to ORCHESTRATING." instead of "No orchestrator terminal — prompt copied." — this is the intended outcome and the two fixes are complementary.

## User Review Required

**Yes — the visibility default change (Defect 1) is a user-visible behavioral change.** Changing `orchestrator: false` to `orchestrator: true` means every user who opens the agent grid will now get an Orchestrator terminal by default, even if they never use epics. This should be confirmed with the user before implementing. The two other changes (stale-reference cleanup and ordering) are internal fixes with no new visible side effect beyond the ordering itself.

## Complexity Audit

### Routine
- **Defect 2 fix (stale references):** Add a `registeredTerminals.delete(name)` loop to the existing `onDidCloseTerminal` handler (extension.ts:1657-1660). Single-block addition, no new control flow.
- **Defect 3 fix (ordering):** Reorder the `allBuiltInAgents` array (extension.ts:2638-2649) to put Orchestrator first. Single-line move within an array literal. No logic change.

### Complex / Risky
- **Defect 1 fix (visibility default):** Changing `orchestrator: false` → `orchestrator: true` (TaskViewerProvider.ts:3721) is a one-line change but has a broad user-visible side effect: the Orchestrator terminal now spawns for all users by default. This is the correct fix for the reported bug (the orchestrator must exist for the Orchestrate action to work), but it means every agent grid now has 7 built-in terminals instead of 6. Risk: users with constrained terminal layouts may notice the extra terminal. Mitigation: the orchestrator terminal is a normal panel terminal and can be closed manually; the visibility toggle remains in the Setup panel for users who want to hide it. **This change requires user confirmation** (see User Review Required above).

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Defect 2 fix:** The `onDidCloseTerminal` handler runs on the VS Code main thread; the `registeredTerminals` Map is accessed from the same thread. The new `delete` loop iterates a snapshot (`Array.from(registeredTerminals.entries())`) to avoid concurrent-modification issues if the close event fires during a `createAgentGrid` iteration. Safe.
- **Defect 1 fix:** `createAgentGrid` reads `getVisibleAgents()` once (line 2634) and uses the snapshot for the whole grid creation. No race with concurrent visibility toggles during grid creation — the next grid creation picks up the new default. Safe.

**Security:** None. No user input handling changes, no new command surface, no permission changes.

**Side Effects:**
- **Defect 1 (visibility default `true`):** All existing users who have NOT explicitly toggled `orchestrator` in their config will now see an Orchestrator terminal when they open the agent grid. Users who HAVE explicitly set `orchestrator: false` in their `visibleAgents` config (via the Setup panel or `~/.switchboard` config) are unaffected — their explicit override wins (the `getVisibleAgents` merge at line 3732/3740 spreads `defaults` then `fileValue`/`globalValue`, so explicit `false` overrides the default `true`). This is the intended behavior: only users who never configured it get the new default.
- **Defect 2 (stale cleanup):** Removing closed terminals from `registeredTerminals` means `deactivate()` will no longer attempt to dispose already-closed terminals (minor: fewer caught exceptions in logs). The `locateTerminal()` and `createAgentGrid` reuse logic already filter by `exitStatus === undefined`, so removing stale entries does not change their behavior — it only prevents the Map from growing unboundedly over a long session with many manual terminal closes.
- **Defect 3 (ordering):** The Orchestrator terminal will now be the first (topmost) terminal in the panel. All other agent terminals shift down one position. This is the requested behavior. Users who rely on a specific terminal order (e.g. muscle-memory for the Nth terminal) will need to adjust. No functional impact — terminal role resolution is by name, not by position.

**Dependencies & Conflicts:**
1. **`createAgentGrid` reuse logic (extension.ts:2772):** `vscode.window.terminals.find(t => t.exitStatus === undefined && matchesGridAgentName(t, agent.name))` — reuses a live terminal if one with the same name already exists. With Orchestrator now first in the array, on a re-run of `createAgentGrid` (e.g. after a workspace switch), the existing Orchestrator terminal is reused (not recreated), so its position does NOT change on re-runs. The ordering fix only affects the first creation. This is correct — the user wants it at the top on first creation; subsequent grid refreshes preserve whatever order the terminals are already in.
2. **`disposeAllGridTerminals` (extension.ts:2571-2589):** Iterates `registeredTerminals` and disposes/dismisses each, then clears the Map and cleans `state.json`. With the Defect 2 fix, the Map no longer has stale entries, so `disposeAllGridTerminals` disposes only live terminals. The `terminal.exitStatus === undefined` guard (line 2573) already prevents disposing closed terminals. No conflict.
3. **`handleTerminalClosed` PID resolution (TaskViewerProvider.ts:15232):** Calls `terminal.processId` with a 1s timeout. For a closed terminal, `processId` may reject or return undefined — the `try/catch` at line 15270 handles this. The new `registeredTerminals` cleanup in the `onDidCloseTerminal` handler (extension.ts) is independent of PID resolution (it matches by object identity, not PID), so it works even when PID resolution fails. No conflict.
4. **`deactivate()` (extension.ts:3614-3624):** Iterates `registeredTerminals` and calls `.dispose()` on each, then clears the Map. With the Defect 2 fix, the Map has fewer stale entries at deactivation time, so fewer `.dispose()` calls hit the `catch {}` block. No conflict — strictly better.
5. **Visibility config merge (TaskViewerProvider.ts:3728-3740):** Explicit user config (`fileValue` or `globalValue`) is merged over defaults. Changing the default from `false` to `true` does NOT override an explicit `false` — the spread `{ ...defaults, ...fileValue }` puts `fileValue` last, so an explicit `orchestrator: false` in the user's config still wins. Only users with no explicit setting get the new default. Safe.
6. **Custom agents (extension.ts:2664-2667):** Custom agents are appended after built-in agents. Reordering the built-in array does not affect custom agent creation order. No conflict.

## Dependencies

None. Self-contained changes with no prerequisite plans or sessions. The three fixes are independent and can be implemented in any order, though all three should ship together for a coherent fix.

## Adversarial Synthesis

**Key risks:** (1) The visibility default change (Defect 1) affects all ~4,000 installs — every user gets a 7th terminal by default, even those who never use epics. (2) The Defect 2 problem analysis originally overlooked `syncTerminalRegistryWithState`'s eventual cleanup mechanism — the real gap is the re-entry guard at line 1669 that can skip the cleanup sync indefinitely. **Mitigations:** The visibility toggle remains in the Setup panel for users who don't want the orchestrator; the `registeredTerminals` cleanup is belt-and-suspenders over the existing eventual cleanup; the ordering fix is empirically validated — the existing 6 terminals already appear in `allBuiltInAgents` array order, proving creation order reliably determines panel position.

## Proposed Changes

### File: `src/extension.ts`

**Change 1 — Reorder Orchestrator to the top of the agent array (Defect 3: ordering)**

Locate the `allBuiltInAgents` array (lines 2638-2649):

```typescript
const allBuiltInAgents = [
    { name: 'Planner', role: 'planner' },
    { name: 'Lead Coder', role: 'lead' },
    { name: 'Coder', role: 'coder' },
    { name: 'Intern', role: 'intern' },
    { name: 'Reviewer', role: 'reviewer' },
    { name: 'Analyst', role: 'analyst' },
    // Orchestrator has no kanban column (Decision #2): it is a full role only so its
    // terminal is spawnable/configurable and dispatch-by-role works for the Epics-tab
    // Orchestrate action. Hidden by default (visibleAgents.orchestrator === false).
    { name: 'Orchestrator', role: 'orchestrator' }
];
```

Move Orchestrator to the front and update the comment to reflect the new default:

```typescript
const allBuiltInAgents = [
    // Orchestrator is created first so its terminal appears at the top of the VS Code
    // terminal panel (VS Code's createTerminal API has no position parameter — order is
    // determined solely by creation order). Orchestrator has no kanban column (Decision #2):
    // it is a full role only so its terminal is spawnable/configurable and dispatch-by-role
    // works for the Epics-tab Orchestrate action.
    { name: 'Orchestrator', role: 'orchestrator' },
    { name: 'Planner', role: 'planner' },
    { name: 'Lead Coder', role: 'lead' },
    { name: 'Coder', role: 'coder' },
    { name: 'Intern', role: 'intern' },
    { name: 'Reviewer', role: 'reviewer' },
    { name: 'Analyst', role: 'analyst' }
];
```

This works because `createAgentGrid` iterates `agents` in array order (line 2770) and calls `vscode.window.createTerminal()` (line 2780) in that order. VS Code places terminals in the panel in creation order, so the first-created terminal is topmost. With Orchestrator first in the array, it is created first and appears at the top.

**Change 2 — Remove closed terminals from the in-memory `registeredTerminals` map (Defect 2: stale references)**

Locate the `onDidCloseTerminal` handler (lines 1657-1660):

```typescript
context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    // Ensure state.json is updated when terminal is closed manually
    taskViewerProvider.handleTerminalClosed(terminal);
}));
```

Add a `registeredTerminals` cleanup loop that removes the closed terminal by object identity:

```typescript
context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    // Remove the closed terminal from the in-memory registry (object-identity match).
    // handleTerminalClosed cleans up state.json by PID/name, but does not touch this Map —
    // without this, manually-closed terminals leave stale references that leak memory and
    // cause deactivate() to call .dispose() on already-closed terminals.
    for (const [name, ref] of Array.from(registeredTerminals.entries())) {
        if (ref === terminal) {
            registeredTerminals.delete(name);
            break;
        }
    }
    // Ensure state.json is updated when terminal is closed manually
    taskViewerProvider.handleTerminalClosed(terminal);
}));
```

This works because:
- `Array.from(registeredTerminals.entries())` snapshots the entries, avoiding concurrent-modification during iteration.
- `ref === terminal` matches by object identity (the exact `vscode.Terminal` object that closed), not by name — robust against name collisions or suffix variants.
- `break` exits after the first match (a terminal object is registered at most once under one key).
- The cleanup runs before `handleTerminalClosed`, so even if `handleTerminalClosed`'s PID resolution fails, the in-memory cleanup still succeeds.

### File: `src/services/TaskViewerProvider.ts`

**Change 3 — Enable Orchestrator by default (Defect 1: not created properly)**

Locate the `getVisibleAgents` defaults (lines 3706-3722):

```typescript
const defaults: Record<string, boolean> = { 
    lead: true, 
    coder: true, 
    intern: true, 
    reviewer: true, 
    tester: false, 
    planner: true, 
    analyst: true, 
    jules: false, 
    gatherer: false,
    code_researcher: false,
    ticket_updater: false,
    researcher: false,
    splitter: false,
    mcp_monitor: false,
    orchestrator: false
};
```

Change `orchestrator: false` to `orchestrator: true`:

```typescript
const defaults: Record<string, boolean> = { 
    lead: true, 
    coder: true, 
    intern: true, 
    reviewer: true, 
    tester: false, 
    planner: true, 
    analyst: true, 
    jules: false, 
    gatherer: false,
    code_researcher: false,
    ticket_updater: false,
    researcher: false,
    splitter: false,
    mcp_monitor: false,
    orchestrator: true
};
```

This works because:
- `createAgentGrid` checks `if (visibleAgents[builtIn.role] !== false)` (extension.ts:2653). With the default now `true`, the orchestrator is included in the `agents` array and its terminal is created.
- The terminal is registered in `state.json` with `role: 'orchestrator'` (extension.ts:2786), so `_getAgentNameForRole('orchestrator', ...)` (TaskViewerProvider.ts:6104-6142) finds it and dispatch succeeds.
- Users who have explicitly set `orchestrator: false` in their config are unaffected — the merge at lines 3728-3740 (`{ ...defaults, ...fileValue }`) puts the user's explicit value last, so explicit `false` still wins.

**No other files need changes.** The dispatch flow (`dispatchEpicOrchestration` → `dispatchCustomPromptToRole` → `_resolveAgentTerminalForPlan` → `_getAgentNameForRole`) is correct as-is — it only fails because the terminal doesn't exist. Once the terminal is created by default, dispatch works without further changes.

## Verification Plan

### Automated Tests

None for the CSS/lifecycle changes. The terminal ordering and visibility changes are best validated manually via the VS Code terminal panel. If the project has existing terminal-lifecycle unit tests, they should be run to confirm no regressions in `handleTerminalClosed` or `createAgentGrid` behavior.

**Session directives:** Compilation (`npm run compile`) and automated tests are skipped for this session per user directives. The test suite will be run separately by the user. Verification below is manual-only.

### Manual Verification

1. **Defect 1 — Orchestrator terminal is created by default:**
   - Open the Switchboard extension in VS Code with a fresh config (no explicit `visibleAgents` setting).
   - Run the "Create Agent Grid" command (or whatever triggers `createAgentGrid`).
   - Confirm an "Orchestrator" terminal appears in the terminal panel.
   - Confirm the terminal is registered in `state.json` with `role: 'orchestrator'` (check the Switchboard sidebar agent list shows Orchestrator).

2. **Defect 1 — Orchestrate dispatch succeeds:**
   - Create or find an epic card on the Kanban board (Epics tab).
   - Click the "Orchestrate" button on the epic card.
   - Confirm the orchestrator terminal receives focus and displays the orchestration prompt.
   - Confirm the epic card moves to the ORCHESTRATING column.
   - Confirm NO "No agent assigned to role 'orchestrator'" error message appears.

3. **Defect 2 — Stale references are cleaned on manual close:**
   - With the agent grid open, manually close the Orchestrator terminal (click the trash icon on the terminal tab).
   - Confirm the `onDidCloseTerminal` handler fires (check the Switchboard output channel for the auto-clean log: `[TaskViewerProvider] Auto-cleaned state for closed terminal: ...`).
   - Confirm `registeredTerminals` no longer contains the Orchestrator entry (verify by re-running "Create Agent Grid" — it should create a NEW Orchestrator terminal rather than reusing the closed one; the reuse check at extension.ts:2772 filters by `exitStatus === undefined`, so this works regardless, but the Map should not grow).
   - Repeat the close/reopen cycle 5+ times. Confirm the `registeredTerminals` Map does not grow unboundedly (no memory leak). If the project has a debug command to dump the Map size, use it; otherwise, infer from the fact that `deactivate()` (on extension reload) does not log repeated "Terminal may already be closed" caught exceptions.

4. **Defect 3 — Orchestrator appears at the top of the terminal list:**
   - Close all existing Switchboard terminals (or run "Dispose All Grid Terminals").
   - Run "Create Agent Grid" fresh.
   - Confirm the Orchestrator terminal is the FIRST (topmost) terminal in the VS Code terminal panel.
   - Confirm the remaining terminals (Planner, Lead Coder, Coder, Intern, Reviewer, Analyst) appear below it in that order.

5. **Regression — Explicit visibility override still wins:**
   - In the Setup panel (or `~/.switchboard` config), explicitly set `orchestrator: false`.
   - Run "Create Agent Grid".
   - Confirm the Orchestrator terminal does NOT appear (the explicit override wins over the new default).
   - Reset the override and confirm the Orchestrator terminal reappears on the next grid creation.

6. **Regression — Existing terminal reuse on grid refresh:**
   - With the agent grid open (Orchestrator at top), run "Create Agent Grid" again without closing terminals.
   - Confirm no duplicate terminals are created (the reuse check at extension.ts:2772 finds the existing live Orchestrator terminal by name).
   - Confirm the terminal order is unchanged (reuse does not reorder).

---

**Recommendation:** Complexity 4/10 → **Send to Coder**. The ordering change (Defect 3) and the stale-cleanup change (Defect 2) are safe internal fixes. The visibility-default change (Defect 1) is the correct fix for the reported bug but has a user-visible side effect (extra terminal by default for all ~4,000 installs) — **confirm with the user before implementing Defect 1**. If the user prefers not to change the default, the alternative is lazy initialization: add an auto-create path in `dispatchCustomPromptToRole` that creates the orchestrator terminal on-demand when the user clicks Orchestrate with no orchestrator terminal present (note: this would not solve Defect 3's top-of-list ordering, since the lazily-created terminal would appear at the bottom).
