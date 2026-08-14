# Agent Terminals Must Open on the Surface the Operator Is Actually Using

## Goal

Autoban terminals and worktree agent terminals are created on — and receive their prompts on — whichever surface the operator is working in: the VS Code terminal panel, the standalone browser cockpit, or the browser cockpit backed by the VS Code extension. The terminal backend becomes an implementation detail resolved at creation time instead of a hardcoded call.

### Reproduction

Create a worktree from the board with the extension running and the browser cockpit open:

- the worktree is created and its row appears correctly in the Worktrees tab;
- **no entry appears in the `terminals.html` sidebar**;
- pressing **Open agent terminals** opens the terminals **in VS Code** instead.

Two symptoms, one cause. The worktree machinery is working; everything downstream of it targets the wrong terminal system.

### Root cause

**Creation is hardcoded to the VS Code backend.** `ensureWorktreeTerminals` (`src/services/TaskViewerProvider.ts:10343`) delegates to `_createAutobanTerminal` (`:9497`), which calls `vscode.window.createTerminal` (`:9534`). There is no branch. Every autoban terminal and every worktree agent terminal is a VS Code terminal, regardless of where the operator is looking.

**The cockpit is fed by a different system.** `src/webview/terminals.js:1364` populates `fleetList` over HTTP from the PTY fleet. The per-worktree groups at `:2489-2500` are **derived from terminals** — `source: 'worktree'`, keyed on each terminal's `worktreePath` — not from worktree rows, and only materialise once a worktree's live terminal count reaches the group `threshold`. Membership resolves at `:2546` on the same key. So with no fleet terminal carrying that path, no group can exist. The Worktrees tab row has no bearing on it.

**The extension is not fleet-less.** Per `TaskViewerProvider.ts:24-28`: *"the fleet itself, the WebSocket gateway and the prompt-delivery helpers now live in the pty host child. The extension is control plane: it never constructs a fleet and never sees terminal bytes."* The extension reaches that child through `_ptyHostVerb(verb, payload)` (`:415`), and the child already exposes `ptyCreateTerminal`, `ptyCreateBatch`, `ptyListTerminals` and `ptySendPrompt` (`src/standalone/ptyHost.ts:69`, `:114`, `:138`, `:235`). The capability is present and wired; creation simply never routes to it.

**Standalone already does this correctly, which is why the hosts have diverged.** `src/standalone/bootstrap.ts:1494-1504` matches a terminal by `worktreePath` + role, falls back to any terminal in that worktree, and otherwise calls `ptyFleetService.create(targetRole, overrideName, matchedWtPath || root, matchedWtPath)` — a fleet terminal stamped with its worktree path, which is exactly what makes the cockpit grouping work. Standalone cannot do otherwise: `src/standalone/vscodeShim.ts:129` makes `createTerminal` throw outright. So the correct model already exists next door and the extension host never adopted it.

### The rule this plan implements

**Surface decides the backend, not host.**

| Host | Surface in use | Creation | Prompt delivery |
| :--- | :--- | :--- | :--- |
| VS Code extension | VS Code terminal panel | `vscode.window.createTerminal` | `sendRobustText` |
| VS Code extension | browser cockpit | `ptyCreateTerminal` (with `worktreePath`) | `ptySendPrompt` |
| Standalone | browser cockpit (only option) | `ptyCreateTerminal` (with `worktreePath`) | `ptySendPrompt` |

## Metadata

**Complexity:** 8
**Tags:** backend, reliability, bugfix, devops, ui
**Project:** Browser Switchboard

## User Review Required

None. Every decision in this plan is settled below: the config key is `switchboard.terminal.surface`, `auto` prefers the fleet when a cockpit client is connected, the per-role terminal cap becomes worktree-scoped, and worktree-seated terminals stop joining the autoban rotation pool.

## Complexity Audit

### Routine

- Adding a config key under the existing `switchboard.terminal.*` namespace (`package.json:315-334`).
- Adding a `scripts/check-terminal-routing.js` guard modelled on `scripts/check-push-routing.js` and wiring an npm script + CI step.
- Threading an existing `opts.allowPtyFleet` flag into two additional call sites.

### Complex / Risky

- Two terminal worlds must stay consistent across creation, the existing-terminal check, the per-role cap, prompt delivery, autoban rotation and liveness. A partial conversion produces a terminal that exists on one backend and is invisible to the accounting of the other — a silent no-op with no error, which is the failure mode already shipped.
- `_createAutobanTerminal` mints the terminal name from `vscode.window.terminals` before creating. On the fleet branch that name-space is the wrong one; the fleet mints its own names. Getting this wrong duplicates friendly names, and friendly name is the fleet's primary key.
- `_getAliveAutobanTerminalRegistry`'s signature and its `isPtyRow` line are asserted by regex in `src/test/browser-planner-dispatch-surface.test.js:148-162`. Changing either without updating those contract tests in lockstep breaks the gate; *removing* the `allowPtyFleet` opt-in breaks it permanently.
- Shipped-install byte-compatibility: with no cockpit connected and no config set, every path must resolve `vscode` and behave exactly as today.

## Implementation

### 1. One surface resolver, shared by both hosts

Add a single exported resolver — `resolveTerminalSurface(workspaceRoot): 'vscode' | 'fleet'` — and a config key with values `auto` (default) | `vscode` | `browser`.

> **Superseded:** the config key `switchboard.terminalSurface`.
> **Reason:** the codebase already owns a `switchboard.terminal.*` configuration namespace — `switchboard.terminal.clearBeforePrompt`, `.clearBeforePromptDelay`, `.ptyClearBeforePromptDelay`, `.claudeInlineRendering` (`package.json:315-334`). A sibling top-level key splits the namespace for no reason and reads as a different subsystem in the Settings UI.
> **Replaced with:** `switchboard.terminal.surface`.

Read it through `vscode.workspace.getConfiguration('switchboard').get<string>('terminal.surface', 'auto')`. That exact call works unmodified in **both** hosts: the standalone shim's `getConfiguration` returns a section-prefixing proxy (`src/standalone/vscodeShim.ts:192-215`) that resolves the same dotted key off disk. This is what makes "one resolver" achievable without a seam — do not add a config seam for it.

`auto` resolves as: standalone ⇒ always `fleet`; extension ⇒ `fleet` when a cockpit client is connected, else `vscode`. The connection signal already exists — `GET /ws/connections` (`src/services/LocalApiServer.ts:4033`). Explicit `vscode` / `browser` values always win, so an operator who wants terminals in one place regardless can pin it.

This must be **one** resolver consumed by both hosts. A per-host copy is the known drift trap in this codebase and would reproduce exactly the divergence this plan is repairing.

The extension must not make a blocking HTTP call to itself on every terminal creation. Cache the connection state — the WS gateway already knows when a client attaches and detaches — and treat a stale-but-recent snapshot as authoritative. Biasing toward `fleet` when the answer is uncertain is the safe direction: a fleet terminal is visible in the cockpit *and* enumerable from VS Code, whereas the reverse is not true.

### 2. Route creation inside `_createAutobanTerminal`

Keep `_createAutobanTerminal` (`TaskViewerProvider.ts:9497`) as the single entry point and branch inside it. This matters: autoban terminals **and** worktree agent terminals both flow through it, so one branch fixes both, and no caller needs to learn about backends.

The fleet branch calls `_ptyHostVerb('ptyCreateTerminal', { role, name: agentName, cwd: worktreePath || workspaceRoot, worktreePath })`. **Stamping `worktreePath` is the load-bearing part** — it is the key `terminals.js:2476` groups on, and omitting it produces a terminal that exists but is ungrouped, which looks like a different bug.

**Naming authority differs per backend, and this is not optional.** Today the method builds `usedNames` from `_readTerminalRegistryState`, `vscode.window.terminals` and `_registeredTerminals` (`:9524-9530`), then calls `getNextAutobanTerminalName`. On the fleet branch that union omits every live fleet terminal, so the computed name can collide with one the fleet already owns. Two options, and this plan picks the second:

- Union `ptyListTerminals` into `usedNames` before minting. Correct, but adds a cross-process round trip to every creation and still races the fleet's own allocator.
- **Let the fleet name it.** Pass `name` only when the caller explicitly requested one, take `terminal.friendlyName` back out of the `ptyCreateTerminal` response (`ptyHost.ts:97-105`), and register *that*. The fleet's allocator is the only thing that can answer the question atomically.

Return the created name from `_createAutobanTerminal` as it does today, so callers are unaffected by which backend answered.

### 3. Route prompt delivery to match the terminal's backend

Delivery must follow creation. A terminal created in the fleet but prompted through the VS Code path (or the reverse) silently does nothing — a failure mode with no error and no output, which is the worst kind to debug.

VS Code backend keeps `sendRobustText` (imported at `TaskViewerProvider.ts:52` from `./terminalUtils`; never raw `sendText`). Fleet backend uses `_ptyHostVerb('ptySendPrompt', { name, data, clearBeforePrompt, clearBeforePromptDelayMs })` — the pty host wraps `sendPromptToPty`, which owns bracketed-paste framing, chunked writes and the confirm CR (`ptyHost.ts:235-256`).

**The reference implementation for this branch already exists in-file**: `TaskViewerProvider.ts:13580-13601` resolves a fleet terminal from `ptyListTerminals` and delivers via `ptySendPrompt`, with the VS Code arm at `:13639-13654` using `_seams().terminal` + `sendRobustText`. Extract that pairing into the routed helper rather than writing a third variant.

Route on the terminal's recorded backend, never on the current surface — the operator may have switched surfaces since the terminal was created.

### 4. Scope the existing-terminal check and the per-role cap by backend *and* worktree

> **Superseded:** "The registry must record which backend each terminal lives in. `_getAliveAutobanTerminalRegistry` and `_findTerminalNameByWorktreePathAndRole` currently assume one terminal world. […] Terminals recorded by released versions carry no backend field; treat a missing field as `vscode`."
> **Reason:** false at HEAD. The registry already records the backend and both helpers already distinguish the two worlds. `_isFleetTerminalInfo(info)` (`TaskViewerProvider.ts:8680`) classifies a row as fleet on `info.purpose === 'pty' || info.ideName === PTY_IDE_NAME`; `_pickTerminalCandidate` (`:8699`) encodes an explicit live-first, fleet-wins-among-equals precedence over mixed candidate sets; and `_getAliveAutobanTerminalRegistry` already takes `opts?: { allowPtyFleet?: boolean }` and branches on `const isPtyRow = opts?.allowPtyFleet && this._isFleetTerminalInfo(info)` (`:8992-9035`). No new field and no missing-field default are needed — writing one would add a second, competing backend discriminator.
> **Replaced with:** the defect is narrower and entirely on the *consumer* side. Two concrete call sites in `ensureWorktreeTerminals`:
>
> 1. `:10363` calls `_getAliveAutobanTerminalRegistry(workspaceRoot)` with **no opts**, so `allowPtyFleet` is falsy and every fleet row is dropped before the liveness pass. A fleet row cannot survive that pass on the vscode path either — it has no entry in `vscode.window.terminals`, so `nameMatch` and `pidMatch` both fail and it lives or dies on a `lastSeen` heartbeat the fleet writer does not maintain. Result: the per-worktree cap count at `:10380-10390` sees zero fleet terminals and the fleet is uncapped.
> 2. `:10371` calls `_findTerminalNameByWorktreePathAndRole(resolvedPath, role, true)`, which matches on `worktreePath` + role across **both** backends and `continue`s on any hit. So an existing VS Code terminal satisfies the "already have one" check for a cockpit that cannot see it — the reported bug in a subtler form, where pressing the button appears to succeed and does nothing.
>
> The fix is to thread the resolved backend through both: pass `{ allowPtyFleet: true }` when the resolved surface is `fleet`, and give `_findTerminalNameByWorktreePathAndRole` a backend filter so the existing-check only matches terminals on the backend about to be used.

**Do not change `_getAliveAutobanTerminalRegistry`'s signature or delete the `allowPtyFleet` opt-in.** `src/test/browser-planner-dispatch-surface.test.js:148-162` asserts the signature and the `isPtyRow` line by regex, and `:184` asserts a caller passes `{ allowPtyFleet: true }`. Add the backend filter as a new optional parameter on `_findTerminalNameByWorktreePathAndRole` instead, and re-run those contract tests as part of the change.

### 4a. The per-role cap is workspace-global and must become worktree-scoped

*(Clarification — strictly implied by "one terminal per role per worktree per surface" in step 7, and by the registry scoping above. Not new product scope.)*

`_createAutobanTerminal` gates creation at `:9517-9521`:

```ts
const configuredPool = this._getConfiguredAutobanPool(normalizedRole);
const livePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
const poolSize = configuredPool.length > 0 ? configuredPool.length : livePrimaryRoleTerminals.length;
if (poolSize >= MAX_AUTOBAN_TERMINALS_PER_ROLE) { /* warn and return undefined */ }
```

`MAX_AUTOBAN_TERMINALS_PER_ROLE = 5` (`src/services/autobanState.ts:16`) and `_getConfiguredAutobanPool` reads `this._autobanState.terminalPools[role]` — a **workspace-global** rotation pool with no worktree dimension. `ensureWorktreeTerminals` then appends every terminal it creates into that pool (`:10406-10420`, via `_limitAutobanPool`, which itself `slice(0, 5)`s).

Two consequences, both live today and both blocking:

- The sixth worktree to request a `coder` is refused outright with a warning toast, whichever backend it targets. `ensureWorktreeTerminals`' own per-worktree cap is bypassed for `isManual` calls, but this gate is not — it takes no `isManual` parameter.
- Seating worktree terminals **injects them into the autoban rotation pool**, so autoban starts dispatching board work into worktree terminals, and `_limitAutobanPool`'s truncation evicts the operator's main-tree terminals from their own pool.

Fix both here, because this plan owns `_createAutobanTerminal`:

- Scope the cap the same way `ensureWorktreeTerminals` already scopes its own: count only terminals matching this role **on this backend and this worktree path**. The main tree (`worktreePath` unset) keeps today's global-per-role semantics unchanged, so shipped installs see no behaviour change.
- Worktree-seated terminals must not be added to `terminalPools` / `managedTerminalPools`. The rotation pool is the autoban dispatch pool; a worktree agent is not a rotation target.

This is the single change that makes bulk worktree creation possible at all — see `bulk-create-feature-worktrees-from-board-selection.md`, which is blocked on it.

### 5. Autoban parity: rotation and liveness must see fleet terminals

Autoban rotation, the alive-registry sweep, and `getFleetLiveness` (`:715`) all need to work against fleet terminals, not just VS Code ones.

`getFleetLiveness` already returns `{ friendlyName, lastDataAt, status }` from the cached `_ptyLiveness` snapshot and documents its fleet-less degradation contract; the registry's PTY branch already treats `info.status === 'exited'` as the tombstone (`:9029-9035`). Those two signal shapes are the contract — rotation and the alive sweep must read `status` / `lastDataAt` for fleet rows and `pid`/`nameMatch`/`lastSeen` for VS Code rows, from the one registry, rather than each growing its own liveness notion.

This is what makes the plan's title claim true for autoban and not only for worktrees.

### 6. Converge standalone onto the same resolver

`bootstrap.ts:1494-1504` already produces the correct result. Do not rewrite its behaviour — route it through the shared resolver so that behaviour is now *guaranteed* by the same code path the extension uses, rather than coincidentally matching.

Standalone must ignore a `switchboard.terminal.surface: vscode` setting it cannot honour (`vscodeShim.ts:129` throws) and resolve `fleet` regardless, without an error.

### 7. Never create in both backends

One terminal per role per worktree per surface. Creating in both doubles the fleet, doubles autoban's pool accounting, and makes prompt delivery ambiguous.

### 8. Ratchet the rule so this is the last revision

This is the fifth time this requirement has been fixed. It keeps coming back because it exists only as prose: there is no chokepoint, and `vscode.window.createTerminal` is called directly from **six** non-shim sites — `src/extension.ts:3435`, `src/services/hostSeams.ts:250`, and `src/services/TaskViewerProvider.ts:4884`, `:9534`, `:9854`, `:25932`. (A seventh reference, `src/standalone/vscodeShim.ts:129`, is the throw itself and is exempt.) Repairing the site behind the current bug cannot stop the next feature from adding another.

Add `scripts/check-terminal-routing.js`, modelled directly on the existing `scripts/check-push-routing.js` ratchet:

- **Zero** direct `vscode.window.createTerminal` references outside the surface router and `src/standalone/vscodeShim.ts`. Baseline-locked in a JSON ceiling like `scripts/check-verb-return-contract.js` does against `scripts/verb-return-contract-baseline.json`, so the six remaining legacy sites can be burned down without blocking the build, but no *new* one can be added. Note that `check-push-routing.js` keeps its baselines as an inline `BASELINES` object rather than a JSON file — follow the verb-return-contract file layout, not that one, so the ceiling is editable without touching the guard.
- Same rule for raw `sendText` — prompt delivery must go through the routed helpers (`sendRobustText` / `ptySendPrompt`), never the terminal API directly.
- Wire it into the same gate as the other guards.

> **Superseded:** "Wire it into the same gate the other four `check-*.js` guards run in."
> **Reason:** stale count. `scripts/` currently holds seven: `check-claude-mirror.js`, `check-icon-parity.js`, `check-kanban-dispatch-callers.js`, `check-protocol-parity.js`, `check-push-routing.js`, `check-standalone-push-parity.js`, `check-verb-return-contract.js`.
> **Replaced with:** add a `terminal-routing:check` script beside the existing ones in `package.json:887-896`, and a step in `.github/workflows/integration-tests.yml` alongside the checks at lines 25-53.

The point is to make the wrong call fail mechanically rather than rely on the next agent remembering the rule. Note the evidence that this works: the only host that routes terminals correctly today is standalone, and it does so because `vscodeShim.ts:129` makes the wrong call *throw*. Where the wrong path was impossible, the implementation is correct; where it was merely discouraged, it is wrong at six sites.

### 9. A contract test that exercises both surfaces

The existing terminal contract tests (`src/test/terminal-open-all-seating-contract.test.js`, `src/test/multi-parent-terminals-contract.test.js`) assert seating behaviour on one surface. Extend the pattern with a case that resolves each surface and asserts the backend chosen for creation *and* delivery. The recurring failure is invisible to any test that only ever looks at one surface — that asymmetry is why five rounds of manual verification came back green.

### Edge cases

- **Pty host unavailable** (`_ptyHostBootFailed` `:679`, `isPtyAvailable()` `:2028`). In the extension, fall back to the VS Code backend with a visible message saying why; the operator must not be left staring at an empty cockpit. In standalone there is no fallback (`vscodeShim` throws), so surface the error rather than silently creating nothing.
- **Both surfaces genuinely in use.** `auto` prefers `fleet`. That is the reported failure case, and the cockpit is the surface the operator is watching when they press the button; `vscode` remains one setting away.
- **Non-pool roles** are already filtered out up front (`:10353-10360`). Unchanged — they simply have no worktree terminal on either backend.
- **Terminals created before this change** keep working through the VS Code path: `_isFleetTerminalInfo` returns false for any row lacking `purpose: 'pty'` / the PTY `ideName`, which is every pre-existing record. No migration of live terminals, no rename.
- **Parallel seating within one call.** `ensureWorktreeTerminals` fires all roles through `Promise.all` (`:10398-10403`) while each `_createAutobanTerminal` reads its own `usedNames` snapshot. Letting the fleet own naming (step 2) removes the race on the fleet branch; the VS Code branch keeps today's behaviour, which is pre-existing and out of scope here.
- **Never write `feature_worktree_mode`** from this path. Orchestration stashes a prior under `orchestration_prior_feature_worktree_mode` (`KanbanProvider.ts:2244-2253`, `:8363-8376`) and a stray write clobbers the restore.

## Edge-Case & Dependency Audit

**Race conditions.** (a) Friendly-name allocation across two allocators — resolved by making the fleet the naming authority on its own branch. (b) `Promise.all` seating means N roles read the pool gate before any of them writes back; with the cap scoped per worktree+backend the window shrinks to one worktree's role set, which cannot exceed the cap. (c) A cockpit client disconnecting between resolver read and creation produces a fleet terminal with no viewer — harmless and recoverable, and preferred over the reverse.

**Security.** No new network surface. `ptyCreateTerminal` deliberately refuses a caller-supplied `startupCommand` (`ptyHost.ts:85-92`) — the routed creation path must not reintroduce one.

**Side effects.** Removing worktree terminals from the autoban rotation pool changes what autoban dispatches into on installs that currently have worktrees open. That is the intended correction, but it is observable: an operator relying on autoban reaching a worktree terminal loses that. Dispatch-to-worktree remains available through the explicit worktree dispatch path, which resolves by `worktreePath` + role rather than by pool.

**Dependencies & conflicts.** `src/test/browser-planner-dispatch-surface.test.js` and `src/test/browser-stray-dispatch-surface.test.js` pin the `allowPtyFleet` surface by regex (28 references across the test tree) — update in lockstep, never remove. No other plan in this feature edits `TaskViewerProvider.ts`, so this file is uncontended.

## Dependencies

- None. This is the root of the feature; both sibling subtasks depend on it, not the reverse.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a partial conversion: creation routed to the fleet while the existing-terminal check, the per-role cap, rotation or delivery still reason in VS Code terms — producing terminals that exist but are invisible to their own accounting, with no error anywhere. Mitigations: thread the resolved backend through *every* consumer in one change (`allowPtyFleet` into the registry read, a backend filter into the existing-check, worktree+backend scoping into the cap), make the fleet the naming authority on its own branch, and land the `check-terminal-routing.js` ratchet plus a two-surface contract test so the asymmetry that hid five previous failures is mechanically closed. Secondary risk: the `allowPtyFleet` signature is regex-pinned by shipped contract tests — widen around it, never through it.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context.** Owns `_createAutobanTerminal` (`:9497`), `ensureWorktreeTerminals` (`:10343`), `_getAliveAutobanTerminalRegistry` (`:8992`), `_findTerminalNameByWorktreePathAndRole` (`:8858`), `_isFleetTerminalInfo` (`:8680`), `_pickTerminalCandidate` (`:8699`), `getFleetLiveness` (`:715`) and `_ptyHostVerb` (`:415`).
- **Logic.** Branch creation and delivery on the resolved surface; scope the existing-check, the per-role cap and pool bookkeeping by backend + worktree path.
- **Implementation.** (1) Import and call `resolveTerminalSurface`. (2) In `_createAutobanTerminal`, add the fleet branch before the `vscode.window.createTerminal` call at `:9534`, taking the friendly name from the verb response. (3) Replace the global pool gate at `:9517-9521` with a worktree+backend-scoped count. (4) In `ensureWorktreeTerminals`, pass `{ allowPtyFleet: true }` at `:10363` when the surface is `fleet`, and a backend filter at `:10371`. (5) Skip the `terminalPools` / `managedTerminalPools` append at `:10406-10420` for terminals carrying a `worktreePath`. (6) Route delivery through the helper extracted from `:13580-13654`.
- **Edge cases.** Pty host down → fall back with a message. Missing `purpose`/`ideName` → vscode, which is every legacy row.

### `src/services/terminalSurface.ts` *(new)*

- **Context.** No shared home exists for this decision today; both hosts would otherwise grow a copy.
- **Logic.** `resolveTerminalSurface(workspaceRoot): 'vscode' | 'fleet'`.
- **Implementation.** Read `switchboard.terminal.surface` via `vscode.workspace.getConfiguration('switchboard')` (shim-compatible); explicit values win; `auto` consults the cached cockpit-connection state and standalone short-circuits to `fleet`.
- **Edge cases.** Standalone ignores `vscode`. Unknown values fall back to `auto` rather than throwing.

### `src/standalone/bootstrap.ts`

- **Context.** `:1494-1504` already resolves correctly by hand.
- **Logic.** Route the same decision through the shared resolver; behaviour unchanged.
- **Implementation.** Replace the implicit always-fleet assumption with a `resolveTerminalSurface` call and assert the `fleet` result.
- **Edge cases.** None new — standalone has no second backend.

### `scripts/check-terminal-routing.js` *(new)* + `package.json` + `.github/workflows/integration-tests.yml`

- **Context.** Six direct `createTerminal` sites and no mechanical guard.
- **Logic.** Ratchet ceilings for `vscode.window.createTerminal` and raw `sendText` outside the router and the shim.
- **Implementation.** JSON baseline file in the `verb-return-contract-baseline.json` style; `terminal-routing:check` npm script; CI step beside lines 25-53.
- **Edge cases.** Ceilings ratchet down only; the guard must never be able to raise one.

## Verification Plan

### Automated Tests

1. **Unit — resolver matrix.** Every row of the surface table, plus explicit `vscode` / `browser` overrides beating `auto` in both hosts, plus standalone ignoring a `vscode` setting it cannot honour, plus an unknown value falling back to `auto`.
2. **Unit — creation routing.** Assert the fleet branch calls `ptyCreateTerminal` with `worktreePath` populated and registers the name returned by the verb, and that the VS Code branch still calls `createTerminal` with today's arguments.
3. **Unit — delivery follows the terminal, not the surface.** Create on the fleet, switch the resolved surface to `vscode`, send a prompt, assert it still goes via `ptySendPrompt`.
4. **Unit — existing-check scoping.** A VS Code terminal for role+worktree must NOT satisfy the existing-terminal check for the fleet backend, and must not count toward the fleet's per-role limit.
5. **Unit — cap is worktree-scoped.** Seat a `coder` in each of six distinct worktree paths; assert all six are created and no warning fires. Assert the main tree (no `worktreePath`) still caps at `MAX_AUTOBAN_TERMINALS_PER_ROLE`.
6. **Unit — worktree terminals stay out of the rotation pool.** After `ensureWorktreeTerminals`, assert `terminalPools[role]` and `managedTerminalPools[role]` are unchanged.
7. **Unit — allowPtyFleet contract preserved.** Re-run `src/test/browser-planner-dispatch-surface.test.js` and `src/test/browser-stray-dispatch-surface.test.js` unmodified where possible; where the signature widened, assert the `allowPtyFleet` opt-in is still present rather than deleting the assertion.
8. **Unit — pty host down.** Extension host falls back to VS Code with a message; standalone returns an error rather than a silent no-op.
9. **Ratchet — `npm run terminal-routing:check`** fails when a new `vscode.window.createTerminal` or raw `sendText` is introduced outside the router and the shim.

### Manual

10. **The exact reported bug.** With the extension running and the cockpit open, create a worktree from the board. The terminals must appear in the `terminals.html` sidebar, grouped under that worktree, and **Open agent terminals** must open them there — not in VS Code. Note the group only renders once the worktree's live terminal count reaches the sidebar group threshold; seat both roles before judging.
11. **VS Code surface regression.** Close the cockpit, set `switchboard.terminal.surface: vscode`, repeat. Terminals open in the VS Code panel exactly as today, receive dispatched prompts, and autoban rotation still recycles them.
12. **Standalone regression.** Run the standalone host and confirm worktree terminals still appear and take prompts, with behaviour unchanged from today.
13. **Autoban on the fleet.** With the cockpit as the surface, let autoban rotate a role to its limit and confirm terminals are created, counted and recycled on the fleet backend — the claim in the title, tested.

---

**Recommendation: Send to Lead Coder** (complexity 8).
