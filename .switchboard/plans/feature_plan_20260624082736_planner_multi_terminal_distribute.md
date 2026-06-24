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

So the dispatch primitive (one `handleKanbanBatchTrigger` call per terminal with `targetTerminalOverride`) already exists; the new work is (a) spawning N planner terminals, (b) the dropdown + toggle + persistence, and (c) the round-robin partition on advance-all.

## Metadata

- **Tags:** kanban, agents-tab, planner, terminals, dispatch, distribute, manual-action
- **Complexity:** 6/10
- **Primary files:** `src/webview/kanban.html`, `src/extension.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`
- **User-facing review items:** None — design is specified by the user (Agents-tab dropdown + adjacent limit toggle, planner-only).

## Complexity Audit

**Complex / Risky:**
- `createAgentGrid` expansion: turning the single Planner entry into N entries while keeping the existing dedup/clear logic (`clearGridBlockers`, `matchesGridAgentName`) correct so re-running the grid neither disposes live pool terminals nor spawns runaway duplicates. Idempotency on repeat "OPEN AGENT TERMINALS" is the main hazard.
- Advance-all round-robin: correct **oldest-first** ordering for the limit, per-sub-batch dispatch-lock handling, and partial-failure behavior (a failure on terminal #3 must not roll back plans already accepted by #1–2).

**Routine:**
- Agents-tab dropdown + checkbox markup and their save/restore wiring (mirrors existing startup-command autosave).
- Persisting two planner-scoped fields through the existing startup-config object.

## Edge-Case & Dependency Audit

- **Configured count vs. live count.** The dropdown drives *creation*; distribution must enumerate the **actually live** planner terminals at advance time (terminals may have been closed). Use `_getAliveAutobanTerminalNames('planner', ws)` for the live set; the limit uses `min(plans, liveTerminalCount)`.
- **Oldest-first ordering.** "the two oldest plans" requires sorting candidate cards ascending by creation/`lastActivity` before slicing. `moveAll` currently dispatches in `_lastCards` filter order — add an explicit ascending sort (the autoban path already sorts by `lastActivity`, mirror it).
- **Limit OFF, plans > terminals.** Round-robin all plans across the live terminals (some terminals get ≥2 plans, dispatched as a small batch each). Limit ON → only the oldest `liveTerminalCount` plans, one per terminal, rest remain in column.
- **One terminal (count 1 or only 1 alive).** Limit ON → only the single oldest plan dispatched (explicitly requested). Limit OFF → today's behavior (all selected plans to the one terminal).
- **Count default & back-compat.** Default planner count = **1**, limit = **false** → byte-for-byte current behavior. `startupCommands` is shipped state with ~4,000 installs on old versions: **add** the new fields, **preserve** all existing/unknown keys, never rewrite the object wholesale (per repo migration rule). No `.bak` needed since nothing is deleted.
- **Pool terminal naming.** Use "Planner", "Planner 2", … "Planner N" (bare suffix) so `primaryPattern` (extension.ts ~2629) keeps treating them as distinct pool terminals, not duplicates to dispose. Optionally reuse `getNextAutobanTerminalName('Planner', …)` for name generation to stay consistent with existing pool naming.
- **Worktree mode.** `createAgentGrid` also spawns worktree terminals (`ensureWorktreeTerminals`). Planner multi-terminal applies to the **main** grid path; leave worktree behavior unchanged for this iteration (note as a known limitation).
- **Cap.** Bound the dropdown to a sane max (e.g. **5**, matching the existing `MAX_AUTOBAN_TERMINALS_PER_ROLE` ceiling) to avoid terminal storms. Document the cap in the dropdown.
- **`promptAll` unaffected.** The clipboard "prompt all" path involves no terminals; distribution applies only to CLI dispatch (advance-all with CLI triggers enabled).
- **No autoban coupling.** Reusing `_getAliveAutobanTerminalNames` for enumeration is fine (it is a registry-by-role read), but do **not** read/write autoban `terminalPools`/`poolCursor`/session caps here — this feature is independent of automation.

## Proposed Changes

### 1. `src/webview/kanban.html` — Agents tab: planner terminal-count dropdown + limit toggle

Below the Planner `startup-row` (line ~2687), add a planner-scoped sub-row:

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
  <label class="cli-toggle-inline" style="margin-left:12px;" title="When advancing all, send at most one plan per available planner terminal (oldest plans first)">
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

Restore them in the `startupCommands` message handler (~6448) and add `change` listeners (the existing autosave loop binds checkboxes; bind the new `<select>` and checkbox to `agentsTabSaveConfig`).

### 2. `src/services/KanbanProvider.ts` + `src/services/TaskViewerProvider.ts` — persist the two fields

In `_saveStartupCommands` (~2655), persist `msg.plannerTerminalCount` and `msg.plannerLimitDispatchToTerminals` alongside `startupCommands`, **without** dropping existing keys. Surface them in `_getStartupCommands` (~2619) and add small getters on `TaskViewerProvider`, e.g.:

```ts
public async getPlannerTerminalCount(ws?: string): Promise<number> {
    const n = /* read from state.startupConfig.plannerTerminalCount */ 1;
    return Math.max(1, Math.min(5, Number.isFinite(n) ? Math.floor(n) : 1));
}
public async getLimitDispatchToTerminals(role: string, ws?: string): Promise<boolean> { /* planner only for now */ }
```

(Store next to the existing startup config so it rides the same persistence/migration path; default count 1, limit false.)

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

The existing per-agent loop then creates/registers/startup-commands each "Planner N" with `role: 'planner'`. Verify `clearGridBlockers`/`matchesGridAgentName` leave "Planner 2"+ intact (bare-suffix exclusion already does this) and that the startup command is sent to each newly created planner terminal.

### 4. `src/services/KanbanProvider.ts` — distribute on advance-all (`moveAll` / `moveSelected`)

In the dispatch site where `role = this._columnToRole(nextCol)` resolves to `planner` (~5544 for `moveAll`, mirror in `moveSelected` ~5453), branch into a distribute helper instead of the single `triggerBatchAgentFromKanban` call:

```ts
const role = this._columnToRole(nextCol);
if (role === 'planner') {
    await this._distributePlannerDispatch(workspaceRoot, sessionIds, sourceCards, nextCol);
} else if (role) {
    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
}
```

New helper (sketch):

```ts
private async _distributePlannerDispatch(ws: string, sessionIds: string[], sourceCards: KanbanCard[], nextCol: string) {
    const tvp = this._taskViewerProvider!;
    const terminals = await tvp.getAliveRoleTerminalNames('planner', ws); // wraps _getAliveAutobanTerminalNames
    if (terminals.length === 0) { /* fall back to single trigger */ return; }

    // oldest-first ordering so "limit" keeps the oldest plans
    const ordered = [...sourceCards].sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));
    const limit = await tvp.getLimitDispatchToTerminals('planner', ws);
    const plans = limit ? ordered.slice(0, terminals.length) : ordered;

    // round-robin partition into per-terminal buckets
    const buckets = new Map<string, string[]>();
    plans.forEach((card, i) => {
        const term = terminals[i % terminals.length];
        (buckets.get(term) ?? buckets.set(term, []).get(term)!).push(this._cardId(card));
    });

    for (const [terminalName, ids] of buckets) {
        await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', 'planner', ids, 'improve-plan', ws, terminalName);
    }
    // plans beyond the limit remain in the source column (no move) — only move dispatched cards
}
```

Notes:
- Expose a thin public `getAliveRoleTerminalNames(role, ws)` on `TaskViewerProvider` that delegates to the existing `_getAliveAutobanTerminalNames` (rename-free; just a public, non-autoban-branded entry point).
- `triggerBatchAgentFromKanban`'s 5th arg (`targetTerminalOverride`) already routes to a specific terminal.
- The `'improve-plan'` instruction is what the planner path already uses (see `KanbanProvider.ts` ~5519).
- With the limit ON, only the dispatched (oldest N) cards should be optimistically moved/advanced; undispatched cards stay in the column. Adjust the optimistic `moveCards` payload and the `moveCardToColumn` loop to cover only `plans`, not all `sessionIds`.

## Verification Plan

1. **Terminal creation:** Set planner Terminals = 3 in the Agents tab, click OPEN AGENT TERMINALS. Confirm three terminals "Planner", "Planner 2", "Planner 3" spawn, each runs the planner startup command, and each is registered with `role: planner`. Re-click → no duplicates, no disposal of the live trio.
2. **Distribute (limit OFF):** Put 6 plans in CREATED, advance all. Confirm plans are spread round-robin across the 3 planner terminals (2 each), each via its own `handleKanbanBatchTrigger` call.
3. **Distribute (limit ON):** 10 plans, 2 live planner terminals, advance all → only the **2 oldest** plans dispatch (one per terminal); the other 8 remain in CREATED. Repeat with 1 terminal → only the single oldest plan dispatches.
4. **Back-compat:** count = 1, limit = false → behavior identical to today (single planner terminal, whole batch to it). Confirm `startupCommands` for other roles and any unknown keys are preserved across save/restore.
5. **Regression:** advancing non-planner columns (PLAN REVIEWED → lead/coder/intern, etc.) is unchanged; Automation tab / autoban pools untouched; `promptAll` clipboard path unaffected.
6. **Unit:** add a test for the round-robin partition + oldest-first limit (pure function over card list + terminal names) covering plans>terminals, plans<terminals, 1 terminal, and limit on/off.
7. `npm run compile` succeeds (only needed when producing a VSIX; `src/` is the source of truth for testing).

## Out of Scope (future)

- Reviewer / coder multi-terminal distribution (coder serializes; reviewer has overlap risk).
- Per-role counts for roles other than planner.
- Worktree-grid planner multiplication.
