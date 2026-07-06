# Add an Orchestration Automation Mode (Config, AUTOMATION-Tab UI, Worktree-Mode Coupling)

## Metadata
**Complexity:** 6
**Tags:** backend, frontend, ui, feature, automation
**Project:** Switchboard

## Goal

Add a fourth kanban automation mode, **Orchestration**, as the foundation the rest of the feature builds on. This subtask adds the mode to the autoban state model, surfaces it in the AUTOMATION tab with a **Start orchestrator** control, and couples selecting the mode to enabling **worktree-per-feature**. No grouping, dispatch, or triage behaviour lands here — only the mode, its config, and its wiring.

### Problem / background / root cause

The autoban engine already carries a mode discriminator — `automationMode: 'single-column' | 'multi-column' | 'antigravity-batch'` on `AutobanConfigState` (`src/services/autobanState.ts:76`), defaulted and validated in `normalizeAutobanConfigState` (`:275`). The AUTOMATION tab renders per-mode config from `createAutobanPanel` in `src/webview/kanban.html`. Orchestration needs to be a first-class member of that same enum so it inherits persistence, normalization, broadcast, and the interval tick — rather than being bolted on as a parallel mechanism. Per-feature worktrees are the unit of parallelism and the merge topology for the whole feature, so selecting Orchestration must turn `feature_worktree_mode` on automatically instead of relying on the user to remember.

## Detailed changes

### 1. State model (`src/services/autobanState.ts`)

- Extend the `automationMode` union on `AutobanConfigState` (`:76`) with `'orchestration'`, and add it to the validity list in `normalizeAutobanConfigState` (`:275`) so a persisted `'orchestration'` round-trips (unknown values still fall back to `'single-column'`).
- Add an `OrchestrationConfig` type paralleling `SingleColumnAutobanConfig` (`:18`): at minimum `{ enabled: boolean; intervalMinutes: number }` (wake cadence; clamp 1–60 like the single-column normalizer), with room for later fields. Add `orchestrationConfig?: OrchestrationConfig` to `AutobanConfigState` and a `normalizeOrchestrationConfig` helper mirroring `normalizeSingleColumnConfig` (`:40`). Wire it into `normalizeAutobanConfigState`'s return and `buildAutobanBroadcastState` if it needs live fields.

### 2. AUTOMATION tab UI (`src/webview/kanban.html`, `createAutobanPanel`)

- Add an **Orchestration** option to the mode selector (`modeSelect`, guarded near `:7582`).
- Render an orchestration config panel (shown when the mode is selected): the wake **interval** input and a **Start orchestrator** button, plus a status line (idle / running / last wake). Follow the existing per-mode panel pattern and the `guardInteraction` mechanism so config edits don't fight re-renders.
- **Start orchestrator** posts a message (e.g. `{ type: 'startOrchestrator', workspaceRoot }`) to the backend. No `window.confirm()` anywhere (project hard rule — it is a silent no-op in the webview).

### 3. Backend wiring (`src/services/KanbanProvider.ts`)

- On mode change to `'orchestration'`, **enable `feature_worktree_mode` (per-feature)**, preserving the user's prior value so it can be restored when they switch away (store the previous setting in config; restore on mode-change-away). Adding this coupling here keeps subtask 4 (kickoff) able to assume worktrees exist.
- Add a `startOrchestrator` message handler that launches the orchestrator terminal. The persona it runs is authored in subtask 2; here the handler only needs the launch hook (open/allocate the orchestrator terminal and inject its workflow prompt). If subtask 2 hasn't landed, this can dispatch a placeholder prompt so the wiring is testable.

## Edge cases & constraints

- **Old installs.** `normalizeAutobanConfigState` already defaults unknown modes to `'single-column'`, so a workspace on an older extension version that somehow receives `'orchestration'` degrades safely. Adding the value is backward-compatible (no schema migration).
- **Worktree-mode coupling is reversible.** Selecting Orchestration must not silently destroy a user's chosen `feature_worktree_mode`; persist the prior value and restore on switch-away.
- **No confirm dialogs** (project rule).

## Testing

- `normalizeAutobanConfigState` round-trips `'orchestration'` and its `orchestrationConfig`; unknown modes still fall back to `'single-column'`.
- Selecting the mode in the UI flips `feature_worktree_mode` on; switching away restores the prior value.
- **Start orchestrator** button posts the message and the backend allocates/launches the orchestrator terminal.

## Out of scope

- Grouping, fan-out, wake/triage, and merge-back (subtasks 3–5) and the orchestrator persona (subtask 2). This subtask is purely the mode, its config surface, and the worktree-mode coupling.
