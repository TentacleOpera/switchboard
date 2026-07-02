# Pin Plan Project via .md Metadata (Not Manifest) — Eliminate the Project Race

**Plan ID:** f45dd56d-f65c-430b-afa1-d2b2ef5d4210

## Goal

When a chat or memo planner agent creates plan files, the plan must land in the project the user had active **when they clicked the prompt button**, not whatever project is active when the watcher imports the file minutes later.

The fix: the prompt builder injects the active project name into the dispatch prompt, and the agent writes `**Project:** <name>` into the plan .md's metadata block. The watcher already prefers the .md's `**Project:**` field over the stale `kanban.activeProjectFilter` DB config key (verified: `src/services/GlobalPlanWatcherService.ts:526` for new plans, `:622-632` for re-imports). No manifest, no sidecar file, no concurrency issue.

### Problem analysis / root cause

When a chat/memo agent creates plan files, the watcher stamps each plan's project from the DB `kanban.activeProjectFilter` config key **at file-write time** — potentially minutes after the user clicked the prompt button. If the user has meanwhile clicked into another project or workspace, the plan lands in the wrong project. The project the user intended is only knowable at **prompt-generation time**, so it must ride the prompt and come back written into the plan .md itself.

The watcher already has the right precedence (`src/services/GlobalPlanWatcherService.ts:526`):
```ts
const project = metadata.project || activeProject;
```
and the update path (`:622-632`):
```ts
if (metadata.project) {
    resolvedProject = metadata.project;  // Frontmatter wins, overrides everything
} else if (!resolvedProject) {
    resolvedProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
}
```

The race only exists because the chat/memo prompt never tells the agent to write `**Project:** <name>` into the .md. `parsePlanMetadata` (`src/services/planMetadataUtils.ts:95-99`) already parses this line. The entire fix is on the prompt-generation side.

> **Why not a manifest?** The original version of this plan proposed a `manifest.json` sidecar carrying the project. That design had a fatal concurrency flaw: 10 simultaneous planner agents would each read-modify-write the same `manifest.json`, losing entries to last-writer-wins. Per-agent manifest files would fix the race but add ingestor complexity for no benefit — the .md metadata approach is simpler, already supported by the watcher, and works identically for local and remote agents (the .md rides the git merge either way). Local agents don't use manifests at all (see sibling plan "Fix /improve-plan Manifest Prompting for Local Agents"). Remote agents still use manifests for column transitions (Trigger A), but not for project pinning.

> **Scope boundary:** This plan owns the creator-side project pinning for chat and memo prompts. It does NOT touch `improve-plan.md` — the sibling plan "Fix /improve-plan Manifest Prompting for Local Agents" (`feature_plan_20260702112304_improve-plan-manifest-local-vs-remote.md`) owns the improve-plan Trigger A manifest conditional. Zero file overlap between the two plans.

None of the three creator surfaces currently mentions the project or carries it into the prompt:
- kanban.html `CHAT PROMPT` → `chatCopyPrompt` handler (`src/services/KanbanProvider.ts:6748`) → `buildKanbanBatchPrompt('chat', …)` at `:6765`.
- project.html `CHAT PROMPT` → `switchboard.copyChatPrompt` command (`src/extension.ts:1048`) → `copyGeneralChatPrompt` (`src/services/KanbanProvider.ts:779`) → same chat builder at `:784`. `src/services/PlanningPanelProvider.ts:2985` forwards the message and passes only `workspaceRoot`.
- implementation.html Memo `Copy Prompt` / `Send to Planner` → `memoGeneratePrompt` (`src/services/TaskViewerProvider.ts:9983`) → `_buildMemoPlannerPrompt` (`src/services/TaskViewerProvider.ts:2948`), a standalone prompt not routed through the builder.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, docs

## User Review Required

None.

## Complexity Audit

### Routine
- Adding `manifestProject?: string` to `PromptBuilderOptions` (`src/services/agentPromptBuilder.ts:148`) — one optional field, no type breakage.
- Adding a `PROJECT_LINE_DIRECTIVE` template string and emitting it in the chat role branch (`src/services/agentPromptBuilder.ts:1262`) — pure string concatenation in an existing branch.
- Syncing `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`:622`) with one sentence referencing the PROJECT PIN directive.
- Adding a "project pinning" subsection to `AGENTS.md` (source of truth) — documentation only.
- Adding a note to `.agents/workflows/switchboard-chat.md` about honoring the PROJECT PIN directive — documentation only.
- Unit tests for the directive's presence/absence — straightforward string assertions.

### Complex / Risky
- **project.html → project.js message plumbing (Step 3):** The Project panel's selected project (`_selectedProjectName` in `src/webview/project.js:1249`) is panel state, distinct from the board's `kanban.activeProjectFilter`. The current `copyChatPrompt` message (`project.js:1830`) sends only `workspaceRoot` — it does NOT send `project`. This requires a coordinated 4-hop change: project.js adds `project: _selectedProjectName` → `PlanningPanelProvider.ts:2985` forwards it → `extension.ts:1048` `switchboard.copyChatPrompt` accepts an optional `projectName` param → `copyGeneralChatPrompt` (`KanbanProvider.ts:779`) accepts and forwards it as `manifestProject`. Each hop must handle the optional/undefined case gracefully. This is the highest-risk change because it crosses 4 files and a webview boundary.
- **Memo prompt standalone builder (Step 4):** `_buildMemoPlannerPrompt` (`TaskViewerProvider.ts:2948`) does NOT route through `buildKanbanBatchPrompt` — it builds its own string. The directive must be appended here separately, and the shared constant must be exported from `agentPromptBuilder.ts` to avoid a second divergent copy. The memo handler (`:9983`) resolves `workspaceRoot` but must additionally resolve `kanban.activeProjectFilter` from the DB for that workspace at generation time.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The core race this plan eliminates: user clicks prompt with project A active → switches to project B → agent writes plan → watcher stamps project B. Fix: project A rides the prompt → agent writes `**Project:** A` → watcher prefers it (`GlobalPlanWatcherService.ts:526`). No residual race.
- No manifest read-modify-write race (by design — .md metadata is per-file, not shared state).

**Security:**
- The project name flows from DB config / panel state into a prompt string. No injection risk — it's a display name written into a markdown metadata line. No SQL, no shell, no eval.

**Side Effects:**
- Adding `manifestProject` to `PromptBuilderOptions` is additive — all existing callers pass `undefined`, so the directive is omitted and behavior is identical to today. No regression for callers that don't opt in.
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` change adds one sentence — all chat prompts get it, but it's conditional ("when the dispatch prompt carries a PROJECT PIN directive"). No behavioral change when no directive is present.

**Dependencies & Conflicts:**
- **Sibling plan conflict check:** `feature_plan_20260702112304_improve-plan-manifest-local-vs-remote.md` owns `improve-plan.md` Trigger A. This plan does NOT touch `improve-plan.md`. Zero file overlap. The two plans can execute in parallel.
- **`switchboard-chat.md` Trigger B (epic grouping):** This plan adds a project-pin note to the workflow file but does NOT alter the Trigger B manifest/epic-grouping logic (`switchboard-chat.md:28-71`). The PROJECT PIN directive is orthogonal to the plan-import manifest — project pinning rides the .md metadata; epic grouping rides the manifest. No conflict.
- **`kanban.activeProjectFilter` DB key:** Written by `KanbanProvider.setProjectFilter` on every project selection (`KanbanProvider.ts:344`, `:2284`, `:4957`) and on workspace restore (`:340`). This plan reads it at prompt-generation time — no change to the write path.
- **`UNASSIGNED_PROJECT_FILTER`** (`KanbanDatabase.ts:708`, value `'__unassigned__'`): When the board filter is this sentinel, the directive must be omitted (no project to pin). Verified the constant exists and is checked throughout `KanbanProvider.ts`.

## Dependencies

sess_20260702112304 — improve-plan manifest local-vs-remote (sibling plan; owns `improve-plan.md` Trigger A — do not overlap)

## Adversarial Synthesis

The core risk is the 4-hop project.js → PlanningPanelProvider → extension.ts → KanbanProvider plumbing for the Project panel's selected project, where a missed optional-handling case at any hop silently drops the pin and reverts to the stale-DB race. Secondary risk: the memo prompt's standalone builder diverges from the shared directive constant if the implementer copies the string instead of importing it. Both are mitigable with explicit undefined-guards and a single exported constant.

## Proposed Changes

### [src/services/agentPromptBuilder.ts]

**Context:** The canonical prompt builder. `PromptBuilderOptions` interface is at `:148`. `DEFAULT_CHAT_BASE_INSTRUCTIONS` is at `:622`. The chat role branch is at `:1262-1289`. Currently no project-line text exists anywhere in the builder.

**Logic:**
1. Add `manifestProject?: string` to `PromptBuilderOptions` (`:148`). Name kept for continuity though no manifest is involved — it's the active project to pin. Add a JSDoc comment clarifying: "The active project name to pin into generated plan files. When set, emits a PROJECT PIN directive instructing the agent to write `**Project:** <name>` into each plan's metadata."
2. Add an exported `PROJECT_LINE_DIRECTIVE(project: string): string` template function near `DEFAULT_CHAT_BASE_INSTRUCTIONS`:
```
PROJECT PIN: The user had the project "<project>" active when they copied this prompt. Write this line into each plan file's metadata section (alongside **Complexity:** and **Tags:**):
**Project:** <project>
This pins the plan to that project regardless of what project is active when the file is imported. Omit the line only if no project name is given above.
```
3. In the chat role branch (`:1262`), after building `suffixBlock` (`:1273`), check `options?.manifestProject` and prepend `PROJECT_LINE_DIRECTIVE(manifestProject)` to the suffix block when set. When unset (no active project, or `UNASSIGNED_PROJECT_FILTER`), the directive is omitted entirely — the watcher falls back to `kanban.activeProjectFilter` as today.
4. Add one sentence to `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`:622`): "When the dispatch prompt carries a PROJECT PIN directive, write the `**Project:**` line into each plan file's metadata block." — closing the existing sync gap with `switchboard-chat.md`.

**Edge Cases:**
- `manifestProject` is `undefined` → directive omitted (status quo).
- `manifestProject` is empty string `''` → treat as unset (omit directive). Guard with `if (options?.manifestProject)` not `if (options?.manifestProject !== undefined)`.
- Workspace pinning needs no field: the plan file's location inside the chosen workspace's `.switchboard/plans/` IS the workspace signal, and the PLAN DESTINATION block already directs the agent to the right directory.

### [src/services/KanbanProvider.ts]

**Context:** `chatCopyPrompt` handler at `:6748-6771` calls `buildKanbanBatchPrompt('chat', chatPlans, { workspaceRoot, chatPlanDestinations })` at `:6765`. `copyGeneralChatPrompt` at `:779-787` calls the same builder at `:784`. The board's active project is persisted to the `kanban.activeProjectFilter` DB config key by `setProjectFilter` (`:344`, `:2284`, `:4957`).

**Logic:**
1. In `chatCopyPrompt` (`:6748`): read the board's active project from the DB config key `kanban.activeProjectFilter` at generation time (the established stamping source — use the same `db.getConfig` call the watcher uses). Skip when unset or `UNASSIGNED_PROJECT_FILTER`. Pass as `manifestProject` in the `buildKanbanBatchPrompt` options at `:6765`.
2. In `copyGeneralChatPrompt` (`:779`): add an optional `projectName?: string` parameter. When provided and non-empty/non-sentinel, pass it as `manifestProject` in the builder options at `:784`. When not provided, optionally read `kanban.activeProjectFilter` from the DB as a fallback (the board filter is the natural default for the general chat prompt).

**Edge Cases:**
- Board filter is `UNASSIGNED_PROJECT_FILTER` → omit `manifestProject` (don't pin to the sentinel).
- DB read fails → omit `manifestProject` (graceful fallback to status quo).

### [src/webview/project.js]

**Context:** The Project panel tracks its selected project in `_selectedProjectName` (`:1249`). The `copyChatPrompt` button handler at `:1827-1833` currently sends only `{ type: 'copyChatPrompt', workspaceRoot: ... }` — it does NOT send the project name.

**Logic:**
1. In the `btnChatCopyPrompt` click handler (`:1828`): add `project: _selectedProjectName || ''` to the `vscode.postMessage` payload at `:1830`.

**Edge Cases:**
- `_selectedProjectName` is `null` (no project selected) → send empty string → downstream omits the directive.

### [src/services/PlanningPanelProvider.ts]

**Context:** `copyChatPrompt` handler at `:2985-2992` forwards to `switchboard.copyChatPrompt` command, passing only `workspaceRoot`.

**Logic:**
1. At `:2987`: forward `msg.project` as a second argument to `vscode.commands.executeCommand('switchboard.copyChatPrompt', workspaceRoot, msg.project)`.

**Edge Cases:**
- `msg.project` is undefined/empty → pass `undefined` → `copyGeneralChatPrompt` omits the directive.

### [src/extension.ts]

**Context:** `switchboard.copyChatPrompt` command registered at `:1048-1060`. Currently accepts only `targetWorkspaceRoot?: string`.

**Logic:**
1. At `:1048`: add a second optional param `projectName?: string` to the command handler.
2. At `:1054`: pass `projectName` through to `kanbanProvider.copyGeneralChatPrompt(workspaceRoot, projectName)`.

**Edge Cases:**
- `projectName` is undefined → `copyGeneralChatPrompt` omits the directive (status quo).

### [src/services/TaskViewerProvider.ts]

**Context:** `_buildMemoPlannerPrompt` at `:2948-2981` is a standalone prompt builder (NOT routed through `buildKanbanBatchPrompt`). The `memoGeneratePrompt` handler at `:9983-10012` resolves `workspaceRoot` and calls `_buildMemoPlannerPrompt(issues, workspaceRoot)` at `:9999`.

**Logic:**
1. Import `PROJECT_LINE_DIRECTIVE` from `agentPromptBuilder.ts` (shared constant — do NOT copy the string).
2. In `memoGeneratePrompt` (`:9983`): after resolving `workspaceRoot`, read `kanban.activeProjectFilter` from the DB for that workspace. Pass the resolved project name (or undefined) to `_buildMemoPlannerPrompt`.
3. In `_buildMemoPlannerPrompt` (`:2948`): add an optional `projectName?: string` parameter. When set and non-empty, append `PROJECT_LINE_DIRECTIVE(projectName)` to the returned prompt string (after the "Important" section at `:2980`). When unset, omit it.

**Edge Cases:**
- No project filter active → directive omitted → watcher stamps from `kanban.activeProjectFilter` as today.
- Applies to both Copy Prompt and Send to Planner (same builder, same `:9999` call site).

### [.agents/workflows/switchboard-chat.md]

**Context:** The workflow file's Trigger B section (`:28-71`) covers epic grouping via manifest. The hard rules at `:14` mention the `## Metadata` section with `**Complexity:**` and `**Tags:**` but not `**Project:**`.

**Logic:**
1. Add a note (near the metadata quality gate at `:14` or in a new subsection) that when the dispatch prompt carries a PROJECT PIN directive, the agent must write the `**Project:**` line into each plan file's metadata block. Epic grouping (Trigger B) is unchanged — project pinning is orthogonal to the manifest.

**Edge Cases:**
- No PROJECT PIN directive present → agent writes no `**Project:**` line (status quo).

### [AGENTS.md]

**Context:** Source of truth for agent rules. `CLAUDE.md` and `.claude/skills` are generated copies — sync them via the existing generation path, do not hand-fork.

**Logic:**
1. Add a short subsection:
> **Plan project pinning:** When a chat or memo dispatch prompt carries a PROJECT PIN directive, write `**Project:** <name>` into each plan file's metadata block. The watcher prefers this field over the board's active project at import time, preventing the project race when the user switches projects between copying and running the prompt. No manifest is needed for project pinning — the .md metadata is the carrier.

**Edge Cases:**
- Implementer must locate the existing sync/generation mechanism for `CLAUDE.md` / `.claude/skills` and regenerate — do not hand-edit the generated copies.

### Current State (reference — no changes needed)

- `parsePlanMetadata` (`src/services/planMetadataUtils.ts:95-99`) already parses `**Project:** <name>` from the .md.
- `PlanMetadata` interface already has a `project?: string` field (`src/services/planMetadataUtils.ts:53`).
- The watcher already prefers `metadata.project` over the DB config key on both initial import (`src/services/GlobalPlanWatcherService.ts:526`) and re-imports (`:622-632`).
- `insertFileDerivedPlan` resolves `project_id` from the project name using the same lookup the manual "Assign to project" button uses — unknown names are kept as denormalized strings.

## Non-Goals

- No manifest schema change, no `PlanManifestService` change, no manifest involvement for project pinning.
- No change to `improve-plan.md` Trigger A conditional — owned by the sibling plan "Fix /improve-plan Manifest Prompting for Local Agents".
- No manifest instructions for executor/reviewer/tester dispatch prompts.
- No change to the watcher's import path — it already prefers `metadata.project` (verified at `src/services/GlobalPlanWatcherService.ts:526` and `:622-632`).

## Edge Cases (preserved from original)

- **No active project / Unassigned filter** → directive omitted; watcher stamping behaves as today (falls back to `kanban.activeProjectFilter`).
- **Project deleted between prompt and import** → unknown name is kept as a denormalized string (existing ingest rule in `insertFileDerivedPlan`); nothing breaks.
- **Agent omits the line despite the directive** → watcher falls back to `kanban.activeProjectFilter` as today; no worse than the status quo.
- **Copied chat prompt pasted to a remote (claude.ai) agent** → same directive works: the `**Project:**` line rides the git merge inside the .md and the watcher reads it on import; no manifest needed for project pinning.
- **User manually edits the .md and removes the `**Project:**` line** → on next re-import, watcher falls back to `kanban.activeProjectFilter` (existing behavior at `:626-631`); the plan may shift projects, which is the user's explicit choice.

## Verification Plan

### Automated Tests

1. **Chat-role builder tests:** `PROJECT_LINE_DIRECTIVE` present with project name when `manifestProject` set; absent when unset/empty; correct wording present. Verify the directive appears in the suffix block of the chat prompt output.
2. **Memo prompt test:** project-line directive present when a project filter is active, absent otherwise. Verify `_buildMemoPlannerPrompt` appends the shared `PROJECT_LINE_DIRECTIVE` (not a divergent copy) when `projectName` is provided.
3. **Watcher regression test:** plan .md with `**Project:** Foo` imports with `project='Foo'` even when `kanban.activeProjectFilter` is set to `'Bar'` — confirms the existing precedence at `GlobalPlanWatcherService.ts:526` still holds.
4. **Project panel plumbing test (optional):** verify `copyGeneralChatPrompt(workspaceRoot, 'MyProject')` produces a chat prompt containing the PROJECT PIN directive with "MyProject".

### Manual Verification

1. Set board to project A → copy kanban chat prompt → switch board to project B → run the prompt (agent writes plan with `**Project:** A`) → confirm the plan lands in project A, not B.
2. Memo Send to Planner with a project filter active → planner-created plans land in that project.
3. Chat prompt with no project filter active → no `**Project:**` line in the plan → watcher stamps from `kanban.activeProjectFilter` as today.
4. Project panel: select project X → click CHAT PROMPT → run prompt → plan lands in project X (not the board's active project).
