# Repurpose Created Column's Blank-Feature Button as a Planner Fan-Out Toggle for Batch Move

## Goal

Replace the rarely-used "create blank feature" button on the Created column with a toggle that controls whether batch moves (Move All / Move Selected) from Created fan plans out across multiple free planner terminals — one plan per terminal, round-robin — or fall back to the standard single-terminal batch dispatch. Remove the blank-feature creation entry point from the Kanban board entirely.

### Problem Analysis

The Created column currently has a bespoke button (`addBlankFeature`) that opens the feature-create modal in blank mode, producing a subtask-less ghost feature card on the board. This button is rarely used — blank-feature creation already has a proper home in the Project panel's Features tab (`src/webview/project.html` → `+ New Feature` posts `createFeature` with `subtaskPlanIds: []`).

Meanwhile, the planner fan-out — `_distributePlannerDispatch` in `KanbanProvider.ts` — is a complete, reviewed round-robin distributor that resolves the live planner terminal pool, sorts plans oldest-first, applies an optional per-terminal limit, moves cards, and buckets one plan per terminal from a persistent rotation cursor. But it has no dedicated UI surface: it is only reachable as a side effect of Move Selected / Move All from Created, and only when all of these hold: CLI triggers are enabled, the target column maps to the `planner` role, and no custom-user dispatch spec preempts it. There is no visible toggle, no label saying what will happen, and no way for the user to turn the fan-out behavior on or off independently of the global CLI-triggers toggle.

### Root Cause

The fan-out is gated on `this._cliTriggersEnabled` (the global CLI triggers toggle) with no separate, column-scoped control. The blank-feature button occupies the UI slot where a fan-out toggle naturally belongs. The two problems — unused blank-feature button and invisible fan-out — are the same gap from two sides: the Created column's only bespoke control does the wrong thing, and the right thing has no control.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, ui, feature, refactor
- **Project:** Browser Switchboard

## User Review Required

This plan occupies the same Created-column UI slot as the existing reviewed plan `46eafd1c` ("Replace the Created Column's Blank-Feature Button with an Explicit 'Send N plans to planner team'"). The two approaches are mutually exclusive. This plan's toggle approach is the user's stated preference. Confirm before coding that plan `46eafd1c` should be superseded/discarded.

## Complexity Audit

### Routine

- Swapping the Created column's `featureAddBtn` button markup for a toggle-styled button with an on/off visual state (following the `btn-cli-triggers` pattern: `is-active` / `is-off` classes).
- Adding a `plannerFanoutEnabled` boolean setting persisted via `_getScopedSetting` / `_updateScopedSetting`, mirroring `kanban.cliTriggersEnabled`.
- Adding a `togglePlannerFanout` verb arm in the KanbanProvider switch that flips the setting and broadcasts state to the webview.
- Replacing the `case 'addBlankFeature'` webview handler with `case 'togglePlannerFanout'`.
- Deleting the `isBlankFeature` early-return branch in `openFeatureCreateModal` (now callerless).
- Regenerating `protocol-catalog.json` and `src/generated/verbAllowlist.ts` via `npm run catalog:generate`.

### Complex / Risky

- **The toggle must gate the fan-out in both `moveSelected` and `moveAll` — and the gate is additive, not a replacement for `_cliTriggersEnabled`.** The fan-out currently fires when `role === 'planner' && this._cliTriggersEnabled` (KanbanProvider.ts:10726 and 10869). The new toggle adds a third condition: `&& this._plannerFanoutEnabled`. When the toggle is OFF, the code falls through to the standard path (move cards + single `triggerBatchAgentFromKanban` dispatch to one terminal). When ON, it calls `_distributePlannerDispatch` as today. This means:
  - CLI triggers OFF + fan-out ON → no dispatch at all (CLI triggers is the master switch; the fan-out toggle is subordinate). This is correct and matches user expectation: the fan-out toggle refines the CLI-triggers behavior, it does not override it.
  - CLI triggers ON + fan-out OFF → standard single-terminal batch dispatch (the `else` branch at KanbanProvider.ts:10731-10759 and 10877-onwards).
  - CLI triggers ON + fan-out ON → `_distributePlannerDispatch` (current behavior).

- **The toggle state must reach the webview and survive board refreshes.** The column header shell is built once by `renderColumns()` and is NOT rebuilt on a board refresh (documented at `kanban.html:8427-8429`). So the toggle's visual state cannot be interpolated at render time alone — it must be patchable in place, following the established `updateCliToggleUi()` pattern (`kanban.html:6990-6996`). The backend must broadcast `plannerFanoutState` in the `updateBoard` payload (or a dedicated message), and the webview must update the button's `is-active` / `is-off` classes on receipt.

- **The toggle must be hidden when there are no planner terminals or CLI triggers are off.** A toggle that controls fan-out is meaningless when there is no pool to fan out to. Following the existing plan's analysis (feature_plan_20260812150700): the planner pool count must come from `getRoleTerminalSet('planner', root, { allowPtyFleet: true })` — NOT `getAliveRoleTerminalNames` (omits PTY rows, reports 0 while six planners are live) and NOT `getPlannerTerminalCount` (a config field clamped 1..5, never returns 0). When the pool is 0 or CLI triggers are off, hide the toggle entirely (`display: none`), not disabled.

- **Backlog view suppression.** In backlog view, the Created column shows BACKLOG cards and `suppressPipeline` already hides the advance buttons (`kanban.html:7670`). The toggle must be suppressed there too — toggling fan-out for backlog cards is not meaningful.

- **The `addBlankFeature` guard entry in the next-column check.** The webview's column-icon-btn handler has a guard list at `kanban.html:7829` that allows actions through even when `nextCol` is null. `addBlankFeature` is in that list. Replace it with `togglePlannerFanout` (verified: line 7829 is correct).

- **Verb return contract.** The `togglePlannerFanout` arm must `return` its result, not `break` (PRD contract #4, Kanban ratchet ceiling is 1, `npm run verb-returns:check` is in CI).

- **Verb schema.** Add `togglePlannerFanout` to `KANBAN_VERB_SCHEMAS` in `src/services/verbSchemas.ts` (PRD contract #5 — a missing schema is silently permissive, not an error, so omitting it leaves an unvalidated HTTP boundary). Note: `toggleCliTriggers` has NO schema entry in `KANBAN_VERB_SCHEMAS` — this plan adds validation where none existed for the sibling toggle, rather than following an existing pattern. The schema addition is still correct per the plan's own reasoning about unvalidated HTTP boundaries.

- **Removing `addBlankFeature` does not orphan blank-feature creation.** The Project panel's Features tab has a `+ New Feature` button (`src/webview/project.html:1379`) whose submit handler posts `createFeature` with `subtaskPlanIds: []` and `addToKanbanBoard: true` — a blank feature. The zero-subtask branch of `createFeatureFromPlanIds` stays reachable and has headless contract coverage (`src/test/headless-feature-management-contract.test.js:259-268`). The Created-column button was a duplicate entry point.

- **Relationship to the existing reviewed plan.** Plan `46eafd1c` ("Replace the Created Column's Blank-Feature Button with an Explicit 'Send N plans to planner team'") proposes a different UX: an explicit one-shot button that calls `_distributePlannerDispatch` directly. This plan proposes a toggle that modifies the behavior of the existing Move All / Move Selected buttons. The two approaches are mutually exclusive in the UI slot they occupy (the Created column's bespoke button). If both are desired, the toggle approach subsumes the explicit-button approach: with the toggle ON, Move All already fans out; an explicit button is redundant. This plan should be chosen over the explicit-button plan if the user prefers the toggle UX.

## Edge-Case & Dependency Audit

### Side Effects

1. **Zero planner terminals.** Hide the toggle entirely (`display: none`). Do not render it disabled — a disabled toggle implies "turn this on later", but there is nothing to turn on. The pool count must use `getRoleTerminalSet` with `allowPtyFleet: true` (see Complexity Audit).
2. **CLI triggers disabled.** Hide the toggle — the fan-out is subordinate to CLI triggers, so showing a toggle that cannot take effect is a dead control. The webview already receives `cliTriggersState` (`kanban.html:10378-10381`); gate the toggle's visibility on it client-side.
3. **Custom-user dispatch spec on the Planned column.** When a custom-user dispatch spec exists, the `moveSelected`/`moveAll` code takes the `dispatchSpec?.source === 'custom-user'` branch (KanbanProvider.ts:10697 / 10841) which dispatches to a single terminal via `dispatchConfiguredKanbanColumnAction` — it never reaches the `role === 'planner'` check. The fan-out toggle has no effect in this configuration. This is acceptable: the custom-user dispatch is an explicit configuration that overrides the default pipeline behavior. Document this in the toggle's tooltip.
4. **Toggle OFF with batch move.** Move All / Move Selected from Created falls through to the standard path: moves cards to Planned and dispatches all session IDs to one terminal via `triggerBatchAgentFromKanban` (KanbanProvider.ts:10757 / the equivalent `moveAll` else-branch at 10899). This is the pre-fan-out behavior and is correct.
5. **Toggle state persistence across sessions.** The setting is persisted via `_updateScopedSetting('kanban.plannerFanoutEnabled', ...)` and reloaded in `_reloadSettingsFromStore()`. Default: `true` (matches current behavior — the fan-out is currently always on when CLI triggers are on, so existing users keep their behavior).
6. **Backlog view.** The toggle is absent from the rendered markup when `showingBacklog` is true, matching `suppressPipeline` for the advance buttons.
7. **Rotation cursor.** `getPlannerRotationCursor(locationKey)` is persisted in globalState and shared across workspaces. Toggling the fan-out off and back on must not reset the cursor — `_distributePlannerDispatch` already handles this; do not reset it on toggle.
8. **Subtask exclusion.** `_distributePlannerDispatch` receives `sourceCards` from the caller. `moveAll` uses `_visibleColumnCards(workspaceRoot, column)` which correctly excludes feature subtasks (they carry their own `kanban_column`). `moveSelected` uses `_lastCards` filtered by `_cardMatchesIds`. Both are the documented selection helpers — do not change them.

### Race Conditions

9. **Toggle state vs. in-flight dispatch.** If the user toggles the fan-out off while a `_distributePlannerDispatch` is in flight, the in-flight dispatch completes normally (it was already past the gate). The next batch move respects the new state. No cancellation needed — the toggle is a gate on future dispatches, not a kill switch.
10. **Stale pool count.** The pool count is a snapshot at render/updateBoard time. A planner terminal opened after the last board refresh would not update the toggle's visibility until the next `updateBoard`. This is the same staleness window as `coderTerminalCount` and is acceptable — the board refreshes on terminal lifecycle events.

### Dependencies & Conflicts

11. **Generated verb allowlist.** After adding the `togglePlannerFanout` arm to the switch, run `npm run catalog:generate` and commit both `protocol-catalog.json` and `src/generated/verbAllowlist.ts`. Do not hand-edit. Confirm with `npm run catalog:check` and `npm run parity:check`.
12. **Verb return contract.** The arm must `return`, not `break`. Run `npm run verb-returns:check`.
13. **Existing plan 46eafd1c.** This plan occupies the same UI slot as the existing reviewed plan. If both are in the pipeline, only one should be coded. This plan's toggle approach is the user's stated preference.
14. **`ICON_CODE_MAP` const.** The `ICON_CODE_MAP` const (`kanban.html:6434`) is STILL USED by the new planner-fanout toggle button (section a). Do NOT delete it. Only the `featureAddBtn` reference to `ICON_CODE_MAP` is dead — the const itself remains live. Leave the `{{ICON_CODE_MAP}}` entries in the shared placeholder maps (`KanbanProvider.ts:13798`, `headlessPanelHtml.ts:214`) untouched — they are shared surfaces.

> **Superseded:** After removing `featureAddBtn`, the `ICON_CODE_MAP` const (`kanban.html:5208`) has no consumer in the template. Delete it.
> **Reason:** The plan's own section (a) uses `ICON_CODE_MAP` in the new toggle button (`<img src="${ICON_CODE_MAP}" alt="Planner Fan-Out">`). The const is not callerless if the toggle uses it. The line number was also wrong (5208 vs actual 6434).
> **Replaced with:** Keep the `ICON_CODE_MAP` const at line 6434. Only the `featureAddBtn` template reference is dead. The const stays live because the new toggle button uses it.

## Dependencies

- `feature_plan_20260812150700` — Planner pool count resolver analysis (getRoleTerminalSet with allowPtyFleet: true vs getAliveRoleTerminalNames vs getPlannerTerminalCount). This plan depends on that analysis for the pool-count computation.
- Plan `46eafd1c` — Mutually exclusive UI slot conflict. This plan supersedes it if the user confirms the toggle approach.

## Adversarial Synthesis

Key risks: (1) the original plan's section (e) would have replaced the V60 `resolveCodingRolesFromGroups` coder count resolver with the deprecated `getAliveRoleTerminalNames`, silently regressing `coderTerminalCount` for all PTY-fleet users — corrected to keep the existing resolver and only add the planner pool size alongside it; (2) the original plan contradicted itself by using `ICON_CODE_MAP` in the new toggle while simultaneously deleting it as "callerless" — corrected to keep the const; (3) many line numbers were off by 1-1200 lines, which would send a coder to wrong functions — all corrected against current source. Mitigations: superseded callouts mark each correction, the corrected `Promise.all` keeps `resolveCodingRolesFromGroups` as the coder resolver, and `ICON_CODE_MAP` is retained. A connect-time `plannerFanoutState` broadcast was added for parity with `cliTriggersState` to prevent toggle-state staleness before the first board refresh.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**a) Add the `plannerFanoutEnabled` field and persistence.** Beside `_cliTriggersEnabled` (line 260):

```ts
private _plannerFanoutEnabled: boolean;
```

Initialize in the constructor (beside line 527) and in `_reloadSettingsFromStore()` (beside line 894):

```ts
this._plannerFanoutEnabled = this._getScopedSetting<boolean>('kanban.plannerFanoutEnabled', true);
```

**b) Add a public getter and broadcast the state in `updateBoard`.** Beside the `cliTriggersEnabled` getter (line 1041):

```ts
public get plannerFanoutEnabled(): boolean {
    return this._plannerFanoutEnabled;
}
```

In the `updateBoard` payload (at each of the four `coderTerminalCount` sites — lines ~1288/1324, ~2300/2327, ~4024/4034, ~4231/4241), add `plannerFanoutEnabled: this._plannerFanoutEnabled` alongside the existing `cliTriggersEnabled` field.

**c) Add the `togglePlannerFanout` verb arm.** Beside `case 'toggleCliTriggers'` (line 10102):

```ts
case 'togglePlannerFanout':
    this._plannerFanoutEnabled = !!msg.enabled;
    this._markConfigDirty();
    await this._updateScopedSetting('kanban.plannerFanoutEnabled', this._plannerFanoutEnabled);
    // Broadcast the new state so the webview toggle reflects it immediately.
    // NOTE: toggleCliTriggers does NOT post back (the webview updates optimistically).
    // This arm deviates from that pattern by posting a confirmation echo. The echo
    // is harmless (sets the same value the webview already set) and provides a
    // server-confirmed state update that survives webview reloads. The dedicated
    // plannerFanoutState message is also needed for the connect-time resync (see (e)).
    this.postMessage({ type: 'plannerFanoutState', enabled: this._plannerFanoutEnabled });
    return { success: true, enabled: this._plannerFanoutEnabled };
```

**d) Gate the fan-out on the new toggle.** In `moveSelected` (line 10726), change:

```ts
if (role === 'planner' && this._cliTriggersEnabled) {
```
to:
```ts
if (role === 'planner' && this._cliTriggersEnabled && this._plannerFanoutEnabled) {
```

In `moveAll` (line 10869), change:

```ts
if (role === 'planner' && this._cliTriggersEnabled) {
```
to:
```ts
if (role === 'planner' && this._cliTriggersEnabled && this._plannerFanoutEnabled) {
```

When the toggle is OFF, the code falls through to the existing `else` branch which moves cards and dispatches via `triggerBatchAgentFromKanban` to a single terminal — the pre-fan-out behavior.

**e) Thread the planner pool count into `updateBoard`.** At each of the four `coderTerminalCount` sites, resolve the planner pool size **alongside** the existing coder count computation. **Do NOT replace the existing `resolveCodingRolesFromGroups` coder resolver** — it reads from `terminals.groups` in the DB config (the V60 path), while `getAliveRoleTerminalNames` resolves through the deprecated `state.json`. Replacing it would regress `coderTerminalCount` for every PTY-fleet user. Instead, parallelize the two independent async calls:

> **Superseded:** `const [coderTerminalCount, plannerPoolSize] = this._taskViewerProvider ? await Promise.all([this._taskViewerProvider.getAliveRoleTerminalNames('coder', root).then(n => n.length), ...]) : [0, 0];`
> **Reason:** This replaces the existing `resolveCodingRolesFromGroups(root)` coder count resolver with `getAliveRoleTerminalNames('coder', root)`, which resolves through the deprecated `state.json`. The existing code has explicit comments (KanbanProvider.ts:1281-1286) explaining why it does NOT use `getAliveRoleTerminalNames`. This would silently regress the V60 resolver and reintroduce the exact bug those comments exist to prevent.
> **Replaced with:** Keep `resolveCodingRolesFromGroups` as the coder resolver. Only add the planner pool size computation alongside it, parallelized via `Promise.all`:

```ts
// Existing coder resolver — UNCHANGED. Reads from terminals.groups in the DB
// config (V60 path), NOT getAliveRoleTerminalNames (deprecated state.json).
const [_codingRoles, plannerPoolSize] = await Promise.all([
    this.resolveCodingRolesFromGroups(root),
    // NOT getAliveRoleTerminalNames('planner') and NOT getPlannerTerminalCount —
    // see the comment in getPlannerPoolSize. Must use getRoleTerminalSet with
    // allowPtyFleet: true, the same call _distributePlannerDispatch makes.
    this._taskViewerProvider
        ? this._taskViewerProvider.getRoleTerminalSet('planner', root, { allowPtyFleet: true })
            .then(r => r.terminals.length)
        : Promise.resolve(0),
]);
const coderTerminalCount = _codingRoles.coders.length;
const codingHeadLive = _codingRoles.leads.length > 0 || _codingRoles.coders.length > 0;
```

At each of the four sites, the variable names differ (`_codingRoles1` through `_codingRoles4`); adapt accordingly. Add `plannerPoolSize` to each `updateBoard` payload.

Also add `plannerFanoutState` to the connect-time resync (beside `cliTriggersState` at line 1323):

```ts
{ type: 'plannerFanoutState', enabled: this._plannerFanoutEnabled, surface: SURFACES.kanban },
```

This bridges the gap between webview initialization and the first `updateBoard` — without it, the toggle's visual state defaults to `true` until the first board refresh, which may not match the persisted setting.

### `src/services/TaskViewerProvider.ts`

Expose the pool size as a named helper (beside `getRoleTerminalSet`, line 7233):

```ts
/**
 * Planner pool size as _distributePlannerDispatch will see it.
 * MUST go through getRoleTerminalSet with allowPtyFleet: true.
 * See the long comment in _distributePlannerDispatch for why the two
 * plausible alternatives (getAliveRoleTerminalNames without allowPtyFleet,
 * and getPlannerTerminalCount which is a config field clamped 1..5) are wrong.
 */
public async getPlannerPoolSize(workspaceRoot: string): Promise<number> {
    const { terminals } = await this.getRoleTerminalSet('planner', workspaceRoot, { allowPtyFleet: true });
    return terminals.length;
}
```

### `src/services/verbSchemas.ts`

Add to `KANBAN_VERB_SCHEMAS` (the object exported as `VERB_SCHEMAS.kanban`):

```ts
togglePlannerFanout: {
    fields: {
        enabled: { type: 'boolean' },
    },
},
```

### `src/webview/kanban.html`

**a) Replace the `featureAddBtn` const** (line 7649-7653) with a toggle button:

```js
// Was: addBlankFeature — opened the feature-create modal in blank mode, producing
// a subtask-less ghost feature. Blank-feature creation survives in the Project
// panel's Features tab (project.html "+ New Feature" posts createFeature with
// subtaskPlanIds: []).
// Now: a toggle that controls whether batch moves from Created fan plans out
// across multiple free planner terminals (one per terminal, round-robin) or
// fall back to single-terminal batch dispatch.
// Rendered unconditionally and patched in place by updatePlannerFanoutToggle()
// — renderColumns() is NOT re-run on a board refresh (see :8427), so the
// visual state must be patchable, not interpolated at render time.
const plannerFanoutToggleBtn = (isCreated && !showingBacklog)
    ? `<button class="column-icon-btn strip-icon-btn" id="btn-planner-fanout-toggle" data-action="togglePlannerFanout" data-column="${escapeAttr(def.id)}" style="display:none;" data-tooltip="Toggle: fan out Created plans across multiple planner terminals (one per terminal) on batch move">
           <img src="${ICON_CODE_MAP}" alt="Planner Fan-Out">
       </button>`
    : '';
```

Use `plannerFanoutToggleBtn` where `featureAddBtn` was interpolated (line 7715).

**b) Add webview state variables** (beside `cliTriggersEnabled` at line 6117):

```js
let plannerFanoutEnabled = true;
let lastPlannerPoolSize = 0;
```

**c) Add the `plannerFanoutState` message handler** (beside `case 'cliTriggersState'` at line 10378):

```js
case 'plannerFanoutState':
    plannerFanoutEnabled = msg.enabled !== false;
    updatePlannerFanoutToggleUi();
    break;
```

Also read `plannerFanoutEnabled` and `plannerPoolSize` from the `updateBoard` message (beside where `cliTriggersEnabled` / `coderTerminalCount` are read):

```js
if (typeof msg.plannerFanoutEnabled === 'boolean') { plannerFanoutEnabled = msg.plannerFanoutEnabled; }
if (typeof msg.plannerPoolSize === 'number') { lastPlannerPoolSize = msg.plannerPoolSize; }
```

**d) Add the toggle UI updater** (beside `updateCliToggleUi()` at line 6990):

```js
function updatePlannerFanoutToggleUi() {
    const btn = document.getElementById('btn-planner-fanout-toggle');
    if (!btn) return;
    // Hidden when there is no planner pool or CLI triggers are off — the toggle
    // controls a behavior that cannot take effect in either case.
    const usable = lastPlannerPoolSize > 0 && cliTriggersEnabled;
    btn.style.display = usable ? '' : 'none';
    if (!usable) return;
    btn.classList.toggle('is-active', plannerFanoutEnabled);
    btn.classList.toggle('is-off', !plannerFanoutEnabled);
    btn.setAttribute('data-tooltip',
        plannerFanoutEnabled
            ? `Fan-out ON: batch move from Created distributes ${lastPlannerPoolSize > 0 ? `across ${lastPlannerPoolSize} planner terminal(s)` : 'across planner terminals'} (one plan each, round-robin)`
            : 'Fan-out OFF: batch move from Created dispatches all plans to a single planner terminal'
    );
}
```

**e) Call the updater from all refresh paths:**
- `renderColumns()` — beside `updateDispatchToggleCount()` / `updateDispatchViewInfo()` calls (line ~7747-7748).
- `renderBoard()` — beside the same pair (line ~7338-7339).
- The `updateBoard` handler — after `plannerFanoutEnabled` / `lastPlannerPoolSize` are assigned.
- The `cliTriggersState` handler (line 10378-10381) — call `updatePlannerFanoutToggleUi()` after `updateCliToggleUi()`.

**f) Replace the `case 'addBlankFeature'` handler** (line 7973-7981) with:

```js
case 'togglePlannerFanout': {
    plannerFanoutEnabled = !plannerFanoutEnabled;
    updatePlannerFanoutToggleUi();
    postKanbanMessage({ type: 'togglePlannerFanout', enabled: plannerFanoutEnabled });
    break;
}
```

**g) Update the guard list** (line 7829) — replace `action !== 'addBlankFeature'` with `action !== 'togglePlannerFanout'`.

**h) Dead-code removal** — delete the `isBlankFeature` early-return block in `openFeatureCreateModal` (lines 11583-11594), now callerless. **Do NOT delete the `ICON_CODE_MAP` const** (line 6434) — it is still used by the new planner-fanout toggle button. Leave the `{{ICON_CODE_MAP}}` entries in the shared placeholder maps (`KanbanProvider.ts:13798`, `headlessPanelHtml.ts:214`) untouched.

### `protocol-catalog.json` + `src/generated/verbAllowlist.ts`

Do not hand-edit. After the arm is in the switch, run `npm run catalog:generate` and commit both regenerated files.

## Verification Plan

### Automated Tests

1. **Toggle gates the fan-out.** With `plannerFanoutEnabled = true`, `moveAll` from Created calls `_distributePlannerDispatch`. With `plannerFanoutEnabled = false`, it falls through to the standard `triggerBatchAgentFromKanban` path. Assert the dispatch command received is `triggerBatchAgentFromKanban` (single terminal) not the distribute path.
2. **Toggle persists.** Set `plannerFanoutEnabled = false`, reload settings, assert `_plannerFanoutEnabled` reads `false`. Set to `true`, reload, assert `true`. Default is `true` for a fresh install.
3. **Toggle is subordinate to CLI triggers.** With `cliTriggersEnabled = false` and `plannerFanoutEnabled = true`, `moveAll` from Created does NOT call `_distributePlannerDispatch` (the CLI gate fires first). No dispatch happens at all.
4. **Pool count uses the right resolver.** Stub the registry so `getAliveRoleTerminalNames('planner', ...)` returns `[]` while `getRoleTerminalSet('planner', ..., { allowPtyFleet: true })` returns six names. Assert `plannerPoolSize` in the `updateBoard` payload is **6**, not 0.
5. **Toggle visibility.** Pool 0 → toggle `display: none`. Pool 4, CLI triggers on → toggle visible. CLI triggers off → toggle `display: none` regardless of pool.
6. **Toggle visual state.** `plannerFanoutEnabled = true` → button has `is-active`, not `is-off`. `false` → `is-off`, not `is-active`.
7. **Backlog view.** With `showingBacklog` true, the toggle is absent from the rendered markup.
8. **Return contract.** The `togglePlannerFanout` arm has no `break`; run `npm run verb-returns:check`.
9. **Schema.** Assert `VERB_SCHEMAS.kanban.togglePlannerFanout` exists and that a payload of `{}` validates (field optional).
10. **Verb allowlist.** Run `npm run catalog:check` (no drift after regeneration) and `npm run parity:check`.
11. **Dead code.** Assert `openFeatureCreateModal` no longer has a `blankFeature` branch. Assert `ICON_CODE_MAP` const is still present (used by the new toggle) and `featureAddBtn` is gone from the template.
12. **coderTerminalCount regression guard.** Assert that `coderTerminalCount` in the `updateBoard` payload is still computed via `resolveCodingRolesFromGroups`, NOT `getAliveRoleTerminalNames`. Stub `resolveCodingRolesFromGroups` to return 3 coders and `getAliveRoleTerminalNames('coder', ...)` to return 0. Assert `coderTerminalCount === 3`. This catches the regression the original plan would have introduced.
13. **Connect-time resync.** Assert that a `plannerFanoutState` message is sent at connect time (beside `cliTriggersState`), so the toggle's visual state matches the persisted setting before the first `updateBoard`.
14. **Regression.** Run the kanban dispatch suites. Stash-verify before attributing any red to this change.

### Manual

15. With the extension running and planner terminals live: the Created column shows the fan-out toggle. Click it — the visual state flips (active ↔ off). Perform Move All from Created with the toggle ON: confirm plans are distributed one-per-terminal across the planner pool. Perform Move All with the toggle OFF: confirm all plans go to a single planner terminal.
16. Close all planner terminals: confirm the toggle disappears without a board structure change (exercises the patcher, not a header rebuild). Re-open one: confirm it returns.
17. Turn off CLI triggers: confirm the toggle disappears. Turn CLI triggers back on: confirm it returns.
18. Confirm blank-feature creation still works from the Project panel's Features tab (`+ New Feature`), and that the Created column no longer offers it.
19. Repeat 15 in the browser cockpit — rebuild and reinstall the VSIX first.
