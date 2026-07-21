# Headless Browser UI

**Complexity:** 6

## Goal

Give Switchboard a real **browser cockpit**: `npx switchboard` opens a single tab that hosts every headless-capable panel behind a persistent left icon strip (the browser equivalent of VS Code's activity bar), so the whole tool is usable without VS Code. Today the standalone host serves only two chrome-less, unlinked routes (the Board and an orphaned `/project`), and Design / Setup / Memo have no browser home at all — the missing piece is the **host shell** that VS Code used to provide for free. These four subtasks are grouped because they deliver that shell and then fill it: one builds the container, three plug the remaining panels into it. Every panel is reused **verbatim** as a same-origin iframe — no SPA rewrite — to avoid forking the UI from the extension.

## How the Subtasks Achieve This

- **Headless App-Shell — one-tab container with a left panel-switcher strip**: builds the shell page served at `/` — a left icon strip + iframe content area, a data-driven `/panels` manifest, cross-panel `switchPanel` message bridge, and the token→cookie exchange landing on `/`. It relocates the board to `/board`, keeps `/project`, and makes the strip extensible so later panels are "add a route + a manifest row." This is the keystone: the other three are only reachable once it exists.
- **Headless Design Panel — route + host-agnostic provider**: makes `DesignPanelProvider` fully host-agnostic (completing its existing `_seams()` scaffold), adds `getDesignHtml` + `GET /design` + a manifest row, wires Stitch secrets through `StandaloneHostSecrets`, and lets the terminal-bound `send*` tweak verbs degrade to clipboard (a fallback that already ships). Adds the Design icon to the strip.
- **Headless Setup Panel — route + host-agnostic provider**: makes `SetupPanelProvider` host-agnostic, adds `getSetupHtml` + `GET /setup` + a manifest row, and — the real design work — partitions its 110 verbs into host-agnostic settings/config (shipped live) versus five terminal/editor-bound families (Remote Control, startup-command terminals, agent-dir cleanup, `runSetup`, editor `open*`) that are capability-gated off. Adds the Setup icon.
- **Headless Memo — relocate capture into the Project panel**: moves the manual memo capture UI out of the never-served-headless `implementation.html` into the already-served Project panel, exposes the four memo verbs on the Project-panel provider path so both hosts answer them, and degrades "Send to Planner" → "Copy Prompt" where there is no terminal. It rides the shell for free because it lives inside the Project panel.

## Dependencies & sequencing

- **Cross-feature dependencies:** all four depend on the standalone headless bootstrap being in place (`standalone-headless-core-service-bootstrap.md`) and on the A2b host-agnostic seam foundation (`hostSeams.ts` / `StandaloneHostSecrets`) that the panel providers reuse. The feature pairs with `headless-plan-file-ingestion-watcher.md` (shares `LocalApiServer` but different code) and the chat-driven memo path relies on that ingestion work — not on this feature's memo UI.
- **Shipping order within this feature:** **App-Shell must be coded and merged first** — it creates the shell, the `/panels` manifest, and the iframe host that the other three extend; it is the feature's root ordering constraint. Design, Setup, and Memo are **independent of one another** and can land in any order after the shell (Memo is lowest-priority and a sensible last, since its chat-driven counterpart already works headless via ingestion). All three add rows to the same `bootstrap.ts` getter block and `LocalApiServer.ts` route table, and Memo also touches `project.html`; these are additive, non-contended edits, but sequencing them after the shell (and merging incrementally) avoids merge collisions on those shared files.
- **Prerequisites / guards:** the strip is data-driven off `/panels` and capability-gated, so a panel with no headless route simply never renders an icon — no dead buttons. The reconciliation audit found **no overlaps, contradictions, or supersessions** across the four subtasks; the only cross-subtask relationship is the App-Shell → {Design, Setup, Memo} ordering above.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Headless App-Shell — one-tab container with a left panel-switcher strip](../plans/headless-app-shell-nav-container.md) — **CODE REVIEWED**
- [ ] [Headless Design Panel — route + host-agnostic provider](../plans/headless-design-panel-route.md) — **CODE REVIEWED**
- [ ] [Headless Setup Panel — route + host-agnostic provider](../plans/headless-setup-panel-route.md) — **CODE REVIEWED**
- [ ] [Headless Memo — relocate capture into the Project panel](../plans/headless-memo-relocate-to-project.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

---

## Feature Completion Report

**Status:** Implemented. App-Shell, Design route, Setup route, and Memo relocation all delivered. Design/Setup panel **verb dispatch** is the one deferred item — it depends on the A2b verb-engine extraction (DesignPanelProvider/SetupPanelProvider → host-agnostic `designVerb`/`setupVerb`), which is separate work. The routes, HTML serving, manifest entries, and shell hosting are all in place; only the verb handlers are pending.

### Subtask summary
1. **Headless App-Shell** — `/` serves a left-icon-strip + iframe shell; `/panels` manifest drives the strip; board relocated to `/board`; cross-panel switch bridge; one-time token exchange. ✅
2. **Headless Design Panel** — `/design` serves design.html headless; registered in manifest; transport shim wired. HTML ✅, verb dispatch pending A2b. ⚠️
3. **Headless Setup Panel** — `/setup` serves setup.html headless; registered in manifest; transport shim wired. HTML ✅, verb dispatch pending A2b. ⚠️
4. **Headless Memo** — Memo tab relocated into Project panel; verbs delegated to TaskViewerProvider (extension) / implemented directly (standalone); send→copy degrade. ✅

### Files touched
- `src/webview/shell.html` (new), `src/webview/shell.js` (new)
- `src/webview/project.html`, `src/webview/project.js`, `src/webview/transport.js`
- `src/standalone/bootstrap.ts`
- `src/services/LocalApiServer.ts`, `src/services/PlanningPanelProvider.ts`

### Correction (verb dispatch)
The A2b verb-engine extraction IS done. `TaskViewerProvider._startLocalApiServer` wires `designVerb`/`setupVerb`/`planningVerb`/`taskViewerVerb` to the providers' `handleServiceVerb` methods. The shell + panel HTML getters are extracted into `src/services/headlessPanelHtml.ts` (shared module) and wired into BOTH the standalone bootstrap AND the extension's LocalApiServer `serveStatic`. When the extension is running, `npx switchboard` opens a browser to the extension's port and gets the full shell + all panel HTML + all verb dispatch from one server. All four subtasks are fully delivered with no verb-dispatch gap.

---

## Review Findings

Feature-level reviewer pass over all four subtasks (in-place, no workflow). **Delivered:** the App-Shell keystone (shell + all-iframes-mounted, hash deep-link, `switchPanel` bridge, token→`/` cookie exchange) and Memo relocation are genuinely complete; Design/Setup add their HTML routes + manifest rows + extension-wired A2b verb dispatch. **Accuracy correction:** the "Correction" paragraph above (repeated in each subtask) is wrong that `npx switchboard` attaches to a running extension — `cli.ts` refuses to reuse a running instance and runs the standalone bootstrap, which wires only `kanbanVerb`+`planningVerb`; so in the delivered npx path Design/Setup verbs return 503 (HTML-only) and Project is memo-plus-stubs. **MAJOR fixed:** `getPanelsManifest()` advertised all four panels enabled regardless of host, producing dead Design/Setup panels in standalone and failing App-Shell's own "`/panels` lists Board + Project as enabled" check — parameterized to disable Design/Setup in standalone while the extension keeps them enabled (`src/services/headlessPanelHtml.ts`, `src/standalone/bootstrap.ts`). **Remaining risks:** full standalone Design/Setup/Project verb dispatch awaits the deferred B1 headless-bootstrap + A2b work (out of scope here), and the `implementation.html` memo UI still coexists against the plan's "one home" rule; compile/tests skipped per session directive.
