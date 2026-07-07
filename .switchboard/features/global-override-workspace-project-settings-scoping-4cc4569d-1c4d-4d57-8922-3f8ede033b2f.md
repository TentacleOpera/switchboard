# Global Override: Workspace & Project Settings Scoping

**Complexity:** 7

## Goal

Add a GLOBAL OVERRIDE section to the Setup tab with two independent switches (Workspace, Project) that scope all kanban.html tab settings to the workspace or project tier. Resolution: project → workspace → global. Both OFF = today's behavior. Toggling ON snapshots current values into the scoped store.

## How the Subtasks Achieve This

- **Global Override 01: project_config Storage Layer**: Adds the `project_config (project, key, value)` table to kanban.db (migration V52) plus CRUD methods on `KanbanDatabase` mirroring the existing config-table idiom, including a batched write for snapshots. This creates the project tier's physical store — nothing above it can exist without it.
- **Global Override 02: Scope-Aware Settings Read/Write Layer**: Introduces `_getScopedSetting` / `_updateScopedSetting` on `KanbanProvider` implementing the project → workspace → global resolution driven by the two override flags, and routes every verified in-scope call site (6 `kanban.*` keys + the generic `switchboard.prompts.*` path) through them. This is the feature's backbone; it also classifies which Setup-tab settings are already per-workspace by construction and stay outside the layer.
- **Global Override 03: GLOBAL OVERRIDE UI Section & Toggle Handlers**: Adds the Setup tab's first section — Workspace and Project toggle switches with an active-scope indicator — plus the `setWorkspaceOverride` / `setProjectOverride` backend handlers and the `overrideState` push that keeps the webview authoritative-synced (project switch disabled unless a specific project is selected). This is how users actually flip the tiers on and off.
- **Global Override 04: Snapshot-on-Toggle Mechanism**: On first toggle-ON of either switch, copies the current effective values of all scope-aware keys into the newly activated store (skip-if-populated, batched persist, no deletion on toggle-OFF), so the board looks identical before and after the toggle and subsequent edits diverge from a faithful baseline.
- **Global Override 05: Role Config Scope Awareness**: Extends scoping to role configs (`switchboard.prompts.roleConfig_*`), which flow through `TaskViewerProvider` on a separate path — scoped read/write methods, rerouting the seven direct prompt-assembly reads (addon getters, git-policy, overrides-cache builder), and cache invalidation on scope changes — so dispatched agent prompts genuinely honor per-project role configs.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. The feature is self-contained within `KanbanDatabase`, `KanbanProvider`, `TaskViewerProvider`, and `kanban.html`; it introduces migration V52 (additive `CREATE TABLE IF NOT EXISTS`, no shipped-state changes).
- **Shipping order within the feature:** 01 → 02 → 03 → 04, strictly — 02 calls 01's CRUD, 03 flips 02's flags, 04 inserts into 03's handlers at marked insertion points. 05 depends only on 01 + 02 and can be coded in parallel with 03/04, but all five must ship together: the feature is one delivery unit (a released 03 without 04 would show the "settings appear to reset" behavior 04 exists to prevent, and without 05 the Prompts tab would show scoped values that dispatched prompts ignore).
- **Prerequisites / guards:** none beyond the internal ordering. The feature has never shipped, so no migrations or compat shims are owed to the install base beyond V52 itself; both-switches-OFF must remain bit-identical to current behavior, which every subtask's verification checklist enforces.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Global Override 01: project_config Storage Layer](../plans/global-override-01-project-config-storage-layer.md) — **CODE REVIEWED**
- [ ] [Global Override 03: GLOBAL OVERRIDE UI Section & Toggle Handlers](../plans/global-override-03-ui-and-toggle-handlers.md) — **CODE REVIEWED**
- [ ] [Global Override 04: Snapshot-on-Toggle Mechanism](../plans/global-override-04-snapshot-on-toggle.md) — **CODE REVIEWED**
- [ ] [Global Override 05: Role Config Scope Awareness](../plans/global-override-05-role-config-scope-awareness.md) — **CODE REVIEWED**
- [ ] [Global Override 02: Scope-Aware Settings Read/Write Layer](../plans/global-override-02-scope-aware-settings-layer.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

Reviewer pass across all five subtasks (files: `KanbanDatabase.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `kanban.html`) with advanced regression analysis. One MAJOR fixed in plan 04 — the snapshot read effective values via globalState-first `_getSetting`, changing the board on Project-ON-while-Workspace-ON; switched to `_getScopedSetting` (safe because it runs before the flag flips). One NIT fixed in plan 05 — removed a double prompt-overrides cache rebuild on both-OFF role saves. Plans 01/02/03 verified clean (all six scoped keys + role-config reads correctly routed, both-OFF resolution bit-identical, server-side toggle validation present). Validation: static review only per SKIP COMPILATION/TESTS; remaining risks are the documented workspace-tier partial dormancy and a self-correcting stale-webview resolver race — neither material.
