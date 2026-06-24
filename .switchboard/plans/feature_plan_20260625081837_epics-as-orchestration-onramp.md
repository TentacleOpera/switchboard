# Epic Orchestration in the Epics Tab — Orchestrator Role, No Board Column

## Goal

Give epics **one legible way to be run end-to-end by the CLI's native subagent orchestration**, and put it **only in the Epics tab of `project.html`** — never on the kanban board. The board keeps the epic-as-traveller compaction model (an epic is one card; the column agents batch-process its subtasks stage-by-stage). Orchestration is a separate, explicit Epics-tab action so the board stays uncluttered and the two ways of running an epic don't visually collide. Introduce an `orchestrator` agent role whose prompt is edited **alongside every other role** (not in a bespoke per-epic modal), and **remove the confusing on-board epic-manage modal**.

### Problem analysis & root cause (verified against live code + the drafted epic plans)

There are two legitimate ways to action an epic, and the confusion comes from trying to host both on the board:

1. **Step it through columns (the traveller).** Today an epic rides the board as a single compaction card. When it is advanced/dispatched from a column, `_cardsToPromptPlans` (`KanbanProvider.ts:2407+`) expands it into epic + all subtasks and that column's agent (planner/lead/coder/…) receives one batch prompt covering every subtask, with `EPIC_ORCHESTRATION_DIRECTIVE` (`agentPromptBuilder.ts:320-325`) prepended. **This already gives "column agents action the epic with its subtask instructions"** — it is the value of the traveller, especially for small epics where one card grouping 3 subtasks reads far better than 3 loose cards in a 20-card column. The drafted plan **`kanban-epic-subtask-column-leak-and-backlog-cascade`** (epic = one rigid unit at board level; subtasks cascade and stay hidden) is the right model and is preserved — **with one correction (Decision #8): subtasks never diverge across stages and never render as individual board cards, so on-board epic *focus mode* is removed.** The "look inside an epic" surface is the **Epics tab**, not a board filter.

2. **Orchestrate it (hand-off to one agent).** The alternative is to hand the *whole* epic to a single agent that uses its native subagents/worktrees to do every subtask in one shot — instead of the user manually stepping it column-to-column. This is the "activate the CLI orchestration features" use the board does not currently expose as a distinct, clear affordance.

**Root cause of the confusion:** putting orchestration *on the board* (a dedicated column, or an on-card toggle) competes with the pipeline the epic is already travelling through, and the existing on-board **epic-manage modal** (`kanban.html:3121-3150`) makes it worse — it is opened per-epic-card but **saves global config** (`epic_prompt_template` / `epic_max_subtasks` / `epic_lock_columns` are DB `config` keys, not per-epic), so it reads as per-epic settings that silently aren't. The fix is to **take orchestration off the board entirely**: the board does step-it; the **Epics tab** does orchestrate-it; the orchestration *prompt* is a normal global role prompt edited with the other roles.

### What this delivers

- A new **`orchestrator` role** (no kanban column) whose prompt is editable in the standard per-role "Customize Default Prompts" UI — confirmed auto-generated from `BUILT_IN_AGENT_LABELS` (`setup.html:1643`), so registering the role surfaces its prompt tab for free.
- An **Epics-tab "Orchestrate" action** that assembles `orchestrator-prompt + this epic's subtasks` (reusing the existing epic-expansion path) and copies it / dispatches it to the orchestrator terminal.
- **Removal of the kanban epic-manage modal**, with its still-needed capabilities (epic delete, add/remove subtask, config) relocated to the Epics tab so nothing is lost.
- Migration of the legacy global keys into the orchestrator role config, killing the "per-epic UI saving global state" smell.

## Relationship to the drafted epic plans (dependencies, not overlaps)

This plan **depends on** and must land after:

- **`feature_plan_20260625120001_review-epic-opens-kanban-tab-not-epic-tab.md`** — routes the epic **Review** button to the **Epics tab**. This plan relies on that: the Epics tab is where orchestration lives, and Review is the navigation into it. (Do **not** re-spec this routing here.)
- **`kanban-epic-subtask-column-leak-and-backlog-cascade.md`** — establishes epic = one unit on the board (cascade + subtasks hidden). The traveller/step-it path this plan preserves *is* that model. (§1 already implemented in the working tree.)
- **`kanban-epic-focus-worktree-decouple.md`** — focus mode as the first-class way to drop into an epic's subtasks on the board. Orthogonal to orchestration; untouched here.

This plan adds **only** the orchestrate-it path + the role + the modal removal. It does not change board dispatch, cascade, or focus behavior.

## Metadata

- **Tags:** `feature`, `epics`, `orchestration`, `roles`, `project-panel`, `ui`, `prompt`
- **Complexity:** 7/10 (new role across many enumeration touch-points; relocating management UI between two webviews; migrating shipped global config keys)
- **Depends on:** `review-epic-opens-kanban-tab-not-epic-tab` (Review→Epics nav), `kanban-epic-subtask-column-leak-and-backlog-cascade` (epic-as-unit), `kanban-epic-focus-worktree-decouple` (focus mode). All three drafted; sequence after them.

## Decisions (made, not deferred)

1. **Orchestration lives ONLY in the Epics tab.** No orchestrator board column, no on-board orchestrate toggle. The board keeps the traveller + focus model untouched.
2. **New `orchestrator` role, with NO kanban column.** Register it across the role enumerations (below) so its prompt edits "with everyone else" and it is a dispatch-by-role target — but do **not** add it to `DEFAULT_KANBAN_COLUMNS`. No column references `role:'orchestrator'`, so no lane appears.
3. **The orchestration prompt is GLOBAL** — it is the orchestrator role's prompt (base branch in `agentPromptBuilder.ts` + the per-role override from setup). The Epics tab only *triggers and previews* it for a chosen epic. This resolves the per-epic-vs-global smell.
4. **Migrate the legacy global keys.** On first read, import `epic_prompt_template` → orchestrator role prompt override and `epic_max_subtasks` → an orchestrator config/addon; keep reading the legacy keys as fallback (shipped keys — never drop, per CLAUDE.md). `epic_lock_columns` is dormant (its default `IN PROGRESS,CODE REVIEW,REVIEWED,DONE` matches no real column id) — treat the stale default as unset; preserve any non-default user value.
5. **Remove the kanban epic-manage modal entirely**, relocating its still-needed capabilities to the Epics tab FIRST (no capability regression): epic **delete** (Epics tab has none today), **add-subtask** (only bulk-add via the EPIC strip button survives on the board), and config (now the orchestrator role prompt + Epics-tab orchestration settings). Preserve shared messages used elsewhere.
6. **Orchestrate action = copy prompt by default, optional send-to-terminal.** Baseline: assemble and copy to clipboard (works regardless of terminal state). Optional: dispatch to the orchestrator terminal via `dispatchCustomPromptToRole('orchestrator', …)`.
7. **Per-CLI keyword injection is an optional later phase** (Phase 4), implemented as an orchestrator addon with a fail-safe map (unknown CLI → inject nothing), deriving the target CLI from the role's startup-command binary (`TaskViewerProvider.ts:6671`). The universal `EPIC_ORCHESTRATION_DIRECTIVE` stays agnostic.

## User Review Required

None — all forks decided. One product note: Decision #1 deliberately keeps the epic a board traveller (your compaction rationale for small epics) and confines orchestration to the Epics tab. If you ever want orchestration discoverable from the board, the clean hook is a single "Open in Epics tab" affordance on the epic card (reusing the plan-#1 Review nav) — not an on-board column.

## Complexity Audit

### Routine
- Building the Epics-tab orchestration UI by following the established `.kanban-log-overlay`/`.kanban-log-modal` modal pattern (`project.html:1455-1480`) and the `vscode.postMessage` / `window.addEventListener('message')` convention (`project.js:277+`).
- Relocating subtask add/remove + epic delete into the Epics tab — `removeSubtaskFromEpic` is already used there (`project.js:1377-1386`); `addSubtaskToEpic` and `deleteEpic` handlers already exist in both `KanbanProvider.ts` and `PlanningPanelProvider.ts`, so the Epics tab just needs to send them.
- Adding the orchestrator role to the dynamic per-role prompt UI — free once it is in `BUILT_IN_AGENT_LABELS` (`setup.html:1643` filters that list).

### Complex / Risky
- **New role across many enumerations.** A role must be added in lockstep to: `BuiltInAgentRole` (`agentConfig.ts:1`), `BUILT_IN_AGENT_LABELS` (`agentConfig.ts:87-99` **and** the webview copy in `sharedDefaults.js`), `DEFAULT_VISIBLE_AGENTS` (`sharedDefaults.js:2-18`), `DEFAULT_ROLE_CONFIG` + `ROLE_ADDONS` (`sharedDefaults.js`), `getVisibleAgents` defaults (`TaskViewerProvider.ts:3600-3615`), `PlanningPanelProvider` visible-agent defaults (`:7716-7721`), the `buildKanbanBatchPrompt` role branch + the "unknown role" error list (`agentPromptBuilder.ts:494-1193`), `_getDefaultPromptOverrides` roles array (`KanbanProvider.ts:2517`), and the role-config snapshot (`KanbanProvider.ts:2923-2935`). **Miss one and the role silently misbehaves.** Note: `columnToPromptRole` (`agentPromptBuilder.ts:1200-1218`) needs NO entry since there is no orchestrator column.
- **Orchestrator base prompt branch.** `buildKanbanBatchPrompt` throws on unknown roles — the orchestrator needs a real base-instruction branch (assemble: orchestrator base + `EPIC_ORCHESTRATION_DIRECTIVE` + subtask list + optional CLI keyword).
- **Migrating shipped config keys.** `epic_prompt_template` / `epic_max_subtasks` exist on released installs (written by both `KanbanProvider.updateEpicConfig` and `PlanningPanelProvider`). Import-then-supersede; never drop.
- **Modal removal without capability loss.** The board modal is the ONLY current UI for epic delete and dropdown add-subtask; those must exist in the Epics tab before/as the modal is removed.
- **No-column role must not create a phantom lane or break visibility filters.** Confirm `_filterVisibleColumns` / `_filterDynamicColumns` never synthesize a column for a role that has none.

## Edge-Case & Dependency Audit

- **Team-lead remnants:** none in active code (only stale docs/archived plans) — this is a genuinely new role, not a revival.
- **Shared messages on modal removal:** `addSubtaskToEpic` is also sent by the EPIC strip button's bulk convert/add path (`kanban.html:9341-9356`) — keep the handler; only remove the modal's call site. `removeSubtaskFromEpic` is used by the Epics tab — keep. `updateEpicConfig` is also handled by `PlanningPanelProvider` — keep. `kanbanEpicDetails` is used ONLY by the board modal — safe to remove. `deleteEpic` is unique to the modal — relocate to the Epics tab, do not delete the handler.
- **Orchestrator with no terminal:** if no orchestrator terminal exists, the Orchestrate action must still copy the prompt (don't hard-fail on missing dispatch target).
- **Max-subtasks cap still applies** to the assembled orchestration prompt (reuse the existing `epic_max_subtasks`/addon limit + the `[WARNING: N subtasks …]` line).
- **Preview = dispatch parity:** the Epics-tab preview must be assembled by the same code path the Orchestrate action dispatches, or it will drift.
- **Per-CLI fail-safe (Phase 4):** undetected/wrapper/aliased binary or empty map → inject nothing; never emit one CLI's keyword to another; agnostic directive always remains.
- **No confirmation dialogs** anywhere (project rule) — epic delete in the Epics tab executes immediately, like every other delete.

## Proposed Changes

### Phase 1 — `orchestrator` role (no column) + prompt "with everyone else"
- `agentConfig.ts`: add `'orchestrator'` to `BuiltInAgentRole` (`:1`) and `orchestrator: 'Orchestrator'` to `BUILT_IN_AGENT_LABELS` (`:87-99`). **Do not** touch `DEFAULT_KANBAN_COLUMNS`.
- `sharedDefaults.js`: add orchestrator to the webview `BUILT_IN_AGENT_LABELS` list, `DEFAULT_VISIBLE_AGENTS`, `DEFAULT_ROLE_CONFIG`, `ROLE_ADDONS` (include an `epicMaxSubtasks` and, later, per-CLI keyword addon).
- `TaskViewerProvider.ts:3600-3615` and `PlanningPanelProvider.ts:7716-7721`: add `orchestrator` to visible-agent defaults.
- `agentPromptBuilder.ts`: add an `if (role === 'orchestrator')` base-instruction branch in `buildKanbanBatchPrompt` (`:494-1193`) and add `orchestrator` to the unknown-role error list (`:1193`). The branch assembles orchestrator base + `EPIC_ORCHESTRATION_DIRECTIVE` + subtask list (+ optional CLI keyword in Phase 4).
- `KanbanProvider.ts`: add `'orchestrator'` to the `_getDefaultPromptOverrides` roles array (`:2517`) and an `orchestratorConfig` in the role-config snapshot (`:2923-2935`).
- **Migration:** on first orchestrator-config read, import legacy `epic_prompt_template` → orchestrator prompt override and `epic_max_subtasks` → orchestrator `epicMaxSubtasks`; keep reading legacy keys as fallback.

### Phase 2 — Epics-tab orchestration + relocate epic management (`project.html` / `project.js` / `PlanningPanelProvider.ts`)
- Add an **"Orchestrate"** button per epic (and/or in the preview meta-bar). On click, request a backend-assembled orchestration prompt (`previewEpicPrompt`-style) and copy it; optional "Send to Orchestrator" → `dispatchCustomPromptToRole('orchestrator', …)`.
- Add a **live preview** pane and a short "How epics work" explainer (step-on-the-board vs orchestrate-here).
- Add **epic delete** and **add-subtask** UI to the Epics tab (send existing `deleteEpic` / `addSubtaskToEpic`); `removeSubtaskFromEpic` already wired (`project.js:1377-1386`).
- Backend: `PlanningPanelProvider` already handles `getEpicDetails`/`updateEpicConfig`/`addSubtaskToEpic`/`removeSubtaskFromEpic`/`deleteEpic`; add a `previewEpicPrompt` (or reuse `getEpicDetails`) that returns the assembled orchestrator prompt for the chosen epic via the same builder the dispatch uses.

### Phase 3 — Remove the kanban epic-manage modal (`kanban.html` / `KanbanProvider.ts`)
- Delete the modal HTML (`:3121-3150`), `openEpicManageModal`/`closeEpicManageModal`/`populateEpicManageModal` (`:7218-7279`) and the modal listeners (`:9393-9439`).
- Remove the modal-open path on the EPIC strip button (`:9335-9340`) while **keeping** its convert-to-epic / bulk-add-subtask path (`:9341-9356`).
- Remove the `kanbanEpicDetails` message (sender `KanbanProvider.ts:7466-7469` `source:'kanban'` branch; receiver `kanban.html:6600-6601`). Keep `getEpicDetails`/`updateEpicConfig`/`addSubtaskToEpic`/`removeSubtaskFromEpic`/`deleteEpic` handlers (shared / relocated).

### Phase 4 (optional) — Per-CLI orchestration keyword
- Add `targetCli`/`epicCliKeyword` to `PromptBuilderOptions`; in the orchestrator branch, append a delimited keyword line only when a keyword is mapped. In the dispatch path, derive the CLI binary from `getStartupCommands(workspaceRoot)['orchestrator']` first token; look up an `epic_cli_keywords` config map; unknown → inject nothing.

## Verification Plan

> Manual verification against an installed VSIX (per project norm). Compile/tests run separately.

1. **Role registration:** orchestrator appears in the per-role "Customize Default Prompts" modal; its prompt saves/loads; `buildKanbanBatchPrompt('orchestrator', …)` does not throw. Confirm **no** new kanban column appears and no phantom lane is synthesized.
2. **Migration:** seed legacy `epic_prompt_template`/`epic_max_subtasks` → confirm they import into the orchestrator prompt/limit; legacy `epic_lock_columns` stale default treated as unset.
3. **Epics-tab orchestrate:** open an epic, click Orchestrate → assembled prompt (orchestrator base + directive + subtasks, capped at max) is copied; optional send-to-terminal dispatches to the orchestrator. Preview matches the dispatched prompt exactly.
4. **Capability parity after removal:** delete an epic from the Epics tab; add and remove subtasks from the Epics tab — all work. The board's EPIC strip button still converts/bulk-adds.
5. **Board untouched:** the traveller still advances an epic as a unit with cascade; focus mode still works; column dispatch still batch-processes subtasks. Review on an epic still lands in the Epics tab (plan #1).
6. **Modal gone:** no epic-manage modal opens from the board; no dead listeners or `kanbanEpicDetails` traffic.
7. **(Phase 4)** keyword injected only for a mapped CLI; absent/unknown CLI → directive only.

## Uncertain Assumptions

None requiring research. Touch-points verified: role enumerations (`agentConfig.ts:1,87-99`; `sharedDefaults.js`; `TaskViewerProvider.ts:3600-3615`; `PlanningPanelProvider.ts:7716-7721`; `agentPromptBuilder.ts:494-1193,1200-1218`; `KanbanProvider.ts:2517,2923-2935`), dynamic per-role prompt UI (`setup.html:1643`), epic expansion + directive (`KanbanProvider.ts:2407+`; `agentPromptBuilder.ts:320-325,485-490`), the board modal removal surface (`kanban.html:3121-3150,7218-7279,9335-9356,9393-9439,6600-6601`), shared message handlers (`KanbanProvider.ts` + `PlanningPanelProvider.ts` epic cases), legacy config keys and the dormant `epic_lock_columns` default (`KanbanProvider.ts:7260-7262`), and the CLI-binary parse (`TaskViewerProvider.ts:6671`).

---

**Recommendation:** Sequence after the three drafted epic plans land (this plan assumes the Review→Epics nav and the epic-as-unit board model). Ship Phase 2 (Epics-tab orchestration + relocated management) and Phase 3 (modal removal) together so capabilities never regress; Phase 1 (role) underpins both; Phase 4 (per-CLI keyword) is optional polish. Complexity 7/10 — consider `/improve-plan` for an adversarial pass on the role-enumeration completeness before execution.
