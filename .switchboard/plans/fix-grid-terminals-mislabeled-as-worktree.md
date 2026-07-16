# Fix Grid Terminals Mislabeled as "worktree" When No Worktrees Exist

## Goal

Agent rows in the Implementation tab (and Kanban tab) display `CODER - DEVIN CLI - worktree` even when the user has zero worktrees on disk and in the DB. The label persists across IDE/extension restarts. This plan fixes the root cause and cleans up stale state.

### Problem

When the user clicks **OPEN AGENT TERMINALS** (the grid terminal creation flow in `extension.ts`), every terminal is registered into `state.json` with `worktreePath` set to the **workspace root** — not a real worktree path. The webview then sees a truthy `worktreePath` on these terminals, prefers them in `findTerminalByRole`, and appends the ` - worktree` label.

### Background

The `worktreePath` field on a terminal state entry is meant to identify terminals that were spawned inside a git worktree (a separate working directory linked to the main repo). The webview uses this field to:
1. Prefer worktree terminals over main-workspace terminals in role resolution (`findTerminalByRole`).
2. Append a ` - worktree` visual label to the agent row name.

When `worktreePath` is set to the workspace root itself, both behaviors fire incorrectly — the terminal is neither in a worktree nor distinct from the main workspace.

### Root Cause

**`src/extension.ts` line 3024** — the grid terminal batch registration unconditionally sets `worktreePath` to `effectiveCwd`, which defaults to `effectiveWorkspaceRoot`:

```ts
let effectiveCwd = effectiveWorkspaceRoot;          // line 2826
if (options?.cwdOverride) {                          // line 2827
    if (fs.existsSync(options.cwdOverride)) {
        effectiveCwd = options.cwdOverride;
    } else {
        vscode.window.showWarningMessage(`cwdOverride path does not exist: ${options.cwdOverride}. Using workspace root.`);
    }
}
// ...
batchRegistrations.push({
    ...
    worktreePath: effectiveCwd                       // line 3024 — BUG
});
```

The `cwdOverride` path (the only way `effectiveCwd` differs from the workspace root) is the legitimate worktree-terminal case. The default case sets `worktreePath` to the workspace root, which is not a worktree.

**Contrast:** The autoban terminal creator (`TaskViewerProvider._createAutobanTerminal`, `src/services/TaskViewerProvider.ts` line 8146) does this correctly:
```ts
worktreePath: cwd || undefined   // only set when a real cwd is passed
```

### Why It Returns After Restarts

> **Superseded:** "It is not stale state from old worktrees — it re-triggers every time the user opens agent terminals. The `clearGridBlockers` cleanup (line 2977-2989) deletes old entries on restart, but the next OPEN AGENT TERMINALS action re-registers them with `worktreePath = workspace root`, so the label returns."
>
> **Reason:** The original narrative conflated two separate mechanisms and mislocated the restart cleanup. (a) `clearGridBlockers` (defined at `extension.ts:2930`, called at `:3000`) does NOT run on restart — it runs on every OPEN AGENT TERMINALS click, and it deletes `state.terminals` entries whose `ideName` matches the current IDE (`:2977-2996`). (b) The actual restart cleanup is `taskViewerProvider.deregisterAllTerminals(true)`, invoked at extension activation (`extension.ts:916`) and which wipes `state.terminals = {}` (`TaskViewerProvider.ts:17682`). Because of that wipe, bogus `worktreePath` entries do NOT survive a restart — `state.json` is empty after every activation until the user clicks OPEN AGENT TERMINALS again.
>
> **Replaced with:** Stale `worktreePath` entries do not persist across restarts: `deregisterAllTerminals(true)` runs at activation (`extension.ts:916`) and clears `state.terminals = {}` (`TaskViewerProvider.ts:17682`). The bug "survives restarts" only in the sense that the *defect* re-triggers on the next OPEN AGENT TERMINALS: `clearGridBlockers` (`extension.ts:2930`, called at `:3000`) deletes the current-IDE entries, then the batch registration at `:3024` re-adds them with `worktreePath = effectiveWorkspaceRoot`. So the label reappears after the first post-restart OPEN AGENT TERMINALS, not because stale state persisted.

## Metadata
- **Complexity:** 4
- **Tags:** bugfix, ui, backend

## User Review Required

Yes. This review corrects two conclusions in the original plan and adds a **required companion fix** that the original plan omitted. The companion fix prevents a regression in the worktree+main-repo coexistence flow (see *Adversarial Synthesis* and *Proposed Changes → src/extension.ts (companion)*). Reviewer must confirm the `mainRepoTerminalNames` identification change is the right criterion before coding.

## Complexity Audit

### Routine
- Single-line fix at `extension.ts:3024` — mirrors the existing `worktreePath: cwd || undefined` pattern already used by `_createAutobanTerminal` (`TaskViewerProvider.ts:8146`).
- No webview changes: `implementation.html` (`findTerminalByRole` `:2738-2749`, label `:2813-2835`) and `kanban.html` (`findTerminalByRole` `:5538-5547`) only label/ prefer on truthy `worktreePath`; once the backend stops setting it, the label disappears automatically.
- Batch-registration write at `extension.ts:3048` (`if (reg.worktreePath) state.terminals[reg.name].worktreePath = reg.worktreePath;`) is already guarded by a truthy check, so writing `undefined` is a no-op — no change needed there.

### Complex / Risky
- **Companion fix to `mainRepoTerminalNames` (`extension.ts:2895-2913`) is load-bearing.** When worktrees exist (`gridWorktrees.length > 0`), this block identifies main-repo terminals by `termWtPath === path.resolve(effectiveCwd)`. Post-fix, main-repo terminals have NO `worktreePath`, so `termWtPath = ''` and the set stays empty — causing `matchesGridAgentName` (`:2912-2929`) to fall back to "match any terminal with this agent name", which includes worktree terminals. That breaks `clearGridBlockers` duplicate disposal (`:2959-2975`) and the terminal-reuse lookup (`:3005`). This is a subtle interaction the original plan did not consider.
- The fix touches terminal routing/disposal logic that runs only when worktrees coexist with main-repo terminals — a path that is hard to exercise without a real worktree, so a regression could land unnoticed.

## Edge-Case & Dependency Audit

- **Race Conditions:** `clearGridBlockers` runs before batch registration within the same OPEN AGENT TERMINALS flow; the companion fix only changes the *criterion* used to build `mainRepoTerminalNames`, not the timing. No new race introduced.
- **Security:** No security surface — `worktreePath` is a local filesystem path already stored in `state.json`; the fix only stops over-populating it.
- **Side Effects:**
  - Side effect of the line-3024 fix: main-repo terminals no longer carry `worktreePath`, so `findTerminalByRole` in both webviews will stop preferring them as "worktree" terminals — intended.
  - Side effect of the companion fix: `mainRepoTerminalNames` now also includes terminals with no `worktreePath` (the post-fix main-repo case) — restores the pre-fix routing/disposal scoping.
- **Dependencies & Conflicts:**
  - `deregisterAllTerminals(true)` at activation (`extension.ts:916`) wipes `state.terminals` on every restart, so no migration of stale entries is required (see *Superseded* above).
  - Other `worktreePath` consumers in `TaskViewerProvider.ts` (`:7457-7473`, `:8850-8945`) all guard with `info.worktreePath && path.resolve(info.worktreePath) === resolvedTarget` — a missing `worktreePath` simply does not match a worktree-path query, which is correct. No regression there.
  - `agentPromptBuilder.ts:84` and the `allSameWorktree` checks (`TaskViewerProvider.ts:4622`, `KanbanProvider.ts:5144`) operate on plan `worktreePath`, not terminal state — unrelated.

## Dependencies

- None. Single-file change to `src/extension.ts`. No other plan or session dependency.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the original plan's activation cleanup is redundant — `deregisterAllTerminals` already wipes `state.terminals` at activation, so adding a second cleanup is dead code; (2) the original plan's "no other changes required" claim is false — the `mainRepoTerminalNames` block (`extension.ts:2895-2913`) identifies main-repo terminals by `worktreePath === effectiveCwd`, which breaks once main-repo terminals no longer carry `worktreePath`, causing `clearGridBlockers` and the terminal-reuse lookup to match worktree terminals as if they were main-repo. Mitigations: drop the redundant activation cleanup; add the companion one-line criterion change (`!termWtPath || termWtPath === path.resolve(effectiveCwd)`) so main-repo identification works both pre- and post-fix.

## Proposed Changes

### src/extension.ts — Line 3024 (the root-cause fix)

**Context:** Grid terminal batch registration unconditionally writes `worktreePath: effectiveCwd`, and `effectiveCwd` defaults to `effectiveWorkspaceRoot` (the workspace root), so every main-repo grid terminal is mislabeled as a worktree terminal.

**Logic:** Only set `worktreePath` when `effectiveCwd` is an actual override (a real worktree path distinct from the workspace root). This mirrors `_createAutobanTerminal`'s `worktreePath: cwd || undefined` pattern (`TaskViewerProvider.ts:8146`).

**Implementation:**
```ts
worktreePath: effectiveCwd !== effectiveWorkspaceRoot ? effectiveCwd : undefined
```

**Edge Cases:**
- If a caller passes `cwdOverride` equal to the workspace root itself, `effectiveCwd === effectiveWorkspaceRoot` → `worktreePath: undefined`. Correct — the workspace root is not a worktree.
- The downstream write at `:3048` (`if (reg.worktreePath) ...`) is truthy-guarded, so `undefined` is a no-op. No change needed there.

### src/extension.ts — Lines 2895-2913 (the REQUIRED companion fix)

**Context:** When worktrees exist (`gridWorktrees.length > 0`), this block builds `mainRepoTerminalNames` to scope `matchesGridAgentName` (`:2912-2929`) to main-repo terminals only. Pre-fix, main-repo terminals carried `worktreePath = effectiveWorkspaceRoot = effectiveCwd`, so the criterion `termWtPath === path.resolve(effectiveCwd)` identified them. Post-fix, main-repo terminals have NO `worktreePath`, so `termWtPath = ''` and the set stays empty — `matchesGridAgentName` then falls back to matching ANY terminal with the agent name, including worktree terminals. That breaks:
- `clearGridBlockers` duplicate disposal (`:2959-2975`): could dispose a worktree terminal as a "duplicate" of the main-repo terminal (or vice versa).
- Terminal-reuse lookup (`:3005`): could reuse a worktree terminal as the main-repo terminal.

**Logic:** A terminal is main-repo if it has no `worktreePath` (the post-fix main-repo case) OR its `worktreePath` resolves to the workspace root (the transitional/pre-fix case, harmless to keep). This keeps the identification correct both before and after the line-3024 fix lands.

**Implementation** (change the condition inside the `for` loop at `:2901-2902`):
```ts
const termWtPath = entry.worktreePath ? path.resolve(entry.worktreePath) : '';
if (!termWtPath || termWtPath === path.resolve(effectiveCwd)) {
    mainRepoTerminalNames.add(name);
    mainRepoTerminalNames.add(entry.friendlyName || name);
}
```

**Edge Cases:**
- `effectiveCwd` in this branch equals `effectiveWorkspaceRoot` (the main-repo cwd; the `cwdOverride` path is the worktree-routing case). So `path.resolve(effectiveCwd)` is the workspace root — the right reference for "main repo".
- A genuine worktree terminal has `worktreePath` = the worktree path (≠ workspace root), so it is excluded from `mainRepoTerminalNames` — intended.
- The `catch` fallback at `:2914-2916` ("Fall back to name-only matching") is unchanged and still safe.

### Activation cleanup pass — DROPPED (Superseded)

> **Superseded:** Original Implementation Step 2 — "Add a one-time cleanup pass in the extension activation path (or in `TaskViewerProvider` initialization) that iterates `state.terminals` and clears `worktreePath` on any entry where `path.resolve(worktreePath) === path.resolve(workspaceRoot)`."
>
> **Reason:** Redundant. Extension activation already calls `taskViewerProvider.deregisterAllTerminals(true)` (`extension.ts:916`), which wipes `state.terminals = {}` (`TaskViewerProvider.ts:17682`). After that wipe there are no entries to clean. Running a second cleanup on every activation is dead code. Additionally, `state.json` is per-workspace (`_resolveStateFilePath` → `<stateWorkspaceRoot>/.switchboard/state.json`), and `updateState` writes only to the currently-selected workspace's `state.json` (`_processUpdateQueue` uses `this._resolveWorkspaceRoot()`), so a single-root activation cleanup would not cover other workspaces' state files anyway — but that gap is moot because `deregisterAllTerminals` already empties the active workspace's `state.terminals`, and the line-3024 fix ensures the next OPEN AGENT TERMINALS in any workspace registers cleanly.
>
> **Replaced with:** No activation cleanup. The line-3024 fix plus the `mainRepoTerminalNames` companion fix are sufficient. Convergence is automatic: (a) on restart — `deregisterAllTerminals` wipes `state.terminals`, then the next OPEN AGENT TERMINALS registers with `worktreePath: undefined`; (b) mid-session — the next OPEN AGENT TERMINALS runs `clearGridBlockers` (deletes current-IDE entries) then re-registers cleanly.

### Webview — No changes required

The webview logic in `implementation.html` (`findTerminalByRole` `:2738-2749`; `isWtTerm`/`wtSegment` label `:2813-2835`) and `kanban.html` (`findTerminalByRole` `:5538-5547`) is correct — it only labels/prefers a terminal as `worktree` when `worktreePath` is truthy. Once the backend stops setting `worktreePath` on non-worktree terminals, the label disappears and the role-resolution preference stops firing — automatically.

## Verification Plan

> Per session directive: SKIP COMPILATION (do not run any project compilation step) and SKIP automated tests. Verification is manual/static only.

### Automated Tests
- Skipped per session directive.

### Manual Verification
1. **Reproduce the bug first (pre-fix):** Open agent terminals in a workspace with no worktrees. Confirm the Agents tab shows the ` - worktree` suffix on every agent row.
2. **Apply both edits** (line 3024 root-cause fix AND the `mainRepoTerminalNames` companion fix at 2895-2913).
3. **Restart the extension/IDE.** Confirm `deregisterAllTerminals` runs and `state.json` `terminals` is empty after activation.
4. **Open agent terminals again (no worktrees).** Confirm:
   - No agent row shows the ` - worktree` suffix.
   - `state.json` terminal entries have no `worktreePath` field (or it is `undefined`).
5. **Worktree + main-repo coexistence (the regression path):** Create a real worktree (via the Worktrees tab or kanban dispatch to a worktree-routed plan). With `suppressMain` OFF, open agent terminals so both main-repo and worktree terminals exist for the same role. Confirm:
   - The worktree-routed terminal shows the ` - worktree` suffix; main-repo terminals do **not**.
   - `clearGridBlockers` does NOT dispose the worktree terminal as a "duplicate" of the main-repo terminal (this is what the companion fix protects).
   - The terminal-reuse lookup (`:3005`) reuses the main-repo terminal for the main-repo slot, not the worktree terminal.
6. **Abandon the worktree.** Confirm `closeWorktreeTerminals` disposes the worktree terminal and the label disappears.
7. **Static check:** Confirm no activation cleanup pass was added (it was dropped as redundant) and that `deregisterAllTerminals(true)` at `extension.ts:916` is the sole restart-time `state.terminals` reset.

## Risks & Edge Cases

- **Multi-workspace setups:** `state.json` is per-workspace (`<stateWorkspaceRoot>/.switchboard/state.json`), and `updateState` writes only to the currently-selected workspace's file. The line-3024 fix is per-OPEN-AGENTS-click (uses the selected workspace's `effectiveWorkspaceRoot`), so each workspace converges on its next OPEN AGENT TERMINALS. No cross-workspace migration is needed because `deregisterAllTerminals` wipes each workspace's `state.terminals` on activation. (Original plan's claim about "child workspace whose `worktreePath` resolves to the effective parent root" was imprecise — the operative unit is the per-workspace `state.json`, not parent-vs-child root resolution.)
- **Pair-programming / IDE-CLI modes:** These flows use `_createAutobanTerminal` (`TaskViewerProvider.ts:8065`), which already sets `worktreePath: cwd || undefined` (`:8146`) correctly. No change needed there.
- **Existing live terminals:** Neither edit disposes or recreates terminals. The line-3024 edit only changes what gets *registered*; the companion edit only changes the *criterion* for building a name set used during OPEN AGENT TERMINALS. Live terminals keep running; labels update on the next `terminalStatuses` post / next OPEN AGENT TERMINALS.

## Recommendation

Complexity 4 → **Send to Coder** (per skill: 4-6 → Coder). The change is single-file and routine, but the `mainRepoTerminalNames` companion fix is subtle and load-bearing for the worktree+main coexistence path — a Coder should implement and manually exercise the worktree coexistence scenario (Verification step 5) before considering it done.

## Completion Report

Implemented the two edits in `src/extension.ts`: line 3024 now sets `worktreePath` only when `effectiveCwd` is not the workspace root (`effectiveCwd !== effectiveWorkspaceRoot ? effectiveCwd : undefined`), and the `mainRepoTerminalNames` loop at lines 2895-2913 now treats a terminal as main-repo when it has no `worktreePath` (`!termWtPath`) or its `worktreePath` resolves to `effectiveCwd`. No activation cleanup was added, since `deregisterAllTerminals(true)` already clears `state.terminals` on activation. No webview changes were needed. Static verification confirmed the target snippets; compilation and automated tests were skipped per the session directive.
