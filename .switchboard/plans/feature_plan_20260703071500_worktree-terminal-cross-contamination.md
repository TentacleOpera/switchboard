# Fix: Worktree terminal cross-contamination with main repo terminals

## Goal

### Problem
When a user has a worktree with `agentsOpenWithGrid` enabled and `suppressMainTerminals` OFF, clicking "OPEN AGENT TERMINALS" in the sidebar or implementation.html terminals tab produces a broken mix — some terminals open in the main workspace, others in the worktree — instead of the expected behavior of opening terminals in BOTH locations.

### Root Cause Analysis
The `createAgentGrid` function in `extension.ts` (line 2573) creates terminals in two phases:
1. **Phase 1 (lines 2650–2658)**: Worktree terminals via `ensureWorktreeTerminals` → `_createAutobanTerminal`
2. **Phase 2 (lines 2660+)**: Main repo terminals via direct `vscode.window.createTerminal`

Three cross-contamination bugs cause the broken behavior:

**Bug 1 — `matchesGridAgentName` matches worktree terminals (extension.ts line 2663)**
The main repo terminal creation uses `matchesGridAgentName` to check if a terminal already exists (line 2747):
```typescript
let terminal = vscode.window.terminals.find(t => t.exitStatus === undefined && matchesGridAgentName(t, agent.name));
```
This scans ALL `vscode.window.terminals`, including worktree terminals created in Phase 1. Since worktree terminals are named identically (e.g., "Planner", "Lead Coder"), `matchesGridAgentName` finds the worktree terminal, considers it "already existing," and skips main repo creation for that role. Result: that role's terminal only exists in the worktree, not the main repo.

**Bug 2 — Pool limit in `ensureWorktreeTerminals` counts main repo terminals (TaskViewerProvider.ts line 7555)**
```typescript
const livePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
```
`_getAliveAutobanTerminalNames` (backed by `_getAliveAutobanTerminalRegistry`, line 6545) counts ALL alive non-backup terminals in the registry, including main repo `agent-grid` terminals — it does NOT filter by `worktreePath`. If 5 main repo terminals already exist for a role, worktree terminal creation for that role is blocked entirely. The pool limit should be per-location (worktree vs main), not global.

**Bug 3 — `clearGridBlockers` disposes worktree terminals as duplicates (extension.ts line 2700)**
```typescript
const matches = vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, agent.name));
if (healthy.length > 1) { /* dispose extras */ }
```
If both a main repo and worktree terminal share the same agent name, `clearGridBlockers` sees them as "duplicates" and disposes one — typically the worktree terminal since it was created first.

### Combined Effect
On a typical run with suppressMain OFF and one worktree:
- Phase 1 creates worktree terminals: "Planner", "Lead Coder", "Coder", "Intern", "Reviewer"
- Phase 2 checks `matchesGridAgentName` for each agent → finds the worktree terminals → skips ALL main repo creation
- User sees terminals ONLY in the worktree, NOT in the main repo
- If some terminals had different names (due to pre-existing terminals causing name suffixing), a partial mix occurs

### Key Confirmation (verified in source)
Main repo agent-grid terminals ARE registered in the terminal registry state with `worktreePath: effectiveCwd` (extension.ts line 2766 sets `worktreePath: effectiveCwd` in the batch registration, and line 2790 persists it to `state.terminals`). This means the proposed `mainRepoTerminalNames` filter — which selects state entries whose `worktreePath` resolves to `effectiveCwd` — correctly identifies main repo terminals and excludes worktree terminals (whose `worktreePath` is the worktree path, set at TaskViewerProvider.ts line 7115). The fix is structurally sound.

## Metadata
- **Tags:** bugfix, backend
- **Complexity:** 6

## User Review Required

Yes — the fix changes `matchesGridAgentName` from a pure name-regex check to a name-regex + state-registry lookup. Reviewer should confirm that: (a) building a `mainRepoTerminalNames` set from registry state once per `createAgentGrid` call is acceptable overhead, (b) the `worktreePath === effectiveCwd` equality is the correct discriminator (vs. e.g. checking `purpose === 'agent-grid'`), and (c) no other caller of `matchesGridAgentName` exists outside `createAgentGrid` that would break from the narrowed match semantics.

## Complexity Audit

### Routine
- Adding `worktreePath` checks to existing terminal-finding logic
- Filtering pool count by worktree path (using the existing private `_getAliveAutobanTerminalRegistry`)
- Exposing `readTerminalRegistryState` as a public wrapper (one-line delegation)

### Complex / Risky
- `matchesGridAgentName` is a closure inside `createAgentGrid` — it doesn't have access to terminal state. Need to cross-reference `vscode.window.terminals` with the state registry to determine if a terminal is a worktree terminal or main repo terminal. The proposed fix builds a `mainRepoTerminalNames` set once before the closure, which is correct but adds a one-time state read per `createAgentGrid` call.
- `clearGridBlockers` disposes terminals — must be careful not to break the duplicate-cleanup logic for main repo terminals. Since `clearGridBlockers` uses `matchesGridAgentName`, narrowing that function to main-repo-only automatically narrows `clearGridBlockers` too. This is the desired behavior, but it means worktree duplicate cleanup is no longer handled by `clearGridBlockers` — confirm worktree dedup is handled elsewhere (the `ensureWorktreeTerminals` existence check at line 7547 covers same-role-same-path duplicates).
- The `registeredTerminals` map stores both main repo and worktree terminals by suffixed name — need to distinguish them. The state-registry lookup is the source of truth for `worktreePath`; the in-memory `registeredTerminals` map does not carry `worktreePath`.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `mainRepoTerminalNames` set is built from registry state at the start of Phase 2. `clearGridBlockers` (line 2742) runs AFTER the set is built and may dispose terminals / delete state entries. Stale entries in the set are harmless because `matchesGridAgentName` first filters `vscode.window.terminals` (live terminals only) via the regex — a disposed terminal is not in `vscode.window.terminals`, so a stale set entry never matches.
- **Security:** No external input is trusted here; `worktreePath` and `effectiveCwd` are internal paths. `path.resolve` normalization prevents path-trivial mismatches.
- **Side Effects:** Narrowing `matchesGridAgentName` to main-repo-only means `clearGridBlockers` will no longer dispose worktree duplicates. This is correct (worktree terminals are managed by `ensureWorktreeTerminals`), but verify no code path relied on `clearGridBlockers` cleaning worktree terminals.
- **Multiple worktrees with agentsOpenWithGrid**: Each worktree should get its own set of terminals. The pool limit fix must be per-worktree-path, not per-role-global. The proposed fix filters by `path.resolve(entry.worktreePath) === resolvedPath`, which is per-worktree-path. Correct.
- **Pre-existing terminals from previous session**: On VS Code reload, terminals may be restored. The `matchesGridAgentName` check must correctly identify which are main repo vs worktree. Since the discriminator is `worktreePath` in state (persisted), restored terminals are classified correctly as long as their state entry survived.
- **Terminal name collision**: `getNextAutobanTerminalName` suffixes names with numbers (e.g., "Planner 2"). The `matchesGridAgentName` regex `^Planner(?: \(\d+\))?$` does NOT match "Planner 2" (space-number, not parenthesized). This means suffixed worktree terminals won't suppress main repo creation, but non-suffixed ones will. The proposed fix's `mainRepoTerminalNames` set membership check is the authoritative gate, so the regex gap is moot once the set check is in place.
- **`cwdOverride` option**: When `createAgentGrid` is called with `cwdOverride`, `effectiveCwd` may differ from the workspace root. The main repo terminal check must use `effectiveCwd` as the distinguishing path. The proposed fix uses `path.resolve(effectiveCwd)` — correct.
- **`disposeAllGridTerminals`**: Only cleans `agent-grid` purpose from state, not `autoban-backup`. This is correct behavior (worktree terminals are managed separately) but should be verified after the fix.
- **Dependencies & Conflicts:** This plan touches `ensureWorktreeTerminals` (pool limit) and `createAgentGrid` (matchesGridAgentName). The sibling subtask "Fix Slow Sequential Terminal Opening" also rewrites `ensureWorktreeTerminals`. The two plans must be merged carefully — the pool-limit filter (this plan) must be preserved inside the pre-filter loop of the parallelized `ensureWorktreeTerminals` (sibling plan). See epic `## Dependencies & sequencing`.

## Dependencies

- None at the session/plan-id level. Coordinate with the sibling subtask "Fix Slow Sequential Terminal Opening" because both rewrite `ensureWorktreeTerminals` — land the pool-limit filter inside whichever version of that function ships second.

## Adversarial Synthesis

Key risks: (1) `matchesGridAgentName` narrowing silently disables worktree-duplicate cleanup in `clearGridBlockers`, leaving orphaned worktree terminals if `ensureWorktreeTerminals`' existence check ever has a gap; (2) the one-time state read to build `mainRepoTerminalNames` adds latency to every `createAgentGrid` call even when no worktrees exist (mitigated — the read is skipped when `gridWorktrees.length === 0` because Phase 2 only runs when `!suppressMain`, and the set is only needed when worktree terminals could collide); (3) relying on `worktreePath` persistence in state means a corrupted/missing state entry misclassifies a terminal. Mitigations: confirm worktree dedup coverage, gate the state read behind `gridWorktrees.length > 0`, and fall back to name-only matching if the state read fails.

## Uncertain Assumptions

The following assumptions are not 100% confirmed from the codebase alone. The user was advised to run web research to confirm them before implementation:

- VS Code's `vscode.window.terminals` array reliably excludes disposed terminals synchronously after `terminal.dispose()` returns, so the `exitStatus === undefined` + live-array filter in `clearGridBlockers` never matches a just-disposed terminal. (API behavior.)
- Restored terminals from a previous VS Code session retain their `creationOptions.name` so `matchesGridAgentName`'s `createdName` fallback still classifies them correctly. (API behavior.)

## Proposed Changes

### 1. `src/extension.ts` — Make `matchesGridAgentName` worktree-aware (line 2663)

**Current** (line 2663):
```typescript
const matchesGridAgentName = (terminal: vscode.Terminal, agentName: string): boolean => {
    const creationName = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.name;
    const terminalName = normalizeGridTerminalName(terminal.name);
    const createdName = normalizeGridTerminalName(creationName);
    const primaryPattern = new RegExp(`^${escapeRegex(agentName)}(?: \\(\\d+\\))?$`);
    return primaryPattern.test(terminalName) || primaryPattern.test(createdName);
};
```

**Proposed**: Build a set of terminal names that are main repo terminals (state entries whose `worktreePath` resolves to `effectiveCwd`), then require both a name-regex match AND set membership. Gate the state read behind `gridWorktrees.length > 0` to avoid overhead when no worktrees are configured:

```typescript
// Build a set of terminal names that are main repo terminals (not worktree).
// Only needed when worktree terminals exist and could collide by name.
const mainRepoTerminalNames = new Set<string>();
if (gridWorktrees.length > 0) {
    try {
        const terminalState = await taskViewerProvider.readTerminalRegistryState(effectiveWorkspaceRoot);
        for (const [name, info] of Object.entries(terminalState || {})) {
            const entry = info as any;
            // A terminal is "main repo" if its worktreePath matches effectiveCwd
            // (main repo agent-grid terminals are registered with worktreePath: effectiveCwd
            // at extension.ts line 2766; worktree terminals have worktreePath = the worktree path).
            const termWtPath = entry.worktreePath ? path.resolve(entry.worktreePath) : '';
            if (termWtPath === path.resolve(effectiveCwd)) {
                mainRepoTerminalNames.add(name);
                mainRepoTerminalNames.add(entry.friendlyName || name);
            }
        }
    } catch {
        // If state read fails, fall back to name-only matching (pre-fix behavior) for safety.
    }
}

const matchesGridAgentName = (terminal: vscode.Terminal, agentName: string): boolean => {
    const creationName = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.name;
    const terminalName = normalizeGridTerminalName(terminal.name);
    const createdName = normalizeGridTerminalName(creationName);
    const primaryPattern = new RegExp(`^${escapeRegex(agentName)}(?: \\(\\d+\\))?$`);
    if (!primaryPattern.test(terminalName) && !primaryPattern.test(createdName)) {
        return false;
    }
    // When no worktree terminals exist, fall back to pure name match (pre-fix behavior).
    if (mainRepoTerminalNames.size === 0) {
        return true;
    }
    // Exclude worktree terminals — only match main repo terminals.
    const suffixedTerminalName = suffixedName(terminalName);
    const suffixedCreatedName = createdName ? suffixedName(createdName) : '';
    return mainRepoTerminalNames.has(terminalName) ||
           mainRepoTerminalNames.has(suffixedTerminalName) ||
           mainRepoTerminalNames.has(createdName) ||
           mainRepoTerminalNames.has(suffixedCreatedName);
};
```

**Note**: `readTerminalRegistryState` must be exposed as a public method on `TaskViewerProvider` (see change #4). `suffixedName` already exists in `extension.ts` (line 252).

### 2. `src/extension.ts` — `clearGridBlockers` (line 2672)

**Current** (line 2700):
```typescript
for (const agent of agents) {
    const matches = vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, agent.name));
    // ... dispose duplicates beyond the first
}
```

**Proposed**: Since `matchesGridAgentName` is now worktree-aware (only matches main repo terminals when worktrees exist), `clearGridBlockers` will naturally only target main repo duplicates. No additional change needed beyond the `matchesGridAgentName` fix above. Worktree duplicate cleanup remains the responsibility of `ensureWorktreeTerminals`' existence check (line 7547).

### 3. `src/services/TaskViewerProvider.ts` — Fix pool limit in `ensureWorktreeTerminals` (line 7552)

**Current** (line 7552):
```typescript
const workspaceRoot = this._resolveWorkspaceRoot();
if (workspaceRoot) {
    const normalizedRole = this._normalizeAutobanPoolRole(role);
    const livePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
    const configuredPool = this._getConfiguredAutobanPool(normalizedRole);
    const poolSize = configuredPool.length > 0 ? configuredPool.length : livePrimaryRoleTerminals.length;
    if (poolSize >= 5) { // MAX_AUTOBAN_TERMINALS_PER_ROLE is 5
        vscode.window.showWarningMessage(`Could not open ${agentName} terminal for ${path.basename(resolvedPath)}: role terminal limit reached`);
        continue;
    }
}
```

**Proposed**: Count only terminals whose `worktreePath` matches the current worktree path, not all non-backup terminals. Use the existing private `_getAliveAutobanTerminalRegistry` (line 6545):

```typescript
const workspaceRoot = this._resolveWorkspaceRoot();
if (workspaceRoot) {
    const normalizedRole = this._normalizeAutobanPoolRole(role);
    const aliveTerminals = await this._getAliveAutobanTerminalRegistry(workspaceRoot);
    // Count only terminals for THIS worktree path, not main repo or other worktrees
    const worktreeTerminalsForRole = Object.entries(aliveTerminals)
        .filter(([, info]) => {
            const entry = info as any;
            return this._normalizeAutobanPoolRole(entry.role) === normalizedRole &&
                   entry.worktreePath &&
                   path.resolve(entry.worktreePath) === resolvedPath;
        })
        .map(([name]) => name);
    if (worktreeTerminalsForRole.length >= MAX_AUTOBAN_TERMINALS_PER_ROLE) {
        vscode.window.showWarningMessage(`Could not open ${agentName} terminal for ${path.basename(resolvedPath)}: worktree role terminal limit reached`);
        continue;
    }
}
```

**Note**: This block sits inside the pre-filter loop of `ensureWorktreeTerminals`. If the sibling subtask ("Fix Slow Sequential Terminal Opening") is landed, this filter must be preserved inside that plan's `rolesToCreate` pre-filter loop — the two changes occupy the same code region.

### 4. `src/services/TaskViewerProvider.ts` — Expose `readTerminalRegistryState` (line 6527)

`_readTerminalRegistryState` is private (line 6527). Add a public wrapper so `extension.ts` can read the registry for the `mainRepoTerminalNames` set:

```typescript
public async readTerminalRegistryState(workspaceRoot?: string): Promise<Record<string, any>> {
    const root = workspaceRoot || this._resolveWorkspaceRoot();
    if (!root) { return {}; }
    return this._readTerminalRegistryState(root);
}
```

## Verification Plan

> Compilation and automated tests are intentionally skipped per session directive. Verification is manual.

### Automated Tests
- Skipped per session directive.

### Manual Verification
1. **Manual test — suppressMain OFF, one worktree with agentsOpenWithGrid**:
   - Open kanban, create a worktree, check "Agent terminals" checkbox on the worktree
   - Ensure "Suppress main repo agent terminals" is UNCHECKED
   - Click "OPEN AGENT TERMINALS" in sidebar
   - **Expected**: Terminals open in BOTH the main repo AND the worktree (full set in each)
   - **Verify**: Check terminal panel — should see e.g., "Planner" (main repo) + "Planner" (worktree, possibly with suffix)

2. **Manual test — suppressMain ON, one worktree**:
   - Same setup but check "Suppress main repo agent terminals"
   - Click "OPEN AGENT TERMINALS"
   - **Expected**: Terminals open ONLY in the worktree, NOT in main repo

3. **Manual test — no worktrees, no suppressMain**:
   - Click "OPEN AGENT TERMINALS"
   - **Expected**: Terminals open only in main repo (no regression — `mainRepoTerminalNames.size === 0` falls back to pure name match)

4. **Manual test — multiple worktrees with agentsOpenWithGrid**:
   - Two worktrees, both with "Agent terminals" checked, suppressMain OFF
   - Click "OPEN AGENT TERMINALS"
   - **Expected**: Terminals in main repo + both worktrees

5. **Manual test — "Open terminals" button on individual worktree in kanban**:
   - Click "Open terminals" button on a worktree row
   - **Expected**: Terminals open only for that worktree (this path goes through `openWorktreeTerminals` in KanbanProvider, not `createAgentGrid`)

6. **Regression test — "RESET ALL AGENTS" button**:
   - Open terminals in main repo + worktree
   - Click "RESET ALL AGENTS"
   - **Expected**: Main repo terminals disposed; worktree terminals should NOT be disposed (they have `autoban-backup` purpose, not `agent-grid`)

7. **Regression test — pool limit**:
   - Open 5+ terminals for a single role in a worktree
   - **Expected**: 6th terminal is blocked with warning message (per-worktree, not global — main repo terminals for the same role must NOT count toward the worktree limit)

8. **Regression test — duplicate cleanup**:
   - Open main repo terminals, then click "OPEN AGENT TERMINALS" again
   - **Expected**: `clearGridBlockers` disposes duplicate MAIN REPO terminals only; worktree terminals are untouched

## Recommendation

Complexity 6 → **Send to Coder**.
