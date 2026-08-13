# Replace the Created Column's Blank-Feature Button with an Explicit "Send N plans to planner team"

## Goal

Give the planner fan-out a named, discoverable button on the Created column that states exactly how many plans it will send and hides itself when there is no planner pool to send them to. Retire the blank-feature button from that column to make room.

### The problem

Two halves of the same gap:

1. **The Created column's only bespoke button creates an empty feature.** `src/webview/kanban.html:6078-6082`:
   ```js
   const featureAddBtn = isCreated
       ? `<button class="column-icon-btn" data-action="addBlankFeature" data-column="${escapeAttr(def.id)}" data-tooltip="Add a blank feature to this column">
              <img src="${ICON_CODE_MAP}" alt="Add Feature">
          </button>`
       : '';
   ```
   It opens the feature-create modal in blank mode (`openFeatureCreateModal({ blankFeature: true })`, line 6383) after clearing the selection. A feature with no subtasks is a ghost card on the board.

2. **The planner fan-out is implemented, reviewed, and has no button.** `KanbanProvider._distributePlannerDispatch` (`src/services/KanbanProvider.ts:5800`) is a complete round-robin distributor: it resolves the live planner pool, sorts oldest-first, applies the optional per-terminal limit, moves the cards, and buckets one plan per terminal from a persistent rotation cursor.
   ```ts
   const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot, { allowPtyFleet: true });
   ...
   const limit = !options?.skipLimit && await tvp.getLimitDispatchToTerminals('planner', workspaceRoot);
   const plans = limit ? ordered.slice(0, terminals.length) : ordered;
   ...
   const cursor = tvp.getPlannerRotationCursor(locationKey);
   plans.forEach((card, i) => { const term = terminals[(cursor + i) % terminals.length]; ... });
   ```

### Root cause of "there is no way to access the planner fan out feature"

`_distributePlannerDispatch` has exactly two call sites, both inside generic move verbs, and both behind gates that hide it:

- `moveSelected` → line 9626, `{ skipLimit: true }`
- `moveAll` → line 9766

Each sits in the `else` of a `dispatchSpec` check:

```ts
const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol, msg.initiatorProject);
if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
    ... dispatchConfiguredKanbanColumnAction(...)   // NO fan-out — single target
} else {
    const role = this._columnToRole(nextCol);
    if (role === 'planner' && this._cliTriggersEnabled) {
        await this._distributePlannerDispatch(workspaceRoot, sourceCards, nextCol);
```

So the fan-out runs only when **all** of these hold: the action is Move Selected or Move All, the source column is Created (so `nextCol` maps to the `planner` role), CLI triggers are enabled, and the target column has **no** custom-user dispatch spec. Any configured dispatch on the Planned column silently routes to `dispatchConfiguredKanbanColumnAction`, which dispatches to one terminal. Nothing in the UI names the behaviour, nothing reports which terminals were used, and the two buttons that reach it are labelled "move to next stage".

The fix is a button that says what it does, with the count in the label.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, ui, feature
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Swapping the Created column's button markup and switch arm.
- Adding a `sendCreatedToPlannerTeam` verb that calls the existing `_distributePlannerDispatch`.
- Threading a count into the `updateBoard` payload, mirroring `coderTerminalCount`.

**Complex / Risky — read this before writing the count**

- **The obvious way to count planner terminals is wrong.** `coderTerminalCount` is built as
  ```ts
  (await this._taskViewerProvider.getAliveRoleTerminalNames('coder', root)).length
  ```
  and `getAliveRoleTerminalNames` (`TaskViewerProvider.ts:5891`) calls `_getAliveAutobanTerminalRegistry(workspaceRoot)` **without** `{ allowPtyFleet: true }`. `_distributePlannerDispatch` passes `allowPtyFleet: true` deliberately, with a long comment explaining why: PTY rows fail the registry's liveness test entirely (no `pidMatch`, no `nameMatch`, `ideName: 'switchboard-pty'` matches no `appName`, and no `lastSeen` field is ever written), and "leaving the pool resolver blind to PTY rows is what collapsed a whole grid of planners onto one terminal". Copying the coder pattern verbatim would report **0** planner terminals while the dispatcher sees six — hiding the button in exactly the configuration where it works. The count MUST come from `getRoleTerminalSet('planner', root, { allowPtyFleet: true })`.
- **`getRoleTerminalSet` is expensive.** Its own comment (at the reuse note, line ~5893 in KanbanProvider) says it runs `_getAliveAutobanTerminalRegistry`, "a Promise.all over PID resolution with up to 1s timeout per terminal". It is already called on every board refresh for coders; adding a second per-refresh call doubles that cost. Resolve both counts from **one** registry read, or cache per refresh.
- **The button's count is a snapshot and the dispatch re-reads.** `_distributePlannerDispatch` takes `sourceCards` from the caller. The verb must re-read the Created column inside the handler (as `sendDispatchSetToCoders` does at line 10688 — "Re-reads the set from the latest board state inside the handler so a card dragged out between render and press is skipped, not dispatched"), so a card moved between render and press is not dispatched from a stale list.
- **`n = min(plans, planners)` is the label, not necessarily the dispatch.** `_distributePlannerDispatch`'s slice-to-`terminals.length` is conditional on `getLimitDispatchToTerminals('planner', ...)`. With the limit OFF, more plans than terminals are all dispatched, round-robin, several per terminal. The label must not promise `min(...)` while the code sends everything. Decision: label with the number that will actually be dispatched — read the limit setting when building the payload and compute accordingly.
- **The subtask-exclusion contract.** `_visibleColumnCards` is the documented selection helper precisely because a naive column sweep picks up a BACKLOG feature's subtasks (feature subtasks carry their own `kanban_column`). Use `_visibleColumnCards(workspaceRoot, 'CREATED')` — which `batchPlannerPrompt` (line 9460) already does — never a raw `_lastCards` column filter. `sendDispatchSetToCoders` additionally filters `!c.featureId`; decide and state whether feature subtasks in Created are in scope (they should NOT be — a subtask's plan is improved via its feature).
- **Removing `addBlankFeature` from Created removes the only entry point to blank-feature creation.** Verify whether another surface offers it (the Features tab / the board's feature action button). If Created is the only one, the modal path becomes unreachable — either leave a blank-feature entry point elsewhere or state explicitly that blank features are being retired. Do not silently orphan `openFeatureCreateModal({ blankFeature: true })` and its `createFeatureFromPlanIds` zero-subtask branch (`KanbanProvider.ts:13250`), which was deliberately made valid.
- **Planner teams do not exist yet.** The user notes team support is planned work on another plan. This plan must therefore gate on the *planner terminal pool* — which does exist and is exactly what the dispatcher uses — and be written so that swapping the gate to a team lookup later is a one-line change behind a single helper.

## Edge-Case & Dependency Audit

1. **Zero planner terminals.** Hide the button entirely (the user's requirement). Do not render it disabled — a disabled button implies "do this later", and the fallback path in `_distributePlannerDispatch` (lines 5822-5847) would batch everything onto one terminal, which is the behaviour this button exists to make visible.
2. **Zero plans in Created.** Render the button disabled with the count `0`, matching `sendDispatchSetToCoders`' `dispatchStagedNow === 0` idiom. The distinction from (1) is deliberate: no planners is a capability gap, no plans is a transient state.
3. **CLI triggers disabled.** Both existing call sites gate on `this._cliTriggersEnabled`. The verb must too, and the button must be hidden or disabled to match — a press that silently does nothing is a dead click. The webview already receives `cliTriggersState` (`KanbanProvider.ts:1249`), so gate on it client-side as well.
4. **Unknown complexity.** `_distributePlannerDispatch` does **not** filter on complexity (unlike the coder paths, which call `_filterUnknownComplexitySessions`). Planning a plan is what assigns complexity, so this is correct — do not add a complexity filter, and do not "fix" the asymmetry.
5. **Custom-user dispatch spec on the Planned column.** The new verb calls `_distributePlannerDispatch` **directly**, so it is not subject to the `dispatchSpec` preemption that hides the fan-out today. State this: the button is the explicit fan-out, and it deliberately overrides a configured single-target dispatch. That is the whole point.
6. **Project filter scope.** `copyDispatchPromptSelected` and `dispatchAnalyze` both scope to `msg.initiatorProject` with three-way handling (`undefined` = raw API caller → no scope). The new verb must follow the same convention, or a multi-project board fans out plans the user cannot see.
7. **Backlog view.** In backlog view the Created column shows BACKLOG cards and `suppressPipeline` already hides the advance buttons (line 6094). The new button must be suppressed there too — sending backlog cards to planners is not what the button says.
8. **Selection semantics.** `sendDispatchSetToCoders` sends the whole staged set and ignores selection. Follow that: this button sends the Created column (project-scoped), not the selection — the label carries a count, and a count that silently means "your selection" is a trap. Selection-based sending already exists via Move Selected.
9. **Rotation cursor.** `getPlannerRotationCursor(locationKey)` is persisted in globalState and shared across workspaces serving the same terminals. Pressing the button repeatedly must continue the rotation, not restart at terminal 0 — `_distributePlannerDispatch` already handles this; do not reset it.
10. **The `skipLimit` option.** `moveSelected` passes `{ skipLimit: true }`; `moveAll` does not. The new button is an "all" action, so it must respect the limit (no `skipLimit`) — and the label must reflect the limited count per the Complexity Audit note above.
11. **Live count refresh.** `coderTerminalCount` is recomputed on every `updateBoard` (four sites: lines 1220, 2107, 3658, 3856). Add the planner count at all four or the label goes stale on some refresh paths. Missing one is the classic writer/reader split.
12. **Standalone host.** `_distributePlannerDispatch` reaches terminals through `TaskViewerProvider` seams; in standalone, PTY is the only fleet — which is exactly why `allowPtyFleet: true` is unconditional there. Verify the count helper behaves the same in the standalone bootstrap path.
13. **No confirm dialog** before dispatching (repo rule). The count in the label is the safeguard.
14. **Verb allowlist.** Add the new verb to `KANBAN_VERBS` in `src/generated/verbAllowlist.ts` (regenerate rather than hand-edit if a generator exists), or the browser transport rejects it.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

Expose the pool size using the **same** resolution the dispatcher uses:

```ts
/**
 * Planner pool size as _distributePlannerDispatch will see it.
 *
 * MUST go through getRoleTerminalSet with allowPtyFleet: true, NOT
 * getAliveRoleTerminalNames. The latter omits allowPtyFleet, and PTY rows fail the
 * registry liveness test outright (no pidMatch/nameMatch, ideName
 * 'switchboard-pty' matches no appName, no lastSeen is ever written). Counting
 * with it reports 0 while the dispatcher sees the whole grid — hiding the button
 * in precisely the configuration where the fan-out works.
 */
public async getPlannerPoolSize(workspaceRoot: string): Promise<number> {
    const { terminals } = await this.getRoleTerminalSet('planner', workspaceRoot, { allowPtyFleet: true });
    return terminals.length;
}
```

### `src/services/KanbanProvider.ts`

**a) Thread the count and the effective send size into `updateBoard`.** At each of the four `coderTerminalCount` sites (1220, 2107, 3658, 3856):

```ts
const plannerPoolSize = this._taskViewerProvider
    ? await this._taskViewerProvider.getPlannerPoolSize(root)
    : 0;
const plannerLimitOn = this._taskViewerProvider
    ? await this._taskViewerProvider.getLimitDispatchToTerminals('planner', root)
    : false;
```

and add `plannerPoolSize, plannerLimitOn` to the `updateBoard` payload beside `coderTerminalCount`.

**b) New verb arm**, modelled on `sendDispatchSetToCoders` (line 10675):

```ts
case 'sendCreatedToPlannerTeam': {
    // The EXPLICIT entry point to the planner fan-out. _distributePlannerDispatch
    // has existed and been reviewed, but was reachable only as a side effect of
    // Move Selected / Move All from Created — and only when the Planned column had
    // no custom-user dispatch spec (that branch preempts it and dispatches to ONE
    // terminal). This arm calls the distributor directly, so a configured
    // single-target dispatch does not silently defeat the fan-out.
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._currentWorkspaceRoot;
    if (!workspaceRoot) { return { success: false, error: 'No workspace root resolved' }; }
    if (!this._cliTriggersEnabled) {
        void this._seams().ui.showWarningMessage('CLI triggers are disabled — enable them to dispatch to planners.');
        return { success: false, error: 'CLI triggers are disabled.' };
    }
    const poolSize = this._taskViewerProvider
        ? await this._taskViewerProvider.getPlannerPoolSize(workspaceRoot) : 0;
    if (poolSize === 0) {
        void this._seams().ui.showWarningMessage('No live planner terminals. Open one, then try again.');
        return { success: false, error: 'No live planner terminals.' };
    }
    // Re-read INSIDE the handler so a card dragged out of Created between render
    // and press is skipped, not dispatched from a stale list.
    // _visibleColumnCards, not a raw _lastCards filter — a raw column sweep picks
    // up a BACKLOG feature's subtasks (they carry their own kanban_column).
    const scope: string | null = msg.initiatorProject === undefined ? null : msg.initiatorProject;
    const sourceCards = this._visibleColumnCards(workspaceRoot, 'CREATED')
        .filter(card => this._cardMatchesProjectFilter(card, scope))
        .filter(card => !card.featureId);   // a subtask's plan is improved via its feature
    if (sourceCards.length === 0) {
        void this._seams().ui.showInformationMessage('No plans in Created to send.');
        return { success: false, error: 'No plans in Created to send.' };
    }
    const nextCol = await this._getNextColumnId('CREATED', workspaceRoot);
    if (!nextCol) { return { success: false, error: 'No next column after CREATED' }; }
    // No skipLimit: this is an "all" action, and the button's label was computed
    // from the limited count — the two must agree.
    await this._distributePlannerDispatch(workspaceRoot, sourceCards, nextCol);
    return { success: true, planCount: sourceCards.length, poolSize };
}
```

### `src/webview/kanban.html`

**a) Replace the Created button** (lines 6078-6082):

```js
// Was: an addBlankFeature button, which created a subtask-less ghost feature.
// Now: the explicit planner fan-out, labelled with the number it will send.
// Hidden (not disabled) when there is no planner pool — a disabled button implies
// "later", while the dispatcher's no-pool fallback batches everything onto ONE
// terminal, which is exactly what this button exists to make visible.
const plannerSendCount = (isCreated && !showingBacklog)
    ? plannerSendableCount()          // min(createdPlans, pool) when the limit is on, else createdPlans
    : 0;
const plannerTeamBtn = (isCreated && !showingBacklog && lastPlannerPoolSize > 0 && cliTriggersEnabled)
    ? `<button class="column-icon-btn" id="btn-send-to-planner-team" data-action="sendCreatedToPlannerTeam" data-column="${escapeAttr(def.id)}" data-tooltip="Fan the Created plans out across the ${lastPlannerPoolSize} live planner terminal(s) — one plan each, round-robin" style="width:auto; padding:0 8px; font-size:10px;"${plannerSendCount === 0 ? ' disabled' : ''}>Send ${plannerSendCount} plans to planner team</button>`
    : '';
```

Use `plannerTeamBtn` wherever `featureAddBtn` was interpolated, and delete `featureAddBtn`.

**b) Switch arm** (replacing `case 'addBlankFeature'` at line 6383):

```js
case 'sendCreatedToPlannerTeam': {
    postKanbanMessage({
        type: 'sendCreatedToPlannerTeam',
        workspaceRoot: getActiveWorkspaceRoot(),
        initiatorProject: getActiveProjectFilter()
    });
    break;
}
```

**c) Guard list** (line 6251) — replace `action !== 'addBlankFeature'` with `action !== 'sendCreatedToPlannerTeam'`.

**d) State** — add `lastPlannerPoolSize` / `lastPlannerLimitOn` beside `lastCoderTerminalCount` (line 8373) and read them from `updateBoard`:

```js
if (typeof msg.plannerPoolSize === 'number') { lastPlannerPoolSize = msg.plannerPoolSize; }
if (typeof msg.plannerLimitOn === 'boolean') { lastPlannerLimitOn = msg.plannerLimitOn; }
```

**e)** Add a `plannerSendableCount()` helper that returns `lastPlannerLimitOn ? Math.min(createdCount, lastPlannerPoolSize) : createdCount`, counting Created cards under the active project filter and excluding cards with a `featureId`.

### `src/generated/verbAllowlist.ts`

Add `sendCreatedToPlannerTeam` to `KANBAN_VERBS`.

### Blank-feature entry point

Before deleting `addBlankFeature`, confirm whether another surface creates a blank feature. If Created was the only one, add the action to the Features tab (or the board's feature action menu) in the same change — do not leave `openFeatureCreateModal({ blankFeature: true })` and the zero-subtask branch of `createFeatureFromPlanIds` unreachable.

## Verification Plan

1. **Unit — the count uses the right resolver (the highest-risk item).** Stub the registry so `getAliveRoleTerminalNames('planner', ...)` returns `[]` while `getRoleTerminalSet('planner', ..., { allowPtyFleet: true })` returns six names. Assert `getPlannerPoolSize` returns **6**, and assert the source does not call `getAliveRoleTerminalNames`.
2. **Unit — count reaches all four refresh paths.** Assert `plannerPoolSize` is present in the `updateBoard` payload emitted from each of the four sites that already carry `coderTerminalCount`.
3. **Unit — label arithmetic.** With 9 Created plans and a pool of 4: limit ON → label reads `Send 4 plans to planner team`; limit OFF → `Send 9 plans to planner team`.
4. **Unit — hidden vs disabled.** Pool 0 → the button is absent from the rendered markup. Pool 4 with 0 Created plans → present and `disabled`. CLI triggers off → absent.
5. **Unit — backlog view.** With `showingBacklog` true, the button is absent.
6. **Unit — selection is ignored.** With three of nine Created cards selected, the verb dispatches all nine (limit off), proving the label's count is the truth.
7. **Unit — subtask exclusion.** A BACKLOG feature with subtasks whose `kanban_column` is `CREATED`: assert those subtasks are NOT in the dispatched set (this is the documented Advance-All-swept-a-feature's-subtasks bug).
8. **Unit — project scope.** Two projects with Created plans; with `initiatorProject` set to one, only that project's plans dispatch. With `initiatorProject: undefined` (raw API), no scope is applied.
9. **Unit — stale-card re-read.** Remove a card from `_lastCards` between building the payload and invoking the verb; assert it is not dispatched.
10. **Unit — no-pool guard.** With pool 0, the verb returns `success: false` and calls `_distributePlannerDispatch` **zero** times (it must not fall through to the one-terminal fallback).
11. **Unit — rotation continues.** Two consecutive presses with a pool of 3 and 2 plans each: assert the second press starts at terminal index 2, not 0.
12. **Unit — allowlist.** `KANBAN_VERBS` contains `sendCreatedToPlannerTeam`.
13. **Regression.** Run the kanban dispatch suites, including `src/test/dispatch-analysis-scope-contract.test.js` and `src/test/kanban-drag-confirm-before-dispatch.test.js`. Note five regression tests are red at HEAD independently — stash-verify before attributing red to this change.
14. **Manual.** With the extension running and six planner terminals live (verify via `POST /terminals/verb/ptyListTerminals`): the Created column shows `Send N plans to planner team`. Press it and confirm N distinct planner terminals each receive one plan (not one terminal receiving a batch), and that the cards move to Planned. Close every planner terminal and confirm the button disappears. Re-open one and confirm it returns with the count updated.
    - Check `kanban.db`'s `plan_events` table if any card lands in an unexpected column.
    - Remember the browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding the button did not appear.
