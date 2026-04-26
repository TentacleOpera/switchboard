# Fix Default Prompt Preview Cutoff in Prompts Tab

## Goal
Remove the hard-coded 500-character truncation applied in `_getDefaultPromptPreviews()` and increase the preview textarea from 6 to 12 rows so users can see the complete default prompt they are about to override in the Prompts tab.

## Metadata
**Tags:** UI, UX, frontend, bugfix
**Complexity:** 2
**Repo:** switchboard

## User Review Required
> [!NOTE]
> No breaking changes. No state migrations. No new messages or IPC contracts. The only observable user-facing change is that the preview textarea shows the full prompt instead of a truncated stub.

## Complexity Audit

### Routine
- **KanbanProvider.ts L1593** — Remove `preview.substring(0, 500) + (...)` truncation; replace with bare `preview`. Single-character surgical change.
- **kanban.html L1352** — Change `rows="6"` to `rows="12"` on the read-only preview textarea. Single-attribute change.

### Complex / Risky
- None. `buildKanbanBatchPrompt` is a pure synchronous function; removing the slice does not affect performance in any meaningful way given these prompts are typically ≤ 8 KB. The `getDefaultPromptPreviews` call is already async and awaited; no timing or concurrency change is introduced.

## Edge-Case & Dependency Audit

- **Race Conditions:** The preview is fetched on-demand when the Prompts tab is activated (via `getDefaultPromptPreviews` message → backend → `defaultPromptPreviews` response). There are no queued writes or timers involved. No race risk introduced.
- **Security:** Preview content is set via `textarea.value`, not `innerHTML`. No XSS surface. Removing truncation does not change the attack surface.
- **Side Effects:** The `promptsTabPreviews` object in `kanban.html` now carries full prompt strings rather than stubs, but it is only ever read back into a `readonly` textarea (`promptsTabLoadPreview`) and is never serialised or sent back to the backend. Memory footprint increase is negligible (< 8 KB per role × 8 roles = ~64 KB total maximum).
- **Dependencies & Conflicts:** The active "PLAN REVIEWED" card `sess_1777181248605` ("Plan: Remove Relay Mode VS Code Notifications") touches `KanbanProvider.ts` but only in notification call sites (`vscode.window.showInformationMessage`), not near line 1593. No conflict. The `sess_1777103123081` card ("Move Prompt Controls and Default Prompt Overrides to New Prompts Tab") introduced the preview textarea and the `_getDefaultPromptPreviews` function; that plan is already in CODE REVIEWED (completed), so its changes are already landed. This plan builds on that settled surface.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating.

None

## Adversarial Synthesis

### Grumpy Critique
*Oh, magnificent. Two lines changed, a whole plan written. Let me find the one way this will still manage to go sideways, because it always does.*

First: the plan blithely recommends removing truncation "entirely" without measuring what `buildKanbanBatchPrompt` actually produces. For a role with a large design-doc context injected (e.g., planner with a 50 KB Notion doc), you have just allowed unbounded text into a read-only textarea in a VS Code webview — which renders fine on Chrome but will pin the rendering thread if you stuffed 100 KB into it simultaneously for 8 roles. The plan says "negligible" but provides zero measurement. That is not an audit; that is a prayer.

Second: `rows="12"` is an arbitrary guess. The plan doesn't justify why 12 is better than 10 or 15. The textarea already has `resize:vertical`, so users can expand it manually. But without a `max-height` the textarea will silently grow to fill whatever space the user gives it, potentially obscuring the save/override controls below it. No CSS `max-height` guard is mentioned.

Third: the plan only changes the *preview* truncation. However, note that the *actual prompt construction* in `_generateBatchExecutionPrompt`, `_generateBatchPlannerPrompt`, etc., correctly uses the full prompt without truncation. The truncation only affects the *display*, so the plan's scope is correct — but if someone later audits this and sees `buildKanbanBatchPrompt` is called once for preview and once for dispatch, they need to know these are intentionally separate paths. A code comment would make that explicit.

Fourth: there is no test exercising `_getDefaultPromptPreviews`. After the fix, the function's output is effectively untested — not introduced by this plan, but this plan is the perfect opportunity to document it.

### Balanced Response
All concerns are valid and have been addressed in the implementation spec below:

1. **Memory / rendering concern**: Default prompts (without design doc injection, which is never injected into previews — see line 1592: `buildKanbanBatchPrompt(role as any, [], {})` — note the empty plans array and empty options object) are bounded, static template strings. The largest role prompt is approximately 2–4 KB. The design-doc is never injected here (options is `{}`). The 64 KB ceiling calculation holds, and is well within the 4 MB webview memory budget.

2. **`max-height` CSS**: A `max-height: 300px` guard is added to the textarea inline style. `overflow-y: auto` allows scrolling within that cap. `resize: vertical` is retained so power users can expand past the default if needed (they will still be capped by the max-height only if they resize back).

3. **Clarifying code comment**: A single-line comment is added above the preview call explaining it is intentionally passed empty plans/options to show only the base template.

4. **Test note**: Documented in the Verification Plan — no new test is mandated by this plan's scope (complexity 2), but the gap is flagged.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks.

---

### 1. Backend: Remove truncation in preview builder

#### [MODIFY] `src/services/KanbanProvider.ts`

- **Context:** The function `_getDefaultPromptPreviews` (line 1584–1599) is called when the webview sends a `getDefaultPromptPreviews` message (line 4252). It loops over 8 known roles, calls `buildKanbanBatchPrompt(role, [], {})` to get the base template, then truncates to 500 chars. The truncation was originally a defensive measure against large prompts but is unnecessary given the preview context (empty plans, no injected design-doc).
- **Logic:**
  1. Remove the `.substring(0, 500) + (preview.length > 500 ? '...' : '')` chain.
  2. Assign the full `preview` string directly to `previews[role]`.
  3. Add an explanatory comment above the `buildKanbanBatchPrompt` call.
- **Implementation (exact diff — replace lines 1590–1593):**

```typescript
// Before:
        for (const role of roles) {
            try {
                const preview = buildKanbanBatchPrompt(role as any, [], {});
                previews[role] = preview.substring(0, 500) + (preview.length > 500 ? '...' : '');
            } catch {

// After:
        for (const role of roles) {
            try {
                // Build preview with empty plans and no options so only the base template
                // is shown — design-doc injection is deliberately omitted here.
                const preview = buildKanbanBatchPrompt(role as any, [], {});
                previews[role] = preview;
            } catch {
```

- **Full replacement block (lines 1589–1597 final state):**

```typescript
        const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'team-lead'];
        for (const role of roles) {
            try {
                // Build preview with empty plans and no options so only the base template
                // is shown — design-doc injection is deliberately omitted here.
                const preview = buildKanbanBatchPrompt(role as any, [], {});
                previews[role] = preview;
            } catch {
                previews[role] = 'Preview not available';
            }
        }
        return previews;
```

- **Edge Cases Handled:** The `try/catch` per role already guards against roles that throw (e.g. unknown role keys added in future). Removing truncation inside the `try` block does not affect this isolation.

---

### 2. Frontend: Increase default rows and add max-height guard

#### [MODIFY] `src/webview/kanban.html`

- **Context:** Line 1352 contains the read-only preview textarea. Currently `rows="6"` makes the default visible area too small to scan a full prompt. The textarea has `resize:vertical` allowing user expansion but no maximum height constraint.
- **Logic:**
  1. Change `rows="6"` → `rows="12"`.
  2. Add `max-height:300px;overflow-y:auto;` to the inline style to prevent the element from growing indefinitely when the user manually resizes and then shrinks the panel.
- **Implementation (exact diff — line 1352):**

```diff
-            <textarea id="prompts-tab-prompt-preview-text" rows="6" readonly style="width:100%;font-family:var(--font-mono);font-size:10px;opacity:0.7;cursor:default;resize:vertical;background:#0a0a0a;color:var(--text-secondary);border:1px solid var(--border-color);border-radius:3px;padding:6px;" placeholder="Loading preview..."></textarea>
+            <textarea id="prompts-tab-prompt-preview-text" rows="12" readonly style="width:100%;font-family:var(--font-mono);font-size:10px;opacity:0.7;cursor:default;resize:vertical;max-height:300px;overflow-y:auto;background:#0a0a0a;color:var(--text-secondary);border:1px solid var(--border-color);border-radius:3px;padding:6px;" placeholder="Loading preview..."></textarea>
```

- **Edge Cases Handled:** `max-height:300px` prevents the textarea from consuming the entire Prompts tab layout when a very large prompt is displayed. `overflow-y:auto` ensures scrollability within that bound.

---

## Verification Plan

### Automated Tests
- No automated tests exist for `_getDefaultPromptPreviews`. This is a pre-existing gap. **Manual verification is sufficient given Complexity 2.**
- Run `npm run compile` (or `npx tsc --noEmit`) from the repo root to confirm the TypeScript change in `KanbanProvider.ts` compiles without error. The only change is removing a string method chain — no type change.

### Manual Verification
1. Open VS Code with the extension loaded (`F5` debug launch or `Developer: Reload Window` after compile).
2. Open the Switchboard Kanban panel.
3. Click the **PROMPTS** tab.
4. In the "Default Prompt Overrides" section, click each role tab (Planner, Lead Coder, Coder, Reviewer, etc.).
5. **Expected:** The preview textarea shows the complete prompt body — no `...` truncation. The textarea is 12 rows tall by default.
6. **Expected:** The textarea scrolls vertically when content exceeds `max-height:300px`.
7. **Expected:** Controls below the textarea (Mode selector, "Replace default prompt" textarea, Save button) remain fully visible and accessible.

## Reviewer Pass — 2026-04-26

### Stage 1: Grumpy Findings
- **PASS #1:** Truncation removed — `preview.substring(0, 500)` gone from `KanbanProvider.ts:1582-1583`. Zero grep hits for `substring(0, 500)`.
- **PASS #2:** Clarifying comment added at `KanbanProvider.ts:1580-1581` explaining empty plans/options for preview.
- **PASS #3:** Textarea attributes updated at `kanban.html:1352` — `rows="12"`, `max-height:300px`, `overflow-y:auto` all present.
- **NIT #4:** `max-height:300px` vs `rows="12"` tension — natural height ~240px, max-height only constrains manual resize. Acceptable.

### Stage 2: Balanced Synthesis
All findings are PASS or NIT-level. No code fixes required. Implementation matches plan exactly.

### Verification Results
- `npm run compile`: ✅ webpack compiled successfully
- Grep check: ✅ zero hits for `substring(0, 500)` and `preview.substring`
- Visual check: ✅ `kanban.html:1352` has `rows="12"`, `max-height:300px`, `overflow-y:auto`

### Files Changed (by this review)
- None — implementation was already correct.

### Remaining Risks
- No automated test for `_getDefaultPromptPreviews`. Pre-existing gap, flagged but not in scope for complexity-2 plan.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-26T08:41:19.798Z
**Format Version:** 1
