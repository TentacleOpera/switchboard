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

**Creation is hardcoded to the VS Code backend.** `ensureWorktreeTerminals` (`src/services/TaskViewerProvider.ts:10015`) delegates to `_createAutobanTerminal` (`:9169`), which calls `vscode.window.createTerminal` (`:9526`). There is no branch. Every autoban terminal and every worktree agent terminal is a VS Code terminal, regardless of where the operator is looking.

**The cockpit is fed by a different system.** `src/webview/terminals.js:1364` populates `fleetList` over HTTP from the PTY fleet. The per-worktree groups at `:2128-2151` are **derived from terminals** — `source: 'worktree'`, keyed on each terminal's `worktreePath` — not from worktree rows. So with no fleet terminal carrying that path, no group can exist. The Worktrees tab row has no bearing on it.

**The extension is not fleet-less.** Per `TaskViewerProvider.ts:24-28`: *"the fleet itself, the WebSocket gateway and the prompt-delivery helpers now live in the pty host child. The extension is control plane: it never constructs a fleet and never sees terminal bytes."* The extension reaches that child through `_ptyHostVerb(verb, payload)` (`:364`), and the child already exposes `ptyCreateTerminal`, `ptyListTerminals` and `ptySendPrompt` (`src/standalone/ptyHost.ts:69`, `:110`, `:211`). The capability is present and wired; creation simply never routes to it.

**Standalone already does this correctly, which is why the hosts have diverged.** `src/standalone/bootstrap.ts:1313` matches a terminal by `worktreePath` + role, falls back to any terminal in that worktree, and otherwise calls `ptyFleetService.create(targetRole, overrideName, matchedWtPath || root, matchedWtPath)` — a fleet terminal stamped with its worktree path, which is exactly what makes the cockpit grouping work. Standalone cannot do otherwise: `src/standalone/vscodeShim.ts:128` makes `createTerminal` throw outright. So the correct model already exists next door and the extension host never adopted it.

### The rule this plan implements

**Surface decides the backend, not host.**

| Host | Surface in use | Creation | Prompt delivery |
| :--- | :--- | :--- | :--- |
| VS Code extension | VS Code terminal panel | `vscode.window.createTerminal` | `sendRobustText` |
| VS Code extension | browser cockpit | `ptyCreateTerminal` (with `worktreePath`) | `ptySendPrompt` |
| Standalone | browser cockpit (only option) | `ptyCreateTerminal` (with `worktreePath`) | `ptySendPrompt` |

## Implementation

### 1. One surface resolver, shared by both hosts

Add a single exported resolver — `resolveTerminalSurface(workspaceRoot): 'vscode' | 'fleet'` — and a config key `switchboard.terminalSurface` with values `auto` (default) | `vscode` | `browser`.

`auto` resolves as: standalone ⇒ always `fleet`; extension ⇒ `fleet` when a cockpit client is connected, else `vscode`. The connection signal already exists — `GET /ws/connections` (`src/services/LocalApiServer.ts:3797`). Explicit `vscode` / `browser` values always win, so an operator who wants terminals in one place regardless can pin it.

This must be **one** resolver consumed by both hosts. A per-host copy is the known drift trap in this codebase and would reproduce exactly the divergence this plan is repairing.

### 2. Route creation inside `_createAutobanTerminal`

Keep `_createAutobanTerminal` as the single entry point and branch inside it. This matters: autoban terminals **and** worktree agent terminals both flow through it, so one branch fixes both, and no caller needs to learn about backends.

The fleet branch calls `_ptyHostVerb('ptyCreateTerminal', { role, name: agentName, cwd: worktreePath || workspaceRoot, worktreePath })`. **Stamping `worktreePath` is the load-bearing part** — it is the key `terminals.js:2131` groups on, and omitting it produces a terminal that exists but is ungrouped, which looks like a different bug.

### 3. Route prompt delivery to match the terminal's backend

Delivery must follow creation. A terminal created in the fleet but prompted through the VS Code path (or the reverse) silently does nothing — a failure mode with no error and no output, which is the worst kind to debug.

VS Code backend keeps `sendRobustText` (never raw `sendText`). Fleet backend uses `ptySendPrompt`. Route on the terminal's recorded backend, never on the current surface — the operator may have switched surfaces since the terminal was created.

### 4. The registry must record which backend each terminal lives in

`_getAliveAutobanTerminalRegistry` and `_findTerminalNameByWorktreePathAndRole` (used at `:10043` and `:10050-10060`) currently assume one terminal world. Once there are two, the existing-terminal check and the `MAX_AUTOBAN_TERMINALS_PER_ROLE` count must be scoped by backend **and** worktree path, or a VS Code terminal will satisfy the "already have one" check for a cockpit that cannot see it — reproducing the reported bug in a subtler form where pressing the button appears to succeed and does nothing.

Terminals recorded by released versions carry no backend field; treat a missing field as `vscode`, which is what every existing record is.

### 5. Autoban parity: rotation and liveness must see fleet terminals

Autoban rotation, the alive-registry sweep, and `getFleetLiveness` (`:612`) all need to work against fleet terminals, not just VS Code ones. Confirm the exit/tombstone signal shapes match between backends — the fleet reports `status` and `lastDataAt`, and the rotation logic must read the same liveness facts for both or a fleet terminal will never be recycled.

This is what makes the plan's title claim true for autoban and not only for worktrees.

### 6. Converge standalone onto the same resolver

`bootstrap.ts:1313` already produces the correct result. Do not rewrite its behaviour — route it through the shared resolver so that behaviour is now *guaranteed* by the same code path the extension uses, rather than coincidentally matching.

### 7. Never create in both backends

One terminal per role per worktree per surface. Creating in both doubles the fleet, doubles autoban's pool accounting, and makes prompt delivery ambiguous.

### 8. Ratchet the rule so this is the last revision

This is the fifth time this requirement has been fixed. It keeps coming back because it exists only as prose: there is no chokepoint, and `vscode.window.createTerminal` is called directly from **six** sites — `src/extension.ts:3428`, `src/services/hostSeams.ts:250`, and `src/services/TaskViewerProvider.ts:4619`, `:9223`, `:9543`, `:24687`. Repairing the site behind the current bug cannot stop the next feature from adding a seventh.

Add `scripts/check-terminal-routing.js`, modelled directly on the existing `scripts/check-push-routing.js` ratchet:

- **Zero** direct `vscode.window.createTerminal` references outside the surface router and `src/standalone/vscodeShim.ts`. Baseline-locked in a JSON ceiling like `check-verb-return-contract.js` does, so remaining legacy sites can be burned down without blocking the build, but no *new* one can be added.
- Same rule for raw `sendText` — prompt delivery must go through the routed helpers (`sendRobustText` / `ptySendPrompt`), never the terminal API directly.
- Wire it into the same gate the other four `check-*.js` guards run in.

The point is to make the wrong call fail mechanically rather than rely on the next agent remembering the rule. Note the evidence that this works: the only host that routes terminals correctly today is standalone, and it does so because `vscodeShim.ts:128` makes the wrong call *throw*. Where the wrong path was impossible, the implementation is correct; where it was merely discouraged, it is wrong at six sites.

### 9. A contract test that exercises both surfaces

The existing terminal contract tests (`src/test/terminal-open-all-seating-contract.test.js`, `src/test/multi-parent-terminals-contract.test.js`) assert seating behaviour on one surface. Extend the pattern with a case that resolves each surface and asserts the backend chosen for creation *and* delivery. The recurring failure is invisible to any test that only ever looks at one surface — that asymmetry is why five rounds of manual verification came back green.

### Edge cases

- **Pty host unavailable** (`_ptyHostBootFailed`, `isPtyAvailable()` false — see `:579`, `:1918`). In the extension, fall back to the VS Code backend with a visible message saying why; the operator must not be left staring at an empty cockpit. In standalone there is no fallback (`vscodeShim` throws), so surface the error rather than silently creating nothing.
- **Both surfaces genuinely in use.** `auto` prefers `fleet`. That is the reported failure case, and the cockpit is the surface the operator is watching when they press the button; `vscode` remains one setting away.
- **Non-pool roles** are already filtered out up front (`:10025-10035`). Unchanged — they simply have no worktree terminal on either backend.
- **Terminals created before this change** keep working through the VS Code path via the missing-field default; no migration of live terminals, no rename.
- **Never write `feature_worktree_mode`** from this path. Orchestration stashes a prior under that key and a stray write clobbers the restore.

## Verification Plan

1. **Unit — resolver matrix.** Every row of the table above, plus explicit `vscode` / `browser` overrides beating `auto` in both hosts, plus standalone ignoring a `vscode` setting it cannot honour.
2. **Unit — creation routing.** Assert the fleet branch calls `ptyCreateTerminal` with `worktreePath` populated, and the VS Code branch still calls `createTerminal` with today's arguments.
3. **Unit — delivery follows the terminal, not the surface.** Create on the fleet, switch the resolved surface to `vscode`, send a prompt, and assert it still goes via `ptySendPrompt`.
4. **Unit — registry scoping.** A VS Code terminal for role+worktree must NOT satisfy the existing-terminal check for the fleet backend, and must not count toward the fleet's per-role limit.
5. **Unit — pty host down.** Extension host falls back to VS Code with a message; standalone returns an error rather than a silent no-op.
6. **Manual — the exact reported bug.** With the extension running and the cockpit open, create a worktree from the board. The terminals must appear in the `terminals.html` sidebar, grouped under that worktree, and **Open agent terminals** must open them there — not in VS Code.
7. **Manual — VS Code surface regression.** Close the cockpit, set `terminalSurface: vscode`, repeat. Terminals open in the VS Code panel exactly as today, receive dispatched prompts, and autoban rotation still recycles them.
8. **Manual — standalone regression.** Run the standalone host and confirm worktree terminals still appear and take prompts, with behaviour unchanged from today.
9. **Manual — autoban on the fleet.** With the cockpit as the surface, let autoban rotate a role to its limit and confirm terminals are created, counted, and recycled on the fleet backend — the claim in the title, tested.

## Metadata

**Complexity:** 8
**Tags:** backend, reliability, bugfix, devops, ui
**Project:** Browser Switchboard
