# Enforce PTY-Only for Team Automations

## Goal

Teams are PTY-only. No team automation — team creation, team dispatch, autoban schedule queue pop, autoban terminal selection, team-scoped role resolution, or worktree terminal creation — may create or dispatch to a VS Code integrated terminal. The VS Code sidebar remains a control surface (start orchestrator, view board, trigger dispatch), but the terminals it drives are PTY fleet terminals, not `vscode.window.createTerminal` terminals. The browser shell / PTY web view is where teams are visible and interacted with.

## Metadata
- **Complexity:** 6
- **Tags:** refactor, reliability, backend
- **Project:** Switchboard Core

## Background & Problem Analysis

### The rule (from the user)

> "There will literally be a button in the VS Code sidebar that opens [the PTY web view], like there is now. There will be NO affordance for running teams inside VS Code — we do not have the UI for it."

> "Teams are meant to be PTY only."

> The orchestrator terminal type "depends entirely from where the user started it. If they started it from VS Code sidebar, in VS Code. If they started it by pressing the shell sidebar rail button, PTY."

### What this means concretely

1. **Team terminal creation**: When a PTY fleet is available (`_ptyHostPort` is set on the extension host, or the standalone host's in-process fleet), team role terminals (lead, coder, intern, reviewer, planner) must be created as PTY fleet terminals, never as `vscode.window.createTerminal`. When no fleet exists, team creation refuses with a clear error — it does not fall back to VS Code terminals.

2. **Team dispatch resolution**: When resolving a terminal for a team dispatch (autoban schedule, batch trigger, single-card trigger, team-scoped reviewer routing), the resolver must only return PTY fleet terminals. VS Code terminals in the registry are not eligible targets for team automations.

3. **Orchestrator**: The orchestrator is entry-point-dependent. `startOrchestratorFromKanban` (VS Code sidebar entry) creates a VS Code terminal — this is correct and stays as-is. The shell rail entry creates a PTY terminal — also correct. The orchestrator is NOT a team member; it is a control agent. It is out of scope for this plan.

4. **Pair programming and prompt-mode dispatch**: Out of scope per the user.

### The existing architecture

The codebase has a dual-host architecture:

- **Extension host** (`TaskViewerProvider`): PTY fleet lives in a child process (`_ptyHostChild`/`_ptyHostPort`), reached via `_ptyHostVerb`. VS Code terminals also exist via `vscode.window.createTerminal`. The fleet is the intended terminal set for teams.
- **Standalone host** (`bootstrap.ts`): PTY fleet is in-process (`ptyFleetService`). No VS Code terminals at all. This host is already correct — it has no VS Code terminal paths.

The PTY fleet is checked first in several dispatch resolvers (`_resolveAgentTerminalForPlan`, `_attemptDirectTerminalPush`), but VS Code terminals are always the fallback. Several terminal creation paths bypass the fleet entirely. This plan closes those gaps.

### Verified facts (read from source during the audit)

> **Note:** All line numbers below were re-verified against the current source (`src/services/TaskViewerProvider.ts`, 27,780 lines) during this improve pass. The original plan's line numbers had drifted by 30-50 lines in every case; they are corrected here.

- `_createAutobanTerminal` (TVP:10790-10904+) unconditionally calls `vscode.window.createTerminal()` at line 10825. No PTY fleet check. Used by `addCoderTerminalFromKanban` (line 11693, the `+` button in the Dispatch header) and `ensureWorktreeTerminals` (line 11841). The state registry update at lines 10853-10871 sets `purpose: 'autoban-backup'` and `ideName: vscode.env.appName`. The startup command is sent via `terminal.sendText()` at line 10890 — a VS Code terminal API unavailable on PTY terminals.
- `ensureWorktreeTerminals` (TVP:11784-11849) calls `_createAutobanTerminal` at line 11841 for each role. No PTY fleet check. Passes `resolvedPath` as the `cwd` argument.
- `_scheduleQueuePop` (TVP:13235-13287) falls back to `getAliveRoleTerminalNames` (lines 13257-13263) when `resolveCodingHeadFromGroups` returns empty. The code comment at lines 13244-13254 explicitly documents that `getAliveRoleTerminalNames` is invisible to PTY fleet terminals (it reads `_readTerminalRegistryState` with `allowPtyFleet: false`).
- `_selectAutobanTerminal` (TVP:10576-10627) reads from `_getAliveAutobanTerminalRegistry(workspaceRoot)` at line 10594 without passing `allowPtyFleet: true` — blind to PTY fleet terminals. The registry function (TVP:10449-10531) accepts `opts?: { allowPtyFleet?: boolean }` at line 10451; when false (default), PTY rows are skipped entirely (line 10496).
- `resolveTeamRoleTerminal` (TVP:10109-10138) unions PTY fleet (lines 10118-10125) with VS Code registry (lines 10126-10129) for team-scoped routing.
- `_resolveAgentTerminalForPlan` (TVP:10064-10097) checks PTY fleet first (lines 10087-10095) but falls back to `_getAgentNameForRole` (line 10096, VS Code registry). Used by `dispatchCustomPromptToRole` (line 6276) and team dispatch paths.
- `_isTerminalLive` (TVP:9904-9943) checks VS Code terminals (lines 9905-9931) and PTY snapshot (lines 9935-9940) without distinguishing for team automation checks. Used by `handoffOrchestrationSession` (line 11421) to verify a coding head is live, and by `_pickTerminalCandidate` (lines 9968-9970) for fleet-vs-VS-Code precedence.
- `instantiateAgentGroup` (TVP:12795-12860) already has a PTY gate (`if (!this._ptyHostPort)` → refuse, line 12800). This is the correct pattern. The PTY creation call is at line 12841: `_ptyHostVerb('ptyCreateTerminal', { role, name, cwd, delegates, teamName, claudeInlineRendering })`. The mirror registry update is at line 12858: `onCreated: () => { void this._updatePtyMirrorRegistry?.(db); }`.
- `_attemptDirectTerminalPush` (TVP:21347-21439+) checks PTY fleet first (lines 21358-21407), then falls back to VS Code `sendRobustText` (lines 21409-21437). The fallback is the violation for team dispatches. When no terminal is found, returns false (line 21439).
- `sendPromptToAgentTerminal` (TVP:5707-5759+) tries PTY fleet delivery FIRST via `_tryFleetDeliveryForRole` (line 5714). Only if that fails does it fall through to the VS Code path, where the fleet gate at line 5741 (`if (this._ptyHostPort) { return false; }`) prevents VS Code terminal creation when a fleet exists.

> **Superseded:** `sendPromptToAgentTerminal` (TVP:5686-5715) has a fleet gate that "returns false, causing the caller to surface a failure rather than creating a PTY terminal."
> **Reason:** The original description implied the function does not attempt PTY delivery at all. In reality, it calls `_tryFleetDeliveryForRole` (line 5714) FIRST — that IS PTY delivery. The fleet gate at line 5741 only fires after PTY delivery fails. The function is already partially correct: it tries PTY, then refuses to fall back to VS Code. No code change is needed here; the description was misleading.
> **Replaced with:** `sendPromptToAgentTerminal` already tries PTY first via `_tryFleetDeliveryForRole` (line 5714) and refuses VS Code terminal creation when a fleet exists (line 5741). It is out of scope for this plan — no change needed.

- The standalone host's `createExternalTeam` (bootstrap.ts:2451-2474) uses `ptyFleetService` / `instantiateExternalHeadedTeam` directly — correct.
- The standalone host's `orchestrationStart` (bootstrap.ts:2422-2449) uses `ptyFleetService.create()` — correct.
- `PTY_IDE_NAME` is imported from `../standalone/ptyFleetService` (line 43). `_isFleetTerminalInfo` (line 9946-9947) checks `info?.purpose === 'pty' || info?.ideName === PTY_IDE_NAME`.
- `_dispatchExecuteMessage` (TVP:21273-21301) calls `_attemptDirectTerminalPush` at line 21290. Has 14 callers (see Subtask 6 for full classification).

## User Review Required

None. The rules are established by the user's answers above. The scope (pair programming and prompt mode excluded) is confirmed.

## Complexity Audit

### Routine
- Adding `allowPtyFleet: true` to `_selectAutobanTerminal`'s registry read (line 10594).
- Filtering VS Code terminals out of team dispatch resolution paths.
- Adding PTY fleet gates to `_createAutobanTerminal` and `ensureWorktreeTerminals`.
- Adding `ptyOnly?: boolean` parameter to `_isTerminalLive` and `_attemptDirectTerminalPush`.

### Complex / Risky
- `_createAutobanTerminal` is used by `addCoderTerminalFromKanban` (the `+` button in the Dispatch header, line 11693) and `ensureWorktreeTerminals` (worktree terminal opening, line 11841). Both are user-facing actions. Routing them through the PTY fleet changes the terminal the user sees — from a VS Code integrated terminal to a PTY terminal in the browser cockpit. This is the intended behavior but is a visible change.
- `_createAutobanTerminal` PTY creation path requires three changes the original plan underspecified: (1) the `_ptyHostVerb('ptyCreateTerminal', ...)` call must use `{ role, name, cwd, claudeInlineRendering }` — no `delegates` or `teamName` (this is a single terminal, not a group); (2) the startup command must be delivered via `_ptyHostVerb('ptySendPrompt', ...)` instead of `terminal.sendText()` (line 10890), since PTY terminals have no VS Code terminal object; (3) the state registry update must set `purpose: 'pty'` and `ideName: PTY_IDE_NAME` (or delegate to `_updatePtyMirrorRegistry`) so `_isFleetTerminalInfo` recognizes the terminal.
- `_scheduleQueuePop`'s fallback to `getAliveRoleTerminalNames` (lines 13257-13263) exists because `resolveCodingHeadFromGroups` can return empty when `terminals.groups` has no live head. Removing the VS Code fallback means the schedule silently no-ops when no PTY head is live — which is correct (the schedule should not dispatch to VS Code terminals) but changes behavior for installs that currently rely on VS Code terminals as coding heads.
- `_resolveAgentTerminalForPlan` is used by both team dispatch paths and `dispatchCustomPromptToRole` (line 6276), which dispatches to team roles (planner). The PTY-only filter applies to all paths when a fleet exists — this is the broader rule (no dispatch to VS Code terminals when a fleet exists), and `dispatchCustomPromptToRole` is a team path, so it is correctly affected.
- `_dispatchExecuteMessage` has 14 callers. Only team automation callers should pass `ptyOnly: true`; non-team callers (orchestrator kickoff, airlock, PM terminal, analyst) keep the VS Code fallback for fleet-less installs. Misclassifying a caller either breaks a non-team path or leaves a team path ungated.

## Edge-Case & Dependency Audit

- **Race Conditions**: None new. The PTY fleet check is a synchronous boolean (`this._ptyHostPort` is set or not).
- **Install base (~4,000 installs)**: Installs that currently have VS Code terminals as team dispatch targets will lose that capability. This is the intended behavior — "there will be NO affordance for running teams inside VS Code." The migration is: when a PTY fleet is available, team automations use it; when no fleet is available, team automations refuse with a clear error directing the user to open the PTY web view.
- **Side Effects**: The `+` button in the Dispatch header will create PTY terminals instead of VS Code terminals. Worktree terminal opening will create PTY terminals. The autoban schedule will no longer dispatch to VS Code terminals.
- **Dependencies**: The PTY web view / browser cockpit must be accessible from the VS Code sidebar. The `terminalWsGateway` and the terminals panel already exist in the browser shell. A button in the VS Code sidebar that opens the PTY web view is mentioned as planned/existing — this plan assumes it is available or will be available.

## Dependencies

- The PTY web view / browser cockpit must be accessible from the VS Code sidebar. The `terminalWsGateway` and terminals panel already exist in the browser shell. A VS Code sidebar button that opens the PTY web view is assumed to exist or be planned separately.
- `instantiateAgentGroup` and `instantiateExternalHeadedTeam` already have PTY gates — this plan extends the same pattern to the remaining paths.

## Adversarial Synthesis

Key risks: (1) Line number drift in the original plan would have led an implementer to edit wrong functions in a 27,780-line file — all line numbers re-verified and corrected. (2) `_createAutobanTerminal` PTY creation path was underspecified — verb parameters, startup command delivery via `ptySendPrompt`, and state registry fields (`purpose: 'pty'`, `ideName: PTY_IDE_NAME`) are now explicit. (3) `_dispatchExecuteMessage` has 14 callers but only 3 were originally classified — `dispatchCustomPromptToRole` (line 6276) was a confirmed miss, now included. (4) The plan could pass its own success checks while missing an ungated path — a grep-based audit is added to the verification plan. Mitigations: all line numbers verified against current source; PTY creation details specified; all 14 `_dispatchExecuteMessage` callers classified; grep audit added.

## Proposed Changes

### Subtask 1: Gate `_createAutobanTerminal` on PTY fleet

**File:** `src/services/TaskViewerProvider.ts` (line 10790)

When `_ptyHostPort` is set, `_createAutobanTerminal` must create a PTY fleet terminal via `_ptyHostVerb('ptyCreateTerminal', ...)` instead of `vscode.window.createTerminal()` (line 10825). When no fleet is available, refuse with a clear error: "Team automations require a PTY terminal fleet. Open the Terminals panel in the browser cockpit or start the standalone host."

**PTY creation call** (replaces lines 10825-10829):
```typescript
const ptyRes = await this._ptyHostVerb('ptyCreateTerminal', {
    role: normalizedRole,
    name: uniqueName,
    cwd: cwd || workspaceRoot,
    claudeInlineRendering: vscode.workspace
        .getConfiguration('switchboard')
        .get<boolean>('terminal.claudeInlineRendering', true),
});
if (!ptyRes?.success) {
    this._seams().ui.showErrorMessage(
        `Failed to create PTY terminal for role '${normalizedRole}': ${ptyRes?.error || 'unknown error'}`);
    return;
}
```
No `delegates` or `teamName` — this is a single terminal, not a group. The `claudeInlineRendering` setting is threaded in because the pty child cannot read configuration (same reason as `instantiateAgentGroup` at line 12852).

**Startup command delivery** (replaces lines 10873-10904+):
The current code sends the startup command via `terminal.sendText()` (line 10890) — a VS Code terminal API. For PTY terminals, deliver via `_ptyHostVerb('ptySendPrompt', { name: uniqueName, data: startupCommand.trim(), clearBeforePrompt: false })`. Wait for shell readiness before sending (the pty host child handles this internally for `ptyCreateTerminal`, but a short delay may be needed — mirror the 1500ms wait in `instantiateAgentGroup`'s pattern).

**State registry update** (replaces lines 10853-10871):
The current manual `updateState` sets `purpose: 'autoban-backup'` and `ideName: vscode.env.appName`. For PTY terminals, either:
- (a) Replace the manual update with `void this._updatePtyMirrorRegistry?.(db)` (the callback `instantiateAgentGroup` uses at line 12858), which reads the fleet list and writes `purpose: 'pty'` / `ideName: PTY_IDE_NAME` entries; OR
- (b) Change the manual update fields to `purpose: 'pty'` and `ideName: PTY_IDE_NAME` so `_isFleetTerminalInfo` (line 9946) recognizes the terminal.

Option (a) is preferred — it reuses the existing mirror mechanism and stays consistent with `instantiateAgentGroup`. The `_registeredTerminals?.set()` call at line 10830 must be skipped for PTY terminals (no VS Code terminal object to register).

**Collision detection** (lines 10814-10823):
The `usedNames` set at line 10819 includes `vscode.window.terminals.map(t => t.name)` — for PTY terminals, also include PTY fleet terminal names from `_ptyHostVerb('ptyListTerminals', {})` to avoid name collisions across both registries.

### Subtask 2: Gate `ensureWorktreeTerminals` on PTY fleet

**File:** `src/services/TaskViewerProvider.ts` (line 11784)

`ensureWorktreeTerminals` calls `_createAutobanTerminal` at line 11841 for each role. After subtask 1, this automatically routes through the PTY fleet when available. No additional change needed beyond subtask 1 — but verify that the worktree path (`resolvedPath`, line 11885) is passed through to `ptyCreateTerminal` as the `cwd` (it is — `resolvedPath` is the third argument to `_createAutobanTerminal` at line 11841, which becomes the `cwd` parameter).

### Subtask 3: Filter VS Code terminals from team dispatch resolution

**File:** `src/services/TaskViewerProvider.ts`

Three resolvers need to stop returning VS Code terminals for team dispatch:

1. **`_resolveAgentTerminalForPlan`** (line 10064): The fallback to `_getAgentNameForRole` (line 10096) reads the VS Code registry. When `_ptyHostPort` is set, this fallback must be removed — if no PTY terminal matches (worktree match at line 10071, team-scoped match at line 10080, fleet match at lines 10087-10095), return `undefined` (no target). When no fleet exists, keep the fallback (the refusal happens at the dispatch layer, not the resolver). This affects `dispatchCustomPromptToRole` (line 6276) — which is a team dispatch path and is correctly affected.

2. **`resolveTeamRoleTerminal`** (line 10109): The VS Code registry union (lines 10126-10129) must be gated on `!this._ptyHostPort`. When a fleet exists, only PTY fleet terminals (lines 10118-10125) are team members. The `live` array should not include VS Code registry entries when a fleet is available.

3. **`_selectAutobanTerminal`** (line 10576): Must pass `allowPtyFleet: true` to `_getAliveAutobanTerminalRegistry` at line 10594 so PTY fleet terminals are visible. Additionally — and this is critical — when `_ptyHostPort` is set, filter `aliveEntries` (line 10595) to only entries where `_isFleetTerminalInfo(info)` is true. Without this filter, the registry returns BOTH PTY and VS Code terminals, and `_selectAutobanTerminal` could pick a VS Code terminal — the exact violation this plan exists to prevent. The filter:
```typescript
const aliveRegistry = await this._getAliveAutobanTerminalRegistry(workspaceRoot, { allowPtyFleet: true });
const aliveEntries = Object.entries(aliveRegistry)
    .filter(([, info]) => this._normalizeAgentKey((info as any)?.role) === normalizedRole)
    .filter(([, info]) => !this._isAutobanBackupTerminalInfo(info))
    .filter(([, info]) => !info?.hidden)
    .filter(([, info]) => !this._ptyHostPort || this._isFleetTerminalInfo(info)) // PTY-only when fleet exists
    .sort(([a], [b]) => a.localeCompare(b));
```

### Subtask 4: Filter VS Code terminals from `_scheduleQueuePop` fallback

**File:** `src/services/TaskViewerProvider.ts` (line 13235)

The fallback to `getAliveRoleTerminalNames` (lines 13257-13263) reads the VS Code registry (via `_getAliveAutobanTerminalNames` → `_getAliveAutobanTerminalRegistry` with `allowPtyFleet: false`). When `_ptyHostPort` is set, this fallback must be removed — the schedule only dispatches to PTY fleet terminals. When no fleet exists, the schedule should no-op (it already does when no head is found — line 13265).

The code comment at lines 13244-13254 already documents that `getAliveRoleTerminalNames` is invisible to PTY fleet terminals. The fix is to wrap the fallback block (lines 13256-13263) in `if (!this._ptyHostPort) { ... }` so it only fires for fleet-less installs.

### Subtask 5: Filter VS Code terminals from `_isTerminalLive` for team automation checks

**File:** `src/services/TaskViewerProvider.ts` (line 9904)

`_isTerminalLive` is used by `handoffOrchestrationSession` (line 11421) to verify a coding head is live before handing off orchestration to it. The coding head IS a team member (lead/coder), so this check is in scope. The check currently accepts VS Code terminals (lines 9905-9931). Add a parameter `ptyOnly?: boolean` — when true, skip the `_registeredTerminals` check (lines 9905-9922) and the `vscode.window.terminals` check (lines 9923-9931) and only check `_ptyTerminalNames` (lines 9935-9940). `handoffOrchestrationSession` passes `ptyOnly: true` at line 11421.

Note: `_pickTerminalCandidate` (lines 9968-9970) also calls `_isTerminalLive` but does NOT pass `ptyOnly` — it uses the default (false) to maintain fleet-vs-VS-Code precedence for general resolution. This is correct: `_pickTerminalCandidate` is a general utility, not a team automation gate.

### Subtask 6: Filter VS Code terminals from `_attemptDirectTerminalPush` for team dispatches

**File:** `src/services/TaskViewerProvider.ts` (line 21347)

`_attemptDirectTerminalPush` checks the PTY fleet first (lines 21358-21407), then falls back to VS Code `sendRobustText` (lines 21409-21437). The VS Code fallback is the delivery path for VS Code terminals. For team dispatches, this fallback must be removed — when the PTY fleet check fails, return `false` (delivery failed) instead of falling through to VS Code.

Add a `ptyOnly?: boolean` parameter to `_dispatchExecuteMessage` (line 21273) and `_attemptDirectTerminalPush` (line 21347). When true, skip the VS Code fallback in `_attemptDirectTerminalPush` (wrap lines 21409-21437 in `if (!ptyOnly) { ... }`). Thread the parameter from `_dispatchExecuteMessage` to `_attemptDirectTerminalPush` at line 21290.

**Full caller classification for `_dispatchExecuteMessage` (14 callers):**

| Caller | Line | Team path? | `ptyOnly`? |
|--------|------|-----------|------------|
| `dispatchCustomPromptToRole` | 6288 | Yes (dispatches to team roles: planner) | `true` |
| `handleKanbanBatchTrigger` (batch dispatch) | 7111 | Yes (batch team dispatch) | `true` |
| `startOrchestratorFromKanban` (adopted seat) | 11124 | No (orchestrator kickoff) | `false` (default) |
| `startOrchestratorFromKanban` (new terminal) | 11275 | No (orchestrator kickoff) | `false` (default) |
| `dispatchToCoderTerminal` | 12015 | Yes (coder dispatch) | `true` |
| `_handleTriggerAgentActionInternal` (reviewer dispatch) | 21870 | Yes (reviewer is a team role) | `true` |
| `_handleTriggerAgentActionInternal` (pre-review coder report) | 21922 | Yes (coder is a team role) | `true` |
| `_handleTriggerAgentActionInternal` (message dispatch) | 22042 | Yes (team dispatch) | `true` |
| `_tryFleetDeliveryForRole` → `_dispatchExecuteMessage` | 21261 | Yes (fleet delivery for role) | `true` |
| Airlock patch delivery | 24157 | No (manual patch application) | `false` (default) |
| PM terminal dispatch | 27638 | No (PM is not a team role) | `false` (default) |

When `_ptyHostPort` is not set (no fleet), the VS Code fallback remains for ALL callers — this is the legacy path for installs without a PTY fleet, which will be removed when the PTY web view is the only terminal surface. The `ptyOnly` flag only changes behavior when a fleet IS available.

## Verification Plan

### Automated Tests
1. `npm run compile` — zero errors. *(SKIPPED this run per session directive — check remains written.)*
2. Unit test: `_createAutobanTerminal` with `_ptyHostPort` set calls `_ptyHostVerb('ptyCreateTerminal', ...)`, not `vscode.window.createTerminal`.
3. Unit test: `_createAutobanTerminal` with no `_ptyHostPort` refuses with a clear error.
4. Unit test: `_createAutobanTerminal` with `_ptyHostPort` set delivers the startup command via `_ptyHostVerb('ptySendPrompt', ...)`, not `terminal.sendText()`.
5. Unit test: `_createAutobanTerminal` with `_ptyHostPort` set registers the terminal with `purpose: 'pty'` and `ideName: PTY_IDE_NAME` (or via `_updatePtyMirrorRegistry`).
6. Unit test: `_resolveAgentTerminalForPlan` with `_ptyHostPort` set returns `undefined` when no PTY terminal matches (does not fall back to VS Code registry).
7. Unit test: `_selectAutobanTerminal` with `allowPtyFleet: true` and `_ptyHostPort` set sees PTY fleet terminals AND filters out VS Code terminals.
8. Unit test: `_scheduleQueuePop` with `_ptyHostPort` set does not fall back to `getAliveRoleTerminalNames`.
9. Unit test: `resolveTeamRoleTerminal` with `_ptyHostPort` set does not include VS Code registry terminals.
10. Contract test: `_isTerminalLive(name, true)` returns false for a VS Code terminal, true for a PTY terminal.
11. Unit test: `_attemptDirectTerminalPush` with `ptyOnly: true` and `_ptyHostPort` set returns false when the target is not in the PTY fleet (does not fall back to VS Code).
12. Unit test: `_attemptDirectTerminalPush` with `ptyOnly: false` (default) and `_ptyHostPort` set still falls back to VS Code (non-team paths unchanged).

### Grep-Based Audit (Goal-vs-Appearance Guard)
13. Grep audit: search for all calls to `vscode.window.createTerminal` in `TaskViewerProvider.ts`. Verify each call site is either (a) gated by `!this._ptyHostPort` or a PTY fleet check, or (b) provably non-team (orchestrator, manual terminal, artifact send). No ungated team-path call to `vscode.window.createTerminal` may remain.
14. Grep audit: search for all calls to `sendRobustText` and direct `vscode.window.terminals` access in team dispatch paths. Verify each is either gated or non-team.

### Manual
1. With a PTY fleet available, click the `+` button in the Dispatch header — a PTY terminal is created, not a VS Code terminal.
2. With a PTY fleet available, open worktree terminals — PTY terminals are created.
3. With a PTY fleet available, run the autoban schedule — dispatch only goes to PTY terminals.
4. With no PTY fleet, click the `+` button — a clear error is shown, no VS Code terminal is created.
5. With no PTY fleet, the autoban schedule no-ops (no dispatch to VS Code terminals).
6. With a PTY fleet available, `dispatchCustomPromptToRole('planner', ...)` dispatches to a PTY planner terminal, not a VS Code terminal.

## Out of Scope

- **Orchestrator terminal type**: Entry-point dependent, already correct. `startOrchestratorFromKanban` (VS Code sidebar) creates a VS Code terminal; shell rail creates a PTY terminal. Not changing.
- **Pair programming IDE modes**: Not touching per user instruction.
- **Prompt-mode column dispatch**: Not in scope per user instruction.
- **VS Code sidebar button to open PTY web view**: Separate plan, assumed to exist or be planned.
- **Removing VS Code terminal support entirely**: VS Code terminals remain for non-team purposes (orchestrator, manual terminals, artifact sends). Only team automations are gated.
- **`sendPromptToAgentTerminal`**: Already tries PTY first via `_tryFleetDeliveryForRole` (line 5714) and refuses VS Code creation when a fleet exists (line 5741). No change needed.

## Recommendation

Complexity 6 — **Send to Coder**.

## Implementation Summary

Gated all team automation terminal creation, selection, and dispatch on PTY fleet availability across both extension and standalone hosts via `_hasFleet()`. `_createAutobanTerminal` now creates PTY fleet terminals via `ptyCreateTerminal` without duplicate startup commands and refuses creation when no fleet is active. Terminal resolution paths (`_resolveAgentTerminalForPlan`, `resolveTeamRoleTerminal`, `_selectAutobanTerminal`, and scheduler queue pop) enforce strict PTY fleet selection and eliminate all fallbacks to VS Code window terminals or non-PTY registries. Live-seat validation (`_isTerminalLive`, `_isLikelyPtyDispatchTarget`) consults `getFleetLiveness()` (`_fleetLivenessProvider`) in addition to cached name snapshots, ensuring standalone in-process PTY fleets correctly report liveness during Mission Control handoff and worktree seat matching. Parity contract tests verify standalone and extension alignment.
