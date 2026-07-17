# Verb Engine — Remaining Provider Burndowns (Design, Setup, TaskViewer)

**Complexity:** 7

## Goal

The remaining A2b provider arm-migrations not needed for the board-only or Project-panel browser cockpit; backlog until those panels are browser-served. Each makes one more provider run without VS Code, unblocking that panel's headless/browser use later.

## How the Subtasks Achieve This

- **Verb Engine · 2 — DesignPanelProvider Burndown (62 arms)**: migrates the Design/Stitch tab's arms onto the seams. Was the original "proving panel" in the burndown order; the most deferrable for the cockpit (design/mockups aren't core to planning).
- **Verb Engine · 3 — SetupPanelProvider Burndown (117 arms)**: migrates the config/onboarding/integrations panel. Note: *configuration itself* in a headless cockpit is handled by B1's seams (config-file/env/keyring), so this burndown is only needed if the Setup **UI** is served in the browser.
- **Verb Engine · 5 — TaskViewerProvider Burndown (110 arms)**: migrates the sidebar / integration-token panel. Its server-hosting role (LocalApiServer, port/token files) is replaced by B1's composition root, not this burndown — this covers the panel's own UI arms.

## Dependencies & sequencing

- **Cross-feature:** all three depend on **·1 Foundations** (Core feature — already built). **None** is required for the board-only cockpit or the Project-panel upgrade; they gate only the Design / Setup / sidebar panels going headless.
- **Internal order:** independent — no cross-dependency among ·2/·3/·5. The only hard rule is the burndown's operational one: **one agent stream per provider file** (they touch different files, so they parallelise, but must not collide on the same file).
- **Guards:** byte-compatibility per provider (~4,000 installs); test-seam acceptance (no `vscode` reachable) per migrated arm.
- **Status:** backlog. Pull a subtask forward only when its panel is slated for browser/headless use.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Verb Engine · 2 — DesignPanelProvider Burndown (62 arms)](../plans/a2b-verb-engine-02-design-panel.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 3 — SetupPanelProvider Burndown (117 arms)](../plans/a2b-verb-engine-03-setup-panel.md) — **PLAN REVIEWED**
- [ ] [Verb Engine · 5 — TaskViewerProvider Burndown (110 arms)](../plans/a2b-verb-engine-05-taskviewer-provider.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
