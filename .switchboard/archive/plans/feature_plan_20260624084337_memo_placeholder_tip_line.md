# Add /memo Skill Tip Line After Examples in the Memo Placeholder

## Goal

After the example lines in the Memo textarea's placeholder (the "suggested text" shown when the field is empty), add a line break followed by a tip telling users they can dictate memo entries to an agent via the `/memo` skill. This surfaces the hands-free capture path to users who otherwise only see the manual typing workflow.

### Problem analysis & root cause

The Memo textarea placeholder is defined in `src/webview/implementation.html` at line ~1628–1630:

```html
<textarea id="memo-textarea" class="modal-textarea"
          placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
          style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
```

The placeholder shows three example entries separated by `&#10;` (newline) entities, but gives no hint that the `/memo` skill exists for dictating entries to an agent instead of typing them manually. Users who would prefer to speak/dictate to an agent never discover the capability from this surface.

**Root cause:** the placeholder was authored to illustrate formatting only; the `/memo` skill (documented in `.agents/workflows/memo.md` and the AGENTS.md skill registry) is a separate capture channel that was never cross-referenced from the manual-entry UI. This is a single-attribute text change to the placeholder.

## Metadata

- **Tags:** ui, ux, feature
- **Complexity:** 1/10
- **Primary files:** `src/webview/implementation.html`
- **User-facing review items:** Memo textarea placeholder now ends with a tip line about the `/memo` skill.

## User Review Required

Yes — the user should visually confirm the tip line renders on its own line after the three examples in the empty Memo textarea, and that the exact wording matches their specification: `Tip: use the /memo skill to dictate memo entries to an agent`.

## Complexity Audit

### Routine
- Append `&#10;Tip: use the /memo skill to dictate memo entries to an agent` to the `placeholder` attribute of `#memo-textarea` in `src/webview/implementation.html` (~line 1629).
- Single-attribute text change; no logic, no state, no JavaScript, no migration.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The placeholder is static HTML rendered by the browser; no async logic, no event handlers, no state mutations involved.
- **Security:** None. The tip text contains no user input, no dynamic interpolation, no script, and no HTML special characters beyond the existing `&#10;` entity pattern. No XSS surface.
- **Side Effects:** None. The `placeholder` attribute is purely presentational (shown only when the textarea is empty). It does not affect the textarea's value, save logic, Copy Prompt, or Send to Planner behavior.
- **Dependencies & Conflicts:**
  - **Placeholder newline encoding.** The existing placeholder uses `&#10;` HTML entities for line breaks (these render as newlines inside the textarea placeholder). Append another `&#10;` before the tip so it appears on its own line after the examples, matching the user's "have a line break then …" requirement.
  - **Placeholder length.** The textarea has `min-height: 240px` and the placeholder is only shown when empty, so a fourth line fits comfortably; no layout impact.
  - **Exact tip wording.** The user specified (verbatim): `Tip: use the /memo skill to dictate memo entries to an agent`. Use this exactly.
  - **No interaction with the intro paragraph.** The intro `<p>` at lines 1624–1626 is a separate element above the textarea; the placeholder is a separate attribute on the textarea and is independent of the intro text and of the reload/save logic.
  - **No migration.** Static view text; safe for all ~4,000 installs.

## Dependencies

- None — this plan is self-contained and has no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: none of substance. The change is a single static-attribute text append with no logic, state, or migration surface. The only structural concern (missing required plan sections and non-compliant metadata tags) is resolved in this improved plan. The "dictate" wording is user-specified verbatim and technically accurate in the broader sense of "to state/prescribe." Mitigations: use `&#10;` entity matching the existing pattern; preserve all other attributes unchanged.

## Proposed Changes

### `src/webview/implementation.html` — `#memo-textarea` placeholder (~line 1628–1630)

**Context:** The Memo textarea is inside the `#agent-list-memo` panel (line 1622). Its `placeholder` attribute currently shows three example entries separated by `&#10;` entities. The `/memo` skill (defined in `.agents/workflows/memo.md`) provides an agent-based capture channel that is not surfaced anywhere in this UI.

**Logic:** None — this is a pure text change to a static HTML attribute.

**Implementation:** Append a `&#10;` entity (line break) followed by the exact tip text to the `placeholder` attribute. The resulting textarea element:

```html
<textarea id="memo-textarea" class="modal-textarea"
          placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload...&#10;Tip: use the /memo skill to dictate memo entries to an agent"
          style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
```

Only the `placeholder` attribute changes; the `id`, `class`, and `style` attributes stay identical.

**Edge Cases:** The `&#10;` entity renders as a newline in textarea placeholders across all major browsers (Chrome, Firefox, Safari, Edge). The tip line will appear on its own line after the three examples. When the user types into the textarea, the entire placeholder (including the tip) disappears as normal.

## Verification Plan

### Automated Tests

No automated tests required or applicable. This is a static HTML attribute text change with no logic, state, or behavior to test programmatically. The test suite (run separately by the user) should continue to pass unchanged since no JavaScript or TypeScript files are modified.

### Manual Verification

1. **Placeholder rendering:** Open the Switchboard sidebar, switch to the Memo sub-tab, and with the textarea empty confirm the placeholder now shows the three example lines followed by a line break and the `Tip: use the /memo skill to dictate memo entries to an agent` line.
2. **Regression:** Type into the textarea and confirm the placeholder disappears as usual; clear the textarea and confirm the placeholder (with the new tip line) reappears.
3. **No compile needed** for a static attribute text change. `npm run compile` is only required when producing a VSIX for release.

---

**Recommendation:** Complexity 1/10 → **Send to Intern**

---

## Reviewer Pass (2026-06-24)

### Stage 1 — Grumpy Principal Engineer

*"A placeholder text append. My expertise is being wasted, but fine — I'll waste it thoroughly."*

**NIT-1 — `src/webview/implementation.html:1630` — "dictate" is a stretch, but you documented it.**
The tip says "dictate memo entries to an agent." The `/memo` skill (per `.agents/workflows/memo.md`) appends user messages to `.switchboard/memo.md` — it's a capture/append channel, not a speech-to-text dictation interface. "Dictate" in the sense of "to state/prescribe" is technically defensible, but a user reading "dictate" in a textarea placeholder will likely think voice input. The plan's Adversarial Synthesis already acknowledged this wording is user-specified verbatim. It's the user's word. Not changing it.

**NIT-2 — `src/webview/implementation.html:1630` — `&#10;` entity correctness (verified, non-issue).**
The tip is appended with a single `&#10;` before "Tip:", producing one newline. The plan says "a line break followed by a tip" — a single newline satisfies this (the tip appears on its own line immediately after the last example). A double `&#10;&#10;` would produce a blank line separator, which the plan did not request. The single-entity approach matches the existing pattern used between the three examples. Correct.

**No CRITICAL findings. No MAJOR findings.** The implementation is a faithful, byte-accurate execution of the plan. The `placeholder` attribute now ends with `...&#10;Tip: use the /memo skill to dictate memo entries to an agent"`. The `id`, `class`, and `style` attributes are unchanged. The tip wording matches the user's verbatim specification exactly.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Verdict |
|:---|:---|:---|
| NIT-1: "dictate" wording may imply voice input | NIT | **Keep as-is.** User-specified verbatim. The plan's Adversarial Synthesis already addressed this. No silent rewrite of user-supplied copy. |
| NIT-2: `&#10;` entity count (single vs. double) | NIT | **Non-issue.** Single `&#10;` matches the existing pattern and the plan's "line break" requirement. Verified correct. |

**Fixes applied:** None. No CRITICAL or MAJOR findings. The implementation matches the plan exactly.

### Verification Results

- **Static HTML attribute text change** — no compile needed (per session directive, compilation skipped). `npm run compile` would succeed for a VSIX release build.
- **No automated tests** applicable (per session directive, test suite run separately by user).
- **Grep verification:** Exactly one `#memo-textarea` element in `src/webview/implementation.html` (line 1629). No duplicate or stale placeholder copies elsewhere. The 6 other `memo-textarea` matches are JS references (`getElementById`), not element definitions — unaffected by the attribute change.
- **Git diff verification:** `git diff HEAD~1 -- src/webview/implementation.html` confirms the only in-scope change is the `placeholder` attribute at line 1630 — the `&#10;Tip: use the /memo skill to dictate memo entries to an agent` suffix was appended. The `id`, `class`, and `style` attributes are unchanged.
- **Out-of-scope note:** The same commit (`b97ee33`) bundled unrelated changes (intro `<p>` text swap, `memoDirty` flag, `switchAgentTab` isChanging guard, `memoContent` race buffer) belonging to separate plans. Those changes are out of scope for this review and were not assessed here.

### Files Changed

- `src/webview/implementation.html` — line 1630 (`placeholder` attribute of `#memo-textarea` extended with `&#10;Tip: use the /memo skill to dictate memo entries to an agent`).

### Remaining Risks

1. **"Dictate" wording (NIT-1):** Low risk. Users may interpret "dictate" as voice input rather than agent-based capture. Mitigated by the `/memo` skill's actual behavior being self-evident once invoked. Resolvable only by the user choosing different wording.
2. **No technical risk.** No logic, state, migration, or build surface touched. The `placeholder` attribute is purely presentational and only visible when the textarea is empty.
