# Fix Slow Sequential Terminal Opening in Worktrees

## Goal

Eliminate the multi-second delay between opening each agent terminal inside a worktree. Currently there is a noticeable several-second gap between each terminal appearing, making the "Open terminals" action feel broken for users with 5+ agent terminals.

### Problem Analysis & Root Cause

The root cause is **sequential awaits with fixed delays** inside `_createAutobanTerminal()` and `ensureWorktreeTerminals()`.

**Chain of calls:**

1. `ensureWorktreeTerminals(worktreePath, roles)` (`TaskViewerProvider.ts:7520`) loops over `roles` **sequentially** with `for (const role of roles)` and `await this._createAutobanTerminal(...)` on each iteration (line 7564).

2. Each `_createAutobanTerminal()` call (`TaskViewerProvider.ts:7026`) contains **two blocking delays**:
   - **PID resolution** (line 7073): `await this._waitWithTimeout(terminal.processId, 10000, undefined)` — waits up to 10 seconds for the VS Code terminal process ID promise to resolve. In practice this resolves in ~500ms–2s on macOS, but it is awaited **sequentially** before the next terminal can be created.
   - **Startup command delay** (line 7140): `await new Promise(resolve => setTimeout(resolve, 1000))` — a **hardcoded 1-second sleep** before sending the startup command to the terminal. This exists to give the terminal shell time to initialize before receiving text.

**Total per-terminal overhead:** ~1.5–3 seconds (PID wait + 1s sleep). With 6 roles (Planner, Lead Coder, Coder, Intern, Reviewer, Analyst), that's **9–18 seconds** of cumulative waiting, with each terminal appearing one at a time.

**Why the 1s sleep exists:** `terminal.sendText()` called immediately after `vscode.window.createTerminal()` can fail silently — the shell hasn't started yet and the command is lost. The 1s delay is a blunt workaround.

**Why PID resolution is awaited:** The PID is stored in the terminal registry state and used for dispatch routing (matching plans to terminals by PID). However, PID resolution does NOT need to block the creation of the next terminal — it can be done in parallel or after all terminals are created.

### Fix Strategy

1. **Parallelize terminal creation:** Create all terminals in parallel using `Promise.all` instead of a sequential `for` loop. Each terminal's `vscode.window.createTerminal()` call is independent.

2. **Defer PID resolution:** Don't await `terminal.processId` inside the creation loop. Instead, fire off PID resolution as a background promise per terminal and update the registry state when it resolves. The PID is only needed for dispatch routing, which happens later (when a plan is actually dispatched), not during creation.

3. **Replace the 1s sleep with the shell-ready event (Clarification — pattern already exists in this codebase):** The original plan assumed VS Code's terminal API provides no "shell ready" event. That is incorrect — `vscode.window.onDidStartTerminalShellExecution` IS that event, and it is already used in `extension.ts:2813` for the main-repo agent-grid path (`createAgentGrid`). The worktree path should adopt the same pattern: register a one-shot `onDidStartTerminalShellExecution` listener per created terminal, send the startup command when the event fires, and use a safety timeout (5s, matching the existing `createAgentGrid` pattern) to proceed even if the event never fires. This is strictly better than a blind `setTimeout(200)` because it sends the command exactly when the shell is ready — no lost commands, no unnecessary wait. (See `## Uncertain Assumptions` for the residual API-behavior question about `sendText` reliability before shell execution starts.)

4. **Batch state updates:** Instead of calling `updateState()` (which reads/writes the JSON state file) once per terminal, batch all terminal state entries into a single `updateState()` call after all terminals are created.

## Metadata

- **Tags:** backend, performance, bugfix
- **Complexity:** 6

## User Review Required

Yes — the shift from a fixed `setTimeout(1000)` to the `onDidStartTerminalShellExecution` event pattern changes the timing contract for startup-command delivery. Reviewer should confirm that worktree terminals are expected to receive their startup command via the same event-driven path as main-repo grid terminals, and that no downstream code assumes the command is sent synchronously inside `_createAutobanTerminal`.

## Complexity Audit

### Routine
- Replacing the `for` loop in `ensureWorktreeTerminals` with `Promise.all` — straightforward parallelization.
- Batching `updateState` calls — collecting state entries into an array and writing once.
- Deferring PID resolution to a background promise — mechanical refactor of an existing `await` into a fire-and-forget `.then()`.

### Complex / Risky
- **Shell-ready event adoption:** Switching from `setTimeout(1000)` to `onDidStartTerminalShellExecution` introduces an async listener per terminal. The listener must be disposed after firing (or after the safety timeout) to avoid a listener leak across many terminal-creation cycles. The existing `createAgentGrid` pattern (extension.ts:2813–2830) disposes the disposable correctly — mirror that disposal discipline.
- **PID resolution race:** Moving PID resolution to a background promise means the terminal registry may briefly have terminals without PIDs. If a dispatch happens in that window, `findTerminalNameByWorktreePath` (which matches by `worktreePath` in state, not by PID) will still find the terminal — PID is a secondary match key, not the primary one. The existing `worktreePath` field in the terminal state entry (set at creation time, line 7115) is populated immediately, so routing works without PID.
- **`_createAutobanTerminal` is also called from other paths:** It's called from `addAutobanTerminalFromKanban` (line 7410) and from a message handler (line 10162). The parallelization change is in `ensureWorktreeTerminals` only — `_createAutobanTerminal` itself stays sequential-safe (it can be called in parallel from multiple `Promise.all` branches, but each call creates one terminal). The state update inside `_createAutobanTerminal` uses `await this.updateState(...)` which is already serialized internally (the state update queue). Parallel calls to `updateState` are safe — they queue and apply in order.
- **Pool size check race:** The `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` check (line 7047) reads `configuredPool.length` and `livePrimaryRoleTerminals.length`. If multiple terminals for the same role are created in parallel, they all read the same pool size and all pass the check, potentially exceeding the limit. Mitigation: pre-check the pool size before the `Promise.all`, and only create `min(roles.length, remainingSlots)` terminals. Or accept a temporary over-limit (the pool is soft-capped and the next autoban tick will trim it).
- **No autoban retry for lost startup commands (corrected assumption):** The original plan claimed an "autoban retry mechanism" would re-send a lost startup command on the next tick. Code inspection found NO such retry — the startup command is sent exactly once (line 7141). This makes the event-driven approach (which sends the command only after the shell is ready) strictly safer than any fixed-delay reduction, because there is no safety net if the command is lost.

## Edge-Case & Dependency Audit

- **Race Conditions:** Parallel `Promise.all` creation means multiple `onDidStartTerminalShellExecution` listeners are registered simultaneously. Each listener must match its own terminal instance (by reference, as `createAgentGrid` does at line 2814) to avoid one terminal's shell-ready event sending another terminal's command.
- **Duplicate terminal creation:** `ensureWorktreeTerminals` already checks for existing terminals via `_findTerminalNameByWorktreePathAndRole` (line 7547) before creating. In parallel, multiple roles won't collide (different role = different terminal). The same role for the same worktree path is guarded by the existing check. However, if `ensureWorktreeTerminals` is called twice in quick succession (e.g., user double-clicks "Open terminals"), both calls may pass the existence check before either creates the terminal. The existing `createAgentGrid` already debounces with a 5-second button disable (kanban.html), so this is mitigated at the UI layer.
- **Terminal disposal during creation:** If the user closes a terminal while `Promise.all` is in flight, the `terminal.dispose()` may race with `terminal.sendText()`. VS Code's terminal API handles this gracefully — `sendText` on a disposed terminal is a no-op. The `onDidStartTerminalShellExecution` listener should also guard: if the terminal is disposed before the event fires, dispose the listener without sending.
- **State file corruption:** Batching state updates into one `updateState` call reduces the number of file writes, which actually reduces the risk of corruption from concurrent writes.
- **Side Effects:** The `_autobanState.terminalPools` / `managedTerminalPools` mutation (lines 7119–7135) currently runs once per terminal sequentially. Under parallel creation, these mutations must be applied atomically after all terminals are created, or the pool bookkeeping will race (each parallel branch reads `this._autobanState.terminalPools` and spreads it, so later branches overwrite earlier ones). Mitigation: collect all new suffixed names per role and apply a single pool update after `Promise.all` resolves.
- **No user data migration needed:** This is a pure performance fix — no state format changes, no new fields.

## Dependencies

- None — this plan is self-contained within `src/services/TaskViewerProvider.ts`. It does not depend on the cross-contamination fix (the other subtask in this epic), though the two plans touch overlapping code in `ensureWorktreeTerminals` and should be landed with awareness of each other (see epic `## Dependencies & sequencing`).

## Adversarial Synthesis

Key risks: (1) parallel `_autobanState.terminalPools` mutation races that corrupt pool bookkeeping, (2) `onDidStartTerminalShellExecution` listener leaks if not disposed on timeout/disposal, (3) PID-less registry window during which PID-based dispatch routing fails (mitigated — routing uses `worktreePath` first). Mitigations: apply pool updates atomically post-`Promise.all`, mirror the disposable-disposal discipline from `createAgentGrid:2813`, and rely on the existing `worktreePath`-first routing.

## Uncertain Assumptions

The following assumptions about the VS Code terminal API are not 100% confirmed from the codebase alone. The user was advised to run web research to confirm them before implementation:

- `terminal.sendText()` is a silent no-op (not a thrown error) when the shell has not yet started — relied upon by the safety-timeout fallback path.
- `vscode.window.onDidStartTerminalShellExecution` fires reliably for every created terminal across macOS/Linux/Windows and across all supported shells (bash, zsh, pwsh, cmd), so the startup command is not permanently lost when the event is used.
- `terminal.processId` resolves concurrently without serialization when awaited from multiple parallel branches (i.e., parallel `Promise.all` PID waits do not block each other).

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Parallelize `ensureWorktreeTerminals` (line 7520)

Replace the sequential `for` loop with parallel creation. Pre-filter roles (existence check + pool check) sequentially — these are cheap reads — then create the survivors in parallel:

```typescript
public async ensureWorktreeTerminals(worktreePath: string, roles: string[]): Promise<void> {
    const resolvedPath = path.resolve(worktreePath);
    const roleToName: Record<string, string> = {
        'planner': 'Planner', 'lead': 'Lead Coder', 'coder': 'Coder',
        'intern': 'Intern', 'reviewer': 'Reviewer', 'analyst': 'Analyst'
    };

    const wsRootForRoles = this._resolveWorkspaceRoot();
    let eligiblePoolRoles: Set<string> | null = null;
    if (wsRootForRoles) {
        try {
            const customAgentRoles = (await this.getCustomAgents(wsRootForRoles)).map(a => a.role);
            eligiblePoolRoles = new Set(this._autobanPoolRoles(customAgentRoles).map(r => this._normalizeAutobanPoolRole(r)));
        } catch { /* fall through */ }
    }

    // Filter to roles that need a terminal (skip existing + ineligible in one pass)
    const rolesToCreate: { role: string; agentName: string }[] = [];
    for (const role of roles) {
        if (eligiblePoolRoles && !eligiblePoolRoles.has(this._normalizeAutobanPoolRole(role))) {
            continue;
        }
        const existing = await this._findTerminalNameByWorktreePathAndRole(resolvedPath, role, true);
        if (existing) {
            continue;
        }
        // Pool size check
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            const normalizedRole = this._normalizeAutobanPoolRole(role);
            const livePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
            const configuredPool = this._getConfiguredAutobanPool(normalizedRole);
            const poolSize = configuredPool.length > 0 ? configuredPool.length : livePrimaryRoleTerminals.length;
            if (poolSize >= MAX_AUTOBAN_TERMINALS_PER_ROLE) {
                const agentName = roleToName[role] || role.charAt(0).toUpperCase() + role.slice(1);
                vscode.window.showWarningMessage(`Could not open ${agentName} terminal for ${path.basename(resolvedPath)}: role terminal limit reached`);
                continue;
            }
        }
        const agentName = roleToName[role] || role.charAt(0).toUpperCase() + role.slice(1);
        rolesToCreate.push({ role, agentName });
    }

    // Create all terminals in parallel
    await Promise.all(rolesToCreate.map(({ role, agentName }) =>
        this._createAutobanTerminal(role, agentName, resolvedPath)
    ));
}
```

### 2. `src/services/TaskViewerProvider.ts` — Defer PID resolution in `_createAutobanTerminal` (line 7071)

Replace the blocking PID await with a background fire-and-forget. Remove the 2-second retry `setTimeout` block (lines 7079–7097) — the background promise already handles late PID resolution:

```typescript
// BEFORE (blocking, lines 7071-7097):
let pid: number | undefined;
try {
    pid = await this._waitWithTimeout(terminal.processId, 10000, undefined);
} catch {
    console.warn(`[TaskViewerProvider] Failed to get PID for terminal '${uniqueName}' within 10s. Will retry.`);
}
if (!pid) {
    setTimeout(async () => { /* 2s retry ... */ }, 2000);
}

// AFTER (non-blocking — resolve in background, update state when ready):
const suffixedNameForPid = suffixedUniqueName;
void this._waitWithTimeout(terminal.processId, 10000, undefined)
    .then(pid => {
        if (pid) {
            void this.updateState(async (state) => {
                if (state.terminals?.[suffixedNameForPid]) {
                    state.terminals[suffixedNameForPid].pid = pid;
                    state.terminals[suffixedNameForPid].childPid = pid;
                }
            });
            this._refreshTerminalStatuses();
        }
    })
    .catch(() => {
        console.warn(`[TaskViewerProvider] PID resolution failed for terminal '${suffixedNameForPid}'.`);
    });
```

Then in the `updateState` call below (line 7099), set `pid: undefined` initially — it will be populated by the background promise above:

```typescript
state.terminals[suffixedUniqueName] = {
    purpose: 'autoban-backup',
    role: normalizedRole,
    pid: undefined,      // populated asynchronously by background PID resolver
    childPid: undefined, // populated asynchronously
    startTime: new Date().toISOString(),
    status: 'active',
    friendlyName: uniqueName,
    icon: 'terminal',
    color: 'cyan',
    lastSeen: new Date().toISOString(),
    ideName: vscode.env.appName,
    worktreePath: cwd || undefined
};
```

### 3. `src/services/TaskViewerProvider.ts` — Replace 1s sleep with shell-ready event (line 7137)

Replace the blind `setTimeout(1000)` with the `onDidStartTerminalShellExecution` pattern already used in `extension.ts:2813`. Send the startup command when the shell reports ready, with a 5s safety timeout that proceeds (and re-sends once) if the event never fires:

```typescript
// BEFORE (line 7140):
await new Promise(resolve => setTimeout(resolve, 1000));
terminal.sendText(startupCommand.trim(), true);

// AFTER (event-driven, mirrors createAgentGrid:2813-2830):
const startupCommands = await this.getStartupCommands(workspaceRoot);
const startupCommand = startupCommands[normalizedRole];
if (startupCommand && startupCommand.trim()) {
    await new Promise<void>((resolve) => {
        let disposed = false;
        const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
            if (e.terminal === terminal && !disposed) {
                disposable.dispose();
                disposed = true;
                if (terminal.exitStatus === undefined) {
                    terminal.sendText(startupCommand.trim(), true);
                }
                resolve();
            }
        });
        // Safety timeout: proceed after 5s even if the shell never reported ready.
        setTimeout(() => {
            if (!disposed) {
                disposable.dispose();
                disposed = true;
                outputChannel?.appendLine(`[TaskViewerProvider] Shell init timeout for worktree terminal '${uniqueName}', sending startup command anyway`);
                if (terminal.exitStatus === undefined) {
                    terminal.sendText(startupCommand.trim(), true);
                }
                resolve();
            }
        }, 5000);
    });

    // Cache the binary-derived agent display name (unchanged)
    const binary = startupCommand.trim().split(/\s+/)[0];
    const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
    this._terminalAgentInfo.set(suffixedUniqueName, { role: normalizedRole, displayName });
}
```

**Note:** `outputChannel` access inside `TaskViewerProvider` — verify the class has a logger reference; if not, fall back to `console.warn` for the timeout message (the existing code at line 7075 uses `console.warn`, so this is consistent).

### 4. `src/services/TaskViewerProvider.ts` — Apply pool bookkeeping atomically (lines 7119–7135)

The `_autobanState.terminalPools` / `managedTerminalPools` mutation currently runs once per terminal. Under parallel `Promise.all` creation, each branch reads and spreads `this._autobanState.terminalPools`, so later branches overwrite earlier branches' additions. Move this block out of `_createAutobanTerminal` into a post-`Promise.all` batch step in `ensureWorktreeTerminals`, OR guard it with a serializing lock. The simplest fix: collect the new suffixed names per role during creation and apply one pool update after `Promise.all` resolves.

## Verification Plan

> Compilation and automated tests are intentionally skipped per session directive. Verification is manual.

### Automated Tests
- Skipped per session directive.

### Manual Verification
1. Open a worktree with 6 agent roles enabled (Planner, Lead Coder, Coder, Intern, Reviewer, Analyst).
2. Click "Open terminals" on the worktree row.
3. **Measure:** all 6 terminals should appear within ~1–2 seconds total (vs. the current 9–18 seconds). Use a stopwatch or the VS Code terminal panel timestamp.
4. Confirm each terminal received its startup command (check that the agent CLI prompt is visible in each terminal) — the event-driven send should make this reliable.
5. Confirm the terminal registry state file has PIDs populated for all terminals within ~10 seconds of creation (the background PID resolver runs in parallel).
6. Trigger a plan dispatch to a worktree and confirm routing still works (the plan is sent to the correct worktree terminal by `worktreePath` match, not PID).
7. Test the "Suppress main repo agent terminals" + "Open terminals with grid" flow: click the main Agents button with suppress on and a worktree opted in. Confirm all worktree terminals open quickly.
8. Test edge case: click "Open terminals" twice rapidly. Confirm no duplicate terminals are created (the existence check + 5-second button debounce should prevent this).
9. Test edge case: close a terminal during creation. Confirm no crash, no unhandled promise rejection, and no listener leak (the `onDidStartTerminalShellExecution` disposable is disposed on timeout or terminal-disposal guard).
10. Test edge case: a shell that never reports ready (e.g., a misconfigured shell). Confirm the 5s safety timeout fires and the startup command is sent anyway, and that the disposable is disposed (no listener leak across repeated "Open terminals" presses).

## Recommendation

Complexity 6 → **Send to Coder**.
