# Browser Cockpit — Panel Data Delivery Fixes

**Complexity:** 6

## Goal

Fix the four browser-cockpit bugs where panels render no content: Kanban UAT/Automation tabs, Planning/Artifacts docs, Design view assets, and Stitch projects. Shared root cause: load verbs push instead of returning a typed HTTP body, _panel-gated senders bail headlessly, and the lazy BroadcastHub apiServer is null. Fixed via the return-contract per surface plus per-provider broadcaster wiring.

## How the Subtasks Achieve This

- **Browser Cockpit — Kanban UAT & Automation Tabs Render No Content**: Adds `type:'uatData'` to the `getUATData` return body and hardens its workspace-root resolution, adds a new read verb `getAutobanConfig` (catalog + allowlist + schema) returning a typed `updateAutobanConfig` body so the Automation tab loads over HTTP, and repairs the `KanbanProvider` broadcaster wiring (store `_apiServer`, pass it on lazy `_initKanbanService`) so live board/UAT/Automation deltas also reach the cockpit over WS.
- **Browser Cockpit — Planning / Artifacts Tab Loads No Docs**: Removes the spurious `_panel` guards in `_sendLocalDocsReady`/`_sendOnlineDocsReady`, makes both senders (plus `_handleFetchImportedDocs`) return their payloads, folds all three doc-tree payloads into the `fetchRoots` in-body return, adds a `fetchRootsComplete` handler in `planning.js` that routes them to the existing tree handlers, and repairs the `PlanningPanelProvider` broadcaster wiring for live file-watcher re-pushes.
- **Browser Cockpit — Design View Renders No Content (Doc Trees, Images, Previews)**: Removes the five spurious `_panel` guards in the `_send*DocsReady` senders and makes them return typed `*DocsReady` payloads (so every local tab loads over HTTP), introduces a `assetUrl` host seam (`asWebviewUri` in VS Code, `/design/asset` HTTP route headless) plus a guarded local-asset route reusing the provider's traversal allow-list, and repairs the `DesignPanelProvider` broadcaster wiring for live folder-watch re-pushes. Owns the shared `DesignPanelProvider` broadcaster-wiring change and the `assetUrl` seam that the Stitch subtask reuses.
- **Browser Cockpit — Stitch Integration Shows No Projects or Screens**: Adds `type:'stitchProjectsReady'`/`'stitchScreensReady'` to the `stitchListProjects`/`stitchGetProjectScreens` return bodies so the dropdown and gallery render over HTTP, emits `/static/stitch/...` URLs for cached screenshots instead of `asWebviewUri` (reusing the `assetUrl` seam from the Design-view subtask), and defers to the Design-view subtask's already-applied `DesignPanelProvider` broadcaster-wiring fix for the live background re-post.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. No other feature must land first; the four fixes are scoped to the browser-cockpit panel-delivery layer.
- **Shipping order within this feature:**
  - Subtasks 1 (Kanban) and 2 (Planning) are **independent** — they touch disjoint provider files (`KanbanProvider.ts`, `PlanningPanelProvider.ts`) and may be coded/merged in parallel or in either order (PRD contract: one agent stream per provider file; these are different files).
  - Subtask 3 (Design view) **must land before** subtask 4 (Stitch). Both edit `DesignPanelProvider.ts` (same provider file → must serialize per the PRD's one-stream-per-provider-file discipline), and subtask 3 introduces two shared surfaces subtask 4 reuses: (a) the `assetUrl` host seam in `hostSeams.ts` + the guarded `/design/asset` route in `LocalApiServer.ts`, and (b) the `DesignPanelProvider` broadcaster-wiring fix (`setApiServer` storing `_apiServer` + `_initDesignService` passing it). Subtask 4's plan already defers to these ("Prefer reusing the same host-seam `assetUrl` approach the Design-view plan introduces"; "idempotent… applying it in either plan is safe"). Coding 4 before 3 would duplicate the broadcaster change and force 4 to invent a seam 3 then replaces.
  - Recommended merge sequence: 1 ∥ 2 → 3 → 4.
- **Prerequisites / guards:**
  - Subtask 1 adds a **new verb** (`getAutobanConfig`): it must edit `protocol-catalog.json`, add a permissive schema entry in `verbSchemas.ts` (require only fields the arm dereferences — PRD contract #5), regenerate `src/generated/verbAllowlist.ts` via `npm run catalog:generate` (never hand-edit the generated file), and run `npm run parity:check` + `npm run verb-returns:check` (baseline via `npm run verb-returns:baseline` if the new verb moves the ceiling). Subtasks 2–4 enrich existing verbs' return bodies only — no catalog/schema changes.
  - All four apply the same broadcaster-wiring fix *shape* but each to its own provider (`KanbanProvider`, `PlanningPanelProvider`, `DesignPanelProvider`); the `DesignPanelProvider` instance is owned by subtask 3 and reused by subtask 4 — do not apply it twice.
  - Every return-contract addition must keep the VS Code webview path unchanged (the `onDidReceiveMessage` listener discards the return; only the HTTP transport consumes it) and must not regress `npm run verb-returns:check` / `npm run mirror:check` / `npm run parity:check`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Browser Cockpit — Kanban UAT & Automation Tabs Render No Content](../plans/feature_plan_20260724103701_browser-cockpit-kanban-uat-automation-tabs-empty.md) — **PLAN REVIEWED**
- [ ] [Browser Cockpit — Planning / Artifacts Tab Loads No Docs](../plans/feature_plan_20260724103702_browser-cockpit-planning-artifacts-docs-empty.md) — **PLAN REVIEWED**
- [ ] [Browser Cockpit — Design View Renders No Content (Doc Trees, Images, Previews)](../plans/feature_plan_20260724103703_browser-cockpit-design-view-no-content.md) — **PLAN REVIEWED**
- [ ] [Browser Cockpit — Stitch Integration Shows No Projects or Screens](../plans/feature_plan_20260724103704_browser-cockpit-stitch-integration-empty.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

