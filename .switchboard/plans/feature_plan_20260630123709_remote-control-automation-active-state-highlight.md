# Highlight Active State for Remote Control & Automation Buttons on Kanban Board

## Goal

Make the **Start/Stop Remote Control** and **Automation** toggle buttons on the kanban board visually distinct when they are ON, so the user can tell at a glance whether remote control or the automation engine is currently running.

### Problem
The **Start/Stop Remote Control** button (`#btn-remote-control`) and the **Automation** button (`#btn-autoban`) in the kanban board's control strip look visually identical whether they are ON or OFF. The user cannot tell at a glance whether remote control or the automation engine is currently running, which leads to confusion (e.g. accidentally leaving automation running, or clicking "start" when it is already started).

### Background
Both buttons are `.strip-icon-btn` elements in the top control strip of `src/webview/kanban.html`. The JS already toggles an `is-active` class to reflect the running state:

- `applyRemoteControlButtonState()` (kanban.html:6897-6900) toggles `is-active` on `#btn-remote-control` based on `remoteControlActive`.
- `updateAutobanButtonState()` (kanban.html:4966-4977) toggles `is-active` on `#btn-autoban` based on `autobanConfig.enabled`, and also swaps the tooltip/alt text.

So the **state is already tracked correctly in JS** — the bug is purely visual: the `.strip-icon-btn.is-active` CSS rule does not produce a perceptible difference from the resting state.

### Root Cause
The base `.strip-icon-btn` style (kanban.html:517-530) is:
```css
.strip-icon-btn {
    border: 1px solid transparent;
    background: var(--panel-bg2);
    box-shadow: none;          /* (implicit, none set at rest) */
}
```

The `.strip-icon-btn.is-active` rule (kanban.html:567-580) is:
```css
.strip-icon-btn.is-active {
    border-color: transparent;
    background: transparent;   /* actually REMOVES the resting bg tint */
    box-shadow: none;
    opacity: 1;
}
.strip-icon-btn.is-active img {
    filter: brightness(1.2);   /* the ONLY visible cue — far too subtle */
}
```

The active state sets `background: transparent` and `box-shadow: none`, making it *less* visible than the resting state (which has a `--panel-bg2` background). The only differentiator is `filter: brightness(1.2)` on the icon image — a ~20% brightness bump that is essentially imperceptible, especially on the small 18px icons. The same problem is mirrored in the `.kanban-sub-bar .strip-icon-btn.is-active` rule (kanban.html:351-361) and in the Claudify theme overrides (kanban.html:74-82), which only bump the icon to a "brighter grey".

There is no border, no background tint, and no glow to signal "this is ON". Compare with `.kanban-sub-bar .strip-icon-btn.is-paused` (kanban.html:368-374), which correctly uses an orange background tint + orange icon color for its paused state — that is the pattern to follow.

## Metadata
- **Tags:** `ui`, `ux`, `bugfix`
- **Complexity:** 2/10 — CSS-only change to existing rules; no logic, no new state, no migration.

## User Review Required
Yes — visual design choices (teal tint opacity, border prominence) should be confirmed by the user during manual testing via the installed VSIX. No code-level review gate is needed beyond the manual visual checks in the Verification Plan.

## Complexity Audit

### Routine
- CSS-only restyle of an existing `.is-active` class that is already toggled at the correct times by verified JS functions.
- No new DOM elements, no new event handlers, no backend changes, no data migration.
- The `--glow-teal` variable already resolves to `none` under `body.theme-claudify` (kanban.html:39), so the glow degrades gracefully without additional conditional logic.
- `color-mix(in srgb, ...)` is already used extensively throughout the stylesheet (e.g. lines 533, 535, 570, 574), so the webview rendering engine supports it — no compatibility risk.
- The change follows an existing pattern: `.kanban-sub-bar .strip-icon-btn.is-paused` (kanban.html:368-374) already uses a background tint + colored icon for its state, which is the exact pattern being adopted.

### Complex / Risky
- **Specificity fragility (low risk):** `.controls-strip .strip-icon-btn` (kanban.html:543-550) sets `border: 1px solid transparent` with specificity (0,2,0) — equal to `.strip-icon-btn.is-active` (0,2,0). The `is-active` rule wins only by virtue of later source order (line 567 > line 543). If someone ever moves the `.is-active` rule above the `.controls-strip` rule, the teal border would vanish silently. This is acceptable today (source order is stable) but should be noted.
- **Claudify icon-filter override (no risk, documentation gap):** The new `filter: brightness(1.25)` on `.strip-icon-btn.is-active img` (specificity 0,2,1) is overridden under Claudify by `body.theme-claudify .strip-icon-btn.is-active img` (kanban.html:74-82, specificity 0,3,0) which sets `filter: brightness(0) invert(72%)`. This means the `brightness(1.25)` line is effectively dead code under Claudify — the visual cue under Claudify relies solely on the border + background tint, not the icon filter. This is the intended behavior (consistent with the plan's "border + tint only under Claudify" statement) but should be documented explicitly so future maintainers don't expect the icon filter to apply.

## Edge-Case & Dependency Audit
- **Affected buttons**: The `.strip-icon-btn.is-active` class is shared by several toggles in the control strip: `#btn-autoban` (automation), `#btn-remote-control` (remote control), `#btn-cli-triggers` (CLI triggers), `#btn-epic-ultracode`, `#btn-epic-goal`, `#btn-collapse-coders` (toggle collapsed coder columns view, kanban.html:2496), and the sub-bar `#btn-pause-autoban-timer`. Giving `is-active` a clear highlight improves ALL of these consistently — this is desirable, not a side effect, since they all share the same "toggle is on" semantics. *(Clarification: `#btn-collapse-coders` was not listed in the original plan but is a `.strip-icon-btn` that toggles `is-active`/`is-off` oppositely at kanban.html:7347-7348 — it benefits from the same fix.)*
- **`.is-off` must remain distinct**: `is-off` (kanban.html:582-589) greys out + dims the icon for disabled toggles. The new `is-active` style must not collide with `is-off`. A button should never carry both classes simultaneously (the JS uses `is-active` for "on" and `is-off` for "off"), but to be safe the `is-active` rule should be ordered after / have higher specificity than `is-off` so an "on" button never looks greyed-out.
- **Claudify theme**: `body.theme-claudify` intentionally kills neon glow (`--glow-teal: none`, kanban.html:39). The fix must rely on `var(--glow-teal)` (which is already `none` under Claudify) rather than a hardcoded glow, so the highlight degrades gracefully to a border + background tint under Claudify. The Claudify icon-filter rules (kanban.html:74-82) only adjust image brightness — they do not touch border/background, so adding border/background to `.is-active` will show through correctly under both themes.
- **`kanban-icons-colour` opt-in**: When colour icons are enabled under Claudify (kanban.html:108-130), the active icon already gets a brighter terracotta filter. Adding a border/background tint complements this; no conflict.
- **Sub-bar buttons**: The `.kanban-sub-bar .strip-icon-btn.is-active` rule (kanban.html:351-361) has the same invisible-active problem and must be updated in parallel for consistency (the pause button is the main consumer).
- **`is-paused` vs `is-active` transition**: When `#btn-pause-autoban-timer` switches from `is-active` (not paused) to `is-paused` (paused), the JS toggles both classes oppositely (kanban.html:4990-4991). The `is-paused` rule (kanban.html:368-374) sets an orange background tint but does NOT set `border-color`, so when `is-active` is removed the border reverts to the base `.kanban-sub-bar .strip-icon-btn` transparent border (kanban.html:339). The orange background tint alone is the visual cue for paused — this is the existing, correct behavior and is not disrupted by the change.
- **No `window.confirm` / dialogs**: This change adds no confirmation gates (per CLAUDE.md hard rule).

## Dependencies
- None — this is a self-contained CSS-only change with no prerequisite plans or sessions.

## Adversarial Synthesis
Key risks: (1) CSS specificity fragility — `.is-active` border wins over `.controls-strip .strip-icon-btn` only by source order, not by specificity; (2) the `filter: brightness(1.25)` line is dead code under Claudify due to higher-specificity theme overrides; (3) the plan's original button list missed `#btn-collapse-coders`. Mitigations: source order is stable and verified correct today; the Claudify no-op is harmless (border + tint carry the cue under Claudify); the missing button is now documented and benefits from the same fix. The change is low-risk, CSS-only, and follows an existing pattern (`.is-paused`).

## Proposed Changes

### File: `src/webview/kanban.html`

#### Change 1 — Make `.strip-icon-btn.is-active` visually distinct (main control strip)

Replace the current invisible-active rule at kanban.html:567-580:

```css
/* BEFORE */
.strip-icon-btn.is-active {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    opacity: 1;
}
.strip-icon-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
    box-shadow: var(--glow-teal);
}
.strip-icon-btn.is-active img {
    filter: brightness(1.2);
}
```

with a clearly highlighted active state:

```css
/* AFTER */
.strip-icon-btn.is-active {
    border-color: var(--accent-teal);
    background: color-mix(in srgb, var(--accent-teal) 18%, transparent);
    box-shadow: var(--glow-teal);
    opacity: 1;
}
.strip-icon-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 26%, transparent);
    box-shadow: var(--glow-teal);
}
.strip-icon-btn.is-active img {
    filter: brightness(1.25);
}
```

This gives an "on" toggle a teal border, a persistent teal background tint, and the standard teal glow (which is already `none` under Claudify, so Claudify gets border + tint only — no neon). The hover state deepens the tint.

> **Clarification — Claudify icon filter:** The `filter: brightness(1.25)` line on `.strip-icon-btn.is-active img` has specificity (0,2,1). Under Claudify, `body.theme-claudify .strip-icon-btn.is-active img` (kanban.html:74-82, specificity 0,3,0) overrides it with `filter: brightness(0) invert(72%)`. This is expected and harmless — under Claudify the visual cue is carried by the border + background tint (which use `--accent-teal` = `#D97757` terracotta), not the icon filter. The `brightness(1.25)` line only takes effect under the default cyber theme.

#### Change 2 — Mirror the highlight in the sub-bar variant

Replace kanban.html:351-361:

```css
/* BEFORE */
.kanban-sub-bar .strip-icon-btn.is-active {
    background: transparent;
    box-shadow: none;
}
.kanban-sub-bar .strip-icon-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 10%, transparent);
    box-shadow: var(--glow-teal);
}
.kanban-sub-bar .strip-icon-btn.is-active img {
    filter: brightness(1.2);
}
```

with:

```css
/* AFTER */
.kanban-sub-bar .strip-icon-btn.is-active {
    border-color: var(--accent-teal);
    background: color-mix(in srgb, var(--accent-teal) 18%, transparent);
    box-shadow: var(--glow-teal);
}
.kanban-sub-bar .strip-icon-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 26%, transparent);
    box-shadow: var(--glow-teal);
}
.kanban-sub-bar .strip-icon-btn.is-active img {
    filter: brightness(1.25);
}
```

#### Change 3 — Ensure `is-active` wins over `is-off` (defensive ordering)

The `is-off` rule (kanban.html:582-589) sets `opacity: 0.5` and greys the icon. Since a button should never be both active and off simultaneously, no runtime conflict is expected, but to be defensive, add an explicit `is-active.is-off` disambiguator is unnecessary — instead, simply confirm via testing that an active button never has `is-off` applied. No code change required here beyond verifying the JS callers (`updateCliToggleUi` at 4196-4202, `updateEpicWorkflowToggleUi` at 4207-4218, `updateComplexityRoutingToggleUi` at 4231-4236, and the `#btn-collapse-coders` handler at 7343-7363) toggle BOTH classes oppositely, which is correct. The remote-control and autoban buttons only toggle `is-active` (never `is-off`), so they are already correct.

#### No JS changes required
`applyRemoteControlButtonState()` (kanban.html:6897-6900) and `updateAutobanButtonState()` (kanban.html:4966-4977) already toggle `is-active` correctly. No JS edits.

## Verification Plan

### Automated Tests
No automated tests required — this is a pure CSS visual change with no logic, state, or data-flow impact. The JS state-tracking is already verified correct and unchanged. Per session directives, compilation and automated test suites are skipped; the user will run the test suite separately.

1. **Build**: `npm run compile` (webpack) — confirm no CSS/JS syntax errors introduced. (Note: `dist/` is not used during dev testing; this is just a syntax gate.) *(Skipped per session directive — compilation is not run in this session.)*
2. **Manual test via installed VSIX** (per CLAUDE.md — testing is done via installed extension, not `dist/`):
   - Open the Switchboard kanban board.
   - **Automation button**: Click `#btn-autoban` to start automation. Confirm the button now shows a teal border + teal background tint + glow (or border + tint only under Claudify). Click again to stop; confirm it reverts to the plain resting state.
   - **Remote Control button**: Click `#btn-remote-control` to start. Confirm the same active highlight appears. Click to stop; confirm it reverts.
   - **CLI Triggers / Epic Ultracode / Epic Goal / Collapse Coders**: Toggle each on; confirm the same active highlight. Toggle off; confirm revert. Verify `is-off` (greyed/dimmed) still looks distinct from `is-active` (teal-tinted).
   - **Pause timer button** (sub-bar): With automation running, confirm `#btn-pause-autoban-timer` shows the active highlight; click to pause and confirm it switches to the orange `is-paused` style (kanban.html:368-374), not the teal active style.
3. **Theme check**: Toggle the Claudify theme and the `kanban-icons-colour` setting. Confirm the active highlight reads as border + background tint (no neon glow) under Claudify, and as full teal border + tint + glow under the default cyber theme.
4. **No regressions**: Confirm resting (off) buttons still look unchanged — the change only affects the `.is-active` selector, not the base `.strip-icon-btn` rule.

---

**Recommendation:** Complexity 2/10 → **Send to Intern** — this is a routine, CSS-only change to two existing rule blocks with no logic, no new state, and no migration. The pattern already exists in the codebase (`.is-paused`).
