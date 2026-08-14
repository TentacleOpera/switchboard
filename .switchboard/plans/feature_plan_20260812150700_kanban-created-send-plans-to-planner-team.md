# Replace the Created Column's Blank-Feature Button with an Explicit "Send N plans to planner team"

## Goal

Give the planner fan-out a named, discoverable button on the Created column that states exactly how many plans it will send and hides itself when there is no planner pool to send them to. Retire the blank-feature button from that column to make room.

### The problem

Two halves of the same gap:

1. **The Created column's only bespoke button creates an empty feature.** `src/webview/kanban.html:6341-6345`:
   ```js
   const featureAddBtn = isCreated
       ? `<button class="column-icon-btn" data-action="addBlankFeature" data-column="${escapeAttr(def.id)}" data-tooltip="Add a blank feature to this column">
              <img src="${ICON_CODE_MAP}" alt="Add Feature">
          </button>`
       : '';
   ```
   It opens the feature-create modal in blank mode (`openFeatureCreateModal({ blankFeature: true })`, `kanban.html:6653`) after clearing the selection. A feature with no subtasks is a ghost card on the board.

2. **The planner fan-out is implemented, reviewed, and has no button.** `KanbanProvider._distributePlannerDispatch` (`src/services/KanbanProvider.ts:5819`) is a complete round-robin distributor: it resolves the live planner pool, sorts oldest-first, applies the optional per-terminal limit, moves the cards, and buckets one plan per terminal from a persistent rotation cursor.
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

- `moveSelected` → `KanbanProvider.ts:9645`, `{ skipLimit: true }`
- `moveAll` → `KanbanProvider.ts:9785`

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

## User Review Required

None. The two questions this plan previously deferred are resolved in the Complexity Audit below: blank-feature creation survives in the Project panel (so `addBlankFeature` can be deleted outright), and the pool count is read concurrently with the existing coder count rather than sharing a registry read.

## Complexity Audit

### Routine

- Swapping the Created column's button markup and switch arm.
- Adding a `sendCreatedToPlannerTeam` verb that calls the existing `_distributePlannerDispatch`.
- Threading a count into the `updateBoard` payload, mirroring `coderTerminalCount`.

### Complex / Risky — read this before writing the count

- **There are TWO wrong ways to count planner terminals, and both look right.**

  *Wrong way 1 — the coder idiom.* `coderTerminalCount` is built as
  ```ts
  (await this._taskViewerProvider.getAliveRoleTerminalNames('coder', root)).length
  ```
  and `getAliveRoleTerminalNames` (`TaskViewerProvider.ts:6005`) calls `_getAliveAutobanTerminalRegistry(workspaceRoot)` **without** `{ allowPtyFleet: true }`. `_distributePlannerDispatch` passes `allowPtyFleet: true` deliberately, with a long comment (`KanbanProvider.ts:5831-5839`) explaining why: PTY rows fail the registry's liveness test entirely (`_getAliveAutobanTerminalRegistry:9040-9055` — no `pidMatch`, no `nameMatch`, `ideName: 'switchboard-pty'` matches no `appName`, and no `lastSeen` field is ever written), and "leaving the pool resolver blind to PTY rows is what collapsed a whole grid of planners onto one terminal". Copying the coder pattern verbatim would report **0** planner terminals while the dispatcher sees six — hiding the button in exactly the configuration where it works.

  *Wrong way 2 — the name trap.* `TaskViewerProvider.getPlannerTerminalCount(ws)` **already exists** (`:5995`) and reads like the answer. It is not. It is a *configuration* field:
  ```ts
  const n = await this._readStateField('plannerTerminalCount', ws, 1);
  return Math.max(1, Math.min(5, Number.isFinite(n) ? Math.floor(n) : 1));
  ```
  — a user setting clamped to 1..5, with a floor of **1**, that knows nothing about whether any terminal is alive. Using it would render `Send N plans to planner team` with a hard-coded minimum of one phantom planner and never hide the button. Do not call it here.

  The count MUST come from `getRoleTerminalSet('planner', root, { allowPtyFleet: true })` (`TaskViewerProvider.ts:6017`) — the same call, with the same options, that the dispatcher makes.

- **`getRoleTerminalSet` is expensive, and the fix is concurrency, not sharing.**

  > **Superseded:** "Resolve both counts from **one** registry read, or cache per refresh."
  > **Reason:** the two counts need *different* registries. The coder count reads without `allowPtyFleet`; the planner pool reads with it. Deriving one from the other means either changing what `coderTerminalCount` reports on ~4,000 shipped installs (PRD contract #2, byte-compatibility) or filtering PTY rows back out by hand and betting that a PTY row could never pass the non-PTY liveness test — a bet on an implementation detail of another module's writer. A cache adds an invalidation problem to a value whose whole job is to be live.
  > **Replaced with:** issue the two reads **concurrently**. The cost `_getAliveAutobanTerminalRegistry` is worried about is latency — a `Promise.all` over PID resolution with a 1s timeout per terminal (`:9011-9015`) — and that latency is parallel-bounded, not additive. Running the planner read alongside the existing coder read leaves board-refresh wall-clock essentially unchanged while keeping `coderTerminalCount` byte-identical:
  > ```ts
  > const [coderTerminalCount, plannerPoolSize, plannerLimitOn] = await Promise.all([...]);
  > ```

- **The button's count is a snapshot and the dispatch re-reads.** `_distributePlannerDispatch` takes `sourceCards` from the caller. The verb must re-read the Created column inside the handler (as `sendDispatchSetToCoders` does at `KanbanProvider.ts:10694` — "Re-reads the set from the latest board state inside the handler so a card dragged out between render and press is skipped, not dispatched"), so a card moved between render and press is not dispatched from a stale list.

- **The label goes stale, because `renderColumns()` is not re-run on a board refresh.** This is the defect that would have shipped. The column header shell is built once by `renderColumns()` (`kanban.html:6227`), whose callers are structure/view-toggle paths (`:6489`, `:8882`, `:8888`, `:8900`, `:8973`, `:9806`, `:10090`) — **not** the `updateBoard` handler. The codebase already documents this at `kanban.html:7141-7143` ("The header shell (renderColumns) is NOT rebuilt on a board refresh, so the toggle's label has to be patchable in place") and solves it with in-place patchers `updateDispatchToggleCount()` / `updateDispatchViewInfo()` (`:7144`, `:7156`) called from `renderBoard()` (`:7305-7306`). A button that interpolates its count at render time would keep announcing `Send 9 plans` after four of them were dragged out — the exact class of lying feedback the sibling copy-flash subtask exists to remove. **Follow the established patcher pattern** (see Proposed Changes).

- **Hidden-vs-present must survive the same problem.** Because the header is not rebuilt, visibility cannot be an interpolation-time `? ... : ''` either — a planner terminal opened after the last header render would never make the button appear. Render the button unconditionally in the Created column's non-backlog header and let the patcher own `style.display`, `disabled`, and the label. `display: none` satisfies the "hide when there is no pool" requirement and satisfies PRD contract #6 (no dead buttons) without needing a header rebuild.

- **`n = min(plans, planners)` is the label, not necessarily the dispatch.** `_distributePlannerDispatch`'s slice-to-`terminals.length` is conditional on `getLimitDispatchToTerminals('planner', ...)` (`:5874`). With the limit OFF, more plans than terminals are all dispatched, round-robin, several per terminal. The label must not promise `min(...)` while the code sends everything. Decision: label with the number that will actually be dispatched — push the limit setting alongside the pool size and compute accordingly.

- **The subtask-exclusion contract.** `_visibleColumnCards` (`KanbanProvider.ts:538`) is the documented selection helper precisely because a naive column sweep picks up a BACKLOG feature's subtasks (feature subtasks carry their own `kanban_column`). Use `_visibleColumnCards(workspaceRoot, 'CREATED')` — which `batchPlannerPrompt` (`:9478`) already does — never a raw `_lastCards` column filter. Feature subtasks in Created are **out of scope**: filter `!card.featureId`, matching `sendDispatchSetToCoders`. A subtask's plan is improved via its feature, not by a loose column sweep.

- **Planner teams do not exist yet.** The user notes team support is planned work on another plan. This plan therefore gates on the *planner terminal pool* — which does exist and is exactly what the dispatcher uses — and is written so that swapping the gate to a team lookup later is a one-line change inside `getPlannerPoolSize`.

- **Resolved: removing `addBlankFeature` does not orphan blank-feature creation.** The Project panel's Features tab has a `+ New Feature` button (`src/webview/project.html:1379`) whose submit handler (`src/webview/project.js:3173-3190`) posts `createFeature` with `subtaskPlanIds: []` and `addToKanbanBoard: true` — a blank feature by any definition. The zero-subtask branch of `createFeatureFromPlanIds` therefore stays reachable from the UI, and it additionally has headless contract coverage (`src/test/headless-feature-management-contract.test.js:259-268`). The Created-column button was a duplicate entry point, not the only one.

  Consequence: with `addBlankFeature` gone, `openFeatureCreateModal`'s blank-feature early-return branch (`kanban.html:10119-10132`) has no caller and the `ICON_CODE_MAP` const (`kanban.html:5208`) has no consumer. Delete both. Leave the two `{{ICON_CODE_MAP}}` entries in the shared placeholder maps (`KanbanProvider.ts:12399`, `headlessPanelHtml.ts:214`) alone — they are inert once no template carries the placeholder, and both tables are shared surfaces where a needless edit invites a merge conflict for zero gain.

- **PRD contracts the new verb must satisfy.** Contract #4: the arm **returns** its result in the HTTP body — never `break` (the Kanban ratchet ceiling in `scripts/verb-return-contract-baseline.json` is `1`, and `npm run verb-returns:check` is wired into CI). Contract #5: add a `sendCreatedToPlannerTeam` block to `VERB_SCHEMAS.kanban` in `src/services/verbSchemas.ts` — a missing schema is silently permissive (`validateVerbPayload:54-55` returns `{ ok: true }` when no schema exists), so omitting it leaves an unvalidated HTTP boundary that no gate will flag.

## Edge-Case & Dependency Audit

### Side Effects

1. **Zero planner terminals.** Hide the button entirely (`style.display = 'none'`, the user's requirement). Do not render it disabled — a disabled button implies "do this later", and the fallback path in `_distributePlannerDispatch` (`:5841-5866`) would batch everything onto one terminal via `triggerBatchAgentFromKanban`, which is the behaviour this button exists to make visible.
2. **Zero plans in Created.** Render the button visible and `disabled` with the count `0`, matching `sendDispatchSetToCoders`' `dispatchStagedNow === 0` idiom (`kanban.html:6392`). The distinction from (1) is deliberate: no planners is a capability gap, no plans is a transient state.
3. **Unknown complexity.** `_distributePlannerDispatch` does **not** filter on complexity (unlike the coder paths, which call `_filterUnknownComplexitySessions`). Planning a plan is what assigns complexity, so this is correct — do not add a complexity filter, and do not "fix" the asymmetry.
4. **Custom-user dispatch spec on the Planned column.** The new verb calls `_distributePlannerDispatch` **directly**, so it is not subject to the `dispatchSpec` preemption that hides the fan-out today. This is stated as intent, not an oversight: the button is the explicit fan-out, and it deliberately overrides a configured single-target dispatch. That is the whole point.
5. **Rotation cursor.** `getPlannerRotationCursor(locationKey)` (`TaskViewerProvider.ts:6068`) is persisted in globalState and shared across workspaces serving the same terminals. Pressing the button repeatedly must continue the rotation, not restart at terminal 0 — `_distributePlannerDispatch` already handles this; do not reset it.
6. **No confirm dialog** before dispatching (repo rule — `confirm()` is a silent no-op in webviews anyway). The count in the label is the safeguard.

### Race Conditions

7. **Live count refresh.** `coderTerminalCount` is recomputed on every `updateBoard` (four sites: `KanbanProvider.ts:1221`, `2108`, `3659`, `3857`, with payloads at `1251`, `2119`, `3669`, `3867`). Add the planner values at **all four** or the label goes stale on some refresh paths. Missing one is the classic writer/reader split.
8. **Stale-card re-read.** Covered above: the verb re-reads `_visibleColumnCards` inside the handler, so the dispatched set is the set at press time, not at render time. The label may briefly disagree with the dispatch; the dispatch is the truth and the status feedback reports the real number.
9. **Patcher ordering.** `updatePlannerTeamButton()` must be called from `renderColumns()` (first paint / view toggle), `renderBoard()` (card churn), the `updateBoard` handler (pool/limit change), and the `cliTriggersState` handler (`kanban.html:8917`). Any of the four omitted leaves a stale surface.

### Dependencies & Conflicts

10. **CLI triggers disabled.** Both existing call sites gate on `this._cliTriggersEnabled` (`KanbanProvider.ts:214`, set at `:467`). The verb must too, and the button must be hidden to match — a press that silently does nothing is a dead click. The webview already receives `cliTriggersState` (`kanban.html:8917-8918`, backing var at `:4882`), so gate on it client-side as well.
11. **Project filter scope.** `copyDispatchPromptSelected` and `dispatchAnalyze` both scope to `msg.initiatorProject` with three-way handling (`undefined` = raw API caller → no scope; see `KanbanProvider.ts:10788-10789`). The new verb must follow the same convention, or a multi-project board fans out plans the user cannot see.
12. **Backlog view.** In backlog view the Created column shows BACKLOG cards and `suppressPipeline` already hides the advance buttons (`kanban.html:6357-6358`). The new button must be suppressed there too — sending backlog cards to planners is not what the button says.
13. **Selection semantics.** `sendDispatchSetToCoders` sends the whole staged set and ignores selection. Follow that: this button sends the Created column (project-scoped), not the selection — the label carries a count, and a count that silently means "your selection" is a trap. Selection-based sending already exists via Move Selected.
14. **The `skipLimit` option.** `moveSelected` passes `{ skipLimit: true }`; `moveAll` does not. The new button is an "all" action, so it must respect the limit (no `skipLimit`) — and the label must reflect the limited count per the Complexity Audit note above.
15. **Standalone host.** `_distributePlannerDispatch` reaches terminals through `TaskViewerProvider` seams; in standalone, PTY is the only fleet — which is exactly why `allowPtyFleet: true` is unconditional there. Verify the count helper behaves the same in the standalone bootstrap path (PRD contract #7, two-layer completion).
16. **Verb allowlist is generated, not hand-maintained.**

    > **Superseded:** "Add the new verb to `KANBAN_VERBS` in `src/generated/verbAllowlist.ts` (regenerate rather than hand-edit if a generator exists)."
    > **Reason:** the generator exists and is wired into CI. `scripts/generate-protocol-catalog.js` scans each provider's `switch (msg.type)` block for `case` arms and emits `protocol-catalog.json`; `scripts/generate-verb-allowlist.js` emits `src/generated/verbAllowlist.ts` from that catalog. A hand-edit drifts and `npm run catalog:check` (drift check, no `--write`) fails.
    > **Replaced with:** add the arm to the switch, then run `npm run catalog:generate` (`generate-protocol-catalog.js --write && generate-verb-allowlist.js --write`) and commit both regenerated files. Confirm with `npm run parity:check`.

17. **Sibling subtask — the column floor.** The `Kanban Column Floor` subtask rewrites the same `buttonArea` template (`kanban.html:6394`, dropping its inline style) and adds a pass that counts `class="column-icon-btn"` occurrences to derive the floor. Land the floor subtask **first**; this plan's new button carries `class="column-icon-btn"` (matching the existing `btn-send-dispatch-set` idiom at `:6392`) and **is** counted by that regex. With `featureAddBtn` deleted, the Created column renders 5 counted controls (4 pipeline + 1 planner button), below the clamp of 6, so the effective floor stays at 248px set by the Planned column. **Confirm by measuring, not by assuming** — a sixth control on Created would widen every column on the board.

### Security

18. **Schema validation at the HTTP boundary** (PRD contract #5). Add `sendCreatedToPlannerTeam` to `VERB_SCHEMAS.kanban`. Keep it permissive and field-accurate — the arm dereferences only `workspaceRoot` and `initiatorProject`, both optional, so requiring anything would reject a valid webview payload.
19. **No user string reaches a shell or a prompt template unescaped**; the verb passes card ids the provider already owns to an existing distributor.

## Dependencies

None (no session dependencies). File-level ordering only: land after the `Kanban Column Floor` subtask, which rewrites the same `buttonArea` template.

## Adversarial Synthesis

**Key risks:** counting the planner pool with the wrong resolver reports 0 while six planners are live and hides the button in the only configuration where it works — and there are two plausible-looking wrong resolvers, one of which (`getPlannerTerminalCount`) is a config field with a floor of 1. Second, the column header shell is not rebuilt on board refresh, so a count interpolated at render time lies within seconds and a visibility test evaluated at render time never notices a terminal opening. Third, the verb touches three generated/gated surfaces (verb allowlist, verb schema, return-contract ratchet) that fail loudly in CI if skipped and silently at runtime if half-done. **Mitigations:** one helper, `getPlannerPoolSize`, wraps `getRoleTerminalSet(..., { allowPtyFleet: true })` with a comment naming both wrong resolvers; the button renders unconditionally and an in-place patcher (the established `updateDispatchViewInfo` pattern) owns display, disabled state, and label across all four refresh paths; and the verb arm returns in-body, ships a permissive schema, and the allowlist is regenerated via `npm run catalog:generate` rather than hand-edited.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

Expose the pool size using the **same** resolution the dispatcher uses. Place it beside `getRoleTerminalSet` (`:6017`):

```ts
/**
 * Planner pool size as _distributePlannerDispatch will see it.
 *
 * MUST go through getRoleTerminalSet with allowPtyFleet: true. The two
 * plausible alternatives are both wrong:
 *
 *  - getAliveRoleTerminalNames omits allowPtyFleet, and PTY rows fail the
 *    registry liveness test outright (no pidMatch/nameMatch, ideName
 *    'switchboard-pty' matches no appName, no lastSeen is ever written).
 *    Counting with it reports 0 while the dispatcher sees the whole grid —
 *    hiding the button in precisely the configuration where the fan-out works.
 *  - getPlannerTerminalCount is a CONFIG field (_readStateField, clamped 1..5),
 *    not a liveness count. It never returns 0, so the button would never hide.
 *
 * When planner *teams* land, this is the one place the gate changes.
 */
public async getPlannerPoolSize(workspaceRoot: string): Promise<number> {
    const { terminals } = await this.getRoleTerminalSet('planner', workspaceRoot, { allowPtyFleet: true });
    return terminals.length;
}
```

### `src/services/KanbanProvider.ts`

**a) Thread the pool size and limit flag into `updateBoard`.** At each of the four `coderTerminalCount` sites (`:1221`, `:2108`, `:3659`, `:3857`), resolve the three values concurrently so the second registry read costs duplicate work but not duplicate latency:

```ts
const [coderTerminalCount, plannerPoolSize, plannerLimitOn] = this._taskViewerProvider
    ? await Promise.all([
        this._taskViewerProvider.getAliveRoleTerminalNames('coder', root).then(n => n.length),
        // NOT getAliveRoleTerminalNames and NOT getPlannerTerminalCount — see
        // getPlannerPoolSize's comment. Concurrent, not shared: the coder count
        // must keep reading the registry WITHOUT allowPtyFleet to stay
        // byte-identical on shipped installs.
        this._taskViewerProvider.getPlannerPoolSize(root),
        this._taskViewerProvider.getLimitDispatchToTerminals('planner', root),
    ])
    : [0, 0, false];
```

and add `plannerPoolSize, plannerLimitOn` to each `updateBoard` payload beside `coderTerminalCount` (`:1251`, `:2119`, `:3669`, `:3867`).

**b) New verb arm**, modelled on `sendDispatchSetToCoders` (`:10694`). Note every exit is a `return` — no `break` — per PRD contract #4 and the Kanban ratchet ceiling:

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
        // Guard, not a fallback: _distributePlannerDispatch's zero-terminal branch
        // batches EVERYTHING onto one terminal, which is the behaviour this button
        // exists to make visible. Never fall through to it.
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

### `src/services/verbSchemas.ts`

Add to `VERB_SCHEMAS.kanban` (PRD contract #5 — a missing schema is silently permissive, not an error):

```ts
// Both fields OPTIONAL: the arm falls back to _currentWorkspaceRoot, and
// initiatorProject uses the three-way convention (undefined = raw API caller,
// no project scope) that dispatchAnalyze and copyDispatchPromptSelected share.
sendCreatedToPlannerTeam: {
    fields: {
        workspaceRoot: { type: 'string' },
        initiatorProject: { type: 'string' },
    },
},
```

### `src/webview/kanban.html`

**a) Replace the Created button** (`:6341-6345`). The button renders unconditionally for the Created column outside backlog view; the patcher owns visibility, enabled state, and label:

```js
// Was: an addBlankFeature button, which created a subtask-less ghost feature.
// (Blank-feature creation survives in the Project panel's Features tab —
// project.html:1379 "+ New Feature" posts createFeature with subtaskPlanIds: [].)
// Now: the explicit planner fan-out, labelled with the number it will send.
//
// Rendered unconditionally and patched in place by updatePlannerTeamButton().
// It CANNOT gate on the pool at interpolation time: renderColumns() does not run
// on a board refresh (see the note at :7141), so a planner terminal opened after
// the last header build would never make the button appear, and the count would
// freeze at whatever Created held when the header was last rebuilt.
const plannerTeamBtn = (isCreated && !showingBacklog)
    ? `<button class="column-icon-btn" id="btn-send-to-planner-team" data-action="sendCreatedToPlannerTeam" data-column="${escapeAttr(def.id)}" style="width:auto; padding:0 8px; font-size:10px; display:none;" disabled>Send 0 plans to planner team</button>`
    : '';
```

Use `plannerTeamBtn` where `featureAddBtn` was interpolated (`:6401`), and delete the `featureAddBtn` const.

**b) The in-place patcher** — add beside `updateDispatchViewInfo()` (`:7156`):

```js
// The Created column's planner fan-out button: pool size and limit come from
// updateBoard, the plan count from currentCards. renderColumns() is NOT re-run on
// a board refresh, so — exactly like updateDispatchViewInfo — this patches the
// live element instead of re-interpolating it.
function plannerSendableCount() {
    if (!Array.isArray(currentCards)) return 0;
    // currentCards is already the board's visible, project-filtered set — the same
    // source dispatchStagedCount() reads. Subtasks are excluded: a subtask's plan
    // is improved via its feature, never by a loose column sweep.
    const created = currentCards.filter(c => c.column === 'CREATED' && !c.featureId).length;
    return lastPlannerLimitOn ? Math.min(created, lastPlannerPoolSize) : created;
}

function updatePlannerTeamButton() {
    const btn = document.getElementById('btn-send-to-planner-team');
    if (!btn) return;                       // Created column not rendered, or backlog view
    // Hidden (not disabled) when there is no pool or CLI triggers are off: a
    // disabled button implies "later", and the verb's no-pool guard means a press
    // would do nothing. Hidden when there IS nothing to press.
    const usable = lastPlannerPoolSize > 0 && cliTriggersEnabled;
    btn.style.display = usable ? '' : 'none';
    if (!usable) return;
    const n = plannerSendableCount();
    btn.textContent = `Send ${n} plan${n === 1 ? '' : 's'} to planner team`;
    btn.disabled = n === 0;
    btn.setAttribute('data-tooltip',
        `Fan the Created plans out across the ${lastPlannerPoolSize} live planner terminal(s) — one plan each, round-robin`);
}
```

**c) Call the patcher from all four refresh paths:**
- `renderColumns()` — beside the existing `updateDispatchToggleCount()` / `updateDispatchViewInfo()` calls at `:6432-6433`.
- `renderBoard()` — beside the same pair at `:7305-7306`.
- the `updateBoard` handler — after `lastPlannerPoolSize` / `lastPlannerLimitOn` are assigned (`:8635`).
- the `cliTriggersState` handler (`:8917-8918`).

**d) State** — add `lastPlannerPoolSize` / `lastPlannerLimitOn` beside `lastCoderTerminalCount` (`:7940`) and read them from `updateBoard` (`:8635-8637`):

```js
if (typeof msg.plannerPoolSize === 'number') { lastPlannerPoolSize = msg.plannerPoolSize; }
if (typeof msg.plannerLimitOn === 'boolean') { lastPlannerLimitOn = msg.plannerLimitOn; }
```

**e) Switch arm** (replacing `case 'addBlankFeature'` at `:6646-6655`):

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

**f) Guard list** (`:6514`) — replace `action !== 'addBlankFeature'` with `action !== 'sendCreatedToPlannerTeam'`. (Created does resolve a next column, so this branch is defensive rather than load-bearing, but the `addBlankFeature` entry must go regardless.)

**g) Dead-code removal** — delete the `isBlankFeature` early-return block in `openFeatureCreateModal` (`:10119-10132`) and the `ICON_CODE_MAP` const (`:5208`), both now callerless. Leave the `{{ICON_CODE_MAP}}` entries in the shared placeholder maps (`KanbanProvider.ts:12399`, `headlessPanelHtml.ts:214`) untouched — inert, and both are shared tables.

### `protocol-catalog.json` + `src/generated/verbAllowlist.ts`

Do not hand-edit. After the arm is in the switch, run `npm run catalog:generate` and commit both regenerated files.

## Verification Plan

### Automated Tests

1. **The count uses the right resolver (the highest-risk item).** Stub the registry so `getAliveRoleTerminalNames('planner', ...)` returns `[]` while `getRoleTerminalSet('planner', ..., { allowPtyFleet: true })` returns six names. Assert `getPlannerPoolSize` returns **6**. Add a source-reading assertion that the `getPlannerPoolSize` body references neither `getAliveRoleTerminalNames` nor `getPlannerTerminalCount`.
2. **The coder count is unchanged.** Assert `coderTerminalCount` still resolves through `getAliveRoleTerminalNames('coder', ...)` (no `allowPtyFleet`) — PRD contract #2, byte-compat on shipped installs.
3. **Count reaches all four refresh paths.** Assert `plannerPoolSize` and `plannerLimitOn` are present in the `updateBoard` payload emitted from each of the four sites that already carry `coderTerminalCount`.
4. **Label arithmetic.** With 9 Created plans and a pool of 4: limit ON → `Send 4 plans to planner team`; limit OFF → `Send 9 plans to planner team`. With 1 plan → `Send 1 plan to planner team` (singular).
5. **Label does not go stale.** Render the header, then deliver an `updateBoard` that removes 4 of 9 Created cards **without** re-running `renderColumns()`. Assert the live button's `textContent` reads `Send 5 plans …`. This is the regression that guards the patcher pattern.
6. **Hidden vs disabled.** Pool 0 → the button element exists but `style.display === 'none'`. Pool 4 with 0 Created plans → visible and `disabled`. CLI triggers off → `display === 'none'`.
7. **Backlog view.** With `showingBacklog` true, the button is absent from the rendered markup.
8. **Selection is ignored.** With three of nine Created cards selected, the verb dispatches all nine (limit off), proving the label's count is the truth.
9. **Subtask exclusion.** A BACKLOG feature with subtasks whose `kanban_column` is `CREATED`: assert those subtasks are NOT in the dispatched set (the documented Advance-All-swept-a-feature's-subtasks bug), and that they are not counted in the label either.
10. **Project scope.** Two projects with Created plans; with `initiatorProject` set to one, only that project's plans dispatch. With `initiatorProject: undefined` (raw API), no scope is applied.
11. **Stale-card re-read.** Remove a card from `_lastCards` between building the payload and invoking the verb; assert it is not dispatched.
12. **No-pool guard.** With pool 0, the verb returns `{ success: false }` and calls `_distributePlannerDispatch` **zero** times (it must not fall through to the one-terminal fallback).
13. **Rotation continues.** Two consecutive presses with a pool of 3 and 2 plans each: assert the second press starts at terminal index 2, not 0.
14. **Return contract + gates.** Assert the arm has no `break`; run `npm run verb-returns:check` (Kanban ceiling stays at 1), `npm run catalog:check` (no drift after regeneration), and `npm run parity:check`.
15. **Schema.** Assert `VERB_SCHEMAS.kanban.sendCreatedToPlannerTeam` exists and that a payload of `{}` validates (both fields optional).
16. **Regression.** Run the kanban dispatch suites, including `src/test/dispatch-analysis-scope-contract.test.js` and `src/test/kanban-drag-confirm-before-dispatch.test.js`. Five regression tests are red at HEAD independently — stash-verify before attributing red to this change.

### Manual

17. With the extension running and six planner terminals live (verify via `POST /terminals/verb/ptyListTerminals`): the Created column shows `Send N plans to planner team`. Press it and confirm N distinct planner terminals each receive one plan (not one terminal receiving a batch), and that the cards move to Planned.
18. Close every planner terminal and confirm the button disappears **without touching the board structure** (no column add/remove, no view toggle) — this exercises the patcher, not a header rebuild. Re-open one and confirm it returns with the count updated.
19. Drag two cards out of Created and confirm the label decrements on the board refresh alone.
20. Confirm blank-feature creation still works from the Project panel's Features tab (`+ New Feature`), and that the Created column no longer offers it.
21. Check `kanban.db`'s `plan_events` table if any card lands in an unexpected column.
22. Repeat 17 and 18 in the browser cockpit. The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding the button did not appear.

---

**Recommendation:** Complexity 6 → **Send to Coder.**
