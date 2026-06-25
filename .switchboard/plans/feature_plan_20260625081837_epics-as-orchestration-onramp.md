# Epic Orchestration in the Epics Tab — Orchestrator Role, No Board Column

## Goal

Give epics **one legible way to be run end-to-end by the CLI's native subagent orchestration**, and put it **only in the Epics tab of `project.html`** — never on the kanban board. The board keeps the epic-as-traveller compaction model (an epic is one card; the column agents batch-process its subtasks stage-by-stage). Orchestration is a separate, explicit Epics-tab action so the board stays uncluttered and the two ways of running an epic don't visually collide. Introduce an `orchestrator` agent role whose prompt is edited **alongside every other role** (not in a bespoke per-epic modal), and **remove the confusing on-board epic-manage modal**.

### Problem analysis & root cause (verified against live code + the drafted epic plans)

There are two legitimate ways to action an epic, and the confusion comes from trying to host both on the board:

1. **Step it through columns (the traveller).** Today an epic rides the board as a single compaction card. When it is advanced/dispatched from a column, `_cardsToPromptPlans` (`KanbanProvider.ts:2407+`) expands it into epic + all subtasks and that column's agent (planner/lead/coder/…) receives one batch prompt covering every subtask, with `EPIC_ORCHESTRATION_DIRECTIVE` (`agentPromptBuilder.ts:320-325`) prepended. **This already gives "column agents action the epic with its subtask instructions"** — it is the value of the traveller, especially for small epics where one card grouping 3 subtasks reads far better than 3 loose cards in a 20-card column. The drafted plan **`kanban-epic-subtask-column-leak-and-backlog-cascade`** (epic = one rigid unit at board level; subtasks cascade and stay hidden) is the right model and is preserved — **with one correction (Decision #8): subtasks never diverge across stages and never render as individual board cards, so on-board epic *focus mode* is removed.** The "look inside an epic" surface is the **Epics tab**, not a board filter.

2. **Orchestrate it (hand-off to one agent).** The alternative is to hand the *whole* epic to a single agent that uses its native subagents/worktrees to do every subtask in one shot — instead of the user manually stepping it column-to-column. This is the "activate the CLI orchestration features" use the board does not currently expose as a distinct, clear affordance.

**Root cause of the confusion:** putting orchestration *on the board* (a dedicated column, or an on-card toggle) competes with the pipeline the epic is already travelling through, and the existing on-board **epic-manage modal** (`kanban.html:3165-3194`) makes it worse — it is opened per-epic-card but **saves global config** (`epic_prompt_template` / `epic_max_subtasks` / `epic_lock_columns` are DB `config` keys, not per-epic), so it reads as per-epic settings that silently aren't. The fix is to **take orchestration off the board entirely**: the board does step-it; the **Epics tab** does orchestrate-it; the orchestration *prompt* is a normal global role prompt edited with the other roles.

### What this delivers

- A new **`orchestrator` role** (no kanban column) whose prompt is editable in the standard per-role "Customize Default Prompts" UI — confirmed auto-generated from `BUILT_IN_AGENT_LABELS` (`setup.html:1643`), so registering the role surfaces its prompt tab for free.
- An **Epics-tab "Orchestrate" action** that assembles `orchestrator-prompt + this epic's subtasks` (reusing the existing epic-expansion path) and copies it / dispatches it to the orchestrator terminal.
- **Removal of the kanban epic-manage modal**, with its still-needed capabilities (epic delete, add/remove subtask, config) relocated to the Epics tab so nothing is lost.
- Migration of the legacy global keys into the orchestrator role config, killing the "per-epic UI saving global state" smell.

### Epic execution modes (split mode is the primary workflow)

The board and the Epics tab are independent surfaces that **compose**, giving three ways to run an epic — no mode toggle, no stage-gating, the user controls timing:

- **Step mode** — drag the epic column-to-column; each column's agent batch-processes all subtasks (with the epic-mode subagent directive). Full manual control per stage.
- **Orchestrate mode** — from the Epics tab, click **Orchestrate**; one orchestrator agent runs the whole epic end-to-end with native subagents. Good for a cold epic you want done in one shot.
- **Split mode (the primary expected workflow)** — drag the epic to the **Planner** column so the planner improves *each* subtask plan using subagents, **then** click **Orchestrate** in the Epics tab to hand the improved epic to the orchestrator to implement. Plan with one agent, implement with another.

Split mode needs **no new mechanism**: dragging an epic to the planner column already expands it to subtasks and prepends `EPIC_ORCHESTRATION_DIRECTIVE` (verified: `generateUnifiedPrompt` sets `epicMode` from `plans.some(p => p.isSubtask)`, role-agnostically — `KanbanProvider.ts:~2896`), and Epics-tab Orchestrate is Phase 2. The only design consequence is Decision #9 (orchestrator default prompt is implementation-oriented).

## Relationship to the drafted epic plans (dependencies, not overlaps)

**Depends on (land after):**

- **`feature_plan_20260625120001_review-epic-opens-kanban-tab-not-epic-tab.md`** — routes the epic **Review** button to the **Epics tab**. This plan relies on that: the Epics tab is where orchestration *and* epic management live, and Review is the navigation into it. (Do **not** re-spec this routing here.)
- **`kanban-epic-subtask-column-leak-and-backlog-cascade.md`** §1 + §2 — epic = one rigid unit on the board (subtasks excluded from loose-column ops; cascade on move). The traveller this plan preserves *is* that model. (§1 already implemented in the working tree.)

**Amends (these drafted plans must change to match Decision #8 — confirm before either is executed):**

- **`kanban-epic-subtask-column-leak-and-backlog-cascade.md`** §3 (focus-aware column buttons) → **dropped**: with focus mode removed there is no focused-subtask column path to support. §2's cascade should generalize so **every** epic move cascades to its subtasks (not only backlog/activate).
- **`kanban-epic-focus-worktree-decouple.md`** → **headline goal rejected**: do *not* make focus mode first-class; **remove** on-board focus mode instead. Salvage only its worktree half — move per-epic worktree creation into the Worktrees tab and demote the epic card's worktree chip to a read-only branch label. The plan effectively becomes "worktree cleanup."

This plan adds the orchestrate-it path + the orchestrator role + the modal removal. It **requires** the focus-mode removal of Decision #8 but does not own it — that work lives in the two amended plans above. It does not touch dispatch routing (which is by `epic_id`, independent of focus).

## Metadata

- **Tags:** `feature`, `ui`, `backend`
- **Complexity:** 7/10 (new role across many enumeration touch-points; relocating management UI between two webviews; migrating shipped global config keys)
- **Depends on:** `review-epic-opens-kanban-tab-not-epic-tab` (Review→Epics nav), `kanban-epic-subtask-column-leak-and-backlog-cascade` (epic-as-unit), `kanban-epic-focus-worktree-decouple` (removes focus mode + worktree cleanup). All three drafted; sequence after them.

## Dependencies

- `feature_plan_20260625120001_review-epic-opens-kanban-tab-not-epic-tab.md` — routes the epic Review button to the Epics tab (navigation dependency; this plan's Epics-tab orchestration surface relies on it)
- `kanban-epic-subtask-column-leak-and-backlog-cascade.md` — epic = one rigid unit on the board; §1 + §2 must land first (§3 is dropped per Decision #8)
- `kanban-epic-focus-worktree-decouple.md` — removes on-board focus mode machinery and salvages worktree creation to the Worktrees tab (headline goal rejected; worktree cleanup half is kept)

## Decisions (made, not deferred)

1. **Orchestration lives ONLY in the Epics tab.** No orchestrator board column, no on-board orchestrate toggle. The board keeps the epic-as-traveller model; on-board focus mode is removed (Decision #8).
2. **New `orchestrator` role, full role but with NO kanban column.** Register it across **all** role enumerations (below) so (a) its prompt edits "with everyone else" in the per-role modal, (b) the user can configure its **startup command and spawn its terminal in the same agent-setup area as every other agent** (this is why it must be a full role, not an Epics-tab-local config — confirmed), and (c) it is a dispatch-by-role target. But do **not** add it to `DEFAULT_KANBAN_COLUMNS`. No column references `role:'orchestrator'`, so no lane appears. This means the built-in agent grid (`extension.ts:2626-2633`) and the setup agents list must include orchestrator so its terminal is configurable/spawnable. **Correction:** `validRoles` (`extension.ts:347`) and `rolePriority` (`extension.ts:2497`) are review-role resolution arrays, NOT terminal-setup arrays — the orchestrator must NOT be added to either, since it is not a review role and should never be a candidate for review dispatch.
3. **The orchestration prompt is GLOBAL** — it is the orchestrator role's prompt (base branch in `agentPromptBuilder.ts` + the per-role override from setup). The Epics tab only *triggers and previews* it for a chosen epic. This resolves the per-epic-vs-global smell.
4. **Migrate the legacy global keys.** On first read, import `epic_prompt_template` → orchestrator role prompt override and `epic_max_subtasks` → an orchestrator config/addon; keep reading the legacy keys as fallback (shipped keys — never drop, per CLAUDE.md). `epic_lock_columns` is dormant (its default `IN PROGRESS,CODE REVIEW,REVIEWED,DONE` matches no real column id) — treat the stale default as unset; preserve any non-default user value.
5. **Remove the kanban epic-manage modal entirely**, relocating its still-needed capabilities to the Epics tab FIRST (no capability regression): epic **delete** (Epics tab has none today), **add-subtask** (only bulk-add via the EPIC strip button survives on the board), and config (now the orchestrator role prompt + Epics-tab orchestration settings). Preserve shared messages used elsewhere.
6. **Orchestrate action = copy prompt by default, optional send-to-terminal.** Baseline: assemble and copy to clipboard (works regardless of terminal state). Optional: dispatch to the orchestrator terminal via `dispatchCustomPromptToRole('orchestrator', …)`.
7. **Per-CLI keyword injection is an optional later phase** (Phase 4), implemented as an orchestrator addon with a fail-safe map (unknown CLI → inject nothing), deriving the target CLI from the role's startup-command binary (`TaskViewerProvider.ts:6671`). The universal `EPIC_ORCHESTRATION_DIRECTIVE` stays agnostic.

8. **Remove on-board epic focus mode; the Epics tab is the focus surface.** Subtasks are a **rigid unit** with their epic — they always share its column, cascade on every move, and **never render as individual board cards** (the `displayCards.filter(card => !card.epicId)` exclusion at `kanban.html:~5086` becomes unconditional). Rejecting subtask-stage-divergence removes the only thing focus mode did, so `enterEpicFocusMode`/`clearEpicFocusMode`/`currentFocusedEpicId` and the focus banner are removed from `kanban.html`. To inspect or manage an epic's subtasks, the user opens the **Epics tab** (reached via the Review button per dependency plan #1). This **amends drafted plans #2 (drop §3) and #3 (reject focus-first-class; keep worktree-to-tab)** — see "Amends" above.

9. **Support three execution modes; split mode is primary.** Step / orchestrate / split (see "Epic execution modes"). No mode toggle and no stage-gating — modes emerge from composing the board (planning) with the Epics tab (orchestration); the user decides when to click Orchestrate. The **orchestrator role's default prompt is implementation-oriented** — it assumes the subtask plans may already have been improved (split mode) and implements them, refining a subtask plan only if it is clearly insufficient — while still working standalone on a cold epic. Users tune it via the role's prompt override "with everyone else."

## User Review Required

None — all forks decided. One product note: Decision #1 deliberately keeps the epic a board traveller (your compaction rationale for small epics) and confines orchestration to the Epics tab. If you ever want orchestration discoverable from the board, the clean hook is a single "Open in Epics tab" affordance on the epic card (reusing the plan-#1 Review nav) — not an on-board column.

## Complexity Audit

### Routine
- Building the Epics-tab orchestration UI by following the established `.kanban-log-overlay`/`.kanban-log-modal` modal pattern (`project.html:1455-1480`) and the `vscode.postMessage` / `window.addEventListener('message')` convention (`project.js:277+`).
- Relocating subtask add/remove + epic delete into the Epics tab — `removeSubtaskFromEpic` is already used there (`project.js:1397+`); `addSubtaskToEpic` and `deleteEpic` handlers already exist in both `KanbanProvider.ts` and `PlanningPanelProvider.ts` (`:2776,2826`), so the Epics tab just needs to send them.
- Adding the orchestrator role to the dynamic per-role prompt UI — free once it is in `BUILT_IN_AGENT_LABELS` (`setup.html:1643` filters that list).

### Complex / Risky
- **New role across many enumerations.** A role must be added in lockstep to: `BuiltInAgentRole` (`agentConfig.ts:1`), `BUILT_IN_AGENT_LABELS` (`agentConfig.ts:87-99` **and** the webview copy in `sharedDefaults.js:41-57`), `DEFAULT_VISIBLE_AGENTS` (`sharedDefaults.js:2-18`), `DEFAULT_ROLE_CONFIG` + `ROLE_ADDONS` (`sharedDefaults.js:21-267`), `getVisibleAgents` defaults (`TaskViewerProvider.ts:3600-3616`), `PlanningPanelProvider` visible-agent defaults (`:7724-7729`), the `buildKanbanBatchPrompt` role branch + the "unknown role" error list (`agentPromptBuilder.ts:494-1193`), `_getDefaultPromptOverrides` roles array (`KanbanProvider.ts:2550` **and** `TaskViewerProvider.ts:7340` — both have their own hardcoded roles arrays), the `VALID_ROLES` array in `parseDefaultPromptOverrides` (`agentConfig.ts:394` — without this, saved orchestrator prompt overrides are silently dropped during parsing), `handleGetDefaultPromptPreviews` roles array (`TaskViewerProvider.ts:3913` — without this, no preview appears in the Customize Default Prompts UI), and the role-config snapshot `else if` chain (`KanbanProvider.ts:2920-2942`). **Required for terminal setup (Decision #2):** the built-in agent grid `allBuiltInAgents` (`extension.ts:2626-2633`) and the setup.html agents/terminal list so its startup command is configurable and its terminal spawnable. **NOT required (correction):** `validRoles` (`extension.ts:347`) and `rolePriority` (`extension.ts:2497`) are review-role resolution arrays — the orchestrator is NOT a review role and must NOT be added to either. **Verify** that `PROMPT_OVERRIDE_EXCLUDED_KEYS` (`sharedDefaults.js:64`) does NOT include `orchestrator` (it should not — the orchestrator's prompt must be editable). **Miss one enumeration and the role silently misbehaves.** Note: `columnToPromptRole` (`agentPromptBuilder.ts:1200-1218`) needs NO entry since there is no orchestrator column.
- **Removing focus mode is a deletion across a hot webview.** `enterEpicFocusMode`/`clearEpicFocusMode`/`currentFocusedEpicId`/`renderFocusBanner` and every reference (`kanban.html:3782,5036-5054,5057-5065,5121-5124,6205-6209,9422-9448`) must be removed cleanly, and the subtask-hiding filter made unconditional. Regression surface: the main board render and drag-drop. Must not strand the worktree-chip rendering that plan #3's salvaged half still needs.
- **Orchestrator base prompt branch.** `buildKanbanBatchPrompt` throws on unknown roles (`agentPromptBuilder.ts:1193`) — the orchestrator needs a real base-instruction branch (assemble: orchestrator base + `EPIC_ORCHESTRATION_DIRECTIVE` + subtask list + optional CLI keyword).
- **Migrating shipped config keys.** `epic_prompt_template` / `epic_max_subtasks` exist on released installs (written by both `KanbanProvider.updateEpicConfig` at `:7524-7536` and `PlanningPanelProvider` at `:3000+`). Import-then-supersede; never drop. **Critical read-site:** `generateUnifiedPrompt` in `KanbanProvider.ts:2939` reads `epic_prompt_template` from the DB and injects it via `resolvedOptions.epicPromptTemplate` — after migration, this read must redirect to the orchestrator role's prompt override (or keep the legacy key as fallback per CLAUDE.md). The `kanbanEpicDetails` sender (`KanbanProvider.ts:7517-7520`) and the `updateEpicConfig` handler (`:7524-7536`) also read/write these keys and must be updated or removed as part of the modal removal in Phase 3.
- **Modal removal without capability loss.** The board modal is the ONLY current UI for epic delete and dropdown add-subtask; those must exist in the Epics tab before/as the modal is removed.
- **No-column role must not create a phantom lane or break visibility filters.** Confirm `_filterVisibleColumns` / `_filterDynamicColumns` never synthesize a column for a role that has none.

## Edge-Case & Dependency Audit

- **Team-lead remnants:** none in active code (only stale docs/archived plans) — this is a genuinely new role, not a revival.
- **Shared messages on modal removal:** `addSubtaskToEpic` is also sent by the EPIC strip button's bulk convert/add path (`kanban.html:9458-9474`) — keep the handler; only remove the modal's call site. `removeSubtaskFromEpic` is used by the Epics tab — keep. `updateEpicConfig` is also handled by `PlanningPanelProvider` — keep. `kanbanEpicDetails` is used ONLY by the board modal — safe to remove. `deleteEpic` is unique to the modal — relocate to the Epics tab, do not delete the handler.
- **Orchestrator with no terminal:** if no orchestrator terminal exists, the Orchestrate action must still copy the prompt (don't hard-fail on missing dispatch target).
- **Max-subtasks cap still applies** to the assembled orchestration prompt (reuse the existing `epic_max_subtasks`/addon limit + the `[WARNING: N subtasks …]` line).
- **Preview = dispatch parity:** the Epics-tab preview must be assembled by the same code path the Orchestrate action dispatches, or it will drift.
- **Per-CLI fail-safe (Phase 4):** undetected/wrapper/aliased binary or empty map → inject nothing; never emit one CLI's keyword to another; agnostic directive always remains.
- **No confirmation dialogs** anywhere (project rule) — epic delete in the Epics tab executes immediately, like every other delete.

## Adversarial Synthesis

Key risks: (1) silent prompt-override loss if any of the three newly identified enumeration touch-points (`parseDefaultPromptOverrides` VALID_ROLES, `TaskViewerProvider._getDefaultPromptOverrides` roles array, `handleGetDefaultPromptPreviews` roles array) are missed; (2) incorrect review-dispatch behavior if `orchestrator` is added to `validRoles`/`rolePriority` (now corrected — these are review-role arrays, not terminal-setup); (3) stale `epic_prompt_template` read in `generateUnifiedPrompt` producing empty prompts post-migration if the read site is not redirected. Mitigations: all three missing enumerations are now explicitly listed in Phase 1; the `validRoles`/`rolePriority` error is corrected in Decision #2 and the Complex/Risky audit; the `generateUnifiedPrompt` read-site migration is specified in Phase 1 with legacy fallback per CLAUDE.md.

## Proposed Changes

### Phase 1 — `orchestrator` role (no column) + prompt "with everyone else"
- `agentConfig.ts`: add `'orchestrator'` to `BuiltInAgentRole` (`:1`), `orchestrator: 'Orchestrator'` to `BUILT_IN_AGENT_LABELS` (`:87-99`), and `'orchestrator'` to the `VALID_ROLES` array in `parseDefaultPromptOverrides` (`:394`). **Do not** touch `DEFAULT_KANBAN_COLUMNS`.
- `sharedDefaults.js`: add orchestrator to the webview `BUILT_IN_AGENT_LABELS` list (`:41-57`), `DEFAULT_VISIBLE_AGENTS` (`:2-18`), `DEFAULT_ROLE_CONFIG` (`:21-38`), `ROLE_ADDONS` (`:67-267` — include an `epicMaxSubtasks` and, later, per-CLI keyword addon). Verify `PROMPT_OVERRIDE_EXCLUDED_KEYS` (`:64`) does NOT include `orchestrator`.
- `TaskViewerProvider.ts`: add `orchestrator` to `getVisibleAgents` defaults (`:3600-3616`), to `_getDefaultPromptOverrides` roles array (`:7340`), and to `handleGetDefaultPromptPreviews` roles array (`:3913`).
- `PlanningPanelProvider.ts:7724-7729`: add `orchestrator` to visible-agent defaults.
- `agentPromptBuilder.ts`: add an `if (role === 'orchestrator')` base-instruction branch in `buildKanbanBatchPrompt` (`:494-1193`) and add `orchestrator` to the unknown-role error message (`:1193`). The branch assembles orchestrator base + `EPIC_ORCHESTRATION_DIRECTIVE` + subtask list (+ optional CLI keyword in Phase 4). Per Decision #9 the **base is implementation-oriented** ("the subtask plans may already be improved — implement them with native subagents; refine a plan only if clearly insufficient").
- `KanbanProvider.ts`: add `'orchestrator'` to the `_getDefaultPromptOverrides` roles array (`:2550`) and an `orchestratorConfig` branch in the role-config snapshot `else if` chain (`:2920-2942`).
- `extension.ts`: add `{ name: 'Orchestrator', role: 'orchestrator' }` to `allBuiltInAgents` (`:2626-2633`). **Do NOT** add to `validRoles` (`:347`) or `rolePriority` (`:2497`) — those are review-role resolution only.
- **Migration:** on first orchestrator-config read, import legacy `epic_prompt_template` → orchestrator prompt override and `epic_max_subtasks` → orchestrator `epicMaxSubtasks`; keep reading legacy keys as fallback. **Update the read site** in `generateUnifiedPrompt` (`KanbanProvider.ts:2939`) to source the epic prompt template from the orchestrator role config (with legacy DB key as fallback per CLAUDE.md).

### Phase 2 — Epics-tab orchestration + relocate epic management (`project.html` / `project.js` / `PlanningPanelProvider.ts`)
- Add an **"Orchestrate"** button per epic (and/or in the preview meta-bar). On click, request a backend-assembled orchestration prompt (`previewEpicPrompt`-style) and copy it; optional "Send to Orchestrator" → `dispatchCustomPromptToRole('orchestrator', …)`.
- Add a **live preview** pane and a short "How epics work" explainer documenting the three execution modes (step / orchestrate / **split**), featuring split mode: "drag the epic to the Planner column to improve every subtask plan, then click Orchestrate here to implement."
- Add **epic delete** and **add-subtask** UI to the Epics tab (send existing `deleteEpic` / `addSubtaskToEpic`); `removeSubtaskFromEpic` already wired (`project.js:1397+`).
- Backend: `PlanningPanelProvider` already handles `getEpicDetails`/`updateEpicConfig`/`addSubtaskToEpic`/`removeSubtaskFromEpic`/`deleteEpic`; add a `previewEpicPrompt` (or reuse `getEpicDetails`) that returns the assembled orchestrator prompt for the chosen epic via the same builder the dispatch uses.

### Phase 3 — Remove the kanban epic-manage modal (`kanban.html` / `KanbanProvider.ts`)
- Delete the modal HTML (`:3165-3194`), `openEpicManageModal`/`closeEpicManageModal`/`populateEpicManageModal` (`:7326-7361+`) and the modal listeners (`:9510-9529`).
- Remove the modal-open path on the EPIC strip button (`:9452-9457`) while **keeping** its convert-to-epic / bulk-add-subtask path (`:9458-9474`).
- Remove the `kanbanEpicDetails` message (sender `KanbanProvider.ts:7517-7520` `source:'kanban'` branch; receiver `kanban.html:6653-6654`). Keep `getEpicDetails`/`updateEpicConfig`/`addSubtaskToEpic`/`removeSubtaskFromEpic`/`deleteEpic` handlers (shared / relocated). Also remove or redirect the `updateEpicConfig` handler's writes to legacy `epic_lock_columns`/`epic_prompt_template`/`epic_max_subtasks` keys (`KanbanProvider.ts:7524-7536`) — these are superseded by the orchestrator role config migration in Phase 1.

### Phase 3b — On-board focus-mode removal (owned by the amended drafted plans; dependency, not re-specced here)
Focus-mode removal and the rigid-unit board behavior that Decision #8 requires are **owned by the two amended drafted plans**, and this plan depends on them landing — it does not re-implement them:
- `kanban-epic-subtask-column-leak-and-backlog-cascade.md` → unconditional `!card.epicId` exclusion (§1) + cascade on every epic move (§2). (§3 dropped.)
- `kanban-epic-focus-worktree-decouple.md` → deletes the focus machinery (`enterEpicFocusMode`/`clearEpicFocusMode`/`currentFocusedEpicId`/`renderFocusBanner`) and salvages the worktree half (creation → Worktrees tab; chip → label).

This plan's only stake here is the **consequence**: with focus mode gone, the **Epics tab (Phase 2) is the sole surface for inspecting/managing an epic's subtasks** — which is exactly what Phase 2 builds. If those two plans are deferred, Phase 2 must not assume focus mode is already gone.

### Phase 4 (optional) — Per-CLI orchestration keyword
- Add `targetCli`/`epicCliKeyword` to `PromptBuilderOptions`; in the orchestrator branch, append a delimited keyword line only when a keyword is mapped. In the dispatch path, derive the CLI binary from `getStartupCommands(workspaceRoot)['orchestrator']` first token; look up an `epic_cli_keywords` config map; unknown → inject nothing.

## Verification Plan

> Manual verification against an installed VSIX (per project norm). Compile/tests run separately.

### Automated Tests

Per session directive, automated tests (unit, integration, e2e) are skipped in this planning session — the test suite will be run separately by the user. No compilation step is run either (project is in a pre-compiled/compilation-free state). The manual steps below are the verification plan.

### Manual Verification

1. **Role registration:** orchestrator appears in the per-role "Customize Default Prompts" modal; its prompt saves/loads; `buildKanbanBatchPrompt('orchestrator', …)` does not throw. Confirm **no** new kanban column appears and no phantom lane is synthesized. Verify `_filterDynamicColumns` (`KanbanProvider.ts:2397-2409`) does not create a column for a role with no column definition (it only filters existing columns — confirmed safe).
1a. **Prompt override round-trip (critical):** save an orchestrator prompt override in the Customize Default Prompts UI → reload the webview → confirm the override persists (tests `parseDefaultPromptOverrides` VALID_ROLES at `agentConfig.ts:394`, `_getDefaultPromptOverrides` roles array at `TaskViewerProvider.ts:7340`, and `handleGetDefaultPromptPreviews` at `:3913`). Confirm a non-empty preview appears for the orchestrator tab.
2. **Migration:** seed legacy `epic_prompt_template`/`epic_max_subtasks` → confirm they import into the orchestrator prompt/limit; legacy `epic_lock_columns` stale default treated as unset.
3. **Epics-tab orchestrate:** open an epic, click Orchestrate → assembled prompt (orchestrator base + directive + subtasks, capped at max) is copied; optional send-to-terminal dispatches to the orchestrator. Preview matches the dispatched prompt exactly.
4. **Split mode (primary workflow):** drag an epic to the Planner column → the planner receives all subtask plans with the subagent directive and improves each; the epic stays a single board card and advances as a unit (no per-subtask cards). Then click **Orchestrate** in the Epics tab → the orchestrator receives the now-improved subtask plans to implement. Confirm the two stages chain cleanly and the orchestrator prompt reflects the improved plan files.
5. **Capability parity after removal:** delete an epic from the Epics tab; add and remove subtasks from the Epics tab — all work. The board's EPIC strip button still converts/bulk-adds.
6. **Board traveller intact, focus gone:** the epic still advances as a unit and cascades to all subtasks on **every** move; column dispatch still batch-processes subtasks; subtasks **never** appear as individual board cards; no focus banner/affordance exists; Review on an epic lands in the Epics tab (plan #1). Drag-drop and the main board render are not regressed by the focus-machinery deletion.
7. **Modal gone:** no epic-manage modal opens from the board; no dead listeners or `kanbanEpicDetails` traffic.
8. **Worktree salvage:** per-epic worktree creation works from the Worktrees tab; the epic card's chip is a read-only branch label; subtask dispatch still runs in the epic's worktree (routing by `epic_id` unchanged).
9. **(Phase 4)** keyword injected only for a mapped CLI; absent/unknown CLI → directive only.

## Uncertain Assumptions

None requiring research. All touch-points verified against live code in this pass: role enumerations (`agentConfig.ts:1,87-99,394`; `sharedDefaults.js:2-18,21-267,41-57,64`; `TaskViewerProvider.ts:3600-3616,3913,7340`; `PlanningPanelProvider.ts:7724-7729`; `agentPromptBuilder.ts:494-1193,1193,1200-1218`; `KanbanProvider.ts:2550,2920-2942,2939`; `extension.ts:347,2497,2626-2633`), dynamic per-role prompt UI (`setup.html:1643`), epic expansion + directive (`KanbanProvider.ts:2407+`; `agentPromptBuilder.ts:320-325,485-490`), the board modal removal surface (`kanban.html:3165-3194,7326-7361,9452-9474,9510-9529,6653-6654`), focus-mode machinery (`kanban.html:3782,5036-5065,5121-5124,6205-6209,9422-9448`), shared message handlers (`KanbanProvider.ts:7517-7536` + `PlanningPanelProvider.ts:2759-2847,3000+`), legacy config keys and the dormant `epic_lock_columns` default, `dispatchCustomPromptToRole` (`TaskViewerProvider.ts:2634-2646`), `_resolveAgentTerminalForPlan` (`:5945-5955`), and the CLI-binary parse (`TaskViewerProvider.ts:6671`).

---

**Recommendation:** Sequence after the three drafted epic plans land (this plan assumes the Review→Epics nav and the epic-as-unit board model). Ship Phase 2 (Epics-tab orchestration + relocated management) and Phase 3 (modal removal) together so capabilities never regress; Phase 1 (role) underpins both; Phase 4 (per-CLI keyword) is optional polish. Complexity 7/10 — **Send to Lead Coder** (multi-file coordination across 8+ source files, new role enumeration pattern, shipped-config migration). The adversarial pass found and fixed 3 missing enumeration touch-points, 1 incorrect touch-point (`validRoles`/`rolePriority`), and 1 unspecified migration read-site; all line numbers have been corrected against live code.

## Reviewer Pass (2026-06-25)

### Stage 1 — Adversarial Findings

| Severity | Finding | Location |
|----------|---------|----------|
| CRITICAL | None — all 15+ enumeration touch-points verified complete | — |
| MAJOR | `epicMaxSubtasks` addon missing from `ROLE_ADDONS` — plan Phase 1/Decision #4 explicitly calls for it; old modal's "Max Subtasks" field was removed with no UI replacement | `sharedDefaults.js:266-281` |
| MAJOR | `updateEpicConfig` handlers still write to superseded `epic_prompt_template` and dormant `epic_lock_columns` legacy keys — plan Phase 3 says "remove or redirect" | `KanbanProvider.ts:7617-7637`, `PlanningPanelProvider.ts:3045-3056` |
| NIT | `handleGetDefaultPromptPreviews` roles array pre-existing missing `ticket_updater`/`researcher`/`splitter`/`gatherer` (not introduced by this plan) | `TaskViewerProvider.ts:3914` |
| NIT | `'preview'` mode in orchestration backend is dead code — no UI button sends it | `project.js` `requestEpicOrchestration` |

### Stage 2 — Balanced Synthesis

**Verified correct (keep as-is):**
- All role enumeration touch-points: `BuiltInAgentRole`, `BUILT_IN_AGENT_LABELS` (both copies), `VALID_ROLES` in `parseDefaultPromptOverrides`, `DEFAULT_VISIBLE_AGENTS`, `DEFAULT_ROLE_CONFIG`, `ROLE_ADDONS`, `getVisibleAgents` defaults (both providers), `_getDefaultPromptOverrides` roles arrays (both providers), `handleGetDefaultPromptPreviews` roles array, `allBuiltInAgents`, `columnToPromptRole` (correctly NO entry), unknown-role error message
- `validRoles`/`rolePriority` correctly NOT touched (review-role arrays only)
- `DEFAULT_KANBAN_COLUMNS` correctly NOT touched (no phantom lane)
- `PROMPT_OVERRIDE_EXCLUDED_KEYS` correctly does NOT include `orchestrator`
- Orchestrator prompt branch in `agentPromptBuilder.ts` — implementation-oriented per Decision #9, all variables in scope
- `generateUnifiedPrompt` migration — imports legacy `epic_prompt_template` as prepend for orchestrator; uses orchestrator override (or legacy fallback) as epic prompt template for non-orchestrator step mode
- Epics-tab orchestration UI — overlay, preview, copy/send, add-subtask, delete — all wired correctly; `setKanbanProvider` properly called in `extension.ts:852`
- Modal removal — clean, no dangling references, `kanbanEpicDetails` fully removed
- `completeAll` cascade fix — correct use of `updateColumnWithEpicCascade`
- Regression test — covers cascade and subtask exclusion

**Fixed in this review pass:**
- MAJOR #2: Removed `epic_prompt_template` and `epic_lock_columns` writes from both `updateEpicConfig` handlers (`KanbanProvider.ts:7617`, `PlanningPanelProvider.ts:3045`). Kept `epic_max_subtasks` write (still actively read, no addon replacement yet). Legacy key READS preserved as fallback per CLAUDE.md.

**Deferred (documented as remaining risks):**
- MAJOR #1: `epicMaxSubtasks` addon not added to `ROLE_ADDONS`. The addon rendering system in `kanban.html:renderRoleAddons` only supports checkbox/radio/file types — no number/text input. Adding a configurable max-subtasks knob requires extending the addon type system, which is beyond the scope of this fix. The cap still works at default 20 via the legacy `epic_max_subtasks` DB key (read in `buildEpicOrchestrationPrompt` and the board step-mode path). **Remaining risk:** user has no UI to change the cap. Follow-up: add a `type: 'text'` or `type: 'number'` addon type to `renderRoleAddons` and wire `epicMaxSubtasks` into `buildEpicOrchestrationPrompt` (read from orchestrator role config, fall back to legacy DB key).
- NIT #1/#2: Pre-existing missing roles in `handleGetDefaultPromptPreviews`; dead `'preview'` mode. Both harmless.

### Files Changed in Review

- `src/services/KanbanProvider.ts` — removed `epic_prompt_template` and `epic_lock_columns` writes from `updateEpicConfig` handler (lines 7617-7634)
- `src/services/PlanningPanelProvider.ts` — removed `epic_prompt_template` and `epic_lock_columns` writes from `updateEpicConfig` handler (lines 3045-3060)

### Validation Results

- Compilation: skipped per session directive
- Automated tests: skipped per session directive
- Static verification: all enumeration touch-points confirmed via grep; no dangling references to removed modal; legacy key reads preserved; `updateColumnWithEpicCascade` method exists; `setKanbanProvider` wiring confirmed; `dispatchCustomPromptToRole` exists; `_filterDynamicColumns` confirmed safe (no column synthesis)
