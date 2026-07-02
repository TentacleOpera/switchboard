# Planner Agent Row Shows IDE-Suffixed Terminal Name ("planner - planner-devin")

## Goal

### Problem
In the Implementation tab (`src/webview/implementation.html`), the Planner agent row renders a weird display name like `PLANNER - Planner-devin` (reported by the user as "planner - planner-devin"). The `-devin` (or `-Windsurf`, `-Cursor`, etc.) sub-name is unexpected and confusing — the user asks "where is the sub name coming from?"

### Background / Root Cause
The Planner agent row's display name is driven by the **planner rotation cursor target** (`lastPlannerTarget` in the webview), not by the binary-derived `displayName` used for other roles. The relevant render path in `createAgentRow` (`src/webview/implementation.html:2768-2772`):

```js
const displayName = explicitTermName
    || (dispatchInfo && dispatchInfo.isWorktreeTerminal && dispatchInfo.terminalName ? dispatchInfo.terminalName : lastTerminalAgentNames[roleId]);
if (displayName) {
    name.innerHTML = `${label} - ${displayName}${suffix}`;
}
```

For the Planner row, `explicitTermName = lastPlannerTarget` is passed (`implementation.html:3048-3053`). `lastPlannerTarget` is populated from two backend payload fields:
- `currentPlannerTarget` in `terminalStatuses` messages (`implementation.html:2243`)
- `nextPlannerTarget` in `actionTriggered` messages (`implementation.html:2362-2363`)

Both fields are computed in `src/services/TaskViewerProvider.ts` from `getRoleTerminalSet('planner', ...)`:

```ts
// line 18557-18564 (terminalStatuses)
const plannerSet = await this.getRoleTerminalSet('planner', state.workspaceRoot || '');
if (plannerSet.terminals.length > 0) {
    const cursor = this.getPlannerRotationCursor(plannerSet.locationKey);
    const picked = plannerSet.terminals[cursor % plannerSet.terminals.length];
    if (picked && this._isValidAgentName(picked)) {
        currentPlannerTarget = picked;   // <-- suffixed key sent to webview
    }
}

// line 16462-16472 (actionTriggered, after dispatch)
const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
if (terminals.length > 0) {
    const nextCursor = this.getPlannerRotationCursor(locationKey);
    const picked = terminals[nextCursor % terminals.length];
    if (picked && this._isValidAgentName(picked)) {
        nextPlannerTarget = picked;      // <-- suffixed key sent to webview
    }
}
```

`getRoleTerminalSet` (`TaskViewerProvider.ts:3742-3766`) returns the **keys** of the autoban terminal registry:

```ts
const entries = Object.entries(aliveTerminals)
    .filter(([, info]) => this._normalizeAgentKey((info as any)?.role) === normalizedRole)
    ...
const terminals = entries.map(([name]) => name);
```

Those keys are **IDE-suffixed**. Every terminal is registered into `state.terminals` under `suffixedName(...)` = `${baseName}-${vscode.env.appName}`:
- Grid terminals: `state.terminals[suffixedName(agent.name)]` with `friendlyName: agent.name` (`extension.ts:2758-2785`)
- Autoban pool terminals: `state.terminals[suffixedUniqueName]` with `friendlyName: uniqueName` (`TaskViewerProvider.ts:7026-7033`)
- User-registered terminals: `state.terminals[suffixedKey]` with `friendlyName: rawName` (`TaskViewerProvider.ts:15695-15708`)

So `picked` is a string like `"Planner-devin"` (when `vscode.env.appName` resolves to `devin`), and that raw suffixed key is pushed straight to the webview and rendered as the display name — producing `PLANNER - Planner-devin`.

The registry entry always carries a `friendlyName` field holding the **unsuffixed** human-readable name (`"Planner"`, `"Planner 2"`, etc.), and `_stripIdeSuffix(name)` (`TaskViewerProvider.ts:1491-1494`) removes the `-${appName}` suffix. Neither is used at the display boundary today.

### Why other roles don't show this
Only the Planner row passes `explicitTermName` (the cursor target). All other agent rows fall through to `lastTerminalAgentNames[roleId]`, which comes from `getActualTerminalAgentNames()` → `info.displayName` (the binary-derived `"DEVIN CLI"` / `"CLAUDE CLI"` string), never the suffixed registry key. So this bug is Planner-specific.

## Metadata
- **Complexity:** 3
- **Tags:** ui, bugfix, frontend, backend, planner, terminal-naming

## Complexity Audit
**Routine.** The fix is a pure display-string transformation at two assignment sites in a single file. No control-flow changes, no new state, no schema changes. `getRoleTerminalSet` is left untouched so dispatch routing (which depends on the suffixed key for correct terminal lookup via `_suffixedName` / `_registeredTerminals`) is unaffected. The `_stripIdeSuffix` helper already exists and is used in ~20 other places. Risk is limited to the planner row label reverting to the unsuffixed name.

## Edge-Case & Dependency Audit
- **Dispatch routing must keep the suffixed key.** `getRoleTerminalSet` is also used in `_handleTriggerAgentActionInternal` (line 16306) and `dispatchCustomPromptToRole` (line 2873) to pick the actual terminal to dispatch to; those paths resolve the terminal via `_registeredTerminals.get(_suffixedName(...))` and need the suffixed key. **Mitigation:** do NOT modify `getRoleTerminalSet`; strip only at the `currentPlannerTarget` / `nextPlannerTarget` assignment sites.
- **`friendlyName` vs `stripIdeSuffix`.** The registry entry's `friendlyName` is the most accurate display name (it reflects user aliases / renames). However `getRoleTerminalSet` returns only keys, not info objects. Re-reading the registry inside the display sites would duplicate work. `_stripIdeSuffix(picked)` is sufficient and matches the user's expectation (remove the `-devin` suffix). If a user has set an alias via the rename UI, `friendlyName` would already differ from the key — but the alias is surfaced separately via `allOpenTerminals` displayName and the dropdown, not via the planner cursor target, so stripping the suffix is the correct minimal fix here.
- **Pool terminals ("Planner 2", "Planner 3").** Their suffixed keys are `"Planner 2-devin"`; `_stripIdeSuffix` yields `"Planner 2"` — correct.
- **`vscode.env.appName` containing regex-special chars.** `_stripIdeSuffix` uses `String.endsWith`, not regex — safe.
- **No terminal alive / picked undefined.** Existing guards (`if (picked && this._isValidAgentName(picked))`) already skip assignment; stripping is only applied to a validated `picked`, so no new null path.
- **Shipped-state impact.** This is a pure display fix with no state migration. No user data is touched. The `terminalAgentNames` / `currentPlannerTarget` payload contract is unchanged in shape (still a string | undefined); only the string content changes.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — strip IDE suffix at the two display-boundary sites

**Site 1 — `currentPlannerTarget` in `_refreshTerminalStatuses` (line 18557-18565):**

```ts
let currentPlannerTarget: string | undefined;
const plannerSet = await this.getRoleTerminalSet('planner', state.workspaceRoot || '');
if (plannerSet.terminals.length > 0) {
    const cursor = this.getPlannerRotationCursor(plannerSet.locationKey);
    const picked = plannerSet.terminals[cursor % plannerSet.terminals.length];
    if (picked && this._isValidAgentName(picked)) {
        currentPlannerTarget = this._stripIdeSuffix(picked);
    }
}
```

**Site 2 — `nextPlannerTarget` in `_handleTriggerAgentActionInternal` (line 16462-16472):**

```ts
let nextPlannerTarget: string | undefined;
if (role === 'planner' && plannerLocationKey) {
    const { terminals, locationKey } = await this.getRoleTerminalSet('planner', resolvedWorkspaceRoot);
    if (terminals.length > 0) {
        const nextCursor = this.getPlannerRotationCursor(locationKey);
        const picked = terminals[nextCursor % terminals.length];
        if (picked && this._isValidAgentName(picked)) {
            nextPlannerTarget = this._stripIdeSuffix(picked);
        }
    }
}
```

No other files need changes. The webview already renders `lastPlannerTarget` verbatim (`implementation.html:2772`), so once the backend sends the unsuffixed name, the row will display `PLANNER - Planner` (or `PLANNER - Planner 2` for pool terminals).

### Why not fix in `getRoleTerminalSet` or the webview
- `getRoleTerminalSet` must keep returning suffixed keys for dispatch routing (see Edge-Case audit).
- Stripping in the webview would require shipping a matching `stripIdeSuffix` JS helper and the appName into the webview; the backend already owns `_stripIdeSuffix` and the appName, so doing it there is one place, not two.

## Verification Plan
1. **Reproduce before fix:** With the planner terminal open (Devin CLI / any CLI), open the Implementation tab and observe the Planner row shows `PLANNER - Planner-<appName>` (e.g. `PLANNER - Planner-devin`).
2. **Apply fix** (the two `_stripIdeSuffix(picked)` edits).
3. **Compile:** `npm run compile` (webpack) — confirm no type errors. (Note: `dist/` is not used during dev testing; this is just a typecheck gate.)
4. **Build VSIX & install** per project convention (testing is via installed VSIX, not repo `dist/`).
5. **Single planner terminal:** Open the planner agent terminal, open Implementation tab → Planner row reads `PLANNER - Planner` (no `-devin` / `-Windsurf` suffix). Red/green dot and IMPROVE PLAN button behave as before.
6. **Pool of 3 planners:** Set planner terminal count to 3, open agent terminals → row reads `PLANNER - Planner`, then after each dispatch the label rotates to `PLANNER - Planner 2`, `PLANNER - Planner 3`, back to `PLANNER - Planner` (verifies `nextPlannerTarget` path and bare-suffix pool names strip correctly).
7. **Dispatch still routes correctly:** Click IMPROVE PLAN on the Planner row → the prompt is sent to the correct (cursor-targeted) terminal. This confirms `getRoleTerminalSet` still returns suffixed keys for routing and only the display string changed.
8. **No planner terminal alive:** Row falls back to `PLANNER` with no suffix (existing behaviour preserved — `currentPlannerTarget` stays undefined).
9. **Run existing planner-rotation regression tests** (`src/test/pipeline-orchestrator-regression.test.js` and any planner-rotation tests) to confirm no routing regressions.
