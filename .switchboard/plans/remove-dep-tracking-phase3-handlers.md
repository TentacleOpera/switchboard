# Remove Dependency Tracking — Phase 3: Service Handlers

## Goal

Remove all dependency-related message handlers, config resolution, and data push logic from KanbanProvider, GlobalPlanWatcherService, and ReviewProvider. After this phase, no backend code responds to dependency messages or writes dependency data to the webview/database.

## Problem Analysis

With the UI removed (Phase 1) and prompt injection removed (Phase 2), the backend handlers for dependency messages are dead code. This phase removes them along with the config resolution that feeds `dependencyCheckEnabled` and `includeDependencyInstructions` to the prompt builder, and the dependency metadata writes in the plan watcher and review provider.

## Metadata

- **Complexity:** 6
- **Tags:** refactor, backend

## User Review Required

None — removal only, no new behaviour.

## Complexity Audit

### Routine
- Remove `dependencyMapData` message handler cases from KanbanProvider
- Remove `dependencyCheckEnabled` config read/save from KanbanProvider
- Remove `includeDependencyInstructionsByRole` config resolution from KanbanProvider
- Remove `dependencies` metadata writes from GlobalPlanWatcherService
- Remove `dependencies` field from ReviewProvider types and handlers

### Complex / Risky
- **KanbanProvider `_calculateBlockingDependencies()`** — mutates `KanbanCard.hasBlockingDependencies` in-place across 3 call sites. Must remove the method and all calls. The `hasBlockingDependencies` field is still in the `KanbanCard` interface (removed in Phase 5) but the webview no longer reads it (Phase 1 removed the badge).
- **KanbanProvider `_sendDependencyMapData()`** — called from 3 sites: auto-refresh (line 2144), and two manual refresh handlers (lines 4507, 4511). Must remove the method and all calls.
- **KanbanProvider `getDependenciesFromPlan()`** — called from TaskViewerProvider (3 sites). Those callers are removed in Phase 4. This method can be removed now — Phase 4 will remove its callers.
- **KanbanProvider card construction** — `dependencies` and `hasBlockingDependencies` fields are set in 4 card construction sites (lines 1116–1131, 1146–1147, 1886–1901, 2050–2065, 3555–3570). Must remove from all object literals. The `KanbanCard` interface still has these fields until Phase 5, so TypeScript will error if they're removed from the literals. **Strategy: keep the fields in the literals as empty values (`dependencies: [], hasBlockingDependencies: false`) for now, and remove them from the interface in Phase 5.**
- **GlobalPlanWatcherService ClickUp sync** — line 493 passes `plan.dependencies` to `debouncedSync()`. Must remove the field from the sync payload without breaking the ClickUp service contract. The service likely accepts a generic object.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — removal only.
- **Security:** None.
- **Side Effects:**
  - `getDependenciesFromPlan()` is called from TaskViewerProvider (lines 2121, 10246, 14244). Those callers still exist after this phase. **Strategy: leave `getDependenciesFromPlan()` stub that returns `''` until Phase 4 removes the callers, then delete the method.** Alternatively, remove the method now and fix the 3 callers in TaskViewerProvider to not call it. Since Phase 4 is next, either approach works. **Decision: remove the method now. Phase 4 will remove the callers.** The code won't compile between phases 3 and 4, but since we're doing sequential execution, this is acceptable.
- **Dependencies & Conflicts:** Phase 1 and 2 must be complete before this phase.

## Dependencies

- Phase 1 (UI layer)
- Phase 2 (Prompt pipeline)

## Adversarial Synthesis

Key risk: KanbanCard interface still requires `dependencies` and `hasBlockingDependencies` fields until Phase 5 removes them. Removing these from card construction literals will cause TypeScript errors. Mitigation: keep the fields as `dependencies: [], hasBlockingDependencies: false` in card literals for now — they're dead data that the webview no longer reads. Phase 5 will remove the interface fields and then these can be cleaned from the literals. Alternative: do the KanbanCard interface change in this phase too, but that crosses into Phase 5 territory. The cleaner approach is to defer the interface change.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- Remove `_calculateBlockingDependencies()` method definition (lines 1746–1768) and all 3 calls (lines 1150, 1925, 2084)
- Remove `_sendDependencyMapData()` method definition (lines 2163–2173) and all 3 calls (lines 2144, 4507, 4511)
- Remove `getDependenciesFromPlan()` method definition (line 3709+)
- Remove `dependencies: card.dependencies?.join(', ')` from promptPlans construction (line 2253)
- Remove `getDependencyMapData` message handler case (lines 4481–4514)
- Remove `rebuildDependencyMap` message handler case (lines 4516–4524)
- Remove `dependencyCheckEnabled` read from resolved options (line 2500)
- Remove `dependencyCheckEnabled` default resolution from config (line 2608)
- Remove `dependencyCheckEnabled` save with persistence verification (lines 2951–2957)
- Remove `includeDependencyInstructions` from resolved options (line 2488)
- Remove `includeDependencyInstructionsByRole` config resolution (lines 2746–2749)
- Remove dependency rebuild prompt generation (lines 4491–4504, part of the already-removed handler)
- In card construction literals: remove CSV-to-array dependency parsing (lines 1116–1118, 1886–1888, 2050–2052, 3555–3557). Set `dependencies: []` and `hasBlockingDependencies: false` directly instead of computing them.

### `src/services/GlobalPlanWatcherService.ts`
- Remove `dependencies: metadata.dependencies` from new plan record (line 442)
- Remove `dependencies: metadata.dependencies` from existing plan update record (line 469)
- Remove `dependencies: plan.dependencies` from ClickUp `debouncedSync()` call (line 493)

### `src/services/ReviewProvider.ts`
- Remove `dependencies: string[]` from `ReviewTicketData` type (line 55)
- Remove `'setDependencies'` from `ReviewTicketUpdateRequest` type union (line 65)
- Remove `dependencies?: string[]` field from `ReviewTicketUpdateRequest` interface (line 69)
- Remove `case 'setDependencies'` from message handler (line 236)
- Remove `dependencies: []` default initialization (line 416)
- Remove `dependencies` from the ticket update pass-through in `_applyTicketUpdate` (lines 510–516)

## Verification Plan

### Automated Tests
- Skip (per session directive). Tests cleaned in Phase 6.

### Manual Verification
- Open Kanban view — no errors in developer console
- No dependency-related messages sent to webview
- Review panel no longer shows dependencies section
- ClickUp sync still works (no crash on missing `dependencies` field)

**Recommendation: Send to Coder** (Complexity 6 — multi-file handler removal with KanbanCard interface constraint)
