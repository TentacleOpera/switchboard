# Add plan folder ingestion target ot setup menu

## Goal
- Add a field to the setup menu that points the plan folder watcher at a specific folder where the user may be keeping their plans. It currently points to the antigravity brain, so this target would be in addition to that location. this allows user swho keep their plans in a specific folder to have them easily ingested into the database.

## Source Analysis
- `src/webview/implementation.html:1334-1385`
  - The sidebar `SETUP` section already contains persisted configuration controls for startup commands, agent visibility, toggles, custom agents, and docs.
  - There is currently no field for a plan-ingestion folder target.
- `src/webview/implementation.html:1797-1823` and `2141-2168`
  - Opening the setup panel requests current settings via webview messages, and clicking `SAVE CONFIGURATION` posts a `saveStartupCommands` payload.
  - The current save/load loop only handles startup commands, visible agents, and a few toggles. It does not currently round-trip a folder path.
- `src/services/TaskViewerProvider.ts:2586-2634`
  - The backend `saveStartupCommands` / `getStartupCommands` message handlers are the existing settings seam for the setup menu.
  - Right now those handlers do not persist or return any ingestion-folder configuration.
- `src/services/TaskViewerProvider.ts:537-610`
  - `updateState(...)` is the safe, locked `state.json` write path already used for sidebar configuration persistence.
  - A new setup-menu field should reuse this mechanism instead of introducing a parallel config file.
- `src/services/TaskViewerProvider.ts:2944-3016`
  - `_setupBrainWatcher()` is hardcoded to watch `C:\Users\<user>\.gemini\antigravity\brain`.
  - This is the existing out-of-workspace ingestion path.
- `src/services/TaskViewerProvider.ts:4240-4394`
  - Brain plans are not ingested directly into the DB from their source location. They are mirrored into `.switchboard\plans`, then runsheets/registry metadata are created.
- `src/services/TaskViewerProvider.ts:2826-2897` and `4400-4478`
  - Local workspace plan ingestion is already implemented by watching `.switchboard\plans\*.md` and creating runsheets from files that appear there.
- `src/services/TaskViewerProvider.ts:79-87`, `3218-3345`
  - The registry already tracks `sourceType`, `brainSourcePath`, and `localPlanPath`, so the codebase already has some concept of “original source path” metadata.
- **Clarification:** the requested feature is an additional ingestion source, not a replacement for the existing Antigravity brain watcher.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260311_082706_add_docs_button_to_setup_menu.md`
  - Direct setup-menu overlap.
  - This plan should add the new ingestion field into the same `SETUP` panel structure without disturbing the existing docs and save buttons.
- `feature_plan_20260311_083827_add_custom_agent_builder_option.md`
  - Direct setup-menu overlap.
  - That work already expanded the `SETUP` panel and save flow; this plan should reuse the same sidebar configuration persistence pattern rather than creating a second setup subsystem.
- `feature_plan_20260312_135938_fix_plan_detection.md`
  - Direct ingestion/discovery overlap.
  - This new folder target must not regress the current plan discovery behavior, ownership checks, or stale-plan suppression logic.
- `feature_plan_20260317_065103_open_plans_should_opena_new_ticket.md`
  - Related downstream consumer.
  - Newly ingested plans should still participate in the normal ticket/open-plan workflow once they are in the system.
- `feature_plan_20260317_165350_remove_view_plan_option_from_kanban_cards.md`
  - Related downstream UX.
  - Since ticket view is increasingly the main interaction surface, this ingestion work should preserve the normal plan/ticket creation pipeline rather than bypassing it with a one-off DB-only import.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Add the ingestion-folder field to the existing `SETUP` UI
   - **File:** `src/webview/implementation.html`
   - Add a single field to the existing setup panel for the additional plan-folder ingestion target.
   - Keep it within the current `SETUP` section and existing save flow.
   - **Clarification:** the ask only requires a field; do not expand scope with a new modal or a multi-folder manager unless the current implementation proves that a single stored folder path is impossible.
2. Extend the current setup save/load round-trip to include the new folder target
   - **Files:** `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`
   - Load the saved folder path when the setup panel opens.
   - Persist updates through the same `saveStartupCommands` / `updateState(...)` path already used by the rest of the setup menu.
   - Avoid introducing a second config persistence file when `state.json` already serves this purpose.
3. Keep the current Antigravity brain ingestion intact
   - The additional folder target must be additive, not a replacement.
   - Existing brain watcher behavior should remain enabled and unchanged for users who do not configure the new field.
4. Add focused regression coverage for the new config path
   - Add a small regression test proving the setup save/load path includes the new folder target.
   - Prefer the project’s existing source-level/config-path testing style over UI automation for this pass.

### Band B — Complex / Risky
1. Add a second out-of-workspace watcher path safely
   - **Primary files:** `src/services/TaskViewerProvider.ts`
   - The new folder target is not inside the workspace and is not the hardcoded Antigravity brain path, so it needs watcher lifecycle handling similar to the existing brain watcher.
   - This includes:
     - startup initialization,
     - reload when config changes,
     - cleanup/disposal,
     - fallback behavior for external-folder watcher reliability.
2. Reuse the existing ingestion pipeline instead of creating a DB-only import shortcut
   - The safest implementation is to feed external-folder plans into the same plan/runsheet/registry flow the app already uses, rather than inserting database rows directly.
   - **Clarification:** the plan should reuse established ingestion stages (workspace-visible staging and normal runsheet creation) wherever possible so imported plans behave like normal plans afterward.
3. Preserve registry/scoping semantics for externally sourced plans
   - The system already distinguishes between `brain` and `local` sources and uses plan registry ownership/scoping to prevent zombie or cross-workspace leakage.
   - Adding a third effective source path without care could break:
     - delete/archive behavior,
     - recoverability,
     - ownership scoping,
     - duplicate suppression when the same plan appears from multiple ingestion paths.
4. Ensure config changes can take effect without stale watchers lingering
   - Saving a new folder path should not leave the old watcher alive forever or require mysterious manual cleanup.
   - The watcher lifecycle needs an explicit refresh/reinitialize step when the setup value changes.

## Verification Plan
1. Open the sidebar `SETUP` section and confirm the new ingestion-folder field appears in the existing configuration area.
2. Enter a folder path, save configuration, collapse/reopen the setup panel, and confirm the value persists.
3. Keep the Antigravity brain watcher active and also add the new external folder target.
   - Confirm existing brain ingestion still works.
4. Place a valid plan markdown file in the configured external folder.
   - Confirm it is ingested through the normal plan pipeline and appears in the system/database rather than being ignored.
5. Change the configured folder target and verify the new target takes effect without duplicate or stale ingestion from the old path.
6. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - the focused regression test(s) for setup-menu persistence of the ingestion folder target.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Add a single setup-menu field for the external ingestion folder target.
- Persist/load that value through the existing `state.json` setup configuration path.
- Add focused regression coverage for the new config field.

### Band B — Complex / Risky
- Add and manage a second out-of-workspace watcher alongside the hardcoded brain watcher.
- Reuse the existing ingestion pipeline without creating duplicate plans or breaking registry/workspace scoping.
- Reinitialize watcher state correctly when the configured folder target changes.
