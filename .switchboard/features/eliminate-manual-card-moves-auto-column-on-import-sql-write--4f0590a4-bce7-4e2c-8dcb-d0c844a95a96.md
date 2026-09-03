# Eliminate Manual Card Moves — Auto-Column on Import + SQL Write Guardrail

**Complexity:** 4

## Goal

Eliminate the need for agents to manually move kanban cards after restructuring, and prevent agents from bypassing the extension by writing to kanban.db directly. Plan 1 auto-advances feature-scoped subtasks to PLAN REVIEWED on import. Plan 2 adds a four-layer guardrail (skill cleanup, allowlist narrowing, extension warning, fallback audit) to make direct DB writes impossible and visible when attempted.

## How the Subtasks Achieve This

- **Auto-Column Feature-Scoped Subtasks to PLAN REVIEWED on Import**: Modifies `PlanIngestionEngine._applyFeatureLink` to auto-move freshly linked subtasks from `CREATED` to `PLAN REVIEWED` when a `**Feature:**` frontmatter line is detected. Eliminates the manual `move-card.js` step that `improve-feature` and `rearrange-feature` currently require. The existing `featureId`-already-set guard ensures re-imports are unaffected.
- **SQL Write Guardrail — Prevent Agents from Writing to kanban.db Directly**: Closes four layers of the bypass: (1) fixes `create-feature-from-plans` to use `sqlite3 -readonly`, (2) narrows the Claude Code allowlist from `Bash(sqlite3 *)` to `Bash(sqlite3 -readonly *)`, (3) adds a throttled VS Code warning when `_reloadIfStale` detects an external write, (4) confirms `move-card.js` direct fallback is safely gated. Together these make direct DB writes both impossible (allowlist) and visible (warning) when they slip through.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [SQL Write Guardrail — Prevent Agents from Writing to kanban.db Directly](../plans/sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md) — **PLAN REVIEWED** — ID: ecfb14fa-0a8b-4765-b3c0-d4f5a1483ff4
<!-- END SUBTASKS -->

## Dependencies & sequencing

Plan 1 (auto-column) should land first — it eliminates the *need* for manual card moves, which is the root cause of agents reaching for direct SQL. Plan 2 (guardrail) should land second — it closes the bypass that agents fall back to when the manual move is inconvenient. No hard technical dependency between them (they touch different code paths), but the sequencing is logical: remove the motivation before closing the escape hatch.
