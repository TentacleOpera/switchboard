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

1. **No registered terminal agents** → introduce **agent setup** (the most important thing —
   nothing works without an agent).
2. **Has agents, but no plans** → teach the **kanban board** and how to create/run plans.
3. **Has agents + plans, but no constitution** → walk through **`project.html`** to establish
   project governance.
4. **All three present** → copy an **"advanced tips"** prompt (epics, `/improve-plan`, design
   panel, multi-repo control plane, remote control) and a toast confirming they're all set.

The prompt **references the relevant doc paths** and instructs the pasted-into agent to read
them and walk the user through that one step interactively — it does not embed doc text
(keeps the clipboard light and always in sync with the docs).

## Detection surfaces (verified in codebase)

All three checks run in the **extension host** (`TaskViewerProvider`), where the state and the
`vscode` clipboard/toast APIs live — not in the webview.

| Milestone | How to detect | Source |
| :--- | :--- | :--- |
| Registered terminal agent | Read the persisted state file via `_resolveStateFilePath()`, parse JSON, check `state.terminals` map is non-empty. This is the same file `_refreshTerminalStatuses()` reads (`src/services/TaskViewerProvider.ts:18653`), so it survives restarts (the in-memory `_registeredTerminals` map does **not** — do not use it). | State file |
| Plans exist | Enumerate `.switchboard/plans/*.md`, **excluding** internal `brain_*.md` files, and check count > 0. | Workspace fs |
| Constitution exists | `constitutionUtils.getConstitutionPath(context, workspaceRoot)` + `fs.existsSync`. Honours the user's custom constitution path. | `src/services/constitutionUtils.ts` |

## Implementation steps

### 1. Webview — add the button (`src/webview/implementation.html`)

- After the `btn-quick-setup` button (line ~1517), inside `.quick-actions-section`, add:
  ```html
  <button id="btn-guided-setup" class="secondary-btn w-full" style="margin-top: 6px;"
      title="Copy a tutorial prompt tailored to your next setup step, then paste it into an agent chat">Guided Setup</button>
  ```
  (Reuse the exact classes/inline style of the neighbouring Setup button so it matches.)

- Near the existing `btn-quick-setup` listener (line ~1779), add:
  ```js
  const btnGuidedSetup = document.getElementById('btn-guided-setup');
  if (btnGuidedSetup) btnGuidedSetup.addEventListener('click', () => vscode.postMessage({ type: 'guidedSetup' }));
  ```

The webview does **not** compute the prompt or touch the clipboard — it only posts the message.
(Clipboard + toast belong in the host, and `navigator.clipboard` is unreliable in the
sandboxed webview iframe.)

### 2. Extension host — handle the message (`src/services/TaskViewerProvider.ts`)

- In the `onDidReceiveMessage` switch (~line 9029), add `case 'guidedSetup':` that calls a new
  private method `_handleGuidedSetup()`.

- `_handleGuidedSetup()`:
  1. Resolve `workspaceRoot` (bail with a toast if none open).
  2. Run the three detection checks above.
  3. Pick the first unmet milestone (agents → plans → constitution → all-done).
  4. Build the tailored prompt (see §3).
  5. `await vscode.env.clipboard.writeText(prompt)`.
  6. `vscode.window.showInformationMessage(<paste-instruction toast>)`.

- Reuse existing helpers where present: the state-file read pattern from
  `_refreshTerminalStatuses`, and `getConstitutionPath` from `constitutionUtils`. Factor the
  state-file `terminals` read into a small `_hasRegisteredTerminalAgent(): Promise<boolean>`
  helper if one doesn't already exist, so the check is testable in isolation.

### 3. Prompt templates (reference-by-path)

Four short prompt templates, each naming the doc(s) to read and the step to walk through.
Suggested doc anchors (confirm section numbers against the live doc when writing):

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

## Edge cases & risks

- **No workspace open** → toast "Open a workspace folder to use Guided Setup." No copy.
- **State file missing/unreadable** → treat as "no agents" (rung 1). Wrap the read in try/catch;
  never throw out of the click handler.
- **`brain_*.md` false positives** → must be excluded from the plan count or a fresh install
  with only internal brain files would skip the kanban tutorial.
- **Custom constitution path** → always go through `getConstitutionPath`, never hard-code
  `CONSTITUTION.md`, so users who relocated it aren't told it's missing.
- **Docs drift** → because we reference paths (not embedded text), section renames only require
  updating the template strings, not re-syncing copied content. Note the section numbers are a
  soft dependency — verify against the live manual at implementation time.
- **No confirmation dialog** anywhere (per repo rule). The button copies immediately.

## Out of scope

- Changing the existing `Setup` button behaviour.
- Persisting "guided setup dismissed/completed" state or auto-showing on first run — this is a
  manual, always-available button.
- Localizing the prompt/toast text.

## Verification

- Manual: with (a) zero agents, (b) agents but no plans, (c) agents+plans but no constitution,
  (d) all three — click the button and confirm the clipboard payload targets the correct
  milestone and the toast text matches.
- Unit: test the milestone-selection function (state inputs → chosen rung) and
  `_hasRegisteredTerminalAgent` in isolation, per the repo's testing approach (installed VSIX,
  `src/` as source of truth).

## Metadata

**Complexity:** 4
**Tags:** feature, frontend, ui, ux
