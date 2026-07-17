# Verb Engine — Project Panel (Planning Burndown + Browser)

**Complexity:** 7

## Goal

Make the Project panel (PlanningPanelProvider / project.html) host-agnostic (·6 burndown) and serve it in a browser (headless Project panel) — the planning/management half of the standalone cockpit. Where the Kanban board covers "see and move the board", this feature covers "author plans, PRDs, and tickets" without VS Code.

## How the Subtasks Achieve This

- **Verb Engine · 6 — PlanningPanelProvider Burndown (172 arms)**: migrates the Project panel's arms in place onto the seams so `project.html`'s verbs run with no VS Code. This is the **largest and least-migrated** provider (~26 seam-calls against 259 vscode refs today) — the single biggest chunk of the whole verb engine.
- **Headless Project Panel (Browser)**: serves `project.html` in a browser by **reusing** the Kanban board's transport shim (verb-fetch out / wsHub renders in), static asset serving, Host-header+token→cookie auth, and the serve-time `data-host-capabilities` hook. It capability-gates the panel's terminal verbs (`openArchitectTerminal`, `sendArtifactPromptToTerminal`, …) and keeps the copy-prompt + doc/PRD/constitution/ticket surface. Wiring + verification, not new infrastructure.

## Dependencies & sequencing

- **Cross-feature:** depends on **·1 Foundations** (Core feature — already built). The Headless Project Panel also **reuses** the Standalone Headless **B2** browser machinery (shim/serving/auth) and, for a no-VS-Code run, **B1** (headless host).
- **Internal order (hard):** **·6 must land before the Headless Project Panel.** The panel's arms crash in a headless process until ·6 seam-injects them — exactly the reason the board needed ·4. The panel plan is a no-op until then.
- **Guards:** byte-compatibility on the shipped Project panel; ·6 acceptance = arms under a test seam bundle with no `vscode`. Verify the doc-editor / live-markdown / ticket round-trips explicitly (172 arms is real surface, even though the shim is generic).
- **Scope note:** adding the Project panel to the browser is deliberately *not* a freebie — it pulls ·6 (172 arms) onto the path. That was the accepted tradeoff for making the planning/management workflow usable without VS Code.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Verb Engine · 6 — PlanningPanelProvider Burndown (172 arms)](../plans/a2b-verb-engine-06-planning-panel.md) — **CODE REVIEWED**
- [ ] [Headless Project Panel (Browser)](../plans/headless-project-panel-browser.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings (feature)

Reviewed both subtasks in-place 2026-07-17. **·6 Planning Burndown:** arm-level host coupling is genuinely migrated behind `this._seams()`, shims deleted, dispatch allowlist+schema-gated (176 verbs); the return-in-body contract is the one material deviation (arms still push over WS instead of returning data in the HTTP body — browser unaffected, external HTTP read-agents affected). **Headless Project Panel:** routing/serving/auth/transport-shim/capability-hook all wired; applied one MAJOR fix — capability-gating now hides the Project panel's four AI-builder terminal-dispatch buttons when `terminalDispatch:false` (was a board-only no-op) — in `src/webview/transport.js`. **Top remaining risk:** the standalone `planningVerb` is a stub (`bootstrap.ts:537`), so `npx switchboard` serves the panel but no verb functions; combined with `serveStatic` being standalone-only (not extension-hosted), the browser Project panel has no functional home until the documented B1 final-wiring lands. Only `src/webview/transport.js` changed during review; compile/tests skipped per session directives.

