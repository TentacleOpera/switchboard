# Terminal Creation Policy — Spawn in the Fleet Instead of Declining

## Goal

Close the create-if-missing gap left by the `allowPtyFleet` deletion: when a role resolves to no terminal in either set and a PTY fleet is running, spawn the terminal **in the fleet** and deliver to it, rather than returning `false`. Today the code declines, which is safe but costs VS Code users an affordance they have had since before the browser cockpit existed.

### Problem analysis and root cause

**The flag carried three jobs; only two had successors.** `delete-allowptyfleet-resolve-terminals-by-name.md` identified this precisely and named it the plan's single genuine risk. Jobs 1 (resolution eligibility) and 2 (delivery target) were replaced by name-based resolution. Job 3 — *whether to spawn a `vscode.Terminal` at all when the role resolves to nothing* — has no successor under name resolution, because its trigger is a role that resolves to **nothing in either set**. Name resolution answers "where does it live" only when it lives somewhere.

**What shipped.** The implementing change chose the conservative half of the plan's stated policy. Verified in the working tree on 2026-08-10:

- `TaskViewerProvider.sendPromptToAgentTerminal` (`:4505`): after the fleet delivery attempt and the registered/open-terminal scan both miss, `if (this._ptyHostPort) { return false; }`, then a `try { vscode.window.createTerminal(...) } catch { return false; }`.
- `PlanningPanelProvider._sendPromptToTerminal` (`:1250`): same shape — `if (this._taskViewerProvider?.hasPtyHost()) { return false; }` before `this._seams().terminal.create(...)`.

The plan asked for three branches:

| Host state | Plan | Shipped |
|---|---|---|
| Standalone (no `vscode.Terminal` at all) | never spawn a `vscode.Terminal`; create/attach in the fleet, else `false` with a reason | ✅ `false` (the shim's `createTerminal` throws and is caught; the Planning seam is guarded by `hasPtyHost()`) |
| VS Code, fleet running | **spawn in the fleet**, so the result is visible in the browser cockpit | ❌ returns `false` |
| VS Code, no fleet (`!this._ptyHostPort`) | spawn a `vscode.Terminal` exactly as at HEAD (byte-compat) | ✅ unchanged |

**Why "return false" is not simply wrong.** It is the safe half. Restoring the VS Code spawn under a running fleet would recreate the original silent-positive failure on the miss path: a browser click spawns an invisible `vscode.Terminal`, waits 5 s for the shell, sends the prompt into it and reports success. With the surface flag deleted there is no longer any way to tell a browser caller from a sidebar caller at that point, so "spawn in VS Code" is *always* a coin flip. Declining is honest, and every caller degrades to a clipboard fallback with a stated reason — `DesignPanelProvider`'s four send arms write the prompt to the clipboard and return `{ success: false, error: '… copied to clipboard instead.', prompt }`, and the Planning builder arms do the same. So this is a **lost affordance, not a dead click**, and it does not violate PRD contract #6.

**Why it still needs closing.** `_ptyHostPort` is set at `_startLocalApiServer` time whenever `isPtyAvailable()` succeeds and the ptyHost child completes its handshake (`TaskViewerProvider.ts:1916-1992`) — it is not gated on the browser cockpit being open. On any shipped install where node-pty loads, the fleet is running, so **every** VS Code user on that path now gets the clipboard fallback where they previously got a spawned terminal. That is a behaviour regression against ~4,000 installs (PRD contract #2), taken silently rather than declared. The plan's third branch exists precisely because it serves both surfaces at once: a fleet terminal is visible in the browser cockpit *and* addressable from VS Code, so spawning there is the one answer that needs no caller context.

**The affected entry points.** `sendPromptToAgentTerminal` is reached by `DesignPanelProvider`'s four send arms (`sendStitchTweakPrompt`, `sendHtmlTweakPrompt`, `sendClaudeImportPrompt`, `sendClaudeArtifactPrompt`) and two `PlanningPanelProvider` arms. `_sendPromptToTerminal` is reached by the PRD Builder, Constitution Builder (×2) and Switchboard Architect arms. `_deliverPromptToPmTerminal` (`:24394`) has a third, separate creation path with the same question.

## Metadata

**Tags:** backend, reliability, bugfix
**Complexity:** 6
**Project:** Browser Switchboard

## User Review Required

None. The policy is decided: spawn in the fleet when a fleet is running. It is what the parent plan specified, it is the only branch that serves both surfaces, and the alternatives were evaluated and rejected above.

## Complexity Audit

### Routine
- Replacing the two `return false` guards with a fleet-spawn attempt, keeping the `return false` as the fallback when the spawn itself fails.
- Keeping the existing no-fleet `vscode.Terminal` path byte-identical.

### Complex / Risky
- **The fleet spawn is a real capability, not a one-liner.** The extension host reaches the fleet through `handlePtyVerb('ptyCreateTerminal', payload)` (`TaskViewerProvider.ts:2038`), which resolves `cwd` from the kanban provider's effective workspace root when the caller omits it, then calls `_ptyHostVerb`, then refreshes the mirror registry. The child's arm is `fleet.create(payload.role || 'coder', payload.name, payload.cwd, payload.worktreePath)` (`ptyHost.ts:69`). A spawn issued from a dispatch path must supply `role` and `cwd` deliberately rather than inheriting the grid button's defaults.
- **Startup command and settle timing have no fleet equivalent yet.** The VS Code path spawns, waits 2000 ms for the shell, sends `getAgentStartupCommand(role, root)` if configured, then waits a further 3000 ms. The fleet path must apply the same startup command and settle behaviour or the first prompt lands in a shell with no agent running — a failure that looks like the agent ignoring the prompt.
- **Delivery must go through `_dispatchExecuteMessage`, never a hand-rolled `ptyWrite`.** `ptySendPrompt` owns bracketed-paste framing, chunking, the per-terminal send lock and the confirm CR. A multi-line prompt written raw runs one fragment per line. This is already documented at `_tryFleetDeliveryForRole`.
- **Seat visibility.** A fleet terminal created from a dispatch path appears in the browser Terminals panel only when a cockpit client is connected and seats it. Spawning into a fleet nobody is watching is not a dead click (the return value is honest and the terminal is real), but the user-facing message must say where the terminal went, or it reads as silence.
- **Byte-compatibility (PRD contract #2).** The `!this._ptyHostPort` branch must stay byte-identical, including both settle timings and the `_registeredTerminals` registration. Installs where node-pty does not load must see no change whatsoever.
- **Three creation paths, not two.** `_deliverPromptToPmTerminal` has its own spawn logic and its own clipboard escape hatch. Decide whether it adopts the same policy (it should) and treat it as part of this change, not a follow-up — leaving one path on a different policy is how the original divergence started.

## Edge-Case & Dependency Audit

**Race Conditions**
- Between `ptyCreateTerminal` returning and the terminal being ready to accept a prompt there is a startup window. The VS Code path handles this with fixed sleeps; the fleet path must not assume the handle is immediately promptable.
- A pty-host restart between the resolution miss and the spawn attempt leaves `_ptyHostPort` set but the child gone. The spawn must fail honestly rather than throw across the arm boundary (PRD contract #4: failures return `{success:false, error}`).
- Two near-simultaneous dispatches for the same unresolved role must not spawn two terminals. Re-check resolution immediately before spawning, or key the spawn on the normalised role name.

**Security** — no new endpoint, verb or allowlist change. `_isValidAgentName` remains the path-segment guard on `_dispatchExecuteMessage` and is untouched. Note the spawn path inherits the fleet's existing cwd resolution; do not widen it to accept a caller-supplied absolute path.

**Side Effects**
- A VS Code user with a fleet running who previously saw an editor terminal appear will now see a browser terminal appear instead. That is the intended consolidation and belongs in release notes.
- Terminals created this way persist in the fleet and count against whatever seating the cockpit applies.

**Dependencies & Conflicts**
- Touches `TaskViewerProvider.ts` and `PlanningPanelProvider.ts` — one agent stream per provider file (PRD orchestration discipline). Serialise against other work in those files.
- `src/test/browser-direct-terminal-helpers.test.js` currently asserts *"sendPromptToAgentTerminal returns Promise<boolean> and refuses to create a terminal when fleet is available"* — that assertion pins the behaviour this plan changes and must be rewritten in the same change, not after.

## Dependencies

None. `delete-allowptyfleet-resolve-terminals-by-name.md` has landed.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that "spawn in the fleet" is implemented as a bare `ptyCreateTerminal` call without the startup command and settle behaviour the VS Code path has always applied — producing a terminal that exists, accepts the prompt, and runs it in a plain shell with no agent, which reads to the user as the agent ignoring them and is *worse* than today's honest clipboard fallback. The second risk is the byte-compat branch: the no-fleet path must stay identical for installs where node-pty does not load, and a refactor that unifies the two spawn paths is the obvious way to break it. The third is that `_deliverPromptToPmTerminal` is left on the old policy, restarting the divergence this feature exists to end, and that `browser-direct-terminal-helpers.test.js` is edited to match the new behaviour without anyone noticing it was pinning the old one deliberately. Mitigations: port the startup-command + settle behaviour explicitly and test it; leave the `!this._ptyHostPort` branch untouched rather than unified; convert all three creation paths in one change; and rewrite the contract assertion with a comment recording what it used to assert and why that changed.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** `sendPromptToAgentTerminal` (`:4505`) and `_deliverPromptToPmTerminal` (`:24394`) both decline to create when `_ptyHostPort` is set.
- **Logic:** Add one private seam — `_createFleetTerminalForRole(role, workspaceRoot, worktreePath?): Promise<string | undefined>` — that issues `ptyCreateTerminal` with an explicit `role` and `cwd`, applies `getAgentStartupCommand(role, root)` through `ptySendPrompt` if one is configured, waits the same settle intervals the VS Code path uses, and returns the created terminal's `friendlyName`. Replace the two `if (this._ptyHostPort) { return false; }` guards with: attempt the fleet spawn; on success deliver via `_dispatchExecuteMessage` and return its result; on failure return `false`. Leave the `!this._ptyHostPort` VS Code branch exactly as it is.
- **Edge Cases:** Re-check role resolution immediately before spawning so two concurrent dispatches do not create two terminals. Surface a message naming the browser Terminals panel when the spawn succeeds, so a VS Code user knows where the terminal went.

### `src/services/PlanningPanelProvider.ts`
- **Context:** `_sendPromptToTerminal` (`:1250`) declines via `hasPtyHost()`; its seam-based `terminal.create` is a silent no-op under the standalone bundle (`hostServices.ts` returns an inert handle), which is why the guard is there.
- **Logic:** Replace the `hasPtyHost()` decline with a call to the new `TaskViewerProvider` fleet-spawn seam, falling back to `false` on failure. Keep the seam-based `terminal.create` path for the no-fleet case, and keep it unreachable in standalone — the inert handle must never be treated as a successful delivery.
- **Edge Cases:** `_sendPromptToTerminal` must keep returning `Promise<boolean>`; its callers turn `false` into the clipboard fallback and that contract is relied on by four builder arms.

### `src/test/browser-direct-terminal-helpers.test.js`
- **Logic:** Rewrite the *"refuses to create a terminal when fleet is available"* assertion to pin the new three-branch policy: standalone never constructs a `vscode.Terminal`; VS Code with a fleet spawns **in the fleet**; VS Code without a fleet spawns a `vscode.Terminal` exactly as at HEAD. Record inline what the assertion previously pinned and why it changed.

## Verification Plan

### Automated
1. **Miss path, standalone:** role resolves to nothing; assert no `vscode.Terminal` is constructed and the arm returns `{success:false}` with a stated reason.
2. **Miss path, VS Code + fleet:** role resolves to nothing; assert `ptyCreateTerminal` is issued with the correct `role` and `cwd`, the configured startup command is sent, and the prompt is delivered through `_dispatchExecuteMessage` (not a raw write).
3. **Miss path, VS Code, no fleet:** byte-compat — assert `vscode.window.createTerminal` is called with the same options, both settle intervals are preserved, and the terminal is registered in `_registeredTerminals`, exactly as at HEAD.
4. **Spawn failure is honest:** with `_ptyHostPort` set but the child gone, assert the arm returns `{success:false, error}` and does not throw across the boundary.
5. **No double spawn:** two concurrent dispatches for the same unresolved role produce one terminal.
6. All three creation paths (`sendPromptToAgentTerminal`, `_sendPromptToTerminal`, `_deliverPromptToPmTerminal`) exercise the same policy — asserted per path, not once.
7. The rewritten `browser-direct-terminal-helpers.test.js` passes; the other three dispatch-surface contract tests pass unmodified.
8. Existing gates stay green: `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, full `test:contract:*`.

### Manual
1. **VS Code, fleet running, no coder terminal:** Design → send element tweak. A coder terminal appears in the browser Terminals panel with the agent started, the prompt lands in it, and the editor message says where it went.
2. **VS Code, node-pty unavailable:** same click spawns an editor terminal exactly as before, including the startup command. No change.
3. **Standalone (`npx switchboard`), no coder terminal:** the same verb over HTTP fails closed with a stated reason and copies to clipboard; nothing references a VS Code terminal.
4. **PRD Builder / Constitution Builder / Architect** with no planner terminal, in both host states — same three outcomes.
5. **Project Manager dispatch** with no PM terminal — same policy, confirming the third path was not left behind.
6. Spawned fleet terminal survives, is seated in the cockpit, and accepts a second dispatch by name without spawning a duplicate.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The branch structure is simple and already specified, but the change adds a real capability (dispatch-initiated fleet spawn with startup-command parity) across three creation paths in two shipped provider files, and its worst outcome — a terminal that exists but has no agent running in it — is silent and reads as the agent ignoring the user. The byte-compat branch must be left alone rather than unified, which is the opposite of the instinct a refactor invites.
