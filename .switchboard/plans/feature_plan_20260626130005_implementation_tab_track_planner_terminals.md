# Make the Implementation Panel Agents Tab Track Extra Planner Terminals

## Goal

The Kanban panel's Agents tab lets the user run multiple planner terminals (a "planner pool" of 1–5). The Implementation panel's Agents tab (`implementation.html`) only ever shows a **single** PLANNER row with no indication of which planner terminal the next dispatch will target. It should show the **current rotation-cursor target** in the row label (e.g. `PLANNER - Planner 2`), dispatch to that terminal when the button is pressed, and — as soon as the dispatch completes — instantly advance the label to the next planner in the rotation and reactivate the button.

**Chosen approach: Option C — single row, cursor-synced label, rotation dispatch.** The row count stays at one (no multi-row enumeration). The label reflects the current rotation cursor target. The button dispatches via the existing rotation mechanism. After dispatch completes, the label instantly updates to the next cursor target and the button reactivates.

### Problem analysis & root cause

**Where the extra planner terminals come from.** The Kanban Agents tab has a count dropdown `#agents-tab-planner-terminal-count` (1–5) (`src/webview/kanban.html:2695`). Its value is persisted as `plannerTerminalCount` via `KanbanProvider.ts` into the workspace state file / globalState (`getPlannerTerminalCount`, `TaskViewerProvider.ts:3473-3476`; globalState key `switchboard.agents.plannerTerminalCount`). When agent terminals are opened, the count is expanded into N named terminals — `Planner`, `Planner 2`, `Planner 3`, … — **each carrying `role: 'planner'`** (`src/extension.ts:2640-2652`).

**What the Implementation panel receives.** `implementation.html` is rendered by `TaskViewerProvider`. Its agent rows are driven by the `terminalStatuses` message (handled at `implementation.html:2227-2233`, storing `lastTerminals = message.terminals`). `TaskViewerProvider._refreshTerminalStatuses()` posts the **same** enriched terminal map to both the sidebar and the Kanban provider (`TaskViewerProvider.ts:17899-17932`). That `lastTerminals` map already contains **every** planner terminal as a separate key (`Planner`, `Planner 2`, …), each with `.role === 'planner''` and its own `alive`/`lastSeen`/`statusState`.

**The rotation cursor — where it lives and where it doesn't.** The persistent round-robin cursor (`getPlannerRotationCursor`, `TaskViewerProvider.ts:3528-3533`) is stored in globalState keyed by terminal-set location. It is advanced **only after successful dispatch** (`advancePlannerRotationCursor`, `:3535-3540`). Crucially, the rotation cursor is used in `dispatchCustomPromptToRole` (`:2648-2657`) — but the Implementation panel's "IMPROVE PLAN" button goes through a **different** dispatch path: `_handleTriggerAgentActionInternal` (`:15594`), which resolves the planner target via `_resolveAgentTerminalForPlan` (`:15728-15732`) — **no rotation cursor, no cursor advance**. So today the Implementation panel always hits whichever planner `_resolveAgentTerminalForPlan` returns (first alive), regardless of the pool.

**The dispatch flow itself.** `_dispatchExecuteMessage` → `_attemptDirectTerminalPush` (`:15487`) does the `/clear` + `sendRobustText` sequence the user described: clipboard-paste `/clear`, wait, submit, wait for clear delay, then `sendRobustText` the prompt (`:15557-15578`). On completion, `actionTriggered { role, success }` is posted to the webview (`:15854`).

**The webview dispatch-pending lifecycle.** `markDispatchPending('planner')` disables the button and shows "DISPATCHING…" (`:2844-2845`, `:2862-2867`). On `actionTriggered`, `clearDispatchPending('planner')` fires (`:2329`), then the button shows "DISPATCHED" for 2 seconds before `renderAgentList()` re-renders (`:2360-2362`). The 2-second "DISPATCHED" delay and the stale-label problem are what the user wants replaced with an instant label switch.

**Fix shape (Option C).** Three coordinated changes:
1. **Backend:** wire the rotation cursor into `_handleTriggerAgentActionInternal` for the planner role (same pattern as `dispatchCustomPromptToRole`), and advance the cursor after successful dispatch. Expose the current cursor target terminal name in the `terminalStatuses` payload and in the `actionTriggered` message so the webview can display it.
2. **Webview (label):** the single PLANNER row's label shows the current cursor target terminal name (e.g. `PLANNER - Planner 2`) instead of the role-collapsed `lastTerminalAgentNames['planner']`.
3. **Webview (button lifecycle):** on `actionTriggered` for planner, skip the 2-second "DISPATCHED" delay — immediately clear pending, update the label to the next cursor target (from the `actionTriggered` payload), and re-render so the button reactivates instantly.

## Metadata

- **Tags:** frontend, backend, ui, bugfix, feature
- **Complexity:** 5 / 10
- **Primary file:** `src/webview/implementation.html`
- **Secondary file:** `src/services/TaskViewerProvider.ts` (rotation cursor wiring + payload exposure)
- **Affected feature area:** Implementation panel → Agents tab (planner terminals)

## User Review Required

- **Resolved:** Option C chosen by user. Single row, cursor-synced label, rotation dispatch, instant label advance on dispatch completion. No multi-row enumeration.

## Complexity Audit

### Routine
- Webview: reading a new `currentPlannerTarget` field from `terminalStatuses` and `actionTriggered` payloads and using it for the PLANNER row label — pure JS, localized to the `terminalStatuses` handler and `renderAgentList()`.
- Webview: skipping the 2-second "DISPATCHED" delay for the planner role in the `actionTriggered` handler — a branch addition in an existing switch case.
- Webview: the existing `markDispatchPending`/`isDispatchPending`/`clearDispatchPending` lifecycle already handles button inactive/active — no new state machine needed.

### Complex / Risky
- **Backend: rotation cursor not in the Implementation panel's dispatch path.** `_handleTriggerAgentActionInternal` (`:15594`) resolves the planner via `_resolveAgentTerminalForPlan` (`:15728-15732`), not the rotation cursor. Wiring the cursor in means replicating the `getRoleTerminalSet` + `getPlannerRotationCursor` + `advancePlannerRotationCursor` pattern from `dispatchCustomPromptToRole` (`:2648-2676`) into this path. Must not break the Kanban batch-advance path or the `dispatchCustomPromptToRole` path.
- **Backend: exposing the cursor target to the webview.** The cursor is in globalState on the backend; the webview has no way to read it. Must compute the current target terminal name during `_refreshTerminalStatuses` (or `_computeDispatchReadiness`) and include it in the payload. Must also include the *next* target in the `actionTriggered` message for instant label update (the cursor advances after dispatch, but the webview needs the new target immediately, not on the next `terminalStatuses` refresh).
- **Timing: instant label switch.** The `actionTriggered` message arrives after `_dispatchExecuteMessage` completes (the `/clear` + `sendRobustText` await chain). The cursor has already advanced by the time `actionTriggered` is posted. The `actionTriggered` payload must carry the post-advance cursor target so the webview can render the new label without waiting for the next `terminalStatuses` tick.

## Edge-Case & Dependency Audit

- **Race Conditions:** `renderAgentList` re-runs on every `terminalStatuses` message and rebuilds the list. The `currentPlannerTarget` is read fresh each render. The `actionTriggered` handler stores the next target and re-renders immediately — no stale state survives because the row is fully rebuilt.
- **Security:** No new message surface — `currentPlannerTarget` is a read-only display string computed from the existing terminal set + cursor. The dispatch path is unchanged (still `triggerAgentAction` with `role`/`sessionFile`/`instruction`); the backend rotation picks the target internally.
- **Side Effects:** Wiring the rotation cursor into `_handleTriggerAgentActionInternal` means the Implementation panel's planner dispatch now shares the same cursor as the Kanban single-card path (`dispatchCustomPromptToRole`). This is **correct and desirable** — sequential dispatches from either UI advance the same rotation. The Kanban batch-advance path (`handleKanbanBatchTrigger`) has its own distribution logic and is unaffected.
- **Dependencies & Conflicts:**
  - `lastDispatchReadiness['planner']` is a single role-keyed entry pointing at the first alive planner (`TaskViewerProvider.ts:1715-1733`) — **not** the cursor target. The label must use the new `currentPlannerTarget` field, not `dispatchReadiness.terminalName` or `lastTerminalAgentNames['planner']`.
  - `lastTerminalAgentNames['planner']` is role-collapsed (first alive wins, `:533-536`) — also not the cursor target. Same: use `currentPlannerTarget`.
  - `isAgentGreen('planner')` (onboarding guard, `:2921-2937`) uses first-match find — role-level, unaffected; onboarding still triggers correctly if any planner is alive.
- **Single planner (count = 1):** cursor always points at `Planner`; label shows `PLANNER - Planner`; dispatch hits `Planner`; cursor advances but wraps to 0 → same terminal. No regression.
- **Planner pool not yet opened:** no planner terminals alive → `currentPlannerTarget` is null/undefined → label falls back to `PLANNER` (no suffix), red dot, button disabled. Preserves current behaviour.
- **Cursor target terminal is dead (closed between renders):** the backend should skip dead terminals when computing the cursor target (advance past them). If all planners are dead, `currentPlannerTarget` is null → placeholder label.
- **Failed dispatch:** cursor does **not** advance (existing behaviour, `:2672-2676` — advance only on success). The `actionTriggered { success: false }` handler should show "FAILED" briefly then revert to the same cursor target (label unchanged, button reactivates). The user's flow assumes success; failure should not silently advance the label.
- **Locate / Clear buttons:** should target the current cursor target terminal (not the first planner). With `currentPlannerTarget` available, the PLANNER row's locate/clear can use it as `resolvedTermName`.
- **Other roles unchanged:** Lead/Coder/Intern/Reviewer/Analyst continue using their existing single-find rows and existing `actionTriggered` handling (including the 2-second "DISPATCHED" delay). Only the planner role gets the instant-switch behaviour.
- **No confirmation dialogs** (project rule).

## Dependencies

- None — this plan is self-contained. (No prerequisite plan sessions.)

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the Implementation panel's dispatch path (`_handleTriggerAgentActionInternal`) does not use the rotation cursor at all — it uses `_resolveAgentTerminalForPlan`, so wiring the cursor in is a required backend change, not a render-only fix; (2) the webview cannot know the cursor target without a new payload field, and the instant label switch requires the post-advance target in `actionTriggered`, not just the next `terminalStatuses` tick; (3) failed dispatches must not advance the label (cursor advance is success-gated, but the webview `actionTriggered` handler must distinguish success from failure). Mitigations: replicate the cursor pattern from `dispatchCustomPromptToRole` into `_handleTriggerAgentActionInternal`; expose `currentPlannerTarget` in `terminalStatuses` and `nextPlannerTarget` in `actionTriggered`; branch the `actionTriggered` handler on `success` for planner.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — wire rotation cursor into `_handleTriggerAgentActionInternal` for planner

Currently `_handleTriggerAgentActionInternal` (`:15594`) resolves the planner target at `:15728-15732`:

```ts
let targetAgent: string | undefined;
if (options?.targetTerminalOverride && this._isValidAgentName(options.targetTerminalOverride)) {
    targetAgent = options.targetTerminalOverride;
} else {
    targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreePath);
}
```

For the planner role, replace the `_resolveAgentTerminalForPlan` branch with the rotation cursor pattern from `dispatchCustomPromptToRole` (`:2648-2657`):

```ts
let targetAgent: string | undefined;
let plannerLocationKey: string | undefined;
if (options?.targetTerminalOverride && this._isValidAgentName(options.targetTerminalOverride)) {
    targetAgent = options.targetTerminalOverride;
} else if (role === 'planner') {
    const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
    if (terminals.length > 0) {
        const cursor = this.getPlannerRotationCursor(locationKey);
        const picked = terminals[cursor % terminals.length];
        if (picked && this._isValidAgentName(picked)) {
            targetAgent = picked;
            plannerLocationKey = locationKey;
        }
    }
    // Fallback: default resolution if cursor yielded nothing (no terminals or invalid)
    if (!targetAgent) {
        targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreePath);
    }
} else {
    targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreePath);
}
```

Then after the successful dispatch (where `actionTriggered { success: true }` is posted, `:15854`), advance the cursor — mirroring `dispatchCustomPromptToRole:2672-2676`:

```ts
if (success && plannerLocationKey) {
    await this.advancePlannerRotationCursor(plannerLocationKey, 1);
}
```

> **Non-planner roles are unchanged** — they still use `_resolveAgentTerminalForPlan`. The `targetTerminalOverride` path (used by Kanban batch) is preserved. The Kanban `dispatchCustomPromptToRole` path is untouched.

### 2. `src/services/TaskViewerProvider.ts` — expose current cursor target in `terminalStatuses` payload

In `_refreshTerminalStatuses` (`:17895-17932`), after computing `dispatchReadiness`, compute the current planner rotation target and add it to the payload sent to both webviews:

```ts
// Compute current planner rotation target for display
let currentPlannerTarget: string | undefined;
const plannerSet = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
if (plannerSet.terminals.length > 0) {
    const cursor = this.getPlannerRotationCursor(plannerSet.locationKey);
    const picked = plannerSet.terminals[cursor % plannerSet.terminals.length];
    if (picked && this._isValidAgentName(picked)) {
        currentPlannerTarget = picked;
    }
}
```

Add `currentPlannerTarget` to both `terminalStatuses` posts (`:17899` and `:17921-17926`):

```ts
this._view.webview.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, dispatchReadiness, currentPlannerTarget });
this._kanbanProvider?.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, dispatchReadiness, currentPlannerTarget });
// ... and in the second post with allOpenTerminals:
this._view.webview.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, dispatchReadiness, allOpenTerminals, currentPlannerTarget });
this._kanbanProvider?.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, dispatchReadiness, allOpenTerminals, currentPlannerTarget });
```

> The Kanban provider can ignore this field (it has its own rotation display). The Implementation panel uses it for the label.

### 3. `src/services/TaskViewerProvider.ts` — include next cursor target in `actionTriggered` for planner

After the cursor is advanced (Change 1), compute the **next** cursor target and include it in the `actionTriggered` message so the webview can update the label instantly. At `:15854` (success path) and `:2997` (if there's a second post site for this path), change:

```ts
this._view?.webview.postMessage({ type: 'actionTriggered', role, success: true });
```

to:

```ts
let nextPlannerTarget: string | undefined;
if (role === 'planner' && success && plannerLocationKey) {
    // Cursor has already been advanced — compute the new target
    const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
    if (terminals.length > 0) {
        const nextCursor = this.getPlannerRotationCursor(locationKey);
        const picked = terminals[nextCursor % terminals.length];
        if (picked && this._isValidAgentName(picked)) {
            nextPlannerTarget = picked;
        }
    }
}
this._view?.webview.postMessage({ type: 'actionTriggered', role, success: true, nextPlannerTarget });
```

> On failure (`success: false`), `nextPlannerTarget` is omitted — the webview keeps the current label.

### 4. `src/webview/implementation.html` — store `currentPlannerTarget` from `terminalStatuses`

In the `terminalStatuses` handler (`:2227-2233`), store the new field:

```js
case 'terminalStatuses':
    lastTerminals = message.terminals || {};
    lastAllOpenTerminals = message.allOpenTerminals || [];
    if (message.dispatchReadiness !== undefined) { lastDispatchReadiness = message.dispatchReadiness || {}; }
    if (message.currentPlannerTarget !== undefined) { lastPlannerTarget = message.currentPlannerTarget || null; }
    renderAgentList();
    updateTerminalButtonState();
    break;
```

Add a module-level variable near the other `last*` variables:

```js
let lastPlannerTarget = null;  // current rotation-cursor target terminal name, from terminalStatuses
```

### 5. `src/webview/implementation.html` — use `lastPlannerTarget` for the PLANNER row label and locate/clear

In `renderAgentList()`, the Planner block (`:3030-3035`) stays as a single row but passes `lastPlannerTarget` as the `explicitTermName` so the label, locate, and clear target the cursor's terminal:

```js
// 1. Planner — single row, label synced to current rotation-cursor target
if (va.planner !== false) {
    agentListStandard.appendChild(createAgentRow('PLANNER', 'planner',
        'IMPROVE PLAN',
        terminals => Object.keys(terminals).find(key => terminals[key].role === 'planner'),
        false,                          // hideLocate
        lastPlannerTarget || undefined   // explicit terminal name = cursor target
    ));
}
```

In `createAgentRow` (`:2684`), add the `explicitTermName` parameter (same as previously proposed) so the label and locate/clear use it:

```js
function createAgentRow(label, roleId, actionLabel, findTerminalFn, hideLocate, explicitTermName) {
    const container = document.createElement('div');
    container.className = 'agent-row';

    const termName = explicitTermName || (findTerminalFn ? findTerminalFn(lastTerminals) : null);
    // ... rest unchanged: dispatchInfo, dispatchState, routedTermName, resolvedTermName, termData ...
```

In the name-display block (`:2745-2755`), prefer `explicitTermName`:

```js
const displayName = explicitTermName
    || (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName ? dispatchInfo.terminalName : lastTerminalAgentNames[roleId]);
if (displayName) {
    name.innerHTML = `${label} - ${displayName}${suffix}`;
}
```

> When `lastPlannerTarget` is null (no planner open), `explicitTermName` is undefined → falls back to existing behaviour (role-collapsed name or label-only).

### 6. `src/webview/implementation.html` — instant label switch on `actionTriggered` for planner

In the `actionTriggered` handler (`:2326-2363`), add a planner-specific branch that skips the 2-second "DISPATCHED" delay and instantly updates the label:

```js
case 'actionTriggered': {
    const role = message.role;
    const success = message.success;
    clearDispatchPending(role);
    if (role === 'analyst') {
        // ... existing analyst handling unchanged ...
        break;
    }
    if (role === 'planner') {
        // Instant label switch: update to next cursor target and re-render immediately
        if (success && message.nextPlannerTarget) {
            lastPlannerTarget = message.nextPlannerTarget;
        }
        // On failure, lastPlannerTarget stays unchanged (cursor didn't advance)
        renderAgentList();
        break;
    }
    // ... existing handling for other roles (2-second DISPATCHED delay) unchanged ...
```

> The button reactivates because `clearDispatchPending('planner')` removes the pending flag, and `renderAgentList()` rebuilds the row with `isDispatchPending('planner') === false` → button enabled. The label shows `lastPlannerTarget` (the post-advance target).

## Verification Plan

> Per session directives: **skip compilation** (`npm run compile`) and **skip automated tests** — these are run separately by the user. Verification below is manual/functional.

### Automated Tests
- Skipped this session (user runs the suite separately).

### Manual Verification
1. **Set planner pool to 3:** in Kanban → Agents tab, set `#agents-tab-planner-terminal-count` to 3 and open the agent terminals (so `Planner`, `Planner 2`, `Planner 3` exist).
2. **Label shows current cursor target:** open the Implementation panel → Agents tab. Confirm the PLANNER row label shows the current rotation target (e.g. `PLANNER - Planner`). The status dot, locate, and clear all target that terminal.
3. **Dispatch hits the displayed terminal:** click "IMPROVE PLAN". Confirm the `/clear` + prompt lands in the terminal shown in the label (e.g. `Planner`), not a different one.
4. **Button goes inactive during dispatch:** while the `/clear` + `sendRobustText` is in flight, confirm the button shows "DISPATCHING…" and is disabled.
5. **Instant label switch on completion:** as soon as the dispatch completes, confirm the label **instantly** updates to the next planner (e.g. `PLANNER - Planner 2`) and the button reactivates — no 2-second "DISPATCHED" delay for the planner role.
6. **Rotation continues:** click "IMPROVE PLAN" again. Confirm it dispatches to `Planner 2` (the newly displayed target), then the label advances to `PLANNER - Planner 3`, then wraps back to `PLANNER - Planner`.
7. **Count = 1 regression:** set the pool back to 1; the label shows `PLANNER - Planner`, dispatch hits `Planner`, label stays `PLANNER - Planner` after dispatch (cursor wraps to 0). No regression.
8. **No planner open:** with no planner terminal alive, confirm the PLANNER row renders with no terminal suffix (just `PLANNER`), red dot, button disabled.
9. **Failed dispatch:** if a dispatch fails (e.g. terminal closed mid-dispatch), confirm the label does **not** advance — it stays on the same planner target and the button reactivates.
10. **Other roles unchanged:** Lead/Coder/Intern/Reviewer/Analyst rows still show the 2-second "DISPATCHED" feedback and are otherwise unaffected.
11. **Kanban dispatch shares the cursor:** after dispatching from the Implementation panel, confirm a subsequent Kanban single-card dispatch picks up the advanced cursor (not restarting at Planner 1).

## Recommendation

Complexity is 5 (multi-file, touches a shared dispatch path, requires coordinated backend+webview payload changes). **Send to Coder.**

## Review Findings

**Stage 1 (Grumpy Principal Engineer):** Welcome to the big leagues. This plan touches a shared dispatch path — one wrong move and the Kanban rotation cursor desyncs from the Implementation panel. Let me trace every path. `_handleTriggerAgentActionInternal` (line 16327-16346) correctly wires the rotation cursor for planner, with fallback to `_resolveAgentTerminalForPlan` when the cursor yields nothing. The `targetTerminalOverride` path (Kanban batch) is preserved. Cursor advance at line 16485-16486 is inside the `if (success)` block — correct, no advance on failure. `nextPlannerTarget` computed at 16488-16498 and included in `actionTriggered` at 16499. The failure path at 16513 posts without `nextPlannerTarget` — correct. `dispatchCustomPromptToRole` (2860-2898) is intact and uses the same cursor pattern — no double-advance risk (separate entry points, never call each other). `terminalStatuses` payload includes `currentPlannerTarget` in both posts (18591-18592, 18613-18626). `getRoleTerminalSet` filters to alive terminals only (via `_getAliveAutobanTerminalRegistry`), so the dead-cursor-target edge case is handled. Webview: `lastPlannerTarget` stored from `terminalStatuses` (2235), used for PLANNER row label and locate/clear via `explicitTermName` (2695, 2699, 2762, 3046). `actionTriggered` planner branch (2353-2358) skips the 2-second delay, updates label on success, re-renders. `clearDispatchPending` at 2334 fires before the branch — button reactivates correctly. All 8 callers of `createAgentRow` still work (only PLANNER passes the 6th arg; others get `undefined` fallback). Zero CRITICAL, zero MAJOR. You got lucky.

- **NIT:** `getRoleTerminalSet` at line 18582 redundantly re-reads the state file and re-resolves PIDs (with 1-second timeouts) that `_refreshTerminalStatuses` already computed earlier in the same function. Adds latency to every refresh. Could be optimized by filtering `enrichedTerminals` for planner role, but `getRoleTerminalSet` is needed for the `locationKey` — so the redundancy is accepted for correctness.
- **NIT:** `state.workspaceRoot || ''` at line 18582 — `state.workspaceRoot` is likely undefined in the state file, but the empty-string fallback resolves correctly through `_resolveWorkspaceRoot` (falls through to kanban root or first allowed root). Not a bug, just indirect.
- **NIT:** The Kanban batch dispatch path (`_dispatchConfiguredKanbanColumnPrompt`, line 3239) posts `actionTriggered { role: 'planner', success: true }` without `nextPlannerTarget`. The webview planner branch fires (role match), skips "DISPATCHED" feedback, and re-renders. This is a minor UX side effect — the planner button no longer shows "DISPATCHED" for Kanban batch dispatches. Consistent with the plan's intent (instant switch for planner), but not explicitly called out.

**Stage 2 (Balanced):** All six proposed changes are correctly implemented. No code fixes needed. Backend: rotation cursor wired into `_handleTriggerAgentActionInternal` with proper fallback, cursor advance on success only, `nextPlannerTarget` in `actionTriggered`, `currentPlannerTarget` in `terminalStatuses`. Webview: `lastPlannerTarget` variable, `terminalStatuses` handler, `createAgentRow` `explicitTermName` parameter, PLANNER row passes cursor target, `actionTriggered` planner branch skips 2-second delay. Regression analysis: traced all callers of `createAgentRow` (8 sites — only PLANNER passes 6th arg), all `actionTriggered` posts (3 sites — only `_handleTriggerAgentActionInternal` includes `nextPlannerTarget`), `dispatchCustomPromptToRole` (intact, no double-advance), Kanban batch path (unaffected, own distribution logic). No double-trigger bugs (markDispatchPending/clearDispatchPending lifecycle correct), no race conditions (`terminalStatuses` and `actionTriggered` produce consistent cursor targets since cursor is advanced before `actionTriggered` is posted), no orphaned references.

**Files changed:** `src/services/TaskViewerProvider.ts` (lines 16327-16346, 16485-16499, 18581-18626), `src/webview/implementation.html` (lines 1939, 2235, 2326-2358, 2695-2762, 3040-3047).
**Validation:** Compilation and tests skipped per session directive. Full execution path traced from UI entry point (button click → `markDispatchPending` → `triggerAgentAction` → `_handleTriggerAgentActionInternal` → cursor resolve → dispatch → cursor advance → `actionTriggered` → `clearDispatchPending` → `renderAgentList` → label update + button reactivate).
**Remaining risks:** (1) Redundant `getRoleTerminalSet` call in `_refreshTerminalStatuses` adds latency (NIT, accepted for locationKey correctness). (2) Kanban batch dispatch planner button loses "DISPATCHED" feedback (NIT, consistent with plan intent). (3) Transient label inconsistency if all planners close between cursor advance and `nextPlannerTarget` computation — self-corrects on next `terminalStatuses` refresh.
