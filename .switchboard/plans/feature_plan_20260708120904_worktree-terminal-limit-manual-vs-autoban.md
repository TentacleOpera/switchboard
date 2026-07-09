# Feature Plan: Remove Autoban 5-Terminal Cap from Manual Worktree Creation

## Goal

### Problem
Users cannot create more than 5 worktrees. When attempting to create a 6th, the system shows the error "cannot have more than 5 terminals per role" (actual message: "worktree role terminal limit reached"). This limit was designed for **autoban automation** to prevent runaway terminal spawning, but it is incorrectly applied to **manual, user-initiated worktree creation** via the Kanban UI.

### Background
- `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` is defined in `src/services/autobanState.ts` line 16.
- It is used in `src/services/TaskViewerProvider.ts` at:
  - Line 6714: `_limitAutobanPool()` — autoban-only, correct
  - Line 6718: `_getConfiguredAutobanPool()` — autoban-only, correct
  - Lines 7271–7272: autoban pool size check in `_createAutobanTerminal()` — autoban-only, correct (separate code path, does NOT call `ensureWorktreeTerminals`)
  - **Line 8131: `ensureWorktreeTerminals()` — THE BUG** — this function is called from manual worktree creation handlers
- `ensureWorktreeTerminals()` (lines 8086–8165, signature: `public async ensureWorktreeTerminals(worktreePath: string, roles: string[], reveal: boolean = true): Promise<void>`) is called from manual handlers in `KanbanProvider.ts`:
  - Line 9148: `createWorktree` — `ensureWorktreeTerminals(wtPath, activeAgents, true)`
  - Line 9185: `createWorktreeForFeature` — `ensureWorktreeTerminals(wtPath, activeAgents, true)`
  - Line 9221: `createWorktreeForProject` — `ensureWorktreeTerminals(wtPath, activeAgents, true)`
  - Line 9300: `openWorktreeTerminals` — `ensureWorktreeTerminals(w.path, activeAgents, true)`
  - Line 9858: `_ensureFeatureIntegrationWorktree` — `ensureWorktreeTerminals(wtPath, activeAgents, false)`
- **Autoban does NOT call `ensureWorktreeTerminals()`** — verified. Autoban dispatches via `_enqueueAutobanTick` → `_autobanTickColumn` → `handleKanbanBatchTrigger` → `_createAutobanTerminal()` (which has its own cap at lines 7271–7272). Adding an `isManual` flag to `ensureWorktreeTerminals` is safe — autoban is unaffected.

### Root Cause
`ensureWorktreeTerminals()` at line 8131 checks `worktreeTerminalsForRole.length >= MAX_AUTOBAN_TERMINALS_PER_ROLE` and blocks terminal creation. This check uses an autoban-specific constant for ALL worktree terminal creation, including manual user-initiated creation. The autoban cap should only apply to autoban automation, not to manual UI actions.

## Metadata

- **Tags:** backend, bugfix
- **Complexity:** 4

## User Review Required

No — this is a bugfix that restores intended behaviour (the 5-terminal cap was never meant for manual creation). No product-scope change, no schema migration, no breaking change. The autoban cap is preserved via its separate code path. Safe to implement without user sign-off.

## Complexity Audit

### Routine
- Removing or bypassing the `MAX_AUTOBAN_TERMINALS_PER_ROLE` check in `ensureWorktreeTerminals()` for manual call sites.
- Adding a parameter to `ensureWorktreeTerminals()` to distinguish manual vs autoban callers.

### Complex / Risky
- Ensuring the autoban callers still enforce the 5-terminal cap — the fix must not remove the cap from autoban paths.
- The `ensureWorktreeTerminals()` function is called from 5 sites; must verify each passes the correct `isManual` flag.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Terminal creation is sequential per worktree.

### Security
- None.

### Side Effects
- Users can now create more than 5 worktrees manually. This is the intended behaviour — the 5-limit was never meant for manual creation.
- More worktrees = more terminals = more resource usage. This is acceptable since the user explicitly initiated it.

### Dependencies & Conflicts
- The plan `feature_plan_20260703071500_worktree-terminal-cross-contamination.md` already addressed per-worktree-path filtering. This fix is orthogonal — it removes the hard cap for manual creation entirely.
- Must verify autoban callers (lines 7271–7272) are NOT affected — they use a different check path and should remain capped.

## Dependencies

- No upstream plan dependencies. This is a standalone bugfix.
- The `ensureWorktreeTerminals` signature change (section 1) must land BEFORE or in the same commit as the call-site changes (section 2) — TypeScript will flag the 4th argument as an error if the parameter doesn't exist yet.

## Adversarial Synthesis

Key risks: (1) Default `isManual: false` is the safe choice — if a future caller forgets the flag, it gets the cap (conservative), not unbounded terminals. (2) All 5 call sites verified — no missed callers, no autoban callers route through `ensureWorktreeTerminals`. (3) The `_ensureFeatureIntegrationWorktree` call (line 9858) passes `reveal: false` — the 4th arg must be `true` (isManual), not accidentally inherit `false`. Mitigation: explicit `false, true` in the call, positional clarity confirmed.

## Proposed Changes

---

### 1. `src/services/TaskViewerProvider.ts` — Add `isManual` parameter to `ensureWorktreeTerminals()`

**Context**: Lines 8086–8165, the `ensureWorktreeTerminals()` function. Current signature: `public async ensureWorktreeTerminals(worktreePath: string, roles: string[], reveal: boolean = true): Promise<void>`. Line 8131 has the cap check.

**Implementation**: Add `isManual: boolean = false` as the 4th parameter (after `reveal`). Default `false` is the defensive choice — any new caller that forgets to pass the flag gets the cap (safe), and all 5 existing manual callers will explicitly pass `true`:
```typescript
// BEFORE (line 8086):
public async ensureWorktreeTerminals(worktreePath: string, roles: string[], reveal: boolean = true): Promise<void> {
    // ...
    // Line 8131:
    if (worktreeTerminalsForRole.length >= MAX_AUTOBAN_TERMINALS_PER_ROLE) {
        vscode.window.showWarningMessage(`Could not open ${agentName} terminal for ${path.basename(resolvedPath)}: worktree role terminal limit reached`);
        continue;
    }
    // ...
}

// AFTER:
public async ensureWorktreeTerminals(worktreePath: string, roles: string[], reveal: boolean = true, isManual: boolean = false): Promise<void> {
    // ...
    // Only enforce the 5-terminal cap for autoban, not manual creation
    if (!isManual && worktreeTerminalsForRole.length >= MAX_AUTOBAN_TERMINALS_PER_ROLE) {
        vscode.window.showWarningMessage(`Could not open ${agentName} terminal for ${path.basename(resolvedPath)}: worktree role terminal limit reached`);
        continue;
    }
    // ...
}
```

---

### 2. `src/services/KanbanProvider.ts` — Pass `isManual: true` from manual call sites

**Context**: The 5 manual call sites (lines 9148, 9185, 9221, 9300, 9858).

**Implementation**: For each manual call, add `true` as the 4th argument (`isManual`):
```typescript
// Line 9148 (createWorktree):
await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);

// Line 9185 (createWorktreeForFeature):
await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);

// Line 9221 (createWorktreeForProject):
await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);

// Line 9300 (openWorktreeTerminals):
await this._taskViewerProvider.ensureWorktreeTerminals(w.path, activeAgents, true, true);

// Line 9858 (_ensureFeatureIntegrationWorktree):
// This is orchestration-related — pass isManual: true since it's user-initiated orchestration
// Note: this call passes reveal: false (not true like the others)
await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, false, true);
```

**Note**: The `isManual` parameter is the 4th positional arg, after `reveal`. All 5 callers already pass `reveal` explicitly (4 pass `true`, 1 passes `false`), so adding the 4th arg is a clean append with no positional ambiguity.

---

### 3. Verify autoban callers are unaffected

**Context**: Lines 7271–7272 in `TaskViewerProvider.ts` (`_createAutobanTerminal()`) — the autoban pool size check. This is a SEPARATE check from `ensureWorktreeTerminals()` and uses `MAX_AUTOBAN_TERMINALS_PER_ROLE` directly. It should remain unchanged.

**Verification**: Confirmed — the autoban terminal creation path (lines 7271–7272) does NOT call `ensureWorktreeTerminals()`. Autoban dispatches via `_enqueueAutobanTick` → `_autobanTickColumn` → `handleKanbanBatchTrigger` → `_createAutobanTerminal()`, which has its own cap check. No change needed there.

## Verification Plan

### Manual Verification
- [ ] Create 5 worktrees manually via the Worktrees tab — all succeed
- [ ] Create a 6th worktree manually — it succeeds (no "terminal limit reached" error)
- [ ] Create a 7th worktree manually — it succeeds
- [ ] Verify autoban dispatch still caps at 5 terminals per role (run autoban with >5 plans in a role)
- [ ] Verify "Open terminals" button on a 6th worktree works

### Automated

- Compilation (`npm run compile`) and automated tests are SKIPPED per session directive. Verify via the manual checklist above using an installed VSIX.
- A unit test for `ensureWorktreeTerminals` with `isManual: true` is recommended post-implementation (not part of this verification pass).

## Files Changed

- `src/services/TaskViewerProvider.ts` — add `isManual` param, gate the cap check
- `src/services/KanbanProvider.ts` — pass `isManual: true` from 5 manual call sites
- `src/extension.ts` — pass `isManual: true` from the `createAgentGrid` worktree-terminal call (6th manual caller, found in review)
- `dist/extension.js` — rebuild artefact

## Code Review (Direct Reviewer Pass — 2026-07-09)

**Verdict:** Gate + parameter correct; 5 KanbanProvider call sites correct. One MAJOR fixed inline — the plan's "no missed callers" claim was wrong.

### Verified as implemented
- `ensureWorktreeTerminals` signature (`TaskViewerProvider.ts:8395`) adds `isManual: boolean = false`; gate at `:8440` is `!isManual && worktreeTerminalsForRole.length >= MAX_AUTOBAN_TERMINALS_PER_ROLE`. Default-`false` is the conservative choice — a new caller that forgets the flag keeps the cap.
- All 5 KanbanProvider manual call sites pass `isManual: true`: `9469`, `9506`, `9542`, `9621`, and `10179` (`_ensureFeatureIntegrationWorktree`, correctly `..., false, true` — reveal=false, isManual=true, positional trap avoided).
- Autoban path (`_createAutobanTerminal`, `TaskViewerProvider.ts:7271-7272`) does NOT route through `ensureWorktreeTerminals` — cap retained there. Confirmed.

### Finding fixed inline
- **[MAJOR] Missed 6th manual caller** — `extension.ts:2683`, inside `createAgentGrid()`. This function is bound to the `switchboard.createAgentGrid` command (AGENTS button / status-bar terminal icon / "OPEN AGENT TERMINALS" button) — a user-initiated path exactly analogous to `openWorktreeTerminals`. It called `ensureWorktreeTerminals(w.path, roles)` with the default `isManual=false`, so it still hit the autoban cap. With `plannerCount > 5` (`extension.ts:2656` pushes one 'planner' role per planner), opening grid terminals in a worktree would trip the exact "worktree role terminal limit reached" toast this feature set out to eliminate. The plan's "All 5 call sites verified — no missed callers" assertion was incorrect.
  - **Fix:** Changed the call to `ensureWorktreeTerminals(w.path, roles, true, true)` (`reveal=true` preserves prior default behavior; `isManual=true` lifts the cap for this user-initiated path).

### Validation
- Compilation and automated tests SKIPPED per session directive.
- Static review: new 4-arg call matches the 4-param signature; no other `ensureWorktreeTerminals` callers exist in `src/` (grep-verified — only `extension.ts` + the 5 KanbanProvider sites + the definition).

### Remaining risks
- None material. All known manual/user-initiated callers now pass `isManual: true`; any future caller defaults to the capped (safe) behavior.
- Files changed by this review: `src/extension.ts` (6th caller now passes `isManual: true`).
