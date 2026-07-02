# Pin Plan Project via .md Metadata (Not Manifest) — Eliminate the Project Race

## Goal

When a chat or memo planner agent creates plan files, the plan must land in the project the user had active **when they clicked the prompt button**, not whatever project is active when the watcher imports the file minutes later.

The fix: the prompt builder injects the active project name into the dispatch prompt, and the agent writes `**Project:** <name>` into the plan .md's metadata block. The watcher already prefers the .md's `**Project:**` field over the stale `kanban.activeProjectFilter` DB config key (verified: `GlobalPlanWatcherService.ts:526` for new plans, `:620-632` for re-imports). No manifest, no sidecar file, no concurrency issue.

### Problem analysis / root cause

When a chat/memo agent creates plan files, the watcher stamps each plan's project from the DB `kanban.activeProjectFilter` config key **at file-write time** — potentially minutes after the user clicked the prompt button. If the user has meanwhile clicked into another project or workspace, the plan lands in the wrong project. The project the user intended is only knowable at **prompt-generation time**, so it must ride the prompt and come back written into the plan .md itself.

The watcher already has the right precedence (`GlobalPlanWatcherService.ts:526`):
```ts
const project = metadata.project || activeProject;
```
and the update path (`:620-632`):
```ts
if (metadata.project) {
    resolvedProject = metadata.project;  // Frontmatter wins, overrides everything
} else if (!resolvedProject) {
    resolvedProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
}
```

The race only exists because the chat/memo prompt never tells the agent to write `**Project:** <name>` into the .md. `parsePlanMetadata` (`planMetadataUtils.ts:95-99`) already parses this line. The entire fix is on the prompt-generation side.

> **Why not a manifest?** The original version of this plan proposed a `manifest.json` sidecar carrying the project. That design had a fatal concurrency flaw: 10 simultaneous planner agents would each read-modify-write the same `manifest.json`, losing entries to last-writer-wins. Per-agent manifest files would fix the race but add ingestor complexity for no benefit — the .md metadata approach is simpler, already supported by the watcher, and works identically for local and remote agents (the .md rides the git merge either way). Local agents don't use manifests at all (see sibling plan "Fix /improve-plan Manifest Prompting for Local Agents"). Remote agents still use manifests for column transitions (Trigger A), but not for project pinning.

> **Scope boundary:** This plan owns the creator-side project pinning for chat and memo prompts. It does NOT touch `improve-plan.md` — the sibling plan "Fix /improve-plan Manifest Prompting for Local Agents" (`feature_plan_20260702112304_improve-plan-manifest-local-vs-remote.md`) owns the improve-plan Trigger A manifest conditional. Zero file overlap between the two plans.

None of the three creator surfaces currently mentions the project or carries it into the prompt:
- kanban.html `CHAT PROMPT` → `chatCopyPrompt` handler (`KanbanProvider.ts:6715-6738`) → `buildKanbanBatchPrompt('chat', …)`.
- project.html `CHAT PROMPT` → `switchboard.copyChatPrompt` command (`extension.ts:1047`) → `copyGeneralChatPrompt` (`KanbanProvider.ts:768-776`) → same chat builder. `PlanningPanelProvider.ts:2984` passes only `workspaceRoot`.
- implementation.html Memo `Copy Prompt` / `Send to Planner` → `memoGeneratePrompt` (`TaskViewerProvider.ts:9954`) → `_buildMemoPlannerPrompt` (`TaskViewerProvider.ts:2948`), a standalone prompt not routed through the builder.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, docs

## Current State

- `parsePlanMetadata` (`planMetadataUtils.ts:95-99`) already parses `**Project:** <name>` from the .md.
- `PlanMetadata` interface already has a `project?: string` field (`planMetadataUtils.ts:53`).
- The watcher already prefers `metadata.project` over the DB config key on both initial import (`GlobalPlanWatcherService.ts:526`) and re-imports (`:620-632`).
- `insertFileDerivedPlan` resolves `project_id` from the project name using the same lookup the manual "Assign to project" button uses — unknown names are kept as denormalized strings.
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`agentPromptBuilder.ts:622`) claims sync with `switchboard-chat.md` but contains no project-line text (pre-existing sync gap — fixed here).
- Control-plane rule: edit `.agents/workflows/*` + `AGENTS.md` (source of truth); `CLAUDE.md` / `.claude/skills` are generated copies — sync them via the existing generation path, do not hand-fork.

## Proposed Changes

### 1. New project-line directive in the prompt builder

`agentPromptBuilder.ts`: add `manifestProject?: string` to `PromptBuilderOptions` (keep the name for continuity, though no manifest is involved — it's the active project to pin), and a `PROJECT_LINE_DIRECTIVE(project)` template emitted by the **chat** role branch when `manifestProject` is set:

```
PROJECT PIN: The user had the project "<project>" active when they copied this prompt. Write this line into each plan file's metadata section (alongside **Complexity:** and **Tags:**):
**Project:** <project>
This pins the plan to that project regardless of what project is active when the file is imported. Omit the line only if no project name is given above.
```

When `manifestProject` is unset (no active project, or the Unassigned filter) the directive is omitted entirely — the watcher falls back to `kanban.activeProjectFilter` as today. Workspace pinning needs no field: the plan file's location inside the chosen workspace's `.switchboard/plans/` IS the workspace signal, and the PLAN DESTINATION block already directs the agent to the right directory.

### 2. kanban.html chat prompt carries the board's active project

`chatCopyPrompt` handler (`KanbanProvider.ts:6715`): read the board's active project from the DB config key `kanban.activeProjectFilter` at generation time (the established stamping source) and pass it as `manifestProject` (skip when unset or `UNASSIGNED_PROJECT_FILTER`).

### 3. project.html chat prompt carries the panel's selected project

The Project panel's selected project is panel state, not the board filter, so it must ride the message: project.js sends `project` in its `copyChatPrompt` message → `PlanningPanelProvider.ts:2984` forwards it → extend `switchboard.copyChatPrompt` (`extension.ts:1047`) and `copyGeneralChatPrompt` with an optional `projectName` param → `manifestProject`.

### 4. Memo prompt gets the same directive

`_buildMemoPlannerPrompt` (`TaskViewerProvider.ts:2948`): resolve `kanban.activeProjectFilter` for the memo's workspace at generation time and append the same `PROJECT_LINE_DIRECTIVE` (shared constant from `agentPromptBuilder.ts`, not a second copy). Applies to both Copy Prompt and Send to Planner (same builder).

### 5. switchboard-chat.md + DEFAULT_CHAT_BASE_INSTRUCTIONS sync

- `switchboard-chat.md`: add a note that when the dispatch prompt carries a PROJECT PIN directive, the agent must write the `**Project:**` line into each plan file's metadata. Epic grouping (Trigger B) unchanged.
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`agentPromptBuilder.ts:622`): add one sentence referencing the PROJECT PIN directive when present — closing the existing sync gap with the workflow file.

### 6. AGENTS.md "project pinning" summary

Add a short subsection to `AGENTS.md` (source of truth; regenerate `CLAUDE.md` / skills via the existing sync mechanism — implementer: locate it, do not hand-edit generated copies):

> **Plan project pinning:** When a chat or memo dispatch prompt carries a PROJECT PIN directive, write `**Project:** <name>` into each plan file's metadata block. The watcher prefers this field over the board's active project at import time, preventing the project race when the user switches projects between copying and running the prompt. No manifest is needed for project pinning — the .md metadata is the carrier.

### 7. Tests

- Chat-role builder tests: `PROJECT_LINE_DIRECTIVE` present with project name when `manifestProject` set; absent when unset; correct wording present.
- Memo prompt test: project-line directive present when a project filter is active, absent otherwise.
- Watcher test (regression): plan .md with `**Project:** Foo` imports with `project='Foo'` even when `kanban.activeProjectFilter` is set to `'Bar'` — confirms the existing precedence still holds.

## Non-Goals

- No manifest schema change, no `PlanManifestService` change, no manifest involvement for project pinning.
- No change to `improve-plan.md` Trigger A conditional — owned by the sibling plan "Fix /improve-plan Manifest Prompting for Local Agents".
- No manifest instructions for executor/reviewer/tester dispatch prompts.
- No change to the watcher's import path — it already prefers `metadata.project` (verified at `GlobalPlanWatcherService.ts:526` and `:620-632`).

## Edge Cases

- **No active project / Unassigned filter** → directive omitted; watcher stamping behaves as today (falls back to `kanban.activeProjectFilter`).
- **Project deleted between prompt and import** → unknown name is kept as a denormalized string (existing ingest rule in `insertFileDerivedPlan`); nothing breaks.
- **Agent omits the line despite the directive** → watcher falls back to `kanban.activeProjectFilter` as today; no worse than the status quo.
- **Copied chat prompt pasted to a remote (claude.ai) agent** → same directive works: the `**Project:**` line rides the git merge inside the .md and the watcher reads it on import; no manifest needed for project pinning.
- **User manually edits the .md and removes the `**Project:**` line** → on next re-import, watcher falls back to `kanban.activeProjectFilter` (existing behavior at `:626-631`); the plan may shift projects, which is the user's explicit choice.

## Verification Plan

1. Unit tests from §7.
2. Manual: set board to project A → copy kanban chat prompt → switch board to project B → run the prompt (agent writes plan with `**Project:** A`) → confirm the plan lands in project A, not B.
3. Manual: memo Send to Planner with a project filter active → planner-created plans land in that project.
4. Manual: chat prompt with no project filter active → no `**Project:**` line in the plan → watcher stamps from `kanban.activeProjectFilter` as today.

## User Review Required

None.
