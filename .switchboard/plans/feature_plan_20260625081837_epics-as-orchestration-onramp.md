# Epics as a CLI-Orchestration On-Ramp: EPIC Column + Prompt Builder Modal + Per-CLI Keyword Injection

## Goal

Reframe epics from "cards that crawl through plan → code → review like any other plan" into a **distinct orchestration on-ramp**: a dedicated lane right after the first column where an epic + all its subtasks are dispatched as a single unit, explicitly activating the CLI's native subagent / worktree-per-plan orchestration. Make the feature legible (today it is "quite unclear how epics work") by giving the Epics tab a real **epic prompt builder modal**, and make the dispatch portable across CLIs by injecting the correct orchestration keyword **only** for the CLI actually targeted.

### Problems, background & root-cause analysis (verified against live code)

Three connected problems, all confirmed in source:

1. **Epics have no home of their own on the board.** New epics land in `CREATED` (label **"New"**) alongside ordinary plans (`KanbanProvider.ts:7340-7343`, default `'CREATED'`). The board then expects every card to flow `CREATED → PLAN REVIEWED → …CODED → CODE REVIEWED → COMPLETED` (`agentConfig.ts:101-114`). But an epic is a *container* — it doesn't get "planned" then "coded" then "reviewed" as one card; its **subtasks** do. So epics sit awkwardly in a pipeline built for single plans. The user's insight: epics are really a way to **activate CLI orchestration** over a batch, not a pipeline stage.

2. **The epic configuration UI exists but is hidden and crude.** There is already an `epic-manage-modal` in the **board** webview (`kanban.html:3121-3147`) with a single-line `<input type="text">` "Prompt Template" field, a "Max Subtasks" field, and a legacy "Lock Columns" field. It is reachable only from a kanban card, not from the Epics tab where a user goes to *understand* epics. The `project.html` Epics tab (`project.html:1310-1344`) is render-only — it lists epics and previews markdown but cannot edit any epic dispatch config. The backend message round-trip is fully wired and unused by the Epics tab: `getEpicDetails` (with `source:'kanban'`) emits `kanbanEpicDetails {epic, subtasks, epicLockColumns, epicPromptTemplate, epicMaxSubtasks}` (`KanbanProvider.ts:7466-7469`); `updateEpicConfig` persists `epic_prompt_template` / `epic_max_subtasks` / `epic_lock_columns` to the DB `config` table (`KanbanProvider.ts:7478-7481`). **The pipes are in place; only the Epics-tab UI is missing.**

3. **`epic_lock_columns` is legacy/dormant and its default is wrong.** Its default is `'IN PROGRESS,CODE REVIEW,REVIEWED,DONE'` (`KanbanProvider.ts:7261`, `PlanningPanelProvider.ts:2764`) — **none of those strings are real column ids** in `DEFAULT_KANBAN_COLUMNS` (which uses `CREATED`, `PLAN REVIEWED`, `LEAD CODED`, `CODE REVIEWED`, `COMPLETED`, …). So the gate `if (lockColumns.includes(epic.kanbanColumn))` (`KanbanProvider.ts:7262`) is effectively never true on current installs. This stale field is the half-built ancestor of exactly the "epics shouldn't traverse the coding stages" idea — it should be **repurposed/migrated**, not duplicated.

4. **Orchestration keywords are per-CLI and collide with ordinary English (the portability problem).** The epic prompt already injects an agnostic directive — `EPIC_ORCHESTRATION_DIRECTIVE` (`agentPromptBuilder.ts:320-325`): *"Use your native subagent or orchestration capabilities…"* — which is correct and must stay. But a CLI-specific trigger word (e.g. Claude Code's `ultracode`) is a no-op or noise on the other CLIs across the ~4,000-install base, and a bare word like "goal" can be load-bearing in one CLI while meaning nothing in another. **Root cause:** the prompt is built **CLI-agnostically** — the builder (`buildKanbanBatchPrompt(role, plans, options)`, `agentPromptBuilder.ts:423`) never receives the target CLI identity, even though that identity is trivially derivable: the role's startup command's first token is already parsed into a display label at terminal init (`TaskViewerProvider.ts:6671-6673`), and `getStartupCommands(workspaceRoot)[role]` is reachable from the prompt builder's caller. The fix is to thread that identity in and gate any CLI-specific keyword behind a **fail-safe, per-CLI map** (unknown CLI → inject nothing).

### What this plan delivers

- **Phase A — EPIC lane.** A new built-in `EPIC` column immediately after "New". User-disableable. By default it auto-appears when epics exist (content-driven, mirroring the existing `hideWhenNoAgent` occupancy precedent). Epics are the cards that live here; dispatching from this lane is the orchestration trigger.
- **Phase B — Epic prompt builder modal in the Epics tab.** A proper modal (multi-line template, max-subtasks, orchestration toggles, and a **live preview** of the assembled epic prompt) wired to the already-existing `getEpicDetails`/`updateEpicConfig` round-trip. Plus inline "how epics work" copy to kill the confusion. Legacy `epic_lock_columns` migrated into the new model.
- **Phase C — Per-CLI orchestration keyword injection.** Thread the target CLI into epic prompt building; inject the right keyword via a fail-safe map; surface the per-epic orchestration switches in the Phase-B modal.

Each phase is independently shippable in the order A → B → C (B is most valuable for "clarity"; A gives epics a home; C is the portability hardening).

## Metadata

- **Tags:** `feature`, `epics`, `kanban`, `ui`, `frontend`, `orchestration`, `prompt`
- **Complexity:** 8/10 (new built-in column + visibility model touching the shared column pipeline; a new modal mirroring an existing one across two webviews; a prompt-builder signature change with migration of a shipped config key)
- **Depends on:** none landed; internally A → B → C sequencing recommended.

## Decisions (made, not deferred)

1. **EPIC column id/label/order.** `id: 'EPIC'`, `label: 'Epics'`, `order: 10` — between `CREATED` (order 0) and `CONTEXT GATHERER` (order 50). `kind: 'created'`-adjacent new kind `'epic'`; `source: 'built-in'`; `autobanEnabled: false`; `dragDropMode: 'prompt'` (dispatch = copy the orchestration prompt, no blind CLI auto-send).
2. **Epics are NOT hard-blocked from other columns.** The EPIC lane is the *home and launch point*, not a cage. A user can still drag an epic elsewhere (existing flows must not break). "Epics don't belong in the coding columns" is expressed as a **default**, not an enforced lock — avoids regressing any install that currently parks epics elsewhere.
3. **Default placement.** New epics land in `EPIC` instead of `CREATED` when the EPIC lane is enabled; fall back to `CREATED` when the lane is disabled (`KanbanProvider.ts:7340-7343` default changes from `'CREATED'` to a helper that respects the lane setting).
4. **Disable + auto-appear semantics.** New DB config key `epic_lane_mode` ∈ `{auto, on, off}`, default `auto`. `auto` = show iff any `isEpic` card exists (occupancy-driven); `on` = always show; `off` = never show (epics fall back to `CREATED`). Modeled on `hideWhenNoAgent` + `_filterDynamicColumns` occupancy, extended for a card-type rather than a role.
5. **Canonical config editor moves to the Epics tab.** The Phase-B modal in `project.html` becomes the primary editor. The existing `kanban.html` `epic-manage-modal` is upgraded in place to the same fields (shared field set, not a fork) so both entry points behave identically.
6. **`epic_lock_columns` migration.** On first read, if `epic_lock_columns` still holds the stale default (`IN PROGRESS,CODE REVIEW,REVIEWED,DONE`) it is treated as unset (dormant value, never matched a real column) and superseded by `epic_lane_mode`. A non-default user value is preserved and surfaced as an "advanced: columns epics should not be dispatched into" field — **not dropped** (shipped key; CLAUDE.md migration rule).
7. **Per-CLI keyword = explicit profile with binary prefill, fail-safe to nothing.** New DB config `epic_cli_keywords` (JSON map `{cliBinary: keywordText}`), plus a derived "detected CLI" hint from `getStartupCommands(workspaceRoot)[role]`'s first token. Unknown/undetected CLI → inject nothing. The universal `EPIC_ORCHESTRATION_DIRECTIVE` stays agnostic; the CLI keyword is an additive, clearly-delimited line appended only when the target CLI has a mapped keyword.

## User Review Required

None — all forks above are decided. One product note (not a blocker): Decision #2 deliberately keeps epics draggable into coding columns. If you later want a hard guard, the migrated `epic_lock_columns` field (Decision #6) is the place to enforce it; this plan wires the data but does not enforce a block.

## Complexity Audit

### Routine
- Adding the `EPIC` entry to `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:101-114`) and a new `kind: 'epic'` to the `KanbanColumnDefinition` union (`agentConfig.ts:70-81`).
- Building the Phase-B modal HTML/CSS by copying the established `.kanban-log-overlay`/`.kanban-log-modal` pattern (`project.html:1455-1480`) and the New-Epic open/close/submit JS (`project.js:1689-1723`).
- Reusing the existing `getEpicDetails`/`updateEpicConfig`/`kanbanEpicDetails` messages — no new backend message types for Phase B config (only an added `source:'project'` branch so the Epics tab gets the config payload).
- Upgrading the `kanban.html` `epic-manage-modal` "Prompt Template" from `<input>` to `<textarea>` and adding the orchestration toggles (same field set as Phase B).

### Complex / Risky
- **New column visibility flag in a shared pipeline.** The EPIC column must flow through `buildKanbanColumns` (`agentConfig.ts:334-367`), `_filterVisibleColumns` (`TaskViewerProvider.ts:2063-2075`), and `_filterDynamicColumns` (`KanbanProvider.ts:2363-2376`). `_filterVisibleColumns` currently treats only `CREATED`/`COMPLETED` as always-fixed and keys visibility off `visibleAgents[role]`; EPIC has no role. Must add a card-type-aware branch (occupancy by `isEpic`) without disturbing the role-based logic for every other column. Regression surface: any change here re-renders **all** columns for **all** users.
- **Default-placement change for epic creation.** Changing the `'CREATED'` fallback (`KanbanProvider.ts:7340-7343`) affects where every newly created epic lands. Must respect `epic_lane_mode` and not strand epics in a hidden column (if lane is `off`, must fall back to `CREATED`).
- **Prompt builder signature change (Phase C).** Threading `targetCli` into `PromptBuilderOptions` (`agentPromptBuilder.ts:93-191`) and `generateUnifiedPrompt` (`KanbanProvider.ts:2783-2917`) touches a hot, widely-called path. Must be additive/optional so non-epic and non-CLI-aware callers are unaffected.
- **Migration of a shipped config key.** `epic_lock_columns` exists on released installs; its handling must import-then-supersede, never silently drop (CLAUDE.md).
- **Two webviews must not fork.** The Epics-tab modal and the board modal must share one field set and one save payload shape or they will drift.

## Edge-Case & Dependency Audit

- **Lane `off` + epics exist.** Epics must remain visible in `CREATED` (fallback), never vanish. `_filterDynamicColumns`/placement must guarantee no orphaned-in-hidden-column state.
- **Lane `auto` + zero epics.** Column hidden — must not render an empty ghost lane or break drag-drop column indexing in `kanban.html` (`handleDrop` indexes `columns.indexOf(...)`).
- **Subtasks never appear as EPIC-lane cards.** The board already hides `card.epicId` cards off the main board (`kanban.html:5077-5087`) and `_visibleColumnCards` excludes subtasks (`KanbanProvider.ts:360-364`). EPIC lane shows epic *containers* only; verify subtasks still roll up.
- **Epic focus mode still works.** `currentFocusedEpicId` (`kanban.html:3738, 4993-5087`) filters the board to an epic + its subtasks. The EPIC lane and focus mode are orthogonal — focusing an epic from the EPIC lane must still expand subtasks across the pipeline.
- **Order-override collisions.** `getKanbanOrderOverrides()` (consumed in `_buildKanbanColumnsForWorkspace`, `TaskViewerProvider.ts:2054-2061`) could reorder EPIC; ensure a sane default and that overrides can move it but it defaults to position-after-New.
- **Migration: no double-stamp.** Don't assume a prior migration ran; `epic_lane_mode` absent → treat as `auto` (the desired default) so existing installs get the new behavior without a write.
- **Per-CLI fail-safe.** Undetected binary, wrapper script, alias, or empty `epic_cli_keywords` → inject nothing. Never emit one CLI's keyword to another. The agnostic directive always remains.
- **Clipboard vs CLI dispatch parity.** EPIC lane uses `dragDropMode: 'prompt'` (clipboard). Confirm the orchestration prompt (directive + template + per-CLI keyword + subtask list) is assembled identically whether dispatched via the lane's prompt-copy or any CLI-trigger path that also builds an epic prompt.

## Proposed Changes

### Phase A — EPIC lane

**File: `src/services/agentConfig.ts`**
1. Extend the `KanbanColumnDefinition.kind` union (`:70-81`) with `'epic'`.
2. Insert into `DEFAULT_KANBAN_COLUMNS` (`:101-114`) after `CREATED`:
   ```ts
   { id: 'EPIC', label: 'Epics', order: 10, kind: 'epic', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoEpics: true },
   ```
   Add the optional `hideWhenNoEpics?: boolean` field to the interface.

**File: `src/services/TaskViewerProvider.ts`**
3. In `_filterVisibleColumns` (`:2063-2075`): when `epic_lane_mode === 'off'`, drop the `EPIC` column; otherwise keep it (occupancy handled by the dynamic filter). Read the mode via the kanban DB config (cache per refresh to avoid an await storm).

**File: `src/services/KanbanProvider.ts`**
4. In `_filterDynamicColumns` (`:2363-2376`): generalize the occupancy check so a column flagged `hideWhenNoEpics` is shown iff (`epic_lane_mode === 'on'`) OR any card with `isEpic` exists (for `auto`). Keep the existing `hideWhenNoAgent` branch untouched.
5. Epic creation placement (`:7340-7343`): replace the hard `'CREATED'` fallback with `await this._defaultEpicColumn(workspaceRoot)` → returns `'EPIC'` when lane enabled (`auto`/`on`), else `'CREATED'`. Preserve the "earliest subtask column" behavior when the epic is created from existing subtasks.

**File: `src/webview/kanban.html`**
6. `renderColumns` (`:4466+`) already maps `columnDefinitions`; verify the new `kind:'epic'` renders (add a lane style/badge class). Confirm `handleDrop` column-index math tolerates the inserted column.

### Phase B — Epic prompt builder modal (Epics tab)

**File: `src/webview/project.html`**
7. Add an `epic-builder-modal` using the `.kanban-log-overlay`/`.kanban-log-modal` pattern (model on `:1455-1480`). Fields: **multi-line** `<textarea>` prompt template, `max subtasks` number, orchestration toggles (use-subagents / worktrees-per-plan / no-subagents — mirroring `agentPromptBuilder.ts:443-462` addon semantics), the migrated advanced "do-not-dispatch columns" field, and a **read-only live preview** pane showing the assembled epic prompt. Add a short "How epics work" explainer block at the top of the Epics tab (`:1310-1344`).
8. Add a "⚙ Configure dispatch" button on each epic row and/or in the preview meta-bar that opens the modal.

**File: `src/webview/project.js`**
9. On modal open, post `getEpicDetails {sessionId, workspaceRoot, source:'project'}`; handle a new `epicDetailsConfig`/reused `kanbanEpicDetails` (see backend change) to populate fields. On Save, post `updateEpicConfig {workspaceRoot, epicPromptTemplate, epicMaxSubtasks, epicLockColumns, epicOrchestration}` (existing message type). Reuse the `vscode.postMessage` + `window.addEventListener('message')` switch convention (`:277+`).
10. Live preview: assemble client-side from the directive text + template + a sample subtask list, OR (preferred) request a backend-rendered preview so it is byte-identical to dispatch (add a `previewEpicPrompt` message — small, read-only).

**File: `src/services/KanbanProvider.ts`**
11. `getEpicDetails` (`:7445-7469`): add a `source === 'project'` branch that emits the same config payload to `project.html` (either reuse `kanbanEpicDetails` or a parallel `epicDetailsConfig`). `updateEpicConfig` (`:7465-7481`): extend to persist the new orchestration toggles (new config keys, see Phase C) alongside the existing three. Implement the `epic_lock_columns` migration (Decision #6): stale-default → treated as unset.
12. Optional `previewEpicPrompt` handler: build via the same `generateUnifiedPrompt` epic path and return the string for the modal preview.

**File: `src/webview/kanban.html`**
13. Upgrade `epic-manage-modal` (`:3121-3147`): "Prompt Template" `<input>` → `<textarea>`; add the same orchestration toggles; keep `populateEpicManageModal` (`:7253`) and the save path (`:9418-9432`) in sync with the shared field set. No behavioral fork from the Epics-tab modal.

### Phase C — Per-CLI orchestration keyword injection

**File: `src/services/agentPromptBuilder.ts`**
14. Add optional `targetCli?: string` and `epicCliKeyword?: string` to `PromptBuilderOptions` (`:93-191`). In the epic-mode block (`:485-490`), after the agnostic `EPIC_ORCHESTRATION_DIRECTIVE`, append a clearly-delimited line **only if** `epicCliKeyword` is non-empty (e.g. `\n\n<orchestration trigger>: ${epicCliKeyword}`). Keep the directive itself unchanged and agnostic. Add a `EPIC_CLI_KEYWORD_BLOCK` helper for the delimiter.

**File: `src/services/KanbanProvider.ts`**
15. In `generateUnifiedPrompt` (`:2783-2917`), when `epicMode` is set: derive the target CLI binary via `this._taskViewerProvider?.getStartupCommands(workspaceRoot)?.[role]` → first whitespace token → basename (mirror `TaskViewerProvider.ts:6671`). Look up the keyword from the `epic_cli_keywords` JSON config map; if found, set `resolvedOptions.epicCliKeyword`. **Unknown/empty → leave undefined (inject nothing).**

**File: `src/services/KanbanDatabase.ts`**
16. No schema change — `epic_cli_keywords` and `epic_lane_mode` are plain `config` rows via existing `getConfig`/`setConfig` (`:2857-2875`). (DB `config` table is the blessed home for state — consistent with project convention.)

## Verification Plan

> Manual verification against an installed VSIX (per project norm; `dist/` is not used in dev). Compile/tests run separately by the user.

**Phase A**
1. With no epics: EPIC lane hidden in `auto` (default). Create an epic → lane appears, epic lands in it, subtasks do not appear as lane cards.
2. Set `epic_lane_mode='on'` → lane always visible even with zero epics; `'off'` → lane hidden and a new epic falls back to `CREATED` (never stranded).
3. Drag an epic out of the lane into another column → still allowed (Decision #2), board re-renders correctly; drag-drop indices intact with the inserted column.
4. Confirm every other column (role-based visibility, `hideWhenNoAgent`) is unchanged for a normal (non-epic) board.

**Phase B**
5. Open the Epics tab → "How epics work" copy present. Open the builder modal on an epic → existing `epic_prompt_template`/`epic_max_subtasks` load into the fields.
6. Edit template (multi-line), toggle orchestration switches, Save → `updateEpicConfig` persists; reopen → values round-trip. Verify the board's `epic-manage-modal` shows the same values (no fork).
7. Live preview matches the actual dispatched prompt (if backend-rendered, byte-identical).
8. Legacy migration: seed `epic_lock_columns` with the stale default → modal treats it as unset; seed a custom value → preserved and shown in the advanced field.

**Phase C**
9. Configure `epic_cli_keywords` `{claude: "ultracode"}`. Dispatch an epic to a `claude`-started role → prompt contains the agnostic directive **and** the `ultracode` keyword line. Dispatch to a `gemini`-started role with no mapping → directive only, **no** keyword. Undetectable binary (wrapper script) → directive only.
10. Confirm non-epic dispatches are completely unaffected by the new option.

## Uncertain Assumptions

None requiring web research. All anchors verified against live source: column model (`agentConfig.ts:70-114, 334-367`), visibility filters (`TaskViewerProvider.ts:2063-2075`; `KanbanProvider.ts:2363-2376`), epic placement (`KanbanProvider.ts:7340-7343`), epic config round-trip (`KanbanProvider.ts:7445-7481`), the dormant `epic_lock_columns` default and its mismatch with real column ids (`KanbanProvider.ts:7260-7262`, `PlanningPanelProvider.ts:2763-2765`), the existing board modal (`kanban.html:3121-3147, 7253, 9418-9432`), the Epics tab and New-Epic modal patterns (`project.html:1310-1344, 1455-1480`; `project.js:1689-1723`), the agnostic epic directive (`agentPromptBuilder.ts:320-325, 485-490`), the subagent-addon block (`agentPromptBuilder.ts:443-462`), and the binary-from-startup-command parse (`TaskViewerProvider.ts:6671-6673`).

---

**Recommendation:** Ship in order **B → A → C**. B alone fixes "it's unclear how epics work" by surfacing the existing-but-hidden config in the Epics tab (lowest risk, highest clarity payoff). A gives epics a home and is the structural piece (touches the shared column pipeline — most regression-sensitive). C is portability hardening for the multi-CLI install base. Complexity 8/10 — consider running `/improve-plan` for an adversarial pass before execution, and splitting A into its own PR given it re-renders columns for all users.
