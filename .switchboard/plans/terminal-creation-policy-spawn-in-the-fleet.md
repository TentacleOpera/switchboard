# Terminal Creation Policy — Spawn in the Fleet Instead of Declining

## Goal

Close the create-if-missing gap left by the `allowPtyFleet` deletion: when a role resolves to no terminal in either set and a PTY fleet is running, spawn the terminal **in the fleet** and deliver to it, rather than returning `false`. Today the code declines, which is safe but costs VS Code users an affordance they have had since before the browser cockpit existed.

### Problem analysis and root cause

**The flag carried three jobs; only two had successors.** `delete-allowptyfleet-resolve-terminals-by-name.md` identified this precisely and named it the plan's single genuine risk. Jobs 1 (resolution eligibility) and 2 (delivery target) were replaced by name-based resolution. Job 3 — *whether to spawn a `vscode.Terminal` at all when the role resolves to nothing* — has no successor under name resolution, because its trigger is a role that resolves to **nothing in either set**. Name resolution answers "where does it live" only when it lives somewhere.

**What shipped.** The implementing change chose the conservative half of the plan's stated policy. Re-verified in the working tree on 2026-08-14 (line numbers corrected from the original draft):

- `TaskViewerProvider.sendPromptToAgentTerminal` (`:4847`): after the fleet delivery attempt and the registered/open-terminal scan both miss, `if (this._ptyHostPort) { return false; }` at `:4881`, then a `try { vscode.window.createTerminal(...) } catch { return false; }`.
- `PlanningPanelProvider._sendPromptToTerminal` (`:1251`): same shape — `if (this._taskViewerProvider && this._taskViewerProvider.hasPtyHost()) { return false; }` at `:1273` before `this._seams().terminal.create(...)`.

The plan asked for three branches:

| Host state | Plan | Shipped |
|---|---|---|
| Standalone (no `vscode.Terminal` at all) | never spawn a `vscode.Terminal`; create/attach in the fleet, else `false` with a reason | ✅ `false` (the shim's `createTerminal` throws and is caught; the Planning seam is guarded by `hasPtyHost()`) |
| VS Code, fleet running | **spawn in the fleet**, so the result is visible in the browser cockpit | ❌ returns `false` |
| VS Code, no fleet (`!this._ptyHostPort`) | spawn a `vscode.Terminal` exactly as at HEAD (byte-compat) | ✅ unchanged |

**Why "return false" is not simply wrong.** It is the safe half. Restoring the VS Code spawn under a running fleet would recreate the original silent-positive failure on the miss path: a browser click spawns an invisible `vscode.Terminal`, waits 5 s for the shell, sends the prompt into it and reports success. With the surface flag deleted there is no longer any way to tell a browser caller from a sidebar caller at that point, so "spawn in VS Code" is *always* a coin flip. Declining is honest, and every caller degrades to a clipboard fallback with a stated reason — `DesignPanelProvider`'s four send arms write the prompt to the clipboard and return `{ success: false, error: '… copied to clipboard instead.', prompt }`, and the Planning builder arms do the same. So this is a **lost affordance, not a dead click**, and it does not violate PRD contract #6.

**Why it still needs closing.** `_ptyHostPort` is set at `_startLocalApiServer` time whenever `isPtyAvailable()` succeeds and the ptyHost child completes its handshake — it is not gated on the browser cockpit being open. On any shipped install where node-pty loads, the fleet is running, so **every** VS Code user on that path now gets the clipboard fallback where they previously got a spawned terminal. That is a behaviour regression against ~4,000 installs (PRD contract #2), taken silently rather than declared. The plan's third branch exists precisely because it serves both surfaces at once: a fleet terminal is visible in the browser cockpit *and* addressable from VS Code, so spawning there is the one answer that needs no caller context.

**The precedent already exists on the other host.** Standalone's `handlePtyVerb` `case 'sendToTerminal'` (`bootstrap.ts:1534`) already does exactly this: on a name miss it calls `ptyFleetService.create(payload.role || 'coder', name, root)`, flags the result `created: true` so a driving agent can tell it is talking to a terminal it just spawned, and then delivers. Its comment names it *"the existing standalone contract."* This plan is not inventing a policy; it is bringing the extension host's shared-provider paths onto the policy standalone already ships, and adopting the `created` signal so callers can say where the terminal went.

**The affected entry points.** `sendPromptToAgentTerminal` is reached by `DesignPanelProvider`'s four send arms (`:2975`, `:3005`, `:3035`, `:3066` — `sendStitchTweakPrompt`, `sendHtmlTweakPrompt`, `sendClaudeImportPrompt`, `sendClaudeArtifactPrompt`) and two `PlanningPanelProvider` arms (`:3358`, `:3384`). `_sendPromptToTerminal` is reached by the PRD Builder, Constitution Builder (×2) and Switchboard Architect arms.

## Scope — two creation paths, not three

> **Superseded:** "`_deliverPromptToPmTerminal` (`:24394`) has a third, separate creation path with the same question" / "**Three creation paths, not two.** `_deliverPromptToPmTerminal` has its own spawn logic and its own clipboard escape hatch. Decide whether it adopts the same policy (it should) and treat it as part of this change" / verification step "Project Manager dispatch with no PM terminal — same policy, confirming the third path was not left behind."
> **Reason:** Verified at HEAD (`TaskViewerProvider.ts:26178`): **`_deliverPromptToPmTerminal` has no creation path at all.** It tries the fleet, then registered terminals, then open terminals by name, then copies to the clipboard. It never calls `createTerminal` on any surface. Its own doc comment states the omission is deliberate — *"Deliberately does NOT auto-spawn a terminal (unlike sendPromptToAgentTerminal) so the clipboard escape hatch stays available when no PM terminal is configured."* Nothing was lost here when `allowPtyFleet` was deleted, because there was never a spawn to lose. Converting it would not be closing a regression; it would be net-new product scope that deletes a documented affordance, executed under the banner of consistency — and the plan's own verification step would have signed it off as "confirming the third path was not left behind."
> **Replaced with:** **two creation paths**, both in scope: `sendPromptToAgentTerminal` and `PlanningPanelProvider._sendPromptToTerminal`. `_deliverPromptToPmTerminal` is explicitly **out of scope and unchanged**. If auto-spawning a PM terminal is wanted, it is a separate proposal that must argue against that doc comment on its merits — not a consistency sweep. The divergence risk the original bullet was reaching for is real, but it lives between the two in-scope paths, which is why both are converted here in one change.

Also explicitly out of scope and **not to be touched**: `_dispatchResearchToResearcher` (`:4790`). It resolves a researcher terminal the same two-stage way and **deliberately never spawns**, closing a documented TOCTOU gap ("Design Decision #3" — a re-route through `sendPromptToAgentTerminal` would spawn a researcher if the live one exited inside the check window). It is named here only so a coder sweeping for terminal-resolution sites does not "fix" it into this policy.

## Metadata

**Tags:** backend, reliability, bugfix
**Complexity:** 6
**Project:** Browser Switchboard

## User Review Required

None. The policy is decided: spawn in the fleet when a fleet is running. It is what the parent plan specified, it is the only branch that serves both surfaces, it is what standalone already does, and the alternatives were evaluated and rejected above.

## The startup-command question — corrected

This is the plan's highest-risk area and the original analysis had it inverted. The facts, verified at HEAD:

- `ptyFleetService.create(role, name, cwd, worktreePath, parentInstanceId, startupCommand, opts)` ends with `await this.injectStartupCommand(handle, role, startupCommand)` (`ptyFleetService.ts:297`).
- `injectStartupCommand` (`:313`): when no explicit `startupCommand` is passed, it resolves `GlobalIntegrationConfigService.getAgentStartupCommands()[role]`; if that is empty it returns having sent nothing; otherwise it waits `SHELL_READINESS_DELAY_MS` (**750 ms**, `:14`) and calls `handle.sendText(cmd, true)`.
- Both hosts pass `undefined` for `startupCommand` on `ptyCreateTerminal` — the extension host's child hardcodes it (`ptyHost.ts:75`), and standalone `delete`s any wire-supplied value then passes `undefined` (`bootstrap.ts:1147`, `:1168`). This is a deliberate security boundary: an arbitrary shell line from anything holding the API token would turn the verb into a command-execution endpoint.

> **Superseded:** "**Startup command and settle timing have no fleet equivalent yet.** … The fleet path must apply the same startup command and settle behaviour or the first prompt lands in a shell with no agent running" and the instruction to add a seam that "applies `getAgentStartupCommand(role, root)` through `ptySendPrompt` if one is configured."
> **Reason:** The fleet **already injects the role's configured startup command on every create**. Following the instruction as written sends it a *second* time, launching a second agent process in the same shell — or, worse, typing `claude` into a Claude session that has already started. It also cannot be done the prescribed way regardless: the wire strips `startupCommand` on both hosts by design, so the only route is a separate post-create send, which is exactly the double-application. The feared outcome ("a terminal that exists, accepts the prompt, and runs it in a plain shell with no agent") is real but has a much narrower cause than "the fleet has no equivalent."
> **Replaced with:** the fleet is the default provider of the startup command. This plan adds a **conditional top-up for the three cases where the fleet's resolution is narrower than the VS Code path's**, and a **post-startup settle** which genuinely has no fleet equivalent.

**The three divergence classes** (each verified by comparing `injectStartupCommand` against `TaskViewerProvider.getStartupCommands`/`getAgentStartupCommand` at `:6111` and `:6156`):

1. **Hard-coded role fallbacks.** `getAgentStartupCommand` substitutes a default when the configured command is missing or blank: `jules_monitor`→`jules`, `claude_artifacts`→`claude`, `claude_import`→`claude`, `project_manager`→`claude`. `injectStartupCommand` has none of these. `claude_artifacts` and `claude_import` are precisely the roles behind two of the four Design panel arms this plan serves, so this is the common case, not the exotic one.
2. **Custom agents.** `getStartupCommands` merges `parseCustomAgents(...)` over the file commands; `injectStartupCommand` reads the file map only. A custom role spawns into a bare shell.
3. **Legacy installs.** `getStartupCommands` falls back to per-IDE `globalState` and then the per-workspace DB when the machine-global `integration-config.json` is absent (pre-backfill installs). `injectStartupCommand` reads only the global file (`|| {}`), so on those installs it sends nothing while the VS Code path sends the right command.

**The required logic**, in the new seam, after a successful create:

```
fleetWouldSend = (await GlobalIntegrationConfigService.getAgentStartupCommands() || {})[role]
expected       = await this.getAgentStartupCommand(role, resolvedWorkspaceRoot)

if (expected && !fleetWouldSend) → top-up: send `expected` as a bare line after the fleet's 750 ms window
if (fleetWouldSend)              → send nothing; the fleet already did it
```

`GlobalIntegrationConfigService` is already imported and used by this provider (`:6117`), so this adds no new dependency. When they are both non-empty and differ, **trust the fleet and log** — do not send a second command to reconcile them; the fleet owns the terminal it created.

**The settle gap is real and is the whole risk.** The VS Code path waits 2000 ms after create, sends the startup command, then waits a further **3000 ms** before the prompt. The fleet waits 750 ms and sends, then returns immediately — there is no post-command settle anywhere. Whenever a startup command was sent (by the fleet or by the top-up), the seam must wait the equivalent settle before delivering, or the first prompt races the agent's own boot. This — not the command itself — is what produces "the agent ignored my prompt."

## Complexity Audit

### Routine
- Replacing the two guards with a fleet-spawn attempt, keeping `return false` as the fallback when the spawn itself fails.
- Keeping the existing no-fleet `vscode.Terminal` path byte-identical.

### Complex / Risky
- **The startup-command conditional above.** Getting it wrong in either direction is silent: skip it and four Design-panel roles land in a bare shell; apply it unconditionally and every correctly-configured role gets two agents in one terminal.
- **The post-startup settle has no fleet equivalent** and must be added in the seam, not assumed.
- **The fleet spawn is a real capability, not a one-liner.** The extension host reaches the fleet through `handlePtyVerb('ptyCreateTerminal', payload)` (`:2145`), which resolves `cwd` from the kanban provider's effective workspace root when the caller omits it, then calls `_ptyHostVerb`, then refreshes the mirror registry. The child's arm is `fleet.create(payload.role || 'coder', payload.name, payload.cwd, payload.worktreePath, …)` (`ptyHost.ts:70`). A spawn issued from a dispatch path must supply `role`, `name` and `cwd` deliberately rather than inheriting the grid button's defaults. Pass `name` as the same `agentName` the VS Code path would have used, so the terminal is addressable by name on the next dispatch and the no-duplicate check works.
- **Delivery must go through `_dispatchExecuteMessage`, never a hand-rolled `ptyWrite`.** `ptySendPrompt` owns bracketed-paste framing, chunking, the per-terminal send lock and the confirm CR. A multi-line prompt written raw runs one fragment per line. This is already documented at `_tryFleetDeliveryForRole`.
- **Seat visibility.** A fleet terminal created from a dispatch path appears in the browser Terminals panel only when a cockpit client is connected and seats it. Spawning into a fleet nobody is watching is not a dead click (the return value is honest and the terminal is real), but the user-facing message must say where the terminal went, or it reads as silence.
- **Byte-compatibility (PRD contract #2).** The `!this._ptyHostPort` / no-fleet branch must stay byte-identical, including both settle timings and the `_registeredTerminals` registration. Installs where node-pty does not load must see no change whatsoever.
- **The new seam must be public.** `PlanningPanelProvider` reaches `TaskViewerProvider` only through public members (it uses the public `tryFleetDeliveryForRole` wrapper today). A `_`-prefixed private helper is not reachable from there; expose a public wrapper in the same shape.

## Edge-Case & Dependency Audit

**Race Conditions**
- Between `ptyCreateTerminal` returning and the terminal being ready to accept a prompt there is a startup window — 750 ms of shell readiness plus the agent's own boot. The seam must not assume the handle is immediately promptable (see the settle gap above).
- A pty-host restart between the resolution miss and the spawn attempt leaves `_ptyHostPort` set but the child gone. The spawn must fail honestly rather than throw across the arm boundary (PRD contract #4: failures return `{success:false, error}`).
- Two near-simultaneous dispatches for the same unresolved role must not spawn two terminals. Re-check resolution via `ptyListTerminals` immediately before spawning, keyed on the normalised role name.

**Security** — no new endpoint, verb or allowlist change. `_isValidAgentName` remains the path-segment guard on `_dispatchExecuteMessage` and is untouched. The spawn path inherits the fleet's existing cwd resolution; do not widen it to accept a caller-supplied absolute path. **The `delete payload.startupCommand` strip on both hosts stays** — the top-up is a separate post-create send from trusted host-side code, never a wire-supplied launch command.

**Side Effects**
- A VS Code user with a fleet running who previously saw an editor terminal appear will now see a browser terminal appear instead. That is the intended consolidation and belongs in release notes.
- Terminals created this way persist in the fleet and count against whatever seating the cockpit applies.

**Dependencies & Conflicts**
- Touches `TaskViewerProvider.ts` and `PlanningPanelProvider.ts` — one agent stream per provider file (PRD orchestration discipline). Serialise against other work in those files.
- `src/test/browser-direct-terminal-helpers.test.js:96` pins the literal `hasPtyHost()` inside `_sendPromptToTerminal`'s body. See the Test Impact section — this plan is designed to keep it green rather than rewrite it.

## Dependencies

- **Blocking (inbound):** `feature_plan_20260812150000_fleet-seam-standalone-terminal-parity.md` **must land first.** It replaces guard `:4881` with `this._hasFleet()` and re-points `hasPtyHost()`'s body at the same predicate. This plan then replaces that already-swapped guard with the spawn attempt. In the other order, the guard is rewritten twice and this plan is written against a predicate that is about to be replaced.
- `delete-allowptyfleet-resolve-terminals-by-name.md` has landed.

## Test Impact

The sibling fleet-seam subtask owns three source-text assertions that pin `_ptyHostPort` literals (in `browser-direct-terminal-helpers.test.js` and `pty-dispatch-focus-contract.test.js`) and rewrites them to `_hasFleet()`. **This plan owns exactly one assertion, and can keep it green.**

| File:line | Assertion | Disposition |
| :--- | :--- | :--- |
| `browser-direct-terminal-helpers.test.js:96` | `_sendPromptToTerminal` must contain `hasPtyHost()` | **keep green — do not rewrite** |
| `browser-direct-terminal-helpers.test.js:105-110` | `sendPromptToAgentTerminal` returns `Promise<boolean>`; guard literal | guard literal already rewritten to `_hasFleet()` by the sibling; the `Promise<boolean>` pin must survive this change |

> **Superseded:** "`browser-direct-terminal-helpers.test.js` currently asserts *'sendPromptToAgentTerminal returns Promise<boolean> and refuses to create a terminal when fleet is available'* — that assertion pins the behaviour this plan changes and must be rewritten in the same change" / "Rewrite the *'refuses to create a terminal when fleet is available'* assertion to pin the new three-branch policy."
> **Reason:** Two different tests carry that title — one for `_sendPromptToTerminal`, one for `sendPromptToAgentTerminal` — so "the assertion" is ambiguous and a coder will rewrite whichever they find first. More importantly, rewriting the `hasPtyHost()` pin is avoidable: the new policy needs a branch on "is a fleet running" in exactly the place the old decline sat, so the call can stay and simply select a different branch.
> **Replaced with:** keep `hasPtyHost()` as the branch selector rather than deleting it —
> ```ts
> if (!handle) {
>     // Fleet running → spawn there (visible to both surfaces). No fleet → spawn a
>     // VS Code terminal exactly as at HEAD. This call previously returned false here.
>     if (this._taskViewerProvider && this._taskViewerProvider.hasPtyHost()) {
>         return await this._taskViewerProvider.createFleetTerminalAndDeliver(...);
>     }
>     try { handle = this._seams().terminal.create(name, undefined, wsRoot); }
>     catch { return false; }
> }
> ```
> The literal survives, `:96` stays green, and the comment above it records that the branch's meaning changed from decline to spawn. The `Promise<boolean>` pins on both methods are likewise preserved by construction — the contract is unchanged.

## Adversarial Synthesis

Key risks, in order: the startup command is applied **twice** (fleet + seam) and launches two agents in one shell, or is skipped for the four fallback roles and the terminal sits at a bare prompt — both silent, and the original plan's instruction produced the first while trying to prevent the second; the post-startup settle is omitted so the first prompt races the agent's boot; the byte-compat no-fleet branch is broken by a well-intentioned unification of the two spawn paths; and a consistency sweep converts `_deliverPromptToPmTerminal`, deleting a deliberate clipboard escape hatch that was never part of the regression. Mitigations: the startup command is applied conditionally on the fleet's own resolution being empty, with the check specified explicitly; the settle is required whenever a command was sent by either party; the `!this._ptyHostPort` branch is left untouched rather than unified; PM and `_dispatchResearchToResearcher` are named out of scope with reasons; and the one pinned test assertion is kept green by retaining `hasPtyHost()` as the branch selector.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** `sendPromptToAgentTerminal` (`:4847`), whose miss-path guard sits at `:4881`. After the sibling subtask lands, that guard reads `if (this._hasFleet()) { return false; }`.
- **Logic:** Add one seam — a **public** `createFleetTerminalAndDeliver(role, prompt, workspaceRoot, opts?): Promise<boolean>` (plus a private implementation if preferred) that:
  1. re-checks role resolution via `ptyListTerminals` and delivers to an existing match rather than spawning;
  2. issues `ptyCreateTerminal` through `handlePtyVerb` with explicit `role`, `name` (the resolved `agentName`) and `cwd`;
  3. applies the conditional startup-command top-up specified above;
  4. waits the post-startup settle when a command was sent by either party;
  5. delivers via `_dispatchExecuteMessage`;
  6. returns the delivery result, and surfaces a message naming the browser Terminals panel so a VS Code user knows where the terminal went.
  Replace the `:4881` guard with: attempt this seam; on failure return `false`. Leave the no-fleet `vscode.Terminal` branch exactly as it is.
- **Implementation:** Adopt standalone's `created: true` signal (`bootstrap.ts:1553`) in the seam's result shape so callers can distinguish "delivered to your existing coder" from "spawned a new terminal and delivered there" — that distinction is what the user-facing message needs.
- **Edge Cases:** Re-check resolution immediately before spawning so two concurrent dispatches do not create two terminals. A pty-host restart mid-flight returns `{success:false, error}` rather than throwing.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `_sendPromptToTerminal` (`:1251`); the `hasPtyHost()` decline at `:1273`. Its seam-based `terminal.create` is a silent no-op under the standalone bundle (`hostServices.ts` returns an inert handle), which is why the guard is there.
- **Logic:** Keep the `hasPtyHost()` call as the branch selector and change what the true branch does — spawn-and-deliver through the new public seam instead of returning `false`, falling back to `false` on failure. Keep the seam-based `terminal.create` path for the no-fleet case, and keep it unreachable in standalone — the inert handle must never be treated as a successful delivery.
- **Edge Cases:** `_sendPromptToTerminal` must keep returning `Promise<boolean>`; its callers turn `false` into the clipboard fallback and that contract is relied on by four builder arms.

### `src/test/browser-direct-terminal-helpers.test.js`
- **Logic:** No assertion rewrites required if the `hasPtyHost()` branch-selector shape above is used. Add coverage for the new policy rather than replacing existing pins: assert the true branch calls the fleet-spawn seam (not `terminal.create`), and that the false branch still reaches `terminal.create`.
- **Implementation:** Record inline that the `hasPtyHost()` branch changed meaning from "decline" to "spawn in the fleet", so the next reader does not mistake the retained call for unchanged behaviour.

### New contract coverage
- **Logic:** Pin the startup-command conditional explicitly — it is the part most likely to be silently wrong and it cannot be observed from the return value. Assert that the seam consults the fleet's own resolution before sending anything, and that a role with a configured command produces exactly one startup send.

## Verification Plan

### Automated
1. **Miss path, standalone:** role resolves to nothing; assert no `vscode.Terminal` is constructed and the arm returns `{success:false}` with a stated reason.
2. **Miss path, VS Code + fleet:** role resolves to nothing; assert `ptyCreateTerminal` is issued with the correct `role`, `name` and `cwd`, and the prompt is delivered through `_dispatchExecuteMessage` (not a raw write).
3. **Startup command, configured role:** the fleet resolves a command for the role; assert the seam sends **no** second startup command — exactly one launch reaches the terminal.
4. **Startup command, fallback role:** `claude_artifacts` with no configured command; assert the seam tops up with `claude` after the fleet's window, and that the prompt is delivered only after the settle.
5. **Miss path, VS Code, no fleet:** byte-compat — assert `vscode.window.createTerminal` is called with the same options, both settle intervals are preserved, and the terminal is registered in `_registeredTerminals`, exactly as at HEAD.
6. **Spawn failure is honest:** with `_ptyHostPort` set but the child gone, assert the arm returns `{success:false, error}` and does not throw across the boundary.
7. **No double spawn:** two concurrent dispatches for the same unresolved role produce one terminal.
8. **Both in-scope creation paths** (`sendPromptToAgentTerminal`, `_sendPromptToTerminal`) exercise the same policy — asserted per path, not once. `_deliverPromptToPmTerminal` is asserted **unchanged**: it still reaches the clipboard fallback with no terminal created.
9. `browser-direct-terminal-helpers.test.js` passes with `:96` unmodified; the other dispatch-surface contract tests pass unmodified.
10. Existing gates stay green: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, full `test:contract:*`.

### Manual
1. **VS Code, fleet running, no coder terminal:** Design → send element tweak. A coder terminal appears in the browser Terminals panel **with the agent started**, the prompt lands in it after the agent is up, and the editor message says where it went.
2. **VS Code, fleet running, no Claude Artifacts terminal:** the `claude_artifacts` arm — the fallback-role case. Confirm exactly one `claude` launch, not zero and not two.
3. **VS Code, node-pty unavailable:** same click spawns an editor terminal exactly as before, including the startup command. No change.
4. **Standalone (`npx switchboard`), no coder terminal:** the same verb over HTTP spawns in the fleet and delivers, matching what `sendToTerminal` already does there.
5. **PRD Builder / Constitution Builder / Architect** with no planner terminal, in both host states — same outcomes.
6. **Project Manager dispatch** with no PM terminal — **unchanged**: clipboard fallback, no terminal created. This is the regression check for the scope correction above.
7. Spawned fleet terminal survives, is seated in the cockpit, and accepts a second dispatch by name without spawning a duplicate.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The branch structure is simple and already specified, but the change adds a real capability across two shipped provider files, and its two worst outcomes — a terminal with no agent running in it, or one with two — are both silent and both read as the agent misbehaving. The startup-command conditional cannot be verified from the return value, and the byte-compat branch must be left alone rather than unified, which is the opposite of the instinct a refactor invites.

## Implementation Summary

Implemented the fleet-first terminal creation policy in `TaskViewerProvider.ts` and `PlanningPanelProvider.ts`. Added public `createFleetTerminalAndDeliver` seam to `TaskViewerProvider` which handles pre-spawn active terminal re-checks, fleet terminal creation via `ptyCreateTerminal`, conditional startup command top-ups with pre-command shell-readiness delay (750ms) and post-startup settle delays (3000ms), and prompt delivery via `_dispatchExecuteMessage`. Preserved unchanged byte-compatibility for no-fleet VS Code environments while updating `browser-direct-terminal-helpers.test.js` to assert the fleet-spawn seam contracts.


## Review Findings

Reviewed commit `4f165c9e`. Goal achieved: both in-scope creation paths spawn in the fleet on a resolve-to-nothing miss — `sendPromptToAgentTerminal` (`TaskViewerProvider.ts:6435`) and `PlanningPanelProvider._sendPromptToTerminal` (`:1383`) — through the new public `createFleetTerminalAndDeliver` seam, which follows the established `instantiateAgentGroup` precedent (direct `_ptyHostVerb('ptyCreateTerminal')`, threaded `claudeInlineRendering`, explicit `_updatePtyMirrorRegistry` since the wrapper is bypassed). The no-fleet VS Code branch, both settle waits and `_registeredTerminals` registration are unchanged, and `_deliverPromptToPmTerminal` / `_dispatchResearchToResearcher` were not touched. Two defects fixed: the startup-command top-up wrote via `ptyWrite`, which standalone's `handlePtyVerb` never implemented — it fell to the default arm, so on standalone the fallback roles got no launch command AND no settle, and the prompt landed in a bare shell (a `ptyWrite` arm mirroring `ptyHost.ts` was added to `bootstrap.ts`); and the two new `_dispatchExecuteMessage` call sites broke the CI-wired census in `seat-safeguards-fleet-prompt-path.test.js` (12→14 / 7→9, both uncomposed, which is the safe direction).

**Verdict is provisional on the core mechanism.** The delivered coverage is source-text only. Verification items 1–8 — exactly one startup command for a configured role, the `claude_artifacts` top-up, byte-compat on the no-fleet branch, honest spawn failure, no double spawn — have no automated check that could discriminate on correctness, and none was executed manually in this pass. Passing the unrelated suites is not evidence the startup-command conditional or the settle work.

## Deferred Findings

- MAJOR — `src/services/PlanningPanelProvider.ts:1393` — the plan required the inert standalone `terminal.create` handle stay unreachable; on standalone with node-pty unavailable `hasPtyHost()` is false, the branch is taken, and the inert handle is reported as a successful delivery. Pre-existing and identical at `4f165c9e^`; closing it needs a headless marker on the terminal seam.
- NIT — `src/services/TaskViewerProvider.ts:21258` — pre-spawn `ptyListTerminals` re-check is TOCTOU-windowed; concurrent dispatches inside the window still spawn two terminals.
- NIT — `src/services/TaskViewerProvider.ts:21290` — a failed create returns bare `false`; the plan's `created: true` signal was not adopted, because the seam must return `Promise<boolean>` (pinned by two contract gates). The spawn destination is instead surfaced by the information message.
- NIT — `src/services/TaskViewerProvider.ts:21332` — the seam omits the `_refreshTerminalStatuses()` its own precedent at `:11475` makes after a fleet create.
- NIT — `src/standalone/ptyFleetService.ts:513` — `injectStartupCommand` does not trim, so a whitespace-only configured command is "sent" by the fleet while the seam's trimmed `fleetWouldSend` reads empty and tops up. Harmless (a blank line), but the two resolutions differ by a trim.
