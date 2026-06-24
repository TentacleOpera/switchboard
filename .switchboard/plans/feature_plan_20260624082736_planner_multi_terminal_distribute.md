# Multiple Planner Terminals + Distribute-on-Advance Across the Planner Pool

## Goal

Let a user run **several planner terminals at once** and have a manual column "advance all" hand **one plan to each planner terminal** instead of dumping the whole batch on a single terminal.

Concretely, per the user:
- Add a **dropdown in the Agents tab of `kanban.html`, directly below the Planner agent row**, to choose **how many terminals get created with the planner startup command** (scope: **planner only** for now).
- When the user presses **advance all** on the planner's column, the plans are distributed across those planner terminals — e.g. 5 planner terminals → the 5 plans go individually, one to each.
- Add a **"Limit dispatches to number of available terminals"** toggle **next to that dropdown** (i.e. where the planner pool is defined — **not** in the Automation tab). When ON: if there are more plans than terminals, only the **oldest N** plans (N = number of live planner terminals) are dispatched, one each; the rest stay put. With 1 terminal, only the single oldest plan is sent.

This is a **manual, on-demand feature** wired into the existing advance-all action. It is **not** part of Autoban/automation and must not touch autoban state, timers, or the Automation tab.

### Why this is safe for the planner

The planner only reads a plan and rewrites that one plan file. Two planners working on two different plans cannot collide, so fanning a batch out across many planner terminals in parallel is safe. (Reviewer/coder are deliberately **out of scope** here — coder work serializes to avoid file conflicts; reviewer carries a smaller but real overlap risk. This iteration is planner-only.)

### How the pieces map to the current code

- **Terminal creation:** `createAgentGrid()` in `src/extension.ts:2545` builds an `agents[]` list with exactly one entry per role (`{ name: 'Planner', role: 'planner' }`, line ~2589), creates one terminal each, registers it with `role`, and sends `getAgentStartupCommand(role)` (line ~2785). Pool terminals are expected to use a **bare number suffix** ("Planner 2") — the dedup regex at line ~2629 (`primaryPattern`) deliberately *excludes* bare-suffix names so extra pool terminals are not disposed as duplicates. So spawning "Planner", "Planner 2", … "Planner N" fits the existing convention.
- **Startup config persistence:** Agents-tab settings round-trip through `saveStartupCommands` / `getStartupCommands` (`KanbanProvider._saveStartupCommands` ~2655, `TaskViewerProvider.getStartupCommands` ~3309). The webview collects them in `agentsTabCollectConfig()` (`kanban.html` ~3600) and restores them on the `startupCommands` message (~6448). New fields ride along here.
- **Advance-all dispatch:** `case 'moveAll'` (`KanbanProvider.ts` ~5470) and `case 'moveSelected'` (~5385). Advancing CREATED → PLAN REVIEWED resolves the dispatch role via `_columnToRole('PLAN REVIEWED')` = **`planner`** (~7228), then calls `switchboard.triggerBatchAgentFromKanban(role, sessionIds, …)` (~5546) → `handleKanbanBatchTrigger` → **one** terminal (`_resolveAgentTerminalForPlan`, ~5708).
- **Enumerating live role terminals (already exists):** `TaskViewerProvider._getAliveAutobanTerminalNames(role, workspaceRoot, includeBackups)` (~5901) returns all alive terminals whose registry `role` matches — despite the "autoban" name it is a generic role→terminals lookup over the same registry `createAgentGrid` writes to. `handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot, targetTerminalOverride)` (~3174) already accepts a per-call terminal override.
- **Column update inside `handleKanbanBatchTrigger`:** At line ~3217-3219, `handleKanbanBatchTrigger` computes `targetColumn = options?.targetColumn ? normalize(options.targetColumn) : _targetColumnForRole(role)`. For `role='planner'`, `_targetColumnForRole('planner')` returns `'PLAN REVIEWED'` (line ~1862). It then updates the kanban column for each plan at line ~3227 (`_updateKanbanColumnForSession`). This means `handleKanbanBatchTrigger` performs its own authoritative column move — the `moveAll` pre-move at lines 5538-5542 is an optimistic UI update that precedes it.

So the dispatch primitive (one `handleKanbanBatchTrigger` call per terminal with `targetTerminalOverride`) already exists; the new work is (a) spawning N planner terminals, (b) the dropdown + toggle + persistence, and (c) the round-robin partition on advance-all.

### Existing instruction discrepancy (Clarification)

The current `moveAll` standard-dispatch path (line 5546) passes `undefined` as the instruction for planner dispatch, while `moveSelected` (line 5455) correctly passes `'improve-plan'` for `role === 'planner'`. The custom-user dispatch path also uses `'improve-plan'` for planner (line 5519). The distribute helper will use `'improve-plan'` uniformly, which fixes this inconsistency for `moveAll`. This is a Clarification of existing behavior, not a new requirement.

## Metadata

- **Tags:** frontend, backend, ui, feature
- **Complexity:** 6/10
- **Primary files:** `src/webview/kanban.html`, `src/extension.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`
- **User-facing review items:** None — design is specified by the user (Agents-tab dropdown + adjacent limit toggle, planner-only).

## User Review Required

No user review required. The feature design is fully specified by the user:
- Planner-only scope (reviewer/coder explicitly out of scope).
- Dropdown + limit toggle placement (Agents tab, below Planner row).
- Limit semantics (oldest N plans, one per terminal).
- Cap of 5 (matching `MAX_AUTOBAN_TERMINALS_PER_ROLE`).

The only design decision not explicitly covered by the user is whether the **limit** toggle applies to `moveSelected` (explicitly selected plans) or only `moveAll`. This plan applies round-robin distribution to both but limits only `moveAll` — see Edge-Case audit below for rationale.

## Complexity Audit

### Routine
- Agents-tab dropdown + checkbox markup in `kanban.html` and their save/restore wiring (mirrors existing startup-command autosave pattern at lines 3600-3623).
- Persisting two planner-scoped fields (`plannerTerminalCount`, `plannerLimitDispatchToTerminals`) through the existing `_saveStartupCommands` / `_getStartupCommands` state object (lines 2655-2692).
- Exposing a thin public `getAliveRoleTerminalNames(role, ws)` wrapper on `TaskViewerProvider` that delegates to the existing `_getAliveAutobanTerminalNames` (line 5901) — no new logic, just a public entry point.
- Exposing `getPlannerTerminalCount(ws)` and `getLimitDispatchToTerminals(role, ws)` getters on `TaskViewerProvider` with clamping to [1, 5].

### Complex / Risky
- `createAgentGrid` expansion: turning the single Planner entry into N entries while keeping the existing dedup/clear logic (`clearGridBlockers`, `matchesGridAgentName`) correct so re-running the grid neither disposes live pool terminals nor spawns runaway duplicates. Idempotency on repeat "OPEN AGENT TERMINALS" is the main hazard. Additionally, **count decrease** (e.g. 3→2) leaves "Planner 3" alive but unmanaged — it is not in `agents[]` so `clearGridBlockers` never visits it; it stays registered and alive. This is acceptable (user can close it manually) but must be documented.
- Advance-all round-robin: correct **oldest-first** ordering for the limit, per-sub-batch dispatch-lock handling, and partial-failure behavior (a failure on terminal #3 must not roll back plans already accepted by #1–2). The pre-move (optimistic UI) must cover only dispatched cards, not all `sessionIds`, when limit is ON.
- **Backup terminal exclusion:** `_getAliveAutobanTerminalNames` defaults to `includeBackups = true`, which would include autoban-spawned backup terminals in the distribution pool. The distribute helper must call with `includeBackups = false` to distribute only to manually-spawned pool terminals.
- **Per-terminal failure recovery:** If a terminal dies between enumeration and its bucket's `handleKanbanBatchTrigger` call, the call fails. The helper must catch per-bucket failures, log them, and continue dispatching to remaining terminals rather than aborting.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **Terminal death between enumeration and dispatch.** `_getAliveAutobanTerminalNames` enumerates live terminals at time T0. The round-robin partition assigns plans to terminals. Then `handleKanbanBatchTrigger` is called per bucket sequentially (`for...of` with `await`). If terminal "Planner 3" dies between T0 and its bucket's dispatch call, `handleKanbanBatchTrigger` will fail (invalid agent name or "No agent assigned"). **Mitigation:** Wrap each per-bucket `handleKanbanBatchTrigger` call in try/catch. Log the failure. Continue with remaining buckets. Pre-moved cards for the failed terminal are orphaned in `PLAN REVIEWED` but can be re-advanced by the user. This is acceptable partial-failure behavior — better than rolling back successful dispatches.
  - **Pre-move + `handleKanbanBatchTrigger` double-move.** The existing `moveAll` pre-moves ALL cards to `nextCol` (DB `moveCardToColumn` + UI `moveCards` postMessage) at lines 5538-5542, THEN `handleKanbanBatchTrigger` moves them again at line 3227 (`_updateKanbanColumnForSession`). For the distribute path with limit ON, the pre-move must cover only the dispatched subset (oldest N), not all `sessionIds`. The `handleKanbanBatchTrigger` per-bucket calls handle the authoritative backend move for their respective buckets. Undispatched cards are never pre-moved and remain in the source column.

- **Security:** No new security surface. Terminal names are validated by `_isValidAgentName` inside `handleKanbanBatchTrigger` (line 3204). No user input is passed to shell commands.

- **Side Effects:**
  - **Count decrease leaves orphaned terminals.** When the user changes planner count from 3 to 2 and re-clicks OPEN AGENT TERMINALS, "Planner 3" is no longer in `agents[]`. `clearGridBlockers` (line 2632) iterates only `agents` and disposes duplicates per agent name — "Planner 3" is not visited. The `registeredTerminals` cleanup (line 2635-2639) only removes entries where `agentNames.has(name)` AND `terminal.exitStatus !== undefined` — a live "Planner 3" stays registered. It is not disposed. **Behavior:** orphaned pool terminals remain alive and registered; the user closes them manually. Document this in the dropdown tooltip.
  - **Count increase creates new terminals.** Going 2→3 creates "Planner 3" on next OPEN AGENT TERMINALS click. Existing "Planner" and "Planner 2" are skipped (already running, `matchesGridAgentName` finds them, `healthy.length <= 1` so no disposal).

- **Dependencies & Conflicts:**
  - **Configured count vs. live count.** The dropdown drives *creation*; distribution must enumerate the **actually live** planner terminals at advance time (terminals may have been closed). Use `getAliveRoleTerminalNames('planner', ws)` (wrapping `_getAliveAutobanTerminalNames` with `includeBackups = false`) for the live set; the limit uses `min(plans, liveTerminalCount)`.
  - **Oldest-first ordering.** "the two oldest plans" requires sorting candidate cards ascending by `lastActivity` before slicing. `KanbanCard.lastActivity` (line 91) is populated as `row.updatedAt || row.createdAt || ''` (lines 1200, 1217, 2069) — ISO timestamp strings from SQLite. `localeCompare` on ISO strings yields chronological order. Add a comment noting the ISO format assumption.
  - **Limit OFF, plans > terminals.** Round-robin all plans across the live terminals (some terminals get ≥2 plans, dispatched as a small batch each via a single `handleKanbanBatchTrigger` call per terminal). The user's "one to each" example assumes plans ≤ terminals; with limit OFF and plans > terminals, each terminal receives `ceil(plans/terminals)` plans in one batch prompt. Document this.
  - **Limit ON, plans > terminals.** Only the oldest `liveTerminalCount` plans dispatch (one per terminal); the rest remain in the source column. Only dispatched cards are pre-moved to `nextCol`.
  - **One terminal (count 1 or only 1 alive).** Limit ON → only the single oldest plan dispatched (explicitly requested). Limit OFF → today's behavior (all selected plans to the one terminal as a single batch).
  - **`moveSelected` vs `moveAll` — limit scope.** The limit toggle is semantically about "advance all" (where the user is advancing the entire column and may have more plans than terminals). For `moveSelected`, the user explicitly chose specific plans — applying the limit would silently drop user-selected plans, which is surprising. **Decision:** Apply round-robin distribution to both `moveAll` and `moveSelected`. Apply the **limit slice** only to `moveAll`. For `moveSelected`, round-robin all selected plans across live terminals (no limit).
  - **Count default & back-compat.** Default planner count = **1**, limit = **false** → byte-for-byte current behavior. `startupCommands` is shipped state with ~4,000 installs on old versions: **add** the new fields, **preserve** all existing/unknown keys, never rewrite the object wholesale (per repo migration rule). No `.bak` needed since nothing is deleted.
  - **Pool terminal naming.** Use "Planner", "Planner 2", … "Planner N" (bare suffix) so `primaryPattern` (extension.ts ~2629) keeps treating them as distinct pool terminals, not duplicates to dispose. Optionally reuse `getNextAutobanTerminalName('Planner', …)` (autobanState.ts:166) for name generation to stay consistent with existing pool naming — though for the grid path, deterministic names ("Planner 2", "Planner 3", …) are simpler and match the `agents[]` array exactly.
  - **Worktree mode.** `createAgentGrid` also spawns worktree terminals (`ensureWorktreeTerminals`). Planner multi-terminal applies to the **main** grid path; leave worktree behavior unchanged for this iteration (note as a known limitation).
  - **Cap.** Bound the dropdown to a sane max (e.g. **5**, matching the existing `MAX_AUTOBAN_TERMINALS_PER_ROLE` ceiling, autobanState.ts:14) to avoid terminal storms. Document the cap in the dropdown.
  - **`promptAll` unaffected.** The clipboard "prompt all" path involves no terminals; distribution applies only to CLI dispatch (advance-all with CLI triggers enabled).
  - **No autoban coupling.** Reusing `_getAliveAutobanTerminalNames` for enumeration is fine (it is a registry-by-role read), but do **not** read/write autoban `terminalPools`/`poolCursor`/session caps here — this feature is independent of automation.
  - **Custom-user dispatch spec.** If the next column is a custom-user column (`dispatchSpec?.source === 'custom-user'`, lines 5516/5520) with `dispatchSpec.role === 'planner'`, the distribute logic would be skipped because the custom-user branch is entered before the standard dispatch branch. This is an edge case (custom columns mapped to planner role are rare). Document as a known limitation for this iteration; the distribute logic applies only to the standard built-in dispatch path.

## Dependencies

- None. This feature is self-contained and does not depend on other plans.

## Adversarial Synthesis

Key risks: (1) per-terminal dispatch failure leaves pre-moved cards orphaned in PLAN REVIEWED without a working planner — mitigated by try/catch per bucket and user re-advance; (2) `count decrease` leaves orphaned live terminals that `clearGridBlockers` cannot clean up — mitigated by documenting as expected behavior (user closes manually); (3) backup terminals polluting the distribution pool if `includeBackups` is not set to `false` — mitigated by explicit `includeBackups = false` in the helper. The `moveAll` instruction discrepancy (`undefined` vs `'improve-plan'`) is an existing bug that the distribute helper incidentally fixes.

## Proposed Changes

### 1. `src/webview/kanban.html` — Agents tab: planner terminal-count dropdown + limit toggle

Below the Planner `startup-row` (line 2687), add a planner-scoped sub-row:

```html
<div class="startup-row planner-pool-row" style="padding-left:24px;">
  <label style="min-width:70px;">Terminals</label>
  <select id="agents-tab-planner-terminal-count" data-role="planner" style="flex:0 0 auto;">
    <option value="1" selected>1</option>
    <option value="2">2</option>
    <option value="3">3</option>
    <option value="4">4</option>
    <option value="5">5</option>
  </select>
  <label class="cli-toggle-inline" style="margin-left:12px;" title="When advancing all, send at most one plan per available planner terminal (oldest plans first). Reducing the count does not close existing terminals — close them manually.">
    <input type="checkbox" id="agents-tab-planner-limit-dispatch" data-role="planner" style="width:auto;margin:0;">
    Limit dispatches to number of available terminals
  </label>
</div>
```

Extend `agentsTabCollectConfig()` (~3600) to include the two new planner fields, and `agentsTabSaveConfig()` already posts `saveStartupCommands`:

```js
return {
  commands, visibleAgents,
  julesAutoSyncEnabled: ...,
  plannerTerminalCount: parseInt(document.getElementById('agents-tab-planner-terminal-count')?.value || '1', 10),
  plannerLimitDispatchToTerminals: document.getElementById('agents-tab-planner-limit-dispatch')?.checked ?? false
};
```

Restore them in the `startupCommands` message handler (~6448) and add `change` listeners (the existing autosave loop binds checkboxes; bind the new `<select>` and checkbox to `agentsTabSaveConfig`):

```js
// In case 'startupCommands' handler, after julesSyncCb restore (~6457):
const plannerCountSelect = document.getElementById('agents-tab-planner-terminal-count');
if (plannerCountSelect) plannerCountSelect.value = String(msg.plannerTerminalCount ?? 1);
const plannerLimitCb = document.getElementById('agents-tab-planner-limit-dispatch');
if (plannerLimitCb) plannerLimitCb.checked = !!msg.plannerLimitDispatchToTerminals;
```

```js
// After existing autosave listeners (~3618-3623):
document.getElementById('agents-tab-planner-terminal-count')?.addEventListener('change', agentsTabSaveConfig);
document.getElementById('agents-tab-planner-limit-dispatch')?.addEventListener('change', agentsTabSaveConfig);
```

### 2. `src/services/KanbanProvider.ts` + `src/services/TaskViewerProvider.ts` — persist the two fields

In `_saveStartupCommands` (~2655), persist `msg.plannerTerminalCount` and `msg.plannerLimitDispatchToTerminals` alongside `startupCommands`, **without** dropping existing keys. Add to the `updateState` callback (after line 2672):

```ts
if (typeof msg.plannerTerminalCount === 'number') {
    state.plannerTerminalCount = msg.plannerTerminalCount;
}
if (typeof msg.plannerLimitDispatchToTerminals === 'boolean') {
    state.plannerLimitDispatchToTerminals = msg.plannerLimitDispatchToTerminals;
}
```

Also add to the legacy `state.json` fallback path (after line 2686):

```ts
if (typeof msg.plannerTerminalCount === 'number') state.plannerTerminalCount = msg.plannerTerminalCount;
if (typeof msg.plannerLimitDispatchToTerminals === 'boolean') state.plannerLimitDispatchToTerminals = msg.plannerLimitDispatchToTerminals;
```

Surface them in `_getStartupCommands` (~2619). Add to the return object (after line 2629):

```ts
plannerTerminalCount: state?.plannerTerminalCount ?? 1,
plannerLimitDispatchToTerminals: state?.plannerLimitDispatchToTerminals ?? false
```

For the `TaskViewerProvider` path, read from state inside `updateState` or via a state-read helper. Add small public getters on `TaskViewerProvider`:

```ts
public async getPlannerTerminalCount(ws?: string): Promise<number> {
    const n = await this._readStateField('plannerTerminalCount', ws, 1);
    return Math.max(1, Math.min(5, Number.isFinite(n) ? Math.floor(n) : 1));
}
public async getLimitDispatchToTerminals(role: string, ws?: string): Promise<boolean> {
    // Planner only for now; other roles always return false.
    if (role !== 'planner') return false;
    return await this._readStateField('plannerLimitDispatchToTerminals', ws, false);
}
```

(Store next to the existing startup config so it rides the same persistence/migration path; default count 1, limit false. `_readStateField` is a thin helper that reads from `state.json` or `workspaceState` — reuse the existing state-reading pattern used by `getStartupCommands`.)

### 3. `src/extension.ts` — `createAgentGrid` spawns N planner terminals

When assembling `agents[]` (~2596), expand the planner entry into the configured count:

```ts
const plannerCount = await taskViewerProvider.getPlannerTerminalCount(effectiveWorkspaceRoot);
for (const builtIn of allBuiltInAgents) {
    if (visibleAgents[builtIn.role] === false) continue;
    if (builtIn.role === 'planner' && plannerCount > 1) {
        for (let n = 1; n <= plannerCount; n++) {
            agents.push({ name: n === 1 ? 'Planner' : `Planner ${n}`, role: 'planner' });
        }
    } else {
        agents.push(builtIn);
    }
}
```

The existing per-agent loop then creates/registers/startup-commands each "Planner N" with `role: 'planner'`. Verify `clearGridBlockers`/`matchesGridAgentName` leave "Planner 2"+ intact (bare-suffix exclusion already does this — `primaryPattern` at line 2629 matches `^Planner(?: \(\d+\))?$` which excludes "Planner 2") and that the startup command is sent to each newly created planner terminal (line 2784-2808 loop iterates all `agents`).

**Count decrease behavior:** When `plannerCount` decreases (e.g. 3→2), "Planner 3" is not in `agents[]`. `clearGridBlockers` iterates `agents` (line 2650) — "Planner 3" is never visited, so it is not disposed. It remains alive and registered. This is expected; document in the dropdown tooltip.

### 4. `src/services/TaskViewerProvider.ts` — public `getAliveRoleTerminalNames` wrapper

Add a thin public method that delegates to the existing private `_getAliveAutobanTerminalNames` with `includeBackups = false`:

```ts
public async getAliveRoleTerminalNames(role: string, workspaceRoot: string): Promise<string[]> {
    return this._getAliveAutobanTerminalNames(role, workspaceRoot, false);
}
```

Using `includeBackups = false` excludes autoban-spawned backup terminals from the distribution pool — only manually-spawned pool terminals (from `createAgentGrid`) are included.

### 5. `src/services/KanbanProvider.ts` — distribute on advance-all (`moveAll`)

In the `moveAll` standard-dispatch `else` branch (line 5537), replace the pre-move + single `triggerBatchAgentFromKanban` with a distribute branch when `role === 'planner'`:

```ts
} else {
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    if (!nextCol) { break; }
    const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
    if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
        // ... existing custom-user dispatch path (lines 5516-5536) unchanged ...
    } else {
        const role = this._columnToRole(nextCol);
        if (role === 'planner' && this._cliTriggersEnabled) {
            await this._distributePlannerDispatch(workspaceRoot, sourceCards, nextCol);
        } else {
            // Existing standard dispatch path (pre-move all + single trigger)
            for (const sid of sessionIds) {
                await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
            }
            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds, targetColumn: nextCol });
            if (this._cliTriggersEnabled && role) {
                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
            }
        }
    }
    await this._refreshBoard(workspaceRoot);
    // ... status message ...
}
```

New helper:

```ts
private async _distributePlannerDispatch(
    workspaceRoot: string,
    sourceCards: KanbanCard[],
    nextCol: string
): Promise<void> {
    const tvp = this._taskViewerProvider;
    if (!tvp) return;

    // Enumerate live, non-backup planner terminals
    const terminals = await tvp.getAliveRoleTerminalNames('planner', workspaceRoot);
    if (terminals.length === 0) {
        // No live planner terminals — fall back to single trigger via default resolution
        const sessionIds = sourceCards.map(c => this._cardId(c));
        for (const sid of sessionIds) {
            await this.moveCardToColumn(workspaceRoot, sid, nextCol);
            await tvp.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
        }
        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds, targetColumn: nextCol });
        await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', 'planner', sessionIds, 'improve-plan', workspaceRoot);
        return;
    }

    // Oldest-first ordering (lastActivity is ISO timestamp string)
    const ordered = [...sourceCards].sort((a, b) =>
        (a.lastActivity || '').localeCompare(b.lastActivity || '')
    );

    // Limit: only oldest N plans (N = live terminal count), one per terminal
    const limit = await tvp.getLimitDispatchToTerminals('planner', workspaceRoot);
    const plans = limit ? ordered.slice(0, terminals.length) : ordered;

    if (plans.length === 0) {
        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'No plans to dispatch.', isError: false });
        return;
    }

    // Pre-move only dispatched cards (optimistic UI)
    const dispatchedIds = plans.map(c => this._cardId(c));
    for (const sid of dispatchedIds) {
        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
        await tvp.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
    }
    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: dispatchedIds, targetColumn: nextCol });

    // Round-robin partition into per-terminal buckets
    const buckets = new Map<string, string[]>();
    plans.forEach((card, i) => {
        const term = terminals[i % terminals.length];
        if (!buckets.has(term)) buckets.set(term, []);
        buckets.get(term)!.push(this._cardId(card));
    });

    // Dispatch per bucket with per-bucket failure isolation
    for (const [terminalName, ids] of buckets) {
        try {
            await vscode.commands.executeCommand(
                'switchboard.triggerBatchAgentFromKanban',
                'planner', ids, 'improve-plan', workspaceRoot, terminalName
            );
        } catch (err) {
            console.error(`[KanbanProvider] Distribute dispatch to '${terminalName}' failed:`, err);
            // Continue with remaining buckets; failed-bucket cards are pre-moved
            // and can be re-advanced by the user.
        }
    }

    const limitSuffix = limit && ordered.length > terminals.length
        ? ` (${ordered.length - terminals.length} plan(s) held — limit ON)`
        : '';
    this._panel?.webview.postMessage({
        type: 'showStatusMessage',
        message: `Distributed ${dispatchedIds.length} plan(s) across ${terminals.length} planner terminal(s).${limitSuffix}`,
        isError: false
    });
}
```

Notes:
- `triggerBatchAgentFromKanban`'s 5th arg (`targetTerminalOverride`) already routes to a specific terminal (extension.ts line 1130-1131 → `handleKanbanBatchTrigger` line 3198-3199).
- The `'improve-plan'` instruction is what the planner path already uses in `moveSelected` (line 5455) and the custom-user path (line 5519). Using it here fixes the existing `moveAll` discrepancy (line 5546 passes `undefined`).
- `handleKanbanBatchTrigger` performs its own authoritative column update (`_updateKanbanColumnForSession`, line 3227) to `_targetColumnForRole('planner')` = `'PLAN REVIEWED'` (line 1862). The pre-move is for immediate UI feedback only.
- With limit ON, only the dispatched (oldest N) cards are pre-moved; undispatched cards stay in the source column (no move, no postMessage).

### 6. `src/services/KanbanProvider.ts` — distribute on `moveSelected` (round-robin only, no limit)

In the `moveSelected` standard-dispatch `else` branch (line 5446), mirror the distribute logic but **without the limit slice** (the user explicitly selected these plans):

```ts
const role = this._columnToRole(nextCol);
if (role === 'planner' && this._cliTriggersEnabled) {
    // Round-robin distribute selected plans across live planner terminals (no limit)
    const selectedCards = this._lastCards.filter(card =>
        card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
    );
    await this._distributePlannerDispatch(workspaceRoot, selectedCards, nextCol);
} else {
    // Existing standard dispatch path (pre-move all + single/batch trigger)
    ...
}
```

For `moveSelected`, pass the explicitly-selected cards to `_distributePlannerDispatch`. The helper's limit check (`getLimitDispatchToTerminals`) will still fire, but since `moveSelected` typically involves user-chosen plans, consider adding a `skipLimit` parameter or a separate helper variant. **Recommended:** Add an optional `options: { skipLimit?: boolean }` parameter to `_distributePlannerDispatch` and pass `skipLimit: true` from `moveSelected`:

```ts
private async _distributePlannerDispatch(
    workspaceRoot: string,
    sourceCards: KanbanCard[],
    nextCol: string,
    options?: { skipLimit?: boolean }
): Promise<void> {
    // ...
    const limit = !options?.skipLimit && await tvp.getLimitDispatchToTerminals('planner', workspaceRoot);
    // ...
}
```

## Verification Plan

### Automated Tests

1. **Terminal creation:** Set planner Terminals = 3 in the Agents tab, click OPEN AGENT TERMINALS. Confirm three terminals "Planner", "Planner 2", "Planner 3" spawn, each runs the planner startup command, and each is registered with `role: planner`. Re-click → no duplicates, no disposal of the live trio.
2. **Distribute (limit OFF):** Put 6 plans in CREATED, advance all. Confirm plans are spread round-robin across the 3 planner terminals (2 each), each via its own `handleKanbanBatchTrigger` call with `targetTerminalOverride`.
3. **Distribute (limit ON):** 10 plans, 2 live planner terminals, advance all → only the **2 oldest** plans dispatch (one per terminal); the other 8 remain in CREATED. Repeat with 1 terminal → only the single oldest plan dispatches.
4. **moveSelected distribute (no limit):** Select 4 plans, 2 live planner terminals, advance selected → all 4 plans dispatch round-robin (2 per terminal), even with limit ON (limit applies only to moveAll).
5. **Back-compat:** count = 1, limit = false → behavior identical to today (single planner terminal, whole batch to it). Confirm `startupCommands` for other roles and any unknown keys are preserved across save/restore.
6. **Count decrease:** Set count 3, open terminals, then set count 2 and re-open. "Planner 3" remains alive and registered (not disposed). No errors.
7. **Per-terminal failure:** Kill "Planner 2" between enumeration and dispatch (simulate by closing terminal mid-advance). Confirm "Planner 1" and "Planner 3" still receive their plans; "Planner 2" bucket fails gracefully (logged, not thrown).
8. **Regression:** advancing non-planner columns (PLAN REVIEWED → lead/coder/intern, etc.) is unchanged; Automation tab / autoban pools untouched; `promptAll` clipboard path unaffected; custom-user dispatch spec path unchanged.
9. **Unit:** add a test for the round-robin partition + oldest-first limit (pure function over card list + terminal names) covering plans>terminals, plans<terminals, 1 terminal, limit on/off, and skipLimit=true.

> **Note:** Per session directives, `npm run compile` and automated test suites are NOT run as part of this plan's verification. The user will run them separately. `src/` is the source of truth; `dist/` is not used during development.

## Out of Scope (future)

- Reviewer / coder multi-terminal distribution (coder serializes; reviewer has overlap risk).
- Per-role counts for roles other than planner.
- Worktree-grid planner multiplication.
- Custom-user dispatch spec path integration (distribute applies only to built-in dispatch path this iteration).
- Automatic disposal of orphaned pool terminals when count decreases.
