# Display Plan Names in Autoban Live Feed Logs

## Goal
Modify the frontend live feed renderer to extract and display individual plan names for Autoban batch dispatch events, utilizing the `sessionIds` already provided in the event payload.

## User Review Required
> [!NOTE]
> This is a frontend-only visual change to `src/webview/implementation.html`. No backend payload structure changes are necessary since `sessionIds` are already emitted during Autoban dispatch.

## Complexity Audit

**Manual Complexity Override:** Low


### Band A — Routine
- Update the `formatActivitySummary` JavaScript function in the sidebar webview to map session IDs to plan topics using the existing `currentRunSheets` state array.

### Band B — Complex / Risky
- None.






## Edge-Case & Dependency Audit
- **Race Conditions:** `currentRunSheets` might not be perfectly synced with the exact moment the activity log is rendered if the sidebar was just freshly opened and the log loaded before the runsheets. We must gracefully fall back to the `sessionId` string if a topic isn't found.
- **Security:** None.
- **Side Effects:** Large batches (e.g., 5 plans with very long titles) could cause the activity log line to wrap across multiple lines. The flexbox layout in `.activity-item` will naturally handle text wrapping, but it will increase the vertical height of log entries.
- **Dependencies & Conflicts:** Depends on `payload.sessionIds` being present in the `autoban_dispatch` event (which was successfully added in the prior `live_feed_not_registering_autoban_moves` update).

## Adversarial Synthesis

### Grumpy Critique
What happens when someone has a batch of 5 plans and the titles are all 100 characters long?! You're going to turn a neat, single-line log entry into a massive wall of text that pushes everything else out of the live feed view! And what if `currentRunSheets` hasn't loaded yet? It'll just print out a bunch of ugly internal `sess_12345` IDs! This is going to make the sidebar look completely cluttered!

### Balanced Response
Grumpy is right about the potential for text bloat. However, the core purpose of an activity feed is observability—knowing *what* the autonomous engine actually moved is crucial for user trust. The flexbox wrapping handles long text natively, and because it's a sidebar, vertical scrolling is expected. To mitigate the ugliness of missing titles, we will safely fall back to the raw ID so the user at least has a traceable reference. Since the UI updates `currentRunSheets` on every state refresh, the data will almost always be present. This is a net-positive for transparency.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Sidebar Webview UI
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The `formatActivitySummary(event)` function builds the display string for the live feed. For `autoban_dispatch` events, it currently ignores the `sessionIds` array and only prints the batch count.
- **Logic:** 
  1. Extract the `payload.sessionIds` array.
  2. Map over the array, looking up each ID in the global `currentRunSheets` array to get the corresponding `topic`.
  3. If a sheet isn't found in the current state, fall back to the raw `sessionId`.
  4. Join these topics with a comma separator.
  5. Append the formatted string `(Topic 1, Topic 2)` to the existing log message immediately after the batch count.
- **Implementation:** See the Appendix patch below.
- **Edge Cases Handled:** Includes a safety check for `Array.isArray(payload.sessionIds)` to prevent crashes if a malformed event is logged. 

## Verification Plan

### Automated Tests
- None required for this pure frontend string manipulation.

### Manual Testing
1. Enable the Autoban engine with a batch size of 2 or 3.
2. Place multiple distinct plans in an active Autoban column (e.g., `CREATED` or `PLAN REVIEWED`).
3. Wait for the Autoban tick to fire.
4. Verify the Live Feed in the sidebar updates with an entry that looks like: `⚡ Autoban: moved 3 plan(s) (Fix auth bug, Update CSS, Add caching) from CREATED -> Planner`.
5. Check the developer console to ensure no errors are thrown during rendering.

## Appendix: Implementation Patch
Provide the complete generated code, unified diff, or exact file replacements needed to implement the proposed changes above in a single code block. Do not use truncated placeholders. Use N/A only when no code change is required.
```diff
--- src/webview/implementation.html
+++ src/webview/implementation.html
@@ -... +... @@
 function formatActivitySummary(event) {
     const payload = event && event.payload ? event.payload : {};
     if (event.type === 'autoban_dispatch') {
         const count = Number(payload.batchSize || (Array.isArray(payload.sessionIds) ? payload.sessionIds.length : 0) || 0);
+        let topicsStr = '';
+        if (Array.isArray(payload.sessionIds) && payload.sessionIds.length > 0) {
+            const topics = payload.sessionIds.map(id => {
+                const sheet = currentRunSheets.find(s => s.sessionId === id);
+                return sheet ? sheet.topic : id;
+            });
+            topicsStr = ` (${topics.join(', ')})`;
+        }
-        return `⚡ Autoban: moved ${count} plan(s) from ${payload.sourceColumn} -> ${roleLabel(payload.targetRole)}`;
+        return `⚡ Autoban: moved ${count} plan(s)${topicsStr} from ${payload.sourceColumn} -> ${roleLabel(payload.targetRole)}`;
     }
```

***
Would you like me to go ahead and dispatch this to the Coder agent to implement?

## Reviewer Enhancement Pass (2026-03-17)

### Verified Code Anchors
- `src/webview/implementation.html:1887` defines `currentRunSheets`, which is the correct in-memory lookup source for plan topics in the sidebar webview.
- `src/webview/implementation.html:1986-1992` contains the active `formatActivitySummary(event)` branch for `autoban_dispatch`; it currently renders only count, source column, and target role.
- `src/webview/implementation.html:2031-2058` already routes both `summary` and `autoban_dispatch` events through the same `.activity-summary-message` renderer, so this plan does **not** need any DOM-structure changes.
- `src/webview/implementation.html:2130-2131` refreshes `currentRunSheets` from the host message pipeline, which is what makes topic lookup viable in the renderer.
- `src/services/TaskViewerProvider.ts:1382-1388` already emits `sessionIds` and `batchSize` in the `autoban_dispatch` payload. Backend payload work is already done.

### Dependencies / Cross-Plan Conflict Scan
- **Depends on:** `feature_plan_20260316_222047_live_feed_not_registering_autoban_moves.md` having already landed. This plan is a formatting/observability follow-up on top of that payload/logging work, not a replacement for it.
- **Shared surface:** `feature_plan_20260317_154731_autoban_bugs.md` also touches autoban dispatch behavior in `TaskViewerProvider.ts`. Conflict risk stays low if this plan remains frontend-only and does not change the `autoban_dispatch` payload contract.
- **Important scope correction:** the live-feed renderer is verified in `src/webview/implementation.html`, not `src/webview/kanban.html`. Keep the implementation localized to the actual sidebar renderer.

### Refined Execution Steps
1. **Extend only the existing renderer branch**
   - **File:** `src/webview/implementation.html`
   - **Lines:** `1988-1992`
   - Keep the existing `if (event.type === 'autoban_dispatch')` branch and add topic resolution immediately before the returned template string.
2. **Resolve session IDs to human-readable plan topics**
   - **File:** `src/webview/implementation.html`
   - **Lines:** `1887`, `1988-1992`, `2130-2131`
   - Read `payload.sessionIds` only when `Array.isArray(payload.sessionIds)` is true.
   - For each ID, resolve `currentRunSheets.find(sheet => sheet.sessionId === id)?.topic`.
   - If the sheet or topic is missing, fall back to the raw session ID so fresh-load races remain traceable rather than blank.
3. **Append plan names without changing the overall message shape**
   - **File:** `src/webview/implementation.html`
   - **Lines:** `1989-1992`
   - Preserve the current message prefix (`⚡ Autoban: moved X plan(s) ... from SOURCE -> ROLE`) and append the resolved topic list as a suffix such as ` (Fix auth bug, Update CSS)`.
   - Only append the suffix when at least one non-empty label exists after normalization.
4. **Leave the renderer pipeline and payload emission untouched**
   - **Files:** `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`
   - **Lines:** `2031-2058`, `1382-1388`
   - Do not refactor `renderRecentActivity()` and do not add backend fields; both surfaces already provide the necessary hooks.

### Additional Edge-Case Audit
- **Cold-load race:** if `recentActivityEvents` render before `currentRunSheets` arrives, the renderer should fall back to raw IDs and recover automatically on the next refresh.
- **Duplicate IDs:** if a malformed payload repeats a session ID, the UI should render it twice rather than silently deduplicating and hiding what the event actually reported.
- **Long names / long batches:** wrapping is acceptable in the sidebar; do not add truncation logic in this pass because the feed's main job is observability.
- **Malformed payloads:** a non-array or partially empty `sessionIds` payload should degrade to the current count-only message rather than throwing.

### Adversarial Review Addendum

#### Grumpy Critique
- "Don't casually widen this into a renderer refactor. The event already renders fine; the missing piece is just name lookup."
- "If you blindly join unresolved values, you're going to emit dangling commas and `undefined` garbage into the feed."
- "If you push backend changes here, you'll create churn in the same autoban dispatch path other plans are already touching for no reason."

#### Balanced Synthesis
- Keep the change entirely inside the existing `autoban_dispatch` formatter branch.
- Normalize the resolved labels and append the suffix only when there is at least one usable value.
- Treat backend payloads as authoritative and unchanged; this is a narrow frontend enhancement with low regression risk.

### Complexity Audit Update

#### Band A — Routine
- Single-file renderer update in `src/webview/implementation.html`.
- Reuses already-present `currentRunSheets` state and already-emitted `sessionIds`.
- No schema, workflow, or dispatch-path changes.

#### Band B — Complex / Risky
- None.

### Agent Recommendation
Send this to the **Coder agent**. The verified implementation is a small, localized renderer change in one file with clear fallback behavior and no architectural churn.

## Reviewer Pass (2026-03-19)

### Implementation Status: ✅ COMPLETE — No fixes required

### Files Changed by Implementation
- `src/webview/implementation.html` — `formatActivitySummary()` (lines 1993–2008): topic lookup from `currentRunSheets` with raw-ID fallback, appended as suffix to batch dispatch message.

### Grumpy Findings
| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | Uses `function(id)` / `function(s)` ES5 syntax instead of arrow functions used elsewhere in the file. Cosmetic inconsistency only. |
| 2 | NIT | No truncation on long topic lists for large batches. Plan explicitly deferred this for observability reasons. |

### Balanced Synthesis
- Implementation is correct and matches the plan exactly.
- `Array.isArray` guard, `sheet.topic` fallback to raw ID, and `currentRunSheets` reuse all present.
- No code fixes needed.

### Validation Results
- `npm run compile`: ✅ PASSED (webpack compiled successfully)
- No TypeScript changes — pure frontend HTML/JS.

### Remaining Risks
- Very long batch topic lists may cause visual wrapping in the live feed (accepted per plan).
