# prompt for plan created should reference improve-plan workflow

## Notebook Plan

The copied prompt from the "Plan Created" Kanban card still references the old enhance workflow wording. It should now reference the `/improve-plan` workflow.

## Goal
- Ensure all plan review dispatch paths consistently use `improve-plan` instruction instead of the legacy `enhance` instruction.
- The clipboard prompt is already fixed; the remaining work is in the sidebar planner dispatch.

## Source Code Verification (2026-03-15)
- **`_buildInitiatedPlanPrompt`** at `src/services/TaskViewerProvider.ts:5223-5225` — ✅ Already returns `@[/improve-plan]`. No change needed.
- **Sidebar dispatch** at `src/webview/implementation.html:2572` — ❌ Still sends `instruction: 'enhance'`. This is the remaining fix.
- **Backend handler** at `src/services/TaskViewerProvider.ts:4782` — Already handles both `'improve-plan'` and `'enhance'` identically. Once the sidebar is updated, the `enhance` code path becomes dead code.

## Proposed Changes

### Execution Steps

**Step 1 — Update sidebar planner dispatch (Routine)**
- **File:** `src/webview/implementation.html`
- **Line ~2572:** Change `instruction: 'enhance'` to `instruction: 'improve-plan'`
- **Exact change:**
  ```js
  // OLD:
  vscode.postMessage({ type: 'triggerAgentAction', role: 'planner', sessionFile: sessionId, instruction: 'enhance' });
  // NEW:
  vscode.postMessage({ type: 'triggerAgentAction', role: 'planner', sessionFile: sessionId, instruction: 'improve-plan' });
  ```

**Step 2 — Update backend workflow name mapping (Routine)**
- **File:** `src/services/TaskViewerProvider.ts`
- **Line ~5025-5026:** Remove the special-case for `enhance` in the `_handleTriggerAgentActionInternal` workflow name assignment, or update it to map `improve-plan` consistently.
- The block at line ~608-616 that maps `instruction === 'enhance'` to `'Enhanced plan'` should be updated so `'improve-plan'` maps to `'Improved plan'` (which it already does at line 612-613). The `enhance` fallback can be kept for backward compatibility with older runsheets but the sidebar will no longer emit it.

**Step 3 — Verify no remaining enhance emissions (Routine)**
- Search `src/webview/implementation.html` for any other occurrences of `'enhance'` as an instruction value. There should be none after Step 1.
- The `_deriveColumnFromEvents` at line 959 must still recognize `'Enhanced plan'` for backward compatibility with existing runsheets. Do NOT remove it.

### Complex/Risky Work
- None. This is a straightforward string replacement. Backward compatibility is preserved because the backend already handles both instructions identically.

## Verification Plan
1. Open the Switchboard sidebar, navigate to the Agents tab.
2. Select a plan in the "Plan Created" column and click the planner dispatch button.
3. Observe the dispatched workflow name in the runsheet JSON — it should record `'Improved plan'`, not `'Enhanced plan'`.
4. Use the copy action on a "Plan Created" card. Verify clipboard contains `@[/improve-plan]`.
5. Verify that existing plans with `'Enhanced plan'` events in their runsheets still correctly appear in the "PLAN REVIEWED" column (backward compat).

## Open Questions
- None. All paths verified.

---

## Adversarial Review

### Grumpy-style Critique
"So the clipboard prompt was already fixed and you wrote a whole plan for a one-line string replacement in implementation.html? The only risk here is if some other code path still emits 'enhance' — and you've verified there's only one. The backend already handles both. This is a 30-second fix masquerading as a feature plan."

### Balanced Synthesis
The critique is valid — this is a trivial change. However, the plan correctly identifies the backward compatibility requirement (keeping `'Enhanced plan'` recognition in `_deriveColumnFromEvents`) and documents the exact line to change. The scope is appropriately minimal.

**Recommendation:** This is a simple plan. Send it to the **Coder agent**.
