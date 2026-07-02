# Plan-Import Manifest Split — Creators Pin Project, Reviewers Don't Touch It

## Goal

Split manifest guidance into two explicit mechanisms: agents that **create** initial plans (chat consultations from kanban.html / project.html, memo processing from implementation.html) MUST write a plan-import manifest pinning the workspace + project that was active **when the user sent the prompt**; agents that **review** plans via improve-plan write a manifest ONLY in remote sessions (no running extension) and never when dispatched locally.

### Problem analysis / root cause

The plan-import manifest (`.switchboard/plans/manifest.json`, ingested by `PlanManifestService` via `GlobalPlanWatcherService`, consume-then-delete) was added for remote planners (claude.ai agents) to tell the extension where a plan belongs — column + project — when their work arrives via git merge. That flow works well.

Two problems remain:

1. **Project race for locally created plans.** When a chat/memo agent creates plan files, the watcher stamps each plan's project from the DB `kanban.activeProjectFilter` config key **at file-write time** — potentially minutes after the user clicked the prompt button. If the user has meanwhile clicked into another project or workspace, the plan lands in the wrong project. The project the user intended is only knowable at **prompt-generation time**, so it must ride the prompt and come back via the manifest (whose project assignment the ingestor always applies, even when the column override is skipped).
2. **Local reviewers still told to write manifests.** `.agents/workflows/improve-plan.md:89-128` says "**Always** (Trigger A): you have adversarially reviewed a plan → emit `kanbanColumn: "PLAN REVIEWED"`" with no local/remote distinction. Locally dispatched planners pointlessly write manifests; the extension owns all column moves for local dispatches.

None of the three creator surfaces currently mentions the manifest or carries a project:
- kanban.html `CHAT PROMPT` → `chatCopyPrompt` handler (`KanbanProvider.ts:6715-6738`) → `buildKanbanBatchPrompt('chat', …)`.
- project.html `CHAT PROMPT` → `switchboard.copyChatPrompt` command (`extension.ts:1047`) → `copyGeneralChatPrompt` (`KanbanProvider.ts:768-776`) → same chat builder. `PlanningPanelProvider.ts:2984` passes only `workspaceRoot`.
- implementation.html Memo `Copy Prompt` / `Send to Planner` → `memoGeneratePrompt` (`TaskViewerProvider.ts:9954`) → `_buildMemoPlannerPrompt` (`TaskViewerProvider.ts:2948`), a standalone prompt not routed through the builder.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, docs

## Current State

- Manifest v1 schema already supports `project` (denormalized name, resolved to `project_id` at ingest; unknown names kept as strings) — **no schema change needed**.
- `PlanManifestService` already applies `project` unconditionally and only gates the **column** override on the row still being `CREATED` — the pinning semantics we need already exist on the ingest side.
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`agentPromptBuilder.ts:622`) claims sync with `switchboard-chat.md` but contains no manifest text while the workflow file requires Trigger B on epic grouping (pre-existing sync gap — fixed here).
- Control-plane rule: edit `.agents/workflows/*` + `AGENTS.md` (source of truth); `CLAUDE.md` / `.claude/skills` are generated copies — sync them via the existing generation path, do not hand-fork.

## Proposed Changes

### 1. New creator-manifest directive in the prompt builder

`agentPromptBuilder.ts`: add `manifestProject?: string` and `manifestPlansDir?: string` to `PromptBuilderOptions`, and a `PLAN_MANIFEST_DIRECTIVE(project, plansDir)` template emitted by the **chat** role branch when `manifestProject` is set:

```
PLAN MANIFEST: After writing the plan file(s), also write `<plansDir>/manifest.json` (if it already exists, append your entries to its "plans" array):
{"version": 1, "plans": [{"planFile": "<plan filename>.md", "kanbanColumn": "CREATED", "project": "<project>"}]}
One entry per plan file you created. Write it LAST, after all plan files. This pins each plan to the "<project>" project even if the active project changes before import. Do not use any other kanbanColumn value.
```

When `manifestProject` is unset (no active project, or the Unassigned filter) the directive is omitted entirely — there is nothing to pin. Workspace pinning needs no field: the manifest's location inside the chosen workspace's `.switchboard/plans/` IS the workspace signal, and the PLAN DESTINATION block already directs the agent to the right directory (multi-destination case: the manifest goes next to whichever plans dir the agent chose).

### 2. kanban.html chat prompt carries the board's active project

`chatCopyPrompt` handler (`KanbanProvider.ts:6715`): read the board's active project from the DB config key `kanban.activeProjectFilter` at generation time (the established stamping source) and pass it as `manifestProject` (skip when unset or `UNASSIGNED_PROJECT_FILTER`).

### 3. project.html chat prompt carries the panel's selected project

The Project panel's selected project is panel state, not the board filter, so it must ride the message: project.js sends `project` in its `copyChatPrompt` message → `PlanningPanelProvider.ts:2984` forwards it → extend `switchboard.copyChatPrompt` (`extension.ts:1047`) and `copyGeneralChatPrompt` with an optional `projectName` param → `manifestProject`.

### 4. Memo prompt gets the same directive

`_buildMemoPlannerPrompt` (`TaskViewerProvider.ts:2948`): resolve `kanban.activeProjectFilter` for the memo's workspace at generation time and append the same manifest block (shared constant from `agentPromptBuilder.ts`, not a second copy) listing one entry per plan the agent will create. Applies to both Copy Prompt and Send to Planner (same builder).

### 5. improve-plan.md: manifest becomes remote-only, self-classified

Rewrite the "Plan-Import Manifest (Trigger A)" section header and "when to emit" in `.agents/workflows/improve-plan.md`:

- **If you were dispatched by the Switchboard extension into a local terminal** (your prompt lists absolute local plan paths / worktrees): do **NOT** write a manifest — the extension owns column moves and project assignment for local dispatches.
- **If you are a remote agent** (e.g. claude.ai) whose plan files reach the extension via a git merge: emit Trigger A exactly as today (`kanbanColumn: "PLAN REVIEWED"` + `project`).

Keep the schema/field-rules/stale-guard text once, shared by both cases. No prompt-builder change for the planner role — the same copied planner prompt must work when pasted to a remote agent, so the self-classification lives in the workflow file, not the dispatch prompt.

### 6. switchboard-chat.md + DEFAULT_CHAT_BASE_INSTRUCTIONS sync

- `switchboard-chat.md`: replace "pure consultation that writes loose plans → no manifest" with the new rule: write the project-pinning manifest whenever the dispatch prompt carries a PLAN MANIFEST directive (or you otherwise know the intended project); epic grouping (Trigger B) unchanged.
- `DEFAULT_CHAT_BASE_INSTRUCTIONS` (`agentPromptBuilder.ts:622`): add one Hard Rule sentence referencing the PLAN MANIFEST directive when present — closing the existing sync gap with the workflow file.

### 7. AGENTS.md "when to write a manifest" summary

Add a short subsection to `AGENTS.md` (source of truth; regenerate `CLAUDE.md` / skills via the existing sync mechanism — implementer: locate it, do not hand-edit generated copies):

> **Plan-import manifest — when to write one:** Creating new plans with a project context (chat/memo prompts carrying a PLAN MANIFEST directive) → yes, pin `project` (+ `kanbanColumn: "CREATED"`). Remote sessions delivering reviewed plans via git → yes, Trigger A (`PLAN REVIEWED`). Epic grouping → yes, Trigger B. Locally dispatched review/execution work → never; the extension owns column moves.

### 8. Tests

- Chat-role builder tests: directive present with project + plansDir when `manifestProject` set; absent when unset; append-not-overwrite wording present.
- Memo prompt test: manifest block present when a project filter is active, absent otherwise.

## Non-Goals

- No manifest schema change (v1 `project` field suffices; workspace is positional).
- No change to `PlanManifestService` ingest semantics (project-always/column-gated already matches the design).
- No manifest instructions for executor/reviewer/tester dispatch prompts.

## Edge Cases

- **No active project / Unassigned filter** → directive omitted; watcher stamping behaves as today.
- **Existing `manifest.json` not yet consumed** (another batch within the ~10s scan window) → directive says append to the `plans` array; ingest applies per-entry, idempotent on missed deletes.
- **Manifest arrives before the `.md` import** (agent wrote them out of order despite "write it LAST") → `PlanManifestService` defers and retries (18 attempts / 10-min cap) — existing behavior.
- **User moved the card before ingest** → column override skipped by the stale guard; project still applied — exactly the pinning we want.
- **Copied chat prompt pasted to a remote (claude.ai) agent** → same directive works: the manifest rides the git merge and the ingestor applies it on scan; this is the original remote flow, now uniform with local.
- **Project deleted between prompt and ingest** → unknown name is kept as a denormalized string (existing ingest rule); nothing breaks.

## Verification Plan

1. Unit tests from §8.
2. Manual: set board to project A → copy kanban chat prompt → switch board to project B → run the prompt (agent writes plan + manifest) → confirm the plan lands in project A, not B.
3. Manual: memo Send to Planner with a project filter active → planner-created plans land in that project.
4. Manual: local planner dispatch (improve-plan) → confirm no `manifest.json` is written; board column moves still handled by the extension.

## User Review Required

None.
