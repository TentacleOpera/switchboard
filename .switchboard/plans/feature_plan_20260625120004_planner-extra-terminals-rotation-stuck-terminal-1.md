# Fix: Sequential Single-Card Moves Don't Rotate Across Planner Terminals (Batch Moves Do) — Everything Goes to Terminal 1

## Goal

The **Agents** tab of `kanban.html` lets the user run multiple planner terminals. The intended behaviour for **sequential single-card moves**: move card 1 → terminal 1, move another card → terminal 2, etc., with a persistent **cursor** tracking the next terminal. **Batch moves already fan out correctly** (3 plans dispatched at once land on 3 different terminals), but **sequential single moves all land on terminal 1**.

### Problem analysis & root cause

The key clue: *batch fans out, sequential does not.* That rules out "only one terminal is alive" (a single-terminal pool would force batch onto terminal 1 too). The pool genuinely has multiple terminals — so the defect is path-specific, not pool-specific.

**Where the rotation actually lives.** The round-robin cursor is implemented in exactly one method, `KanbanProvider._distributePlannerDispatch()` (`src/services/KanbanProvider.ts:3385-3495`):

- reads the persisted cursor — `src/services/KanbanProvider.ts:3464` (`tvp.getPlannerRotationCursor(locationKey)`)
- assigns each plan to a terminal — `src/services/KanbanProvider.ts:3466-3470`: `const term = terminals[(cursor + i) % terminals.length];`
- advances the cursor by the number of plans — `src/services/KanbanProvider.ts:3485` (`tvp.advancePlannerRotationCursor(locationKey, plans.length)`)

The cursor primitives themselves are correct and persistent (globalState): `getPlannerRotationCursor` / `advancePlannerRotationCursor` — `src/services/TaskViewerProvider.ts:3489-3501`.

**`_distributePlannerDispatch` is reached from only two call sites** — both are the column-level batch buttons:

- **Move Selected** — `src/services/KanbanProvider.ts:5690` (`moveSelected` planner branch)
- **Move All** — `src/services/KanbanProvider.ts:5813` (`moveAll` planner branch)

**Why batch *appears* to work.** A batch is a single `_distributePlannerDispatch` call with N plans; the fan-out you see comes from the **loop index `i`** (`terminals[(cursor + i) % length]` gives terminals 0,1,2 for i = 0,1,2). The cross-call **cursor** is irrelevant to a single batch, so its behaviour is never exercised here.

**Why sequential single moves all hit terminal 1.** A single-card drag (in CLI mode) or per-card advance does **not** call `_distributePlannerDispatch`. The webview posts `triggerAction` (single) — `src/webview/kanban.html:5916-5917` — which the host handles at `src/services/KanbanProvider.ts:5015` (`case 'triggerAction'`). For a built-in planner column it dispatches via:

```ts
// src/services/KanbanProvider.ts:5072-5074
const instruction = role === 'planner' ? 'improve-plan' : undefined;
const dispatched = await vscode.commands.executeCommand<boolean>(
    'switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
```

That command → `TaskViewerProvider.handleKanbanTrigger` → `_handleTriggerAgentAction` (`src/services/TaskViewerProvider.ts:2621-2628, 15434`), which resolves the target terminal with `_resolveAgentTerminalForPlan(role, …)` (the role's **default/assigned** terminal — `src/services/TaskViewerProvider.ts:5942`, used the same way at `:2635` and `:15579`). **This path never reads or advances the rotation cursor.** So every sequential single planner move resolves to the same default terminal — terminal 1.

(The same gap exists for single-card *batch-drag* via `triggerBatchAction` → `handleKanbanBatchTrigger` with no override — `src/services/KanbanProvider.ts:5097-5118` — but the user-visible symptom is the sequential single-move case.)

**Root cause (one line):** the planner round-robin cursor is wired only into the batch button path (`_distributePlannerDispatch`); the single-card drag/advance path (`triggerAction` → `triggerAgentFromKanban`) bypasses it and always dispatches to the role's default terminal, so sequential moves never rotate.

**Fix:** make the single-card planner dispatch select the next terminal from the rotation cursor and dispatch to it, reusing the existing `targetTerminalOverride` plumbing.

## Metadata

- **Tags:** `bugfix`, `ui`, `backend`
- **Complexity:** 5 / 10
- **Affected components:** `src/services/KanbanProvider.ts` (`triggerAction` planner branch; extract a shared rotation-pick helper from `_distributePlannerDispatch`), `src/services/TaskViewerProvider.ts` (rotation cursor primitives — reused, not changed), `src/extension.ts` (command registration signature if Option B is adopted).
- **Migration required:** No. The rotation cursor (`globalState['switchboard.planner.rotationCursor']`) keeps its existing key/semantics; this only adds a second caller that reads/advances it.

## User Review Required

Yes — a design decision between **Option A** (route single planner dispatch through the existing batch command) and **Option B** (add a `targetTerminalOverride` parameter to the existing single-card command). Option B is recommended (lower risk, no double-record side effect, unifies cleanly with the custom-column branch). See **## Proposed Changes → Change 2** for the trade-off. The user should confirm which option to implement before coding begins.

## Complexity Audit

### Routine
- Reading/advancing the existing persistent rotation cursor (`getPlannerRotationCursor` / `advancePlannerRotationCursor`) — primitives already exist and are persistent across reloads.
- Enumerating the live planner terminal set via `getRoleTerminalSet('planner', workspaceRoot)` — already used by `_distributePlannerDispatch`.
- Scoping the change to `role === 'planner'` only; other roles keep their current single-terminal behaviour.
- Empty / single-terminal fallback (no override → default resolution, identical to today).

### Complex / Risky
- **Dispatch-path unification + shared cursor state.** The cursor is keyed by terminal-set `locationKey` and shared across workspaces (`src/services/TaskViewerProvider.ts:3482-3494`); a new caller must use the **same** `locationKey` derivation (via `getRoleTerminalSet`) so batch and single moves advance one consistent cursor — otherwise the two paths would rotate independently and interleave oddly.
- **Double dispatch-identity record (Option A only).** `handleKanbanBatchTrigger` records dispatch identity at `src/services/TaskViewerProvider.ts:3354-3358` (with the override terminal name), and `KanbanProvider.triggerAction` records it again at `:5078` (with `terminalName=undefined` → `'unknown'`), overwriting the correct record. Option A MUST drop or align the KanbanProvider-side call; Option B avoids this entirely.
- **Touching the hot drag-drop path** risks regressions in optimistic UI, dispatch-identity recording (`_recordDispatchIdentity`), and the custom-user column branch. The change must be scoped to the **built-in planner** branch only.
- **Custom-user planner columns** (`dispatchSpec?.source === 'custom-user'`, `src/services/KanbanProvider.ts:5030-5053`) route through `dispatchConfiguredKanbanColumnAction` → `_handleTriggerAgentAction` for a single id (`src/services/TaskViewerProvider.ts:2765-2766`), which also has no rotation. Applying rotation there requires the same override plumbing (Option B extends naturally; Option A requires extending `dispatchConfiguredKanbanColumnAction`).

## Edge-Case & Dependency Audit

- **Race Conditions:** For sequential user-paced moves the persisted cursor write (`globalState.update`) completes well before the next move, so no debounce/lock is needed. The existing dedupe lock in `_handleTriggerAgentActionInternal` (`src/services/TaskViewerProvider.ts:15452-15470`) guards against double-fires of the same session/instruction; the rotation pick happens before dispatch and is not dedupe-gated, which is correct (the cursor should advance per dispatched card, not per dedupe window).
- **Security:** No new surface. The override terminal name comes from `getRoleTerminalSet` (enumerated live terminals), not user input. `handleKanbanBatchTrigger` already validates the agent name via `_isValidAgentName` (`src/services/TaskViewerProvider.ts:3329`); the override flows through the same `targetAgent` variable and is NOT re-validated — Option B should ensure the override is also passed through `_isValidAgentName` (it is already a name from the live-terminal registry, but defensive validation matches existing patterns).
- **Side Effects:** `handleKanbanBatchTrigger` and `_handleTriggerAgentActionInternal` both call `_updateKanbanColumnForSession` to move the card to `_targetColumnForRole('planner')` = `'PLAN REVIEWED'` (`src/services/TaskViewerProvider.ts:1988`). For a built-in planner drag this is idempotent (drag target == `'PLAN REVIEWED'`). NOTE: if a user drags to the `'PLANNED'` column (also mapped to `planner` via `roleFromColumn`), both today's single path AND Option A would advance the card to `'PLAN REVIEWED'` — this is **existing behaviour**, not a regression. Option B changes nothing about column movement (it only overrides terminal selection), so it has zero column-movement side-effect risk.
- **Dependencies & Conflicts:** None external. Reuses `getRoleTerminalSet`, `getPlannerRotationCursor`, `advancePlannerRotationCursor`, and the `targetTerminalOverride` parameter already present on `switchboard.triggerBatchAgentFromKanban` (`src/extension.ts:1173`) and `handleKanbanBatchTrigger` (`src/services/TaskViewerProvider.ts:3304`). No new dependencies.
- **Scope strictly to `role === 'planner'`.** The rotation cursor is planner-specific. Other roles (coder/lead/reviewer/etc.) and the IDE-lead / pair-programming branches in `triggerAction` (`src/services/KanbanProvider.ts:5054-5089`) must keep their current single-terminal behaviour.
- **One cursor, shared by both paths.** Use `getRoleTerminalSet('planner', workspaceRoot)` to obtain `{ terminals, locationKey }` (`src/services/TaskViewerProvider.ts:3456-3479`) and the same `getPlannerRotationCursor`/`advancePlannerRotationCursor` calls `_distributePlannerDispatch` uses. A single move advances the cursor by 1, so a subsequent batch (or single) continues from the right offset, and vice-versa.
- **Custom-user planner columns.** The `dispatchSpec?.source === 'custom-user'` branch (`src/services/KanbanProvider.ts:5030-5053`) routes through `dispatchConfiguredKanbanColumnAction` → `_handleTriggerAgentAction` for a single id (`src/services/TaskViewerProvider.ts:2765-2766`), which also has no rotation. Decision: apply the same rotation selection here for `role === 'planner'` so custom planner columns behave identically to built-in. Option B's `targetTerminalOverride` on `_handleTriggerAgentAction` covers this branch with no extra plumbing (the override is threaded through `dispatchConfiguredKanbanColumnAction` → `_handleTriggerAgentAction`). If deferred, `log`/comment the gap explicitly — do not silently leave it unrotated.
- **Empty / single-terminal pool.** If `getRoleTerminalSet('planner')` returns zero terminals, fall back to the existing default resolution (no override). If it returns exactly one, rotation is a no-op (correct — one terminal means everything goes there).
- **Cursor advance timing.** Advance the cursor **after** computing the target for this move (mirror `_distributePlannerDispatch`: assign with current cursor, then advance by 1).
- **Don't double-move the card / don't double-record identity.** `triggerAction` is a drag that already moved the card visually. Both candidate dispatch targets (`handleKanbanBatchTrigger` and `_handleTriggerAgentActionInternal`) re-persist the column via `_updateKanbanColumnForSession` to `'PLAN REVIEWED'` (idempotent for built-in planner). The critical guard is on **dispatch identity**: see Change 2 for the per-option handling.
- **`triggerBatchAgentFromKanban` accepts the override.** Confirmed: `handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot, targetTerminalOverride, options)` uses `targetAgent = String(targetTerminalOverride || '').trim() || _resolveAgentTerminalForPlan(...)` (`src/services/TaskViewerProvider.ts:3323-3324`). Passing a single-element `sessionIds` array with the chosen terminal dispatches one plan to one specific terminal.
- **`plannerTerminalCount` setting (secondary, not the cause).** This setting is currently read/stored only and never bounds the rotation pool (`src/services/KanbanProvider.ts:2656,2716`; `src/services/TaskViewerProvider.ts:3434-3437`). It is **not** the cause of this bug and need not be fixed to resolve it. Optional consistency follow-up: bound rotation to `min(plannerTerminalCount, terminals.length)` in the shared helper so both paths honour the configured count. Flagged, not required.
- **No confirmation dialogs** (project rule).

## Dependencies

- None. This is a self-contained bugfix with no prerequisite plans.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) a double dispatch-identity record that overwrites the correct terminal name with `'unknown'` if Option A is taken without dropping/aligning the KanbanProvider-side `_recordDispatchIdentity` call; (2) cursor-key divergence if the single path derives `locationKey` differently from `_distributePlannerDispatch`; (3) regressions on the hot drag-drop path if the planner branch is not strictly scoped. Mitigations: prefer Option B (adds an override parameter to the single-card command — no path switch, no double-record, unifies with the custom-column branch), reuse `getRoleTerminalSet` for identical `locationKey` derivation, and gate the new logic on `role === 'planner'` only.

## Proposed Changes

### Change 1 — `src/services/KanbanProvider.ts`: extract a shared "pick + advance" rotation helper

Factor the rotation selection out of `_distributePlannerDispatch` so both the batch and single paths use identical logic. New private method:

```ts
/**
 * Returns the next planner terminal(s) in the persistent round-robin and advances
 * the shared cursor by `count` (default 1). Returns null if no planner terminals
 * are live (caller should fall back to default resolution).
 */
private async _nextPlannerTerminals(workspaceRoot: string, count = 1): Promise<string[] | null> {
    const tvp = this._taskViewerProvider;
    if (!tvp) return null;
    const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot);
    if (terminals.length === 0) return null;
    const cursor = tvp.getPlannerRotationCursor(locationKey);
    const picked: string[] = [];
    for (let i = 0; i < count; i++) {
        picked.push(terminals[(cursor + i) % terminals.length]);
    }
    await tvp.advancePlannerRotationCursor(locationKey, count);
    return picked;
}
```

Refactor `_distributePlannerDispatch` (`src/services/KanbanProvider.ts:3460-3485`) to obtain its per-plan terminals from this helper (or leave its inline loop and just share the cursor read/advance) so there is a single source of truth for rotation. **Preserve the existing inline loop behaviour** — the refactor must not change batch fan-out; it should delegate the cursor read/advance to `_nextPlannerTerminals` (or a shared cursor-only helper) so both paths advance one consistent cursor.

### Change 2 — `src/services/KanbanProvider.ts`: route single-card planner dispatch through rotation

In `case 'triggerAction'`, built-in planner branch (`src/services/KanbanProvider.ts:5072-5074`), pick the next terminal and dispatch with the override instead of the un-targeted single trigger. **Two options** — **Option B is recommended.**

#### Option A (original — route through the batch command)

Dispatch via `switchboard.triggerBatchAgentFromKanban` with a single-element `sessionIds` array and the picked terminal as `targetTerminalOverride`:

```ts
} else {
    const instruction = role === 'planner' ? 'improve-plan' : undefined;
    let dispatched: boolean;
    let plannerTargetTerminal: string | undefined;
    if (role === 'planner') {
        const picked = await this._nextPlannerTerminals(workspaceRoot!, 1);   // advances the shared cursor
        plannerTargetTerminal = picked?.[0];
        dispatched = !!(await vscode.commands.executeCommand<boolean>(
            'switchboard.triggerBatchAgentFromKanban',
            'planner', [sessionId], instruction, workspaceRoot, plannerTargetTerminal /* override; undefined → default */));
    } else {
        dispatched = !!(await vscode.commands.executeCommand<boolean>(
            'switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot));
    }
    if (dispatched && workspaceRoot) {
        // ⚠️ DOUBLE-RECORD GUARD: handleKanbanBatchTrigger already called _recordDispatchIdentity
        // at TaskViewerProvider.ts:3354-3358 WITH the override terminal name. To avoid overwriting
        // that correct record with 'unknown', either DROP this call for the planner branch or pass
        // the terminal name so both records agree:
        await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn, plannerTargetTerminal);
        // …existing pair-programming block unchanged…
    }
}
```

**Option A caveats:** `handleKanbanBatchTrigger` re-persists the column to `_targetColumnForRole('planner')` = `'PLAN REVIEWED'` (idempotent for built-in planner drags) and records dispatch identity with the terminal name. The KanbanProvider-side `_recordDispatchIdentity` call at `:5078` MUST pass `plannerTargetTerminal` (4th arg) — otherwise it overwrites the good record with `'unknown'`.

#### Option B (recommended — add `targetTerminalOverride` to the single-card command)

Add a `targetTerminalOverride?: string` parameter to the single-card path so the card-movement and dispatch-identity semantics are unchanged — only the terminal selection is overridden. This avoids the double-record entirely and unifies with the custom-column branch (Change 3).

1. **`src/extension.ts:1153`** — extend the command registration:
```ts
const triggerFromKanbanDisposable = vscode.commands.registerCommand(
    'switchboard.triggerAgentFromKanban',
    async (role: string, sessionId: string, instruction?: string, workspaceRoot?: string, targetTerminalOverride?: string) => {
        return await taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot, targetTerminalOverride);
    });
```

2. **`src/services/TaskViewerProvider.ts:2621`** — thread the override through `handleKanbanTrigger` → `_handleTriggerAgentAction` → `_handleTriggerAgentActionInternal`:
```ts
public async handleKanbanTrigger(
    role: string, sessionId: string, instruction?: string,
    workspaceRoot?: string, targetTerminalOverride?: string
): Promise<boolean> {
    return this._handleTriggerAgentAction(role, sessionId, instruction, workspaceRoot, undefined, targetTerminalOverride);
}
```
In `_handleTriggerAgentActionInternal` (`src/services/TaskViewerProvider.ts:15578-15579`), resolve the terminal with the override first, and validate it:
```ts
let targetAgent: string | undefined;
if (targetTerminalOverride && this._isValidAgentName(targetTerminalOverride)) {
    targetAgent = targetTerminalOverride;
} else {
    targetAgent = await this._resolveAgentTerminalForPlan(role, resolvedWorkspaceRoot, worktreePath);
}
```
Because `explicitTargetColumn` is still empty when invoked via the command (no `options.targetColumn`), TaskViewerProvider does NOT record dispatch identity (line 15689 guard) — exactly as today. So KanbanProvider's call at `:5078` remains the single record; pass the override terminal into it so the record carries the correct terminal name.

3. **`src/services/KanbanProvider.ts:5072-5074`** — call the single command with the override:
```ts
} else {
    const instruction = role === 'planner' ? 'improve-plan' : undefined;
    let dispatched: boolean;
    let plannerTargetTerminal: string | undefined;
    if (role === 'planner') {
        const picked = await this._nextPlannerTerminals(workspaceRoot!, 1);   // advances the shared cursor
        plannerTargetTerminal = picked?.[0];
    }
    dispatched = !!(await vscode.commands.executeCommand<boolean>(
        'switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot, plannerTargetTerminal));
    if (dispatched && workspaceRoot) {
        await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn, plannerTargetTerminal);
        // …existing pair-programming block unchanged…
    }
}
```

(If `picked` is null/empty — no live planner terminals — `plannerTargetTerminal` is `undefined` and `triggerAgentFromKanban` falls back to default resolution, identical to today.)

**Why Option B is preferred:** no path switch (single-card semantics preserved), no double-record (TaskViewerProvider still skips its record because `explicitTargetColumn` is empty; KanbanProvider's single record now carries the terminal name), zero column-movement side-effect risk, and the same override parameter naturally covers the custom-column branch in Change 3.

### Change 3 (decision from audit) — custom-user planner columns

Apply the same rotation selection in the `dispatchSpec?.source === 'custom-user'` planner branch (`src/services/KanbanProvider.ts:5030-5052`) when `role === 'planner'` and `dragDropMode !== 'prompt'`, so custom planner columns rotate too.

- **With Option B:** `dispatchConfiguredKanbanColumnAction` → `_handleTriggerAgentAction` already receives the override once Change 2's signature change lands. Pick the terminal with `_nextPlannerTerminals` in the `custom-user` branch and pass it through `dispatchConfiguredKanbanColumnAction` (add an optional `targetTerminalOverride` to `ConfiguredKanbanDispatchOptions` or a new parameter) so it reaches `_handleTriggerAgentAction`. Minimal extra plumbing.
- **With Option A:** extend `dispatchConfiguredKanbanColumnAction`/`_handleTriggerAgentAction` to accept an optional terminal override, mirroring the batch override — more plumbing than Option B.

If deferred, `log`/comment the gap explicitly.

### Change 4 (optional consistency) — honour `plannerTerminalCount`

In `_nextPlannerTerminals` and `_distributePlannerDispatch`, bound the pool to `Math.min(plannerTerminalCount, terminals.length)` (count from `tvp.getPlannerTerminalCount(workspaceRoot)`, `src/services/TaskViewerProvider.ts:3434-3437`) so both paths rotate across exactly the configured number of terminals. Not required to fix the reported bug; include only if tying the Agents-tab number to dispatch behaviour is desired.

## Verification Plan

> **Note:** Per session directives, compilation (`npm run compile`) and automated tests are NOT run as part of this plan. The user will run the build and test suite separately. The steps below are manual verification checks to perform after implementation.

### Automated Tests
- Skipped this session (user runs separately). Existing pair-programming dispatch tests (`src/test/pair-programming-comprehensive.test.ts`) reference `triggerAgentFromKanban`; if Option B changes that command's signature, confirm those tests still compile/pass (the new param is optional, so they should).

### Manual Verification
1. **Sequential fan-out (headline):** With ≥3 live planner terminals, drag one card into the planner column → terminal 1. Drag a second card → terminal 2. Third → terminal 3. Fourth → wraps to terminal 1. (Each is a separate single-card move.)
2. **Batch still works:** Use **Move All** / **Move Selected** with 3 plans → still fans out across 3 terminals (no regression).
3. **Shared cursor coherence:** Do a single move (lands on terminal 1, cursor → 1), then a Move-All of 2 plans → they go to terminals 2 and 3 (continuing the cursor), not 1 and 2.
4. **Cursor persists across reload:** After moves land on 1→2, reload the window, move another card → continues to terminal 3 (cursor is in globalState).
5. **Single-terminal pool:** With one planner terminal, sequential moves all go to it (rotation no-op, no errors).
6. **No-terminal fallback:** With no live planner terminal, a single move falls back to default resolution (current behaviour) without throwing.
7. **No duplicate moves/deltas:** Confirm a single drag still moves the card exactly once (no double `moveCards` delta). For Option A, confirm dispatch identity is recorded once with the correct terminal name (not overwritten with `'unknown'`). For Option B, confirm dispatch identity carries the override terminal name.
8. **Non-planner roles unaffected:** Drag a card into a coder/lead column → behaves exactly as before (no rotation, no override).
9. **Custom planner column (if Change 3 included):** Sequential moves into a custom planner-role column rotate across terminals too.
10. **`'PLANNED'` column drag (edge):** Dragging to the `'PLANNED'` column still advances the card to `'PLAN REVIEWED'` (existing behaviour) and rotates the terminal — confirm no regression versus today.

## Recommendation

Complexity is 5 / 10 (mixed: majority routine cursor reuse with one moderate, well-scoped risk around dispatch-identity recording on the hot drag-drop path). **Send to Coder.** Adopt **Option B** unless the user explicitly prefers Option A (in which case apply the double-record guard in Change 2).
