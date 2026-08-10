# Delete `allowPtyFleet` — Resolve Terminals by Name, Not by Caller Surface

## Goal

Delete the `allowPtyFleet` / `apiOriginated` surface flag and its hand-threaded forwarding sites across the provider files. Replace the question *"what kind of client is calling?"* with *"where does the named terminal actually live?"* — resolve a role/name across both terminal sets and deliver to whichever set holds it.

The flag exists for one reason: each host could only render one of two disjoint terminal sets, so dispatch had to guess by caller type. Once VS Code renders the PTY fleet (`vscode-terminals-view-onto-pty-fleet.md`), both supported hosts can display both sets and the guess has no job left.

> **Superseded:** "…and its ~92 hand-threaded forwarding sites across four provider files."
> **Reason:** Measured against the working tree on 2026-08-08, the flag is carried by **164 source lines across 9 files**, not 92 across 4 — and by a further **99 lines across 6 test files**, four of which are wired into CI. The four-file figure omits `extension.ts` (which owns the two *positional* command registrations that carry the flag), `DesignPanelProvider.ts`, `TicketsPanelProvider.ts`, `verbSchemas.ts` and `standalone/bootstrap.ts`. Sizing the change at four files leads a coder to a partial sweep, and a partial sweep of this flag is precisely the silent-positive failure the plan exists to remove.
> **Replaced with:** the verified inventory below.

**Verified inventory (working tree, 2026-08-08).** Lines matching `apiOriginated` or `allowPtyFleet`:

| File | Lines | Notes |
|---|---:|---|
| `src/services/TaskViewerProvider.ts` | 89 | 51 `apiOriginated` + 44 `allowPtyFleet`, overlapping on some lines |
| `src/services/KanbanProvider.ts` | 36 | mostly positional `executeCommand` args |
| `src/services/PlanningPanelProvider.ts` | 18 | incl. `_sendPromptToTerminal` creation guard |
| `src/extension.ts` | 8 | **2 registered commands take the flag positionally** |
| `src/services/LocalApiServer.ts` | 5 | plus `_stampHttpSurface` def + **6** call sites |
| `src/services/DesignPanelProvider.ts` | 4 | four `sendStitchTweakPrompt`-class arms |
| `src/services/verbSchemas.ts` | 2 | `triggerAction`, `sendToTerminal` field decls |
| `src/services/TicketsPanelProvider.ts` | 1 | `askAgentTask` forward |
| `src/standalone/bootstrap.ts` | 1 | `_apiOriginated` **positional placeholder** |
| **Source total** | **164** | **9 files** |
| `src/test/browser-planner-dispatch-surface.test.js` | 34 | **CI-gated** |
| `src/test/browser-stray-dispatch-surface.test.js` | 32 | **CI-gated** |
| `src/test/browser-direct-terminal-helpers.test.js` | 17 | **CI-gated** |
| `src/test/pty-dispatch-focus-contract.test.js` | 13 | **CI-gated** |
| `src/test/dispatch-analysis-scope-contract.test.js` | 2 | incidental |
| `src/test/analyst-direct-dispatch-regression.test.js` | 1 | incidental |
| **Test total** | **99** | **6 files** |

### Problem analysis and root cause

**What the flag does today.** `TaskViewerProvider._dispatchExecuteMessage` (`src/services/TaskViewerProvider.ts:18999`) takes the surface decision as its **sixth positional parameter, defaulting to `false`**:

```typescript
private async _dispatchExecuteMessage(
    workspaceRoot: string, targetAgent: string, payload: string,
    metadata: Record<string, any>,
    sender: string = 'sidebar',
    allowPtyFleet: boolean = false      // ← the surface decision
): Promise<boolean>
```

`_attemptDirectTerminalPush` (`:19085`) checks the PTY fleet **first, but only when the flag is set**; `_isLikelyPtyDispatchTarget` (`:18944`) returns `false` outright when it is not. Every call site must remember to pass it, and every wrapper above them must forward it — `dispatchCustomPromptToRole` (`:4744`), `dispatchConfiguredKanbanColumnAction` (`:4885`), `dispatchToCoderTerminal` (`:10106`), `_handleTriggerAgentActionInternal` (`:19242`), `_tryFleetDeliveryForRole` (`:18967`), `_handleSendAnalystMessage` (`:19591`), `_handleAirlockSendToCoder` (`:21617`), `_deliverPromptToPmTerminal` (`:24443`), `KanbanProvider._dispatchWithPairProgrammingIfNeeded` (`KanbanProvider.ts:5625`), and the orchestrator path.

**Why the shape is the bug, not the missing argument.** Drop the flag at any hop and the dispatch resolves a `vscode.Terminal`, delivers successfully, and returns `true` — no error, no log, no UI signal. It is a silent, *positive* failure. Observed on 2026-08-07: board drag-and-drop dispatched correctly from the browser while the send-to-terminal buttons on the same page did not, because `dispatchConfiguredKanbanColumnAction` forwarded the flag and `dispatchCustomPromptToRole` did not even declare the parameter. Same page, same rail, same transport — one chain carried the flag, the other could not.

> **Superseded:** "The uncommitted `dispatchCustomPromptToRole` threading in the working tree is throwaway. Keep it as the **reference list** of paths that need coverage, then delete it as part of this change. Committing it first to unblock a broken dev environment is fine and expected."
> **Reason:** Stale as of 2026-08-08. That threading is no longer uncommitted — it landed as `ea1077da` ("fix: thread apiOriginated through kanban dispatch command call sites"). `dispatchCustomPromptToRole` declares `options?: { apiOriginated?: boolean }` at `HEAD`, and the working tree's only remaining diff in these files is a trailing comma. There is no reference list sitting in the working tree to preserve.
> **Replaced with:** the reference list is `git show ea1077da --stat` plus the verified inventory table above. Read `ea1077da` as *evidence*, not as work-in-progress: the reported bug was patched by adding one more forwarding site to a shape that manufactures forwarding sites. That patch is the strongest argument for this plan — and it is itself part of what this change deletes.

**Why deletion becomes correct.** The disjointness is what forced the guess:

| Terminal set | Browser cockpit | VS Code (today) | VS Code (after the fleet view) |
|---|---|---|---|
| PTY fleet (`ptyHost.js` child) | ✅ | ❌ | ✅ |
| `vscode.window.terminals` | ❌ | ✅ | ✅ |

At release the supported hosts are the VS Code extension and standalone (`npx switchboard`). Standalone has no `vscode.Terminal` at all — the shim provides none — so the fleet is its only set and there is nothing to decide. VS Code, once it renders the fleet, can display both, so the correct target is simply wherever the named terminal exists. Neither configuration needs to know what kind of client asked.

The browser-served-by-the-extension-host configuration — the only one in which the question was ever meaningful — is transitional and will not be supported.

**Precedent that this resolution order already works.** `terminals.js:2056-2098` (the terminals-pane drag) delivers by naming an explicit terminal and posting to `/terminals/verb/ptySendPrompt`. It has never needed a surface flag because it never resolves by role — it already knows where the terminal lives. This plan generalises that property to every dispatch path.

**The flag carries three jobs, not two.** This is the load-bearing correction to the plan's original framing, and it is what makes a naive deletion reintroduce the bug:

1. **Resolution eligibility** — which names are even candidates. `_getAgentNameForRole` / `_getAgentNameForRoleGlobal` / `_findTerminalNameByWorktreePathAndRole` each build `const isEligible = (info) => allowPtyFleet || !(info?.purpose === 'pty' || info?.ideName === PTY_IDE_NAME)` over the state file's `state.terminals` map.
2. **Delivery target** — which set receives the push. `_attemptDirectTerminalPush` (`:19085`), `_tryFleetDeliveryForRole` (`:18967`), `sendToTerminal`'s fleet arm (`:13055`).
3. **Creation suppression** — *whether to spawn a `vscode.Terminal` at all when the role resolves to nothing*. `TaskViewerProvider.sendPromptToAgentTerminal:4553` and `PlanningPanelProvider._sendPromptToTerminal:1289` both do:

   ```typescript
   if (!terminal) {
       // A browser caller must not have a VS Code terminal spawned on its behalf.
       if (apiOriginated) { return false; }
       ...
       terminal = vscode.window.createTerminal({ ... });
   ```

Job 3 has **no successor under name-based resolution**, because its trigger is a role that resolves to *nothing in either set*. Name resolution answers "where does it live" only when it lives somewhere. Delete the flag naively and a browser click spawns an invisible `vscode.Terminal`, waits 5 s for the shell, sends the prompt into it and returns `true` — the identical silent-positive failure, relocated from the collision path to the miss path, with a fully green grep. **The create-if-missing policy must be decided explicitly in this change** (see Proposed Changes).

**The state file already holds both sets, and its iteration order is the hidden precedence.** `state.terminals` records fleet terminals with `purpose: 'pty'` / `ideName: PTY_IDE_NAME` alongside VS Code terminals. Today `isEligible` filters by that marker; with the flag gone, `isEligible` becomes always-true and the three role-matching loops `break` on the **first JSON key** that matches the role. Precedence would silently become object insertion order — nondeterministic across installs and across state-file rewrites. There is no single resolver to patch: the logic is duplicated across at least nine sites (`_getAgentNameForRole`, `_getAgentNameForRoleGlobal`, `_findTerminalNameByWorktreePathAndRole`, `_resolveAgentTerminalForPlan`, `_attemptDirectTerminalPush`, `_tryFleetDeliveryForRole`, `sendToTerminal`, `_deliverPromptToPmTerminal`, `sendPromptToAgentTerminal`).

**`_isTerminalLive` is VS Code-only, so "fleet-first" inverts itself on the global path.** `_isTerminalLive` (`:8255`) checks only `_registeredTerminals` and `vscode.window.terminals`. `_getAgentNameForRoleGlobal` (`:8285`) picks its candidate with *"try to find a live one first"* using that predicate. With the flag gone, every fleet candidate reports **not live**, so the loop systematically prefers a **stale VS Code name over a live fleet terminal** — the exact opposite of the intended precedence, arrived at silently.

> **Superseded:** `dispatch-surface-as-request-context-not-threaded-flag.md` — carry the surface decision in an `AsyncLocalStorage` request context read at the delivery primitive, instead of threading it as a parameter.
> **Reason:** It hardens a distinction that is being removed rather than removing its cause, and spends a large sweep across shipped provider files to make a transitional configuration robust. It also introduces an ambient-context mechanism with no precedent in this codebase.
> **Replaced with:** delete the distinction entirely once both hosts can render both terminal sets. Resolution by name needs no caller context, no ambient storage, and no threading.

## Metadata

- **Tags:** refactor, bugfix, backend, reliability
- **Complexity:** 8
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 6.
> **Reason:** 6 was scored against "~92 sites, four files, overwhelmingly deletion". The verified surface is 164 source lines across 9 files plus 99 lines across 6 test files; four CI gates assert the flag's *presence* and must be retired in the same change; two registered commands carry the flag as a **middle positional argument** with a live argument after it, in two different hosts; and the change must newly author a create-if-missing policy and a single precedence rule where none exists. That is multi-file coordination with a breaking-change surface on ~4,000 installs — squarely 7–8 by the scoring guide.
> **Replaced with:** **Complexity:** 8. (The routing recommendation is unchanged — 6 and 8 both route to Lead Coder — but the score drives batching, reviewer attention and the ordering gate, so the honest number matters.)

## User Review Required

None.

## Complexity Audit

### Routine

- Removing a trailing `allowPtyFleet` parameter from functions where it is the **last** argument (`_dispatchExecuteMessage`, `_attemptDirectTerminalPush`, `_findTerminalNameByWorktreePathAndRole`, `_getAgentNameForRoleGlobal`, `_resolveAgentTerminalForPlan`) — positionally safe.
- Deleting `options?: { apiOriginated?: boolean }` from the intermediate wrappers.
- Deleting `msg.apiOriginated` / `message.apiOriginated` reads in the `KanbanProvider`, `PlanningPanelProvider`, `DesignPanelProvider` and `TicketsPanelProvider` arms.
- Removing the two `apiOriginated: { type: 'boolean' }` field declarations from `verbSchemas.ts`. **Verified safe:** `validateVerbPayload` (`verbSchemas.ts:49`) iterates only over declared fields and there is **no `additionalProperties` handling anywhere in the file** — an undeclared extra field is ignored, never rejected. A browser build still sending `apiOriginated` will not 400. This satisfies PRD contract #5 (permissive, field-accurate schemas).

### Complex / Risky

- **Positional-argument shift on two registered commands — the highest-severity landmine.** `extension.ts:1651` registers `switchboard.triggerAgentFromKanban(role, sessionId, instruction, workspaceRoot, targetTerminalOverride, apiOriginated, bypassTriggerGate)` and `extension.ts:1675` registers `switchboard.triggerBatchAgentFromKanban(role, sessionIds, instruction, workspaceRoot, targetTerminalOverride, apiOriginated, analysisScope)`. In both, the flag is the **6th of 7** parameters. Deleting the 6th parameter without simultaneously deleting the 6th *argument* at every call site makes `bypassTriggerGate` receive `apiOriginated`'s boolean, and `analysisScope` receive a boolean where a `string | null` is expected — untyped through the `executeCommand` seam, so **no compile error**. `KanbanProvider` passes these positionally at `:5700`, `:5773`, `:8317`, `:8435`, `:9093`, `:9149`, `:9151`, `:9222`, `:9224`, `:9293`, `:9295`, `:9366`, `:9745`, `:10161`, `:10235`, `:10237`. `standalone/bootstrap.ts:832` holds the slot with a deliberately-unused `_apiOriginated` placeholder purely so `analysisScope` lands correctly. **Both hosts must change in the same commit, and every call site's argument list must be re-counted, not pattern-replaced.**
- **`bypassTriggerGate` must survive untouched.** It sits in the same options type as `apiOriginated` (`TaskViewerProvider.ts:227`/`:238`) and its docstring explicitly says it is *"deliberately separate from `apiOriginated`"* — a browser drag IS api-originated but is NOT an explicit command, so the CLI-triggers gate still binds to it. A regex sweep over "the surface flags" that also removes `bypassTriggerGate` silently re-enables accidental auto-dispatch on drag-drop. Same hazard for `analysisScope` (`:239`).
- **Creation-if-missing has no successor.** See Goal, job 3. The policy must be written, not inherited.
- **Precedence must be stated once, not nine times.** With `isEligible` always-true, three role-matching loops fall back to JSON key order. See Proposed Changes for the single-resolver requirement.
- **`_isTerminalLive` must become fleet-aware or fleet-first inverts.** See Goal.
- **Four CI-gated contract tests assert the flag exists.** `.github/workflows/integration-tests.yml` runs `test:contract:pty-dispatch-focus`, `test:contract:browser-planner-dispatch-surface`, `test:contract:browser-stray-dispatch-surface`, `test:contract:browser-direct-terminal-helpers`. Their assertions are literal source-regex matches such as `_dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {}, 'sidebar', allowPtyFleet)` and `` `_isLikelyPtyDispatchTarget must short-circuit to false when !allowPtyFleet || !this._ptyHostPort` ``. Every one of them goes **red** on the first line of this change. They must be deleted (with their `package.json` scripts and CI steps) and replaced by the new guard in the **same commit** — the branch is otherwise unmergeable.
- **`_orchestratorApiOriginated` disappears with the flag.** It exists (`:687`, `:9356`, `:9514`, `:9561`, `:11074`) purely because the orchestrator wake fires from a timer with no request in scope, so it could not read a surface. Under name-based resolution there is nothing for it to remember — delete the field and all five sites rather than leaving a vestigial `true`. Note `browser-stray-dispatch-surface.test.js:100` asserts the assignment exists; it retires with the rest.
- **`_isLikelyPtyDispatchTarget` changes meaning, it does not disappear.** Its fleet-name match (`_normalizeAgentKey` / `_stripIdeSuffix` over `_ptyTerminalNames`) is exactly the resolution this plan wants; only the `!allowPtyFleet` early-return goes. Keep the normalisation — it handles IDE suffixes and is the reason role names match across sets at all. Keep the `_ptyTerminalNames` **snapshot** read too: its docstring records that it deliberately avoids a round-trip *because it sits on the dispatch hot path*.
- **Hot-path round-trip regression.** `_tryFleetDeliveryForRole` currently returns `false` immediately when `!apiOriginated`, so sidebar dispatches never touch the pty host. Remove that guard and **every** sidebar dispatch on an install with a running fleet issues a `ptyListTerminals` WS round-trip to the child process before doing anything else. The `!this._ptyHostPort` half of the guard still short-circuits fleet-less installs, so the regression is invisible to anyone testing without a fleet. Serve resolution from the `_ptyTerminalNames` snapshot on the hot path and reserve the live round-trip for the delivery step.
- **`_stampHttpSurface` becomes dead — verify, then remove.** `LocalApiServer.ts:1766` defines it; six rails call it (`:1798`, `:1827`, `:1856`, `:1897`, `:1945`, `:1974`). Its only stamped field is `body.apiOriginated = true`. A repo-wide read of every `apiOriginated` consumer (TVP, Kanban, Planning, Design, Tickets) shows all of them are dispatch-surface readers — **no consumer uses it for telemetry, auth, or response shaping**. Confirmed no authorization decision keys on it. So the stamp and its six call sites go. Also delete `LocalApiServer.ts:1268`'s literal `apiOriginated: true` in the `triggerAction` verb call; keep `bypassTriggerGate: true` on that same call.
- **Byte-compatibility for ~4,000 installs (PRD contract #2).** A VS Code user who assigned a role to a real `vscode.Terminal`, with no same-named fleet terminal, must see identical behaviour. Only the collision case and the create-if-missing case may change. Enumerate and test both.
- **Ordering is a hard prerequisite.** Landing this before the VS Code fleet view routes VS Code users' prompts into terminals VS Code cannot display — the reported bug, mirrored onto the larger install base. **Board state 2026-08-08: `vscode-terminals-view-onto-pty-fleet.md` is in `CREATED`. The prerequisite is not started. This plan is not dispatchable yet.** See Dependencies.

## Edge-Case & Dependency Audit

**Race Conditions**

- Fleet membership is read live (`ptyListTerminals`) or from the `_ptyTerminalNames` snapshot. A terminal that dies between resolution and delivery must fail honestly rather than fall back silently to a VS Code terminal with the same name — that fallback would resurrect the invisible-delivery failure under a different cause.
- The `_ptyTerminalNames` snapshot is refreshed on every `ptyListTerminals` forward. A pty-host restart changes the fleet set; resolution must not serve a pre-restart snapshot as authoritative for *delivery*. Snapshot for the advisory/precedence read, live list for the delivery attempt.
- `_findTerminalNameByWorktreePathAndRole` runs its scan inside `this.updateState(...)`. Adding a fleet consultation inside that callback would hold the state lock across an async WS round-trip. Resolve fleet membership **before** entering `updateState`, or from the snapshot.

**Security** — no new endpoint, verb or allowlist change. Removing a routing hint, not an authorization check. **Verified:** no privilege, rate limit, or allowlist decision reads `apiOriginated` — the only non-dispatch reader is `LocalApiServer.ts:1268`, which pairs it with the separate `bypassTriggerGate`. `_isValidAgentName` remains the path-segment guard on `_dispatchExecuteMessage` and is untouched.

**Side Effects**

- In VS Code, a dispatch that previously went to a `vscode.Terminal` will go to a same-named fleet terminal instead. That is the intended consolidation and is only observable in the collision case — but it is a behaviour change and belongs in release notes.
- The create-if-missing policy change is user-visible: a path that used to silently spawn an editor terminal may now decline, or may spawn a fleet terminal. Whichever is chosen, it must produce a visible outcome, never a dead click (PRD contract #6).
- The diff spans 9 source files and deletes 4 test files. Review by grepping for residual references and by re-counting `executeCommand` argument lists, not by reading the whole diff.

**Dependencies & Conflicts**

- One agent stream per provider file (PRD orchestration discipline). Touches `TaskViewerProvider.ts`, `KanbanProvider.ts`, `PlanningPanelProvider.ts`, `LocalApiServer.ts`, `DesignPanelProvider.ts`, `TicketsPanelProvider.ts`, `extension.ts`, `verbSchemas.ts`, `standalone/bootstrap.ts` — serialise against other work in those files.
- `verbSchemas.ts` is shared across all provider work (PRD) — append/edit serialised.
- The positional-command edits in `extension.ts` + `standalone/bootstrap.ts` + all `KanbanProvider` call sites are **one atomic unit**. They cannot be split across agent streams or commits.
- `src/services/__tests__/KanbanProvider.test.ts` and the standalone parity/return-contract ratchets (`npm run parity:check`, `npm run verb-returns:check`, `npm run push-routing:check`) must stay green; none of them key on this flag, but the sweep touches files they measure.

## Dependencies

None.

> **Superseded (2026-08-10, user decision):** *"`vscode-terminals-view-onto-pty-fleet.md` — HARD prerequisite… This plan must not start until VS Code can render fleet terminals."*
> **Reason:** The prerequisite was wrong. PTY terminals are **not** going to be rendered inside VS Code, and were never wanted there. They live in the browser cockpit, which the operator opens and watches. A VS Code-originated dispatch landing in a browser PTY terminal is the **intended** outcome of this plan, not a failure mode — the operator can see it, it is simply not in the editor. Gating on in-editor rendering blocked the plan behind a capability nobody is building.
> **Replaced with:** No prerequisite. This plan is independently codeable now.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that the flag carries a **third** job — suppressing `vscode.Terminal` *creation* for callers that cannot see one — which name-based resolution cannot answer, because its trigger is a role that resolves to nothing; deleting the flag without authoring a replacement policy reproduces the silent-positive failure on the miss path while every grep-based success check stays green. Third is mechanical: the flag is a **middle positional argument** on two registered commands in two hosts, so a partial sweep shifts `bypassTriggerGate` / `analysisScope` into its slot with no compile error, and four CI-gated contract tests assert the flag's presence and go red on the first edit. Mitigations: write the create-if-missing policy explicitly; consolidate precedence into one resolver and make `_isTerminalLive` fleet-aware; treat the command-signature edits as one atomic unit; retire the four contract tests and land the replacement ratchet in the same commit.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context.** The provider owns every role→terminal resolution path and the two delivery primitives. Nine sites independently re-implement "look here, then there".

- **Logic — introduce one resolver, then delete the flag.** Add a single private seam and route all role/name resolution through it:

  ```typescript
  type TerminalTarget = { name: string; kind: 'pty' | 'vscode' };

  private async _resolveTerminalTarget(
      roleOrName: string,
      opts: { workspaceRoot?: string; worktreePath?: string; live?: boolean }
  ): Promise<TerminalTarget | undefined>
  ```

  Precedence, stated once, in this order:
  1. `worktreePath` + role match (existing `_findTerminalNameByWorktreePathAndRole` semantics), fleet-preferred within that match.
  2. **Live** matches beat dead ones. Among live matches, **fleet wins**.
  3. Among dead-only matches, fleet wins.

  > **Superseded:** "**Recommended: fleet first, `vscode.Terminal` fallback**… Record the choice where a reader will find it."
  > **Reason:** Correct in direction, incomplete in mechanism. Stated as a flat rule it silently loses to `_getAgentNameForRoleGlobal`'s pre-existing "try to find a live one first" pass, whose `_isTerminalLive` predicate (`:8255`) inspects only `_registeredTerminals` and `vscode.window.terminals` — so every fleet candidate reads as dead and a **stale VS Code name beats a live fleet terminal**. A flat rule also has to be re-implemented in each of the three role-matching loops, which is how iteration-order precedence gets in.
  > **Replaced with:** **live-first, fleet-wins-among-equals**, implemented once in `_resolveTerminalTarget`, with `_isTerminalLive` extended to consult `_ptyTerminalNames` (or a `_isFleetTerminalLive` companion consulted by the resolver) so "live" spans both sets. This preserves today's liveness semantics for the ~4,000 shipped installs *and* delivers fleet-first where it was intended to bite.

- **Logic — creation policy (the missing successor to job 3).** `sendPromptToAgentTerminal` (`:4523`, guard `:4553`) and `_deliverPromptToPmTerminal` (`:24443`) currently spawn a `vscode.Terminal` when nothing resolves, gated by `if (apiOriginated) { return false; }`. Replace that gate with an explicit, host-derived policy — **not** with an unconditional spawn:
  - **Standalone:** never spawn a `vscode.Terminal` (there is none); create/attach in the fleet, or return `false` with a stated reason.
  - **VS Code, fleet running:** spawn in the **fleet**, so the result is visible in both the fleet view and the browser cockpit. Keep the existing 2000 ms spawn settle / 3000 ms startup-command settle behaviour for whichever set is spawned into.
  - **VS Code, no fleet (`!this._ptyHostPort`):** spawn a `vscode.Terminal` exactly as today — this is the byte-compat path for the shipped install base.

  Whatever branch is taken, the function must return an honest boolean and the caller must surface a reason on `false` (PRD contract #6: no dead clicks).

- **Logic — deletions.** Remove the `allowPtyFleet` parameter from `_dispatchExecuteMessage` (`:18999`), `_attemptDirectTerminalPush` (`:19085`), `_isLikelyPtyDispatchTarget` (`:18944`), `_resolveAgentTerminalForPlan` (`:8379`), `_getAgentNameForRole` (`:8337`), `_getAgentNameForRoleGlobal` (`:8285`), `_findTerminalNameByWorktreePathAndRole` (`:8413`) and `_tryFleetDeliveryForRole` (`:18967`, plus its public wrapper `:18988`). Remove `options?: { apiOriginated?: boolean }` from `dispatchCustomPromptToRole` (`:4744`), `dispatchConfiguredKanbanColumnAction` (`:4885`), `dispatchToCoderTerminal` (`:10106`), `sendPromptToAgentTerminal` (`:4523`), `_handleTriggerAgentActionInternal` (`:19242`), `_handleSendAnalystMessage` (`:19591`), `_handleAirlockSendToCoder` (`:21617`), `_deliverPromptToPmTerminal` (`:24443`), `_handleDispatchProjectManager` (`:24413`), `startOrchestratorFromKanban` (`:9349`), `askAgentTask` (`:7514`) and every intermediate wrapper. Delete `apiOriginated` from the dispatch options type (`:227`) — **keep `bypassTriggerGate` (`:238`) and `analysisScope` (`:239`)**. Delete `_orchestratorApiOriginated` and all five sites (`:687`, `:9356`, `:9514`, `:9561`, `:11074`). Delete the `data?.apiOriginated &&` condition from `sendToTerminal`'s fleet arm (`:13055`) so the arm resolves by name for every caller.
- **Implementation note.** `_isLikelyPtyDispatchTarget` keeps its `_ptyTerminalNames` snapshot read and its `!this._ptyHostPort` short-circuit; only `!allowPtyFleet ||` is removed. Keep `_normalizeAgentKey` / `_stripIdeSuffix` everywhere — they are why role names match across sets at all.
- **Edge Cases.** A resolved-then-dead terminal fails; it does not fall through to a same-named terminal in the other set. Fleet consultation happens outside `updateState` callbacks. The `!this._ptyHostPort` guard stays on every fleet path so no-PTY installs never round-trip and never throw.

### `src/extension.ts` + `src/standalone/bootstrap.ts` + `src/services/KanbanProvider.ts` — atomic positional unit

- **Context.** `switchboard.triggerAgentFromKanban` and `switchboard.triggerBatchAgentFromKanban` take the flag as the **6th of 7** positional parameters, registered independently in both hosts, called positionally from ~16 sites in `KanbanProvider`.
- **Logic.** Delete the 6th parameter from `extension.ts:1651` and `extension.ts:1675`, from `standalone/bootstrap.ts:832` (the `_apiOriginated` placeholder), and the 6th **argument** from every `KanbanProvider` call site listed in the Complexity Audit — in one commit. Also drop the `options` forward on `switchboard.dispatchToCoderTerminal` (`extension.ts:1789`) and the `apiOriginated` field on `switchboard.askAgentTask` (`extension.ts:2106-2111`).
- **Implementation.** Re-count each call site's argument list by hand after editing. Prefer converting both commands to a **single trailing options object** if the coder judges the churn acceptable — that permanently removes the positional-shift hazard for `bypassTriggerGate` / `analysisScope`. If not converted, the new guard (below) must assert the argument counts.
- **Edge Cases.** The registry-first command seam (`commandRegistry.ts:51-57`, `hostSeams.ts:327-336`) executes in-process, so removing the argument does not change reachability — but it also provides **no type checking**, which is exactly why the shift is silent.

### `src/services/KanbanProvider.ts` / `src/services/PlanningPanelProvider.ts` / `src/services/DesignPanelProvider.ts` / `src/services/TicketsPanelProvider.ts`

- **Logic.** Delete `apiOriginated` forwarding: Kanban 36 lines (incl. `_dispatchWithPairProgrammingIfNeeded` `:5625`/`:5659`, `_distributePlannerDispatch` `:5668`, and the Airlock/orchestrator paths), Planning 18 lines (incl. `_sendPromptToTerminal` `:1272`–`:1289` — whose creation guard needs the same successor policy as `sendPromptToAgentTerminal`), Design 4 lines (`:2977`, `:3008`, `:3039`, `:3071`), Tickets 1 line (`:3406`).
- **Edge Cases.** `PlanningPanelProvider._sendPromptToTerminal` must keep returning `Promise<boolean>` and must keep reaching the fleet via the public `tryFleetDeliveryForRole` wrapper — that wrapper stays, minus its `apiOriginated` parameter.

### `src/services/LocalApiServer.ts`

- **Logic.** Delete `_stampHttpSurface` (`:1766`) and its six call sites (`:1798`, `:1827`, `:1856`, `:1897`, `:1945`, `:1974`) — verified to have no non-dispatch consumers. Delete `apiOriginated: true` from the `triggerAction` verb call at `:1268`; **keep `bypassTriggerGate: true` on that call.**

### `src/services/verbSchemas.ts`

- **Logic.** Remove the `apiOriginated: { type: 'boolean' }` field from `triggerAction` (`:245`) and `sendToTerminal` (`:1219`). Safe because `validateVerbPayload` ignores undeclared fields (no `additionalProperties` in the file), so an older browser build still sending the field is not rejected — PRD contract #5 preserved.

### Test retirement — same commit, not a follow-up

- **Logic.** Delete `src/test/pty-dispatch-focus-contract.test.js`, `src/test/browser-planner-dispatch-surface.test.js`, `src/test/browser-stray-dispatch-surface.test.js`, `src/test/browser-direct-terminal-helpers.test.js`; delete their four `package.json` scripts (`test:contract:pty-dispatch-focus`, `test:contract:browser-planner-dispatch-surface`, `test:contract:browser-stray-dispatch-surface`, `test:contract:browser-direct-terminal-helpers`) and their four steps in `.github/workflows/integration-tests.yml`. Clean the two incidental references in `src/test/dispatch-analysis-scope-contract.test.js` and `src/test/analyst-direct-dispatch-regression.test.js` without changing what those tests assert.
- **Implementation.** Port the assertions worth keeping into a new `src/test/terminal-resolution-contract.test.js`: precedence is live-first/fleet-wins; a resolved-then-dead target fails rather than falling through; `_isLikelyPtyDispatchTarget` still short-circuits on `!this._ptyHostPort`; the creation policy branches as specified per host.

### `scripts/check-dispatch-surface.js` (new) + `package.json` + `.github/workflows/integration-tests.yml`

- **Logic.** A ratchet guard that fails if `allowPtyFleet` or `apiOriginated` reappears in the dispatch path, plus an argument-count assertion for the two `switchboard.trigger*AgentFromKanban` registrations if they were not converted to an options object. Wire as `npm run dispatch-surface:check` and add a CI step next to `push-routing:check`.

  > **Superseded:** "AST guard that fails if any parameter, property or field named `allowPtyFleet` / `apiOriginated` is reintroduced on the dispatch path… Declare `typescript` in `devDependencies` — it currently resolves only as a transitive hoist."
  > **Reason:** The transitive-hoist observation is correct (`typescript@5.9.3` is present in `node_modules`, absent from both `dependencies` and `devDependencies`), but the AST vehicle is over-built for the check. **No existing guard script in `scripts/` parses TypeScript** — `check-push-routing.js`, `check-verb-return-contract.js`, `check-protocol-parity.js` and `check-claude-mirror.js` are all text/regex ratchets over source. The target here is *zero occurrences of two identifiers*, which a text scan answers exactly; an AST walk adds a parse step, a new top-level dependency and a novel pattern to buy nothing. The plan's own verification item already phrases the check as a grep.
  > **Replaced with:** a per-file occurrence-count ratchet modelled directly on `scripts/check-push-routing.js` — baseline 0 for both identifiers across the source tree, ceilings that only ever ratchet down, plus a positional-arity assertion on the two command registrations. Still declare `typescript` in `devDependencies` **independently of this guard**: `npm run compile-tests` invokes `tsc` and currently depends on a transitive hoist, which is a latent CI break unrelated to this plan. Flag it; do not let it gate this change.

## Verification Plan

Compilation and automated test execution are out of scope for this planning session; the checks below are specified for the implementing change.

### Automated Tests

1. Role resolving to a fleet-only terminal delivers to the fleet, from both an HTTP caller and an in-editor caller — same result, no caller context involved.
2. Role resolving to a `vscode.Terminal`-only name delivers there, from both callers.
3. **Collision, both live:** name present and live in both sets resolves fleet-first, deterministically, in both call directions.
4. **Collision, fleet live / VS Code dead:** resolves to the fleet (guards the `_isTerminalLive` fleet-awareness fix).
5. **Collision, fleet dead / VS Code live:** resolves to the live VS Code terminal (guards live-first).
6. **Miss path — creation policy:** role resolves to nothing. Assert standalone never constructs a `vscode.Terminal`; assert VS Code + fleet spawns in the fleet; assert VS Code without a fleet spawns a `vscode.Terminal` exactly as at `HEAD` (byte-compat).
7. Resolved-then-dead fleet terminal fails honestly; it does not silently deliver to a same-named VS Code terminal.
8. Orchestrator wake (timer-fired, no request) delivers correctly with no remembered surface; `_orchestratorApiOriginated` is gone.
9. **Positional integrity:** `switchboard.triggerAgentFromKanban` still receives `bypassTriggerGate` as a boolean at its correct slot, and `switchboard.triggerBatchAgentFromKanban` still receives `analysisScope` as `string | null` — asserted from both `extension.ts` and `standalone/bootstrap.ts` registrations.
10. Schema regression: a `triggerAction` / `sendToTerminal` payload that still carries `apiOriginated` validates OK (undeclared fields ignored).
11. Guard: `npm run dispatch-surface:check` reports zero `allowPtyFleet` and zero `apiOriginated` across the source tree, and fails when either is reintroduced.
12. Existing ratchets stay green: `npm run parity:check`, `npm run verb-returns:check`, `npm run push-routing:check`, `npm run catalog:check`.
13. The four retired contract tests and their CI steps are gone; `terminal-resolution-contract.test.js` is wired in their place.

### Manual

1. **Browser cockpit:** every send-to-terminal button and board drag delivers to the visible fleet terminal.
2. **VS Code:** every equivalent path delivers to a terminal visible in the editor — fleet view or editor terminal.
3. **Standalone (`npx switchboard`):** all dispatch paths deliver to the fleet; nothing references a VS Code terminal; the miss path fails closed with a stated reason.
4. **Collision:** with same-named terminals in both sets, confirm fleet-first in both hosts, and confirm the live/dead permutations from Automated 4–5.
5. **PTY-less install:** dispatch falls back to `vscode.Terminal` in VS Code, including create-if-missing, unchanged from `HEAD`. No dead clicks.
6. **Drag-drop gate:** a browser board drag is still blocked by the CLI-triggers gate (`bypassTriggerGate` intact), while `POST /kanban/dispatch` still bypasses it.
7. **Pair programming / Airlock / orchestrator / Design Stitch tweak / Tickets ask-agent** each deliver correctly in both hosts.

## Recommendation

Complexity 8 → **Send to Lead Coder.** The change is largely deletion, but it removes a distinction ~4,000 shipped installs depend on, it must newly author two policies the flag was implicitly carrying (precedence and create-if-missing), it edits a middle positional argument on two commands across two hosts where a partial sweep fails silently, it retires four CI gates in the same commit, and it is only safe **after** the VS Code fleet view lands — which, as of 2026-08-08, has not started. The ordering constraint remains the single most important thing about this plan.
