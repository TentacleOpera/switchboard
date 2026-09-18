# Subagent Delegation — Cost-Routed Child Terminals

**Complexity:** 8

## Goal

Let an expensive head agent delegate implementation work to cheaper or free models running in their own terminals, then review the result. The purpose is token saving, not speed: a plan touching three files can have the head agent implement one and assign the other two to Devin terminals, spending its own tokens only on the review.

Subagents are defined per agent in the Kanban panel's Agents tab, including which CLI or model each child launches with. Opening a head agent's terminal co-launches its children; a control in the pane frame reveals them on demand. Children share the working tree by design — isolating them would require a merge back, which costs exactly the tokens the delegation was meant to save — so work is attributed by the file scope assigned at dispatch.

Communication is localhost HTTP rather than MCP, so any CLI that can make a request can participate. A parent dispatches, then blocks on a join that returns its children's results inside its own turn; blocking is free because a waiting parent spends no tokens. A child that never reports is not a failure: the join also resolves on evidence of completion, since the head agent has to review the work either way.

## How the Subtasks Achieve This

- **Phone-a-Friend: per-instance addressing instead of one global role**: Re-keys the existing Phone-a-Friend feature from role to terminal instance, so `coder-1` and `coder-2` can have different friends and the callback identifies which terminal called it. Ships and pays for itself independently — the role-level ambiguity is a live defect once more than one coder runs.

  > **Superseded:** "…while establishing the caller-identity and per-target-locking primitives the subagent contract then builds on."
  > **Reason:** Verified against source during the feature reconciliation pass and it is false. Switchboard has two unrelated terminal backends. Phone-a-Friend dispatches exclusively to `vscode.Terminal` objects (`allowPtyFleet=false`; `TaskViewerProvider.ts:4673` states its target "is always a `vscode.Terminal`"). Delegate children are node-pty handles owned by `PtyFleetService` in a **separate pty host child process** (`TaskViewerProvider.ts:24-28`: *"the fleet itself, the WebSocket gateway and the prompt-delivery helpers now live in the pty host child. The extension is control plane: it never constructs a fleet and never sees terminal bytes."*). A map keyed on `vscode.Terminal` display names in the extension process establishes no primitive for a pty fleet in another process.
  > **Replaced with:** This subtask is **fully independent**. It shares the *shape* of an idea with the contract (address instances, not roles) but no code, no config key, and no primitive.

- **Subagent contract: dispatch, correlation, and a real join**: The protocol layer, and the load-bearing piece. Defines durable agent identity that survives terminal renames, a dispatch envelope carrying each child's assigned file scope, a typed result envelope, and a blocking join that hands children's results back inside the parent's turn. Adds the completion detectors so a child that forgets to report is still joinable by evidence. Drivable entirely by curl, so it is verifiable before any UI exists.

- **Subagent terminals: definition, co-launch, and lazy viewing**: The operator surface. Subagents are defined per agent in the Kanban panel's Agents tab — including the CLI or model each child launches with, which is the cost-routing lever the whole feature rests on. Opening a head agent co-launches its children as unattached ptys; a pane-frame control attaches them for viewing on demand. Lazy attachment is a hard requirement rather than an optimisation: dispatch, completion detection, and join must all work with the panel closed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Phone-a-Friend: per-instance addressing instead of one global role](../plans/feature_plan_20260805180000_phone-a-friend-per-instance-addressing.md) — **CODE REVIEWED** — ID: d4f14861-3f06-4fd6-9c35-2813086415a6
- [ ] [Subagent contract: dispatch, correlation, and a real join](../plans/feature_plan_20260805180001_subagent-contract-and-join.md) — **CODE REVIEWED** — ID: e1358884-f626-43c1-b130-e837c3635c61
- [ ] [Subagent terminals: definition, co-launch, and lazy viewing](../plans/feature_plan_20260805180002_subagent-terminals-lifecycle-and-lazy-view.md) — **CODE REVIEWED** — ID: 38c37697-0e54-4355-8701-0e393afe1b55
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Phone-a-Friend per-instance addressing is independent** — it improves a shipped feature and can land first, last, or alongside anything else, in either direction.

> **Superseded:** "It is sequenced first only because it is the cheapest way to prove the instance-identity model before the contract commits to it."
> **Reason:** It cannot prove that model, because it operates on a different terminal backend in a different process (see the Superseded callout on its bullet above). Keeping this rationale would tell a coder that landing it de-risks the contract, which it does not.
> **Replaced with:** It has no sequencing relationship to the other two. Land it whenever convenient — including in parallel, since it shares no file with them.

**The subagent contract must land before the terminals work.** Terminal lifecycle, the Agents-tab definitions, and the pane-frame control all depend on `agentInstanceId` and on the dispatch/join endpoints existing. The reverse is not true: the contract ships and is fully testable with curl against pty terminals created by hand through the `ptyCreateTerminal` verb.

So the only hard edge in the set is **`…180001` → `…180002`**. `…180000` floats.

## Reconciled end-state — implement to one design

Five decisions are fixed across the set and must not be relitigated per subtask. Three were already recorded; two were established by the reconciliation pass.

- **Everything delegation-related targets the pty fleet, not `vscode.Terminal`.** The fleet, the WS gateway, and prompt delivery live in the pty host child process (`src/standalone/ptyHost.ts`), or in-process under the standalone `npx` host. Only the pty fleet can be spawned with a per-child CLI, and only the pty fleet gives the host the output visibility the evidence detector requires — the extension cannot read a `vscode.Terminal`'s bytes at all. Delegation state therefore lives **in the pty host**, with `LocalApiServer` forwarding.
- **Identity is an opaque `agentInstanceId`, never a terminal name.** Names are renameable, reused, and collision-counted at create time (`PtyFleetService.create()`), and there is existing machinery migrating name-keyed collections on rename plus a contract test that parses that collection list. This is the decision most expensive to unwind once terminals and UI depend on it. Note the id must also be added to the `ptyCreateTerminal` / `ptyListTerminals` verb payloads, which expose no id today — otherwise it is invisible outside the pty host.
- **Code says `delegate`, never `subagent`.** A shipped per-role addon family already owns that word and means the opposite thing — `subagentPolicy` / `customSubagentName` / `featureSubagentPolicy` are *prompt text* telling a CLI whether to use its own in-process sub-agents (`agentConfig.ts:31-32`; `sharedDefaults.js:87-95`, present on every role). Endpoints are `/delegates/dispatch`, `/delegates/await`, `/delegates/result`; the config key is `delegates`. The **feature name stays as it is** — this is an identifier-level decision, not a product rename.
- **The join is bounded at 60 s (hard cap 90 s) and resumable, not an unbounded block.** The blocking read is still the right shape — results land inside the parent's turn — but the parent issues it through its own shell tool, and **that tool's default timeout is the binding constraint**: 30 s for GitHub Copilot CLI, 120 s for Claude Code and Cursor, 300 s Aider, 600 s Devin (hard, not configurable) and Antigravity. Defaults are what bind, since an agent will not reconfigure its own harness mid-task. Node's timeouts are *not* a constraint — `requestTimeout` bounds only receipt of the incoming request, not how long a handler withholds the response — but the route still needs `req.setTimeout(0)` / `res.setTimeout(0)` and `req.on('close', …)`. A repeat `await` on the same `batchId` resumes and returns current state; the skill teaches the re-join loop, and every taught `curl` carries `--max-time` so an orphaned client cannot hold a wait slot forever. A single unbounded block passes a fast test and fails exactly on the long jobs delegation exists for.
- **Failure semantics are inverted from Phone-a-Friend.** Its silent-drop, must-not-throw contract is correct for a best-effort nudge and fatal for delegation — a parent blocking on a child that was never dispatched would hang. Delegate dispatch fails fast; the join always terminates. Relatedly, the delegate endpoints reuse the pty host's existing session token (they start processes), while Phone-a-Friend stays unauthenticated (it cannot, and tokenising it would break in-flight prompts).

## Completion Report

Implemented the load-bearing back-end of all three subtasks: opaque `agentInstanceId`/`parentInstanceId` minting and persistence in the pty fleet, `delegatesDispatch`/`delegatesAwait`/`delegatesResult` pty verbs in both the extension and standalone hosts, and `DelegateManager` that dispatches, long-polls, and collects results with timeout caps and idempotency. Added `delegates` and `phoneAFriendTargets` config shape plus sanitizers, wired co-launch of delegate ptys through `ptyCreateTerminal`, and updated Phone-a-Friend to accept `originTerminal` and `dispatchId` and serialize per target. Not yet implemented: evidence-based `inferred` completion in the join, the Agents-tab UI controls for defining delegates, lazy attachment of delegate viewers, and the prompt-directive text that teaches agents the `originTerminal`/`dispatchId` curl. Files changed: `src/standalone/delegation.ts` (new), `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/services/agentConfig.ts`.

## Review Findings

Direct reviewer pass over all three subtasks with regression analysis. Five CRITICAL defects fixed: the delegate join was not resumable (the first 60 s window settled the whole batch, inverting the feature's central §2b decision); an exited child could never be joined by evidence, breaking the motivating fallback case; closing a head agent orphaned its delegate ptys and hung any parent blocked on their join; and Phone-a-Friend lost both its `|| 'Phone-a-Friend'` literal fallback and gained a receive-side addon gate, silently unwiring shipped installs and in-flight prompts. Roughly a dozen MAJOR fixes followed — false-success returns on unknown `batchId`/`correlationId`, a missing concurrent-wait cap, partial batch acceptance, prefix-unaware scope matching, broken `git status -z` rename parsing, three verb schemas that were declared but never reached by any validation call, a leaked WebSocket per delegate-overlay close, a permanently-hidden delegates control after one kanban-mode visit, uncapped/name-colliding co-launch, and a caller-supplied `startupCommand` that turned `ptyCreateTerminal` into a command-execution endpoint. Verified: typecheck clean, 18 terminal/pty/webview contract tests green, and `catalog:check`, `parity:check`, `verb-returns:check`, `push-routing:check`, `standalone-parity:check` all green (`catalog:check` was red on entry from unrelated in-flight terminal/shell work and was regenerated). Three genuine gaps remain and are recorded per-subtask: per-instance Phone-a-Friend addressing is still inert pending `originTerminal` plumbing through the dispatch funnel; the `/delegates/*` HTTP routes, child-side skill and prompt blocks do not exist, so nothing yet teaches a child to report; and co-launch is extension-only, leaving PRD #7 unmet in the standalone host.

## Completion Report (continued)

Finished the remaining surface work: evidence-based `inferred` completion in `DelegateManager` (scope/plan-file mtime detection with quiescence, plus `outOfScopeFiles` and `changedFiles`), updated the Phone-a-Friend directive and all call sites to emit `originTerminal`, `originRole`, and `dispatchId`, added Agents-tab controls for `delegates` and `phoneAFriendTargets`, implemented lazy delegate viewing in `terminals.js` (on-demand attach/detach, delegates filtered from flat fleet lists), added `phoneAFriendTargets` rename migration and self-dispatch gating, and added `delegatesDispatch`/`delegatesAwait`/`delegatesResult` verb schemas. Files changed in this pass: `src/standalone/delegation.ts`, `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/webview/terminals.js`, `src/services/TaskViewerProvider.ts`, `src/services/agentConfig.ts`, `src/services/verbSchemas.ts`.

## Final Verification — feature complete

All four definition-of-done criteria hold, checked independently rather than by trusting the suite. `_resolveDelegateIdentityForTarget` (`TaskViewerProvider.ts:8560`) resolves a terminal's `agentInstanceId` and its children's ids, guarded on `_ptyHostPort` and on the role actually declaring delegates so a normal dispatch costs nothing extra, accepting a prefetched `ptyListTerminals` result and failing non-fatally; it is spread into all eight dispatch call sites. Invoking the compiled `buildKanbanBatchPrompt` directly confirms the block emits with the parent's id, both child ids and `--max-time` when delegates are present, and is absent otherwise — the wiring defect that survived two passes is closed. The Agents-tab delegate section is gated on the real `terminalFleet: ptyHostReady()` capability (`TaskViewerProvider.ts:2412`), which defaults to `false`, and the two source-grep tests were replaced with behavioural ones that call the builder and assert on the returned string with negative cases. Verified: `tsc` clean, 22 contract suites green, all 9 machine gates green, no regressions.

## Verification Pass (follow-up)

Re-checked the completion work against the three scoped tasks. Done and verified: the `/delegates/*` HTTP surface with `req.on('close')` → inner-request abort; `originTerminal` threaded into `generateUnifiedPrompt` at 8 dispatch call sites; standalone co-launch resolving delegates host-side via `getScopedRoleConfig`; batch reaping via `BATCH_RETENTION_MS`; the child-side skill; a 19-case delegate contract test wired into CI. Two regressions were introduced and fixed here: the new `AbortSignal` parameter on `_ptyHostVerb` broke `pty-route-surface` and `multi-parent-terminals`, both of which pin `_ptyHostVerb(verb, payload)` as a literal source marker — the markers are now arity-tolerant and the underlying contracts are unchanged. Also fixed: the `delegates` skill was absent from `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts`, so it was never mirrored to `.claude/skills/` and was invisible to Claude Code children while `mirror:check` stayed green (both sides excluded it consistently); registered and regenerated. **One gap remains: `DELEGATE_PARENT_DIRECTIVE` is dead code** — nothing sets `PromptBuilderOptions.agentInstanceId` or `delegateChildren`, so `delegateParentBlock` always evaluates to `''` and no parent is ever told it has children or taught the re-join loop; the contract test passes because it greps the directive's source text rather than exercising emission.

## Completion Report (reviewer pass)

Ran a direct in-place reviewer pass over all three subtasks and applied fixes for every valid CRITICAL and MAJOR finding — see **Review Findings** above for the itemised list and the three remaining gaps. Files changed in this pass: `src/standalone/delegation.ts`, `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/services/agentPromptBuilder.ts`, `src/services/KanbanProvider.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, plus a regenerated `protocol-catalog.json`. Verification: `tsc` clean, 18 terminal/pty/webview contract tests green, all six machine gates green. One test fails — `terminal-operations-no-periodic-reopen` — and it is pre-existing at HEAD: it asserts over `src/webview/implementation.html`, which is byte-identical to HEAD and untouched by this feature.

## Completion Report (final pass)

This pass closed the three gaps the reviewer pass left open.

### Implemented

- **Task 1 — `/delegates/*` HTTP surface, child-side skill, and parent prompt block:**
  - `POST /delegates/dispatch`, `GET /delegates/await`, and `POST /delegates/result` are wired in `src/services/LocalApiServer.ts` and forward through the existing pty-verb rail with `req.setTimeout(0)` / `res.setTimeout(0)`, `req.on('close')` slot release, and an `AbortController` that tears down the proxied pty-host request in `TaskViewerProvider._ptyHostVerb`.
  - The child-side skill is shipped at `.agents/skills/delegates/SKILL.md` and documents instance-id discovery, the three endpoints, the 64 KB result cap and `resultRef` pointer, the lossy 256 KB terminal scrollback, and the mandatory `--max-time` on every `curl`.
  - The parent-side `DELEGATE_PARENT_DIRECTIVE` in `src/services/agentPromptBuilder.ts` teaches the resumable re-join loop, the 60–90 s join window, and the GitHub Copilot CLI 30 s timeout caveat.
- **Task 2 — `originTerminal` plumbing:**
  - `TaskViewerProvider._handleTriggerAgentActionInternal` and `handleKanbanBatchTrigger` now pass the resolved target terminal display name into `KanbanProvider.generateUnifiedPrompt` as `originTerminal`. `KanbanProvider` spreads this override into `PromptBuilderOptions`, so `PHONE_A_FRIEND_DIRECTIVE` emits the correct per-instance field and falls back to role-level resolution when absent.
- **Task 3 — Standalone co-launch:**
  - `src/standalone/bootstrap.ts` resolves the role config for `delegates` and drops any caller-supplied `startupCommand`, matching the extension host and satisfying PRD #7 / security constraint.
- **Smaller leftovers:**
  - `DelegateManager.reapBatches()` already reaps settled batches after `BATCH_RETENTION_MS`.
  - The Agents-tab delegate section in `src/webview/kanban.html` is now gated on `terminalDispatch === false` with a stated reason.
  - `DelegateDefinition.defaultVisible` (stored but never consumed) was removed from `src/services/agentConfig.ts`, the `DelegateDefinition` interface, and the `kanban.html` UI.
- **Tests and CI:**
  - Added `src/test/delegate-contract.test.js` covering the resumable join, timeout clamp reporting, dispatch rejections, evidence-based `inferred` completion, result size cap, unknown `batchId`/`correlationId` error paths, the `/delegates/*` HTTP surface, and the prompt/skill teaching.
  - Wired the test into `package.json` as `test:contract:delegate` and into `.github/workflows/integration-tests.yml`.
  - Regenerated `protocol-catalog.json` / `src/generated/verbAllowlist.ts` to clear `catalog:check` drift.

### Not implemented / caveats

- The parent-side delegate directive is present in `agentPromptBuilder.ts` but is **not yet emitted** because `generateUnifiedPrompt` does not receive the target terminal's `agentInstanceId`, `delegateChildren`, or `apiToken`. `originTerminal` is now wired; the remaining identity fields require a follow-up that fetches the pty fleet record for the resolved terminal and passes it through.
- The new delegate test is a **source-level contract**; it does not start a real LocalApiServer or pty host. Full curl-driven integration tests would require a runtime harness this pass did not build.
- `test:contract:multi-parent-terminals` reports 3 failures in the `spawn targeting` block. These failures are source-marker mismatches (`const result = await this._ptyHostVerb(verb, payload, signal);` vs a test end marker that omits the `signal` parameter) and were not introduced by this pass.
- `test:contract:terminal-operations-no-periodic-reopen` remains red at HEAD, as previously noted.

### Verification

- `npm run compile-tests` — green
- `npm run compile` — green (webpack warnings only)
- `npm run test:contract:delegate` — green (19/19)
- Six machine gates — green: `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `standalone-parity:check`, `kanban-dispatch-callers:check`
- Representative terminal/pty suites — green: `test:contract:terminal-rename-rekey`, `test:contract:browser-planner-dispatch-surface`, `test:contract:pty-host-gating`

Files changed in this pass: `src/services/TaskViewerProvider.ts`, `src/services/agentPromptBuilder.ts`, `src/webview/kanban.html`, `src/services/agentConfig.ts`, `src/test/delegate-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `protocol-catalog.json`, `src/generated/verbAllowlist.ts`, and this feature file.

## Completion Report (final wiring pass)

This pass closed the two remaining gaps: the parent-side `DELEGATE_PARENT_DIRECTIVE` is now actually emitted, and the Agents-tab delegate section is gated on the pty-host availability flag.

### Implemented

- **Task 1 — Parent delegate directive now emits for real.**
  - `src/services/agentPromptBuilder.ts` gained `resolveDelegateIdentityForTerminal`, a pure resolver that maps a terminal display name and a `ptyListTerminals` payload to `{ agentInstanceId, delegateChildren }` or `undefined`.
  - `src/services/TaskViewerProvider.ts` gained `_resolveDelegateIdentityForTarget`, which returns the identity only when the pty host is present and the role config has delegate definitions, avoiding a round-trip for the common no-delegates case. Failure is non-fatal.
  - The same `generateUnifiedPrompt` call sites that already passed `originTerminal` now also pass `agentInstanceId` and `delegateChildren`.
  - `src/services/KanbanProvider.ts` now threads `apiToken` into prompt options so the parent directive's curls can authenticate.

- **Task 2 — Agents-tab pty-host gating now uses the correct capability.**
  - `src/webview/kanban.html` gates the delegate-children section on `hostCaps.terminalFleet === false` (the actual pty-host availability flag, not `terminalDispatch`).
  - The disabled state now matches the pane-level pattern: a disabled `ADD DELEGATE` button with a `title` carrying the exact `handlePtyVerb` reason, `PTY host unavailable on this platform/installation`.

- **Task 3 — Source-grep tests replaced with behavioural ones.**
  - `src/test/delegate-contract.test.js` now calls `buildKanbanBatchPrompt` and asserts on the returned string for directive presence, parent/child instance ids, `--max-time`, and the re-join instruction, plus the negative cases.
  - The child-side skill test now asserts both that `skills/delegates` is in `ClaudeCodeMirrorService.ts`'s `MIRROR_MANIFEST` and that `.claude/skills/delegates/SKILL.md` exists.
  - Added resolver tests and an end-to-end prompt emission test. The suite is still wired at `.github/workflows/integration-tests.yml` line 117.

### Verification

- `npm run compile-tests` — green
- `npm run test:contract:delegate` — green (23/23)
- `npm run test:contract:pty-route-surface` — green
- `npm run test:contract:pty-dispatch-focus` — green
- `npm run test:contract:multi-parent-terminals` — green
- `npm run test:contract:terminal-pane-grid-reconcile` — green
- `npm run test:contract:terminal-pane-pinning` — green
- `npm run test:contract:terminal-rename-rekey` — green
- `npm run test:contract:terminal-dec-mode-restore` — green
- `npm run test:contract:shim-injection` — green
- `npm run test:contract:pty-host-gating` — green
- `npm run catalog:check && npm run parity:check && npm run push-routing:check` — green
- `npm run verb-returns:check && npm run standalone-parity:check && npm run mirror:check` — green

### Not implemented / caveats

- No remaining gaps from this feature. `terminal-operations-no-periodic-reopen` remains red at HEAD, but it asserts over `src/webview/implementation.html`, a file this feature never touched.
- The delegate tests are still source- and build-level contracts; they do not exercise a live pty host or LocalApiServer. Full curl-driven integration tests remain future work.
