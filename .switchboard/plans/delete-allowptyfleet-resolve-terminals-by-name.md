# Delete `allowPtyFleet` — Resolve Terminals by Name, Not by Caller Surface

## Metadata

**Complexity:** 6
**Tags:** refactor, bugfix, backend, reliability
**Project:** Browser Switchboard

## Goal

Delete the `allowPtyFleet` / `apiOriginated` surface flag and its ~92 hand-threaded forwarding sites across four provider files. Replace the question *"what kind of client is calling?"* with *"where does the named terminal actually live?"* — resolve a role/name across both terminal sets and deliver to whichever set holds it.

The flag exists for one reason: each host could only render one of two disjoint terminal sets, so dispatch had to guess by caller type. Once VS Code renders the PTY fleet (`vscode-terminals-view-onto-pty-fleet.md`), both supported hosts can display both sets and the guess has no job left.

### Problem analysis and root cause

**What the flag does today.** `TaskViewerProvider._dispatchExecuteMessage` (`src/services/TaskViewerProvider.ts:18953`) takes the surface decision as its **sixth positional parameter, defaulting to `false`**:

```typescript
private async _dispatchExecuteMessage(
    workspaceRoot: string, targetAgent: string, payload: string,
    metadata: Record<string, any>,
    sender: string = 'sidebar',
    allowPtyFleet: boolean = false      // ← the surface decision
): Promise<boolean>
```

`_attemptDirectTerminalPush` checks the PTY fleet **first, but only when the flag is set** (`:19039`+); `_isLikelyPtyDispatchTarget` (`:18898`) returns `false` outright when it is not. Eight call sites must each remember to pass it, and every wrapper above them must forward it — `dispatchCustomPromptToRole`, `dispatchConfiguredKanbanColumnAction`, `_handleTriggerAgentAction`, `_tryFleetDeliveryForRole`, `_dispatchWithPairProgrammingIfNeeded`, and the Airlock / orchestrator / pair-programming paths. `apiOriginated` currently appears 51× in `TaskViewerProvider.ts`, 18× in `KanbanProvider.ts`, 18× in `PlanningPanelProvider.ts` and 5× in `LocalApiServer.ts`.

**Why the shape is the bug, not the missing argument.** Drop the flag at any hop and the dispatch resolves a `vscode.Terminal`, delivers successfully, and returns `true` — no error, no log, no UI signal. It is a silent, *positive* failure. Observed on 2026-08-07: board drag-and-drop dispatched correctly from the browser while the send-to-terminal buttons on the same page did not, because `dispatchConfiguredKanbanColumnAction` forwards the flag at `HEAD` and `dispatchCustomPromptToRole` at `HEAD` does not even declare the parameter. Same page, same rail, same transport — one chain carried the flag, the other could not.

**Why deletion becomes correct.** The disjointness is what forced the guess:

| Terminal set | Browser cockpit | VS Code (today) | VS Code (after the fleet view) |
|---|---|---|---|
| PTY fleet (`ptyHost.js` child) | ✅ | ❌ | ✅ |
| `vscode.window.terminals` | ❌ | ✅ | ✅ |

At release the supported hosts are the VS Code extension and standalone (`npx switchboard`). Standalone has no `vscode.Terminal` at all — the shim provides none — so the fleet is its only set and there is nothing to decide. VS Code, once it renders the fleet, can display both, so the correct target is simply wherever the named terminal exists. Neither configuration needs to know what kind of client asked.

The browser-served-by-the-extension-host configuration — the only one in which the question was ever meaningful — is transitional and will not be supported.

**Precedent that this resolution order already works.** `terminals.js:2056-2098` (the terminals-pane drag) delivers by naming an explicit terminal and posting to `/terminals/verb/ptySendPrompt`. It has never needed a surface flag because it never resolves by role — it already knows where the terminal lives. This plan generalises that property to every dispatch path.

> **Superseded:** `dispatch-surface-as-request-context-not-threaded-flag.md` — carry the surface decision in an `AsyncLocalStorage` request context read at the delivery primitive, instead of threading it as a parameter.
> **Reason:** It hardens a distinction that is being removed rather than removing its cause, and spends ~92 sites of churn across four shipped provider files to make a transitional configuration robust. It also introduces an ambient-context mechanism with no precedent in this codebase.
> **Replaced with:** delete the distinction entirely once both hosts can render both terminal sets. Resolution by name needs no caller context, no ambient storage, and no threading.

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting a parameter from one function and its eight call sites.
- Deleting `options?: { apiOriginated?: boolean }` forwarding from the intermediate wrappers.
- Deleting `msg.apiOriginated` reads in `KanbanProvider` / `PlanningPanelProvider` arms.

### Complex / Risky
- **Name collisions across the two sets are now a real decision.** With the flag gone, a role that matches a terminal in *both* the fleet and `vscode.window.terminals` needs a defined precedence. Pick one, state it in code, and make it deterministic — do not leave it to iteration order. **Recommended: fleet first, `vscode.Terminal` fallback**, because the fleet is the set both hosts render and the only set standalone has. Record the choice where a reader will find it.
- **`_orchestratorApiOriginated` disappears with the flag.** It exists (`TaskViewerProvider.ts:9466`, `:11026`) purely because the orchestrator wake fires from a timer with no request in scope, so it could not read a surface. Under name-based resolution there is nothing for it to remember — delete the field and its assignment sites rather than leaving a vestigial `true`.
- **`_isLikelyPtyDispatchTarget` changes meaning, it does not disappear.** Its fleet-name match (`_normalizeAgentKey` / `_stripIdeSuffix` over `_ptyTerminalNames`) is exactly the resolution this plan wants; only the `!allowPtyFleet` early-return goes. Keep the normalisation — it handles IDE suffixes and is the reason role names match across sets at all.
- **`_stampHttpSurface` may become dead.** `LocalApiServer` stamps `apiOriginated` on four (now six) rails. If dispatch is its only consumer, remove the stamp too; if anything else reads it, leave the stamp and remove only the dispatch consumers. Check before deleting — a half-removal leaves a field that looks meaningful and is not.
- **Byte-compatibility for ~4,000 installs.** A VS Code user who assigned a role to a real `vscode.Terminal`, with no same-named fleet terminal, must see identical behaviour. Only the collision case can change, and only in the fleet-first direction. Enumerate and test both.
- **Ordering is a hard prerequisite.** Landing this before the VS Code fleet view routes VS Code users' prompts into terminals VS Code cannot display — the reported bug, mirrored. See Dependencies.

## Edge-Case & Dependency Audit

**Race Conditions**
- Fleet membership is read live (`ptyListTerminals` / `_ptyTerminalNames`). A terminal that dies between resolution and delivery must fail honestly rather than fall back silently to a VS Code terminal with the same name — that fallback would resurrect the invisible-delivery failure under a different cause.
- Pty host restart changes the fleet set; resolution must not cache stale names across a restart.

**Security** — no new endpoint, verb or allowlist change. Removing a routing hint, not an authorization check. Confirm nothing gates privilege on `apiOriginated` before deleting it.

**Side Effects**
- In VS Code, a dispatch that previously went to a `vscode.Terminal` will go to a same-named fleet terminal instead. That is the intended consolidation and is only observable in the collision case — but it is a behaviour change and belongs in release notes.
- Deleting ~92 forwards produces a broad diff across four large provider files. Review by grepping for residual references, not by reading the whole diff.

**Dependencies & Conflicts**
- One agent stream per provider file (project PRD orchestration discipline). Touches `TaskViewerProvider.ts`, `KanbanProvider.ts`, `PlanningPanelProvider.ts`, `LocalApiServer.ts` — serialise against other work in those files.
- The uncommitted `dispatchCustomPromptToRole` threading in the working tree is throwaway. Keep it as the **reference list** of paths that need coverage, then delete it as part of this change. Committing it first to unblock a broken dev environment is fine and expected.

## Dependencies

- **`vscode-terminals-view-onto-pty-fleet.md` — HARD prerequisite.** This plan must not start until VS Code can render fleet terminals. Landing it first inverts the reported bug onto VS Code users.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is ordering: shipped before the VS Code fleet view, this plan sends editor users' prompts to terminals they cannot see — the exact failure it exists to eliminate, aimed at the larger install base. The second risk is the newly-exposed collision case, where a role name exists in both terminal sets and precedence was previously decided implicitly by the caller's surface; leaving that non-deterministic would trade a silent misroute for an unpredictable one. Mitigations: gate on the prerequisite, choose fleet-first precedence explicitly and test both collision directions, and make a dead-terminal resolution fail loudly rather than fall through to a same-named terminal in the other set.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Logic:** Remove the `allowPtyFleet` parameter from `_dispatchExecuteMessage` (`:18953`), `_attemptDirectTerminalPush` (`:19039`), `_isLikelyPtyDispatchTarget` (`:18898`), `_resolveAgentTerminalForPlan`, `_getAgentNameForRole` and `_tryFleetDeliveryForRole`. Resolution consults the fleet first, then `vscode.window.terminals` / `_registeredTerminals`, and delivers where the match lives. Remove `options?: { apiOriginated?: boolean }` from `dispatchCustomPromptToRole`, `dispatchConfiguredKanbanColumnAction`, `_handleTriggerAgentAction` and every intermediate wrapper. Delete `_orchestratorApiOriginated` and its assignments.
- **Edge Cases:** Preserve `_normalizeAgentKey` / `_stripIdeSuffix` matching; a resolved-then-dead terminal fails, it does not fall through.

### `src/services/KanbanProvider.ts` / `src/services/PlanningPanelProvider.ts`
- **Logic:** Delete `apiOriginated` forwarding (18 sites each), including `_dispatchWithPairProgrammingIfNeeded`'s pass-through to `executeCommand('switchboard.dispatchToCoderTerminal', …)` and the Airlock path.
- **Edge Cases:** The registry-first command seam (`commandRegistry.ts:51-57`, `hostSeams.ts:327-336`) executes in-process, so removing the argument does not change reachability.

### `src/services/LocalApiServer.ts`
- **Logic:** Remove `_stampHttpSurface`'s `apiOriginated` stamp **only if** dispatch is its sole consumer; otherwise leave the stamp and remove the dispatch readers.

### `scripts/check-dispatch-surface.js` (new) + `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** AST guard that fails if any parameter, property or field named `allowPtyFleet` / `apiOriginated` is reintroduced on the dispatch path. Cheap, and it is the ratchet that stops this class returning. Declare `typescript` in `devDependencies` — it currently resolves only as a transitive hoist.

## Verification Plan

Compilation and automated test execution are out of scope for this planning session; the checks below are specified for the implementing change.

### Automated
1. Role resolving to a fleet-only terminal delivers to the fleet, from both an HTTP caller and an in-editor caller — same result, no caller context involved.
2. Role resolving to a `vscode.Terminal`-only name delivers there, from both callers.
3. Collision case: name present in both sets resolves fleet-first, deterministically, in both call directions.
4. Resolved-then-dead fleet terminal fails honestly; it does not silently deliver to a same-named VS Code terminal.
5. Orchestrator wake (timer-fired, no request) delivers correctly with no remembered surface.
6. Grep assertion: zero `allowPtyFleet`; `apiOriginated` fully removed from the dispatch path.
7. Guard fails on a reintroduced parameter.

### Manual
1. **Browser cockpit:** every send-to-terminal button and board drag delivers to the visible fleet terminal.
2. **VS Code:** every equivalent path delivers to a terminal visible in the editor — fleet view or editor terminal.
3. **Standalone (`npx switchboard`):** all dispatch paths deliver to the fleet; nothing references a VS Code terminal.
4. **Collision:** with same-named terminals in both sets, confirm fleet-first in both hosts.
5. **PTY-less install:** dispatch falls back to `vscode.Terminal` in VS Code and fails closed with a stated reason in standalone — no dead clicks.
6. **Pair programming / Airlock / orchestrator** each deliver correctly in both hosts.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The change is overwhelmingly deletion, but it removes a distinction that ~4,000 shipped installs depend on behaving a particular way, it newly exposes a collision case that was previously decided implicitly, and it is only safe **after** the VS Code fleet view lands — the ordering constraint is the single most important thing about this plan.
