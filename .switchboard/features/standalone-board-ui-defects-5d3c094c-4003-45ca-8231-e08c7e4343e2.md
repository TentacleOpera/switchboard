# Standalone Board UI Defects

**Complexity:** 4

## Goal

Consolidated 2026-09-10: four self-contained board and shell defects in the standalone host.

## How the Subtasks Achieve This

- **The Copy-Prompt Button Keeps the Label of the Column the Card Just Left**: Fixes three defects in `kanban.html` — the copy-prompt button's label (and `data-copy-label` attribute) go stale after a card move because `moveCardElements` updates `data-column` but not the label; a failed clipboard copy silently advances the card because the `externalAutomationPrompt` handler doesn't handle the promise; and the card advance is optimistic (fires at click time) rather than conditional on the copy result. Contributes to the feature's goal by making the copy-prompt button's label and behavior always match the card's current position in both hosts.
- **The Backlog View Cannot Be Exited in Standalone**: Investigates whether the backlog-view toggle still fails to repaint in standalone. The original root cause (missing `postMessage` wiring) was wrong — the broadcaster → WS route is wired. Adds a defence-in-depth fix: the `updateBoard` handler calls `renderColumns()` when `showingBacklog` changes, so a state change never leaves the column showing the wrong mode regardless of transport. Contributes by ensuring display-mode toggles repaint in both hosts.
- **The Startup Curtain Lifts Onto the Shell Banner It Exists to Hide**: Fixes the startup curtain lifting during the 2-second silence between the shell prompt and the CLI's first paint. The quiet timer (`CURTAIN_QUIET_MS = 1200`) fires before the CLI starts, exposing the raw shell banner the curtain exists to hide. Adds a family-derived minimum age (from the per-CLI first-readiness ceilings in `clearReadiness.ts`) so the curtain cannot dismiss before the CLI could plausibly have painted. Contributes by keeping the curtain up until the CLI has actually painted, not just until output went quiet.

## Dependencies & sequencing

- Subtasks are independent and can land in any order. The cross-subtask reconciliation audit found no shared symbols: the Copy-Prompt and Backlog View subtasks both touch `src/webview/kanban.html` but in different `case` branches and different functions (no overlap, no contradiction).
- No prerequisites or guards beyond the standard both-hosts rule (every change must land in both the extension and the standalone host).

## Team Dispatch Instructions

### The Copy-Prompt Button Keeps the Label of the Column the Card Just Left

- **Seat:** Coder (Complexity 4)
- **Acceptance:**
  - A card dragged New → Planned → New shows the correct label at each position with no reload (standalone and extension).
  - A failed copy leaves the card in its column and reports the failure (does not advance).
  - The `externalAutomationPrompt` handler at `:12500` handles the `sbCopyToClipboard` promise (no bare try/catch).
  - The `data-copy-label` attribute is updated alongside `textContent` in `moveCardElements` (the "Copied!" reset does not re-stale the label).
  - The regression test guarding the inline `copyLabel` block is updated and passes.
- **Must not touch:** `src/webview/clipboardFallback.js` (referenced for context, not changed). No confirmation dialogs (per AGENTS.md).

### The Backlog View Cannot Be Exited in Standalone

- **Seat:** Intern (Complexity 3)
- **Acceptance:**
  - Toggling to Backlog and back repaints the column both ways in standalone and the extension, with no reload.
  - Toggling with no cards on the board still repaints (does not depend on the card signature).
  - The DISPATCH display mode toggles correctly in both hosts.
  - The `updateBoard` handler calls `renderColumns()` when `showingBacklog` changes (gated on the value actually changing, not unconditional).
- **Must not touch:** Do not make the client flip its own `showingBacklog` flag (the host owns the state). Do not add a `postMessage` route to the browser — it already exists via the broadcaster. The original bug no longer reproduces; Change 2 (defence-in-depth) is the only code change.

### The Startup Curtain Lifts Onto the Shell Banner It Exists to Hide

- **Seat:** Intern (Complexity 3)
- **Acceptance:**
  - On a Devin seat, the curtain is still up at 4.5 s and the shell banner is never visible; it lifts once the CLI has painted and gone quiet.
  - On a Claude seat, the curtain respects the 8 s ceiling (families genuinely differ, not one number).
  - A seat whose CLI exits immediately dismisses on the exit path, not after the family ceiling.
  - The webview reads the readiness ceilings from an injected `data-*` attribute (no second copy in `src/webview/`).
  - A fast Devin boot (CLI settles at ~5 s) does not sit behind the curtain for 20 s.
- **Must not touch:** `CURTAIN_MAX_MS = 15000` (not in scope). Do not extend the minimum age to seats with no startup command (pure added latency). Do not duplicate the `clearReadiness.ts` constants in the webview (inject them as a `data-*` attribute instead). Option (a) chosen: gate the minimum age on pre-CLI silence only — the curtain lifts at ~5 s on a fast Devin boot, not 20 s.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Copy-Prompt Button Keeps the Label of the Column the Card Just Left](../plans/copy-prompt-button-keeps-the-label-of-the-column-the-card-left.md) — **PLAN REVIEWED** — ID: 14776318-955f-4596-b331-07e72e72f69a
- [ ] [The Backlog View Cannot Be Exited in Standalone](../plans/backlog-view-cannot-be-exited-in-standalone.md) — **PLAN REVIEWED** — ID: 89e874de-4487-4646-8648-31715c714087
- [ ] [The Startup Curtain Lifts Onto the Shell Banner It Exists to Hide](../plans/the-startup-curtain-lifts-onto-the-shell-banner-it-exists-to-hide.md) — **PLAN REVIEWED** — ID: d1245642-3c27-4bb3-9625-b1457db64a11
<!-- END SUBTASKS -->

