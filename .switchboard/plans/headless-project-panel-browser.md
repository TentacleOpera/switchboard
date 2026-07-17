# Headless Project Panel (Browser)

## Goal

Serve the **Project panel** (`project.html` / `PlanningPanelProvider` — PRD, constitution, plan-doc and dev-doc editors, tickets, imported docs) as a live web page the same way the Kanban board is, so the **planning/management half** of Switchboard is usable in a browser with no VS Code. Today only the Kanban board is planned for the browser; this plan is the deliberate second browser panel, chosen because the Project panel is where plans, PRDs, and tickets are authored — the natural companion to a browser board for a Claude-Desktop / GUI-agent workflow.

**Problem & background.** `project.html` is coupled to the VS Code host through the same single seam the board was: `acquireVsCodeApi()` + `postMessage`/inbound-`message`. The generic verb dispatch already reaches its ~172 verbs over HTTP with results in the body. What is missing for a *headless* Project panel is (a) its arms must run without VS Code — that is the **·6 Planning burndown** (seam-injection of `PlanningPanelProvider`'s arms), and (b) the browser transport + serving + auth machinery, which already exists for the board.

**Root cause of the gap.** Two prerequisites, one per axis:
- **Host-agnosticism (·6):** un-migrated Planning arms call `vscode.*` directly; invoked in a headless process they crash. The Project panel cannot go headless until ·6 seam-injects its arms.
- **Browser transport (reuse):** the two-channel shim (verb-fetch out / wsHub renders in), static asset serving, the Host-header + token→cookie auth, and the serve-time `data-host-capabilities` attribute — all built for the Kanban browser board (Standalone B2). This panel reuses that machinery; it does not reinvent it.

## Implementation Steps

1. **Reuse the transport shim.** Load the same `acquireVsCodeApi()`-compatible shim (Standalone B2 `transport.js`) in `project.html`'s bootstrap first — commands map to `POST /planning/verb/<type>`; renders arrive over the wsHub (which already broadcasts the Project panel's inbound vocabulary via the same `BroadcastHub` fan-out). Zero per-call-site rewrites.
2. **Serve `project.html` + assets.** Add the Project panel to the browser static-serving route set (same content-type handler + `{{...}}` placeholder replacement + browser CSP `connect-src 'self'` as the board). Serve from the same resolved path to avoid a forked copy.
3. **Capability-gate the Project panel's CLI/terminal paths.** `PlanningPanelProvider` has terminal-coupled verbs (`openArchitectTerminal`, `sendArtifactPromptToTerminal`, `sendHtmlTweakPrompt`, `serveAndOpenHtml`, the AI-builder invocations that dispatch to terminals). Read the `data-host-capabilities` flag and, when `terminalDispatch` is false, hide those; keep the copy-prompt variants (`copyArchitectPrompt`, `copyArtifactPrompt`, `copyRefinePrompt`, `copyPrdBuildPrompt`, etc. — they return the prompt in the body → browser copies client-side), the doc/plan/PRD/constitution editors, ticket sync, and imports. Default any dispatch to copy mode.
4. **Read-only-first is optional here** — the Project panel is mostly authoring/config, not dispatch, so most of its surface is safe to enable immediately once arms are host-agnostic.

## Metadata

- **Tags:** frontend, api, ui, refactor
- **Complexity:** 6

## User Review Required

- None — scope mirrors the Kanban browser board, applied to the Project panel.

## Complexity Audit

### Routine
- Loading the existing shim in `project.html`'s bootstrap; adding the panel to the static-serve set.
- Capability-gating a known list of terminal verbs (same pattern as the board).

### Complex / Risky
- **Hard dependency on ·6** — without the Planning burndown, a headless Project panel's arms crash. This plan is a no-op until ·6 lands.
- **Breadth of the panel** — 172 arms across PRD/constitution/plans/tickets/docs; verifying each round-trips over the shim in a browser is real surface area (though the shim is generic, so it is verification, not per-arm code).
- **Doc editors + live markdown render** — `renderMarkdownLive`, doc save/round-trip, and imported-doc paths must behave identically over HTTP as in the webview.

## Edge-Case & Dependency Audit

- **Race Conditions:** Same as the board — commands (HTTP) and renders (WS) are async; the shim must not assume the fetch reply reflects post-write state. Doc autosave over the shim must debounce as the webview does.
- **Security:** Inherits the board's browser-facing auth (Host allowlist + token→cookie + Origin/CORS). No new surface beyond serving one more panel.
- **Side Effects:** One more panel served; the VS Code Project panel is unaffected (assets/CSP injected per host; disk file shared, untouched).
- **Dependencies & Conflicts:** **Hard:** ·6 Planning burndown (arms host-agnostic). **Reuse:** the Standalone B2 browser transport/serving/auth/capability machinery (built for the Kanban board). **Soft:** B1 (headless host) if run with no VS Code at all; served fine from the extension host meanwhile.

## Dependencies

- **·6 — PlanningPanelProvider Burndown** (host-agnostic arms) — hard prerequisite.
- **Standalone B2** — browser transport shim + static serving + auth + capability hook — reused, not rebuilt.
- Soft: **B1** headless host for the no-VS-Code case.

## Adversarial Synthesis

Key risks: shipping this before ·6 yields a Project panel whose buttons crash headless; and the panel's breadth (172 arms, doc editors, live render) makes "renders in a browser" easy to claim but hard to fully verify. Mitigations: gate strictly on ·6; reuse the board's proven shim/serving/auth so this is wiring + verification, not new infrastructure; verify the doc-editor and ticket round-trips explicitly, not just that the page loads.

## Proposed Changes

### `src/webview/project.html`
- **Context:** Self-contained webview coupled via `acquireVsCodeApi()` + `postMessage`; ~172 verbs dispatched through `PlanningPanelProvider.handleServiceVerb`.
- **Logic:** Load the B2 transport shim first; capability-gate the terminal/CLI verbs per Step 3.
- **Edge Cases:** Doc autosave debounce over the shim; live-markdown render parity.

### `src/services/LocalApiServer.ts` (+ the standalone service)
- **Context:** Browser static-serving route set introduced for the board.
- **Logic:** Add `project.html` + assets to the served set (same placeholder/CSP replication).
- **Edge Cases:** Same-origin against the API/wsHub; single-source serve path.

## Verification Plan

*(SKIP COMPILATION / SKIP TESTS per session directives — the below are manual acceptance checks for implementation time.)*

### Automated Tests
- None this pass. (Later: assert a `POST /planning/verb/<readVerb>` returns data in the body and a browser-loaded `project.html` round-trips a doc save.)

### Manual Acceptance
- With ·6 landed, open `project.html` in a browser (extension-hosted first): PRD/constitution/plan editors render and save; tickets list and sync; imported docs open.
- With `terminalDispatch: false`, the architect/artifact terminal buttons are absent; copy-prompt variants remain and copy to the browser clipboard.
- The VS Code Project panel behaves identically before/after (shared disk file, per-host CSP/assets).
- (Headless, once B1) the same via `npx switchboard` with no VS Code — no arm crashes.

## Completion Summary

- Migrated the remaining `PlanningPanelProvider` arms from direct `vscode.*` calls to the injected `_seams()` interface: terminal dispatch, configuration reads/writes, file dialogs, external links, watchers, and command execution.
- Extended `hostSeams.ts` with `HostWatchHandle`/`TerminalHandle`, `getConfigNumber`/`getConfigJson`/`updateConfigWorkspace`, and `findByNameContains` on `TerminalBackend` to support the migrated arms.
- Added `StandaloneHostPathConfigProvider` missing config methods and a `createHeadlessHostSeams()` bundle in `src/standalone/hostServices.ts` for the no-VS-Code case.
- Wired the Project panel into the browser static-serve path:
  - `LocalApiServer` now serves `GET /project` and `GET /project.html` via `_handleServeProject` with token→cookie auth.
  - `POST /project/verb/<name>` routes through the existing planning-verb handler.
  - `standalone/bootstrap.ts` provides `getProjectHtml()` which rewrites `project.html` placeholders, injects `sharedDefaults.js`/`transport.js`, sets `data-panel="project"`, and emits a browser-compatible CSP (`connect-src 'self' ws://...`).
- Fixed TypeScript type errors introduced by the migration; `npx tsc --noEmit` now reports only pre-existing `.js` extension import warnings in unrelated files.

**Remaining for full headless functionality:** `PlanningPanelProvider` still imports `vscode` for panel/type bindings and panel-only setup code. In `npx switchboard` mode the module load must be trapped or the provider instantiated with headless seams before the full verb surface works end-to-end; the infrastructure routes and seams are in place for that final wiring.
