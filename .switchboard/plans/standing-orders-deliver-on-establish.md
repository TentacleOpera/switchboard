# Deliver Standing Orders on Terminal Establish

## Goal
When a terminal is spawned or has its role assigned, the system sends the terminal its applicable standing orders as a one-shot prompt. The terminal sees its orders immediately on establishment, not after the first dispatch.

### The problem, and the root cause
Standing orders are delivered by `applyStandingOrders` (standingOrders.ts:254), which appends a `=== STANDING ORDERS ===` block to the end of every prompt sent via `ptySendPrompt`. The block is a suffix on the dispatch payload, not a property of the terminal. A terminal that has just been spawned or had its role assigned does not receive its standing orders until the first dispatch carries them in. Between establishment and first dispatch, the terminal is running without orders — it does not know its role, its callback target, or its constraints.

The fix: after `_terminalAgentInfo.set` (the point where a terminal's role is recorded), the system sends a one-shot standing-orders prompt containing the terminal's applicable orders. The terminal sees its orders as a standalone message, not appended to a task.

## Metadata
- **Complexity:** 5
- **Tags:** backend, reliability, feature
- **Feature:** standing-orders-on-terminal-establish-and-clear

## User Review Required
No — adds a delivery path for existing standing orders. No new product decisions.

## Complexity Audit

### Routine
- Loading effective standing orders via `loadEffectiveStandingOrders(db)` (already imported and used at TaskViewerProvider.ts:685, :927).
- Building the `roleMap` from `_terminalAgentInfo` (the registry at TaskViewerProvider.ts:1221).
- Calling `renderStandaloneOrdersBlock` (from the role-scope subtask) to get the block.
- Sending the block via the existing `ptySendPrompt` / `_dispatchExecuteMessage` path, which already acquires the per-terminal `withTerminalSendLock` (TaskViewerProvider.ts:5696, :5986, :10273) — no new serialization needed.

### Complex / Risky
- **Hooking the RIGHT set sites.** There are five `_terminalAgentInfo.set` sites, not two. They are NOT equivalent:
  - `setTerminalAgentInfo` (TaskViewerProvider.ts:1821) — the public method, called from extension.ts:3624 for **freshly-spawned grid terminals** (the call is gated by `newlyCreatedTerminals.has(terminal)`). ESTABLISH — fire the one-shot here.
  - TaskViewerProvider.ts:10918 — worktree terminal spawn, role assigned post-spawn. ESTABLISH — fire here.
  - TaskViewerProvider.ts:11257 — orchestrator spawn. ESTABLISH, but **immediately followed by the kickoff dispatch** at TaskViewerProvider.ts:11275 (`_dispatchExecuteMessage`), which carries the orders block via `applyStandingOrders`. The one-shot here is redundant — SKIP it (see guard below).
  - TaskViewerProvider.ts:20882 and :20950 — the terminal-registration sweep that auto-detects roles for **already-open** terminals. NOT establish. A one-shot here would inject an orders prompt into a terminal that is mid-conversation. Do NOT hook these.
- **Recommended design — centralize the hook.** Route the two real spawn sites (10918, 11257) through `setTerminalAgentInfo` (1821) instead of calling `_terminalAgentInfo.set` directly, and put the one-shot delivery in `setTerminalAgentInfo`. The registration sweep (20882/20950) keeps using direct `.set` and is therefore naturally excluded. This gives one hook point, one guard, and makes the "fresh spawn only" rule structural rather than enumerated.
- **Double-delivery is NOT prevented by `stripStandingOrdersBlock`.** That helper strips a block from a *prompt string*; it does not scan the terminal's accumulated context. A one-shot followed by a dispatch yields two blocks in context. This is **idempotent noise, not a correctness bug** (same orders, twice) — EXCEPT for the orchestrator, where the one-shot and the kickoff dispatch are part of the same spawn sequence and the redundancy is pointless. Skip the one-shot for the orchestrator role (the kickoff is guaranteed to carry orders). For the grid/worktree paths, a later dispatch re-delivering the block is the acceptable cost of having orders visible *before* the first dispatch — which is the feature's whole point.
- Must not fire for terminals with no orders (avoid noise). Guard: `renderStandaloneOrdersBlock` returns `null` → no prompt sent.
- The one-shot delivery format: a standalone prompt with `ptySendPrompt` using `{ clearBeforePrompt: false, addonsComposed: true }` — the orders are the payload, not a suffix on a dispatch.

## Edge-Case & Dependency Audit
- **Race Conditions:** Grid/worktree terminal spawned, then dispatched later → one-shot fires on establish, dispatch re-appends the block. Two blocks in context, idempotent — acceptable. Orchestrator spawned → one-shot SKIPPED (kickoff dispatch at 11275 carries orders). Terminal spawned with no orders → no prompt sent. The per-terminal `withTerminalSendLock` serializes the one-shot against any concurrent dispatch to the same terminal, so the two sends cannot interleave/corrupt each other — they just both land.
- **Security:** No new endpoints. Uses the existing `ptySendPrompt` path.
- **Side Effects:** A freshly-spawned terminal that previously had no orders until first dispatch now receives orders on establish. For terminals with no applicable orders, the delivery is a no-op. Already-open terminals registered via the sweep (20882/20950) are NOT touched — no interrupt to running conversations.
- **Dependencies & Conflicts:** Depends on the role-scope subtask (`renderStandaloneOrdersBlock` and `roleMap` support in `selectOrders`). Depends on `_terminalAgentInfo` (TaskViewerProvider.ts:1221) and `ptySendPrompt` — both already landed. The recommended centralization refactors the direct `.set` calls at 10918 and 11257 to route through `setTerminalAgentInfo` (1821); this is a behavior-preserving refactor (the map write is identical) plus the new one-shot call.

## Dependencies
- `standing-orders-role-scope.md` — provides `renderStandaloneOrdersBlock` and the `roleMap` parameter for `selectOrders`. Must land first.
- `_terminalAgentInfo` (TaskViewerProvider.ts:1221) — the terminal-to-role registry. Already landed.
- `ptySendPrompt` / `_dispatchExecuteMessage` — the delivery path. Already landed.
- `withTerminalSendLock` — the per-terminal send lock (TaskViewerProvider.ts:5696 et al.). Already landed; reused, not extended.

## Adversarial Synthesis
Key risks: (1) hooking the wrong set sites — the registration sweep (20882/20950) would interrupt running terminals; mitigated by centralizing the hook in `setTerminalAgentInfo` and leaving the sweep on direct `.set`. (2) orchestrator double-delivery — the kickoff dispatch is imminent, not in-flight, so an "in-flight" guard would miss it; mitigated by skipping the one-shot for the orchestrator role (the kickoff is guaranteed to carry orders). (3) the original plan's claim that `stripStandingOrdersBlock` dedups across prompts — it does not; it only strips within a single prompt string. Reframed: cross-prompt redundancy is idempotent noise, accepted for grid/worktree, skipped for orchestrator. Mitigations: centralized hook, orchestrator skip, null-check, post-spawn timing.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — deliver standing orders on terminal establish
**Context:** Terminals are spawned at `vscode.window.createTerminal` (TaskViewerProvider.ts:5744, :10825, :11174) and roles are recorded via `_terminalAgentInfo.set`. There are five `.set` sites; only the fresh-spawn sites should trigger the one-shot (see Complexity Audit for the full classification).

**Logic:**
1. **Centralize the hook.** Put the one-shot delivery in `setTerminalAgentInfo` (TaskViewerProvider.ts:1821). Refactor the two fresh-spawn sites that currently call `_terminalAgentInfo.set` directly — the worktree spawn (TaskViewerProvider.ts:10918) and the orchestrator spawn (TaskViewerProvider.ts:11257) — to call `this.setTerminalAgentInfo(suffixedName, role, displayName)` instead. The map write is identical; this is behavior-preserving plus the new delivery. The registration sweep (TaskViewerProvider.ts:20882, :20950) keeps using direct `.set` and is therefore excluded by structure.
2. In `setTerminalAgentInfo`, after the existing `this._terminalAgentInfo.set(...)` and `this._notifyTerminalAgentNamesChanged()`, call a new async method `_deliverStandingOrdersOnEstablish(workspaceRoot, suffixedName, role)`. The call is fire-and-forget (not awaited) so `setTerminalAgentInfo` stays synchronous — the delivery happens in the background.
3. `_deliverStandingOrdersOnEstablish`:
   a. Load effective standing orders via `loadEffectiveStandingOrders(db)`.
   b. Build the `roleMap` from `_terminalAgentInfo`.
   c. Call `renderStandaloneOrdersBlock(orders, terminalName, liveNames, groups, roleMap)` to get the block.
   d. If the block is `null`, return (no prompt sent — avoid noise).
   e. If non-null, send it via `ptySendPrompt` with `{ name: terminalName, data: block, clearBeforePrompt: false, addonsComposed: true }` (through `_dispatchExecuteMessage` so the per-terminal `withTerminalSendLock` and PTY fleet resolution are reused).
4. **Orchestrator skip.** If `role === 'orchestrator'`, return early before sending — the orchestrator's spawn is immediately followed by the kickoff dispatch (TaskViewerProvider.ts:11275), which carries the orders block via `applyStandingOrders`. The one-shot would be a redundant second block in the same spawn sequence.

> **Superseded:** "After `_terminalAgentInfo.set(suffixedName, { role, displayName })` (line 1818 and 10894), call a new method `_deliverStandingOrdersOnEstablish`." Guard: "do not fire if a dispatch is already in flight to this terminal."
> **Reason:** The line numbers were stale (actual: 1821, 10918), and there are five `.set` sites, not two — the registration sweep (20882/20950) would interrupt already-open terminals, and the orchestrator site (11257) is followed by an imminent (not in-flight) kickoff dispatch an "in-flight" guard cannot detect.
> **Replaced with:** Centralize the hook in `setTerminalAgentInfo` (1821); route the worktree (10918) and orchestrator (11257) spawn sites through it; leave the registration sweep on direct `.set`; skip the one-shot for the orchestrator role (kickoff carries orders).

**Implementation:** The method is private and async, called fire-and-forget from `setTerminalAgentInfo`. The `ptySendPrompt` call goes through `_dispatchExecuteMessage`, so the per-terminal `withTerminalSendLock` and PTY fleet resolution are reused — no new serialization.

**Edge Cases:** Terminal spawned but no role assigned yet (role is empty string) → `selectOrders` finds no role-scoped orders, but global orders still apply → deliver global orders. Orchestrator spawned → one-shot skipped (kickoff carries orders). Worktree/grid terminal spawned, then dispatched later → one-shot fires, dispatch re-appends; two idempotent blocks in context — acceptable. Terminal spawned with no orders at all → no prompt sent. Already-open terminal registered via the sweep → NOT touched (no interrupt).

## Verification Plan
1. `npm run compile` — clean.
2. Unit: `_deliverStandingOrdersOnEstablish` with applicable orders → sends one `ptySendPrompt` with the orders block. No orders → no `ptySendPrompt` call.
3. Unit: `_deliverStandingOrdersOnEstablish` with `role === 'orchestrator'` → no `ptySendPrompt` call (skip — kickoff carries orders).
4. Unit: `setTerminalAgentInfo` for a fresh-spawn role → calls `_deliverStandingOrdersOnEstablish` (fire-and-forget). The registration-sweep path (direct `_terminalAgentInfo.set` at 20882/20950) does NOT call it.
5. Manual: spawn a planner terminal via the agent grid. It receives its role-scoped standing orders (the planner workflow prompt) as a one-shot prompt on establishment — no manual paste needed.
6. Manual: start the orchestrator. It does NOT receive a separate one-shot orders block — the kickoff dispatch carries the block. Terminal sees one block, not two.
7. Manual: dispatch a plan to a freshly-established grid/worktree terminal. The dispatch carries the standing-orders block (appended). The one-shot establish block is also in context — two idempotent blocks, same orders. Acceptable; verify no corruption/garbling (the `withTerminalSendLock` serializes the two sends).
8. Manual: spawn a terminal with no standing orders. No prompt is sent (no noise).
9. Manual: register an already-open terminal via the registration sweep. No one-shot orders prompt is injected into the running terminal.

## Completion Report

Implemented one-shot standing-orders delivery on terminal establish in `src/services/TaskViewerProvider.ts`. Added `renderStandaloneOrdersBlock` to the standingOrders import, added `_deliverStandingOrdersOnEstablish` method (loads effective orders, builds roleMap from `_terminalAgentInfo`, renders standalone block, sends via `_dispatchExecuteMessage` with `promptComposed=true`), and hooked it fire-and-forget into `setTerminalAgentInfo`. Refactored the worktree spawn site (was 10931) and orchestrator spawn site (was 11270) to call `setTerminalAgentInfo` instead of direct `_terminalAgentInfo.set` — the registration sweep (20947/21015) remains on direct `.set` and is excluded by structure. Orchestrator role is skipped (kickoff dispatch carries orders). No issues encountered; compilation and tests skipped per directives.
