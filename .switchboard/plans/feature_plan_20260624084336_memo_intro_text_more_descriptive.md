# Make the Memo Intro Text More Descriptive

## Goal

The Memo sidebar tab's introductory paragraph is too terse and does not explain the full workflow — specifically that each entry becomes a separate plan via Copy Prompt / Send to Planner. Replace it with the user-supplied, more descriptive copy so users understand the one-issue-per-plan contract and the two dispatch paths.

### Problem analysis & root cause

The intro paragraph lives in `src/webview/implementation.html` at lines 1624–1627, directly above `#memo-textarea`:

```html
<p style="font-size: 11px; color: var(--text-secondary); margin: 0 0 4px;">
    Jot down bugs, thoughts, or issues — one per line or paragraph. Each entry becomes a
    <strong>separate issue</strong>. Saved automatically; cleared after Copy Prompt / Send to Planner.
</p>
```

The current wording buries the key outcome ("each entry becomes a separate issue") in a run-on sentence and never states the actual end result: that Send to Planner / Copy Prompt creates **one plan per issue**. Users capturing multiple issues in one memo do not realise each line/paragraph is split into its own plan. The user has supplied exact replacement copy that makes the one-plan-per-issue contract explicit and names both dispatch actions.

The "one plan per issue" contract is enforced in `src/services/TaskViewerProvider.ts` (`_buildMemoPlannerPrompt`, lines 2559–2592), which instructs the planner agent to "Create N plan file(s) total — one per issue" and "Do not combine issues." The intro copy should match that contract.

**Root cause:** copy/UX gap — the original intro was written before the one-plan-per-issue splitting behaviour was finalised and never updated to describe it. This is a static HTML text change only.

## Metadata

- **Tags:** ui, ux
- **Complexity:** 1/10
- **Primary files:** `src/webview/implementation.html`
- **User-facing review items:** Memo tab intro paragraph reads as the new descriptive copy.

## User Review Required

The user supplied the replacement copy verbatim. Two semantic concerns were identified during adversarial review that the user should explicitly decide on before implementation, because they touch the *wording* the user dictated — the implementer must not silently rewrite user-supplied copy:

1. **"Send to an agent via Copy Prompt / Send to Planner" may mischaracterize Copy Prompt.**
   Copy Prompt copies a prompt to the clipboard only (`TaskViewerProvider.ts` lines 9272–9275); it does not dispatch to an agent. Only Send to Planner calls `dispatchCustomPromptToRole` (line 9266). Phrasing both actions as "Send to an agent via…" could imply Copy Prompt also dispatches. Options:
   - (a) Keep the user's verbatim copy as-is (acceptable; the phrase is shorthand and most users will understand Copy Prompt copies).
   - (b) Tweak to e.g. "Send to an agent via Send to Planner, or copy a prompt via Copy Prompt, to create **one plan per issue**."
   - (c) Other user-preferred phrasing.

2. **The "cleared after…" notice was dropped from the new copy.**
   The original copy told users the memo is "cleared after Copy Prompt / Send to Planner." The new copy says "Saved automatically" but does not mention that the memo is cleared on successful dispatch (`TaskViewerProvider.ts` lines 9277–9281 — the memo file is overwritten with `''` and a `memoContent: ''` message is posted on success). Users may be surprised when their text disappears after Send to Planner succeeds. Options:
   - (a) Keep the user's verbatim copy as-is (the status line already says "Memo cleared" after dispatch, so the information is not entirely lost).
   - (b) Re-add a short clause, e.g. "…to create **one plan per issue**. Memo clears on success."
   - (c) Other user-preferred phrasing.

**Default if the user gives no further direction:** implement the user's verbatim copy exactly as supplied (option (a) for both), since the user specified it verbatim and the status line covers the clear-on-success behavior at dispatch time.

## Complexity Audit

### Routine
- Replace the `<p>` inner text at lines 1624–1627 with the user-supplied copy.
- Preserve the existing `style` attribute, element tag, and surrounding markup unchanged.
- Keep a `<strong>` on the key phrase ("one plan per issue") to retain the visual anchor users are accustomed to.

### Complex / Risky
- None. Pure static HTML text; no logic, no state, no migration, no build impact.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The intro paragraph is static markup rendered once; it does not touch the textarea, save timer, or dispatch handlers.
- **Security:** None. No user input is interpolated; the copy is a hardcoded literal. No XSS surface.
- **Side Effects:** None. Changing inner text of a `<p>` has no behavioral side effect. The textarea, Clear/Copy/Send buttons, and `#memo-status` line below are untouched.
- **Dependencies & Conflicts:**
  - No migration — static view text; safe for all ~4,000 installs.
  - No interaction with the memo refresh-overwrite behavior (the textarea reload handler at `implementation.html` line 2687 and the `memoSave`/`memoContent` postMessage flow in `TaskViewerProvider.ts` lines 9231–9238 are not touched).
  - No interaction with the one-plan-per-issue splitting logic (`_parseMemoEntries` / `_buildMemoPlannerPrompt`); this change only describes that logic in prose.
- **Line length / wrapping:** The paragraph uses `font-size: 11px` in the narrow sidebar. The new copy is slightly longer but still a single short paragraph; no layout change needed. Keep the existing `margin: 0 0 4px;` and `color: var(--text-secondary)` styling.
- **Exact copy to use (user-supplied, verbatim):**
  > "Jot down bugs, thoughts, or issues — one per line or paragraph. Saved automatically. Send to an agent via Copy Prompt / Send to Planner to create one plan per issue."

## Dependencies

- None. No `sess_` dependencies — this is a self-contained static text change with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the user-supplied verbatim copy phrases both Copy Prompt and Send to Planner as "Send to an agent via…", which slightly mischaracterizes Copy Prompt (clipboard-only, not a dispatch); (2) the new copy drops the original "cleared after…" notice, so users may be surprised when the memo clears on successful dispatch. Mitigations: surface both concerns in `## User Review Required` for an explicit user decision rather than silently rewriting user-supplied copy; the in-UI status line ("Memo cleared") already partially covers the clear-on-success behavior at dispatch time. Technical risk is otherwise nil — complexity 1/10, no logic, state, or migration.

## Proposed Changes

### `src/webview/implementation.html` — intro paragraph (lines 1624–1627)

**Context:** The `<p>` sits at the top of `#agent-list-memo` > `.memo-tab-content`, directly above `#memo-textarea`. It is static markup; no JS reads or writes it.

**Logic:** None — text-only change.

**Implementation:** Replace the existing `<p>` content with the user-supplied copy, preserving the `style` attribute and tag, and bolding "one plan per issue" to keep the visual anchor:

```html
<p style="font-size: 11px; color: var(--text-secondary); margin: 0 0 4px;">
    Jot down bugs, thoughts, or issues — one per line or paragraph. Saved automatically.
    Send to an agent via Copy Prompt / Send to Planner to create
    <strong>one plan per issue</strong>.
</p>
```

No other lines are touched. The `style` attribute, element tag, and surrounding markup stay identical.

**Edge Cases:**
- If the user picks option (b) or (c) in either User Review Required item, update only the inner text of this same `<p>` accordingly; do not change the tag, style, or location.
- If the user picks option (b) for the "cleared" concern, append the clause inside the same `<p>` before the closing `</p>` — do not add a second element, to keep the single-paragraph layout in the narrow sidebar.

## Verification Plan

### Automated Tests
- None required. This is a static HTML text change with no logic surface; no unit, integration, or e2e test exercises the intro paragraph's wording. Per session directives, the test suite is run separately by the user and is not invoked here.

### Manual Verification
1. **Copy render:** Open the Switchboard sidebar, switch to the Memo sub-tab, and confirm the intro paragraph renders the new copy with "one plan per issue" bolded.
2. **Regression:** Confirm the textarea, Clear/Copy/Send buttons, and `#memo-status` line below are unchanged and still function (type text → autosave fires; Clear empties; Copy Prompt writes clipboard; Send to Planner dispatches and clears on success).
3. **Layout:** Confirm the new (slightly longer) paragraph still fits the narrow sidebar at `font-size: 11px` without overflow or wrapping artifacts.
4. **No compile needed** for a static HTML text change (per session directive, compilation is skipped). `npm run compile` would still succeed if run for a VSIX release build.

---

**Recommendation:** Complexity 1/10 → **Send to Intern**. Resolve the two items in `## User Review Required` first; default to the user's verbatim copy if no further direction is given.
