# Standing Orders: Add a `role` Scope

## Goal
Add a `role` scope to the standing orders system so role-specific instructions (like the planner workflow prompt) can be stored and resolved. Today the scopes are `global`, `team`, `team-head`, and `pair` — there is no way to say "all planners get this instruction" without manually pasting it into each planner terminal.

### The problem, and the root cause
The standing orders system supports four scopes: `'global' | 'team' | 'pair' | 'team-head'` (`src/services/standingOrders.ts:3`). A `global` order applies to every terminal regardless of role — too broad. A `team` order applies to team members — too narrow (planners are not on teams). There is no `role` scope, so role-level instructions like the planner workflow prompt, the reviewer protocol, and the coder directives have no delivery path through standing orders — they must be manually pasted.

The fix is to add a `role` scope: an order with `scope === 'role'` applies when the target terminal's role matches `o.role`. The target's role is resolved from the terminal registry (`_terminalAgentInfo` in `TaskViewerProvider.ts:1221`), which already maps terminal names to roles.

## Metadata
- **Complexity:** 4
- **Tags:** backend, refactor, feature
- **Feature:** standing-orders-on-terminal-establish-and-clear

## User Review Required
No — adds a scope to an existing type system. No new product decisions.

## Complexity Audit

### Routine
- Adding `'role'` to `StandingOrderScope` (standingOrders.ts:3) — one type change.
- Adding a `role?: string` field to `StandingOrder` — the role name this order applies to.
- Teaching `selectOrders` (standingOrders.ts:182) to resolve `role`-scoped orders by checking the terminal's role from a `roleMap: Map<string, string>` (terminal name → role).
- Adding `role` to the `scopeRank` in `applyStandingOrders` (standingOrders.ts:294) so role-scoped orders render in the right position.

### Complex / Risky
- The `roleMap` must be passed through from the call site (`applyStandingOrders` at TaskViewerProvider.ts:777) to `selectOrders`. The call site already has access to the terminal registry (`_terminalAgentInfo`); it builds the map once per dispatch.
- When `roleMap` is absent (headless/test harness), role-scoped orders must be skipped gracefully — no regression. This preserves the existing test suite, which calls `applyStandingOrders`/`selectOrders` without a `roleMap` (see `src/test/standing-orders-marker-contract.test.js`, `src/test/queue-pipeline-contract.test.js`).

## Edge-Case & Dependency Audit
- **Race Conditions:** None — the `roleMap` is a snapshot built at dispatch time. A role change between dispatch and delivery is picked up on the next dispatch.
- **Security:** No new attack surface. Role-scoped orders use the same `mutateStandingOrders` serialization and `validateInstruction` guards.
- **Side Effects:** A terminal whose role matches a role-scoped order now receives that order. Terminals without a role in the registry do not receive role-scoped orders (global/team/pair orders still apply).
- **Dependencies & Conflicts:** Depends on `_terminalAgentInfo` (TaskViewerProvider.ts:1217) for role resolution — already landed. Does NOT conflict with the context-aware completion order plan — that plan changes what the team-scoped order says; this plan adds a role scope. The two coexist.

## Dependencies
- `StandingOrderScope` / `selectOrders` / `applyStandingOrders` (standingOrders.ts) — the scope system and delivery mechanism. Already landed.
- `_terminalAgentInfo` (TaskViewerProvider.ts:1217) — the terminal-to-role registry. Already landed.
- `context-aware-completion-reporting.md` — the context-aware completion order is a team-scoped order that this plan's role scope coexists with. Should land first.

## Adversarial Synthesis
Key risks: (1) role resolution from `_terminalAgentInfo` may be stale — mitigated by the registry being updated on rename/re-assign; (2) `roleMap` absent in headless mode — mitigated by skipping role-scoped orders gracefully. Mitigations: registry kept in sync, graceful degradation when roleMap absent.

## Proposed Changes

### `src/services/standingOrders.ts` — add `role` scope
**Context:** `StandingOrderScope` (line 3) is `'global' | 'team' | 'pair' | 'team-head'`. `selectOrders` (line 182) resolves each scope. There is no `role` scope.

**Logic:**
1. Add `'role'` to `StandingOrderScope`: `'global' | 'team' | 'pair' | 'team-head' | 'role'`.
2. Add a `role?: string` field to `StandingOrder` — the role name this order applies to (e.g., `'planner'`, `'coder'`, `'reviewer'`, `'lead'`).
3. In `selectOrders`, add a `role` branch: an order with `scope === 'role'` applies when the target terminal's role matches `o.role`. The target's role is resolved from a `roleMap: Map<string, string>` (terminal name → role) passed as a new optional parameter. When `roleMap` is absent, role-scoped orders are skipped.
4. In `applyStandingOrders`, pass the `roleMap` through to `selectOrders`. Add `role` to `scopeRank` (between `global` and `team`: `global: 0, role: 1, 'team-head': 2, team: 2, pair: 3`). The current rank is `{ global: 0, 'team-head': 1, team: 1, pair: 2 }` (standingOrders.ts:294) — `team-head` and `team` are renumbered from 1 to 2 to make room for `role` at 1; their relative equality is preserved (both render after `role`, before `pair`).
5. In `renderOrder` (standingOrders.ts:231), **no change is needed** — `role` falls into the existing default branch that renders `global`/`team` as a plain rule (`- ${o.instruction}\n`). The `pair`-only "Regarding terminal" framing is correctly skipped for `role`. Verify this in the unit test; do not add a `role` case that duplicates the default.

**Implementation:** The `roleMap` is built from `_terminalAgentInfo` in TaskViewerProvider.ts and passed through the `applyStandingOrders` call site (line 777). The call site already has access to the terminal name (`payload.name`) and the registry; it builds the map once per dispatch.

**Edge Cases:** Terminal has no role in the registry (unassigned) → role-scoped orders do not apply. Terminal's role changes → the registry is updated, the next dispatch picks up the new role. `roleMap` absent (headless) → role-scoped orders skipped, no regression.

### `src/services/standingOrders.ts` — helper to render a standalone orders block
**Context:** `applyStandingOrders` renders the block as a suffix on a prompt. The establish/clear delivery (sibling subtasks) needs the block as a standalone prompt.

**Logic:**
1. Add `renderStandaloneOrdersBlock(orders: StandingOrder[], targetName: string, liveNames: Set<string>, groups: TerminalGroup[], roleMap?: Map<string, string>): string | null`:
   a. Call `selectOrders` with the parameters.
   b. If no orders apply, return `null`.
   c. Render the block: `\n\n${STANDING_ORDERS_MARKER}\n` + rendered rules + `These apply to everything you do in this terminal until told otherwise.\n`.
   d. Return the block string.
2. The establish/clear delivery subtasks call this helper, and if it returns non-null, send it via `ptySendPrompt`.

**Implementation:** The helper is a thin wrapper around `selectOrders` + the rendering logic already in `applyStandingOrders` (lines 299-304). Extracted to avoid duplicating the rendering.

**Edge Cases:** No orders → `null` → no prompt. Orders present → block string → prompt sent.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: `selectOrders` with a `role`-scoped order and a terminal whose role matches → order selected. Terminal with a different role → order not selected. `roleMap` absent → order not selected (graceful degradation).
3. Unit: `renderStandaloneOrdersBlock` with applicable orders → non-null string containing the marker. No applicable orders → `null`.
4. Unit: `applyStandingOrders` with both `role`-scoped and `team`-scoped orders → both rendered, `role` before `team` in the block (scopeRank ordering).
5. Regression: existing `applyStandingOrders` tests pass unchanged (the `roleMap` parameter is optional, defaults to absent, role-scoped orders are skipped).
6. Regression: existing `selectOrders` tests pass unchanged for `global`, `team`, `team-head`, `pair` scopes.

## Completion Summary

Added a `role` scope to the standing orders system. Changes: `StandingOrderScope` union extended with `'role'`, `StandingOrder` interface gained a `role?: string` field, `selectOrders` gained an optional `roleMap: Map<string, string>` parameter and a `role` branch that matches the target terminal's role from the map (graceful skip when map absent). `applyStandingOrders` and the new `renderStandaloneOrdersBlock` helper (extracted from the rendering logic in `applyStandingOrders`) both thread `roleMap` through. `scopeRank` updated to `{ global: 0, role: 1, 'team-head': 2, team: 2, pair: 3 }`. `makeStandingOrder` gained a `role` parameter. The `LocalApiServer` add handler validates `'role'` scope and requires a non-empty `role` field. Call sites wired: `TaskViewerProvider.ts` (builds `roleMap` from `roleRows`) and `bootstrap.ts` (builds `roleMap` from `ptyFleetService.listActive()`). The `terminalUtils.ts` VS Code terminal path and the `terminals.js` client mirror skip role-scoped orders (graceful degradation — `roleMap` optional, no `role` branch in mirror filter). No issues encountered.
