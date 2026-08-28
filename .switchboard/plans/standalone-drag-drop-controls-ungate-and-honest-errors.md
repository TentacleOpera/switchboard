# Reverse the standalone drag-drop gate: restore the cli/prompt controls and replace the dead-end errors

## Goal

Standalone was deliberately shipped without drag-drop advance controls: the CLI-triggers toggle and the per-column Drag & Drop Mode selector are hidden by host-capability CSS, and a forward drag surfaces a red toast the user cannot act on because the toggle that would clear it is not on screen. That decision is overturned. Make the browser board's drag-drop controls reachable, and make every remaining refusal state what to do about it.

### Problem Analysis

Host capabilities are injected into the panel body as `data-host-capabilities` (`src/services/headlessPanelHtml.ts:184`) and turned into CSS by `applyCapabilityGating` (`src/webview/transport.js:449`). The two composition roots declare them differently:

| Capability | Extension (`TaskViewerProvider.ts:4062`) | Standalone (`bootstrap.ts:861`) |
| :--- | :--- | :--- |
| `terminalDispatch` | `true` | `ptyReady` |
| `automation` | `true` | **`false`** |
| `boardStructure` | `true` | **omitted → `false`** |
| `featureAdvanced` | `true` | **omitted → `false`** |
| `terminalFleet` | `ptyHostReady()` | `ptyReady` |

`DEFAULT_HOST_CAPABILITIES` (`headlessPanelHtml.ts:31-43`) is fail-closed, so an omitted flag is a `false`, not an "unset".

What those two flags hide on the board:

1. **`automation: false`** injects (`transport.js:568-580`) `display:none` for `#btn-cli-triggers` — the only surface for the `toggleCliTriggers` verb (`kanban.html:3017`, handler `:11831`). The browser cannot turn CLI triggers on or off.
2. **`boardStructure: false`** injects (`transport.js:560-578`) `display:none` for `#kanban-structure-list`, `#btn-add-kanban-column`, `#btn-restore-kanban-defaults`. The **Drag & Drop Mode** selector (`kanban.html:3963-3967`, `cli` / `prompt`) lives in `#kanban-column-modal`, which is opened only by clicking a row in that hidden list. Hiding the list hides the selector.
3. **`terminalDispatch: false`** (only when node-pty failed to load) hides `moveSelected` / `moveAll`. This one is honest and stays.

The visible error. `transport.js:376-390` turns any `{success:false, error}` verb response into a red status toast. A forward drag in standalone posts `triggerAction`, which fails in two ways:

- `bootstrap.ts:2079-2083` → `'CLI triggers are disabled'` when `kanban.cliTriggersEnabled` is false. **Unrecoverable from the browser** — the toggle is hidden by (1).
- `bootstrap.ts:1459-1467` → `'PTY terminals are unavailable: the optional node-pty module could not be loaded on this machine.'` Honest, but it does not tell the user the alternative (a `prompt`-mode column, or CLI triggers off for move-only), and the controls for both alternatives are hidden.

The third state is silent rather than loud, and is the companion plan's subject: with CLI triggers ON and no `updateAgentNames` push, `kanban.html:10206` discards forward ids before any verb is posted. The only feedback is an 800ms colour change on `#agent-<col>` — an element that renders **blank** in standalone, because `updateAllColumnAgents` (`:8534`) renders `name || ''` on an empty `lastAgentNames`.

### Root Cause

`boardStructure: false` was justified in a comment that is now false. `transport.js:563-570` states the controls "genuinely cannot work headlessly: standalone's pushFullState publishes `updateColumns` from the CONSTANT DEFAULT_KANBAN_COLUMNS (bootstrap.ts:334, :363), so a saved custom column is written to the DB and never rendered." At HEAD those line numbers are PTY prompt-composition code, and `pushFullState` delegates to `getFullStateMessages`, which builds columns from `_buildKanbanColumns(customAgents, customKanbanColumns)` (`KanbanProvider.ts:1351-1357`) with `_getCustomKanbanColumns` reading through the wired `taskViewerProvider`. The premise for the gate was removed when the state builder was unified; the gate outlived it.

`automation: false` is a coarser problem: it bundles genuinely-unavailable surfaces (autoban timers, remote control, planner buttons) with one that is not (the CLI-triggers toggle, whose verb standalone already serves through the `default:` arm and whose setting `bootstrap.ts:2079` already reads). One flag, two meanings.

## Metadata

**Complexity:** 6
**Tags:** ui, ux, frontend, bugfix, reliability

## Approach

1. **Re-derive `boardStructure` for standalone honestly.** Confirm by test that a custom column saved in the browser renders in the browser (the premise the old comment denied), then declare `boardStructure: true` in `baseStandaloneCapabilities`. Delete the stale justification comment in `transport.js` rather than leaving a contradicted rationale in place. If any part of the structure editor genuinely still cannot work headlessly, gate *that control* on a new, honestly-named flag — never leave a working surface hidden by a flag that means something else.

2. **Split the CLI-triggers toggle out of `automation`.** The toggle is not automation: it decides what a drag does, and standalone already honours the setting server-side. Either introduce a narrow capability (e.g. `dragDispatch`) or move `#btn-cli-triggers` out of the `automation` selector list. Prefer the second if no other flag needs it — one fewer flag beats one more. Leave `#btn-autoban`, `#btn-remote-control`, the autoban timers, and the planner buttons gated exactly as they are.

3. **Keep `terminalDispatch` as-is.** On a machine with no node-pty, CLI dispatch really is unavailable. The controls that must remain reachable there are the ones that let the user *choose the other path* — CLI triggers off (move-only) and `prompt` mode — which is what steps 1-2 restore.

4. **Make the refusals actionable.** Three call sites:
   - `bootstrap.ts:2079` — extend `'CLI triggers are disabled'` to name the recovery ("turn CLI triggers on in the board toolbar, or set this column to Clipboard Prompt mode").
   - `bootstrap.ts:1461` — extend the PTY message the same way.
   - `kanban.html:10206` — replace the silent strip. When forward ids are discarded, show the same status toast the verb path would ("No agent assigned to *Lead Coder* — assign one in Setup, or switch this column to Clipboard Prompt mode"). The existing 800ms colour flash on a blank element is not feedback.

5. **Do not add a confirmation dialog anywhere in this work.** Per `CLAUDE.md`: a drag is a deliberate act, and `window.confirm()` is a silent no-op in VS Code webviews. The toast is a report, never a gate.

6. **Both roots, one diff.** The capability declaration changes in `bootstrap.ts`; the selector lists change in the shared `transport.js`; the drop-path message changes in the shared `kanban.html`. Verify the extension's board is untouched by the shared-file edits — `automation: true` / `boardStructure: true` there means the selector-list edits must be no-ops for the editor.

## Complexity Audit

### Routine

- Adding two keys to a capability literal.
- Editing two selector lists in `transport.js`.

### Complex / Risky

- **`applyCapabilityGating` is shared and fail-closed by design.** The comment at `TaskViewerProvider.ts:4059-4061` warns that the four Board flags must stay `true` in the extension precisely because the defaults are fail-closed. Any *new* flag must therefore be declared `true` explicitly in the extension literal, or the editor loses a working surface the moment the flag ships. That literal is also grepped as a string by `headless-feature-management-contract` — check the test before editing it.
- **`mission-control` is the cautionary precedent.** `transport.js:600-612` records a flag reused for a surface it did not describe, which made the Mission Control controller strip permanently invisible in the browser. The same trap applies in reverse here: do not widen `automation` to cover the toggle, split the toggle out.
- **Turning CLI triggers on in the browser now has teeth.** Once the toggle is reachable, a user on a PTY-less machine can enable dispatch that cannot dispatch. That must produce the step-4 message, not a spawn exception — `bootstrap.ts:1459` already guards, so confirm the guard fires before any `ptyFleetService.create`.
- **`#kanban-structure-list` unhidden exposes the whole column editor**, not just the drag-drop selector: add/delete/rename columns, assigned agent, trigger prompt. Each writes through verbs standalone serves via the `default:` arm — but "serves the verb" is exactly the false green `CLAUDE.md` warns about. Audit each control's read-back path (does a saved label re-render? a deleted column disappear?) before declaring `boardStructure: true`, or the unhide trades an invisible gate for four buttons that fake success.
- **`featureAdvanced: false` hides `#btn-suggest-features`** and is *not* in scope here. Leave it; note it as a separate question so this plan does not quietly become a capability sweep.

## Edge-Case & Dependency Audit

**Migration.** No schema or file changes. Two settings involved (`kanban.cliTriggersEnabled`, `kanban.columnDragDropModes`) both shipped long ago and are already read and written by both hosts — this plan only exposes their controls. Behaviour changes for existing standalone users: drags that silently did nothing will start dispatching (or start reporting why). That is the intent; it belongs in the release note.

**Published install base.** ~4,000 installs, many older. A user whose `kanban.cliTriggersEnabled` is `false` from an old VS Code session currently gets an unrecoverable toast in the browser; after this they get a toggle. No stored value is rewritten by this plan — do not "helpfully" default the setting to `true` on first browser load; that would overwrite an intentional user choice made in the editor.

**Security.** Capability flags are presentation-only; every verb behind the unhidden controls is already authenticated by `LocalApiServer._checkAuth`. Unhiding a control does not widen the authenticated surface. Confirm no newly-reachable control posts a verb that bypasses `_checkAuth`.

**Accessibility of the new toast.** It must reach the same status region existing errors use (`STATUS_MESSAGE_PANELS` / `showStatusMessage`), not a bespoke element — one error surface, not two.

**Ordering.** Ships after the state-parity plan. Unhiding the mode selector before `updateColumnDragDropModes` is pushed would expose a control that cannot read back its own value.

## Verification Plan

1. **Reproduce all three states first,** against `npx switchboard`, and record each:
   (a) CLI triggers off → drag forward → red toast `'CLI triggers are disabled'`, no toggle visible in the toolbar;
   (b) CLI triggers on, no agent names → drag forward → card snaps back, no toast at all;
   (c) node-pty absent → drag forward → PTY toast.
   Also record that the SETUP tab shows no Kanban Structure list, so the Drag & Drop Mode selector is unreachable.
2. **After the change:** `#btn-cli-triggers` is visible and functional in the browser toolbar (toggle off → drag forward → card moves without dispatch, persists across reload; toggle on → drag forward → dispatch or an actionable message).
3. **Drag & Drop Mode reachable:** open SETUP → Kanban Structure → a column → set Clipboard Prompt → save → reload → the column header shows prompt mode and a forward drop copies a prompt instead of dispatching.
4. **Every refusal is actionable:** each of the three messages names both alternatives, and following either alternative works.
5. **Extension host unchanged:** the VS Code board shows the same toolbar and SETUP contents as before the change; no control appears or disappears. Explicitly assert `automation`, `boardStructure` and any new flag are `true` in the extension literal.
6. **The `boardStructure` premise, tested, not assumed:** add a column in the browser, assert it renders in the browser board and in the extension board; delete it, assert it disappears from both.
7. `npm run compile` and `tsc` clean; `headless-feature-management-contract`, `pty-host-gating-contract`, `standalone-parity:check`, `host-seam-parity:check` green.
8. **No confirmation dialog was introduced** — grep the diff for `confirm(`, `showWarningMessage`, and any two-click pattern. Zero hits.

## Dependencies

- Depends on **the eight-missing-pushes plan** for `updateColumnDragDropModes` and `updateAgentNames`.
- Interacts with **the reachability-aware parity gate** plan: a capability flag whose stated justification has expired is the same class of stale gate, and worth a check of its own.
- `featureAdvanced: false` in standalone is left untouched and unresolved — raise separately.
