# Move Protocols Out of Skill Discovery

> **SUPERSEDED (destination only) — do NOT re-implement the file move.**
> This plan's intent (get non-discoverable protocols out of skill discovery) was achieved.
> Its destination was not: `.switchboard/protocols/` cannot ship (`.vscodeignore` excludes
> `.switchboard/**`, and neither seeding path copies outside `.agents/`), so review fix
> `33d4f3d` relocated the 33 items to `.agents/protocols/`. That restored shipping and kept
> the token goal, but left 424K across 32 files scaffolded into every repository — the
> scaffolding cost this plan existed to remove.
> **Current state:** protocols live at `.agents/protocols/<name>/SKILL.md`.
> **Superseded by:** `protocols-as-db-rows-not-scaffolded-files.md`, which removes the files
> entirely rather than relocating them — protocols become `control_plane` rows the extension
> injects or materialises, since nothing discovers them by globbing.
> Every `.switchboard/protocols/` path in the body below is stale; read it for the protocol
> inventory and the reference-site audit, not for the destination.


## Goal

Move 33 items (32 skill directories + 1 flat file) from `.agents/skills/` to `.switchboard/protocols/`, merge 6 skills into 2 new discoverable skills, kill 6 mirror aliases, and update all code path references — reducing the CLI system prompt's `<available_skills>` block from 91 entries to 4.

> **Superseded:** Move 32 skill files from `.agents/skills/` to `.switchboard/protocols/`
> **Reason:** The original count of 32 was wrong — it included `query-switchboard-kanban` in the move list, but that skill is merged into `query-kanban` (stays in `.agents/skills/`), not moved. It also omitted `design-system-builder`, which has a MIRROR_MANIFEST entry and a code reference in `DesignPanelProvider.ts:2975`. With both corrections, the count is 33 items (32 directories + 1 flat file `refine_feature.md`).
> **Replaced with:** Move 33 items (32 skill directories + 1 flat file) from `.agents/skills/` to `.switchboard/protocols/`.

## Problem Analysis

### Background

The `.agents/skills/` directory contains 43 skill directories (including `_lib/` and `delegates/`). CLIs (Devin CLI, Claude Code, Windsurf) scan this directory and inject every discovered skill's name + description into the system prompt. This costs tokens on every turn, even for skills that are never self-discovered by the agent.

### Root Cause

Skills were all placed in `.agents/skills/` regardless of how they're consumed. Three consumption patterns don't require CLI discovery:

1. **Prompt-injected protocols** — The extension reads the file by path and either injects its content into the dispatched prompt, or emits a directive like "Read and follow `.agents/skills/accuracy/SKILL.md`". The agent never needs to find these from the skill list.

2. **Cross-referenced reference docs** — Other protocol files point agents to these by name ("see the `switchboard-orchestration` skill"). The agent finds them because another protocol told it the name, not because it matched the skill description to the user's request.

3. **Extension-delivered by name** — The extension generates prompts that say "Use the `clickup_api` skill" or "Run the tuning skill in extract mode" (tickets tab Agent API button, clipboard prompts, dispatched directives). These can be changed to path references: "Read `.switchboard/protocols/clickup-api/SKILL.md`".

### The 33 Protocols to Move

**Prompt-injected (10) — extension reads by path or emits path directive:**

| Protocol | How it's delivered | Code reference |
|---|---|---|
| `improve-plan` | Extension reads file, injects into planner prompt | `DEFAULT_PLANNER_WORKFLOW` in `agentPromptBuilder.ts:1460` |
| `improve-feature` | Extension reads file, injects into feature planner prompt | `DEFAULT_FEATURE_PLANNER_WORKFLOW` in `agentPromptBuilder.ts:1461` |
| `accuracy` | Directive: "read and follow .agents/skills/accuracy/SKILL.md" | `ACCURATE_CODING_DIRECTIVE` in `agentPromptBuilder.ts:453`, also `TaskViewerProvider.ts:21156` |
| `terminal-coder-dispatch` | Directive: "Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md" | `DRIVE_FEATURE_PREFIX` in `KanbanProvider.ts:77`, also `KanbanProvider.ts:5631` |
| `dispatch-analysis` | Directive: "Read and follow .agents/skills/dispatch-analysis/SKILL.md now" | `KanbanProvider.ts:5877`, `bootstrap.ts:180` |
| `advise_research` | Directive: "read the skill file .agents/skills/advise_research/SKILL.md" | `ADVISE_RESEARCH_DIRECTIVE_BASE` in `agentPromptBuilder.ts:968` |
| `switchboard-orchestrator` | Extension reads by path, injects into orchestrator kickoff | `TaskViewerProvider.ts:10996` |
| `switchboard-orchestrator-external` | Extension reads by path, injects into external kickoff | `TaskViewerProvider.ts:10998` |
| `switchboard-orchestrator-internal` | Extension reads by path, injects into internal kickoff | `TaskViewerProvider.ts:10999` |
| `refine_feature.md` | Extension reads by path for "Improve" button on feature with no subtasks | `PlanningPanelProvider.ts:4963` |

**Cross-referenced reference docs (2) — other protocols point agents to them by name:**

| Protocol | Referenced by |
|---|---|
| `switchboard-orchestration` | `switchboard-orchestrator/SKILL.md:374`, `switchboard-contracts/SKILL.md:5,72,125`, `terminal-coder-dispatch/SKILL.md:655` |
| `switchboard-contracts` | `switchboard-orchestration/SKILL.md:15` (mutual reference) |

**Extension-delivered by name (5) — change "use the X skill" to "read .switchboard/protocols/X/SKILL.md":**

| Protocol | How it's delivered | Code reference |
|---|---|---|
| `complexity-scoring` | `COMPLEXITY_SCORING_DIRECTIVE` says "invoke the complexity_scoring skill" | `agentPromptBuilder.ts:1360` |
| `deep-planning` | `DEEP_RESEARCH_DIRECTIVE` says "using the deep_planning skill protocol" | `agentPromptBuilder.ts:1402` |
| `web-research` | `TICKET_RESEARCH_REFINE_DIRECTIVE` says "use the web_research skill" | `agentPromptBuilder.ts:1380-1382` |
| `tuning` | PlanningPanelProvider generates "Run the tuning skill in extract/governance mode" | `PlanningPanelProvider.ts:5277,5286` |
| `constitution-builder` | PlanningPanelProvider dispatches "Follow instructions in .agents/skills/constitution-builder/SKILL.md" | `PlanningPanelProvider.ts:4514,4537` |

> **Superseded:** Extension-delivered by name (6) — includes `query-switchboard-kanban`
> **Reason:** `query-switchboard-kanban` is listed here as a protocol to move, but it is ALSO listed in the Skill Merges section as a source for `query-kanban` (which stays in `.agents/skills/`). A skill cannot be both moved to `.switchboard/protocols/` AND merged into a new skill in `.agents/skills/` — these are mutually exclusive. The final state table confirms `query-kanban` is one of the 4 discoverable skills, so `query-switchboard-kanban` must be MERGED, not moved.
> **Replaced with:** Extension-delivered by name (5) — `query-switchboard-kanban` removed; it is merged into `query-kanban` in Step 2.

**API proxy skills (12) — tickets tab Agent API button + dispatched prompt directives reference by name:**

| Protocol | Referenced by |
|---|---|
| `clickup-api` | Tickets tab API button (`tickets.js:4682-4683`), `REMOTE_MODE_DIRECTIVE`, `TICKET_UPDATE_DIRECTIVE`, ticket triager prompt |
| `clickup-fetch` | Tickets tab API button (`tickets.js:4676-4677`) |
| `clickup-create-task` | Tickets tab API button (`tickets.js:4664-4665`) |
| `clickup-modify-task` | Tickets tab API button (`tickets.js:4667-4668`) |
| `clickup-attach` | Tickets tab API button (`tickets.js:4670-4671`) |
| `clickup-create-subpage` | Tickets tab API button (`tickets.js:4673-4674`) |
| `clickup-move-task` | `MIRROR_MANIFEST` only — Move button in tickets UI handles directly |
| `linear-api` | Tickets tab API button (`tickets.js:4696-4700`), `REMOTE_MODE_DIRECTIVE`, ticket triager prompt |
| `linear-move-issue` | `MIRROR_MANIFEST` only — Move button in tickets UI handles directly |
| `notion-api` | Ticket triager prompt (`agentPromptBuilder.ts:2278`), `NotionBackupService.ts:330` |
| `get-tickets` | Tickets tab API button (`tickets.js:4658-4662,4687-4691`) |
| `generate-diagram` | Tickets tab API button (`tickets.js:4679-4680,4702-4703`) |

**Other protocols (3) — extension-delivered by name, not self-discovered:**

| Protocol | How it's delivered | Code reference |
|---|---|---|
| `external-team-lead` | Extension or user tells agent to take team lead role; skill defines the HTTP contract | `MIRROR_MANIFEST:93` |
| `improve-remote-plan` | Remote-session counterpart to improve-plan; extension-delivered context | `MIRROR_MANIFEST:99` |
| `design-system-builder` | DesignPanelProvider generates "run the design-system-builder skill" clipboard prompt | `DesignPanelProvider.ts:2975`, `MIRROR_MANIFEST:111` |

> **Superseded:** Other protocols (2) — `external-team-lead` and `improve-remote-plan` only
> **Reason:** `design-system-builder` was completely unaccounted for in the original plan. It exists as a directory in `.agents/skills/`, has a `MIRROR_MANIFEST` entry (line 111, `invocation: 'default'`), and is referenced by code in `DesignPanelProvider.ts:2975`. It was not in the move list, not in the merge list, and not in the final 4 discoverable skills. Since the goal is to reduce to 4 discoverable skills and `design-system-builder` is extension-delivered by name (clipboard prompt), it should be moved to protocols with its code reference updated to a path reference.
> **Replaced with:** Other protocols (3) — `design-system-builder` added to the move list.

**Archive protocol (1) — merged, becomes protocol with new Archives tab:**

| Protocol | Notes |
|---|---|
| `archive` | Merged with `query_archive` content. Moves to protocols. A new Archives tab in project.html will provide a button that copies a prompt pointing to the protocol by path. (Separate plan — Subtask 3.) |

### Skill Merges (2 new discoverable skills from 6 old ones)

**`manage-features`** — merged from 4 skills, stays in `.agents/skills/`:
- `create-feature` — create a feature by writing the file directly (remote fallback)
- `create-feature-from-plans` — create a feature from known plans via create-feature.js
- `group-into-features` — scan pre-coding columns, cluster, propose groupings
- `rearrange-feature` — restructure subtasks (split/move/merge/reorder) without rewriting content

The merged skill has four sections: Create, Create from Plans, Group, Rearrange. Extension prompts that currently say "invoke the `create-feature-from-plans` skill" change to "invoke the `manage-features` skill, follow the Create from Plans section" or "read `.agents/skills/manage-features/SKILL.md` and follow the Create from Plans section."

**`query-kanban`** — merged from 2 skills, stays in `.agents/skills/`:
- `query-switchboard-kanban` — full schema reference, column label mapping, workspace ID resolution, guardrails
- `query-kanban-plans` — ready-made SQL templates by workspace name, project, and features

The merged skill combines the schema reference and the query templates. The KanbanProvider scheduled prompt reference changes from "Use skill: query_switchboard_kanban" to "Use skill: query-kanban" or "Read `.agents/skills/query-kanban/SKILL.md`."

### Mirror Aliases to Kill (6)

These exist only in `MIRROR_MANIFEST` as `no-user` alias entries — same underlying skill, different name. Pure noise:

| Alias | Canonical source |
|---|---|
| `switchboard-remote-plan` | `improve-remote-plan` |
| `switchboard-notion` | `notion-api` |
| `switchboard-linear` | `linear-api` |
| `switchboard-clickup` | `clickup-api` |
| `switchboard-kanban` | `kanban_operations` |
| `switchboard-research` | `web-research` |

### Final State: 4 Discoverable Skills

| Skill | Purpose |
|---|---|
| `manage-features` | Create, group, rearrange features (merged from 4) |
| `query-kanban` | Query kanban DB by SQL (merged from 2) |
| `kanban_operations` | Move cards via move-card.js, create features via create-feature.js |
| `worktree-cleanup` | Clean up worktrees after merge via LocalApiServer |

## Metadata

**Complexity:** 8
**Tags:** refactor, infrastructure, performance, cli
**Project:** Browser Switchboard

## User Review Required

No user review required — the approach (move to `.switchboard/protocols/`) is the clear best option. The contradictions and gaps in the original plan have been resolved during this improve pass.

## Complexity Audit

### Routine
- Moving 33 items from `.agents/skills/` to `.switchboard/protocols/` (git mv)
- Merging 6 skill directories into 2 new directories (content copy + git rm originals)
- Removing 6 alias entries from MIRROR_MANIFEST
- Updating ~15 code files with path references (mechanical find-and-replace)
- Rewriting AGENTS.md skills table

### Complex / Risky
- **Path reference misses**: ~15 code files reference old paths. A missed reference causes a "file not found" error at runtime. Mitigation: grep verification step.
- **Migration/normalization gap**: Users who already ran the v1 planner migration have `.agents/skills/improve-plan/SKILL.md` persisted. The `RETIRED_WORKFLOW_PATH_MAP` only maps `.agents/workflows/` paths, not `.agents/skills/` paths. After the protocol move, those persisted paths are dead. Fix: add `.agents/skills/improve-plan/SKILL.md` and `.agents/skills/improve-feature/SKILL.md` as keys in `RETIRED_WORKFLOW_PATH_MAP`, mapping to the new `.switchboard/protocols/` paths. This normalizes at runtime without a new migration.
- **Merge content loss**: The 6-into-2 merges must preserve all operational content from the original skills. Mitigation: diff the merged files against the originals before deleting.
- **Stale mirror cleanup**: If `ClaudeCodeMirrorService` stale-mirror cleanup doesn't fire correctly, old `.claude/skills/` directories will linger. Mitigation: verify the ledger cleanup runs.
- **AGENTS.md drift**: The Available Skills table must be fully rewritten. Any stale entry will confuse agents.
- **Tickets tab prompts**: 9 capability entries in `AGENT_API_CAPABILITIES` reference skills by name. All must be updated to path references.
- **External agent prompts**: `externalAgentPrompts.ts` has `.agent/` (singular) legacy fallback paths. These must be updated alongside the `.agents/` paths.
- **Atomic landing**: The 33 protocol moves, 2 merges, and 6 alias kills must all land atomically — moving files without updating code references breaks the extension.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — file moves are atomic on the same filesystem. The extension reads skill files at dispatch time, not continuously.
- **Security:** None — skill definition files contain no secrets.
- **Side Effects:** `ClaudeCodeMirrorService` mirror generation will detect stale `.claude/skills/` directories via the ledger and delete them on the next run. The `RETIRED_WORKFLOW_PATH_MAP` normalization will silently rewrite persisted stale paths at runtime.
- **Dependencies & Conflicts:** Must land after Subtask 1 (Delete Dead Skill Files) — reduces noise. Subtask 3 (Archives Tab) depends on this plan — the archive protocol must be at `.switchboard/protocols/archive/SKILL.md` before the Archives tab button can reference it by path.

## Dependencies

- Subtask 1 (Delete Dead Skill Files) must land first — cleans up 23 stale flat `.md` files and `delegates/` directory, reducing noise before the protocol move.

## Adversarial Synthesis

Key risks: (1) path reference misses across ~15 code files — mitigated by grep verification; (2) migration/normalization gap for users with persisted `.agents/skills/` paths — mitigated by adding entries to `RETIRED_WORKFLOW_PATH_MAP`; (3) merge content loss in 6-into-2 consolidation — mitigated by diffing before deleting; (4) stale mirror cleanup not firing — mitigated by verifying the ledger cleanup runs. The original plan had two critical issues (query-switchboard-kanban listed in both move and merge lists; design-system-builder completely unaccounted for) — both are now corrected.

## Proposed Changes

### Step 1: Create `.switchboard/protocols/` and move 33 items

Move these from `.agents/skills/` to `.switchboard/protocols/`:

**Prompt-injected (10):**
- `improve-plan/`, `improve-feature/`, `accuracy/`, `terminal-coder-dispatch/`, `dispatch-analysis/`, `advise_research/`, `switchboard-orchestrator/`, `switchboard-orchestrator-external/`, `switchboard-orchestrator-internal/`, `refine_feature.md`

**Cross-referenced reference docs (2):**
- `switchboard-orchestration/`, `switchboard-contracts/`

**Extension-delivered by name (5):**
- `complexity-scoring/`, `deep-planning/`, `web-research/`, `tuning/`, `constitution-builder/`

**API proxy skills (12):**
- `clickup-api/`, `clickup-fetch/`, `clickup-create-task/`, `clickup-modify-task/`, `clickup-attach/`, `clickup-create-subpage/`, `clickup-move-task/`, `linear-api/`, `linear-move-issue/`, `notion-api/`, `get-tickets/`, `generate-diagram/`

**Other protocols (3):**
- `external-team-lead/`, `improve-remote-plan/`, `design-system-builder/`

**Archive (1, merged):**
- `archive/` (merge `query_archive/` content into it first, then move)

### Step 2: Merge 6 skills into 2 new discoverable skills in `.agents/skills/`

**Create `manage-features/`** from the content of:
- `create-feature/SKILL.md` → ## Create section
- `create-feature-from-plans/SKILL.md` → ## Create from Plans section
- `group-into-features/SKILL.md` → ## Group section
- `rearrange-feature/SKILL.md` → ## Rearrange section

Delete the 4 original directories after merging.

**Create `query-kanban/`** from the content of:
- `query-switchboard-kanban/SKILL.md` → schema reference, column mapping, guardrails
- `query-kanban-plans/SKILL.md` → append as ## Ready-Made Query Templates section

Delete the 2 original directories after merging.

### Step 3: Update code path references

**`src/services/agentPromptBuilder.ts`:**
- `DEFAULT_PLANNER_WORKFLOW` (line 1460): `.agents/skills/improve-plan/SKILL.md` → `.switchboard/protocols/improve-plan/SKILL.md`
- `DEFAULT_FEATURE_PLANNER_WORKFLOW` (line 1461): `.agents/skills/improve-feature/SKILL.md` → `.switchboard/protocols/improve-feature/SKILL.md`
- `ACCURATE_CODING_DIRECTIVE` (line 453): `.agents/skills/accuracy/SKILL.md` → `.switchboard/protocols/accuracy/SKILL.md`
- `ADVISE_RESEARCH_DIRECTIVE_BASE` (line 968): `.agents/skills/advise_research/SKILL.md` → `.switchboard/protocols/advise_research/SKILL.md`
- `COMPLEXITY_SCORING_DIRECTIVE` (line 1360): "invoke the complexity_scoring skill" → "read `.switchboard/protocols/complexity-scoring/SKILL.md`"
- `DEEP_RESEARCH_DIRECTIVE` (line 1402): "using the deep_planning skill protocol" → "using the deep planning protocol at `.switchboard/protocols/deep-planning/SKILL.md`"
- `TICKET_RESEARCH_REFINE_DIRECTIVE` (line 1380-1382): "use the web_research skill" → "read `.switchboard/protocols/web-research/SKILL.md`"
- `TICKET_UPDATE_DIRECTIVE` (line 1368): "use the clickup_api or linear_api skill" → "read `.switchboard/protocols/clickup-api/SKILL.md` or `.switchboard/protocols/linear-api/SKILL.md`"
- `TICKET_REFINE_DIRECTIVE` (line 1375): same pattern
- `TICKET_RESEARCH_REFINE_DIRECTIVE` (line 1385): same pattern
- `REMOTE_MODE_DIRECTIVE` (line 830): "using the linear_api skill (or clickup_api)" → "using `.switchboard/protocols/linear-api/SKILL.md` (or `.switchboard/protocols/clickup-api/SKILL.md`)"
- Ticket triager prompt (line 2277-2278): "clickup_api skill (ClickUp), the linear_api skill (Linear), or the notion_api skill (Notion)" → path references
- `RETIRED_WORKFLOW_PATH_MAP` (lines 1469-1473): the map values reference `DEFAULT_PLANNER_WORKFLOW` and `DEFAULT_FEATURE_PLANNER_WORKFLOW` constants — updating the constants (above) automatically updates the map values. **Additionally, add two new entries** to normalize persisted `.agents/skills/` paths:
  - `.agents/skills/improve-plan/SKILL.md` → `.switchboard/protocols/improve-plan/SKILL.md`
  - `.agents/skills/improve-feature/SKILL.md` → `.switchboard/protocols/improve-feature/SKILL.md`
  - These ensure users who already ran the v1 migration (and have `.agents/skills/` paths persisted) are normalized at runtime via `normalizeRetiredWorkflowPath()`.
- `create-feature-from-plans` references (lines 1452-1454): "Invoke the `create-feature-from-plans` skill" → "Invoke the `manage-features` skill and follow the Create from Plans section"
- Line 2535: `.agents/skills/accuracy/SKILL.md` → `.switchboard/protocols/accuracy/SKILL.md`

**`src/services/KanbanProvider.ts`:**
- `DRIVE_FEATURE_PREFIX` (line 77): `.agents/skills/terminal-coder-dispatch/SKILL.md` → `.switchboard/protocols/terminal-coder-dispatch/SKILL.md`
- Line 5631: same path update
- Line 5877: `.agents/skills/dispatch-analysis/SKILL.md` → `.switchboard/protocols/dispatch-analysis/SKILL.md`
- Line 6575: "Use skill: query_switchboard_kanban" → "Use skill: query-kanban" or "Read `.agents/skills/query-kanban/SKILL.md`"
- Line 6194: `planner.workflowPath` default → `.switchboard/protocols/improve-plan/SKILL.md`
- Line 6230: same default update
- Line 6461: `.agents/skills/improve-feature/SKILL.md` → `.switchboard/protocols/improve-feature/SKILL.md`
- Line 15257: `group-into-features/SKILL.md` reference → `manage-features/SKILL.md` (or path to the Group section)

**`src/services/TaskViewerProvider.ts`:**
- Line 10996: `path.join(root, '.agents', 'skills', 'switchboard-orchestrator', 'SKILL.md')` → `path.join(root, '.switchboard', 'protocols', 'switchboard-orchestrator', 'SKILL.md')`
- Line 10998-10999: same pattern for external/internal
- Line 11214: comment path reference update
- Line 21156: `.agents/skills/accuracy/SKILL.md` → `.switchboard/protocols/accuracy/SKILL.md`
- Line 6331: "invoke the create-feature skill" → "invoke the manage-features skill" or path reference
- Migration constants (lines 2499-2500, 2572-2573): update `NEW_DEFAULT` to `.switchboard/protocols/improve-plan/SKILL.md`. **Keep `OLD_DEFAULT` unchanged** — it matches against historical persisted values (`.agents/workflows/improve-plan.md`). The `RETIRED_WORKFLOW_PATH_MAP` additions (above) handle users who already migrated to `.agents/skills/` paths.

**`src/standalone/bootstrap.ts`:**
- Line 180: `.agents/skills/dispatch-analysis/SKILL.md` → `.switchboard/protocols/dispatch-analysis/SKILL.md`

**`src/services/PlanningPanelProvider.ts`:**
- Lines 4963, 4966: `.agents/skills/refine_feature.md` → `.switchboard/protocols/refine_feature.md` (and legacy `.agent/` path)
- Lines 4514, 4537: `.agents/skills/constitution-builder/SKILL.md` → `.switchboard/protocols/constitution-builder/SKILL.md`
- Lines 5277, 5286: "Run the tuning skill" → "Read and follow `.switchboard/protocols/tuning/SKILL.md`"

**`src/services/externalAgentPrompts.ts`:**
- `LAUNCHER_REGISTRY` entries (lines 67-68, 78-79, 89-90): update skill paths from `.agents/skills/` to `.switchboard/protocols/` (and the `.agent/` singular fallback paths)

**`src/webview/tickets.js`:**
- `AGENT_API_CAPABILITIES` (lines 4655-4704): change all "Use the X skill" prompts to "Read and follow `.switchboard/protocols/X/SKILL.md`" — affects clickup-api, clickup-fetch, clickup-create-task, clickup-modify-task, clickup-attach, clickup-create-subpage, linear-api, get-tickets, generate-diagram

**`src/services/NotionBackupService.ts`:**
- Lines 330, 391: "the notion_api skill" → "`.switchboard/protocols/notion-api/SKILL.md`"

**`src/services/DesignPanelProvider.ts`:**
- Line 2975: "run the design-system-builder skill" → "Read and follow `.switchboard/protocols/design-system-builder/SKILL.md`"

**`src/services/SparkContextExporter.ts`:**
- Line 204: "the remote-only `create-feature` skill" → "the `manage-features` skill"

### Step 4: Update `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts`

Remove all protocol entries from `MIRROR_MANIFEST` (they're no longer in `.agents/skills/` so the source files won't resolve). Verify each entry's presence before removing — some are NOT in the manifest:
- `switchboard-orchestrator`, `switchboard-orchestrator-external`, `switchboard-orchestrator-internal` — launched by path only, NOT in manifest
- `dispatch-analysis` — NOT in manifest
- `refine_feature.md` — IS in manifest (line 172), remove it
- `design-system-builder` — IS in manifest (line 111), remove it

Remove these 6 alias entries:
- `switchboard-remote-plan` (line 246)
- `switchboard-notion` (line 250)
- `switchboard-linear` (line 254)
- `switchboard-clickup` (line 258)
- `switchboard-kanban` (line 262)
- `switchboard-research` (line 266)

Update these entries to reflect merges:
- `query-switchboard-kanban` → rename to `query-kanban`, source `skills/query-kanban`
- `query-kanban-plans` → remove (merged into query-kanban)
- `create-feature` → remove (merged into manage-features)
- `create-feature-from-plans` → remove (merged into manage-features)
- `group-into-features` → remove (merged into manage-features)
- `rearrange-feature` → remove (merged into manage-features)
- Add `manage-features` entry: `source: 'skills/manage-features', name: 'manage-features', invocation: 'default', allowedTools: 'Bash'`

### Step 5: Update cross-references in protocol files

**`.switchboard/protocols/switchboard-orchestrator/SKILL.md`:**
- Line 374: "the `switchboard-orchestration` skill's *Reports channel* section" → "`.switchboard/protocols/switchboard-orchestration/SKILL.md` *Reports channel* section"
- Line 29: "node .agents/skills/kanban_operations/move-card.js" → keep (kanban_operations stays in .agents/skills/)
- Line 574: "use the worktree-cleanup skill (`.agents/skills/worktree-cleanup/SKILL.md`)" → keep (worktree-cleanup stays in .agents/skills/)

**`.switchboard/protocols/switchboard-contracts/SKILL.md`:**
- Lines 5, 72, 125: "use the **`switchboard-orchestration`** skill" → "read `.switchboard/protocols/switchboard-orchestration/SKILL.md`"

**`.switchboard/protocols/terminal-coder-dispatch/SKILL.md`:**
- Line 655: "use the `switchboard-orchestration` skill" → "read `.switchboard/protocols/switchboard-orchestration/SKILL.md`"

**`.switchboard/protocols/switchboard-orchestration/SKILL.md`:**
- Line 15: "consult the **`switchboard-contracts`** skill" → "read `.switchboard/protocols/switchboard-contracts/SKILL.md`"

### Step 6: Update AGENTS.md

Rewrite the **Available Skills** table to list only the 4 discoverable skills:
- `manage-features` — Create, group, rearrange features
- `query-kanban` — Query kanban DB via SQL (read-only)
- `kanban_operations` — Move cards, create features via scripts
- `worktree-cleanup` — Clean up worktrees after merge

Remove all protocol entries from the table. Update the architecture diagram and any inline references to protocols (e.g. "improve-plan skill" → "improve-plan protocol at `.switchboard/protocols/improve-plan/SKILL.md`").

Update the "Fast Kanban Resolution" rule (line 4 of the pre-flight check) from "use the `query-switchboard-kanban` skill" to "use the `query-kanban` skill".

Update the kanban column transitions paragraph: "use the `kanban_operations` skill" stays (it's still discoverable).

### Step 7: Update test files

Search for and update all test files referencing old paths:
- `src/test/orchestrator-tick-and-reports-contract.test.js`
- `src/test/proactive-terminal-rest-clear-contract.test.js`
- `src/services/__tests__/agentPromptBuilder.test.ts`
- `src/test/minimal-prompt.test.js`
- `src/test/agent-prompt-builder-subagents.test.js`
- `src/test/prompt-split-guidance-sync.test.js`
- `src/test/planner-workflow-path-migration.test.js`
- `src/test/agent-version-migration.test.js`
- `src/test/kanban-default-prompt-previews.test.js`
- `src/test/seat-safeguards-fleet-prompt-path.test.js`
- `src/test/standing-orders-marker-contract.test.js`
- `src/test/feature-drive-prompt-reframe-contract.test.js`
- `src/test/agent-prompt-builder-ticket-updater-modes.test.js`

Use `grep -r "\.agents/skills/(improve-plan|improve-feature|accuracy|terminal-coder-dispatch|dispatch-analysis|advise_research|switchboard-orchestrator|switchboard-orchestrator-external|switchboard-orchestrator-internal|switchboard-orchestration|switchboard-contracts|complexity-scoring|deep-planning|web-research|tuning|constitution-builder|clickup-api|clickup-fetch|clickup-create-task|clickup-modify-task|clickup-attach|clickup-create-subpage|clickup-move-task|linear-api|linear-move-issue|notion-api|get-tickets|generate-diagram|external-team-lead|improve-remote-plan|archive|refine_feature|design-system-builder)" src/` to find all references.

### Step 8: Verify the `ClaudeCodeMirrorService` stale-mirror cleanup works

After removing the protocol entries and 6 alias entries from `MIRROR_MANIFEST`, the next mirror generation run should detect the stale `.claude/skills/` directories (via the ledger in `.claude/.switchboard-generated.json`) and delete them. Verify this happens — the `generateClaudeMirror` function removes ledger-tracked skills that were not regenerated.

## Verification Plan

### Automated Tests
- `grep -r "\.agents/skills/(improve-plan|improve-feature|accuracy|terminal-coder-dispatch|dispatch-analysis|advise_research|switchboard-orchestrator|switchboard-orchestrator-external|switchboard-orchestrator-internal|switchboard-orchestration|switchboard-contracts|complexity-scoring|deep-planning|web-research|tuning|constitution-builder|clickup-api|clickup-fetch|clickup-create-task|clickup-modify-task|clickup-attach|clickup-create-subpage|clickup-move-task|linear-api|linear-move-issue|notion-api|get-tickets|generate-diagram|external-team-lead|improve-remote-plan|archive|design-system-builder)" src/` — returns zero matches (all path references updated).
- `grep -r "refine_feature\.md" src/` — only matches with updated `.switchboard/protocols/` paths.
- `grep -r "query_switchboard_kanban\|query-switchboard-kanban" src/` — returns zero matches (merged into query-kanban).
- `ls .agents/skills/` — shows only: `manage-features/`, `query-kanban/`, `kanban_operations/`, `worktree-cleanup/`, `_lib/`.

### Manual
- Start the extension — no errors.
- Dispatch a planner prompt — verify it references `.switchboard/protocols/improve-plan/SKILL.md`.
- Trigger the accuracy directive — verify it references `.switchboard/protocols/accuracy/SKILL.md`.
- Start the orchestrator — verify it reads `.switchboard/protocols/switchboard-orchestrator/SKILL.md`.
- Click "Improve" on a feature with no subtasks — verify it reads `.switchboard/protocols/refine_feature.md`.
- Open the tickets tab Agent API button — verify prompts reference `.switchboard/protocols/` paths.
- Run `generateClaudeMirror` — verify stale `.claude/skills/` directories are cleaned up.
- Start a new Devin CLI session — verify the `<available_skills>` block lists only 4 skills.
- Verify `normalizeRetiredWorkflowPath('.agents/skills/improve-plan/SKILL.md')` returns `.switchboard/protocols/improve-plan/SKILL.md` (migration normalization).

## Impact

| Metric | Original | After Subtask 1 (dead files) | After this plan |
|---|---|---|---|
| Skills in CLI system prompt | 91 | ~43 | 4 |
| `.agents/skills/` directories | 43 | 42 | 4 (+ `_lib/`) |
| `.switchboard/protocols/` items | 0 | 0 | 33 |
| Mirror aliases | 6 | 6 | 0 |
| Total reduction | — | 53% | 96% |

## Risks

- **Path reference misses**: ~15 code files reference the old paths. A missed reference will cause a "file not found" error at runtime. Mitigation: grep verification step + full test suite.
- **Merge content loss**: The 6-into-2 merges must preserve all operational content from the original skills. Mitigation: diff the merged files against the originals before deleting.
- **Migration/normalization gap**: Users who already ran the v1 planner migration have `.agents/skills/improve-plan/SKILL.md` persisted. The `RETIRED_WORKFLOW_PATH_MAP` additions (Step 3) normalize these at runtime. Without them, those users get dead paths after the protocol move.
- **Stale mirror cleanup**: If the `ClaudeCodeMirrorService` stale-mirror cleanup doesn't fire correctly, old `.claude/skills/` directories will linger. Mitigation: verify the ledger cleanup runs.
- **AGENTS.md drift**: The Available Skills table must be fully rewritten. Any stale entry will confuse agents. Mitigation: verify the table matches `ls .agents/skills/`.
- **Tickets tab prompts**: 9 capability entries in `AGENT_API_CAPABILITIES` reference skills by name. All must be updated to path references. A missed entry will tell the agent to use a skill that no longer exists in the discovery list.
- **External agent prompts**: `externalAgentPrompts.ts` has `.agent/` (singular) legacy fallback paths. These must be updated alongside the `.agents/` paths.
- **Atomic landing**: The 33 protocol moves, 2 merges, and 6 alias kills must all land atomically — moving files without updating code references breaks the extension.

**Recommendation:** Complexity 8 → Send to Lead Coder.

## Review Findings

**CRITICAL (fixed):** `.switchboard/protocols/` cannot ship — `.vscodeignore` excludes `.switchboard/**`, and neither seeding path (`extension.ts` `.agents` crawl-copy, `ControlPlaneMigrationService._bootstrapControlPlaneLayout`) copies anything outside `.agents/`; proved with the repo's own vsce-filter reimplementation, so all 33 protocols and every path reference the extension emits were dead on any user install while every grep/compile/manual check passed locally. Relocated to `.agents/protocols/` (ships unchanged, seeded by both existing copy paths, covered by the `.switchboard-bundled.json` ledger prune, and still invisible to CLI discovery, which scans `.agents/skills/` per `docs/imported_document_2026_07_09t00_31_11.md`), rewrote ~45 references across 31 files, added `.switchboard/protocols/*` keys to `RETIRED_WORKFLOW_PATH_MAP`, and added two `vsix-packaging-contract` assertions (negative-tested) that fail if a seeded control-plane file would not be packaged. **MAJOR (fixed):** `mirror:check` — a wired CI gate — was red at HEAD because Step 8 was never run; regenerating dropped `.claude/skills/` from 48 to 8 (the 4 discoverable skills + 4 workflow doors, confirmed live in-session), and two CI-wired tests (`terminal-coder-dispatch`, `seat-safeguards`) were passing only because the stale mirror lingered, so their `.claude/skills/` assertions were retargeted to the protocol source. **NIT (fixed):** `_buildSuggestFeaturesPrompt` now names the merged skill's **Group** section and its docblock no longer cites the deleted `group-into-features/SKILL.md`. Files changed: `.agents/protocols/` (33 moved), 15 `src/services`+`src/standalone` files, 4 webview files, 11 test files, `AGENTS.md`, `.claude/skills/` (regenerated); all 8 static gates pass (`catalog`, `mirror`, `parity`, `standalone-parity`, `standalone-fork`, `kanban-dispatch-callers`, `verb-returns`, `icons`) and `test:contract:{minimal-prompt,standing-orders-marker,feature-drive-prompt,orchestrator-tick,terminal-coder-dispatch,dispatch-analysis-scope,unattended-batch,spark-context-exporter,vsix-packaging}` pass. Remaining risks: `planner-workflow-path-migration.test.js` — the only guard on the `RETIRED_WORKFLOW_PATH_MAP` safety net for ~4,000 installs — is absent from `package.json` and CI and fails on a pre-existing harness bug (it never pre-creates `kanban.db`, which no longer auto-creates); retiring a protocol later still leaves a stale workspace file until the bundle ledger prunes it.
