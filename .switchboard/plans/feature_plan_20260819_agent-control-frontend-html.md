# Add the Agent Control View Mode to `kanban.html`

## Goal
Render the **Agents**, **Teams**, and **Prompts** tabs as a standalone Agent Control view that hides the Kanban board, Automation, Worktrees, UAT, and Setup tabs, and persist that view's active sub-tab and selected role. This is a dark-launch, visibility-only change: with no opt-in attribute present, the board renders byte-identically to today.

> **Superseded:** "Produce a new `src/webview/agent-control.html` … Copy `src/webview/kanban.html` to `src/webview/agent-control.html`."
> **Reason:** `kanban.html` is 12,743 lines with a single ~8,800-line inline script, and it is one of the most frequently edited files in the repo. A physical copy renders correctly on day one and then drifts silently forever: every future fix to the Agents/Teams/Prompts tabs (or to the shared helpers they call — `loadRoleConfigs()`, `agentsTabPopulateRoleSelect()`, `teamsTabRenderGallery()`, `updateRoleDescription()`) must be applied twice, with no gate that detects the miss. The copy also forces a second 30-entry `{{ICON_*}}` substitution map in `headlessPanelHtml.ts` (`getBoardHtml`, lines 188–221) and a second nonce/transport-shim pipeline. Duplication is the *opposite* of the lesson from the `tickets.html`/`planning.html` extractions — that lesson was "port the CSS wholesale", and reusing the same file is the limit case of porting wholesale.
> **Replaced with:** Keep exactly one file. Add an opt-in `data-view="agent-control"` attribute on `<body>`, injected by the host that serves the page. `kanban.html` gains one CSS block and one branch in its existing tab-initialisation code; every other host (the board) omits the attribute and is completely unaffected.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, feature
- **Project:** Browser Switchboard

## Background & Problem Analysis

- The three tabs live inside a 12,661-line `kanban.html` (tab bar at ~2894, content at ~3142-3643) with a single ~8,800-line inline script. Their HTML, CSS, and message handlers are not isolated from the board.
- The `tickets.html` extraction broke partly because the CSS and JS were manually split. The safest first step is to serve the full Kanban HTML under a new name and use a body class to suppress the unrelated tabs, preserving all handlers and theme rules.
- Afterburner and Claudify theme CSS is already in the file, so the three tabs should render correctly immediately as long as the hiding class does not overrule them.

### Verified facts (read from source during this pass)

- **The tab bar has eight buttons, not six.** `src/webview/kanban.html:2918-2926` declares `kanban`, `agents`, `teams`, `prompts`, `automation`, `worktrees`, `uat`, `setup`. A rule that hides only KANBAN / AUTOMATION / WORKTREES leaves **UAT** and **SETUP** visible in the Agent Control view.
- **The content container is `#kanban-tab-content`, not `#kanban-content`** (`kanban.html:2930`). The sibling containers are `#automation-tab-content` (3012), `#uat-tab-content` (3022), `#setup-tab-content` (3037), `#agents-tab-content` (3167), `#teams-tab-content` (3255), `#prompts-tab-content` (3392), `#worktrees-tab-content` (3834).
- **Hiding the KANBAN button alone yields a blank panel.** `kanban.html:5967-5970` runs `document.querySelector('.shared-tab-btn.active').click()` on load. The `active` class is hard-coded on the KANBAN button (2918) and on `#kanban-tab-content` (2930). If those stay put and are merely hidden by CSS, the initialiser activates a hidden tab and *no* visible tab is selected. The active markers must be **moved** to AGENTS at runtime before that initialiser runs.
- **Tab hydration is click-driven.** The `agents`, `teams`, and `prompts` arms of the click handler (`kanban.html:5925-5957`) are what post `getStartupCommands`, `getCustomAgents`, `getAgentGroups` and call `loadRoleConfigs()` / `teamsTabRenderGallery()`. Routing the synthetic initial `click()` at AGENTS is therefore also what hydrates the view — no separate bootstrap call is needed.
- **State seeding order is contract-enforced.** `src/test/panel-revival-retention-contract.test.js:108-131` asserts that in `kanban.html` the **first** textual occurrence of `getState()` is the one inside the `sb-initial-state` seed block (`kanban.html:3848-3849`). Any new `getState()` call must appear *after* that block or the contract test fails.
- **No new host verb is required for persistence.** `vscode.getState()`/`setState()` is per-webview in the editor and `localStorage`-backed in the browser (`src/webview/transport.js:26-46`). Persisting the active sub-tab and role through `setState` needs no message, so it cannot trip `src/test/browser-panel-verb-routing.test.js:180-186` ("every posted verb is in KANBAN_VERBS") and needs no `npm run catalog:generate`.
- **In the browser, both views share one `localStorage` key.** `transport.js:26` derives `localStorageKey = 'sb-state-' + panel` from `data-panel`, and the Agent Control view keeps `data-panel="kanban"` (see the provider and browser subtasks — the verb route prefix is derived from the same attribute). The board at `/board` and Agent Control at `/agent-control` therefore read and write the *same* state blob, so the view's own keys must be namespaced.

## User Review Required

None. The view-mode mechanism, the attribute name, the tab set, and the state-namespacing rule are all decided in this plan.

## Complexity Audit

### Routine
- Adding a scoped CSS block that hides five tab buttons and their content containers.
- Moving the `active` class from KANBAN to AGENTS at runtime.
- Reading and writing two scalars (active tab, selected role) through the existing `vscode.getState()`/`setState()` pattern.

### Complex / Risky
- The edit lands in `kanban.html`, the repo's most-edited webview and the subject of 20+ contract tests. The change must be strictly additive and inert when the attribute is absent.
- The runtime re-marking of the active tab must run **before** `kanban.html:5967` executes, and inside the same inline script (there is only one).
- A new `getState()` call placed above `kanban.html:3849` silently fails `panel-revival-retention-contract.test.js`.
- Namespacing the view's persisted state without disturbing the board's existing `state.collapseCodersEnabled` / `state.currentAutomationMode` / `state.currentWorkspaceRoot` keys, which both views write to the same browser blob.

## Edge-Case & Dependency Audit

- **Race Conditions:** The active-tab re-marking and the initial `click()` are both synchronous and in the same script; ordering is positional, not temporal, so there is no race. The persisted-tab restore must also be applied *before* the `click()` so the restored tab is the one hydrated — restoring afterwards would leave the view showing tab A while tab B's data was fetched.
- **Security:** None. No new network surface, no new message verb, no user-supplied string reaches the DOM. The `data-view` value is host-injected, never user-controlled, and is compared against a literal.
- **Side Effects:** The board's own JS still runs in the Agent Control view — the board DOM exists, is hidden, and continues to process `updateBoard` pushes. This is accepted (see Adversarial Synthesis): it costs a hidden re-render and buys total behavioural parity. It must NOT be "optimised" by suppressing board messages, which would break the shared helpers the three tabs read from.
- **Dependencies & Conflicts:** This plan owns **every** change to `src/webview/kanban.html` for this feature. The provider subtask injects the attribute in the editor; the browser subtask injects it over HTTP. Neither edits this file.

## Dependencies

None.

## Adversarial Synthesis

Key risks: a hidden-but-active KANBAN tab renders a blank panel; the five-tab hide list is easy to under-count (UAT and SETUP are the ones missed); and a `getState()` call inserted above the `sb-initial-state` seed block breaks an existing contract test. Mitigations: move the `active` markers at runtime rather than hiding them in place, drive the hide list from an explicit allow-list of the three kept tabs rather than a deny-list, and place all new state code below `kanban.html:3849`. The residual accepted cost is that the board's JS still executes behind the hidden view — deliberate, because suppressing it is what broke previous extractions.

## Proposed Changes

### `src/webview/kanban.html`

**Context.** One file, one inline script, eight tabs. The opt-in marker is `document.body.dataset.view === 'agent-control'`, injected by the host. Absent ⇒ every behaviour below is skipped and the file behaves exactly as it does today.

**Logic.**
1. **CSS (add beside the existing `.shared-tab-btn` rules, ~`kanban.html:2853-2911`).** Under a `body[data-view="agent-control"]` prefix, hide the five non-target tab buttons and their five content containers. Write it as an **allow-list** so a future tab added to the bar is hidden by default rather than silently appearing:

   ```css
   body[data-view="agent-control"] .shared-tab-btn:not([data-tab="agents"]):not([data-tab="teams"]):not([data-tab="prompts"]) { display: none; }
   body[data-view="agent-control"] #kanban-tab-content,
   body[data-view="agent-control"] #automation-tab-content,
   body[data-view="agent-control"] #worktrees-tab-content,
   body[data-view="agent-control"] #uat-tab-content,
   body[data-view="agent-control"] #setup-tab-content { display: none !important; }
   ```
   The `!important` is required on the content containers only: `.shared-tab-content.active` (`kanban.html:2886`) sets `display` and would otherwise win when a hidden tab is the active one.

2. **Active-tab re-marking (immediately above `kanban.html:5967`, before `initialTabBtn.click()`).** When the view mode is on, strip `active` from the KANBAN button and `#kanban-tab-content`, then apply it to the restored tab — the persisted tab if it is one of the three, otherwise AGENTS. Because the existing `initialTabBtn` lookup selects `.shared-tab-btn.active`, the subsequent `click()` then lands on the correct tab and runs its hydration arm unchanged.

3. **State persistence (all new code strictly below `kanban.html:3849`).** Namespace under a single sub-key so the board's blob is untouched and the shared browser `localStorage` entry cannot collide:
   - Write on tab switch and on role selection: read `vscode.getState() || {}`, merge `{ agentControl: { activeTab, role } }`, `vscode.setState(...)`.
   - Read once during step 2 to pick the initial tab, and after `loadRoleConfigs()` resolves to re-select the stored role.
   - Guard every read and write on the view mode being active, so the board never writes an `agentControl` key.

**Edge Cases.**
- Persisted tab is `kanban`/`worktrees`/stale ⇒ not in the allow-list ⇒ fall back to AGENTS rather than activating a hidden tab.
- Persisted role no longer exists (agent deleted) ⇒ leave the role selector on its default; do not force-select a missing option.
- `vscode.getState()` returns `undefined` on a cold browser load ⇒ the `|| {}` fallback already covers it; do not add a second seed path.
- The attribute is absent (the board) ⇒ no CSS matches, no branch is entered, no `agentControl` key is ever written.

## Verification Plan

### Automated Tests
- `npm run compile` — the webpack `CopyPlugin` pattern is the glob `src/webview/*.html → webview/[name][ext]` (`webpack.config.js`), so no build-config change is needed and none should be made.
- `npm run test:contract:kanban`.
- `node --test src/test/panel-revival-retention-contract.test.js` — specifically guards the `getState()`-below-the-seed ordering this plan depends on.
- `node --test src/test/browser-panel-verb-routing.test.js` — proves no new verb was introduced.

### Manual
- Board unchanged: open the Kanban panel, confirm all eight tabs are present and the board renders.
- Agent Control view: confirm exactly three tab buttons (AGENTS, TEAMS, PROMPTS), AGENTS active on load, and that the role selector, custom-agent list, and team gallery populate.
- Switch to PROMPTS, select a role, reload: the same tab and role are restored.
- Confirm the Afterburner and Claudify themes render the three tabs correctly.

## Recommendation

**Send to Coder** (complexity 5).

## Completion Report

Implemented the Agent Control view mode in `src/webview/kanban.html` as a strictly additive, opt-in change gated on `<body data-view="agent-control">` (injected by the host subtasks, not this file). Added a CSS allow-list block that hides the five non-target tab buttons and their content containers (KANBAN/AUTOMATION/WORKTREES/UAT/SETUP) with `!important` on the containers to beat `.shared-tab-content.active`. Added an active-tab re-marking block before the `initialTabBtn` lookup that moves the `active` class off the hard-coded KANBAN tab onto the persisted target tab (default AGENTS) so the synthetic `click()` hydrates a visible tab instead of a blank panel. Added namespaced state persistence (`agentControl: { activeTab, role }`) via `vscode.getState()/setState()`, written on tab switch and role-select change, and restored on init / after `loadRoleConfigs()` resolves (in the `settingResult` selectedRole handler), with a stale-role guard that drops a deleted-agent role so the selector stays on its default. All new `getState()` calls sit well below the `sb-initial-state` seed block, preserving the `panel-revival-retention-contract` ordering. No issues encountered; with the attribute absent the board renders byte-identically.

## Review Findings

Reviewed `src/webview/kanban.html` in commit `744a895f`. The CSS allow-list, the active-tab re-marking ahead of the `initialTabBtn` lookup, and the `getState()`-below-the-seed ordering are all correct and the board path is genuinely inert without the attribute. Two defects delegated: (1) CRITICAL — the same commit swept in an unrelated `phoneAFriendSelected` posting without its generated catalog half, so `browser-panel-verb-routing.test.js` (a gate this plan names) is red at HEAD; (2) MAJOR — the `settingResult` selectedRole arm nulls `_agentControlPendingRole` unconditionally, permanently destroying a valid persisted `custom_agent_*` role when the restored tab is TEAMS (whose hydration arm never posts `getCustomAgents`), and the host-global `selectedRole` always wins so the namespaced `agentControl.role` is unreachable after first use. Deferred: browser cross-tab `localStorage` blob overwrite (`transport.js` holds one module-level `state` object, so namespacing prevents key collision but not whole-blob overwrite). Note for future passes — this plan's Automated section names `npm run test:contract:kanban`, which does not exist in `package.json`; `test:contract:panel-revival-retention` and `test:contract:browser-panel-verb-routing` are both correctly invoked by `.github/workflows/integration-tests.yml`.

**Review closed — PASS.** All findings resolved across four fix rounds (`513fd654`, `c29377ed`, `cbed74d8`, `6ef4dc10`). `npm run compile` clean; `panel-revival-retention-contract`, `teams-tab-no-start`, `autoban-state` and the kanban.html half of `browser-panel-verb-routing` all green. Two failures remain in the suite and are confirmed pre-existing, not from this work — `connections.js` (`copyTextToClipboard`) and `transport.js` (double-filter) have zero commits in `ba8f5910..HEAD`. Residual risk: `744a895f` bundled four unrelated in-flight features into the same files, so it will not bisect cleanly; and `npm run test:contract:kanban`, named in two of these plans' Automated sections, does not exist in `package.json`.
