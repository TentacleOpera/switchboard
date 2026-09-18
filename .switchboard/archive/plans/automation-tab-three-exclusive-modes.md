# AUTOMATION Tab — Three Exclusive Modes, and Almost No Other Controls

## Goal

You open AUTOMATION, pick one of three modes, set one interval, and turn it on. That is the tab.

| Mode | What Switchboard does |
| :--- | :--- |
| **Agent-managed** | Wakes the orchestrator agent every N minutes to decide and take the next action — dispatch a card to a team, group loose plans into a feature, or nothing. Judgement lives in the agent. |
| **Scheduled** | Applies the run sheet every N minutes. Mechanical, no agent deciding. |
| **External** | Emits a copyable prompt for a tool that runs its own cron. Switchboard runs no clock and dispatches nothing. |

Exactly one is active. The whole tab is a three-way choice, an interval, an on/off, and a line saying what just happened.

### Why the tab is wrong now

**It has three sections because it was built by three plans, not designed as a tab.** In internal mode you get `COLUMN RULES`, `KANBAN AUTOMATION RULES`, and `SCHEDULER` stacked as peers, with `OVERSIGHT AGENT` hanging below the mode branch entirely. The first two configure the same engine and their names don't distinguish them.

**There are two clocks and three start affordances on one screen.** The run sheet arms from the toolbar; every scheduler job row carries its own START/STOP and its own interval; external offers COPY PROMPT. Nothing says which one is "the automation."

**The scheduler and the run sheet are the same feature wearing different clothes.** Both are "every N minutes, do a thing to the board." They were built separately, so they got separate UI, separate persistence, separate arming. Merging them removes a whole surface rather than reorganising it.

> **Superseded:** the scheduler retirement is part of this plan.
> **Reason:** it is an independently-shippable phase with its own shipped-state migration (the jobs persist to the global `integration-config.json`, and `fetch-plans` is the only path cloud-authored plans have onto the board), and it is a pure subtraction that makes this plan's tab rewrite far smaller. Also, the premise as written is only half true: at the level of what they can *express*, a run-sheet step is `{sourceColumn, headRole}` — it dispatches a card — while a scheduler job is a prompt to a named terminal. Merging them removes a capability as well as a surface, which needed its own decision rather than a line item here.
> **Replaced with:** split out as **`retire-the-scheduler-surface.md`**, which lands immediately before this plan. This plan is written against a tab that already has no `SCHEDULER` and no `KANBAN AUTOMATION RULES` section.

**Oversight as a flag alongside automation is being removed because it earns nothing.** `feature_plan_20260816150001_oversight-stops-being-a-mode.md` landed `orchestrationConfig.enabled` — an agent that watches while the run sheet drives. Watching adds nothing: the run sheet is already mechanical and correct, so a supervisor over it has no decision to make. The orchestrator is only worth running when it *is* the automation — deciding and taking the next action itself. That makes it a mode, and makes it exclusive with the run sheet: two things dispatching the same board is the double-dispatch hazard `isAutomationArmed` exists to guard.

This is a deliberate reversal of 150001, not a misreading of it.

## The tab

```
AUTOMATION                                    [ OFF ]

  ( ) Agent-managed   Wake the orchestrator every [ 10 ] min to
                      decide the next action.

  (•) Scheduled       Apply the run sheet every [ 10 ] min.

  ( ) External        Switchboard runs no clock.   [ COPY PROMPT ]

  Last pass 3m ago — moved "Fix reviewer routing" to CODED.
  Next in 7m.
```

Selecting a mode reveals only that mode's controls. The status line is one sentence and always present — an armed automation that has done nothing yet says so.

## What each mode carries

**Agent-managed** — a CLI startup command and a wake interval. That is the mode.

The orchestrator is an ordinary agent: a terminal running a CLI with a skill, like a lead or a planner. So the tab configures it the way any agent is configured — which command starts it — and how often Switchboard wakes it. There is no bespoke orchestrator machinery to expose, and the tab does not enumerate the actions it may take; that is the persona's job.

Pressing Start here does not begin orchestration. It brings the agent up for a pre-flight conversation, and the session begins only when the user answers in the terminal — see `orchestration-starts-as-a-conversation.md`.

**Scheduled** — an interval, and the run-sheet rules that genuinely differ per install.

**External** — the copy button and the evergreen prompt, unchanged from what ships today.

## Controls being deleted

Say the word if any of these earn their place — they are gone otherwise:

- `OVERSIGHT AGENT` as a section (`kanban.html:11105–11154`). It becomes the Agent-managed mode.
- The two-value `internal / external` mode `<select>` (`:10285–10337`). It becomes three radios.
- The toolbar's **separate arming path** as a second way in. One ON/OFF, on the tab — see the toolbar decision below.
- *(The `SCHEDULER` section and `KANBAN AUTOMATION RULES` are deleted by `retire-the-scheduler-surface.md`, which lands first. Not this plan's work.)*

### Toolbar decision — mirror, do not delete

`#btn-autoban` and its `updateAutobanButtonState` (`kanban.html:6917–6975`) currently derive everything from `autobanConfig.enabled` and own their own arming semantics.

> **Superseded:** *"The toolbar's separate arming path as a second way in. One ON/OFF, on the tab."* read as deleting the toolbar button.
> **Reason:** the defect is a *second set of semantics*, not a second affordance. Removing a board-level control that shipped installs use — the only automation control visible without opening a tab — is a regression the plan never asked for, and it would leave the folded-in failure reporting below with no toolbar to report on.
> **Replaced with:** the toolbar button becomes a **pure mirror** of the tab's single ON/OFF. It reads the same one flag and writes the same one message; it carries no mode branch and no independent state. That is one arming path with two surfaces, which is what "one ON/OFF" means.

Concretely, in `updateAutobanButtonState`:

* Delete the comment at `:6930–6932` asserting that oversight "never rides the toolbar" — it documents the model being removed. Leave no tombstone.
* Delete the `watchCount` computation (`:6921–6929`). It existed only to decorate the run-sheet tooltip with a watch-column count, and watch columns are not part of the three-mode model.
* The button's `is-active`, tooltip and alt text track the single armed flag, whatever the active mode is.
* The button hides in External (already true at `:6947`) — External runs no clock, so an arming control there is a dead button (PRD contract #6).
* **Reset and pause stay keyed to the run sheet.** `#btn-reset-autoban-timer` (`:6949`) and `#btn-pause-autoban-timer` (`:6955`) reset and pause *timers*. Agent-managed has a wake interval, so pause is meaningful there too; reset is not. Show both only in Scheduled, hide both in Agent-managed and External. Getting this split wrong puts a "reset the timer" button next to an agent that has no tick to reset.

## Folded in from the retired PM-button subtask

`feature_plan_20260816180000_start-the-project-manager-agent-is-one-button.md` was deleted during this feature's reconciliation. Three of its four proposed changes were void — it bound a control to `orchestrationConfig.enabled` (this plan deletes that field), assumed Start launches the agent immediately (`orchestration-starts-as-a-conversation.md` reverses that), and relocated the `OVERSIGHT AGENT` block (this plan deletes that section). Two parts were real and are covered by no other plan. They land here, because both target the surface this plan owns.

**Survivor 1 — a failed start is silent on the control that was pressed.** `startOrchestratorFromKanban` posts `{ type: 'orchestratorStartResult', success: false, error: 'kickoff prompt not delivered' }` (`TaskViewerProvider.ts:10393`) and **nothing in any webview handles it** — `grep -rn "orchestratorStartResult" src/webview/` returns nothing. The failure reaches a `showErrorMessage` toast; the control that was just pressed says nothing and can be left reading the armed state.

**Survivor 2 — no command-palette entry starts the orchestrator.** `package.json` contributes 28 commands and not one of them does.

> **Superseded:** *"The UI label becomes PROJECT MANAGER."*
> **Reason:** `project_manager` is an existing, shipped, **different** thing — an agent role with its own visibility checkbox and startup-command field (`kanban.html:3037`), its own defaults (`sharedDefaults.js:15`, `:34`, `:51`), its own terminal resolution and its own dispatch path that sends the `/switchboard` console prompt (`TaskViewerProvider._handleDispatchProjectManager`, `:26310`). The orchestrator's terminal is named `Orchestrator` (`autobanState.ts:29`). Labelling the orchestrator "PROJECT MANAGER" gives two unrelated mechanisms one user-facing name — the exact naming collision the *Delete the Attended Oversight Pass* subtask documents for the word "oversight," reproduced deliberately.
> **Replaced with:** the mode is **Agent-managed** and the agent is **the orchestrator**, in the tab and in the command title alike. No code symbol is renamed either way — `orchestrationConfig`, `startOrchestratorFromKanban`, `isOversightAgentRunning`, and the `startOrchestrator` / `stopOrchestrator` verbs all stay exactly as they are.

## Data

`automationMode` becomes `'agent-managed' | 'scheduled' | 'external'`. It is shipped state, so retarget the mapping that `normalizeAutomationMode` (`autobanState.ts:277`) already performs — one function, one fall-through, no new migration machinery:

| Persisted | Becomes |
| :--- | :--- |
| `orchestration` | `agent-managed` |
| `internal` **with `orchestrationConfig.enabled === true`** | `agent-managed` |
| `internal`, `run-sheet`, `scheduler`, `single-column` | `scheduled` |
| `external` | `external` |
| unrecognised | `scheduled` — keeps the board ticking, as today |

> **Superseded:** the mapping table without the second row.
> **Reason:** it loses a real cohort. `feature_plan_20260816150001` (`6a4df070`, 2026-08-16, on `origin/main`) migrated `automationMode === 'orchestration'` onto `internal` *and* set `orchestrationConfig.enabled = true` to carry the intent — `autobanState.ts:340–348`, pinned by `autoban-state-regression.test.js:430–441`. Anyone who has run that build, or who ticked the oversight checkbox on it, is persisted as `internal` + `enabled: true`. Mapping bare `internal` → `scheduled` silently disarms their agent and drops them onto the run sheet. The fix is one extra condition in a function that already reads `orchestrationConfig`.
> **Replaced with:** the four-row table above. `normalizeAutomationMode` needs the sibling field to decide, so either widen its signature to take the whole partial state or make the decision in `normalizeAutobanConfigState`, which already has both values in hand (`:338`, `:344`).

**`orchestrationConfig.enabled` is deleted.** The mode value now carries the whole signal: an install in `agent-managed` has the orchestrator as its automation, and the single tab ON/OFF says whether it is armed. A separate `enabled` flag alongside a mode that means the same thing is the flag-versus-mode confusion this plan exists to end.

> **Superseded:** *"`orchestrationConfig.enabled` is deleted, not migrated. It landed days ago in 150001 and never shipped, so nothing on disk needs carrying across."*
> **Reason:** `orchestrationConfig.enabled` did not land in 150001 — it landed in `fcd98463` (2026-07-08, on `origin/main`) as part of the original Orchestration Automation Mode, alongside `intervalMinutes`, `maxConcurrentSubtasks` and `lastWakeAt`. It is shipped state on `workspaceState['autoban.state']`, and 150001 only changed what set it. "Nothing on disk needs carrying across" is false.
> **Replaced with:** the field is deleted from the type and the normaliser, and its **intent is carried across by the mode mapping above** — both the `orchestration` row and the `internal` + `enabled` row exist precisely so no install loses its agent. That is a migration, performed in the mapping rather than in a separate shim.

**The wake interval is restored, not invented.** Agent-managed needs a wake interval on `orchestrationConfig`.

> **Superseded:** *"Agent-managed needs that wake interval, which does not exist yet — `normalizeOrchestrationConfig` carries only `enabled`. Replace it with `intervalMinutes`, defaulting to the run sheet's current default."*
> **Reason:** `intervalMinutes` is not new. `OrchestrationConfig` shipped on 2026-07-08 as `{ enabled, intervalMinutes, maxConcurrentSubtasks?, lastWakeAt? }` with `intervalMinutes` defaulting to 10 and clamped to 1–60 (`fcd98463`). `6a4df070` (2026-08-16) narrowed the type to `{ enabled }`, so `normalizeOrchestrationConfig` now silently discards a persisted `intervalMinutes` on the first write after upgrade. Re-adding it as if it were new hard-defaults over any value that survived.
> **Replaced with:** restore `intervalMinutes` and **read through the persisted value** rather than defaulting past it — `normalizeOrchestrationConfig` must accept `state?.intervalMinutes` and only fall back to 10 when it is absent or non-finite, exactly as the 2026-07-08 implementation did. Do **not** restore `maxConcurrentSubtasks` or `lastWakeAt`: the first belongs to a fan-out model that is not part of this feature, and the second is status the tab derives from the engine, not config.

Keep the 1-minute floor. Do **not** restore the 60-minute ceiling — the run sheet's own interval had an arbitrary cap removed for the stated reason that "once every few hours" and "overnight" are valid answers (`autobanState.ts:127–130`), and the same reasoning applies to a wake interval.

## Order — third of four

`worktree-strategy-is-the-users-choice.md` lands first. It removes `applyOversightWorktreeTopology`, which fires on the `orchestrationConfig.enabled` false→true transition — the very field this plan deletes. Delete the field while that caller still exists and the topology machinery is left reaching for state that is gone.

`retire-the-scheduler-surface.md` lands second. It shares `createAutobanPanel()` with this plan and is a pure subtraction; writing the three-mode tab against a tab that still contains a scheduler is strictly harder, and the two must serialise on `kanban.html` regardless (PRD orchestration discipline: one agent stream per provider file).

`orchestration-starts-as-a-conversation.md` and `orchestrator-persona-becomes-a-tick.md` both follow this plan, since neither has anywhere to live until agent-managed mode exists.

## Metadata

**Complexity:** 7
**Tags:** ui, ux, refactor, backend
**Project:** Browser Switchboard

## User Review Required

**None.** Five decisions taken here:

* **The toolbar button survives as a mirror**, not as a second arming path and not as a deletion.
* **The `internal` + `enabled` cohort maps to Agent-managed.** A one-day-old cohort is still a cohort, and a no-op migration costs nothing.
* **`intervalMinutes` is restored reading through the persisted value**, not re-invented with a hard default.
* **`maxConcurrentSubtasks` and `lastWakeAt` stay deleted.** Neither is tab configuration.
* **The label is "Agent-managed" / "the orchestrator", never "Project Manager"** — that name is already taken by a different shipped role.

## Complexity Audit

* **Score:** 7 / 10

### Routine

* Swapping a two-option `<select>` for three radios in a function that already rebuilds itself from a broadcast.
* Deleting the `OVERSIGHT AGENT` block.
* Adding one command to `package.json` and one registration in `src/extension.ts` that calls an existing public method.
* Adding one arm to the webview message listener for a message that is already posted.

### Complex / Risky

* **`automationMode` is shipped state on ~4,000 installs and every consumer compares it by literal.** `setAutomationModeFromKanban` validates `['internal','external']` (`TaskViewerProvider.ts:10442`) and branches on `newMode === 'internal'` (`:10451`); `updateAutobanButtonState` branches on `'internal'` / `'external'` (`kanban.html:6923`, `:6947`, `:6951`, `:6957`); `createAutobanPanel` branches at `:10231`, `:10318`, `:10420`, `:11035`. Every one of those literals must move together. A missed branch does not fail loudly — it renders the wrong half of a tab.
* **Deleting a boolean whose meaning moves into an enum.** `orchestrationConfig.enabled` is read by the panel (`:11127`), written by both orchestrator lifecycle methods (`TaskViewerProvider.ts:10404`, `:10426`), and OR'd into the double-dispatch guard (`:1078`). The mode must be armed and disarmed on exactly the transitions the flag was, or an orchestrator starts with the board thinking nothing is running.
* **A regression test asserts the old model in eight places.** `autoban-state-regression.test.js` pins the two-mode set (`:414`), the `orchestration` → `internal` migration (`:430–436`), oversight-off-by-default (`:437–441`), the `isAutomationArmed` OR (`:447–450`), `isOversightAgentRunning` (`:460–463`), and the "no mode literal equals `'orchestration'`" sweep (`:481–488`). These are contract tests asserting the model this plan replaces; they must be rewritten in the same change, not deleted wholesale.
* **Three modes must not leave two clocks installed.** Switching from Scheduled to Agent-managed must tear the run-sheet engine down before arming the wake interval. `setAutomationModeFromKanban` already stops the engine on transition (`:10447`), but the new mode adds a second thing to stop.
* **Both hosts, one file.** `headlessPanelHtml.ts` serves `kanban.html` to the browser cockpit, so the tab and toolbar changes land in the browser and the editor together. The command-palette entry is editor-only by nature; acceptable, because the tab is the primary control and the command is a shortcut.

## Edge-Case & Dependency Audit

### Race Conditions

* **Broadcast-driven labels only.** The existing oversight checkbox derives `checked` and its label purely from the broadcast (`:11127`, `:11134`) with the optimistic write deliberately removed. The three radios and the ON/OFF must keep that discipline: a failed arm settles back to OFF on the next re-render, never on a local click assumption.
* **Panel re-render during interaction.** `renderAutobanPanel` rebuilds the whole tab and is suppressed by `isAutobanPanelInteracting` (`:11166`). Every new control with a focus/change/input lifecycle — the radios, the interval field — needs `guardInteraction`. Restructuring the builder must not disturb the guard registrations of controls that survive.
* **Double-press.** `startOrchestratorFromKanban` reuses a live `Orchestrator` terminal rather than creating a second one, and `stopOrchestratorFromKanban` is idempotent. Two fast presses are safe at the provider; no debounce is needed and none should be added.
* **Mode switch mid-tick.** A run-sheet tick in flight when the mode changes to Agent-managed must not land a dispatch after the new mode is armed. The existing `_stopAutobanEngine()` on transition (`:10447`) is the mechanism; the new arm must run after it, not beside it.

### Security

* Not a privilege change. No new routes and no new verbs — `startOrchestrator` / `stopOrchestrator` / `setAutomationMode` are reused unchanged. The new command carries no user input beyond the resolved workspace root, which `_resolveWorkspaceRoot` already validates.
* `setAutomationMode`'s payload schema in `verbSchemas.ts` must stay **permissive and field-accurate** (PRD contract #5) — it validates shape, not the enum. A schema that hard-codes the old two values would reject a valid webview payload on shipped installs the moment the third value ships.

### Side Effects

* **An install persisted as `internal` with the run sheet armed keeps ticking**, now labelled Scheduled. No behaviour change for the majority cohort; only the name on the radio differs.
* **An install with `orchestrationConfig.enabled === true` moves to Agent-managed** and stops running the run sheet, because the modes are exclusive. That is the intended reversal of 150001, and the status line must say what mode it landed in so the change is visible on first open.
* **The double-dispatch guard changes shape.** `isAutomationArmed` (`TaskViewerProvider.ts:1078`) ORs the run sheet with `orchestrationConfig.enabled`. Deleting the flag breaks that expression. *Delete the Attended Oversight Pass* removes the guard's only consumer entirely; if that subtask has not landed, this plan must retarget the expression to the mode rather than leave it referencing a deleted field. Do **not** narrow it to always-false — that silently disables a double-dispatch 409 while its consumer still exists.
* **`.switchboard/` on-disk state is untouched.** All of this lives in `workspaceState['autoban.state']`.

### Dependencies & Conflicts

* **`src/services/autobanState.ts`** — `AutobanAutomationMode` (`:47`), `normalizeAutomationMode` (`:277`), `OrchestrationConfig` (`:99`), `DEFAULT_ORCHESTRATION_CONFIG` (`:103`), `normalizeOrchestrationConfig` (`:107`), and the migration branch in `normalizeAutobanConfigState` (`:338–348`).
* **`src/services/TaskViewerProvider.ts`** — `setAutomationModeFromKanban` (`:10440–10510`), the arm/disarm writes in `startOrchestratorFromKanban` (`:10402–10407`) and `stopOrchestratorFromKanban` (`:10424–10429`), and `isAutomationArmed` (`:1078`).
* **`src/webview/kanban.html`** — `updateAutobanButtonState` (`:6917`), the `#btn-autoban` click handler, `createAutobanPanel` (`:10217`) and its mode branches, the `OVERSIGHT AGENT` block (`:11105–11154`), and the webview message listener (for `orchestratorStartResult`).
* **`package.json`** — `contributes.commands`.
* **`src/extension.ts`** — command registration alongside the existing `switchboard.*` registrations.
* **`src/test/autoban-state-regression.test.js`** — the eight assertion groups listed under *Complex / Risky*.
* **No provider-construction changes.** `KanbanProvider` is a read-only dependency here apart from nothing at all; if a change is needed there, the plan has been misread.
* **Sibling subtask conflicts.** `worktree-strategy-is-the-users-choice.md` (lands first) removes the `applyOversightWorktreeTopology` calls that ride this field's transitions. `retire-the-scheduler-surface.md` (lands second) rewrites the same `createAutobanPanel()`. `delete-the-attended-oversight-pass.md` owns `isAutomationArmed`'s removal and may land in parallel — coordinate on that one expression only.

## Dependencies

* None outstanding. Every mechanism this plan needs is in the tree; the two ordering constraints above are sequencing, not blockers.

## Adversarial Synthesis

Key risks: (1) **a missed mode literal** — the two-value enum is compared by string in at least eight places across three files, and a stale branch renders the wrong half of a tab rather than throwing; (2) **the `internal` + `enabled` cohort losing its agent** if the migration table keeps only the `orchestration` row; (3) **hard-defaulting `intervalMinutes`** over a value that shipped on 2026-07-08 and may still be persisted; (4) **breaking `isAutomationArmed`** by deleting the field it reads while its consumer still exists; (5) **reproducing the defect by adding rather than replacing** — three radios beside a surviving `OVERSIGHT AGENT` section leaves two ways to start the same agent. Mitigations: the literal sweep is a verification gate, not a code-reading exercise; the migration table carries both cohorts; the normaliser reads through persisted values; the guard is retargeted rather than narrowed; the old section is deleted in the same edit as the radios.

## Proposed Changes

**Build order:** (1) the data model and migration → (2) the provider's mode transitions → (3) the tab → (4) the toolbar mirror → (5) failure reporting → (6) the command → (7) the contract tests. State first, so the UI is written against a settled model.

### 1. `src/services/autobanState.ts` — the three-value mode and the restored interval

* `AutobanAutomationMode` becomes `'agent-managed' | 'scheduled' | 'external'`. Rewrite the doc comment above it — it currently describes the two-mode "who runs the clock" axis and oversight-as-a-flag.
* `normalizeAutomationMode` implements the four-row table. It needs the sibling `orchestrationConfig` to decide, so widen it to take the partial state (or decide inside `normalizeAutobanConfigState`, which already holds both). Keep the fall-through on `scheduled` and keep the comment explaining *why* a whitelist that fell through would silently disarm a shipped install's clock — that reasoning is still correct.
* `OrchestrationConfig` becomes `{ intervalMinutes: number }`. `normalizeOrchestrationConfig` reads through `state?.intervalMinutes`, floors at 1, no ceiling, falls back to 10.
* Delete the `automationMode === 'orchestration'` → `enabled: true` branch (`:344–348`); the mode mapping now carries that intent directly.

**Edge cases:** a persisted state carrying `maxConcurrentSubtasks` or `lastWakeAt` must normalise without error — they are simply not read. Do not add code to strip them; the normaliser already returns a fresh object.

### 2. `src/services/TaskViewerProvider.ts` — mode transitions and arming

* `setAutomationModeFromKanban` validates against the three new values (`:10442`) and branches three ways. `scheduled` keeps the existing `internal` body verbatim. `agent-managed` arms the wake interval and must call `_stopAutobanEngine()` first, like the others. `external` keeps its body minus the `orchestrationConfig` carry-through at `:10496` — the mode now carries that.
* `startOrchestratorFromKanban` / `stopOrchestratorFromKanban` stop writing `orchestrationConfig.enabled` (`:10404`, `:10426`). What they write instead is the armed state for the active mode. The kickoff, terminal reuse, and error paths above are unchanged and must not be touched.
* `isAutomationArmed` (`:1078`) is retargeted to read the mode, not the deleted flag. If `delete-the-attended-oversight-pass.md` has already landed, this expression and its consumer are gone and there is nothing to do here.

**Edge cases:** `_startAllSchedulerLoops` at `:10506` is deleted by `retire-the-scheduler-surface.md`. If that plan has not landed, retarget its `automationMode === 'external'` check rather than leaving it comparing against a value that no longer exists.

### 3. `src/webview/kanban.html` — the tab

Replace the mode `<select>` (`:10285–10337`) with three radios carrying the labels and one-line descriptions from *The tab* mock above. Delete the `OVERSIGHT AGENT` block (`:11105–11154`) in the same edit — the mode replaces it, and leaving both is two ways to start one agent.

Selecting a mode reveals only that mode's controls: Agent-managed shows the wake interval and the startup-command field; Scheduled shows the interval and the run-sheet rules; External shows COPY PROMPT. One ON/OFF sits in the tab header and applies to whichever mode is selected. One status line is always present, including when nothing has happened yet.

Rewrite the how-to hint (`:10272`), which currently reads *"Configure a mode below, then start the automation by pressing the Start Automation icon button on the kanban board"* — it points at the toolbar as the way in, which is no longer the model.

**Edge cases:** radios need `guardInteraction`; so does the interval input. The ON/OFF and the radios both derive state from the broadcast on every render. `state.orchestrationConfig.enabled` no longer exists — every read of it in this file must move to the mode.

### 4. `src/webview/kanban.html` — the toolbar mirror

In `updateAutobanButtonState` (`:6917`), apply the toolbar decision above: delete `watchCount` and the `:6930–6932` comment, track the single armed flag, keep the External hide, and show reset/pause only in Scheduled.

**Edge cases:** `#btn-autoban`'s click handler posts the same message the tab's ON/OFF posts. Two surfaces, one write.

### 5. `src/webview/kanban.html` — a failed start shows on the control that was pressed

Add an arm to the webview message listener for the already-posted message:

```js
case 'orchestratorStartResult': {
    if (!msg.success) {
        const status = document.getElementById('automation-status-line');
        if (status) {
            status.textContent = 'Start failed: ' + (msg.error || 'the orchestrator did not start.');
            status.style.color = 'var(--accent-red, #d9534f)';
        }
    }
    renderAutobanPanel(true);
    break;
}
```

The forced re-render settles the ON/OFF back to OFF from the broadcast, so a failed start never leaves a control reading ON.

**Edge cases:** the target element is the tab's single status line, which this plan creates. If the tab is not open the handler is a no-op and the existing `showErrorMessage` toast is still the user-visible signal — that is acceptable, not a gap.

### 6. `package.json` + `src/extension.ts` — a command-palette entry

```json
{
  "command": "switchboard.startOrchestrator",
  "title": "Switchboard: Start Orchestrator"
}
```

```ts
context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.startOrchestrator', async () => {
        await taskViewerProvider.startOrchestratorFromKanban(undefined, undefined);
    })
);
```

`startOrchestratorFromKanban` already resolves the workspace root, reuses a live terminal, and shows its own error when no workspace is open. Do not re-implement any of that in the command.

**Edge cases:** what the command starts is the pre-flight conversation, not an armed engine — `orchestration-starts-as-a-conversation.md` owns that behaviour. The command title says "Start Orchestrator" and nothing about immediacy.

### 7. `src/test/autoban-state-regression.test.js` — rewrite the pinned contract

* `:414` — the legacy-value sweep now expects `scheduled` for `single-column`, `multi-column`, `run-sheet`, `scheduler`, `''`, `'nonsense'`, `undefined`, `null`; and `agent-managed` for `orchestration`.
* `:430–441` — replace the `orchestration` → `internal` + `enabled: true` assertions with `orchestration` → `agent-managed`, plus the new `internal` + `enabled: true` → `agent-managed` case and a bare `internal` → `scheduled` case. That trio is the migration contract; assert all three or the cohort split is untested.
* `:447–450` — `isAutomationArmed`: retarget to the mode, or delete with the guard if the oversight-pass subtask has landed.
* `:460–463` — `isOversightAgentRunning` stays; it is an accessor, not a mode read.
* `:481–488` — the "no mode literal equals `'orchestration'`" sweep stays and still holds.
* Add: `normalizeOrchestrationConfig` reads through a persisted `intervalMinutes` (e.g. `{ intervalMinutes: 45 }` → `45`, not `10`), floors at 1, and applies no ceiling.
* Add: no file under `src/` compares a mode against `'internal'`. That is the literal sweep, and it is the only mechanical defence against a missed branch.

## Verification Plan

> **Session note:** this run was directed to skip compilation and skip automated test execution, so the checks below are written for the implementing coder, not run here.

### Automated Tests

* `normalizeAutomationMode` maps each of the four table rows correctly, including `internal` + `orchestrationConfig.enabled === true` → `agent-managed` and bare `internal` → `scheduled`.
* `normalizeOrchestrationConfig` preserves a persisted `intervalMinutes`, floors at 1, has no ceiling, defaults to 10 when absent, and returns no `enabled`, `maxConcurrentSubtasks` or `lastWakeAt` field.
* No file under `src/` compares an automation mode against `'internal'` or `'orchestration'`.
* `orchestrationConfig.enabled` appears nowhere under `src/`.
* `createAutobanPanel` renders exactly three mode radios, one interval input, one ON/OFF and one status line; `#oversight-agent-toggle` no longer exists anywhere in `kanban.html`.
* `#btn-autoban`'s `is-active` class and the tab ON/OFF track the same flag; reset and pause are visible in Scheduled and hidden in Agent-managed and External.
* `orchestratorStartResult { success: false }` leaves the ON/OFF reading OFF and writes the error into the status line.
* `switchboard.startOrchestrator` is present in `package.json` and registered in `extension.ts`.
* No `confirm(` / `window.confirm(` is introduced on any path added here.
* `catalog:check` / `parity:check` stay green **without** a regen — this plan adds and removes no verbs.
* `verb-returns:check` stays green — no arm's return shape changes.

### Manual Verification

1. Open AUTOMATION: three radio options, one interval, one ON/OFF, one status line. No `OVERSIGHT AGENT` section, no second START anywhere on the page.
2. Pick Agent-managed, set 10 minutes, turn it on — the orchestrator wakes on the interval and takes an action; the status line names what it did.
3. Pick Scheduled, turn it on — the run sheet advances cards on the interval; the orchestrator is not running.
4. Switching between the two does not leave both live — count installed timers, not just UI state.
5. Pick External — no timer is installed, COPY PROMPT yields a prompt that builds against an empty board, and the toolbar button is hidden.
6. An install persisted as `orchestration` opens on Agent-managed. One persisted as `internal` with oversight ticked opens on Agent-managed. One persisted as `internal` without it opens on Scheduled.
7. An install persisted with `orchestrationConfig.intervalMinutes = 45` opens showing 45, not 10.
8. **Round trip:** toggle from the toolbar; the tab's ON/OFF follows. Toggle from the tab; the toolbar follows. The two never disagree.
9. **Failure reads honestly:** with no CLI configured so the kickoff cannot be delivered, start Agent-managed and confirm the status line reports the failure and the switch settles back to OFF.
10. **Browser cockpit:** repeat 1–5 in the browser board. Same file, so it must behave identically.
11. **Command palette:** run *Switchboard: Start Orchestrator* with the board closed; the orchestrator terminal opens and the board reflects it when opened.

## Recommendation

Complexity 7 → **Send to Lead Coder.**

**Read the Data section's three superseded callouts before writing any code.** All three correct claims that were factually wrong about shipped state: `orchestrationConfig.enabled` shipped on 2026-07-08 rather than "days ago", `intervalMinutes` is a restore rather than an invention, and the migration table was missing the `internal` + `enabled` cohort.

**The thing to get right:** the mode literal sweep. `'internal'` is compared by string in at least eight places across `autobanState.ts`, `TaskViewerProvider.ts` and `kanban.html`, and a stale branch renders the wrong half of a tab instead of throwing. The automated grep assertion is the only reliable defence.

**Second:** *replace*, do not *add*. If the `OVERSIGHT AGENT` block is still in the file when you finish, the change failed — there are then two ways to start one agent, which is the defect this plan exists to remove.

**Do not** rename `orchestrationConfig`, `startOrchestratorFromKanban`, `isOversightAgentRunning`, or the `startOrchestrator` / `stopOrchestrator` verbs, and do not use the words "Project Manager" for the orchestrator anywhere in the UI — that name belongs to a different shipped role.

## Completion Report

*(Recorded by the reviewer: the coder appended this plan's completion report to the bottom of `retire-the-scheduler-surface.md` under "Three-mode tab follow-up" rather than to its own file. The work itself landed; only the report was misfiled.)* The three-value mode axis shipped across `autobanState.ts` (`AutobanAutomationMode`, `normalizeAutomationMode` with the three-cohort migration table, `OrchestrationConfig.intervalMinutes` restored read-through, `orchestrationConfig.enabled` deleted), `TaskViewerProvider.ts` (three-way `setAutomationModeFromKanban`, orchestrator arm/disarm writing the single `enabled` flag, `isOversightAgentRunning` reading mode+flag), `kanban.html` (three radios, OVERSIGHT AGENT block deleted, ON/OFF + status line in the tab header, agent-managed panel, toolbar reduced to a pure mirror with `watchCount` gone, `orchestratorStartResult` handler), `package.json` + `extension.ts` (the `switchboard.startOrchestrator` command), and the rewritten contract assertions in `autoban-state-regression.test.js`.

## Review Findings

Two CRITICAL defects, both instances of the same missed-literal class the plan named as its top risk — but in the *negative space*: `=== 'external'` was a correct proxy for "no run sheet here" on a two-value axis and became a fall-through the moment a third value existed. **(1)** All four run-sheet timer-install paths (`_startAutobanEngine`, `resetAutobanTimersFromKanban`, the `setAutobanPausedFromKanban` resume branch, the `updateAutobanState` arm) gated only on `external`, so `agent-managed` installed the run-sheet clock — reached on *every activation* via `_tryRestoreAutoban` for any agent-managed+armed install, including the `internal`+`enabled` migration cohort; retargeted all four to `!== 'scheduled'`, with the `updateAutobanState` arm stopping rather than forcing `enabled` false so the orchestrator is not disarmed. **(2)** `startOrchestratorFromKanban` flipped the mode to `agent-managed` without `_stopAutobanEngine()`, and three of its four callers (command palette, `POST /kanban/orchestration/start`, the `startOrchestrator` verb) bypass `setAutomationModeFromKanban` — so starting the orchestrator from armed Scheduled left both clocks dispatching; the teardown now precedes the mode write. Also fixed MAJOR: both timer-badge filters let `agent-managed` fall through to the unfiltered set (a countdown badge per column for a clock that does not run), and the agent-managed panel's comment claimed it "shows the startup command" while rendering none — added a read-only `STARTS WITH` line mirroring the method's own `lead || coder` resolution rather than inventing an `orchestrator` role slot. Validation: `tsc -p tsconfig.test.json` clean, eslint 0 errors, and `autoban-state`, `scheduled-jobs`, `unattended-batch`, `headless-feature-mgmt`, `worktree-strategy-control`, `render-guard`, `panel-runtime-surface`, `dispatch-view`, `autoban-no-valid-tickets`, `browser-direct-terminal-helpers`, `feature-worktree-guardrail` plus `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `mirror:check`, `standalone-parity:check` all pass; six new assertions gate the two fixes, and the three retargeted engine-gate assertions were re-scoped from byte windows to method bodies (the same fragility a prior reviewer fixed once already). Remaining risks: **no wake tick is installed** — agent-managed stores `intervalMinutes` but nothing consumes it, so Manual Verification step 2 ("the orchestrator wakes on the interval") cannot pass until `orchestrator-persona-becomes-a-tick.md` lands, which is the feature's stated sequencing and deliberately not built here; and the migration cohort opens reading ON with neither a run sheet nor a live orchestrator terminal behind it until that tick ships.
