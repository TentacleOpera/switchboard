# Starting the Project Manager Agent Is One Button

## Goal

Give internal automation exactly one start control, and make that control launch the **project manager agent** — the agent that watches the teams and moves cards as needed. Pressing the board's Start Automation button in Internal mode starts the PM agent. The AUTOMATION tab leads with that same start control instead of ending with it.

### Problem & background

**The PM agent works. It has no front door.** `startOrchestratorFromKanban` (`TaskViewerProvider.ts:10221`) already does the whole job: it finds or creates the `Orchestrator` terminal, boots the lead CLI, waits for the shell, injects a kickoff prompt pointing at `.agents/skills/switchboard-orchestrator/SKILL.md` with `WORKSPACE_ROOT` / `ACTIVE_PROJECT_FILTER`, arms `orchestrationConfig.enabled`, applies the worktree topology, and surfaces a real error when the kickoff can't be delivered. `POST /orchestration/start` reaches the same method. None of that is the problem.

**The problem is that the only way a user can reach it is a checkbox rendered last on a long configuration tab.** Verified in the working tree on 2026-08-16 (*line numbers drift — anchor on the symbol names*):

| Position in `createAutobanPanel()` | Section |
| :--- | :--- |
| `kanban.html:10265` | CONFIGURE AUTOMATION header + how-to-start hint |
| `:10285` | MODE selector (Internal / External) + description + safety note |
| `:10433`, `:10543` | column rules, KANBAN AUTOMATION RULES |
| `:10656` | SCHEDULER — the whole job list |
| `:11050` | EXTERNAL — instruction input, COPY PROMPT, paused-jobs note |
| **`:11111`** | **OVERSIGHT AGENT — the checkbox that starts the PM agent. Dead last.** |

**Root cause: the PM agent was modelled as an optional add-on *to* automation, when it is what internal automation is.** Three consecutive passes moved it along that axis — first a peer `automationMode` value, then a flag, then a checkbox — and each pass pushed the launch control further down the tab. The current code states the model explicitly:

* `updateAutobanButtonState` (`kanban.html:6929–6931`): *"The toolbar button is the single start/stop control for the board automation engine (the run sheet). Oversight is a separate flag with its own toggle in the panel below — it never rides the toolbar."*
* The tab's own how-to hint (`:10272`) reads *"Configure a mode below, then start the automation by pressing the Start Automation icon button on the kanban board"* — **pointing the user at the one control that does not start the PM agent.** A user who follows the instruction printed at the top of the tab gets the run-sheet timer and no agent.

So: the board has a Start Automation button that starts a timer, and the agent the user actually wants has a checkbox seven sections deep, under a heading (`OVERSIGHT AGENT`) that does not use the words the user uses. There is no command-palette entry either — `package.json` contributes 28 commands and not one of them starts the orchestrator.

**A second, smaller defect found while tracing this.** `startOrchestratorFromKanban` posts `{ type: 'orchestratorStartResult', success: false, error: 'kickoff prompt not delivered' }` on a failed launch (`:10393`), and **nothing in `kanban.html` handles that message** — grep returns only the provider and a contract test. The failure reaches a `showErrorMessage` toast, but the control that was just pressed says nothing. A start button needs to report its own failure.

---

## Metadata

**Complexity:** 4
**Tags:** ui, ux, frontend, bugfix
**Project:** Browser Switchboard

---

## User Review Required

**None.** Four decisions made here:

* **In Internal mode the toolbar Start Automation button starts the project manager agent.** That is the "easy way to launch" — the button that is already on the board, already labelled Start Automation, in the mode the user is already in.
* **The run-sheet timer keeps its own switch, inside the AUTOMATION tab.** It is not deleted and its persisted state is untouched; it stops owning the toolbar. Users with it armed keep it armed.
* **The UI label becomes PROJECT MANAGER.** Label only — no code symbol is renamed. `orchestrationConfig`, `startOrchestratorFromKanban`, `isOversightAgentRunning`, and the `startOrchestrator` / `stopOrchestrator` verbs all stay exactly as they are. Renaming them would churn three sibling plans that just landed on the same files for zero user-visible gain.
* **No new mode, no new config axis, no new panel.** If an implementer finds themselves adding a selector, a sub-mode, or a second peer control, they have reproduced the defect this plan exists to remove.

---

## Complexity Audit

* **Score:** 4 / 10

### Routine

* Moving one DOM block from the bottom of a builder function to the top.
* Swapping a checkbox for a button that posts the same two messages.
* Adding one command to `package.json` + one registration that calls an existing public method.

### Complex / Risky

* **`updateAutobanButtonState` currently derives everything from `autobanConfig.enabled`.** The toolbar button, its tooltip, its icon alt text, and the visibility of the reset and pause buttons all read that one boolean (`kanban.html:6917–6960`). Rebinding the *button* to `orchestrationConfig.enabled` while leaving reset/pause on `autobanConfig.enabled` is correct — the reset and pause controls belong to the run-sheet timer, not the agent — but it means one function now reads two different flags. Get the split wrong and pause/reset appear for an agent that has no timer to pause.
* **Two start paths must not diverge.** The toolbar button, the tab button, `POST /orchestration/start`, and the new command must all land on `startOrchestratorFromKanban`. The webview paths already do this through the `startOrchestrator` verb; the command must call the provider method, not re-implement terminal creation.
* **The failed-start path is currently silent in the UI.** Wiring `orchestratorStartResult` is what stops this shipping as another control that reports success it did not have.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **Toggle-then-render.** The existing checkbox derives both `checked` and its label purely from the broadcast (`kanban.html:11127`, `:11134`) with the optimistic write deliberately removed. **The replacement button must keep that discipline** — its label comes from `state.orchestrationConfig.enabled`, never from a local click assumption. A failed arm must settle back to "START PROJECT MANAGER".
* **Panel re-render during interaction.** `renderAutobanPanel` rebuilds the whole tab and is suppressed by `isAutobanPanelInteracting` (`:11165`). The existing checkbox registers with `guardInteraction`; a button has no focus/change/input lifecycle, so it needs no guard — but moving the block to the top of the builder must not disturb the guard registrations of the controls below it.
* **Double-press.** `startOrchestratorFromKanban` reuses a live `Orchestrator` terminal rather than creating a second one, and `stopOrchestratorFromKanban` is idempotent. Two fast presses are safe at the provider; no debounce is needed and none should be added.

### Security

* Not a privilege change. No new routes, no new verbs — `startOrchestrator` / `stopOrchestrator` are reused unchanged. The new command carries no user input beyond the resolved workspace root, which `_resolveWorkspaceRoot` already validates.

### Side Effects

* **A user whose run-sheet timer is armed keeps it armed.** `autobanConfig.enabled` is not written by this plan. What changes is which control shows its state: the toolbar now reflects the agent, and the timer's state is shown by its own switch in the tab.
* **The double-dispatch guard already covers both.** `isAutomationArmed` (`TaskViewerProvider.ts:1078`) ORs `autobanState.enabled` with `orchestrationConfig.enabled`, so an oversight pass still 409s when either is running. No change needed there — and it must not be narrowed.
* **Both surfaces get the fix from one edit.** `headlessPanelHtml.ts:170–171` serves `kanban.html` to the browser cockpit, so the tab and toolbar changes land in the browser and the editor from the same file. The command-palette entry is editor-only by nature; that is acceptable because the button is the primary control and the command is the shortcut.

### Dependencies & Conflicts

* **`src/webview/kanban.html`** — `updateAutobanButtonState` (`:6917`), the `#btn-autoban` click handler, the how-to-start hint (`:10272`), the OVERSIGHT AGENT block (`:11106–11154`), and the webview message listener (for `orchestratorStartResult`).
* **`package.json`** — `contributes.commands`.
* **`src/extension.ts`** — command registration alongside the existing `switchboard.*` registrations.
* **No provider changes.** `TaskViewerProvider` and `KanbanProvider` are read-only dependencies here. If a change is needed in either, the plan has been misread.
* **Sibling plans on the same file.** `feature_plan_20260816150001` (oversight-as-a-flag), `150002` (internal/external rename) and `150003` (scheduler collapse) all edit `kanban.html`. This plan lands **after** them and must not re-do their work: the flag, the two-mode selector, and the broadcast-driven label are already in.

---

## Dependencies

* None outstanding. Every mechanism this plan needs is in the tree.

---

## Adversarial Synthesis

Key risks: (1) **Reproducing the defect by adding rather than moving** — a new "PM agent" panel beside the existing sections leaves the tab with two start controls and makes it worse; the existing block must be *relocated and re-shaped*, and the checkbox must be gone afterwards. (2) **Leaving the how-to hint pointing at the wrong control** — the sentence at `:10272` is the instruction the user actually followed; if it survives unchanged it keeps sending people to the timer. (3) **Splitting `updateAutobanButtonState` carelessly** so pause/reset follow the agent and appear with nothing to pause. (4) **Shipping a start button that cannot fail visibly** — `orchestratorStartResult` is already posted and already dropped on the floor; wiring it is part of this change, not a follow-up. (5) **Renaming code symbols** because the label changed, colliding with three plans that just landed on these files.

---

## Proposed Changes

**Build order:** (1) the tab control → (2) the toolbar rebind → (3) failure reporting → (4) the command. The tab first, so a working control exists before the toolbar's meaning changes.

### 1. `src/webview/kanban.html` — the PM control is the first thing in the AUTOMATION tab

Move the block currently at `:11106–11154` to run **immediately after** the `CONFIGURE AUTOMATION` header (`:10269`), before the mode selector. Re-shape it from a checkbox to a start/stop button, keeping the broadcast-driven label discipline verbatim.

```js
// ── Project manager agent ─────────────────────────────────────────────
// FIRST control in the tab. This is what internal automation is: an agent
// that watches the teams and moves cards. Everything below is optional
// configuration. Rendered in BOTH modes — orchestrationConfig.enabled
// survives a mode switch, so hiding it in External would strand an armed
// agent with no off-switch.
{
    const pmSection = document.createElement('div');
    pmSection.className = 'db-subsection';
    container.appendChild(pmSection);

    const pmHeader = document.createElement('div');
    pmHeader.className = 'subsection-header';
    const pmSpan = document.createElement('span');
    pmSpan.textContent = 'PROJECT MANAGER';
    pmHeader.appendChild(pmSpan);
    pmSection.appendChild(pmHeader);

    const pmRunning = !!(state.orchestrationConfig && state.orchestrationConfig.enabled);

    const pmBtn = document.createElement('button');
    pmBtn.id = 'btn-project-manager';
    pmBtn.className = 'strip-btn is-teal';
    pmBtn.style.cssText = 'font-size:11px; margin:0 8px 6px 8px;';
    // Label from the broadcast only — no optimistic write. A failed start
    // settles back to START on the next re-render.
    pmBtn.textContent = pmRunning ? 'STOP PROJECT MANAGER' : 'START PROJECT MANAGER';
    // No confirm dialog — project rule, and confirm() is a no-op in a webview.
    pmBtn.addEventListener('click', () => {
        postKanbanMessage(pmRunning
            ? { type: 'stopOrchestrator', workspaceRoot: getActiveWorkspaceRoot() }
            : { type: 'startOrchestrator', workspaceRoot: getActiveWorkspaceRoot() });
    });
    pmSection.appendChild(pmBtn);

    const pmStatus = document.createElement('div');
    pmStatus.id = 'pm-agent-status';
    pmStatus.style.cssText = 'padding:0 8px; font-size:10px; color:var(--text-secondary); margin-bottom:8px; line-height:1.4;';
    pmStatus.textContent = pmRunning
        ? 'Running. It watches the team terminals, groups loose plans into features, and moves cards as work completes.'
        : 'Not running. Start it to have an agent watch the teams and move cards as needed.';
    pmSection.appendChild(pmStatus);
}
```

* **Delete** the old OVERSIGHT AGENT block at `:11106–11154` in the same edit. Two controls for one thing is the defect.
* **Rewrite the how-to hint** at `:10272` so it stops sending users to the timer: *"Press START PROJECT MANAGER to put an agent on the board. The settings below are optional."*
* Keep `guardInteraction` on every control that had it; the new button needs none.

### 2. `src/webview/kanban.html` — the toolbar Start Automation button starts the PM agent

In `updateAutobanButtonState` (`:6917`), split the two flags. Delete the comment at `:6929–6931` that asserts oversight "never rides the toolbar" — it documents the model being removed, so leave no tombstone in its place.

```js
const pmRunning = !!(autobanConfig && autobanConfig.orchestrationConfig && autobanConfig.orchestrationConfig.enabled);
const timerOn   = !!(autobanConfig && autobanConfig.enabled);

// The toolbar button is the board-level start control for the project
// manager agent — the thing the user means by "start automation".
autobanBtn.classList.toggle('is-active', pmRunning);
const tooltipText = pmRunning ? 'Stop the project manager agent' : 'Start the project manager agent';
autobanBtn.setAttribute('data-tooltip', tooltipText);
autobanBtn.title = tooltipText;
const img = autobanBtn.querySelector('img');
if (img) { img.alt = pmRunning ? 'Stop Automation' : 'Start Automation'; }
autobanBtn.style.display = currentAutomationMode === 'external' ? 'none' : '';

// Reset and pause belong to the run-sheet TIMER, not the agent — an agent
// has no tick to reset. They stay keyed on autobanConfig.enabled.
const showTimerControls = timerOn && currentAutomationMode !== 'external';
```

Repoint the `#btn-autoban` click handler to post `startOrchestrator` / `stopOrchestrator` with `workspaceRoot: getActiveWorkspaceRoot()`, matching the tab button. The run-sheet timer keeps its own switch inside the AUTOMATION tab, still posting `toggleAutoban` — it is not deleted and its persisted state is not written by this plan.

**Edge cases:** `watchCount` was only ever used to decorate the timer tooltip; it moves to the timer switch or is dropped. Do not hide the toolbar button when the timer is off — it now reflects the agent.

### 3. `src/webview/kanban.html` — a failed start must show on the control that was pressed

Add an arm to the webview message listener for the already-posted message:

```js
case 'orchestratorStartResult': {
    if (!msg.success) {
        const status = document.getElementById('pm-agent-status');
        if (status) {
            status.textContent = 'Start failed: ' + (msg.error || 'the project manager agent did not start.');
            status.style.color = 'var(--accent-red, #d9534f)';
        }
    }
    renderAutobanPanel(true);
    break;
}
```

The forced re-render settles the button label back to START from the broadcast, so a failed start never leaves a control reading "STOP".

### 4. `package.json` + `src/extension.ts` — a command-palette entry

```json
{
  "command": "switchboard.startProjectManager",
  "title": "Switchboard: Start Project Manager Agent"
}
```

```ts
context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.startProjectManager', async () => {
        await taskViewerProvider.startOrchestratorFromKanban(undefined, undefined);
    })
);
```

`startOrchestratorFromKanban` already resolves the workspace root, reuses a live terminal, and shows its own error when no workspace is open. Do not re-implement any of that in the command.

---

## Verification Plan

### Automated Tests

* `createAutobanPanel` renders `#btn-project-manager` **before** the mode selector in the returned DOM — assert on child order, not on presence.
* `#oversight-agent-toggle` no longer exists anywhere in `kanban.html`.
* The PM button posts `startOrchestrator` when `orchestrationConfig.enabled` is false and `stopOrchestrator` when it is true, both carrying `workspaceRoot`.
* `#btn-autoban`'s handler posts `startOrchestrator` / `stopOrchestrator`, and its `is-active` class tracks `orchestrationConfig.enabled` — not `autobanConfig.enabled`.
* Reset and pause visibility still tracks `autobanConfig.enabled` (the timer), asserted with `orchestrationConfig.enabled === true` and `autobanConfig.enabled === false` so a wrong split fails.
* No `confirm(` / `window.confirm(` is introduced on any path added here.
* `orchestratorStartResult { success: false }` leaves the button reading `START PROJECT MANAGER`.
* `switchboard.startProjectManager` is present in `package.json` and registered in `extension.ts`.
* Verb allowlist regeneration is clean — this plan adds no verbs, so `catalog:check` / `parity:check` must stay green without a regen.

### Manual Verification

1. **The complaint, directly:** open the board in Internal mode, press the Start Automation icon button. An `Orchestrator` terminal opens, the lead CLI boots, and the kickoff prompt lands. Nothing else was clicked and no tab was opened.
2. **The tab leads with it:** open AUTOMATION. `PROJECT MANAGER` and its START button are the first things under the header. No scrolling.
3. **Round trip:** press STOP from the tab; the toolbar button de-activates. Press START from the toolbar; the tab button reads STOP. The two controls never disagree.
4. **The timer is untouched:** with the run-sheet timer armed beforehand, start and stop the PM agent and confirm the timer stays armed and its pause/reset buttons keep behaving.
5. **Failure reads honestly:** with no CLI configured so the kickoff cannot be delivered, press START and confirm the status line reports the failure and the button settles back to START.
6. **Browser cockpit:** open the same board in the browser and repeat steps 1–3. Same file, so it must behave identically.
7. **Command palette:** run *Switchboard: Start Project Manager Agent* with the board closed; the agent starts and the board reflects it when opened.

---

## Recommendation

Complexity 4 → **Send to Coder.**

**Read the Problem section first.** The engine is not broken and needs no changes — `TaskViewerProvider` and `KanbanProvider` are read-only here. This is entirely a launch-surface change in `kanban.html` plus one command.

**The thing to get right:** *move* the control, do not *add* one. After this change there is exactly one PM start control in the tab (first) and one on the toolbar, and they read the same flag. If the OVERSIGHT AGENT checkbox is still in the file when you finish, the change failed.

**Second:** the flag split in `updateAutobanButtonState`. The button follows `orchestrationConfig.enabled`; pause and reset follow `autobanConfig.enabled`. They are different things and one function now reads both.

**Do not** rename `orchestrationConfig`, `startOrchestratorFromKanban`, `isOversightAgentRunning`, or the `startOrchestrator` / `stopOrchestrator` verbs. The label changed; the code did not.
