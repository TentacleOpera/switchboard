# Guided Setup Button — State-Aware First-Run Onboarding Prompt

**Plan ID:** 9f3b1c2e-6a44-4d8e-bf21-3c7e2a10d5b8

## Goal

Add a **Guided Setup** button to `implementation.html`, directly beneath the existing
`Setup` button (`btn-quick-setup`) in the Quick Actions section. When pressed, it copies a
**tutorial prompt tailored to what the user hasn't done yet** to the clipboard and shows a
VS Code toast telling them where to paste it.

### The problem

A first-time Switchboard user faces a broad surface (agents, kanban, plans, constitution,
projects, design, remote control) with no guided on-ramp. The existing `Setup` button opens
the setup panel but doesn't *teach* — it assumes the user already knows what to configure and
in what order. There's no single action that says "here's the most important next thing for
*you*, and here's an agent prompt that will walk you through it."

### Root cause / context

Switchboard's onboarding is spread across the Setup panel, the Kanban board, `project.html`
(constitution/governance), and the docs (`docs/how_to_use_switchboard.md`,
`docs/switchboard_user_manual.md`). Nothing inspects the user's *actual* state and points them
at the single highest-value next step. The result is that new users either over-configure,
skip the constitution entirely, or never learn the kanban flow.

### The fix (behaviour)

The button inspects three onboarding milestones **in priority order** and generates a prompt
focused on the **first unmet** one:

1. **No registered terminal agent** → introduce **agent setup** (the most important thing —
   nothing works without an agent).
2. **Has agents, but no plans** → teach the **kanban board** and how to create/run plans.
3. **Has agents + plans, but no constitution** → walk through **`project.html`** to establish
   project governance.
4. **All three present** → copy an **"advanced tips"** prompt (epics, `/improve-plan`, design
   panel, multi-repo control plane, remote control) and a toast confirming they're all set.

The prompt **references the relevant doc paths** and instructs the pasted-into agent to read
them and walk the user through that one step interactively — it does not embed doc text
(keeps the clipboard light and always in sync with the docs).

### Companion changes

- **Remove the old `PLUGIN TUTORIAL` button** in the analyst row of the Agents tab — the new
  state-aware Guided Setup button supersedes it. (See step 5.)
- **Add a "Hide Guided Setup button" toggle to `setup.html`** so users who no longer need
  onboarding can dismiss it. (See step 6.)

## Metadata

**Complexity:** 5
**Tags:** feature, frontend, ui, ux

## User Review Required

Yes — review needed before coding on:
1. The four prompt templates' wording and which doc sections each references (see step 3).
2. Whether the "Hide Guided Setup button" toggle should be **global** (current recommendation,
   matches `jules.autoSync` / `persistPanels` which use `ConfigurationTarget.Global`) or
   workspace-scoped.
3. Confirmation that removing the `PLUGIN TUTORIAL` button is desired — it currently dispatches
   an analyst message; the new button copies a prompt instead. Behaviour change is intentional
   but should be signed off.

## Complexity Audit

### Routine
- Adding a single `<button>` element + click listener in `implementation.html` (mirrors neighbouring `btn-quick-setup`).
- Adding a `case 'guidedSetup':` branch to an existing `onDidReceiveMessage` switch.
- Four static prompt-template strings (no dynamic construction beyond milestone selection).
- Toast copy strings (four short variants).
- Deleting the `PLUGIN TUTORIAL` button block + its orphaned message handler (pure removal).
- Adding a checkbox + `change` listener in `setup.html` (mirrors `persistPanelsSetting` pattern).

### Complex / Risky
- **Settings persistence schema registration:** the "Hide Guided Setup" toggle must be registered in `package.json`'s `configuration` schema AND persisted via `vscode.workspace.getConfiguration('switchboard').update(..., ConfigurationTarget.Global)` — missing either half leaves the toggle non-functional or invisible in the Settings UI. This is the single most error-prone step.
- **State-file read factoring:** extracting `_hasRegisteredTerminalAgent()` without disturbing the hot `_refreshTerminalStatuses` path (see step 2 — chosen approach is a standalone duplicate read, not a refactor of the existing method).
- **Cross-provider state sync:** the toggle is set in `SetupPanelProvider` but must reflect in the sidebar (`TaskViewerProvider._postSidebarConfigurationState`) and vice versa.

## Detection surfaces (verified in codebase)

All three checks run in the **extension host** (`TaskViewerProvider`), where the state and the
`vscode` clipboard/toast APIs live — not in the webview.

> **Line numbers below are approximate (verified 2026-07-04).** The coder should grep for the
> named symbols rather than trust the numbers blindly — this file is large and lines drift.

| Milestone | How to detect | Source |
| :--- | :--- | :--- |
| Registered terminal agent | Read the persisted state file via `_resolveStateFilePath()` (defined `TaskViewerProvider.ts:1348`), parse JSON, check `state.terminals` map is non-empty (the parse pattern is visible at `TaskViewerProvider.ts:18538` inside `_refreshTerminalStatuses`, defined at line `18529`). This is the same file `_refreshTerminalStatuses()` reads, so it survives restarts (the in-memory `_registeredTerminals` map does **not** — do not use it). | State file |
| Plans exist | Enumerate `.switchboard/plans/*.md`, **excluding** internal `brain_*.md` files, and check count > 0. | Workspace fs |
| Constitution exists | `constitutionUtils.getConstitutionPath(context, workspaceRoot)` (`constitutionUtils.ts:4`) + `fs.existsSync`. Honours the user's custom constitution path. | `src/services/constitutionUtils.ts` |

## Implementation steps

### 1. Webview — add the button (`src/webview/implementation.html`)

- After the `btn-quick-setup` button (line `1517`), inside `.quick-actions-section`, add:
  ```html
  <button id="btn-guided-setup" class="secondary-btn w-full" style="margin-top: 6px;"
      title="Copy a tutorial prompt tailored to your next setup step, then paste it into an agent chat">Guided Setup</button>
  ```
  (Reuse the exact classes/inline style of the neighbouring Setup button so it matches.)

- Near the existing `btn-quick-setup` listener (line `1779`), add:
  ```js
  const btnGuidedSetup = document.getElementById('btn-guided-setup');
  if (btnGuidedSetup) btnGuidedSetup.addEventListener('click', () => vscode.postMessage({ type: 'guidedSetup' }));
  ```

The webview does **not** compute the prompt or touch the clipboard — it only posts the message.
(Clipboard + toast belong in the host, and `navigator.clipboard` is unreliable in the
sandboxed webview iframe.)

### 2. Extension host — handle the message (`src/services/TaskViewerProvider.ts`)

- In the `onDidReceiveMessage` switch (handler registered at line `8919`), add `case 'guidedSetup':` that calls a new
  private method `_handleGuidedSetup()`.

- `_handleGuidedSetup()`:
  1. Resolve `workspaceRoot` (bail with a toast if none open).
  2. Run the three detection checks above.
  3. Pick the first unmet milestone (agents → plans → constitution → all-done).
  4. Build the tailored prompt (see §3).
  5. `await vscode.env.clipboard.writeText(prompt)` — **wrap in try/catch; only show the success toast if the write resolves without throwing.** On throw, show an error toast ("Couldn't copy to clipboard — see [error]"). This guards against silent clipboard failures on web/remote hosts.
  6. `vscode.window.showInformationMessage(<paste-instruction toast>)`.

- **`_hasRegisteredTerminalAgent(): Promise<boolean>` — implementation choice (Clarification):**
  Add a **standalone** read that calls `_resolveStateFilePath()`, reads + parses the JSON, and
  returns `Object.keys(state.terminals || {}).length > 0`. Wrap in try/catch (missing/unreadable
  file → `false`). Do **NOT** refactor `_refreshTerminalStatuses` to share this read — that
  method is a hot sidebar-init path with PID resolution and cache mutation; duplicating the
  small JSON parse here is cheaper and lower-risk than restructuring it. The duplication is
  ~5 lines and is the explicitly chosen trade-off.

- Reuse `getConstitutionPath` from `constitutionUtils` for the constitution check (do not
  hard-code `CONSTITUTION.md`).

### 3. Prompt templates (reference-by-path)

Four short prompt templates, each naming the doc(s) to read and the step to walk through.

> **Doc anchors:** reference sections by **heading text fragment** (survives renumbering)
> alongside the section number. Verify the exact heading text against the live manual at
> implementation time (grep the doc for the heading). Section numbers below are best-effort
> and may have drifted.

- **Agents:** `docs/how_to_use_switchboard.md` + `docs/switchboard_user_manual.md` §2
  (Installation & First-Time Setup), §3 (Agent Roles & Configuration). Mention the `AGENT SETUP`
  button and registering a terminal agent.
- **Kanban:** user manual §4 (The AUTOBAN), §17 (Core Workflows). Walk through creating a plan
  and dragging a card to dispatch it.
- **Constitution:** user manual §8 (Projects, Epics & Governance) + the Project panel
  (`project.html`). Walk through establishing a constitution.
- **Advanced tips (all done):** user manual §5 (Planning Tools), §7 (Multi-Repo Control Plane),
  §9 (Design Panel), §30 (Remote Control), plus `/improve-plan` and epics.

Each template opens with a line like: *"You are onboarding a Switchboard user. Read
`<doc paths>`, then walk me through `<step>` interactively — one step at a time, checking I've
done each before moving on. Focus only on this; don't dump the whole manual."*

### 4. Toast copy

Short, action-oriented, e.g.:
`Guided setup prompt copied — paste it into your agent chat (Cmd/Ctrl+V) to get walked through <the missing step>.`
Vary the `<the missing step>` phrase per milestone so the toast reflects what was detected.
**Only fire the success toast after the clipboard write resolves** (see step 2.5).

### 5. Remove the old `PLUGIN TUTORIAL` button (`src/webview/implementation.html` + `TaskViewerProvider.ts`)

- Delete the `tutorialBtn` block in `createAnalystRow()` (`implementation.html:3492-3507`) —
  the whole block from `const tutorialBtn = document.createElement('button');` through
  `container.appendChild(tutorialBtn);`.
- Remove the now-orphaned `case 'pluginTutorial':` handler in `TaskViewerProvider.ts`
  (line `10312` through its closing `break;`) — nothing else posts that message, so it becomes
  dead code. **Before deleting:** (a) confirm no other reference to `pluginTutorial` exists
  (grep the webview + host); (b) confirm `markDispatchPending('analyst')` (set at
  `implementation.html:3502` before the post) is **not** shared by another analyst-row button —
  if another button relies on the same pending slot, ensure its own onclick still resets state
  correctly after this path is removed.
- **Leave the separate `COPY TUTORIAL PROMPT` button** (`btn-copy-tutorial-prompt`) in
  `setup.html` untouched — it is a different (clipboard-only) control and out of scope.
- No migration concern: this removes UI + a message handler, not persisted user state.

### 6. "Hide Guided Setup button" toggle (`package.json` + `setup.html` + host + `implementation.html`)

> **CRITICAL — persistence pattern (corrected from original draft):** the original draft said
> "persist to globalState key." That is **wrong**. Every sibling toggle
> (`jules.autoSync`, `planner.designSystemDocEnabled`, `persistPanels`) uses
> `vscode.workspace.getConfiguration('switchboard').update(key, value, ConfigurationTarget.Global)`
> and is **registered in `package.json`'s `configuration` schema**. Follow that pattern exactly.

1. **`package.json`:** register the setting in the `contributes.configuration` schema block
   (alongside `switchboard.jules.autoSync` at line `299`, `switchboard.persistPanels` at `686`):
   ```json
   "switchboard.hideGuidedSetup": {
     "type": "boolean",
     "default": false,
     "description": "Hide the Guided Setup button in the sidebar (for users who have completed onboarding)."
   }
   ```
2. **setup.html:** add a checkbox in the existing **"Switchboard guide"** section
   (`setup.html:589-596`), labelled e.g. *"Hide the Guided Setup button in the sidebar"*. On
   `change`, post `{ type: 'setHideGuidedSetup', enabled }` to the setup panel provider.
   Initialise its checked state from a `hideGuidedSetupSetting` message on load.
3. **Host (`TaskViewerProvider` + `SetupPanelProvider`):**
   - In `TaskViewerProvider`, add `handleSetHideGuidedSetup(enabled)` →
     `vscode.workspace.getConfiguration('switchboard').update('hideGuidedSetup', enabled, vscode.ConfigurationTarget.Global)`,
     then refresh both panels. Add `handleGetHideGuidedSetup(): boolean` →
     `vscode.workspace.getConfiguration('switchboard').get<boolean>('hideGuidedSetup', false)`
     (default `false` = visible). Mirror the `handleGetJulesAutoSyncSetting` /
     `handleSetStatusShowTerminalsSetting` shapes (see `TaskViewerProvider.ts:4132` and the
     `setStatusShowTerminalsSetting` handler in `SetupPanelProvider.ts:652`).
   - Handle the `setHideGuidedSetup` message in `SetupPanelProvider`'s `onDidReceiveMessage`
     (switch starts `SetupPanelProvider.ts:71`); delegate to
     `this._taskViewerProvider.handleSetHideGuidedSetup(enabled)`, then
     `await vscode.commands.executeCommand('switchboard.refreshUI')` (matches
     `setStatusShowTerminalsSetting` pattern at `SetupPanelProvider.ts:652-655`).
   - In `_postSidebarConfigurationState` (`TaskViewerProvider.ts:4394`), post
     `{ type: 'hideGuidedSetupSetting', enabled }` (mirrors the `designSystemDocSetting` post at
     `TaskViewerProvider.ts:4426-4430`).
   - In `postSetupPanelState` (`TaskViewerProvider.ts:4441`), post the same so the checkbox
     reflects saved state on open.
4. **implementation.html:** on `hideGuidedSetupSetting`, toggle `#btn-guided-setup`'s
   visibility (`style.display`). Default visible until a message says otherwise, so nothing
   flickers on cold boot.

## Edge-Case & Dependency Audit

### Race Conditions
- **Point-in-time detection on click:** detection reads state at click time, not continuously. A user who registers an agent after clicking once will get the correct next rung on the next click. No stale-cache risk because each click re-reads. Safe.
- **Toggle vs. button-render race:** the `hideGuidedSetupSetting` message is pushed from the host on config-state refresh. The button defaults to visible on cold boot, so a slow host push cannot hide-then-show (flicker). If the user toggles hide then immediately reloads, the host reads the persisted config on init — no race.

### Security
- No secrets, credentials, or user-generated content handled. Prompt templates are static strings. Clipboard write is host-scoped. No injection surface (templates don't interpolate user input).

### Side Effects
- Removing the `PLUGIN TUTORIAL` button removes an analyst-dispatch path. The `markDispatchPending('analyst')` UI state set before the post must be confirmed not to strand the analyst-row dispatch indicator (see step 5 pre-delete check).
- `vscode.workspace.getConfiguration().update(..., Global)` writes to user `settings.json` — a real, visible side effect. This is the intended behaviour (matches sibling toggles) but the coder should be aware the setting lands in the user's global settings.json, not a hidden store.

### Dependencies & Conflicts
- **Depends on:** `constitutionUtils.getConstitutionPath` (stable, `constitutionUtils.ts:4`), `_resolveStateFilePath` (stable, `TaskViewerProvider.ts:1348`), the state-file `terminals` map schema (stable, read at `TaskViewerProvider.ts:18538`).
- **Conflicts:** none expected — adds a new message type and a new setting; does not alter existing handlers.
- **Doc section drift:** prompt templates cite section numbers that may drift. Mitigated by also citing heading-text fragments (see step 3). Renames require updating template strings only (no embedded doc text to re-sync).

## Dependencies

- None. This plan is self-contained; no other plan must complete first.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the "Hide Guided Setup" toggle's settings-schema registration in `package.json` — missing it leaves the toggle invisible in the Settings UI and non-persistent in the expected way (corrected from the original draft's wrong "globalState" approach); (2) the `PLUGIN TUTORIAL` removal stranding the `markDispatchPending('analyst')` UI state if another analyst-row button shares that slot; (3) doc section-number drift in the prompt templates. Mitigations: follow the verified `vscode.workspace.getConfiguration` + `package.json` pattern exactly; run the pre-delete grep check in step 5; reference doc sections by heading-text fragment alongside numbers. Complexity stays at 5 — multi-file but extending existing patterns with one moderate, now-mitigated risk.

## Proposed Changes

### `src/webview/implementation.html`
- **Context:** Quick Actions section (~line 1517) holds `btn-quick-setup`; analyst row (`createAnalystRow`, ~line 3488) holds the `PLUGIN TUTORIAL` button.
- **Logic:** Add `#btn-guided-setup` after `btn-quick-setup`; add click listener near line 1779 posting `{ type: 'guidedSetup' }`. Delete the `tutorialBtn` block (lines 3492-3507). Handle `hideGuidedSetupSetting` message to toggle button visibility.
- **Implementation:** See steps 1, 5, 6.4 above.
- **Edge Cases:** Button must default visible (no flicker on cold boot). Confirm `markDispatchPending('analyst')` not stranded by tutorial removal.

### `src/services/TaskViewerProvider.ts`
- **Context:** `onDidReceiveMessage` switch at line 8919; `_postSidebarConfigurationState` at 4394; `postSetupPanelState` at 4441; `_resolveStateFilePath` at 1348; `_refreshTerminalStatuses` at 18529 (state-file `terminals` read at 18538); `pluginTutorial` case at 10312.
- **Logic:** Add `case 'guidedSetup':` → `_handleGuidedSetup()` (detect milestone, build prompt, clipboard write with try/catch, toast on success). Add `_hasRegisteredTerminalAgent()` standalone read. Add `handleGetHideGuidedSetup` / `handleSetHideGuidedSetup` using `vscode.workspace.getConfiguration('switchboard')` + `ConfigurationTarget.Global`. Post `hideGuidedSetupSetting` in `_postSidebarConfigurationState` and `postSetupPanelState`. Delete `case 'pluginTutorial':` (line 10312+).
- **Implementation:** See steps 2, 5, 6.3 above.
- **Edge Cases:** Clipboard write may throw on web/remote — guard toast on success. State file missing → treat as "no agents" (rung 1).

### `src/services/SetupPanelProvider.ts`
- **Context:** `onDidReceiveMessage` switch at line 71; `setStatusShowTerminalsSetting` pattern at line 652.
- **Logic:** Add `case 'setHideGuidedSetup':` delegating to `this._taskViewerProvider.handleSetHideGuidedSetup(enabled)` then `vscode.commands.executeCommand('switchboard.refreshUI')`.
- **Implementation:** See step 6.3 above.
- **Edge Cases:** None beyond the shared persistence pattern.

### `src/webview/setup.html`
- **Context:** "Switchboard guide" section at lines 589-596.
- **Logic:** Add checkbox labelled "Hide the Guided Setup button in the sidebar"; on `change` post `{ type: 'setHideGuidedSetup', enabled }`; initialise from `hideGuidedSetupSetting` message.
- **Implementation:** See step 6.2 above.
- **Edge Cases:** Checkbox must reflect persisted state on panel open (host pushes `hideGuidedSetupSetting` in `postSetupPanelState`).

### `package.json`
- **Context:** `contributes.configuration` schema (`switchboard.jules.autoSync` at line 299, `switchboard.persistPanels` at 686).
- **Logic:** Register `switchboard.hideGuidedSetup` (boolean, default false).
- **Implementation:** See step 6.1 above.
- **Edge Cases:** Missing this entry is the #1 failure mode — the toggle will not persist or appear in Settings UI without it.

### `src/services/constitutionUtils.ts`
- **No changes** — reused as-is (`getConstitutionPath` at line 4).

## Verification Plan

### Automated Tests
- **Per session directive: automated tests are SKIPPED** in this verification plan. The repo's testing approach is via installed VSIX with `src/` as source of truth; no test run is required here.
- **If tests are later desired:** unit-test the milestone-selection function (state inputs → chosen rung) and `_hasRegisteredTerminalAgent` in isolation.

### Manual Verification
- **Per session directive: compilation is SKIPPED** — do not run `npm run compile` as a verification step.
- With (a) zero agents, (b) agents but no plans, (c) agents+plans but no constitution, (d) all three — click the Guided Setup button and confirm:
  - The clipboard payload targets the correct milestone.
  - The toast text matches the detected milestone.
  - The toast only fires on successful clipboard write (test on web/remote if feasible).
- Confirm the analyst-row `PLUGIN TUTORIAL` button is gone and no console error fires from the removed `pluginTutorial` path.
- Toggle "Hide Guided Setup button" in `setup.html` → the sidebar button disappears immediately (no reload); untoggle → it returns; setting persists across a window reload (verify it landed in user `settings.json` under `switchboard.hideGuidedSetup`).
- Confirm the setting appears in VS Code Settings UI (search "switchboard hide guided") — this validates the `package.json` schema registration.

## Out of scope

- Changing the existing `Setup` button behaviour.
- Auto-showing/dismissing on first run — the button is manual and always-available (except when
  the user hides it via the setup toggle in step 6).
- Removing or changing the `COPY TUTORIAL PROMPT` button in `setup.html`.
- Localizing the prompt/toast text.

## Recommendation

Complexity 5 → **Send to Coder.**

## Review Findings

Reviewer pass (2026-07-05) — implementation verified across `package.json`, `TaskViewerProvider.ts`, `SetupPanelProvider.ts`, `implementation.html`, `setup.html`. All six plan steps are present: button + listener, `guidedSetup` case → `_handleGuidedSetup()` with three-milestone detection in priority order, four reference-by-path prompt templates with heading-text fragments matching the live manual (§2/3/4/5/7/8/9/17/30 all confirmed), `pluginTutorial` button + handler fully removed (no orphaned refs in `src/`), and the `hideGuidedSetup` toggle registered in `package.json` + persisted via `ConfigurationTarget.Global` + pushed from both `_postSidebarConfigurationState` and `postSetupPanelState` (cross-panel sync via `refreshUI` → `_refreshConfigurationState` confirmed). Three NIT fixes applied: (1) advanced-tips prompt had awkward "/improve-plan / features features" duplication left by the epics→features rename → cleaned to "/improve-plan and features tooling"; (2) clipboard error toast kept the plan's literal "[error]" placeholder → replaced with the real error; (3) `getHideGuidedSetupSetting` case in `SetupPanelProvider` was dead code (setup.html never requested it) → added the request to the setup-tab load callback, matching the `getPersistPanelsSetting` pattern so the checkbox re-hydrates on tab activation. `markDispatchPending('analyst')` not stranded — the sendAnalystMessage and queryArchives buttons still set/reset it. Verification: compilation and automated tests skipped per session directive; static trace of all callers/consumers shows no signature, side-effect, or timing regressions. Files changed in this review: `src/services/TaskViewerProvider.ts`, `src/webview/setup.html`. Remaining risk: doc section numbers in prompt templates may drift on future manual edits (mitigated by heading-text fragments already cited alongside numbers).
