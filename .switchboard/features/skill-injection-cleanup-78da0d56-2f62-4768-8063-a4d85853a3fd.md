# Skill Injection Cleanup

**Complexity:** 8

## Goal

Reduce the CLI system prompt's <available_skills> block from 91 entries to 4 by moving 33 items (32 skill directories + 1 flat file) to .switchboard/protocols/, merging 6 skills into 2, killing 6 mirror aliases, deleting 24 dead files, and adding an Archives tab to replace the archive skill's CLI discovery with a UI-delivered protocol reference.

## How the Subtasks Achieve This

- **Delete Dead Skill Files**: Removes 23 stale flat `.md` files left behind by the July 11 migration to directory-based `SKILL.md` format, plus the orphaned `delegates/` directory from the retired delegate-children system. No code changes — none of these files are referenced by the extension. This is the safest change and should land first to reduce noise before the protocol move.
- **Move Protocols Out of Skill Discovery**: The core change. Moves 33 items (32 skill directories + 1 flat file `refine_feature.md`) from `.agents/skills/` to `.switchboard/protocols/` so they're no longer discovered by CLI skill scanners. Includes `design-system-builder` (was missing from the original plan). Merges 6 skills into 2 new discoverable skills (`manage-features` from 4, `query-kanban` from 2 — `query-switchboard-kanban` is merged, not moved). Kills 6 mirror alias entries in `MIRROR_MANIFEST`. Updates ~15 code files that reference the old paths, adds `RETIRED_WORKFLOW_PATH_MAP` entries for users with persisted `.agents/skills/` paths, rewrites the AGENTS.md skills table, and updates cross-references in protocol files. Leaves only 4 discoverable skills: `manage-features`, `query-kanban`, `kanban_operations`, `worktree-cleanup`.
- **Add Archives Tab to Project Panel**: Adds a new Archives tab to `project.html` that reads archived plans from the SQLite cold store (`kanban-archive.db`) and displays them in a searchable list. A "Query Archives" button copies a prompt pointing to the archive protocol by path — same pattern as the tickets tab Agent API button. Replaces the stale DuckDB-based `queryArchives` handler in the implementation panel sidebar (not visible in Browser Switchboard). Depends on the archive protocol being at `.switchboard/protocols/archive/SKILL.md` (from the protocols move).

## Dependencies & sequencing

Strict ordering required:
1. **Delete Dead Skill Files** — must land first. Reduces noise and removes files that would otherwise need to be accounted for during the protocol move.
2. **Move Protocols Out of Skill Discovery** — depends on plan 1 being complete. The 33 protocol moves, 2 merges, and 6 alias kills must all land atomically — moving files without updating code references breaks the extension.
3. **Add Archives Tab to Project Panel** — depends on plan 2 being complete. The "Query Archives" button references `.switchboard/protocols/archive/SKILL.md` by path, which only exists after the protocol move.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Delete Dead Skill Files](../plans/delete-dead-skill-files.md) — **LEAD CODED**
- [ ] [Move Protocols Out of Skill Discovery](../plans/move-protocols-out-of-skill-discovery.md) — **LEAD CODED**
- [ ] [Add Archives Tab to Project Panel](../plans/add-archives-tab-to-project-panel.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Completion Report

All 3 subtasks implemented and committed. Subtask 1 (Delete Dead Skill Files): deleted 23 stale flat `.md` files + `delegates/` directory from `.agents/skills/`, committed `14322bfb`. Subtask 2 (Move Protocols Out of Skill Discovery): moved 33 protocols to `.switchboard/protocols/`, merged 6 skills into `manage-features` + `query-kanban`, killed 6 mirror aliases, updated ~15 code files + AGENTS.md + test files + protocol cross-refs, added RETIRED_WORKFLOW_PATH_MAP entries, committed `1a165cc2`. Subtask 3 (Add Archives Tab): added ARCHIVES tab to `project.html` with searchable list + detail view + QUERY ARCHIVES button, added `fetchArchivedPlans`/`fetchArchivedPlanDetail`/`queryArchivesPrompt` handlers to PlanningPanelProvider.ts, removed stale DuckDB `queryArchives` handler from TaskViewerProvider.ts + implementation.html, updated verbSchemas.ts + regenerated verbAllowlist.ts, committed `111c0c5c`. Coder-1 and coder-2 both went quiet twice on their subtasks; head agent finished remaining work directly (no lead seat to escalate to). Files changed: `.agents/skills/` (24 deletions + 33 moves + 2 new merged skills), `.switchboard/protocols/` (33 new), `src/services/` (agentPromptBuilder, KanbanProvider, TaskViewerProvider, PlanningPanelProvider, ClaudeCodeMirrorService, externalAgentPrompts, NotionBackupService, DesignPanelProvider, SparkContextExporter, verbSchemas), `src/standalone/bootstrap.ts`, `src/webview/` (project.html, project.js, kanban.html, tickets.js, implementation.html, sharedDefaults.js, planning.js), `src/test/` (10 test files), `src/generated/verbAllowlist.ts`, `AGENTS.md`.

