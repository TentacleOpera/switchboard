# Plan: Design System #2 — Make the Design System Per-Project (Parity with the PRD)

## Goal
Replace the single, workspace-global design-system setting with a **per-project** design-system binding, mirroring exactly how the PRD already works. Each project resolves its own design system, so a workspace containing multiple projects (each with its own visual language) binds the right design system to each — the same way `prdReferences` resolves a per-project PRD link today.

### Problem Context
The active design-system doc is stored as one global config key, `planner.designSystemDocLink` (`src/services/DesignPanelProvider.ts:1934`, `:2423`). A workspace with two projects in different design languages cannot give each its own design system — there is exactly one slot. By contrast the PRD is already per-project: `KanbanProvider._resolvePrdReferences(workspaceRoot, plans)` (`:4492`) walks the plans, resolves each plan's project to its PRD link, and produces `prdReferences: [{ projectName, prdLink }]`, which the prompt builder emits per project (`agentPromptBuilder.ts:607`, `:1317`). The design system needs the same treatment.

### Root Cause Analysis
- **Wrong granularity:** the design system was modeled as a workspace-wide default, not a project attribute, so it can't scale to multi-project workspaces.
- **Divergent from the PRD model:** the parallel PRD path already solved per-project resolution; the design system never adopted it.

## Metadata
- **Tags:** backend, agents, projects, refactor
- **Complexity:** 6

## User Review Required
- Confirm the fallback semantics: when a project has **no** design system bound, resolve the legacy global `planner.designSystemDocLink` (if set) as a workspace-wide default, so existing installs keep working. Confirm this fallback is desired rather than "no design system unless explicitly bound per project."

## Migration & Compatibility (published extension — ~4,000 installs)
`planner.designSystemDocLink` shipped as a released global setting. This plan MUST preserve it:
- **Keep reading the global key.** Introduce per-project bindings *in addition to* the global one; do not delete the global key.
- **Resolution order:** per-project design system (new) → else the global `planner.designSystemDocLink` (legacy default) → else none. This makes existing global configs behave exactly as before until the user opts into per-project bindings.
- Store per-project bindings the same way per-project PRD links are stored (project record field), so no new persistence mechanism is introduced.

## Dependencies
- **Depends on Design System #1** (the `DESIGN SYSTEM` injection block must exist and be correctly labeled). Builds directly on `buildDesignSystemBlock` from #1.
- Independently shippable once #1 lands: even without #3/#4, per-project binding is a usable improvement.

## Complexity Audit

### Routine
- Add `designSystemReferences?: Array<{ projectName: string; designSystemLink: string }>` to the addons type in `agentPromptBuilder.ts` (paralleling `prdReferences`).
- Add `buildDesignSystemReferencesBlock(refs)` in `agentPromptBuilder.ts`, modeled on `buildPrdReferenceBlockFromRefs` (`:607`), emitting the #1 `DESIGN SYSTEM` framing per project.

### Complex / Risky
- Add `KanbanProvider._resolveDesignSystemReferences(workspaceRoot, plans)` mirroring `_resolvePrdReferences` (`:4492`): resolve each plan's project → its bound design-system link → `[{ projectName, designSystemLink }]`; populate `mergedAddons.designSystemReferences` (parallel to `:4556`–`:4558`).
- Extend `AgentSkillExporter` to export `designSystemReferences` the way it exports `prdReferences` (`:351`).
- Design System tab: evolve "Set as Active Design Doc" so it can bind to a **project** (as the Planning panel's "Save as PRD" binds a PRD to a project), while still supporting the legacy global set for backward compatibility. This touches `DesignPanelProvider.ts` (`_sendActiveDesignDocState`, the set/unset handlers at `:2423`–`:2459`) and the tab UI in `design.html`/`design.js`.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
1. Add `designSystemReferences` to the addons/options types.
2. Add `buildDesignSystemReferencesBlock(refs)` reusing #1's framing per project.
3. In the planner and `buildCustomAgentPrompt` paths, prefer `designSystemReferences` when present; otherwise fall back to the single `designSystemDocLink`/`designSystemDocContent` (legacy global) via #1's `buildDesignSystemBlock`.

### `src/services/KanbanProvider.ts`
1. Add `_resolveDesignSystemReferences(workspaceRoot, plans)` mirroring `_resolvePrdReferences`.
2. Populate `mergedAddons.designSystemReferences` where `mergedAddons.prdReferences` is populated (`:4556`).

### `src/services/AgentSkillExporter.ts`
1. Export `designSystemReferences` alongside `prdReferences` (`:351`).

### `src/services/DesignPanelProvider.ts` + `src/webview/design.{html,js}`
1. Add a project selector to the Design System tab's bind action so a doc can be set as a specific project's design system.
2. Keep the existing global set/unset path as a legacy option.
3. Reflect per-project bound state in `_sendActiveDesignDocState` / `activeDesignDocUpdated`.

## Verification Plan

### Automated Tests
- `npm run compile`.
- Unit test `_resolveDesignSystemReferences`: two plans in two projects with different bound design systems resolve to two distinct refs; a plan in a project with no binding falls back to the global link.

### Manual Verification
1. Bind design system A to project X and design system B to project Y. Dispatch plans from each; confirm each prompt carries only its project's `DESIGN SYSTEM` block.
2. Leave a project unbound with a global `planner.designSystemDocLink` set; confirm the global is used (legacy fallback).
3. Existing install with only the global key set and no per-project bindings behaves exactly as before.

## Risk Assessment
- **Medium.** The prompt-builder and resolver changes are well-modeled on the PRD path, lowering risk. The real risks are (1) breaking the legacy global setting for existing installs — mitigated by the explicit resolution-order fallback and a legacy-config test; (2) UI ambiguity between "global" and "per-project" binding in the tab — mitigated by keeping both paths explicit.

**Recommendation:** Send to Coder
