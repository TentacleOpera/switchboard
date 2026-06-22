# Clarify Memo Modal Intro Text: Explain Copy Prompt / Send to Planner

## Goal

In the Memo modal it is not clear what **Copy Prompt** and **Send to Planner** actually do. The intro paragraph must explicitly state that the generated prompt instructs an agent to create a **separate plan file for each issue** in the memo.

### Problem Analysis

The Memo modal lives in [kanban.html:2987-3013](src/webview/kanban.html#L2987-L3013). Its intro paragraph currently reads:

> "Jot down bugs, thoughts, or issues. Entries are saved automatically and persist until you press Send to Planner or Copy Prompt (which clears the memo) or Clear. Each line/paragraph is treated as a separate issue when sent to the planner."

The two action buttons — `memo-copy-btn` ("Copy Prompt") and `memo-send-btn` ("Send to Planner") — both call `memoGeneratePrompt` ([kanban.html:3691-3700](src/webview/kanban.html#L3691-L3700)). The backend builds a planner prompt in `_buildMemoPlannerPrompt` ([KanbanProvider.ts:6989-7023](src/services/KanbanProvider.ts#L6989)) which instructs the agent to "refine EACH issue into a separate, complete plan file — one plan per issue." **Copy Prompt** copies this prompt to the clipboard; **Send to Planner** copies it AND dispatches it to the planner agent terminal.

The current copy never tells the user that the prompt's purpose is to produce one plan file per issue, nor the difference between Copy (clipboard only) and Send (auto-dispatch to the planner agent).

### Root Cause

The intro paragraph describes persistence/clearing behavior but omits the actual outcome of the two buttons: generating a planner prompt that produces a separate plan file per issue.

## Metadata

**Tags:** frontend, ui, ux
**Complexity:** 1

## User Review Required

No. This is a pure text/copy change with no behavioral, structural, or data-layer impact. The wording should be reviewed visually in the modal for clarity and layout, but no architectural decision is needed.

## Complexity Audit

### Routine
- Editing static modal copy in one HTML file (`src/webview/kanban.html`).
- Replacing a single `<p>` element's inner text — no JS, no CSS, no backend changes.
- Reuses existing inline-style pattern (`font-size: 12px; color: var(--text-secondary);`) already present in the file.

### Complex / Risky
- None. Pure text change with no behavioral impact.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The intro paragraph is static HTML rendered once when the modal opens.
- **Security:** None. No user input is processed; this is display-only copy.
- **Side Effects:** None — text only. No event handlers, no state changes, no data flow affected.
- **Dependencies & Conflicts:**
  - Keep wording consistent with the actual backend behavior in `_buildMemoPlannerPrompt` ([KanbanProvider.ts:6989-7023](src/services/KanbanProvider.ts#L6989)). The prompt does produce one plan file per issue — the new copy accurately reflects this.
  - **Clarification:** The proposed text says the memo is "cleared" after Copy Prompt or Send to Planner. This is accurate for the success path. In the failure path (Send to Planner dispatch fails — no planner terminal available, or dispatch error), the backend preserves the memo for retry ([KanbanProvider.ts:6933-6950](src/services/KanbanProvider.ts#L6933)). This edge case is communicated to the user via the status message ("Memo preserved for retry") and does not need to be in the intro paragraph. The simplified copy is intentional and acceptable.
  - Do not contradict the related header/workspace-name change or the prompt-text cleanup if those are applied separately.

## Dependencies

None. This plan is self-contained and has no dependency on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) line-number inaccuracy in the original plan could mislead the implementer — corrected to 2995-3000; (2) invalid tags violated the workflow schema — corrected to `frontend, ui, ux`; (3) the intro text simplifies the clearing behavior by omitting the send-failure retry path, but this is acceptable since the status message handles that case. Mitigations: all three issues are addressed in this revised plan. No implementation-level risks remain — this is a single-element text replacement with no behavioral impact.

## Proposed Changes

### 1. `src/webview/kanban.html` — rewrite the memo intro paragraph

Replace the paragraph at [kanban.html:2995-3000](src/webview/kanban.html#L2995-L3000):

```html
<p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
    Jot down bugs, thoughts, or issues — one per line or paragraph. Each entry becomes a
    <strong>separate issue</strong>.
    <br><br>
    <strong>Copy Prompt</strong> copies a planner prompt to your clipboard; <strong>Send to Planner</strong>
    copies it <em>and</em> dispatches it to your planner agent. In both cases the prompt instructs the agent to
    <strong>create a separate plan file for each issue</strong> in <code>.switchboard/plans/</code>.
    <br><br>
    Entries are <strong>saved automatically</strong> and the memo is <strong>cleared</strong> after Copy Prompt or
    Send to Planner (or when you press <strong>Clear</strong>).
</p>
```

**Context:** The `<p>` element is the first child of `<div class="modal-body">` inside the `#memo-modal` overlay (640px width, `max-width: 90vw`). The replacement preserves the existing inline style (`font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;`) and uses the same `<br><br>` double-break spacing pattern.

**Logic:** No logic changes. The `<p>` is static HTML; no `id`, no event handler, no data binding.

**Edge Cases:** The new text is ~3x longer than the original. At 12px font size inside a 640px modal, this adds approximately 3-4 lines of height. The textarea below has `min-height: 300px` with `resize: vertical`, so the modal will grow slightly but should not overflow. Verify visually.

## Verification Plan

### Automated Tests

N/A — this is a text-only change to static HTML copy. No unit, integration, or e2e test covers modal intro paragraph wording, and adding one would be testing a string literal. Manual visual verification is sufficient.

> **Session Directives:** Compilation (`npm run compile` / webpack) and automated tests are skipped per session instructions. The user will run these separately.

### Manual Verification

1. Build and open the Kanban panel → open the Memo modal (memo icon / Cmd+Shift+Alt+M).
2. Confirm the intro text now explains: (a) Copy Prompt vs Send to Planner, and (b) that the prompt makes one plan file per issue.
3. Confirm no layout overflow inside the 640px modal; the textarea and footer buttons remain visible.
4. Confirm the `<br><br>` spacing renders consistently with other modals in the file.

---

**Recommendation:** Complexity 1 → **Send to Intern**

## Review Pass — 2026-06-22

### Stage 1: Grumpy Findings

| Severity | Finding | Location |
|----------|---------|----------|
| NIT | Plan's line-number reference says "2995-3000" but the actual paragraph lives at 3003-3013. Doc inaccuracy, not a code issue. | Plan file line 62 vs `src/webview/kanban.html:3003-3013` |
| NIT | The "cleared after Send" simplification omits the send-failure retry path. Already documented and accepted in the plan's Edge-Case Audit (line 47). No action needed. | `src/webview/kanban.html:3011-3012` |

**No CRITICAL findings. No MAJOR findings.**

### Stage 2: Balanced Synthesis

**Keep (as-is):** The entire `<p>` replacement block at `src/webview/kanban.html:3003-3013`. Every factual claim verified against backend source:
- "Copy Prompt copies a planner prompt to your clipboard" → `KanbanProvider.ts:6983` (`vscode.env.clipboard.writeText`).
- "Send to Planner copies it *and* dispatches it" → `KanbanProvider.ts:6983` (clipboard) + `:6987` (`_dispatchMemoToPlanner`).
- "create a separate plan file for each issue in `.switchboard/plans/`" → `KanbanProvider.ts:7045` ("one plan per issue") + `:7042` (`plansDir = .switchboard/plans`).
- "Entries are saved automatically" → debounce `memoSaveTimer` pattern at `kanban.html:3705/3711`.
- "memo is cleared after Copy Prompt or Send to Planner" → `KanbanProvider.ts:6990-6993` (success path); failure path preserves memo with status message (`:7002`), intentionally omitted per Edge-Case Audit.

**Fix now:** None. Zero CRITICAL/MAJOR findings — no code changes required.

**Defer:** Plan's internal line-number reference inaccuracy (2995-3000 → 3003-3013) corrected in this review section for accuracy; no code impact.

### Code Fixes Applied

None. The implementation at `src/webview/kanban.html:3003-3013` is a verbatim match of the plan's proposed text and all claims are accurate against the backend. No fixes were needed.

### Files Changed by Implementation

- `src/webview/kanban.html` (lines 3003-3013) — memo modal intro `<p>` rewritten. Introduced in commit `760c49c`.

### Validation Results

- **Compilation:** SKIPPED per session directives (`npm run compile` / webpack). User will run separately.
- **Automated tests:** SKIPPED per session directives. User will run separately.
- **Static verification:** Complete. Text replacement matches plan exactly; all copy claims verified against `KanbanProvider.ts` backend behavior (`_buildMemoPlannerPrompt`, `memoGeneratePrompt` handler, `_dispatchMemoToPlanner`).
- **Manual visual verification:** Pending — to be performed by user per plan's Verification Plan (lines 93-97): open Memo modal, confirm intro text explains Copy vs Send + one-plan-per-issue, confirm no layout overflow in 640px modal.

### Remaining Risks

None. This is a static HTML text replacement with no behavioral, structural, or data-layer impact. The only residual item is the user's manual visual layout check (3-4 extra lines at 12px in a 640px modal with a 300px-min textarea).
