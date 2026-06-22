# Slim Down "Convert to Subtask" and "Diagram Prompt" Button Labels in Tickets Tab

## Goal

In the Tickets tab of `planning.html`, the action-bar buttons **Convert to Subtask** and **Diagram Prompt** have verbose labels that crowd the row. Rename them to **To subtask** and **Diagram** respectively.

### Problem Analysis

The tickets preview action bar (`#tickets-preview-meta-bar`) packs many buttons onto one row ([planning.html:3370-3387](src/webview/planning.html#L3370)). Two have long labels:
- `<button id="btn-diagram-prompt" ...>Diagram Prompt</button>` ([planning.html:3384](src/webview/planning.html#L3384)).
- `<button id="btn-convert-subtask" ... title="Convert this ticket to a subtask of another ticket">Convert to Subtask</button>` ([planning.html:3386](src/webview/planning.html#L3386)).

The long text widens the action bar unnecessarily. Shorter labels reduce crowding while the existing `title` tooltips preserve the full meaning.

### Root Cause

The button labels are longer than needed for a dense toolbar.

## Metadata

**Complexity:** 1
**Tags:** frontend, ui, ux

## User Review Required

No. This is a pure copy/label change with no behavioral, data, or structural impact. No confirmation dialogs are involved (per project rules, none are ever added). The label text is cosmetic; tooltips preserve discoverability.

## Complexity Audit

### Routine
- Editing two button label texts in one HTML file.
- Adding a `title` attribute to the diagram button for parity with the convert button (which already has one) — Clarification, not new product scope: shortening a label benefits from a tooltip, and the sibling button already sets this precedent.

### Complex / Risky
- None. The element ids (`btn-diagram-prompt`, `btn-convert-subtask`) and their JS handlers are unchanged, so behavior is unaffected. Verified: handlers bind by id at `planning.js:6021` (`getElementById('btn-diagram-prompt')`) and `planning.js:6383` (`getElementById('btn-convert-subtask')`); the `tickets` cache object also resolves `btnDiagramPrompt` by id at `planning.js:499`. No code looks up these buttons by text content.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** None — labels only. Verified that no code looks up these buttons by their text content: handlers bind by id (`planning.js:6021`, `planning.js:6383`, `planning.js:499`), so the rename is safe.
- **Dependencies & Conflicts:** The Convert modal title ("Convert to Subtask", [planning.html:3541](src/webview/planning.html#L3541)) remains the full phrase for clarity; only the toolbar button is slimmed. An untracked sibling plan ("tickets-tab Source-modal / one-line layout") also tightens this toolbar — before merging either plan, diff against the other to confirm no overlapping line edits on `planning.html:3384`/`3386`. No session ID available for the sibling plan.
- **i18n:** This webview has no localization layer; all sibling buttons in the same bar use hardcoded English labels. Hardcoding "To subtask" / "Diagram" is consistent with the existing file. Non-issue today; if an i18n layer is ever introduced, these strings would need to be externalized alongside every other button in the bar.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the plan originally framed a *net-new* `title` attribute on the diagram button as "retaining" an existing one — corrected to "add for parity"; (2) text-lookup safety was an unverified assumption — now confirmed via id-bound handlers at `planning.js:499/6021/6383`; (3) a sibling toolbar-layout plan may edit the same lines — mitigated by a pre-merge diff checkpoint. Overall risk is near-zero; this is a trivial, verified-safe copy edit.

## Proposed Changes

### 1. `src/webview/planning.html` — Diagram button
At [3384](src/webview/planning.html#L3384). The current button has **no `title` attribute**; this change shortens the label *and* adds a `title` for parity with the convert button (which already has one), preserving discoverability now that the label is shorter:
```html
<button id="btn-diagram-prompt" class="strip-btn" style="display:none;" title="Copy a diagram prompt for this ticket">Diagram</button>
```

### 2. `src/webview/planning.html` — Convert-to-subtask button
At [3386](src/webview/planning.html#L3386). The existing `title` attribute is retained unchanged; only the visible label is shortened:
```html
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">To subtask</button>
```

(The `title` attributes retain/provide the full description for discoverability.)

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user. No unit/integration/e2e tests are added or modified by this change — it is a pure HTML label edit with no behavioral surface.

### Manual Verification
1. Build; open Planning → Tickets → select a ticket so the action bar shows.
2. Confirm the buttons read **Diagram** and **To subtask**.
3. Hover each → confirm the tooltip still explains the full action (diagram button now has a tooltip it previously lacked; convert button retains its existing tooltip).
4. Click each → confirm behavior is unchanged (Diagram prompt copy; Convert-to-subtask modal opens).
5. Pre-merge: diff against the sibling "tickets-tab Source-modal / one-line layout" plan to confirm no overlapping edits on `planning.html:3384`/`3386`.

## Recommendation

Complexity 1 → **Send to Intern**.
