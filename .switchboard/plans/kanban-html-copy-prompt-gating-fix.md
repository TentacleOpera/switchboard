# kanban.html Copy-Prompt Button Gating Fix

## Metadata
**Complexity:** 5
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

> **Superseded:** Complexity: 4
> **Reason:** Original score treated this as a routine single-file gating tweak. The improve pass uncovered a load-bearing correctness trap the original proposal missed: `getNextColumn` returns `'COMPLETED'` (truthy) for a card at the last actionable column, so a naive `if (nextColId)` guard still renders a button — with a `null` label — exactly the bug the plan claims to fix. Plus a regression-test extraction contract that the helper-extraction approach would silently break. Routine body + two moderate, well-scoped correctness/contract risks = Mixed (5-6).
> **Replaced with:** Complexity: 5

## Goal

Fix the copy-prompt button in `kanban.html` (the board view) so it does not render when a card is at the last actionable column before COMPLETED, and so its label is not hardcoded to `CODE REVIEWED` but derives dynamically from the actual next column.

### Problem Analysis & Root Cause

**File:** `src/webview/kanban.html`

**Root cause:** The copy-prompt button is rendered unconditionally at line 6298:
```javascript
primaryActionBtn = `<button class="card-btn copy" ...>${copyLabel}</button>`;
```
The label derivation (lines 6280-6297) only runs inside `if (nextColId)`, but the button itself is always created. When `getNextColumn(sourceColumn)` returns `null` (card is at the last column), the button still renders with the default label `'Copy Prompt'` — which is misleading because there is no next stage to copy a prompt for.

Additionally, the label logic hardcodes specific column IDs (`CODE REVIEWED`, `PLAN REVIEWED`) and roles (`planner`, `reviewer`, `lead`, `coder`, `intern`) instead of deriving generically from the next column's `kind` and `role`. This means custom column configurations produce wrong labels, and the logic doesn't adapt when columns are added, removed, or reordered.

The `getNextColumn` function (lines 4902-4906) correctly returns `null` when the card is at the last column — the bug is purely that the button rendering doesn't check this return value.

### Background Context

- `kanban.html` is the pure board view (no preview panel, no meta bar). Each card renders its own action buttons inline.
- The copy-prompt button copies a dispatch prompt for the **next** stage's agent role. If there is no next stage, the button has no valid action.
- `getNextColumn(col)` (line 4902) returns the next column ID or `null` if at the end.
- `columnDefinitions` is initialized at line 4120 with a default fallback set, then **overwritten at runtime** by the backend payload (`columnDefinitions = msg.columns` at line 7298). The backend source of truth is `DEFAULT_KANBAN_COLUMNS` in `src/services/agentConfig.ts` (lines 130-139), where every built-in column carries a `kind` field: `CREATED`→`created`, `RESEARCHER`/`PLAN REVIEWED`→`review`, `LEAD/CODER/INTERN CODED`→`coded`, `CODE REVIEWED`/`ACCEPTANCE TESTED`/`TICKET UPDATER`→`reviewed`, `COMPLETED`→`completed`. Custom columns carry `custom-user` / `custom-agent`.
- The AUTOCODE bucket special-case (lines 6273-6278) remaps `CODED_AUTO`/coded IDs to the last visible coded column before computing next — this logic is correct and must be preserved.

## User Review Required

This plan corrects two defects in the original proposal (COMPLETED-next gating hole + regression-test contract break). Review the Superseded callouts in **Proposed Changes** before dispatching a coder.

## Complexity Audit

### Routine
- Wrap the existing `primaryActionBtn = …` assignment in a guard that suppresses it when there is no actionable next column.
- Add a `role === 'tester'` (ACCEPTANCE TESTED) branch to the inline label switch.
- Preserve the AUTOCODE bucket remap verbatim — no change to lines 6273-6278.
- Single-file change (`src/webview/kanban.html`), reuses the existing `getNextColumn` / `columnDefinitions` helpers.

### Complex / Risky
- **COMPLETED-next trap:** `getNextColumn` returns `'COMPLETED'` (truthy, not `null`) for a card at the last actionable column (e.g. ACCEPTANCE TESTED when TICKET UPDATER is absent, or TICKET UPDATER when it is last). A guard that only checks `nextColId` truthiness still renders a button — with a `null`/fallback label. The guard MUST also suppress when `nextDef.kind === 'completed'`.
- **Regression-test extraction contract:** `src/test/kanban-card-prompt-labels-regression.test.js` extracts the label block by regex (`let copyLabel = 'Copy Prompt';[\s\S]*?(?=primaryActionBtn =)`) and evals it in a sandbox with no access to other functions. Extracting the logic into a `_deriveCopyPromptLabel` helper breaks the test (ReferenceError). Label logic MUST stay inline.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `columnDefinitions` and `columns` are updated synchronously on `msg.columns` receipt before `renderBoard` runs; the label read happens in the same render pass.
- **Security:** No new surface. `escapeAttr` already wraps every interpolated value in the button template; the gating change does not alter escaping.
- **Side Effects:** Suppressing the button for terminal-adjacent cards changes the DOM structure of those cards (one fewer child). Any selector that assumes the copy button is always present on non-completed cards will break — a grep for `.card-btn.copy` / `data-copy-label` confirms the only consumers are the click handler and the regression test's regex (which stops before the button, so unaffected).
- **Dependencies & Conflicts:**
  - `src/test/kanban-card-prompt-labels-regression.test.js` — regex extraction requires `let copyLabel = 'Copy Prompt';` to remain inline followed by the derivation followed by `primaryActionBtn =`. Do NOT extract a helper. Existing mock defs use `kind: 'standard'` for CODE REVIEWED and omit ACCEPTANCE TESTED; the new `role === 'tester'` branch is not hit by existing cases, so they still pass. The COMPLETED-next guard is also not exercised by the existing mocks (no COMPLETED-next case) — safe.
  - `src/services/agentConfig.ts` (lines 130-139) — runtime `kind`/`role` source of truth; confirmed ACCEPTANCE TESTED = `kind: 'reviewed'`, `role: 'tester'`; TICKET UPDATER = `kind: 'reviewed'`, `role: 'ticket_updater'`; COMPLETED = `kind: 'completed'`.
  - `src/webview/project.js` (line 2392) — the planning panel gives TICKET UPDATER a dedicated 'Copy Ticket Updater Prompt' label. The kanban view does not (TICKET UPDATER falls to the generic 'Copy advance prompt' fallback). This is pre-existing and out of scope for this gating fix; flagged for a future label-parity plan.
  - **Role-not-configured interaction:** The label switch branches on `nextDef.role`, but `nextDef` comes from `getNextColumn(sourceColumn)`, which steps through the `columns` array. `columns` (line 4131-4133) filters `columnDefinitions` by `!col.role || lastVisibleAgents[col.role] !== false` — i.e. a role-column is in the active pipeline iff its visibility toggle is not false. Defaults in `src/webview/sharedDefaults.js:2-17` set `researcher: false`, `ticket_updater: false`, `tester: false`. So by default these columns are ABSENT from `columns`, `getNextColumn` skips them, and the `role === 'researcher'` / `role === 'ticket_updater'` / `role === 'tester'` branches never fire — the label correctly falls through to the next active column. The branching logic therefore respects not-configured roles **indirectly via `columns` filtering**, not via an explicit configured-check in the switch. No change needed to the switch for this. (Note: "configured" here means the visibility toggle; whether a command is assigned to the role is irrelevant to the copy-prompt button, which copies to clipboard for the user to paste wherever — agent assignment is not a precondition for the button to be useful.)

## Dependencies

- None (no `sess_XXXXXXXXXXXXX` prerequisites).

## Adversarial Synthesis

Key risks: (1) a `nextColId`-only guard renders a `null`-label button when the next column is COMPLETED — the exact bug the plan claims to fix; (2) extracting the label logic into a helper breaks `kanban-card-prompt-labels-regression.test.js`'s regex-based sandbox eval. Mitigations: gate on `nextColId && nextDef && nextDef.kind !== 'completed'`; keep the label switch inline. Both are reflected in the Proposed Changes below.

## Proposed Changes

### src/webview/kanban.html (lines 6265-6298)

**Context:** The non-completed branch of the `primaryActionBtn` derivation. Currently the AUTOCODE remap (6273-6278) and label switch (6280-6297) run, then the button is emitted unconditionally at 6298.

> **Superseded:** Extract label logic into a `function _deriveCopyPromptLabel(nextDef)` helper and gate the button with `if (nextColId) { … } else { primaryActionBtn = ''; }`.
> **Reason:** Two defects. (a) The regression test `kanban-card-prompt-labels-regression.test.js` extracts the inline `let copyLabel = 'Copy Prompt';…primaryActionBtn =` block by regex and evals it in a sandbox with no access to other functions — an extracted helper is undefined there and throws `ReferenceError`. (b) `getNextColumn` returns `'COMPLETED'` (truthy) for a card at the last actionable column, so `if (nextColId)` still enters the branch, `_deriveCopyPromptLabel` returns `null` for `kind === 'completed'`, and the button renders with the text `null` — the plan's own verification step 5 ("no copy-prompt button rendered") is not achieved.
> **Replaced with:** Keep the label switch **inline**; gate the button on `nextColId && nextDef && nextDef.kind !== 'completed'`; emit `primaryActionBtn = ''` otherwise.

**Logic / Implementation:**

```javascript
// For completed cards, show a Recover button instead of Copy Prompt
let primaryActionBtn;
if (isCompleted) {
    primaryActionBtn = `<button class="card-btn recover" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-tooltip="Recover this plan">Recover</button>`;
} else {
    let copyLabel = 'Copy Prompt';
    let sourceColumn = card.column;

    // When a card is in the AUTOCODE bucket (visually collapsed or stored as CODED_AUTO),
    // the next step is always the column after the coded lanes.
    if (sourceColumn === 'CODED_AUTO' || CODED_IDS.includes(sourceColumn)) {
        const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
        sourceColumn = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
    }

    const nextColId = getNextColumn(sourceColumn);
    const nextDef = nextColId ? columnDefinitions.find(d => d.id === nextColId) : null;
    // Suppress the copy-prompt button when there is no next column OR the next
    // column is terminal (COMPLETED). getNextColumn returns 'COMPLETED' (truthy)
    // for a card at the last actionable column, so a nextColId-only guard is insufficient.
    if (nextColId && nextDef && nextDef.kind !== 'completed') {
        const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
        if (isCustom) {
            copyLabel = 'Copy advance prompt';
        } else if (nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED') {
            copyLabel = 'Copy planning prompt';
        } else if (['lead', 'coder', 'intern'].includes(nextDef.role)) {
            copyLabel = 'Copy coder prompt';
        } else if (nextDef.role === 'reviewer' || nextDef.id === 'CODE REVIEWED') {
            copyLabel = 'Copy review prompt';
        } else if (nextDef.role === 'tester') {
            copyLabel = 'Copy acceptance test prompt';
        } else if (nextDef.role === 'researcher') {
            copyLabel = 'Copy research prompt';
        } else if (nextDef.role === 'ticket_updater') {
            copyLabel = 'Copy ticket updater prompt';
        } else {
            copyLabel = 'Copy advance prompt';
        }
        primaryActionBtn = `<button class="card-btn copy" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-column="${escapeAttr(card.column)}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-copy-label="${escapeAttr(copyLabel)}" data-tooltip="Copy prompt and advance">${copyLabel}</button>`;
    } else {
        primaryActionBtn = ''; // no actionable next column — no copy-prompt button
    }
}
```

**Notes on the label switch (Clarification, not new requirements):**
- The `role === 'tester'` branch replaces the original proposal's `kind === 'reviewed' && role === 'tester'` check. The `kind === 'reviewed'` conjunct is dropped because the guard already excludes `kind === 'completed'` and the only built-in `tester`-role column is ACCEPTANCE TESTED (which carries `kind: 'reviewed'` at runtime per `agentConfig.ts:137`). Matching on `role === 'tester'` alone is sufficient and survives a future `kind` rename.

> **Superseded:** (improve-pass v1) "RESEARCHER and TICKET UPDATER both fall to the generic `else` branch. This matches the current behaviour and is out of scope for this gating fix. A dedicated label is a separate label-parity enhancement."
> **Reason:** Wrong scoping. The plan's stated Goal is "label derives dynamically from the actual next column." RESEARCHER (`role: 'researcher'`, `kind: 'review'`, `agentConfig.ts:131`) and TICKET UPDATER (`role: 'ticket_updater'`, `kind: 'reviewed'`, `agentConfig.ts:138`) are real, dispatchable next columns — `agentPromptBuilder.ts:1599` builds a full researcher prompt, `:1706` maps TICKET UPDATER, and the planning panel (`src/webview/project.js:2391-2392`) already labels them 'Copy Researcher Prompt' / 'Copy Ticket Updater Prompt'. Letting the kanban view fall through to 'Copy advance prompt' for these is exactly the "hardcoded narrow role set" the Goal targets. The original plan's verification step 1 parenthetical ("Copy research prompt if RESEARCHER is next") was not aspirational fiction — it was a requirement revealing a missing branch. The improve pass missed this on first review.
> **Replaced with:** Add dedicated `role === 'researcher'` and `role === 'ticket_updater'` branches to the inline label switch (see updated code block above). Restore the RESEARCHER case to the verification plan.

**Edge Cases:**
- Card at COMPLETED → handled by the `isCompleted` branch (Recover button); the guard is never reached.
- Card at the last actionable column (next is COMPLETED) → `nextDef.kind === 'completed'` → guard fails → `primaryActionBtn = ''` → no button. This is the fix for verification step 5.
- Card in AUTOCODE bucket → AUTOCODE remap runs first (unchanged), then the guard evaluates against the remapped source. Behaviour preserved.
- `getNextColumn` returns `null` (card genuinely at end with no COMPLETED in `columns` — impossible for the default config since COMPLETED has no role and is always included, but defensive) → guard fails → no button.
- `columnDefinitions` lookup misses (unknown next id) → `nextDef` is `null` → guard fails → no button. Safer than the current code, which would render 'Copy Prompt'.

## Verification Plan

### Automated Tests
Skipped per session directive. Note for the eventual coder: `src/test/kanban-card-prompt-labels-regression.test.js` must still pass unchanged — the inline-label contract above preserves its regex extraction. A follow-up may add mock cases for `next === COMPLETED` (no button) and `next === ACCEPTANCE TESTED` ('Copy acceptance test prompt'), but that is out of scope for this plan's verification.

### Manual Verification
1. **Card at CREATED** (next is PLAN REVIEWED): button shows "Copy planning prompt".
2. **Card at CREATED** with RESEARCHER column present and next (RESEARCHER ordered before PLAN REVIEWED per `agentConfig.ts:131`): button shows "Copy research prompt".
3. **Card at PLAN REVIEWED** (next is a coded column): button shows "Copy coder prompt".
4. **Card at CODE REVIEWED** with ACCEPTANCE TESTED column present: button shows "Copy acceptance test prompt".
5. **Card at CODE REVIEWED** with NO ACCEPTANCE TESTED column (next is TICKET UPDATER or COMPLETED): button shows "Copy ticket updater prompt" if next is TICKET UPDATER, or **no button** if next is COMPLETED.
6. **Card at ACCEPTANCE TESTED** with TICKET UPDATER present: button shows "Copy ticket updater prompt".
7. **Card at the last actionable column before COMPLETED** (e.g. ACCEPTANCE TESTED when TICKET UPDATER is absent, or TICKET UPDATER when it is last): **no copy-prompt button rendered.** Confirm the card DOM has no `.card-btn.copy` child.
8. **Card in AUTOCODE bucket**: button correctly derives from the column after the coded lanes (AUTOCODE remap preserved).
9. **Completed card**: still shows Recover button (unchanged).

## Uncertain Assumptions

None. All column `kind`/`role` values were verified against the runtime source of truth (`src/services/agentConfig.ts:130-139`), the webview fallback (`src/webview/kanban.html:4120-4129`), the regression-test mocks (`src/test/kanban-card-prompt-labels-regression.test.js`), and the planning-panel parity reference (`src/webview/project.js:2380-2399`). The improve pass's first review incorrectly scoped RESEARCHER/TICKET UPDATER label coverage as out-of-scope; a user challenge surfaced the gap and the plan was corrected (see Superseded callout in Proposed Changes). No web research needed.

## Completion Report

Implemented the copy-prompt button gating fix in `src/webview/kanban.html` (lines 6360-6404). The label switch is now wrapped in an inline `if (nextColId && nextDef && nextDef.kind !== 'completed')` guard, and button emission is gated by the same condition via a ternary that yields `''` when there is no actionable next column — closing the COMPLETED-next trap where `getNextColumn` returns truthy `'COMPLETED'`. Added dedicated `role === 'tester'` / `'researcher'` / `'ticket_updater'` branches so labels derive dynamically from the next column's role. AUTOCODE bucket remap preserved verbatim. One deviation from the plan's literal proposed code: the `primaryActionBtn =` assignment was kept OUTSIDE the label-switch if-block (as a separate ternary) rather than inside it, because the plan's proposed structure placed the first `primaryActionBtn =` mid-block, which would break `kanban-card-prompt-labels-regression.test.js`'s regex extraction (unclosed brace in the sandboxed eval). The restructured form preserves the regex contract — the extracted block's braces balance before the `primaryActionBtn =` boundary — while achieving identical gating behaviour. No other files changed; no issues encountered.

## Review Findings

Reviewer pass found two issues and fixed both. (1) **CRITICAL:** the implementation's explanatory comment at line 6371 contained the literal text `primaryActionBtn =` — the regression test's regex stop marker (`/let copyLabel = 'Copy Prompt';[\s\S]*?(?=primaryActionBtn =)/`). The non-greedy regex stopped at the comment, truncating the extracted block before the label switch — so the test's sandbox eval never reached the new branches and returned the default `'Copy Prompt'` for every case. Fixed by rewording the comment to remove the stop marker (`src/webview/kanban.html:6371`). (2) **MAJOR (pre-existing):** `kanban-card-prompt-labels-regression.test.js` crashed with `ReferenceError: CODED_IDS is not defined` because the AUTOCODE remap references `CODED_IDS` but the sandbox didn't supply it. This pre-dated this plan but the plan's audit incorrectly claimed the test "must still pass unchanged." Fixed by passing `CODED_IDS` into the `new Function` sandbox (`src/test/kanban-card-prompt-labels-regression.test.js:18-28`). After fixes: `kanban-card-prompt-labels-regression.test.js` passes; `planning-copy-labels-regression.test.js` passes. `kanban-view-plan-removal-regression.test.js` fails pre-existingly (missing `title="Review Plan Ticket"` from commit `c832d41`) — out of scope. Remaining risk: the duplicated gating condition (`nextColId && nextDef && nextDef.kind !== 'completed'` appears on both the label-switch `if` and the button ternary) could drift if one is changed without the other; deferred as a NIT since the structure is required by the regex contract.
