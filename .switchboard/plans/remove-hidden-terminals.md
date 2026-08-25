# Remove Hidden Terminals

## Goal

The `hidden` terminal mechanism is dead code. It was built for an "unattended batch improver" dispatch path that was never connected — `getUnattendedPlannerTerminal()` has zero callers, and `getUnattendedImproverTerminals()` has zero callers. No code ever passes `hidden: true` from a live dispatch path. The `ptyCreateBatch` verb that accepts `hidden` is agent-only (never called from the webview) and no agent in the codebase calls it with `hidden: true`. The entire mechanism adds complexity, splits the terminal list into two projections, and confuses the terminal architecture. Remove it entirely.

## Background & Root Cause

The hidden terminal feature was designed so that a planner agent could spawn a fleet of "unattended improver" terminals via `ptyCreateBatch` with `hidden: true`. These hidden terminals would:
1. Be excluded from the `terminals` array in `ptyListTerminals` (projected into a sibling `hiddenTerminals` array instead)
2. Be excluded from the autoban dispatch pool (`_getAliveAutobanTerminalRegistry` drops `info.hidden === true`)
3. Be excluded from `_ptyTerminalNames` (the `/kanban/dispatch` live-terminal pre-flight)
4. Be selectable only via `getUnattendedPlannerTerminal()` / `getUnattendedImproverTerminals()`

But step 4 was never wired up. `getUnattendedPlannerTerminal()` is `public` on `TaskViewerProvider` but has zero callers anywhere in the codebase. The batch dispatch path (`handleBatchDispatchLow`, `handleKanbanBatchTrigger`) dispatches to **visible** terminals through the normal `triggerAgentFromKanban` path. The `unattended` flag that IS used only modifies prompt text ("Never ask questions in chat") — it does not route to hidden terminals.

The `ptyCreateBatch` verb itself IS still used (it's the batch terminal creation API), but the `hidden` parameter on it serves no purpose. No caller in the codebase passes `hidden: true` through any live path.

## Metadata

**Tags:** refactor
**Complexity:** 5
**Project:** Browser Switchboard

## User Review Required

- **[user]** The `hidden` terminal mechanism is being removed entirely based on zero-caller analysis. If there is any external automation script (outside this repo) that calls `ptyCreateBatch` over HTTP with `hidden: true`, those scripts will silently stop getting hidden behavior (terminals will be visible). Proceeding on the assumption that no external caller relies on this, since the feature was never documented and the selector methods were never wired.

## Complexity Audit

### Routine
- Removing `hidden?: boolean` from three TypeScript interfaces (`FleetTerminalInfo`, `ExtendedTerminalHandle`, `CreateOptions`)
- Removing `hidden: opts?.hidden === true` from the `create()` method
- Removing `hidden: t.hidden === true` from `updateRegistryState`
- Removing `hidden` from `createBatch()` signature, return type, and internal `created.push()`
- Removing `hidden: payload.hidden === true` from verb handlers in `ptyHost.ts` and `bootstrap.ts`
- Removing `hidden: terminal.hidden === true` / `hidden: t.hidden === true` from return objects
- Removing the `hiddenTerminals` sibling key from all three `ptyListTerminals` implementations
- Removing `_ptyHiddenTerminalNames` field and all its assignments
- Removing `getUnattendedImproverTerminals()` and `getUnattendedPlannerTerminal()` methods
- Removing `if (info.hidden === true) { continue; }` from `_getAliveAutobanTerminalRegistry`
- Removing redundant `.filter(([, info]) => !info?.hidden)` from two autoban selection methods
- Removing `hiddenTerminals` from `listFleetTerminals`, `liveTerminals` callback, `liveDelegateCount` callbacks
- Removing `hiddenTerminals` from LocalApiServer delegate count and relay validation
- Updating comments that reference hidden terminals
- Removing hidden-fleet tests, keeping unattended-prompt-contract tests

### Complex / Risky
- The `ptyListTerminals` response shape changes: `hiddenTerminals` key is removed. Any consumer reading `result.hiddenTerminals` will get `undefined` instead of an array. All consumers are identified and updated in this plan, but a missed consumer would silently get an empty union instead of an error (since most use `Array.isArray(x) ? x : []` guards).
- The mirror registry in TaskViewerProvider.ts (lines 3310-3334) splits terminals into visible/hidden rows with a `hidden` stamp. Removing this split changes the registry shape — the `hidden` field disappears from `runtime.terminals` entries. Any downstream reader of `runtime.terminals` that checks `.hidden` (lines 11047, 11108, 11154) must be removed in the same pass or it filters on a field that no longer exists (a no-op, but dead code).

## Edge-Case & Dependency Audit

**Race Conditions:** None. The removal is synchronous within each file. The `ptyListTerminals` response shape change is consumed by the extension host's poll loop, which runs on a timer — the next poll after deployment picks up the new shape. No migration needed since `hiddenTerminals` was never persisted to disk (it was a per-response projection).

**Security:** No security implications. The `hidden` field was never a security boundary — it was a UI/dispatch projection. Removing it does not expose any terminal to unauthorized access.

**Side Effects:** The `runtime.terminals` registry entries will no longer carry a `hidden` field. Existing entries in the DB from before the removal may still have `hidden: false` stamped — these are harmless (the field is simply ignored by all readers after the removal). No migration is needed because the field was always `false` for live terminals (no live path ever set `hidden: true`).

**Dependencies & Conflicts:** The `unattended` flag on batch dispatch prompts is SEPARATE from the `hidden` terminal mechanism. The `unattended` flag modifies prompt text only ("Never ask questions in chat", `## Outstanding Questions`). It must NOT be removed. The test file `unattended-batch-improvement-contract.test.js` has two subtasks: Subtask 1 (hidden fleet — REMOVE) and Subtask 2 (unattended prompt contract — KEEP). The `ptyCreateBatch` verb itself stays — only the `hidden` parameter is removed.

## Dependencies

None. This is a self-contained dead-code removal with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) missed `.hidden` references in the autoban selection path (lines 11108, 11154) that survive removal and fail grep verification; (2) missed `_ptyHiddenTerminalNames` reset in the dispose path (line 24969); (3) stale `hiddenTerminals` references in cache-pruning conditions and comments (lines 853, 973). Mitigations: all identified references are enumerated per-file in Proposed Changes with exact line numbers; grep verification covers both `hidden` and `hiddenTerminals` separately.

## Proposed Changes

### `src/standalone/ptyFleetService.ts`

**Context:** The fleet service owns the `hidden` field on terminal handles and the `CreateOptions` interface. It also stamps `hidden` into the `runtime.terminals` registry via `updateRegistryState`.

**Logic:**
- Remove `hidden?: boolean` from the `FleetTerminalInfo` interface (line 60)
- Remove `hidden?: boolean` from the `ExtendedTerminalHandle` interface (line 79)
- Remove `hidden?: boolean` from the `CreateOptions` interface (line 115)
- Remove the comment on `CreateOptions.hidden` (line 114)
- Remove `hidden: opts?.hidden === true` from the `create()` method (line 445)
- Remove `hidden: t.hidden === true` from `updateRegistryState` (line 923). Note: line 929 has `} satisfies FleetTerminalInfo;` — removing `hidden` from both the interface and the object literal keeps the `satisfies` clause valid.
- Remove the `hidden: boolean` parameter from `createBatch()` signature (line 792)
- Remove `hidden: boolean` from the `createBatch` return type — the `created` array type (line 796)
- Remove `hidden: boolean` from the local `created` array type (line 798)
- Remove `hidden: t.hidden === true` from `created.push()` inside `createBatch` (line 833)
- Remove the `hidden` argument from the `create()` call inside `createBatch` (line 832 — change `{ hidden, claudeInlineRendering }` to `{ claudeInlineRendering }`)

**Edge Cases:** The `createBatch` method passes `hidden` as a positional argument to `create()` via the `opts` object. After removing the `hidden` parameter from `createBatch`, the `opts` object passed to `create()` must not include `hidden`. The `CreateOptions` interface no longer has `hidden`, so TypeScript will flag any leftover reference.

### `src/standalone/ptyHost.ts`

**Context:** The pty host child process handles PTY verbs over HTTP. It projects hidden terminals into a sibling `hiddenTerminals` key in `ptyListTerminals`.

**Logic:**
- Remove `hidden: payload.hidden === true` from the `ptyCreateTerminal` handler (line 89)
- Remove `hidden: terminal.hidden === true` from the `ptyCreateTerminal` return (line 115)
- Remove `payload.hidden === true` from the `ptyCreateBatch` handler (line 129)
- Remove the comment block about hidden terminals riding a sibling key (lines 150-152)
- Remove `hiddenTerminals: project(all.filter(t => t.hidden))` from the `ptyListTerminals` return (line 174)
- Change `terminals: project(all.filter(t => !t.hidden))` to `terminals: project(all)` (line 173) — all terminals go into `terminals` now, no filtering

**Edge Cases:** The `project` function (lines 154-170) is unchanged — it maps terminal handles to plain objects. After removal, every terminal appears in `terminals`. No consumer should expect `hiddenTerminals` in the response.

### `src/standalone/bootstrap.ts`

**Context:** The standalone host's in-process PTY verb handler. Mirrors the ptyHost.ts handler but with additional plan-attribution and parent-resolution logic.

**Logic:**
- Remove `hidden: payload.hidden === true` from `ptyCreateTerminal` (line 1536)
- Remove `hidden: terminal.hidden === true` from the `ptyCreateTerminal` return (line 1572)
- Remove `hidden: t.hidden === true` from the delegates return (line 1572 — same line, separate occurrence in the `delegates: spawned.children.map(...)` expression)
- Remove `payload.hidden === true` from `ptyCreateBatch` (line 1578)
- Remove `const visible = all.filter(t => !t.hidden)` (line 1602) — use `all` directly
- Remove `const hidden = all.filter(t => t.hidden)` (line 1603)
- Remove `hiddenTerminals: projectTerminals(hidden)` from the `ptyListTerminals` return (line 1662)
- Change `const liveTerminals = projectTerminals(visible)` to `const liveTerminals = projectTerminals(all)` (line 1616)

**Edge Cases:** The `projectTerminals` function (lines 1604-1615) is unchanged. The `rawTerminals` variable (line 1627) currently aliases `liveTerminals` — after the change it still works since `liveTerminals` now projects `all`.

### `src/services/TaskViewerProvider.ts`

**Context:** The extension host's PTY verb wrapper. It enriches `ptyListTerminals` responses, mirrors the fleet into `runtime.terminals`, and uses `hiddenTerminals` for role resolution, cache pruning, and autoban terminal selection.

**Logic:**

*Fields and methods:*
- Remove `_ptyHiddenTerminalNames` field (line 1404) and its comment (line 1403)
- Remove `_unattendedPlannerCursor` field (line 1405)
- Remove `getUnattendedImproverTerminals()` method (lines 7814-7818) and its comment block (lines 7800-7813)
- Remove `getUnattendedPlannerTerminal()` method (lines 7822-7828) and its comment (line 7821)

*Host-disconnect and dispose resets:*
- Remove `this._ptyHiddenTerminalNames = []` from the host-disconnect reset (line 3255)
- Remove `this._ptyHiddenTerminalNames = []` from the dispose path (line 24969)

*Role resolution in `_ptyHostVerb`:*
- Remove the comment about hidden seats being real prompt targets (lines 825-836)
- Remove `hiddenTerminals` from the `roleRows` union (line 839) — `roleRows` becomes just `[...terminals]`
- Update the comment at line 852: remove "(terminals + hiddenTerminals)" reference
- Update the cache-pruning condition at line 853: change `if (listed && (Array.isArray(listed.terminals) || Array.isArray(listed.hiddenTerminals)))` to `if (listed && Array.isArray(listed.terminals))`
- Update the comment at line 973: remove "(terminals + hiddenTerminals)" reference

*`listFleetTerminals` wrapper:*
- Remove `hiddenTerminals` from the `listFleetTerminals` wrapper (line 1458) — return `res.terminals` only
- Remove the comment about `hiddenTerminals` in the wrapper (lines 1446-1448)

*Mirror registry:*
- Remove the `hiddenTerminals` split from the mirror registry (lines 3310-3321): remove the `mirrorRows` array construction with `hidden: true` stamping, just iterate `parsed.terminals` directly
- Remove the `hidden` stamp on mirrored rows (line 3330)
- Remove the comment about hidden workers being mirrored (lines 3310-3317)

*Plan enrichment:*
- Remove `hiddenTerminals` from the plan enrichment (lines 3680-3682): remove `if (Array.isArray(result.hiddenTerminals)) { result.hiddenTerminals = plan(result.hiddenTerminals); }`

*Fleet poll:*
- Remove `this._ptyHiddenTerminalNames = (result.hiddenTerminals || [])` from the fleet poll (lines 3642-3644)

*Autoban terminal registry:*
- Remove `if (info.hidden === true) { continue; }` from `_getAliveAutobanTerminalRegistry` (line 11047) and its comment (lines 11039-11046)
- Remove `.filter(([, info]) => !info?.hidden)` from `_getAliveAutobanTerminalNamesFromRegistry` (line 11108)
- Remove `.filter(([, info]) => !info?.hidden)` from `_selectAutobanTerminal` (line 11154)

*Live terminal callbacks:*
- Remove `hiddenTerminals` from the `liveTerminals` async callback (line 13266): change `return [...(listed.terminals || []), ...(listed.hiddenTerminals || [])]` to `return [...(listed.terminals || [])]`
- Remove `hiddenTerminals` from the `liveDelegateCount` callback in `instantiateAgentGroup` (line 13436): same change
- Remove `hiddenTerminals` from the `liveDelegateCount` callback in `instantiateExternalHeadedTeam` (line 13522): same change

> **Superseded:** The original plan referenced "Remove `hiddenTerminals` from the seat-safeguards `roleRows` (line 3812)" as a separate item.
> **Reason:** There is no `roleRows` at line 3812 — that line is a catch block in an unrelated handler. The only `roleRows` is at line 837, which is already covered by the `roleRows` union removal at line 839. This was a phantom duplicate reference.
> **Replaced with:** No separate action needed — the `roleRows` union at line 839 (now the sole reference) is already covered above.

**Edge Cases:** The `_getAliveAutobanTerminalRegistry` method at line 11047 drops hidden rows BEFORE the downstream filters at lines 11108 and 11154. After removing all three, the autoban pool includes every alive terminal — which is correct, since no terminal is ever hidden anymore. The downstream filters were redundant defenses; removing them is safe.

### `src/services/LocalApiServer.ts`

**Context:** The local API server uses `hiddenTerminals` in two places: the delegate count for external team creation, and the relay validation fleet.

**Logic:**
- Remove `hiddenTerminals` from the delegate count in the external team creation handler (line 3389): change `return [...(listed.terminals || []), ...(listed.hiddenTerminals || [])]` to `return [...(listed.terminals || [])]`
- Remove `hiddenTerminals` from the relay validation fleet in `_handleTerminalsRelay` (line 3914): change `.concat(Array.isArray(listed?.hiddenTerminals) ? listed.hiddenTerminals : [])` to just use `listed.terminals`

> **Superseded:** The original plan cited "line 3345" for the delegate count and "line 3870" for the relay validation.
> **Reason:** Line numbers drifted since the plan was written. Line 3345 is a `headName` collision check; line 3870 is a comment in `_handleTerminalsRelay`. The actual references are at lines 3389 and 3914 respectively.
> **Replaced with:** Corrected line numbers — 3389 (delegate count) and 3914 (relay validation fleet).

**Edge Cases:** The relay validation checks `isActive(from)` and `isActive(to)` against the fleet array. After removal, the fleet is just `listed.terminals`. Since no terminal is hidden, this is the complete fleet — no validation gap.

### `src/test/unattended-batch-improvement-contract.test.js`

**Context:** This test file has two subtasks. Subtask 1 tests the hidden fleet mechanism (REMOVE). Subtask 2 tests the unattended prompt contract (KEEP).

**Logic:**
- Remove the section comment "Subtask 1: hidden fleet, batched creation" (lines 126-132)
- Remove test: "all three hosts project hidden terminals onto a SIBLING key, never into `terminals`" (lines 134-146)
- Remove test: "hidden workers are NOT selectable — registry read drops them, dispatch pre-flight excludes them" (lines 148-175)
- Remove test: "hidden workers ARE mirrored into runtime.terminals on both hosts" (lines 177-195)
- Keep test: "ptyCreateBatch validates the whole allocation BEFORE spawning anything" (lines 197-212) — `createBatch` itself stays, just without `hidden`
- Keep test: "ptyCreateBatch classifies resource exhaustion apart from a bad role config" (lines 214-225)
- Keep all Subtask 2 tests (lines 50-124) — the `unattended` flag's prompt text directives are live and unchanged

**Edge Cases:** The kept `createBatch` tests (lines 197-225) read the source file and assert on `createBatch`'s structure. They do NOT reference `hidden` — they check `MAX_BATCH`, `Number.isInteger`, `getAgentStartupCommands`, and error classification. These remain valid after the `hidden` parameter is removed.

### `src/test/seat-safeguards-fleet-prompt-path.test.js`

**Context:** One test asserts that `_ptyHostVerb` searches `hiddenTerminals` for role resolution.

**Logic:**
- Remove test: "_ptyHostVerb resolves the seat role from hidden terminals too (relay targets them)" (lines 662-677). With hidden terminals gone, `ptyListTerminals` returns one array. The role resolution no longer needs to search a sibling key.

**Edge Cases:** The test at line 674 asserts `roleRows.find(` exists — this pattern is still valid (role resolution still uses `roleRows.find`), but the test's premise (searching `hiddenTerminals`) is gone. The entire test block is removed.

### `src/test/pty-route-surface-contract.test.js`

**Context:** A comment explains why `ptyCreateBatch` is excluded from the webview verb list.

**Logic:**
- Update the comment on `WEBVIEW_PTY_VERBS` (lines 31-37): `ptyCreateBatch` is still agent-only, but the reason is no longer "a planner creates a hidden fleet" — it's simply that batch creation is an agent-only verb (no webview button for it). Rewrite the comment to reflect that `ptyCreateBatch` creates multiple terminals at once and is only called by agent automation, not by the webview.

**Edge Cases:** The `WEBVIEW_PTY_VERBS` filter (line 38) is unchanged — `ptyCreateBatch` is still excluded. Only the explanatory comment changes.

## Verification Plan

### Automated Tests

1. **Compile:** `npm run compile` — no TypeScript errors from removed fields/parameters.
2. **Tests:** `node src/test/unattended-batch-improvement-contract.test.js` — subtask 2 tests pass, subtask 1 tests removed.
3. **Tests:** `node src/test/seat-safeguards-fleet-prompt-path.test.js` — hidden terminal test removed, rest pass.
4. **Tests:** `node src/test/pty-route-surface-contract.test.js` — updated comment, rest pass.
5. **Grep verification:** `grep -r "hidden" src/standalone/ptyFleetService.ts src/standalone/ptyHost.ts src/standalone/bootstrap.ts` — zero matches for `hidden` (excluding unrelated comments about hidden source maps, hidden columns, etc.).
6. **Grep verification:** `grep -r "hiddenTerminals\|_ptyHiddenTerminalNames\|getUnattendedPlannerTerminal\|getUnattendedImproverTerminals" src/` — zero matches.
7. **Grep verification:** `grep -r "\.hidden" src/services/TaskViewerProvider.ts src/services/LocalApiServer.ts` — zero matches for terminal-hidden-related `.hidden` (excluding unrelated CSS/HTML `hidden` attributes or `overflow:hidden` in webview files).

### Goal Invariants

- **Negative:** The string `hiddenTerminals` is absent from all three `ptyListTerminals` implementations (`src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, and the `_ptyHostVerb` wrapper in `src/services/TaskViewerProvider.ts`).
- **Positive:** All three `ptyListTerminals` implementations return a `terminals` array that includes every live terminal handle (no filtering by `hidden`).
- **Negative:** The field `_ptyHiddenTerminalNames` is absent from `src/services/TaskViewerProvider.ts`.
- **Negative:** The methods `getUnattendedPlannerTerminal` and `getUnattendedImproverTerminals` are absent from `src/services/TaskViewerProvider.ts`.
- **Positive:** The `createBatch` method still exists in `src/standalone/ptyFleetService.ts` and still validates allocation before spawning (the `MAX_BATCH` and `Number.isInteger` checks remain).
- **Negative:** The `hidden` field is absent from the `FleetTerminalInfo`, `ExtendedTerminalHandle`, and `CreateOptions` interfaces in `src/standalone/ptyFleetService.ts`.
- **Negative:** The string `!info?.hidden` is absent from `src/services/TaskViewerProvider.ts` (covers lines 11108 and 11154).

## Outstanding Questions

- **[user]** No external automation script outside this repo is known to call `ptyCreateBatch` with `hidden: true` over HTTP. If one exists, it will silently get visible terminals after this change. Proceeding on the assumption that none exist, since the selector methods were never wired and the feature was never documented.
