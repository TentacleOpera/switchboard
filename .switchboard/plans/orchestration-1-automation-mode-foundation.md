# Add an Orchestration Automation Mode (Config, AUTOMATION-Tab UI, Worktree-Mode Coupling)

## Goal

Add a fourth kanban automation mode, **Orchestration**, as the foundation the rest of the feature builds on. This subtask adds the mode to the autoban state model, surfaces it in the AUTOMATION tab with a **Start orchestrator** control, and couples selecting the mode to enabling per-feature worktrees. No grouping, dispatch, or triage behaviour lands here — only the mode, its config, and its wiring.

### Problem / background / root cause

The autoban engine already carries a mode discriminator — `automationMode: 'single-column' | 'multi-column' | 'antigravity-batch'` on `AutobanConfigState` (`src/services/autobanState.ts:76`), defaulted and validated inside `normalizeAutobanConfigState` (function at `:205`; the mode validity list and `'single-column'` fallback at `:275–277`). The AUTOMATION tab renders per-mode config from `createAutobanPanel` in `src/webview/kanban.html` (`:7802`). Orchestration needs to be a first-class member of that same enum so it inherits persistence, normalization, broadcast, and the interval tick — rather than being bolted on as a parallel mechanism. Per-feature worktrees are the unit of parallelism and the merge topology for the whole feature (subtask → feature integration → main), so selecting Orchestration must turn the feature worktree auto-mode on automatically instead of relying on the user to remember.

Two facts discovered during code verification that reshape the original sketch:

1. **The mode message is not handled where the original plan said.** The webview posts `{ type: 'setAutomationMode', mode, enabled: false }` (`kanban.html:7916`); `KanbanProvider` merely relays it (`src/services/KanbanProvider.ts:6702–6707`) to `TaskViewerProvider.setAutomationModeFromKanban` (`src/services/TaskViewerProvider.ts:7471`), which **hard-gates the mode against `['single-column', 'multi-column', 'antigravity-batch']` at `:7473` and silently returns otherwise**. Without touching TaskViewerProvider, selecting Orchestration would be a no-op that leaves the backend on the old mode. TaskViewerProvider is therefore a required target file.
2. **There is no `'per-feature'` worktree-mode value.** `feature_worktree_mode` (kanban.db `config`-table key, written at `KanbanProvider.ts:9184`) accepts `'none' | 'per-subtask' | 'high-low'` (validated at `:9176`). The topology the feature needs — a feature integration worktree plus a worktree per subtask, merging subtask → integration → main — is exactly what `'per-subtask'` provisions (`KanbanProvider.ts:10722–10727`). The coupling therefore sets `feature_worktree_mode = 'per-subtask'`.

Autoban state itself persists in the VS Code workspaceState memento under key `'autoban.state'` (`TaskViewerProvider.ts:465–466` restore, `:6595` persist) — *not* the kanban.db config table. Do not "fix" that here; only the worktree-mode coupling keys live in the db `config` table.

## Metadata
**Complexity:** 6
**Tags:** backend, frontend, ui, feature
**Project:** Switchboard

## User Review Required

None. Decisions made and stated below: the coupling targets `'per-subtask'` (there is no `'per-feature'` value; per-subtask is the exact subtask → integration → main topology this feature merges through); the prior worktree mode is saved under the db config key `orchestration_prior_feature_worktree_mode`; a manual worktree-mode change while in Orchestration takes ownership and cancels the pending restore; the orchestrator terminal boots with the **lead** role's startup command until subtask 2 supplies a persona; the main autoban toolbar button is hidden in Orchestration mode for this subtask (like antigravity-batch) — subtask 5 re-wires it when the wake tick lands.

## Complexity Audit

### Routine
- Extending the `automationMode` union and validity list in `autobanState.ts` (additive, pattern exists at `:76` and `:275`).
- `OrchestrationConfig` type + `normalizeOrchestrationConfig` + default constant, mirroring `SingleColumnAutobanConfig` (`:18`) / `normalizeSingleColumnConfig` (`:40`).
- Adding the mode option to `modeSelect` (`kanban.html:7875–7885`) and a description entry (`:7890–7894`).
- New per-mode panel branch in `createAutobanPanel`, cloning the antigravity-batch branch shape (`:8844–8984`) — interval input + Start/Stop button + status line, with `guardInteraction` (`:7836`).
- Adding `'orchestration'` to the two badge filters (`:7107`, `:7148`) and the toolbar-button hide condition (`:5287`, `:5291`, `:5297`).
- KanbanProvider `startOrchestrator`/`stopOrchestrator` message cases delegating to TaskViewerProvider (pattern at `:6702`).

### Complex / Risky
- The `setAutomationModeFromKanban` gate and mode-branching (`TaskViewerProvider.ts:7471–7542`): `'orchestration'` must join the gate at `:7473` and get correct `enabled` semantics in the non-single-column branch (`:7525–7538`) without disturbing multi-column's `wasEnabled` preservation.
- Wiring `orchestrationConfig` through `normalizeAutobanConfigState` — the normalizer **builds a fresh object**, so any field not explicitly returned is silently dropped on every state mutation (normalize is called on nearly every autoban write). Forgetting this loses the interval setting on the first unrelated config change.
- The prior-value save/restore protocol for `feature_worktree_mode`: double-enter, manual-override-while-active, and reload-mid-mode all have to resolve to sane states (protocol below is stateless on purpose).
- The orchestrator terminal launch cannot reuse `_createAutobanTerminal` (`TaskViewerProvider.ts:7162`) as-is — its role gate (`:7172` via `_autobanPoolRoles`, `:6607–6619`) rejects non-pool roles like `orchestrator`; the launch helper must replicate the createTerminal + shell-ready startup-command wait (`:7265–7295`) without the pool bookkeeping.

## Edge-Case & Dependency Audit

**Race Conditions**
- *Panel re-render vs. typing*: the interval input must use `guardInteraction` (`kanban.html:7836–7852`) exactly like `minInputSc` (`:8120`), or the 2-second re-render guard won't arm and an `updateAutobanConfig` broadcast will wipe mid-typing edits.
- *Mode-change double-write*: selecting Orchestration triggers the KanbanProvider coupling (db write + `_sendWorktreeConfig`) and the TaskViewerProvider mode write (memento + broadcast). Both are idempotent and ordered within the single `setAutomationMode` case handler (`await` the coupling before delegating), so the webview receives `worktreeConfig` and `updateAutobanConfig` reflecting the final state regardless of paint order.
- *Two windows on one workspace*: workspaceState (`autoban.state`) and kanban.db are both last-writer-wins across windows — same exposure every autoban setting already has (see `stateConfigBridge.ts:167–173` note). No new mitigation.
- *Mode toggled mid-feature-creation*: feature creation snapshots `feature_worktree_mode` once per call (`KanbanProvider.ts:10722`, `:10801`), so the coupling flipping the mode mid-creation cannot split one feature between provisioning behaviors. Already handled; do not add anything.

**Security**
- No new attack surface: no new API routes, no shell input from the webview. The `startOrchestrator` message carries only `workspaceRoot`, which is validated by `_resolveWorkspaceRoot` (`KanbanProvider.ts:922`) against allowed roots before any db or terminal action. The startup command sent to the terminal comes from the user's own configured startup commands (`getStartupCommands`, `TaskViewerProvider.ts:3942`), not from webview input.

**Side Effects**
- Selecting Orchestration changes `feature_worktree_mode`, which changes what happens on the *next* feature creation/subtask assignment (worktrees get provisioned, `KanbanProvider.ts:10722–10727`). This is the intended coupling; the restore protocol below makes it reversible.
- The Worktrees tab radio group (`kanban.html:10119–10162`) reflects the coupled value automatically because the coupling broadcasts via `_sendWorktreeConfig` (`KanbanProvider.ts:10076`, payload key `featureWorktreeMode` at `:10140`). No webview change needed for that reflection.
- On downgrade to an older extension version, a persisted `automationMode: 'orchestration'` falls back to `'single-column'` via the old normalizer's fallback (`autobanState.ts:275–277`) — safe degradation, no migration needed (additive enum value; ~4,000-install rule satisfied). A stale `orchestration_prior_feature_worktree_mode` config key left behind by a downgrade is inert (nothing in old versions reads it).

**Dependencies & Conflicts**
- `normalizeAutobanConfigState` is imported by both `TaskViewerProvider.ts` and reachable from `KanbanProvider`'s broadcast mirror — one shared change point, no duplication.
- `buildAutobanBroadcastState` (`autobanState.ts:282`) spreads `normalizeAutobanConfigState(state)`, so once `orchestrationConfig` is wired into the normalizer's return it is broadcast automatically — **no separate change to `buildAutobanBroadcastState` is needed** (correction to the original sketch, which hedged on this).
- Do NOT add orchestration keys to `stateConfigBridge.ts`'s `STATE_KEY_TO_CONFIG` — the legacy `autoban: 'runtime.autoban'` mapping (`:37`) is the state.json shim, not the live persistence path, and touching the bridge risks the known mirror-up clobber pattern.
- The `hasWatchActive` computation (`kanban.html:7815–7831`) only checks single/multi modes; orchestration falls through to `false` correctly with no change.

## Dependencies

None (no sess_ dependencies).

Sibling ordering: **this plan blocks subtasks 4 (kickoff) and 5 (wake/triage/merge-back)** — both key off the `'orchestration'` enum value, `OrchestrationConfig`, and the `startOrchestrator` launch hook added here. Subtask 2 (persona workflow) and subtask 3 (inbox/session log) can proceed in parallel; the `startOrchestrator` handler here injects a placeholder prompt until subtask 2's workflow file exists.

## Adversarial Synthesis

The two failure modes that would ship silently are the TaskViewerProvider mode gate (`:7473`) swallowing `'orchestration'` — the UI would look switched while the backend stays on the old mode — and the normalizer dropping `orchestrationConfig` because it rebuilds state from an explicit field list. The worktree coupling is the only stateful protocol: keying the restore off the presence of the saved-prior config key (not off remembered previous mode) makes it survive reloads, and clearing that key on any manual worktree-mode change prevents the restore from clobbering a user's deliberate choice. Everything else is additive pattern-following with existing per-mode precedents.

## Proposed Changes

### 1. `src/services/autobanState.ts` — state model

**Context.** `AutobanConfigState` at `:59` with `automationMode` union at `:76`; `SingleColumnAutobanConfig` at `:18` is the config-shape template; `normalizeSingleColumnConfig` at `:40` (interval clamp 1–60 at `:43`); `normalizeAutobanConfigState` at `:205` with the mode validity list at `:275–277` and `singleColumnConfig` normalization at `:278`; `buildAutobanBroadcastState` at `:282`.

**Logic.** Extend the `automationMode` union on `AutobanConfigState` (`:76`) with `'orchestration'`, and add it to the validity list in `normalizeAutobanConfigState` (`:275`) so a persisted `'orchestration'` round-trips (unknown values still fall back to `'single-column'`). Add an `OrchestrationConfig` type paralleling `SingleColumnAutobanConfig` (`:18`): at minimum `{ enabled: boolean; intervalMinutes: number }` (wake cadence; clamp 1–60 like the single-column normalizer), with room for later fields. Add `orchestrationConfig?: OrchestrationConfig` to `AutobanConfigState` and a `normalizeOrchestrationConfig` helper mirroring `normalizeSingleColumnConfig` (`:40`). Wire it into `normalizeAutobanConfigState`'s return; `buildAutobanBroadcastState` needs no change because it spreads the normalizer's output (`:287`).

**Implementation.**

```ts
// after SingleColumnAutobanConfig (:18-38)
export type OrchestrationConfig = {
    enabled: boolean;          // orchestrator session armed (Start pressed, not yet stopped)
    intervalMinutes: number;   // wake cadence for subtask 5's tick; stored now, acted on later
    lastWakeAt?: number;       // epoch ms; written by subtask 5, rendered by the status line
};

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
    enabled: false,
    intervalMinutes: 10
};

export function normalizeOrchestrationConfig(state?: Partial<OrchestrationConfig> | null): OrchestrationConfig {
    return {
        enabled: state?.enabled === true,
        intervalMinutes: Math.max(1, Math.min(60, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 10)),
        lastWakeAt: (typeof state?.lastWakeAt === 'number' && Number.isFinite(state.lastWakeAt) && state.lastWakeAt > 0)
            ? state.lastWakeAt
            : undefined
    };
}
```

```ts
// AutobanConfigState (:76-77)
automationMode?: 'single-column' | 'multi-column' | 'antigravity-batch' | 'orchestration';
singleColumnConfig?: SingleColumnAutobanConfig;
orchestrationConfig?: OrchestrationConfig;
```

```ts
// normalizeAutobanConfigState return (:275-278)
automationMode: (['single-column', 'multi-column', 'antigravity-batch', 'orchestration'] as const).includes(state?.automationMode as any)
    ? state!.automationMode!
    : 'single-column',
singleColumnConfig: normalizeSingleColumnConfig(state?.singleColumnConfig),
orchestrationConfig: normalizeOrchestrationConfig(state?.orchestrationConfig)
```

**Edge Cases.** Old installs: `normalizeAutobanConfigState` already defaults unknown modes to `'single-column'`, so a workspace on an older extension version that somehow receives `'orchestration'` degrades safely; adding the value is backward-compatible (no schema migration). The normalizer must return `orchestrationConfig` unconditionally (like `singleColumnConfig` at `:278`) — it is called on nearly every autoban mutation and any field it omits is destroyed, so a conditional return would lose the interval on the first unrelated config write.

### 2. `src/services/TaskViewerProvider.ts` — mode gate, enabled semantics, launch hook

**Context.** `setAutomationModeFromKanban` at `:7471`, hard mode gate at `:7473`, non-single-column branch at `:7525–7538`; `_persistAutobanState` at `:6584–6596` (memento key `'autoban.state'` at `:6595`); restore at `:465–466`; `_createAutobanTerminal` at `:7162` (role gate `:7172`, shell-ready startup-command send `:7265–7295`); `_executeLocal` prompt-injection pattern at `:15952–15980`; `getStartupCommands` at `:3942`.

**Logic.** Admit `'orchestration'` through the gate; treat it like antigravity-batch for engine `enabled` (always `false` on mode entry — the engine tick has no orchestration behavior until subtask 5); add a public `startOrchestratorFromKanban(workspaceRoot)` / `stopOrchestratorFromKanban()` pair that TaskViewerProvider owns because it owns terminals and autoban state.

**Implementation.**

```ts
// :7473
if (!['single-column', 'multi-column', 'antigravity-batch', 'orchestration'].includes(newMode)) return;
```

The `else` branch at `:7525–7538` already computes `enabled = false` for any non-multi-column mode (`newMode === 'multi-column' ? … : false`) and stamps `automationMode: newMode` — with the gate widened, `'orchestration'` flows through it unchanged. Add one line in that branch: when `newMode !== 'orchestration'`, also reset `orchestrationConfig: { ...this._autobanState.orchestrationConfig, enabled: false }` in the same `normalizeAutobanConfigState({...})` call, so switching away always disarms the status line.

```ts
/** Called by Kanban AUTOMATION tab: launch the orchestrator terminal and arm the session. */
public async startOrchestratorFromKanban(workspaceRoot?: string): Promise<void> {
    const root = workspaceRoot || this._resolveWorkspaceRoot();
    if (!root) { vscode.window.showErrorMessage('No workspace folder found. Cannot start the orchestrator.'); return; }

    // Reuse a live 'Orchestrator' terminal if registered; otherwise create one.
    // NOT via _createAutobanTerminal — its role gate (:7172) rejects non-pool roles.
    // Replicate its createTerminal + onDidStartTerminalShellExecution startup wait (:7265-7295):
    //   terminal = vscode.window.createTerminal({ name: 'Orchestrator', location: Panel, cwd: root })
    //   register in this._registeredTerminals under the suffixed name; record in state.terminals
    //   with { purpose: 'orchestrator', role: 'orchestrator', status: 'active', ... }
    //   boot CLI with getStartupCommands(root)['lead'] (lead = most capable configured CLI;
    //   subtask 2 replaces the persona, not the boot command)
    // Then inject the kickoff prompt using the _executeLocal pattern (:15977-15979):
    //   terminal.sendText(kickoffPrompt, false); await 1s; terminal.sendText('', true)
    // kickoffPrompt placeholder until subtask 2 lands:
    //   'You are the Switchboard orchestrator. The orchestrator workflow is not yet installed
    //    (.agents/workflows/orchestrator.md). Stand by — do not take autonomous action.'

    this._autobanState = normalizeAutobanConfigState({
        ...this._autobanState,
        orchestrationConfig: { ...this._autobanState.orchestrationConfig, enabled: true }
    });
    await this._persistAutobanState();
    this._postAutobanStateNow();
}

/** Called by Kanban AUTOMATION tab: disarm the orchestrator session (does not kill the terminal). */
public async stopOrchestratorFromKanban(): Promise<void> {
    this._autobanState = normalizeAutobanConfigState({
        ...this._autobanState,
        orchestrationConfig: { ...this._autobanState.orchestrationConfig, enabled: false }
    });
    await this._persistAutobanState();
    this._postAutobanStateNow();
}
```

`_persistAutobanState` (`:6584`) needs no change — `orchestrationConfig` rides inside `_autobanState` into the `'autoban.state'` memento; only single-column has a side memento (`:6585–6594`).

**Edge Cases.** If subtask 2 hasn't landed, the placeholder prompt keeps the wiring testable (original intent preserved). Start pressed twice: the terminal-reuse check makes the second press re-inject the prompt into the existing terminal rather than spawning a duplicate; `enabled` is already `true` so state writes are idempotent. Terminal closed by the user while `enabled === true`: the status line shows "running" until Stop or mode-switch-away — acceptable for the foundation; subtask 5's wake verification owns liveness truth. Stop does not dispose the terminal (a running agent may hold uncommitted context; killing is the user's call via the existing terminal UI — and per project rule, no confirm dialogs anywhere).

### 3. `src/services/KanbanProvider.ts` — worktree-mode coupling + message relay

**Context.** `case 'setAutomationMode'` at `:6702–6707` (pure relay today); `case 'setFeatureWorktreeMode'` at `:9172–9187` with validity list `['none','per-subtask','high-low']` at `:9176` and `db.setConfig('feature_worktree_mode', mode)` at `:9184`; `_sendWorktreeConfig` at `:10076` (reads the key at `:10084`, posts `featureWorktreeMode` at `:10140`); `_resolveWorkspaceRoot` at `:922` (falls back to the active board workspace when the message omits a root); `_getKanbanDb` used throughout; `KanbanDatabase.getConfig`/`setConfig` at `KanbanDatabase.ts:3530`/`:3541` (string API; **no deleteConfig exists** — clear by writing `''`).

**Logic.** On mode change to `'orchestration'`, enable per-feature worktrees by setting `feature_worktree_mode = 'per-subtask'`, preserving the user's prior value so it can be restored when they switch away. Store the previous setting in the kanban.db `config` table under the concrete key **`orchestration_prior_feature_worktree_mode`**; restore on mode-change-away. Adding this coupling here (in the relay case, before delegating) keeps subtask 4 (kickoff) able to assume worktrees exist, and puts the db access + `_sendWorktreeConfig` broadcast where they already live. The restore protocol is stateless — keyed off the saved-prior key's presence, never off a remembered "previous mode" — so it survives extension-host reloads mid-mode.

**Implementation.**

```ts
case 'setAutomationMode': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const db = workspaceRoot ? this._getKanbanDb(workspaceRoot) : null;
    if (db && await db.ensureReady()) {
        const PRIOR_KEY = 'orchestration_prior_feature_worktree_mode';
        if (msg.mode === 'orchestration') {
            const current = (await db.getConfig('feature_worktree_mode')) || 'none';
            const savedPrior = await db.getConfig(PRIOR_KEY);
            if (!savedPrior) {                       // double-enter guard: never overwrite the true prior
                await db.setConfig(PRIOR_KEY, current);
            }
            if (current !== 'per-subtask') {
                await db.setConfig('feature_worktree_mode', 'per-subtask');
            }
            await this._sendWorktreeConfig(workspaceRoot!);
        } else {
            const savedPrior = await db.getConfig(PRIOR_KEY);
            if (savedPrior) {                        // '' (cleared) and null both skip restore
                const validModes = ['none', 'per-subtask', 'high-low'];
                await db.setConfig('feature_worktree_mode', validModes.includes(savedPrior) ? savedPrior : 'none');
                await db.setConfig(PRIOR_KEY, '');   // consume the saved prior
                await this._sendWorktreeConfig(workspaceRoot!);
            }
        }
    }
    if (this._taskViewerProvider) {
        await this._taskViewerProvider.setAutomationModeFromKanban(msg);
    }
    break;
}
```

One line in `case 'setFeatureWorktreeMode'` (after `:9184`): clear the saved prior — `await db.setConfig('orchestration_prior_feature_worktree_mode', '');` — a manual worktree-mode change means the user has taken ownership; the mode-switch-away restore must not later clobber their explicit choice.

New relay cases beside `:6702`:

```ts
case 'startOrchestrator': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (workspaceRoot && this._taskViewerProvider) {
        await this._taskViewerProvider.startOrchestratorFromKanban(workspaceRoot);
    }
    break;
}
case 'stopOrchestrator': {
    if (this._taskViewerProvider) {
        await this._taskViewerProvider.stopOrchestratorFromKanban();
    }
    break;
}
```

**Edge Cases.** Worktree-mode coupling is reversible: selecting Orchestration must not silently destroy a user's chosen `feature_worktree_mode`; the prior value is persisted and restored on switch-away (original constraint preserved — now with a concrete key and a consume-on-restore step). Selecting Orchestration when the mode is already `'per-subtask'` saves `'per-subtask'` as the prior, making the eventual restore a no-op — correct. Switching between two non-orchestration modes finds no saved prior and touches nothing. The db write is additive (new config key) — no migration needed for the ~4,000-install base. The webview's mode-change message today omits `workspaceRoot` (`kanban.html:7916`); `_resolveWorkspaceRoot(undefined)` falls back to the current board workspace (`:922`), and section 4 adds the explicit root to the message for multi-workspace correctness.

### 4. `src/webview/kanban.html` — AUTOMATION tab UI (self-contained webview; all handlers in this file's own inline script)

**Context.** `currentAutomationMode` declared at `:6327` (default `'single-column'`), set from the backend broadcast at `:6894–6908`; `createAutobanPanel` at `:7802`; `guardInteraction` at `:7836–7852`; `emitAutobanState` at `:7854–7856`; `modeSelect` built at `:7871–7888` with the options array at `:7875–7879` (**not** `:7582` as previously anchored) and change handler at `:7906–7925`; `modeDescriptions` at `:7890–7894`; per-mode branches: single-column `:8005`, antigravity-batch `:8844–8984` (the shape to clone); `renderAutobanPanel` at `:8989`; toolbar button logic `updateAutobanButtonState` at `:5255` with the antigravity hide at `:5287` and reset/pause at `:5291`/`:5297`; badge filters at `:7103–7109` and `:7144–7150`.

**Logic.** Add an **Orchestration** option to the mode selector; render an orchestration config panel (shown when the mode is selected): the wake **interval** input and a **Start orchestrator** button, plus a status line (idle / running / last wake). Follow the existing per-mode panel pattern and the `guardInteraction` mechanism so config edits don't fight re-renders. **Start orchestrator** posts a message to the backend. **No `window.confirm()` anywhere** — project hard rule; it is a silent no-op in the sandboxed webview and any confirm gate makes the button do literally nothing. The button acts immediately.

**Implementation.**

1. Mode option (`:7875–7879`): append `{ value: 'orchestration', label: 'Orchestration' }` to the options array. Description (`:7890–7894`): `'orchestration': 'A system-woken orchestrator agent batches plans into features, fans work out across per-feature worktrees, and merges results back feature by feature. Selecting this mode enables per-subtask feature worktrees automatically.'`. Include the active workspace in the mode-change post (`:7916`): `postKanbanMessage({ type: 'setAutomationMode', mode: currentAutomationMode, enabled: false, workspaceRoot: getActiveWorkspaceRoot() })` so the coupling targets the board's workspace explicitly in multi-workspace setups.
2. New branch after the antigravity-batch branch (`:8984`), cloning its `db-subsection` structure:

```js
} else if (currentAutomationMode === 'orchestration') {
    const orchSection = document.createElement('div');
    orchSection.className = 'db-subsection';
    container.appendChild(orchSection);
    // header: 'ORCHESTRATION' (subsection-header pattern, :8854-8859)
    // desc div (:8861-8864 pattern): explains batch → fan-out → wake → merge-back and that
    // per-subtask feature worktrees were enabled automatically (restored on switching away).

    const orch = (state.orchestrationConfig) || { enabled: false, intervalMinutes: 10 };

    // WAKE INTERVAL row — number input, min=1 max=60, styled with autobanNumberInputStyle,
    // guardInteraction(input) (mirrors minInputSc, :8120). On 'change':
    //   state.orchestrationConfig = { ...orch, intervalMinutes: parseInt(input.value, 10) || 10 };
    //   emitAutobanState();   // -> updateAutobanConfig -> normalize clamps 1-60

    // STATUS line — font-mono muted div:
    //   !orch.enabled -> 'STATUS: idle'
    //   orch.enabled  -> 'STATUS: running' + (orch.lastWakeAt ? ' · last wake ' + new Date(orch.lastWakeAt).toLocaleTimeString() : '')
    // (lastWakeAt is written by subtask 5; renders blank-safe until then.)

    // START/STOP button — strip-btn pattern (:8932-8936). Label: orch.enabled ? 'STOP ORCHESTRATOR'
    // : 'START ORCHESTRATOR'. Click (NO confirm dialog, acts immediately):
    //   postKanbanMessage(orch.enabled
    //       ? { type: 'stopOrchestrator' }
    //       : { type: 'startOrchestrator', workspaceRoot: getActiveWorkspaceRoot() });
    // The backend's updateAutobanConfig broadcast re-renders the panel with the flipped label.
}
```

3. Toolbar + badges: extend the three antigravity-batch checks so orchestration behaves the same for this subtask — `:5287` `(currentAutomationMode === 'antigravity-batch' || currentAutomationMode === 'orchestration') ? 'none' : ''`, same treatment at `:5291`/`:5297`, and add `|| currentAutomationMode === 'orchestration'` to the badge-empty filters at `:7107` and `:7148`. The main engine button returns for orchestration in subtask 5 when the wake tick gives it meaning; until then a visible engine toggle that does nothing would be dead UI.

**Edge Cases.** The mode broadcast (`:6894–6908`) sets `currentAutomationMode` from `autobanConfig.automationMode`, so once the normalizer admits `'orchestration'`, panel restore after reload works with no webview persistence changes (`vscode.getState().currentAutomationMode` is written at `:6899` but never read back — restoration is broadcast-driven; leave as-is). Mode change clears the interaction guard (`:7918–7924`) so the new panel renders immediately. `hasWatchActive` (`:7815–7831`) ignores unknown modes — no change. The Start button stays enabled even if `state.orchestrationConfig` is missing (first broadcast after upgrade): the local fallback object keeps the panel functional and the first `emitAutobanState` round-trip materializes the normalized config.

## Verification Plan

Manual/behavioral verification via an installed VSIX (dist/ is not used in development; per session directive, no compilation or automated test runs are part of this plan's verification):

1. **Mode round-trip**: open the AUTOMATION tab → select *Orchestration* → the orchestration panel renders (interval input, START ORCHESTRATOR, STATUS: idle). Reload the window → the tab restores to Orchestration with the same panel (broadcast-driven restore).
2. **Worktree coupling**: with the Worktrees tab's Auto Mode on *None*, select Orchestration → the Worktrees tab radio flips to *Per Subtask* without manual refresh (via `worktreeConfig` broadcast). Switch the automation mode back to *Single Column* → the radio returns to *None*. Repeat starting from *High/Low* → restore returns *High/Low*.
3. **Double-enter guard**: select Orchestration, switch to Multi Column, select Orchestration again, switch away → the restored value is always the value from before the *first* entry, never `'per-subtask'`.
4. **Manual override wins**: while in Orchestration mode, manually set the Worktrees tab radio to *High/Low* → switch automation mode away → the radio stays on *High/Low* (no restore clobber).
5. **Interval persistence**: set the wake interval to 25 → reload the window → the panel shows 25. Type `999` → after the broadcast round-trip the field clamps to 60; type `0`/garbage → clamps to a valid value. Verify typing is not wiped mid-edit while board refreshes occur (interaction guard).
6. **Start orchestrator**: press START ORCHESTRATOR → a terminal named *Orchestrator* opens in the panel, the lead startup command runs, the placeholder prompt is injected after the CLI is ready, and the status line flips to *running*; the button now reads STOP ORCHESTRATOR. Press START twice quickly → exactly one terminal exists. Press STOP → status returns to *idle*, terminal stays open. Confirm no confirm dialog appears anywhere in the flow.
7. **Other modes unharmed**: cycle through Single Column / Multi Column / Antigravity Batch → their panels, toolbar engine button, badges, and enabled semantics behave exactly as before; the engine button and timer badges are hidden while in Orchestration.
8. **Backend truth check**: after selecting Orchestration, run `query_switchboard_kanban` (sqlite3) → `config` table shows `feature_worktree_mode = 'per-subtask'` and `orchestration_prior_feature_worktree_mode = <prior>`; after switch-away the prior key is `''` and `feature_worktree_mode` is restored.

### Automated Tests (deferred per session directive)

Would cover, as pure-function tests against `autobanState.ts`: `normalizeAutobanConfigState` round-trips `'orchestration'` and its `orchestrationConfig`; unknown modes still fall back to `'single-column'`; `normalizeOrchestrationConfig` clamps intervals to 1–60 and drops non-finite `lastWakeAt`; `orchestrationConfig` survives an unrelated normalize (e.g. a `sendCounts` update). Provider-level tests would cover: selecting the mode flips `feature_worktree_mode` on and switching away restores the prior value; the double-enter and manual-override protocols; and that the **Start orchestrator** message reaches `startOrchestratorFromKanban` and arms `orchestrationConfig.enabled`. Deferred — not run as part of this plan.

## Out of scope

- Grouping, fan-out, wake/triage, and merge-back (subtasks 3–5) and the orchestrator persona (subtask 2). This subtask is purely the mode, its config surface, and the worktree-mode coupling.
- Any engine-tick behavior for orchestration (the interval is stored and rendered but not acted on until subtask 5).
- The `.switchboard/orchestrator/` inbox and session log (subtask 3).

**Recommendation: Send to Coder**

**Stage Complete:** PLAN REVIEWED
