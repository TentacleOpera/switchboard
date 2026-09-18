# Add Line Breaks Between Example Lines in Memo Tab Placeholder

## Goal

Add blank lines between the three example entries in the Memo sub-tab textarea placeholder so they read as distinct, separated entries instead of running together.

### Problem
In the Memo sub-tab of `implementation.html`, the textarea's placeholder example text shows three sample entries (a Bug, a Thought, and an Issue) separated by only a single newline (`&#10;`). Visually, the three lines run together with no breathing room, making the example look cramped and harder to scan. The user wants blank lines between each example line so the placeholder reads as distinct, separated entries.

### Root Cause
The placeholder attribute on the memo `<textarea>` (line 1586 of `src/webview/implementation.html`) uses a single `&#10;` entity between each example line:

```html
placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
```

A single `&#10;` produces one line break — the lines are adjacent with no blank line between them. To get visual separation (a blank line between entries), each separator needs to be a double newline (`&#10;&#10;`).

### Background
- The Memo tab is a sub-tab inside the Agents panel of the implementation webview.
- The placeholder is purely a UI hint shown when the textarea is empty; it is not saved or processed.
- The actual memo content is loaded from `.switchboard/memo.md` via the `memoLoad` / `memoContent` message round-trip in `TaskViewerProvider.ts` and is unrelated to the placeholder.

## Metadata
- **Tags:** ui, frontend
- **Complexity:** 1/10

## User Review Required
- None. This is a deterministic, self-contained cosmetic copy change with no product decisions to make.

## Complexity Audit

### Routine
- Single-attribute edit to static HTML in one file.
- No logic, no state, no data flow, no migrations.
- Reuses the existing `&#10;` separator pattern already present in the same attribute.

### Complex / Risky
- None. The only conceivable failure is a malformed HTML entity, which is verifiable by inspection.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — static HTML attribute, no runtime timing involved.
- **Security:** None — the change adds only the `&#10;` numeric character entity (LF). No script, no user input, no injection surface.
- **Side Effects:**
  - **Placeholder rendering:** Textarea placeholders honor `&#10;` as a line break in VS Code webviews (Chromium-based). Double `&#10;&#10;` will render a blank line between entries. No CSS change needed.
  - **No effect on saved content:** The placeholder is never written to `.switchboard/memo.md`. Existing user memos are unaffected.
  - **No effect on prompt generation:** `memoGeneratePrompt` reads `textarea.value`, not the placeholder. Empty textarea still yields empty content.
- **Dependencies & Conflicts:** None. The placeholder is self-contained in `implementation.html`; no other file reads or depends on this attribute value.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: effectively none — this is a one-token cosmetic edit (`&#10;` → `&#10;&#10;` at two positions) to a placeholder string that is never persisted or parsed. The only failure mode is a typo in the HTML entity, caught by visual inspection. Mitigation: confirm both separators are doubled and the surrounding placeholder text is byte-identical otherwise.

## Proposed Changes

### File: `src/webview/implementation.html` (line 1586)

Replace the single-newline separators in the placeholder with double-newline separators so a blank line appears between each example entry.

**Before:**
```html
<textarea id="memo-textarea" class="modal-textarea"
          placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
          style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
```

**After:**
```html
<textarea id="memo-textarea" class="modal-textarea"
          placeholder="Bug: login button overlaps on mobile&#10;&#10;Thought: maybe cache the user profile&#10;&#10;Issue: API returns 500 on empty payload..."
          style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
```

- **Context:** The `<textarea id="memo-textarea">` placeholder is the empty-state hint for the Memo capture box, sitting below two `<p>` instruction lines inside `agent-list-memo`.
- **Logic:** No logic. Purely a string-literal edit to a static attribute.
- **Implementation:** Change each `&#10;` separator to `&#10;&#10;`. There are exactly two separators (between Bug→Thought and Thought→Issue). The leading "Bug:" text and trailing "..." are unchanged.
- **Edge Cases:** Ensure no trailing/leading double newline is accidentally added — only the two inter-entry separators are doubled.

## Verification Plan

### Automated Tests
- None applicable. Per session directive, compilation and automated tests are skipped, and there is no test harness covering static placeholder copy. Verification is by manual inspection (below).

### Manual Verification
1. Open the implementation webview in VS Code and switch to the Agents panel → Memo sub-tab.
2. Ensure the textarea is empty (clear it if needed) so the placeholder is visible.
3. Confirm the three example lines now appear with a blank line between each:
   - `Bug: login button overlaps on mobile`
   - *(blank line)*
   - `Thought: maybe cache the user profile`
   - *(blank line)*
   - `Issue: API returns 500 on empty payload...`
4. Confirm that typing into the textarea still replaces the placeholder and that Save / Clear / Copy Prompt / Send to Planner all behave as before.

---

**Recommendation:** Complexity 1/10 → **Send to Intern**.

---

## Reviewer Pass — 2026-06-25

### Stage 1: Grumpy Principal Engineer (adversarial)

Inspection target: `src/webview/implementation.html:1583`.

```html
placeholder="Bug: login button overlaps on mobile&#10;&#10;Thought: maybe cache the user profile&#10;&#10;Issue: API returns 500 on empty payload..."
```

- **[NIT] Entity correctness:** `&#10;` is the numeric character entity for LF (U+000A); doubled to `&#10;&#10;` yields one blank line between entries. No typo (`&#13;`, `&amp;#10;`, etc.). Correct.
- **[NIT] Separator count:** Exactly two inter-entry separators (Bug→Thought, Thought→Issue), both doubled. No leading/trailing double-newline introduced. Leading "Bug:" and trailing "..." byte-identical to the plan's "After" spec.
- **[NIT] No collateral damage:** Surrounding context (instruction `<p>` lines above, `memo-status` span, Clear/Copy/Send buttons below, textarea `id`/`class`/`style`) untouched.
- **[NIT] No stray duplicates:** Single occurrence of the placeholder string in `src/`; no missed twin in a second webview file.

**Verdict:** Zero CRITICAL. Zero MAJOR. Zero actionable findings. Byte-exact execution of the plan.

### Stage 2: Balanced Synthesis

| Finding | Severity | Disposition |
|---|---|---|
| Entity correctness | NIT | Keep — verified correct |
| Separator count / no trailing doubles | NIT | Keep — verified correct |
| No collateral damage to surrounding elements | NIT | Keep — verified intact |
| No stray duplicate placeholders | NIT | Keep — single instance confirmed |

**Fixes applied:** None — no CRITICAL/MAJOR findings.
**Deferred:** Nothing — no remaining work.

### Code Changes Verified

- **File:** `src/webview/implementation.html` (line 1583)
- **Change:** Both inter-entry separators in the `memo-textarea` placeholder changed from `&#10;` to `&#10;&#10;`, producing a blank line between each of the three example entries. Matches the plan's "After" spec byte-for-byte.

### Validation Results

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive; no test harness covers static placeholder copy.
- **Manual inspection:** Performed. The rendered placeholder will display:
  - `Bug: login button overlaps on mobile`
  - *(blank line)*
  - `Thought: maybe cache the user profile`
  - *(blank line)*
  - `Issue: API returns 500 on empty payload...`
- **Downstream impact:** None. The placeholder is never persisted to `.switchboard/memo.md` and is not read by `memoGeneratePrompt` (which reads `textarea.value`, not the placeholder).

### Remaining Risks

None material. The only conceivable failure mode (a malformed HTML entity) was ruled out by inspection.

### Summary

| Severity | Count | Files / Lines |
|---|---|---|
| CRITICAL | 0 | — |
| MAJOR | 0 | — |
| NIT | 4 (all verified-clean, no action) | `src/webview/implementation.html:1583` |

**Fixes applied:** 0 (none required).
**Remaining risks:** None.
