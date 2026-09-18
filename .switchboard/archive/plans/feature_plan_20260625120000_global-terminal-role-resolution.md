# Global Terminal Role Resolution — Decouple Dispatch from Kanban-Selected Workspace

## Goal

Make role-based terminal dispatch treat live agent terminals as a **global** resource: if the kanban-selected workspace has no terminal registered for the requested role, role resolution falls back to searching every other workspace's registry before failing. The kanban selector continues to govern plan-file destinations and prompt context — only terminal *resolution* becomes global.

### Problem

Role-based terminal dispatch (memo "Send to Planner", kanban column dispatch, autoban, pair-programming, sidebar dispatch) fails with "No agent assigned to role 'X'" whenever the kanban-selected workspace differs from the workspace where the agent terminals were created/registered.

### Background

The terminal registry is **per-workspace**: each workspace keeps its own `<workspaceRoot>/.switchboard/state.json` recording the `role` → terminal-name mapping (`planner`, `coder`, `lead`, `reviewer`, `intern`, etc.).

The dispatch chain resolves the target terminal **only from the kanban-selected workspace's** `state.json`:

1. `_resolveWorkspaceRoot()` delegates to the kanban provider's `getCurrentWorkspaceRoot()` as the single source of truth (`TaskViewerProvider.ts:1100-1120`).
2. Callers pass that root into `dispatchCustomPromptToRole` / `_resolveAgentTerminalForPlan` / `_getAgentNameForRole`.
3. `_getAgentNameForRole(role, workspaceRoot)` reads **only** `<passed-workspace>/.switchboard/state.json` (`TaskViewerProvider.ts:5919-5944`, via `_resolveStateFilePath` at `1164-1170`).
4. If the terminal was registered in a different workspace, that file has no entry for the role → returns `undefined` → the caller bails with "No agent assigned to role".

By contrast, the raw `sendToTerminal` handler (terminal grid, `/clear`) resolves against the **global in-memory** `_registeredTerminals` map and open VS Code terminals (`TaskViewerProvider.ts:9776-9808`) — it is workspace-agnostic and works fine. Only the **role-based** dispatch path is workspace-locked.

### Root cause

`_getAgentNameForRole` is the choke point: it searches exactly one workspace's `state.json` and gives up. Terminal identity (a live VS Code terminal with a registered role) is a global resource, but the resolver treats it as per-workspace-scoped. The kanban selector should control *where plan files are written* and *which workspace context the prompt carries* — not *which workspace's terminal registry may be searched*.

### Desired behavior

Terminal sends assume **global terminals**: role resolution searches all workspace registries (and the in-memory map) when the preferred workspace has no terminal for the role. The kanban-selected workspace remains the destination for plan files and prompt context.

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, refactor, reliability, ui

## User Review Required

Confirm the following decisions before implementation:

1. **Resolution order.** On a miss in the preferred (kanban-selected) workspace, fall back to the other workspace roots in `_getWorkspaceRoots()` (VS Code folder) order, first match wins. Accept that this order tracks the folder list and can shift if the user reorders workspace folders. (Recommended; matches existing `_filterMappedRoots`/`_getWorkspaceRoots` usage elsewhere.)
2. **Liveness preference in the global fallback (recommended hardening).** Should the global fallback prefer a candidate whose terminal name actually resolves to a *live* terminal (cross-checking `_registeredTerminals` + open VS Code terminals), so a stale/dead foreign `state.json` entry does not shadow a live one in a later root? The minimal fix (return first role match regardless of liveness) still fixes the reported bug; the hardening makes multi-workspace resolution robust. **Recommendation: include the liveness preference.** See Proposed Changes → Clarification.
3. **Stale entry in the *preferred* workspace.** Note that resolution is preferred-first and does NOT liveness-check the preferred workspace. If the kanban-selected workspace's `state.json` has a stale (closed-terminal) entry for the role, it still shadows a live foreign terminal and dispatch fails downstream with "Could not deliver prompt… terminal is not running" (pre-existing behavior, not a regression). Confirm this is acceptable for the initial fix.
4. **Plan-file destination unchanged.** Plan files and prompt context remain tied to the kanban-selected workspace (already confirmed — see Edge-Case audit item 5).

## Complexity Audit

### Routine
- The change is localized to one resolver method (`_getAgentNameForRole`) plus a thin global-fallback helper. No data migrations, no schema changes, no new UI.
- Reuses existing patterns only: `_getWorkspaceRoots()`, `_filterMappedRoots()` (L959), `_resolveStateFilePath()` (L1164), and the same `info.role` matching loop already in `_getAgentNameForRole` (L5928-5938).
- Low risk because every existing caller already treats "not found" as a failure — making the resolver search more broadly can only turn failures into successes, never the reverse.
- No changes to any call site signatures; the fix is inherited automatically through the single choke point.

### Complex / Risky
- **Same role registered in multiple workspaces** (e.g. two `planner` terminals in two workspaces). The deterministic resolution order below makes the choice predictable, but the result depends on workspace-folder order.
- **Liveness is not modeled by `state.json`.** A role entry can name a terminal that has since been closed. Without the optional liveness preference (User Review item 2), the global fallback may return a dead terminal's name and let delivery fail downstream rather than continuing the search.

## Edge-Case & Dependency Audit

### Race Conditions
- **Sequential async reads, no shared mutation.** The global helper reads at most N small JSON files sequentially with `await fs.promises.readFile`; it mutates no shared state, so there is no race with concurrent dispatches.
- **`_registeredTerminals` is cleared on workspace switch.** `clearRegisteredTerminalsMap()` (L501-507) empties the in-memory dispatch map when the kanban workspace changes. After a switch to workspace B, A's terminals may be absent from `_registeredTerminals`. Delivery therefore relies on the open-terminal fallback in `_attemptDirectTerminalPush` (L15385-15392), which matches `vscode.window.terminals` by normalized name and finds A's still-open terminal. This is the linchpin that makes the global fix work post-switch — it is a hard dependency of the fix, not an incidental detail.

### Security
- **Path traversal / agent-name validation is preserved downstream.** Names returned from foreign `state.json` files are still validated by `_isValidAgentName` before use as a path segment in `_dispatchExecuteMessage` (L15294) and `dispatchCustomPromptToRole` (L2642). `state.json` files are local/trusted. No new attack surface.

### Side Effects
- **Plan-file destination must NOT change.** `_buildMemoPlannerPrompt` uses the kanban-selected `workspaceRoot` for `plansDir` (L2686-2688). The fix is strictly about terminal resolution; the prompt's plan path stays tied to the kanban workspace. Confirmed by user decision.
- **No call-site changes.** All four `_resolveAgentTerminalForPlan` callers (L2637, L3327, L7195, L15592), both `dispatchCustomPromptToRole` callers (L9507 memo, L5230 askAgentTask), and the public `getAgentNameForRole` accessor (L7207) keep their signatures and behavior. They already treat `undefined` as failure; the resolver now just returns a result more often.
- **Kanban role badges unaffected.** Role badges derive from the workspace-agnostic `_terminalAgentInfo` map (see field comment at L497-499), not from `_getAgentNameForRole`, so broadening resolution does not change badge display.
- **No confirm dialogs.** Per project rules, no confirmation gates are added. The resolver simply searches more broadly; on total failure it still returns `undefined` and the existing caller error messages fire unchanged.

### Dependencies & Conflicts
1. **Same role registered in multiple workspaces.** Deterministic order: (a) the explicitly-passed/preferred workspace first, then (b) the other workspace roots in `_getWorkspaceRoots()` order, then (c) the in-memory `_registeredTerminals` map. First match wins. This preserves current behavior when the preferred workspace has the terminal, and only broadens the search on miss.
2. **Mapped child workspaces.** `_getWorkspaceRoots()` returns raw VS Code folders; some may be mapped children that should not host their own `.switchboard`. The fallback must use `_filterMappedRoots()` (L959) to avoid reading stray `state.json` files in mapped child folders, matching the existing filtering used elsewhere (L898, L938).
3. **`_registeredTerminals` has no role metadata.** The in-memory map is `Map<string, vscode.Terminal>` (name → terminal) with no role field, so it cannot directly satisfy role-based resolution. The global fallback must therefore search **other workspaces' `state.json`** files (which do carry `info.role`), not the in-memory map. The in-memory map is only useful as a last-resort name-existence / liveness check and is intentionally not used for role matching.
4. **Worktree-scoped terminals.** `_resolveAgentTerminalForPlan` already tries `_findTerminalNameByWorktreePathAndRole` before falling back to `_getAgentNameForRole` (L5946-5956). The worktree path match is already global (it scans `state.terminals` across the in-memory state, not a single file). The change only affects the final `_getAgentNameForRole` fallback, so worktree routing is unaffected.
5. **Callers that pass no workspaceRoot.** `_getAgentNameForRole('analyst')` (L15771) and `_getAgentNameForRole('coder')` (L17985) pass no root, so they already hit the `_resolveStateFilePath(undefined)` path which resolves via kanban. The global fallback improves these too — no regression.
6. **Performance.** The fallback only runs on a miss in the preferred workspace, and reads at most N small JSON files (N = workspace folder count, typically 1-3). No hot-path concern.

## Dependencies

- None known. This change is self-contained within `TaskViewerProvider.ts` and depends only on already-present helpers (`_getWorkspaceRoots`, `_filterMappedRoots`, `_resolveStateFilePath`). No cross-session (`sess_…`) dependencies.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) the global fallback may return a *dead* terminal name from a foreign `state.json`, deferring failure to the downstream "terminal not running" message instead of continuing the search; (2) a stale entry in the *preferred* workspace shadows a live foreign terminal (pre-existing, not a regression); (3) post-switch delivery depends entirely on `_attemptDirectTerminalPush`'s open-terminal fallback, since `_registeredTerminals` is cleared on workspace switch. Mitigations: add an optional liveness preference in the fallback (User Review item 2), document the preferred-workspace stale-entry limitation, and explicitly verify the post-switch open-terminal path in the verification plan. The core change can only convert prior failures into successes for the common case, so net risk is low.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

**Context.** `_getAgentNameForRole(role, workspaceRoot?)` (L5919-5944) is the single choke point for role-based terminal resolution. It currently reads exactly one workspace's `state.json` (via `_resolveStateFilePath`) and returns `undefined` on a miss. Every role-dispatch entry point funnels through it (directly or via `_resolveAgentTerminalForPlan`).

**Logic.** When the preferred-workspace lookup misses, search the other (non-mapped) workspace roots' `state.json` files for a terminal whose `info.role === role`, and return the first match. The kanban workspace is unchanged for everything else.

**Implementation.**

1. **Add a global role-resolution fallback helper** — new private method `_getAgentNameForRoleGlobal(role: string, alreadySearchedRoot?: string): Promise<string | undefined>`:
   - Iterate `this._filterMappedRoots(this._getWorkspaceRoots())`.
   - For each root, call `_resolveStateFilePath(root)`, read `state.json`, and return the first terminal name whose `info.role === role` — checking both `state.terminals` and `state.chatAgents`, mirroring `_getAgentNameForRole`'s existing logic at L5928-5938.
   - Skip the already-searched root to avoid a redundant re-read (see Clarification on how to compare correctly).
   - Return `undefined` if none found.

2. **Wire the fallback into `_getAgentNameForRole` (L5919-5944).** After the existing per-workspace search returns `undefined`, call `_getAgentNameForRoleGlobal(role, <already-searched-root>)` and return its result if non-undefined. Every caller (`askAgentTask`, batch dispatch, pair-programming, sidebar dispatch, memo, autoban) inherits the fix automatically.

3. **No changes to call sites.** All four `_resolveAgentTerminalForPlan` callers (L2637, L3327, L7195, L15592), both `dispatchCustomPromptToRole` callers (L9507 memo, L5230 askAgentTask), and the public `getAgentNameForRole` accessor (L7207) keep their signatures and behavior. They already treat `undefined` as failure; the resolver now just returns a result more often.

4. **No changes to plan-file paths or prompt construction.** `_buildMemoPlannerPrompt` (L2686), `_dispatchExecuteMessage`, and all plan-writing logic continue to use the kanban-selected `workspaceRoot`. Only terminal *resolution* becomes global.

**Clarification (recommended, not new scope).**

- **Correct "skip already-searched" comparison.** `_getAgentNameForRole` may be called with `workspaceRoot=undefined` (kanban-resolved) or a raw root that maps to a different effective root. Comparing raw roots to skip is unreliable. Compare the resolved *state file paths* (`_resolveStateFilePath(root)` vs the path the caller already searched), or simply omit the skip entirely — re-reading the preferred file is cheap and returns the same (no-match) result, so the skip is a pure optimization with no correctness impact.
- **Liveness preference (User Review item 2).** When multiple roots match the role, prefer a candidate whose name resolves to a *live* terminal — cross-check `_registeredTerminals` and `vscode.window.terminals` by normalized name (reuse the same matching used in `_attemptDirectTerminalPush`, L15367-15392, and `_focusTerminalByName`, L15315-15347). This prevents a dead foreign `state.json` entry from shadowing a live terminal in a later root. Falls back to the first role match if none of the candidates are live.

**Edge Cases (implementation-level).**

- Mapped child folders must be excluded via `_filterMappedRoots` (audit item 2).
- `state.chatAgents` matches are returned to mirror existing behavior, even though chat agents are not terminals (no regression vs. current resolver).
- Returned names are still validated by `_isValidAgentName` downstream before any path use.
- Post-workspace-switch, `_registeredTerminals` is cleared; delivery relies on the open-terminal fallback in `_attemptDirectTerminalPush` matching by normalized name (audit: Race Conditions).

## Verification Plan

### Manual / Behavioral

1. **Reproduce the bug first.** With two workspace folders open (A and B), create agent terminals in A, switch the kanban selector to B, open the Memo tab, enter an entry, and click "Send to Planner". Confirm it currently fails with "No agent assigned to role 'planner'".
2. **Apply the fix** and repeat step 1 — confirm the prompt is dispatched to the planner terminal in A and the plan-file path in the prompt points to B's `.switchboard/plans`.
3. **Same-workspace regression check.** With kanban on A (where terminals live), confirm memo Send-to-Planner, kanban column dispatch, and pair-programming dispatch still resolve the correct terminal (preferred-workspace-first order means no behavior change when the terminal is in the kanban workspace).
4. **Multi-workspace ambiguity.** Register a `planner` in both A and B; with kanban on B, confirm B's planner is chosen (preferred-first), not A's.
5. **Mapped-child safety.** With a mapped child workspace that has a stray `state.json`, confirm the fallback does not pick up terminals from the mapped child (uses `_filterMappedRoots`).
6. **Total-failure path.** With no planner registered anywhere, confirm the existing "No agent assigned to role 'planner'" error still fires (no silent success, no new confirm dialog).
7. **Post-switch delivery (open-terminal fallback).** After switching kanban to B (which clears `_registeredTerminals`), confirm the dispatch still reaches A's still-open planner terminal via the open-terminal fallback in `_attemptDirectTerminalPush` — i.e. no "Could not deliver prompt… terminal is not running" warning when A's terminal is alive.
8. **Stale-entry / liveness (if hardening adopted).** Register a `planner` in A (live) and leave a stale `planner` entry in another root C whose terminal is closed; with kanban on B, confirm resolution returns A's live planner rather than C's dead name.

### Automated Tests

- The verification above is primarily manual/behavioral (multi-root VS Code workspace + live terminals), which is the existing convention for this dispatch path. If unit coverage is added, target `_getAgentNameForRoleGlobal` in isolation: stub `_getWorkspaceRoots`/`_filterMappedRoots`/`_resolveStateFilePath` and fixture `state.json` contents to assert (a) preferred-first ordering, (b) mapped-child exclusion, (c) first role match across roots, and (d) liveness preference (if adopted).
- **Per session directive, automated tests and the compile step are NOT run as part of this planning pass** — the user runs the suite separately.

### Build (user-executed)

- `npm run compile` (webpack build, no type errors). Run by the user after implementation; not executed during this planning pass per the skip-compilation directive.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

## Reviewer Pass (2026-06-26)

### Implementation Status: COMPLETE

Changes landed in commit `239a82d` ("many fixes" — bundled with several other plans). The changes specific to THIS plan are isolated to three methods in `src/services/TaskViewerProvider.ts`:

| Method | Lines | Change |
|--------|-------|--------|
| `_isTerminalLive` | L5955-5983 | **New.** Liveness check via `_registeredTerminals` (exact → suffixed → normalized-key fallback) + `vscode.window.terminals` open-terminal match. |
| `_getAgentNameForRoleGlobal` | L5985-6033 | **New.** Iterates `_filterMappedRoots(_getWorkspaceRoots())`, reads each root's `state.json`, collects first role match per root (terminals then chatAgents), applies liveness preference, returns first candidate if none live. |
| `_getAgentNameForRole` | L6035-6073 | **Refactored.** Preferred-workspace lookup preserved as-is; on miss, delegates to `_getAgentNameForRoleGlobal(role, statePath)`. |

No other files modified for this plan. All call sites (`_resolveAgentTerminalForPlan` L6084, `getAgentNameForRole` L7337, `askAgentTask` L5260, L15911, L18125) inherit the fix through the single choke point with no signature changes.

### Stage 1 — Grumpy Principal Engineer Review

*"Let me get my coffee and squint at this..."*

**NIT-1 — Sixth copy of the find-terminal-by-name dance.** `_isTerminalLive` (L5955-5983) is the SIXTH near-identical "look up a terminal by name with exact → suffixed → normalized-key fallback" loop in this file (cf. L9910, L14955, L15449, L15496, L15949). I get it — the plan said "reuse the matching from `_attemptDirectTerminalPush`," and you did, by copy-pasting it. But at some point someone is going to fix a bug in one of these six copies and not the other five, and we'll be back here. Extract a `_findLiveTerminalByName(name): vscode.Terminal | undefined` helper and call it from all six sites. NOT blocking — the logic is correct — but the tech debt odometer just rolled over.

**NIT-2 — Sync `existsSync` inside an async loop.** L5994 uses `fs.existsSync` (synchronous stat) before `fs.promises.readFile` (async) in the global fallback loop. For N=1-3 workspace folders this is invisible. A purist would wrap the readFile in try/catch and drop the existsSync entirely — the readFile already throws ENOENT on a missing file, which the catch block handles. Cosmetic. Not blocking.

**NIT-3 — Silent catch blocks.** L6017 and L6063 swallow all errors with `// ignore and continue`. A corrupt `state.json` in workspace C is silently skipped with zero telemetry. The original code did the same, so this is consistent — but if a user reports "my planner terminal isn't found" and one of their `state.json` files has a syntax error, there is literally no log line to point at. Consider a `console.warn` in the catch. Not blocking; consistent with existing style.

**Non-issue — `dispatchCustomPromptToRole` was modified by a sibling plan.** The plan states "no changes to call sites," and the commit DID modify `dispatchCustomPromptToRole` (L5267-5276) to add planner rotation. BUT that modification is from the `planner-rotation-all-dispatch-paths` plan bundled in the same commit, not this plan. The signature `(role, prompt, workspaceRoot) => Promise<boolean>` is preserved, and the global fallback remains reachable as the final fallback after rotation misses. No conflict with this plan's requirements. Noted for completeness.

**Verdict on correctness:** The resolution order (preferred → other filtered roots → liveness preference → first candidate) exactly matches the plan's Dependencies item 1 and the liveness hardening from User Review item 2. The `skipStatePath` comparison uses resolved state-file paths (per the plan's Clarification), not raw roots — correct. Mapped children are excluded via `_filterMappedRoots` — correct. `state.chatAgents` is mirrored — correct. The preferred workspace is NOT liveness-checked (pre-existing behavior, User Review item 3) — correct. No confirm dialogs added — correct. I found **zero CRITICAL or MAJOR findings.** The implementation is faithful to the plan.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Action |
|---------|----------|--------|
| NIT-1: Duplicated terminal-lookup pattern (6th copy) | NIT | **Defer.** Extracting a shared helper is a worthwhile refactor but out of scope for this bugfix. File a tech-debt note. |
| NIT-2: Sync `existsSync` in async loop | NIT | **Defer.** Invisible at N=1-3. Could simplify to try/catch-only in a future pass. |
| NIT-3: Silent catch blocks | NIT | **Defer.** Consistent with existing codebase style. A `console.warn` would help debuggability but is not required. |

**No code fixes applied.** All findings are NITs with no material impact on correctness, safety, or the plan's stated requirements. The implementation satisfies every Proposed Changes item and every Edge-Case audit item.

### Verification Results

| Check | Result |
|-------|--------|
| Plan requirement: global fallback helper added | ✅ `_getAgentNameForRoleGlobal` L5985-6033 |
| Plan requirement: wired into `_getAgentNameForRole` choke point | ✅ L6072 |
| Plan requirement: `_filterMappedRoots` excludes mapped children | ✅ L5986 |
| Plan requirement: `state.chatAgents` mirrored | ✅ L6009-6016 |
| Plan requirement: liveness preference (User Review item 2) | ✅ L6024-6032 |
| Plan requirement: skip already-searched root via state-path comparison | ✅ L5991 |
| Plan requirement: no call-site signature changes | ✅ All callers unchanged |
| Plan requirement: no plan-file path changes | ✅ Only terminal resolution broadened |
| Plan requirement: no confirm dialogs | ✅ None added |
| Type safety: `skipStatePath` accepts `string \| null` from `_resolveStateFilePath` | ✅ Signature `string \| null \| undefined` |
| `_isTerminalLive` handles `_registeredTerminals === undefined` | ✅ L5956 guard |
| `_isTerminalLive` falls back to `vscode.window.terminals` post-switch | ✅ L5974-5982 |
| Compilation (`npm run compile`) | ⏭️ Skipped per session directive — user to run |
| Automated tests | ⏭️ Skipped per session directive — user to run |
| Manual behavioral tests (Verification Plan steps 1-8) | ⏭️ Pending user execution in multi-root workspace |

### Files Changed (this plan)

- `src/services/TaskViewerProvider.ts` — L5955-6073 (3 methods: `_isTerminalLive` new, `_getAgentNameForRoleGlobal` new, `_getAgentNameForRole` refactored)

### Remaining Risks

1. **Preferred-workspace stale entry** (documented, User Review item 3): if the kanban-selected workspace's `state.json` has a stale (closed-terminal) role entry, it shadows live foreign terminals and dispatch fails downstream with "terminal is not running." Pre-existing behavior, not a regression. A future hardening could liveness-check the preferred workspace too, but that would change current same-workspace semantics.
2. **Tech debt: 6 duplicated terminal-lookup-by-name loops** (NIT-1). A bug fix in one copy won't propagate to the other five.
3. **No automated test coverage** for `_getAgentNameForRoleGlobal`. The plan's Verification Plan item notes unit tests are optional; the dispatch path is conventionally tested manually. If added, stub `_getWorkspaceRoots`/`_filterMappedRoots`/`_resolveStateFilePath` and fixture `state.json` contents.
4. **Manual verification steps 1-8 not yet executed** — require a multi-root VS Code workspace with live terminals, which is outside this review session's scope.
