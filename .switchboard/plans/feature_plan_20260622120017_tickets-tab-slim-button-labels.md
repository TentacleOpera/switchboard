# Slim Down "Convert to Subtask" and "Diagram Prompt" Button Labels in Tickets Tab

## Goal

In the Tickets tab of `planning.html`, the action-bar buttons **Convert to Subtask** and **Diagram Prompt** have verbose labels that crowd the row. Rename them to **To subtask** and **Diagram** respectively.

### Problem Analysis

The tickets preview action bar (`#tickets-preview-meta-bar`) packs many buttons onto one row ([planning.html:3556-3571](src/webview/planning.html#L3556)). Two have long labels:
- `<button id="btn-diagram-prompt" ...>Diagram Prompt</button>` ([planning.html:3568](src/webview/planning.html#L3568)).
- `<button id="btn-convert-subtask" ... title="Convert this ticket to a subtask of another ticket">Convert to Subtask</button>` ([planning.html:3570](src/webview/planning.html#L3570)).

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
- None. The element ids (`btn-diagram-prompt`, `btn-convert-subtask`) and their JS handlers are unchanged, so behavior is unaffected. Verified: handlers bind by id at `planning.js:6624` (`getElementById('btn-diagram-prompt')`) and `planning.js:7036` (`getElementById('btn-convert-subtask')`); the `tickets` cache object also resolves `btnDiagramPrompt` by id at `planning.js:946`. No code looks up these buttons by text content.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** None — labels only. Verified that no code looks up these buttons by their text content: handlers bind by id (`planning.js:6624`, `planning.js:7036`, `planning.js:946`), so the rename is safe.
- **Dependencies & Conflicts:** The Convert modal title ("Convert to Subtask", [planning.html:3736](src/webview/planning.html#L3736)) remains the full phrase for clarity; only the toolbar button is slimmed. An untracked sibling plan ("tickets-tab Source-modal / one-line layout") also tightens this toolbar — before merging either plan, diff against the other to confirm no overlapping line edits on `planning.html:3568`/`3570`. No session ID available for the sibling plan.
- **i18n:** This webview has no localization layer; all sibling buttons in the same bar use hardcoded English labels. Hardcoding "To subtask" / "Diagram" is consistent with the existing file. Non-issue today; if an i18n layer is ever introduced, these strings would need to be externalized alongside every other button in the bar.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the plan originally framed a *net-new* `title` attribute on the diagram button as "retaining" an existing one — corrected to "add for parity"; (2) text-lookup safety was an unverified assumption — now confirmed via id-bound handlers at `planning.js:946/6624/7036`; (3) a sibling toolbar-layout plan may edit the same lines — mitigated by a pre-merge diff checkpoint. Overall risk is near-zero; this is a trivial, verified-safe copy edit.

## Proposed Changes

### 1. `src/webview/planning.html` — Diagram button
At [3568](src/webview/planning.html#L3568). The current button has **no `title` attribute**; this change shortens the label *and* adds a `title` for parity with the convert button (which already has one), preserving discoverability now that the label is shorter:
```html
<button id="btn-diagram-prompt" class="strip-btn" style="display:none;" title="Copy a diagram prompt for this ticket">Diagram</button>
```

### 2. `src/webview/planning.html` — Convert-to-subtask button
At [3570](src/webview/planning.html#L3570). The existing `title` attribute is retained unchanged; only the visible label is shortened:
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
5. Pre-merge: diff against the sibling "tickets-tab Source-modal / one-line layout" plan to confirm no overlapping edits on `planning.html:3568`/`3570`.

## Recommendation

Complexity 1 → **Send to Intern**.

## Review Pass — 2026-06-22

### Files Changed (Implementation)
- `src/webview/planning.html:3568` — Diagram button: label `Diagram Prompt` → `Diagram`; added `title="Copy a diagram prompt for this ticket"`.
- `src/webview/planning.html:3570` — Convert button: label `Convert to Subtask` → `To subtask`; existing `title` retained.

### Files Changed (This Review)
- `.switchboard/plans/feature_plan_20260622120017_tickets-tab-slim-button-labels.md` — corrected stale line references (Problem Analysis, Complexity Audit, Edge-Case Audit, Adversarial Synthesis, Proposed Changes, Verification Plan) to match current file state.

### Stage 1 Findings (Grumpy)
| Severity | Finding | Location |
|:---------|:--------|:---------|
| NIT | Stale line references throughout plan (cited 3384/3386/3541/499/6021/6383; actual 3568/3570/3736/946/6624/7036) | plan file — fixed in this pass |
| NIT | Sibling-plan overlap warning unverified (no session ID) | plan §Dependencies & Conflicts — deferred to pre-merge |

No CRITICAL or MAJOR findings. The code implementation is correct and complete.

### Stage 2 Synthesis
- **Keep:** Both label changes, the added diagram `title`, the retained convert `title`, the untouched modal title at `planning.html:3736`.
- **Fixed now:** Stale line references in the plan file (documentation-only fix; no code changes needed).
- **Deferred:** Sibling-plan overlap diff check — actionable only at merge time by whoever lands second.

### Validation Results
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.
- **Manual source verification:**
  - `planning.html:3568` — label reads `Diagram`, `title` present ✓
  - `planning.html:3570` — label reads `To subtask`, `title` retained ✓
  - `planning.html:3736` — modal title still `Convert to Subtask` ✓
  - All 9 JS references to `btn-diagram-prompt` / `btn-convert-subtask` bind by id (`getElementById` or `getTicketsTabElements` destructure at `planning.js:946,6624,7036,7585,7595,7596,8092,8102,8103`) — zero text-content lookups ✓

### Remaining Risks
- **Sibling-plan merge conflict:** An untracked "tickets-tab Source-modal / one-line layout" plan may edit the same `planning.html` lines. Resolve via pre-merge diff before landing either plan.
