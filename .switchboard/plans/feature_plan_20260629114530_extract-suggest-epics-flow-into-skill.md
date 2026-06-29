# Extract the Suggest-Epics Orchestration Flow into a Model-Invocable Skill

## Goal

Move the epic-grouping orchestration procedure (scan → read bodies → cluster by capability → propose → confirm → execute) out of the button-only TypeScript string `_buildSuggestEpicsPrompt` and into a real skill file, so any agent can follow it **directly** when the user asks to "group / organise plans into an epic" — without first clicking the Suggest Epics board button to be handed the prompt. The board button is retained but becomes a convenience trigger that reads the skill text rather than the sole source of the procedure.

### Problem

The epic-*creation* tooling is split across two layers, and only the low-level half is reachable by an agent:

- **Mechanism (reachable):** `.agents/skills/kanban_operations/SKILL.md` documents `create-epic.js` / `assign-to-epic.js` (the verbs). An agent can call these directly.
- **Procedure (unreachable):** the actual decision flow — what to scan, how to cluster, the propose→confirm→execute gate — lives **only** in `_buildSuggestEpicsPrompt` (`src/services/KanbanProvider.ts:8778-8836`), a hardcoded TS string emitted by `case 'suggestEpics'` (line 8064) when the user clicks the board button.

So an agent asked "organise these plans into an epic" has the verb but not the procedure, and must be handed the flow via the button's clipboard copy. This is the exact friction observed in practice: the user had to press the button and paste the prompt to give the agent a flow the agent should have been able to load itself.

### Root Cause

`agent-epic-creation.md` (the plan that built `create-epic.js`, `assign-to-epic.js`, and the Suggest Epics button) chose to "document the workflow" by **embedding it in the button's copied prompt**, not in a skill. Skills in this project are model-invoked via their description (see `[[control-plane-source-of-truth]]`); a procedure trapped in a TS string is invisible to that mechanism. No existing plan addresses this — `create-epic-skill` is a remote-only file-writing skill, `epic-grouping-awareness` only adds "offer to group" nudges, and `refine-epic-skill` is description-improvement.

### Background

There is a direct precedent for a clipboard button sourcing its text from a skill file at runtime: `copyRefinePrompt` (`PlanningPanelProvider.ts:5208`) **reads `refine_ticket.md`** and builds the clipboard prompt from it. `refine_ticket` is a "backend-consumed" skill — read by the extension, not model-invoked. The fix here makes one skill serve **both** roles: model-invocable (agent loads it by description) and backend-consumed (the button reads it and injects the dynamic workspace root).

## Metadata
**Complexity:** 4
**Tags:** docs, backend, refactor, infrastructure

## Decision (single source of truth)

- **Create a dedicated model-invocable skill `group-into-epics`** (source: `.agents/skills/group-into-epics/SKILL.md`; name adjustable — it pairs with the "Suggest Epics" button label). Its description triggers on natural-language asks: "group plans into an epic", "organise loose plans into epics", "suggest epic groupings". The SKILL.md body is the canonical copy of the scan→read→propose→confirm→execute flow currently in `_buildSuggestEpicsPrompt`, including the `create-epic.js` / `assign-to-epic.js` invocation and the shell-metacharacter escaping rules.
- **The button reads the skill, not a duplicate.** `_buildSuggestEpicsPrompt` is reduced to: read the `group-into-epics` SKILL.md flow text + inject the dynamic `workspaceRoot` (the only runtime value it templates today), mirroring how `copyRefinePrompt` reads `refine_ticket.md`. This keeps the clipboard output self-contained and host-agnostic while eliminating the duplicated procedure.
- Chosen over (a) leaving the flow in TS with a sync-comment (perpetuates the drift the user is objecting to) and (b) folding it into `kanban_operations` (whose description is scoped to "move cards — manual fallback only"; the grouping flow needs its own triggering description).

## Implementation

1. **Author `.agents/skills/group-into-epics/SKILL.md`.** Port the flow verbatim from `_buildSuggestEpicsPrompt` (`KanbanProvider.ts:8778-8836`): the CREATED/PLAN REVIEWED scope, the `planId:`-from-comment rule, parallel body reads, capability-theme grouping (min 2 plans/epic, standalone section, overlap/redundancy/gap flags), the propose→**confirm gate**→execute sequence, the `create-epic.js` command with escaping rules, the post-create "write `## How the Subtasks Achieve This`" step, `assign-to-epic.js` for later additions, and the optional BACKLOG pass. Use a `{{WORKSPACE_ROOT}}` placeholder where the button injects the path.
2. **Register the skill in the control plane.** Add the `group-into-epics` row to `AGENTS.md` (the source), then regenerate the derived `CLAUDE.md` / `.claude/skills` via the existing control-plane generation step — do **not** hand-edit the generated files (`[[control-plane-source-of-truth]]`).
3. **Refactor `_buildSuggestEpicsPrompt` to read the skill.** Replace the hardcoded string array with a read of `group-into-epics/SKILL.md` (resolve the path the same way `copyRefinePrompt` resolves `refine_ticket.md`) and substitute `{{WORKSPACE_ROOT}}`. Preserve the existing status-message behavior in `case 'suggestEpics'` (line 8064) — candidate count, "paste into chat".
4. **Keep the verb scripts untouched.** `create-epic.js` / `assign-to-epic.js` and `kanban_operations/SKILL.md` are unchanged; the new skill references them.

## Edge cases & risks

- **Host-agnostic paste must still work.** Because the button inlines the skill text into the clipboard (not a "load the skill" pointer), pasting into a host without skill support still delivers the full self-contained procedure. Verify the copied output is byte-equivalent in spirit to today's prompt (same steps, same scope, same confirm gate).
- **Skill file must be readable at runtime.** Confirm `group-into-epics/SKILL.md` is resolvable by the running extension the same way `refine_ticket.md` is (the precedent proves this path exists). If the generated `.claude/skills` copy is what ships rather than `.agents/skills`, read from the resolved skill location used by the existing backend-consumed pattern.
- **Confirm gate is load-bearing.** The flow must never auto-create epics before user approval; the skill must preserve "do not create any epic before the user approves."
- **No data migration.** Pure additive skill + a read-from-file refactor of a prompt builder. The button's external behavior is unchanged.

## User Review Required
None. The skill name is adjustable but does not block; the design decision (single source of truth via runtime read) follows the existing `refine_ticket` precedent.

## Epic / Dependencies

Belongs under the existing **"Epic Creation and Specification UX"** epic (`8e44d446`-unrelated; this is epic *creation tooling*, not the orchestrator-dispatch epic). Complements `create-epic-skill` (remote file-write path) and `epic-grouping-awareness` (chat/memo nudges): together those plus this skill cover remote creation, proactive suggestion, and the on-demand grouping procedure. No blocking dependency; the verb scripts it relies on already exist.
