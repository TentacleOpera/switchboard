# Terminals Pane & Viewport Defects

**Complexity:** 5

## Goal

Two live rendering defects in the browser Terminals pane grid: per-pane action buttons condense to single letters based on the layout name instead of measured header width, and the vertical scrollbar disappears in single/solo view mode. (Originally three defects: the `terminals.js` parse error that was keeping CI lint red was verified already fixed at HEAD during improve-feature reconciliation on 2026-08-04 — `node --check` passes, `npm run lint` exits 0 with 0 errors — so that subtask was removed, not implemented.)

## How the Subtasks Achieve This

- **Terminal pane buttons condensed to single letters by layout name, not by actual width**: Removes the layout-name-keyed `isTerseLayout()` condensation from the pane `clear`/`hide`/`pin` button labels (and the matching button-shrink CSS block), letting the pre-existing flex + title-ellipsis degradation handle narrow headers. Restores unambiguous full-word labels on wide monitors.
- **Terminal vertical scrollbar goes missing, especially in single/solo view mode**: Adds a guarded `refreshTerminalScrollbar(entry)` that drives xterm's `Viewport.syncScrollArea()` (with a one-frame `overflowY`-toggle fallback), hooked at the three moments the scroll area can go stale — an actual same-size re-parent, the solo `display:none → grid` flip, and fit-ladder convergence. Closes the gap the fit ladder (cols/rows/canvas verdicts only) leaves open.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. Both subtasks are confined to `src/webview/terminals.js` (+ one CSS block removal in `terminals.html` for the buttons plan) and need nothing from other features. The scrollbar plan's contrast-CSS component was found already landed at HEAD (`terminals.html:940-955`); no cross-feature wait remains.
- **Shipping order within this feature:** (1) pane-buttons subtask FIRST — mechanical, low blast radius, quick UX win; (2) scrollbar subtask SECOND — touches the fit ladder, carries a repro-gate verification step. Both edit `src/webview/terminals.js`, so per the PRD's one-agent-stream-per-file discipline they must be coded SERIALLY by one stream; their surfaces are disjoint (header labels/CSS vs fit ladder/viewport), so the handoff rebase should be conflict-free.
- **Prerequisites / guards:** The scrollbar subtask's step 1 is a reproduction check at HEAD — if the symptom no longer reproduces (the landed fit ladder + contrast CSS may have fixed it), close it as fixed-by-`30d82f8` rather than implementing. Manual verification must cover BOTH hosts (extension webview + `npx switchboard` standalone) since they serve the same panel HTML.
- **Follow-up preserved from the removed parse-error subtask (not part of this feature):** `eslint.config.js` scopes rule blocks to `**/*.ts`, so ~40k lines of `src/webview/*.js` (`planning.js`, `tickets.js`, `terminals.js`, `sharedUtils.js`) get no rule coverage beyond parse errors — the parse error hid behind a CI step literally named "Lint (TypeScript only)". Widening coverage would surface an unmeasured warning backlog; it needs its own plan.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal vertical scrollbar goes missing, especially in single/solo view mode](../plans/feature_plan_20260804092233_terminal-vertical-scrollbar-missing-single-view.md) — **CODER CODED**
- [ ] [Terminal pane buttons condensed to single letters by layout name, not by actual width](../plans/feature_plan_20260804092302_terminal-pane-buttons-condensed-by-layout-name.md) — **CODER CODED**
<!-- END SUBTASKS -->

