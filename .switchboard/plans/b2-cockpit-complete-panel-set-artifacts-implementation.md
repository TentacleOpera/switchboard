---
description: "The browser cockpit exposes only 4 panels (board/project/design/setup); the editor also has the Planning/Artifacts panel (planning.html, a distinct PlanningPanelProvider._panel) and the Implementation sidebar (implementation.html). Add the missing panels as manifest entries + routes + HTML getters and wire their verbs, then audit the editor's full createWebviewPanel inventory against the browser manifest so the nav mirrors the editor exactly."
---

# B2 · Browser Cockpit — Complete the Panel Set (Artifacts / Planning + Implementation)

## Metadata
- **Project:** browser-switchboard
- **Tags:** ui, feature, api
- **Complexity:** 5
- **Release phase:** B2 (browser cockpit). Parity fix.
- **Dependencies:** Soft — new panels also need the data-delivery contract (`b2-cockpit-live-data-delivery-empty-board`) and theming (`b2-cockpit-real-icons-and-claudify-theming`) to look/behave right, but can be built independently.

## Goal

Every panel the editor can open must have a browser equivalent in the cockpit nav — starting with the missing **Artifacts/Planning** panel the user flagged.

### Problem / root-cause analysis

The browser manifest (`getPanelsManifest`, `headlessPanelHtml.ts:238-240`) exposes exactly four panels: board, project, design, setup. The editor's actual panel inventory (verified via `createWebviewPanel` / view registrations) is larger:

- `KanbanProvider._panel` → `kanban.html` (Board) — **in browser**
- `PlanningPanelProvider._projectPanel` (`:531`) → `project.html` (Project) — **in browser**
- `PlanningPanelProvider._panel` (`:737`) → `planning.html` (**Planning / Artifacts**) — **MISSING**
- `DesignPanelProvider._panel` (`:493`) → `design.html` (Design) — **in browser**
- `SetupPanelProvider._panel` (`:180`) → `setup.html` (Setup) — **in browser**
- `TaskViewerProvider` view `switchboard-view` → `implementation.html` (**Implementation**) — **MISSING**

So the user's "artifacts panel is missing" = `planning.html` (the Planning provider's *second* surface, distinct from `project.html`) was never wired into the browser. Implementation (`implementation.html`) is also absent. The Planning verbs are already routed headless (`planningVerb` → `PlanningPanelProvider.handleServiceVerb`), so the Artifacts panel's backend is available — only the route/manifest/HTML wiring is missing.

## Proposed Changes

### `src/services/headlessPanelHtml.ts` — add manifest entries + HTML getters
- Add manifest entries for `planning` (label matching the editor, e.g. "Artifacts") and `implementation`, with real icons (per the icons plan) and routes `/planning` and `/implementation`. Order/label the nav to mirror the editor.
- Extend `getPanelHtmlById` to serve `planning.html` and `implementation.html` (transformed with the same shim + theme injection the other panels get).

### `src/standalone/bootstrap.ts` + extension serveStatic — add routes/getters
- Add `getPlanningHtml`/`getImplementationHtml` (or generalize `getPanelHtmlById`) so both hosts serve the new routes. Register `/planning` and `/implementation` GET routes in `LocalApiServer` alongside `/board` and `/project` (they share the same token→cookie gate and static-asset handling).
- Confirm the Planning "Artifacts" surface's verbs (upload prompt, doc mappings, artifact list) resolve headless — the Planning provider is already constructed and its verbs wired; add any Artifacts-specific verb to the allowlist/schemas if a gap surfaces.

### Panel-set audit (parity guard)
- Enumerate every `createWebviewPanel`/registered view in the extension and assert a 1:1 browser manifest entry. Capture the mapping in a short comment/table next to `getPanelsManifest` so future panels don't silently drift out of the browser again. Diagram/renderer popups that are transient (not nav destinations) are out of scope — document the exclusion explicitly rather than silently dropping them.

## Edge-Case & Dependency Audit
- **Capability gating:** Implementation/Artifacts may expose terminal-dispatch affordances; the existing host-adaptive gating (`transport.js:applyCapabilityGating`) must hide the terminal-only controls in a no-terminal host, exactly as it does for the other panels. Confirm the new panels' terminal buttons are covered by the gating CSS.
- **Two Planning surfaces, one provider:** `project.html` and `planning.html` are both `PlanningPanelProvider` — verify the browser routes disambiguate which surface (`isProject` flag) so verbs target the right panel state.
- **Cross-panel switch:** the shell's `switchPanel` bridge (`transport.js:PANEL_SWITCH_VERBS`) must include the new panels so "open Artifacts" from another panel switches correctly.

## Verification Plan
### Manual (the real DoD)
- The cockpit nav lists every editor panel including **Artifacts** and **Implementation**; opening each renders the real panel content (not 404/503).
- The panel-set audit shows no editor `createWebviewPanel` destination without a browser equivalent.
### Automated
- Unit-test `getPanelsManifest`: entry count + ids match the enumerated editor inventory; each id has a working `getPanelHtmlById`.
- Standalone smoke: `GET /planning` and `GET /implementation` → 200; a representative Artifacts verb → 200 in-body success.
