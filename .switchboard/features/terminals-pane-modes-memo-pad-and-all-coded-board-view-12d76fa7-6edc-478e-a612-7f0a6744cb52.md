# Cockpit Memo Modal and All-Coded Board View

**Complexity:** 4

## Goal

Two independent reach-and-visibility improvements to the browser cockpit, so the operator can act on the whole board and capture a thought without leaving the screen they are on.

- The **Memo** rail icon opens the existing memo screen as a **modal over the current panel** instead of switching the content area to it, so the memo is reachable from anywhere — including mid-session with the Terminals grid up.
- The Terminals kanban pane's column picker gains an **ALL CODED** aggregate option that unions the coder columns client-side, because the server deliberately refuses `AUTOCODE` as a column ref.

The problem they share is reach: the cockpit's two most useful surfaces are each one screen away from where the work happens. Capturing an observation meant abandoning the panel you were driving, and a kanban pane could only ever watch a third of the work that is out for coding.

> **Scope change (2026-08-08).** The memo half was originally specified as a **memo pane mode inside the Terminals grid** — widening `paneModes` to a third value, reclassifying ~18 hardcoded `=== 'kanban'` comparisons, and re-implementing the whole memo editor (load/save/clear/send/flush/status + its own workspace picker) inside `terminals.js`. That was rejected as too clunky: the cost was almost entirely in re-implementing a screen that already exists, plus the flush-before-teardown discipline a pane-mounted editor forces on five separate destruction paths. The replacement reaches the same goal by presenting the **already-mounted** `/memo` iframe as an overlay — no new memo code, no changes to `memo.html`/`memo.js`, and no teardown risk, because the frame is only ever hidden and never destroyed. Feature complexity dropped 6 → 4; the memo subtask dropped 6 → 3.

## How the Subtasks Achieve This

- **Open the Memo as a Shell Modal Instead of a Full-Screen Panel**: The shell already mounts every panel as a live same-origin iframe up front and merely toggles `.is-active` to switch between them, so the memo is loaded and running the whole time — it is just unreachable without replacing the content area. This adds a `presentation: 'modal'` marker to the panel manifest, a modal host inside `#content` (built in JS, so `shell.html`'s asserted body markup is untouched), and a branch in `selectPanel` that intercepts modal ids before they can become the active panel. Close on ×, backdrop, Escape (relayed from inside the same-origin frame) or by selecting another panel. Open and close are display toggles only — the frame is never removed or re-`src`'d, so the memo's WebSocket, its 800 ms autosave debounce and any unsaved text survive a close/open cycle. This is the "capture an observation without leaving the cockpit" half.
- **Add an "All Coded" Aggregate Option to the Terminals Kanban-Pane Column Picker**: Appends a synthetic `CODED_AUTO` / "ALL CODED" entry to the kanban pane's column picker, derived from the live structure's `kind === 'coded'` columns rather than hardcoded ids, so a custom coded column joins the union automatically. Because `CODED_AUTO` exists nowhere server-side and `getBoardCards` filters columns with a literal `===` compare, the aggregate fetch omits `column` entirely and filters client-side — sending the synthetic id would silently return an empty list that reads as "nothing is out for coding". Adds a per-row column chip (and `c.column` to the body signature so the chip stays fresh) to keep the merged list legible. This is the "see all the coding work at once" half.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. Nothing from another feature must land first.
- **Order within this feature: none — the two subtasks are fully independent and may run in parallel, in either order.** They now share no file:
  - Memo modal → `src/webview/shell.js`, `src/webview/shell.html`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts` (one type widening), plus a new `src/test/shell-modal-panel-contract.test.js`.
  - ALL CODED → `src/webview/terminals.js`, `src/webview/terminals.html`.

  The previous revision's strict serialisation (ALL CODED first, memo second, never concurrent, plus a shared `showOnlyPaneModeButton` extraction) existed **only** because the memo half used to edit `terminals.js`. With the pane design gone, the PRD's one-stream-per-file rule is satisfied by construction and the extraction is moot.
- **Reconciled shared surfaces:** none remain. The two plans have a disjoint file set, so there is nothing left to reconcile.
- **Prerequisites / guards:** the extension (or `npx switchboard`) must be running so the panels can reach `/kanban/verb/*` and `/memo/verb/*` — all already-wired verbs. No new verb, no `protocol-catalog.json` regeneration (`/panels` is already catalogued as a GET route; the catalog records routes, not response fields), no new setting, no default-OFF flag, and no migration: the panel manifest is computed per request and never persisted, and `terminals.kanbanPaneColumn` degrades harmlessly on an older build.

## Review Findings

Reviewer pass 2026-08-11 over both subtasks, in-place, no worktree. One CRITICAL in the ALL CODED half — the `CODED_AUTO` collapse-reset (`terminals.js:4076`) could not distinguish "the coder union collapsed" from "the structure has not loaded yet", so it wiped and re-persisted the operator's saved aggregate selection on every reload; fixed by gating on a populated `kanbanColumnsCache`, plus a MAJOR in the same block (stale aggregate rows left under the new heading, and the compensating refetch swallowed by the in-flight guard). One MAJOR each in the memo half — the new `shell-modal-panel-contract.test.js` was red on arrival (`/\.remove\(/` matched `classList.remove`) and was invoked by nothing, so it was repaired and wired into `package.json` + `.github/workflows/integration-tests.yml`. Files changed by the review: `src/webview/terminals.js`, `src/test/shell-modal-panel-contract.test.js`, `src/test/browser-kanban-pane-order.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Validation: 13 contract suites green (shell-modal 6/6, shell-terminal-strip 40/40, browser-kanban-pane-order 9/9) and `tsc --noEmit` clean apart from 5 pre-existing TS2835 dynamic-import errors present verbatim at HEAD; two memo suites (`memo-browser-clear-and-copy`, `memo-panel-workspace-binding`) are red at HEAD on `memo.js` / the `memoGeneratePrompt` arm, neither of which this feature touches.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Open the Memo as a Shell Modal Instead of a Full-Screen Panel](../plans/feature_plan_20260807090100_terminals-pane-memo-mode.md) — **CODE REVIEWED**
- [ ] [Add an "All Coded" Aggregate Option to the Terminals Kanban-Pane Column Picker](../plans/feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

