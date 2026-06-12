# Fix Agent Grid Terminal Startup Command Race Condition

## Goal

Make `createAgentGrid` immune to concurrent `registeredTerminals.clear()` / rebuild by using **locally-held terminal references** for startup command dispatch. The fix must be minimal, preserve all existing sync behavior for the sidebar and state.json, and not regress any terminal lifecycle bugs.

**Core Problem & Background:** The Switchboard extension's `createAgentGrid` function opens VS Code terminals for configured agents and sends startup commands after waiting for shell-ready events via `onDidStartTerminalShellExecution`. `createAgentGrid` stores each new terminal in the shared `registeredTerminals` `Map<string, vscode.Terminal>`, then calls `terminal.show()`. VS Code's `onDidOpenTerminal` event fires on `.show()`, and a handler registered in `activate()` calls `syncTerminalRegistryWithState()`.

That function unconditionally calls `registeredTerminals.clear()` and rebuilds the map **only** from terminals listed in `state.json`. At this point `state.json` has **not yet been written** — `updateState()` is called later in `createAgentGrid`. The newly created grid terminals are therefore dropped from `registeredTerminals`.

When the shell-ready wait resolves and `createAgentGrid` tries to send startup commands:
```typescript
const terminal = registeredTerminals.get(suffixedName(agent.name));
terminal?.sendText(cmd.trim(), true);
```
…it gets `undefined`. The startup command is silently skipped.

**Why It Became Visible Recently:** This latent race has existed since the initial commit (`802aa341`, 2026-02-27) because `registeredTerminals.clear()` + rebuild from `state.json` was always present, and `onDidOpenTerminal` always triggered sync.

It became **reliably reproducible** after two changes on **2026-05-28**:
1. Commit `84f104e6`: Replaced the 1-second fixed `setTimeout` before `sendText` with an `onDidStartTerminalShellExecution` wait (up to 5 seconds), greatly expanding the race window.
2. Commit `edf8e8f5`: Added a pre-subscription to shell execution events, which also extends the window during which `onDidOpenTerminal` can fire and trigger the destructive sync.

Additionally, commit `1b7acb0` (2026-05-31) removed `inboxWatcher?.syncAllTerminals()` from the `onDidOpenTerminal` handler, eliminating a small delay that previously sometimes allowed `updateState` to win the race.

**Impact:**
- Agent grid terminals are created but remain empty — no CLI tool starts.
- Users must manually navigate to each terminal and run the command.
- Log output shows: `WARNING: terminal not found in registeredTerminals for '<agent>'`.

## Metadata

- **Tags:** bugfix, cli, reliability
- **Complexity:** 3

## User Review Required

No — this is a localized terminal-lifecycle bugfix with a well-understood root cause and minimal, non-breaking change.

## Complexity Audit

### Routine
- Single-file change confined to `createAgentGrid` (`src/extension.ts:2222–2471`).
- Introduces a local `Map` to shadow the global registry only during startup-command dispatch.
- Reuses existing terminal-creation loop and shell-ready wait logic.
- No new dependencies or external APIs.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- **Primary race:** `onDidOpenTerminal` → `syncTerminalRegistryWithState` clears `registeredTerminals` before `updateState()` writes grid terminals to `state.json` (`src/extension.ts:1697`). The local map eliminates this race for startup commands.
- **Secondary race:** If `syncTerminalRegistryWithState` fires again during the 5-second shell-ready wait, the global registry is rebuilt without the new terminals (state.json still stale). The local map remains unaffected because it is populated synchronously during the creation loop (`src/extension.ts:2361–2385`).
- **Population timing:** `gridTerminals.set` occurs synchronously in the `for` loop before any `await` that could yield to the event loop. The async `onDidOpenTerminal` callback cannot interleave mid-loop, so the local map is always fully populated before any sync can run.

### Security
- No security implications. Startup commands are already validated by `taskViewerProvider.getAgentStartupCommand`.

### Side Effects
- `registeredTerminals.set(...)` during the creation loop (`src/extension.ts:2385`) is preserved, so global registry state for `clearGridBlockers`, sidebar refresh, and other consumers remains intact.
- Post-grid `updateState` → state watcher → `syncTerminalRegistryWithState` path continues to work normally.
- The `clearGridBlockers` audit at Step 5 is accurate for the current ordering, but a future refactor that moves `clearGridBlockers` after terminal creation could reintroduce a race against the global registry.

### Dependencies & Conflicts
- Depends on existing `taskViewerProvider.getAgentStartupCommand`, `taskViewerProvider.updateState`, and VS Code `vscode.window.onDidStartTerminalShellExecution` API.
- No conflicts with concurrent plans.

## Constraints & Edge Cases

1. **Terminals may already exist.** `createAgentGrid` skips creation for terminals that already match the agent name. The local map must include both newly created and pre-existing terminals.
2. **Shell-ready wait may timeout.** The local reference must remain valid even if the 5-second `onDidStartTerminalShellExecution` timeout fires.
3. **Multiple agent roles may share the same startup command.** This is already handled; the fix must not change startup command lookup (`taskViewerProvider.getAgentStartupCommand`).
4. **Custom agents.** The loop already iterates over `customAgents`; no special handling needed beyond what's in the current loop.
5. **Post-grid sidebar refresh.** After `updateState` writes to `state.json`, the normal sync path (state watcher → `syncTerminalRegistryWithState`) must still work so the sidebar sees the correct terminal list.
6. **No global flags or suppression mechanisms.** Do not introduce a "grid creation in progress" flag to suppress `syncTerminalRegistryWithState` — this is brittle and misses edge cases (autoban, manual terminal open during grid creation).

## Dependencies

- None

## Adversarial Synthesis

Key risks: The fix assumes the synchronous creation loop populates `gridTerminals` before any async `onDidOpenTerminal` callback can fire — valid in the Node.js event loop but not an API guarantee. The 5-second shell-ready timeout and broader `syncTerminalRegistryWithState` blunt-clear behavior are unchanged, leaving residual fragility. Mitigations: Diagnostic logging makes fallback visible; a caller-trace log aids future debugging; the plan warns against reordering `clearGridBlockers`.

## Proposed Changes

### `src/extension.ts` — `createAgentGrid` function (`lines 2222–2471`)

#### Context
The function currently relies on `registeredTerminals.get(suffixedName(agent.name))` at line 2443 to retrieve the terminal for `sendText`. Between lines 2385 (`registeredTerminals.set(...)`) and 2443, `onDidOpenTerminal` can fire and trigger `syncTerminalRegistryWithState`, which clears the map and rebuilds it from `state.json` (line 1697). Because `updateState()` is not called until lines 2395–2409, the newly created terminals are absent from `state.json` and are dropped from the global registry.

#### Logic
Introduce a local `gridTerminals` Map that is populated synchronously during the terminal creation/lookup loop and used exclusively for startup-command dispatch. The global `registeredTerminals` continues to be populated so that `clearGridBlockers`, sidebar refresh, and post-grid sync paths work unchanged.

#### Implementation

**Step 1 — Declare local map**  
At the top of `createAgentGrid` (after line 2231, inside the function body):
```typescript
const gridTerminals = new Map<string, vscode.Terminal>();
```

**Step 2 — Populate local map during terminal creation / lookup**  
Inside the `for (const agent of agents)` loop (after line 2383, before `registeredTerminals.set` at line 2385):
```typescript
gridTerminals.set(suffixedName(agent.name), terminal);
```
This captures both newly created terminals and pre-existing terminals found via `vscode.window.terminals.find`.

**Step 3 — Use local map for startup command dispatch**  
Replace the lookup at line 2443:
```typescript
// BEFORE (line 2443):
const terminal = registeredTerminals.get(suffixedName(agent.name));

// AFTER:
const terminal = gridTerminals.get(suffixedName(agent.name));
```

**Step 4 — Add diagnostic logging for the local-map fallback**  
Replace the `if (terminal)` block at lines 2444–2453 with:
```typescript
if (terminal) {
    terminal.sendText(cmd.trim(), true);
    outputChannel?.appendLine(`[Extension] Sent startup command for '${agent.name}' (${agent.role}): ${cmd.trim()}`);

    // NEW: Cache the binary-derived agent display name
    const binary = cmd.trim().split(/\s+/)[0];
    const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
    taskViewerProvider.setTerminalAgentInfo(suffixedName(agent.name), agent.role, displayName);

    if (!registeredTerminals.has(suffixedName(agent.name))) {
        outputChannel?.appendLine(`[Extension] Startup command sent via local reference (registeredTerminals missing for '${agent.name}')`);
    }
} else {
    outputChannel?.appendLine(`[Extension] WARNING: terminal not found in gridTerminals for '${agent.name}' (key=${suffixedName(agent.name)})`);
}
```

**Step 5 — Verify no other affected lookups in `createAgentGrid`**  
- `clearGridBlockers()` (line 2298) uses `registeredTerminals.entries()` — not affected for the current ordering, but a future refactor that moves it after terminal creation would reintroduce a race.
- The `batchRegistrations` loop (line 2361) uses `suffixedName(agent.name)` for state persistence — not affected.
- The only other `registeredTerminals` access in `createAgentGrid` is `.set()` at line 2385, which is safe and must be preserved.

**Step 6 — Add trace log to `syncTerminalRegistryWithState`** *(Clarification — improves debuggability without changing behavior)*  
At the top of `_syncTerminalRegistryWithStateImpl` (line 1604):
```typescript
outputChannel?.appendLine(`[Extension] syncTerminalRegistryWithState called for ${workspaceRoot}`);
```
This makes it possible to correlate unexpected registry rebuilds with grid creation timing in the Output panel.

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The test suite will be run separately by the user.

### Manual Verification
1. **Happy path:** Open agent grid in a workspace with 6 built-in agents. Verify each terminal shows its startup command prompt.
2. **Existing terminals:** Open grid when some terminals already exist. Verify startup commands are sent to both new and existing terminals.
3. **Rapid re-open:** Close grid terminals, immediately re-open grid. Verify commands are sent.
4. **Custom agents:** Add a custom agent with a startup command. Verify the custom terminal receives its command.
5. **Sidebar sync:** After grid creation, verify sidebar "Terminals" tab lists all agents correctly.
6. **Log inspection:** Open Output panel → "Switchboard" channel, trigger "Open Agent Grid". Confirm log shows `Sent startup command for '<agent>'` for every agent. Confirm absence of `WARNING: terminal not found in registeredTerminals` messages.

## Risks

- **Risk:** The `onDidOpenTerminal` → sync path could still cause other issues (e.g. sidebar flicker, stale PID lookups). This plan does not attempt to fix the broader sync timing — it only fixes the startup command dispatch.
- **Mitigation:** The broader sync timing is a known architectural tension. A future plan could explore batching `syncTerminalRegistryWithState` calls during grid creation, but that is out of scope here.

---

**Recommendation:** Send to Intern
