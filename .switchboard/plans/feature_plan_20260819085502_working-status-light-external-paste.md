# Light Up Working Status When Copy-Prompt Is Pasted to an External Interface

## Goal

When a card's copy-prompt is pasted into an interface Switchboard does not control (a coding app, an IDE sidepanel chat, etc.), the working status light (the `is-working` ring around the card) never turns on. The light should activate so the operator can see at a glance which cards have active agents working on them, regardless of where the prompt was sent.

### Problem Analysis

The working status light is driven by the `card.working` boolean, which is derived from the `dispatched_at` column in the Kanban database. The `isWorkingState()` function in `KanbanProvider.ts` (line 167) returns `{ working: true }` when `dispatchedAt` is non-NULL and within the configured timeout window (default 10 minutes). The webview applies the `is-working` CSS class (line 8449) when `card.working` is true, rendering the 2px highlight ring (line 1021).

`dispatched_at` is written by exactly two paths:

1. **`updateDispatchInfoByPlanFile`** (KanbanDatabase.ts line 9814) — called via `_recordDispatchIdentity` when a card is dispatched to a Switchboard-controlled terminal and the dispatch succeeds.

2. **`attributePasteDispatch`** (KanbanDatabase.ts line 9852) — called via the `attributePastedPrompt` verb when a prompt is pasted or drag-dropped into a Switchboard-controlled terminal pane (detected by `term.onData` in terminals.js, or by `wireTerminalDropTarget` for drag-drop, or by the standalone bootstrap after `sendPromptToPty`).

### Root Cause

When the copy-prompt flow fires — either the user clicks "Copy Prompt" on a card (`promptSelected` handler, KanbanProvider.ts line 10292) or dispatch fails and the prompt is copied as a fallback (`dispatchFailedPromptReady`, KanbanProvider.ts line 9066) — the prompt is written to the clipboard and the card is moved to the target column, but **`dispatched_at` is never set**. Neither `_recordDispatchIdentity` nor `attributePasteDispatch` is called.

The `attributePasteDispatch` function exists specifically for this scenario — it writes `dispatched_at` (and `dispatched_agent` / `dispatched_terminal`) without touching `routed_to` or `dispatched_ide`, since the paste path knows the pane and role but not the routing decision. However, it is only invoked when the paste is detected inside a Switchboard terminal. When the user pastes the prompt into an external interface (a coding app, an IDE sidepanel chat), Switchboard has no detection mechanism and `attributePastedPrompt` is never called.

The fix is to stamp `dispatched_at` at the moment the prompt is copied to the clipboard in the `promptSelected` and `promptAll` handlers (and in the `dispatchFailedPromptReady` fallback paths), using the existing `attributePasteDispatch` writer. This lights the working ring immediately, signaling "an agent is (or is about to be) working on this card." The existing timeout sweep (`clearStaleWorkingState` in GlobalPlanWatcherService) and the `**Stage Complete:**` marker parser (`clearWorkingState`) will turn the light off when the agent finishes or when the timeout elapses — the same off-switches that already cover terminal-dispatched cards.

## Metadata

**Complexity:** 5
**Tags:** bugfix, ui, backend, frontend
**Project:** Browser Switchboard

## User Review Required

No user review required for the core approach (stamping `dispatched_at` via the existing `attributePasteDispatch` writer). One correctness fix applied during review: the complexity-routing branches must pass the role-routed `targetCol` (not `nextCol`) to the stamp helper so the `dispatchedAgent` analytics field is correct — see the Superseded callout in Proposed Changes §1.

## Complexity Audit

### Routine
- The `attributePasteDispatch` writer already exists (KanbanDatabase.ts line 9852) and is tested — no new DB schema, no new verb.
- No frontend changes needed. The webview already renders the `is-working` ring when `card.working` is true. The board refresh that follows the column move picks up the newly-set `dispatched_at` and lights the ring.
- The off-switches (`clearWorkingState` marker parser, `clearStaleWorkingState` timeout sweep) already cover this writer.

### Complex / Risky
- Identifying all code paths that copy a prompt without setting `dispatched_at`, and ensuring the stamp is written at the right point (after the card move, before the board refresh `postMessage`).
- The complexity-routing branches in `promptSelected` and `promptAll` move cards to a role-routed `targetCol` (not `nextCol`) — the stamp helper must receive `targetCol` to resolve the correct `dispatchedAgent`.
- The new `_attributeExternalDispatch` helper duplicates the `roleFromColumn` mapping already defined in `_recordDispatchIdentity` (line 3478). If either mapping drifts, the `dispatchedAgent` analytics will be inconsistent between terminal-dispatched and external-paste cards.

## Edge-Case & Dependency Audit

- **Timeout accuracy:** The default 10-minute timeout (`DEFAULT_WORKING_STATE_TIMEOUT_MS`) starts from `dispatched_at`. If the user takes several minutes to paste the prompt into an external interface and get the agent started, the light may turn off before the agent finishes. This is an acceptable tradeoff — the same timeout applies to terminal-dispatched cards, and the user can configure `switchboard.activityLight.timeoutMs` to extend it. The `3× timeoutMs` hard cap in `isWorkingState` (line 181) also applies.

- **Completion detection:** The `clearWorkingState` off-switch fires when a `**Stage Complete:**` marker is parsed from the plan file. If the external agent writes this marker, the light turns off correctly. If the external agent does not write the marker (different format, or the agent is not instructed to), the light stays on until the timeout sweep clears it. This is the same behavior as terminal-dispatched cards whose agents don't write the marker.

- **Re-dispatch:** If the user copies the prompt again (re-dispatch), `attributePasteDispatch` overwrites `dispatched_at` with a fresh timestamp, resetting the timeout clock. This is correct — the existing `updateDispatchInfoByPlanFile` does the same for terminal dispatches.

- **`promptSelected` with no next column:** When there is no next column to advance to (line 10320), the prompt is copied but the card stays in place. In this case, `dispatched_at` should NOT be set — the card hasn't moved to a working column, so lighting the working ring would be misleading. The stamp should only be applied when the card is actually moved to a target column.

- **`promptAll` handler:** The `promptAll` handler (line 10416) has the same structure as `promptSelected` — it copies the prompt and moves cards. The same fix applies.

- **`dispatchFailedPromptReady` paths:** There are four fallback paths that copy the prompt when dispatch fails (lines 9066–9082, 9083–9099, 9168–9184, 9186–9198). All should stamp `dispatched_at` since the card has already been moved to the target column and the user is expected to paste the prompt manually.

- **Feature cards:** Feature cards derive `working` from their subtasks' `dispatched_at` values (via `getFeatureWorkingStates`). The fix targets non-feature cards (the `promptSelected` / `promptAll` paths operate on individual plan cards). Feature cards are unaffected.

- **`attributePasteDispatch` parameters:** The function takes `{ dispatchedAgent, dispatchedTerminal, dispatchedAt }`. For the copy-prompt flow, `dispatchedAgent` should be a descriptive string like `'external'` or the role name, and `dispatchedTerminal` should be empty (no terminal — the prompt went to an external interface). `dispatchedAt` defaults to `new Date().toISOString()`.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — `promptSelected` handler (line 10292)

After the card is moved to the target column and the prompt is copied, stamp `dispatched_at`. Add the call in the three branches that move cards:

**Branch A — PLAN REVIEWED with complexity routing (line 10374–10385):**
After `await this.moveCardToColumn(workspaceRoot, sid, targetCol);` (line 10379), add:
```ts
await this._attributeExternalDispatch(workspaceRoot, sid, targetCol);
```

> **Superseded:** `await this._attributeExternalDispatch(workspaceRoot, sid, nextCol);`
> **Reason:** In the complexity-routing branch, the card is moved to `targetCol` (the role-routed column — LEAD CODED / CODER CODED / INTERN CODED, resolved by `_targetColumnForDispatchRole`), NOT `nextCol` (the raw next column after PLAN REVIEWED). Passing `nextCol` to the helper's `roleFromColumn` map produces a wrong `dispatchedAgent` (likely the `'external'` fallback), corrupting dispatch analytics. The stamp must reference the column the card was actually moved to.
> **Replaced with:** `await this._attributeExternalDispatch(workspaceRoot, sid, targetCol);`

**Branch B — default else branch (line 10399–10413):**
After `await this.moveCardToColumn(workspaceRoot, sid, nextCol);` (line 10402), add:
```ts
await this._attributeExternalDispatch(workspaceRoot, sid, nextCol);
```

**Branch C — custom-user column (line 10333–10361):**
This branch dispatches via `dispatchConfiguredKanbanColumnAction`, which may or may not set `dispatched_at` depending on whether it falls back to copy-prompt. Add the stamp only when `!dispatched`:
```ts
if (!dispatched) {
    for (const sid of msg.sessionIds) {
        await this._attributeExternalDispatch(workspaceRoot, sid, nextCol);
    }
}
```

**No-next-column branch (line 10320–10327):** Do NOT stamp — the card hasn't moved to a working column.

### 2. `src/services/KanbanProvider.ts` — `promptAll` handler (line 10416)

Apply the same pattern as `promptSelected`, with the same `targetCol` vs `nextCol` distinction:

- **Complexity-routing branch (lines 10480–10501):** After `await this.moveCardToColumn(workspaceRoot, sid, targetCol);` (line 10489), add `await this._attributeExternalDispatch(workspaceRoot, sid, targetCol);` — use `targetCol` (the role-routed column), NOT `nextCol`, for the same reason as Branch A above.
- **Default else branch (lines 10507–10525):** After `await this.moveCardToColumn(workspaceRoot, sid, nextCol);` (line 10513), add `await this._attributeExternalDispatch(workspaceRoot, sid, nextCol);` — here `nextCol` is correct because the card is moved to `nextCol`.
- **Custom-user branch (lines 10442–10466):** Stamp only when `!dispatched`, same as Branch C in `promptSelected`.

### 3. `src/services/KanbanProvider.ts` — `dispatchFailedPromptReady` fallback paths

There are four fallback paths (lines 9066–9082, 9083–9099, 9168–9184, 9186–9198) that copy the prompt when dispatch fails. In each, after `this._seams().clipboard.writeText(prompt);`, add:
```ts
await this._attributeExternalDispatch(workspaceRoot, sessionId, targetColumn);
```

### 4. `src/services/KanbanProvider.ts` — new helper method

Add a private helper that resolves the plan and calls `attributePasteDispatch`:
```ts
/**
 * Stamp dispatched_at for a card whose prompt was copied to the clipboard
 * for manual paste into an external interface (coding app, IDE sidepanel
 * chat, etc.). Lights the working status ring so the operator can see the
 * card is being worked on, even though Switchboard did not dispatch the
 * agent itself. Uses the existing attributePasteDispatch writer so the
 * same off-switches (clearWorkingState, clearStaleWorkingState) apply.
 */
private async _attributeExternalDispatch(
    workspaceRoot: string,
    sessionId: string,
    targetColumn: string
): Promise<void> {
    try {
        const roleFromColumn: Record<string, string> = {
            'LEAD CODED': 'lead',
            'CODER CODED': 'coder',
            'INTERN CODED': 'intern',
            'CODE REVIEWED': 'reviewer',
            'ACCEPTANCE TESTED': 'tester',
            'PLAN REVIEWED': 'planner',
        };
        const role = roleFromColumn[targetColumn] || 'external';
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) return;
        const plan = await db.getPlanBySessionId(sessionId);
        if (!plan) return;
        const workspaceId = plan.workspaceId;
        if (!workspaceId || !plan.planFile) return;
        await db.attributePasteDispatch(plan.planFile, workspaceId, {
            dispatchedAgent: role,
            dispatchedTerminal: '',
        });
    } catch (err) {
        console.warn(`[KanbanProvider] _attributeExternalDispatch failed for ${sessionId}:`, err);
    }
}
```

**Side effect — `updated_at` bump:** `attributePasteDispatch` updates `updated_at` alongside `dispatched_at` (KanbanDatabase.ts line 9870). This means the card's `lastActivity` refreshes, which feeds `_ts` in the board sort. The card will sort to the top of its column after the prompt is copied — a beneficial side effect that complements the AUTOCODE sort-order fix in the sibling subtask. No action needed, but the coder should be aware the stamp affects sort position, not just the working ring.

**DRY note:** The `roleFromColumn` mapping above duplicates the one in `_recordDispatchIdentity` (KanbanProvider.ts line 3478). The duplication is intentional — `_recordDispatchIdentity` writes `routed_to` and `dispatched_ide` via `updateDispatchInfo`, while this helper deliberately uses `attributePasteDispatch` which omits those fields (the copy-prompt path knows the role but not the routing decision or IDE). If a future refactor extracts a shared mapping, both call sites must be updated together.

### 5. `src/webview/kanban.html` — `dispatchFailedPromptReady` handler (line 9869)

No change needed. The board refresh that follows the `dispatched_at` stamp will cause `card.working` to be true, and the existing `is-working` CSS class will render the ring. The `dispatchFailedPromptReady` handler already glows the copy-prompt button orange (line 9874) — the working ring is an additional, complementary signal.

## Dependencies

None — this is a self-contained backend stamping fix. It reuses the existing `attributePasteDispatch` writer and existing off-switches. No dependency on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) the `nextCol` vs `targetCol` bug in the complexity-routing branches — corrected with a Superseded callout; the stamp must reference the column the card was actually moved to, not the raw next-column. (2) The `updated_at` bump from `attributePasteDispatch` changes card sort position — beneficial but undocumented in the original plan; now noted. (3) The duplicated `roleFromColumn` mapping could drift from `_recordDispatchIdentity`'s copy — mitigated by the DRY note; a future shared-extraction refactor is the clean fix. Mitigations: all three are addressed in the plan text. The core approach (reusing `attributePasteDispatch` rather than adding a new DB column or ephemeral frontend state) is sound — it inherits all existing off-switches and requires no schema change.

## Verification Plan

1. **Build:** Run `npm run build` and confirm no errors.

2. **Manual test — promptSelected (Copy Prompt button):**
   - Create a plan, move it to PLAN REVIEWED.
   - Click the "Copy Prompt" button on the card.
   - Verify the card moves to the coder column AND the working status ring (2px highlight) appears around the card.
   - Verify the ring disappears after the timeout (or when a `**Stage Complete:**` marker is written to the plan file).

3. **Manual test — promptAll (column-level Prompt All button):**
   - Create 2+ plans in PLAN REVIEWED.
   - Click the "Prompt All" button on the column header.
   - Verify all moved cards show the working status ring.

4. **Manual test — dispatchFailedPromptReady (drag-drop with no agent):**
   - Disable all coding agents in Setup.
   - Drag a card from PLAN REVIEWED to a coder column.
   - Verify the prompt is copied to clipboard, the card moves to the coder column, and the working status ring appears.

5. **Manual test — no next column:**
   - Click "Copy Prompt" on a card in the last column (no next column to advance to).
   - Verify the working status ring does NOT appear (the card hasn't moved to a working column).

6. **Manual test — timeout sweep:**
   - After stamping `dispatched_at` via copy-prompt, wait for the timeout to elapse (or reduce `switchboard.activityLight.timeoutMs` for testing).
   - Verify the working ring turns off after the timeout.

7. **Regression — terminal dispatch:** Dispatch a card to a Switchboard-controlled terminal and verify the working ring still appears (existing `updateDispatchInfoByPlanFile` path, unchanged).

8. **Regression — paste attribution:** Paste a prompt into a Switchboard terminal pane and verify the working ring appears (existing `attributePastedPrompt` path, unchanged).
