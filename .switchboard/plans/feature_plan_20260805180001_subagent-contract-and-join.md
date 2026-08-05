# Subagent contract: dispatch, correlation, and a real join

## Goal

Define and implement the protocol layer for head-agent → subagent delegation over localhost HTTP: a dispatch envelope with durable agent identity, a correlation id, a typed result envelope, and a **blocking join** endpoint that lets a parent agent wait for its children and receive their results inside its own turn.

No terminal lifecycle work and no UI. When this lands, a subagent tree is drivable entirely by hand with `curl` — which is the point: if the contract is right, whether the child is Claude Code, Google Antigravity, or anything else that can make an HTTP request becomes an implementation detail.

### What this is for — cost routing, not speed

**The purpose is token saving.** An expensive head agent delegates *writing* to a cheaper or free model, then spends its own (expensive) tokens only on *reviewing*. A plan touching three files: the head agent implements one itself and assigns the other two to cheaper terminals, then checks all three.

Three consequences that shape every decision below, and that are easy to get wrong by assuming this is a parallelism feature:

- **Children share the working tree.** That is the design, not a compromise. Isolating a child means merging its work back, and a merge costs the head agent exactly the tokens the delegation was meant to save. No worktrees, no branches, no per-child sandboxes.
- **Concurrency is incidental.** Children may run one at a time. Nothing here should be justified by throughput, and no complexity should be accepted to buy it.
- **A blocked parent is a *cheap* parent.** Waiting costs no tokens. This makes the blocking join the natural fit rather than a compromise — the parent is idle by design while a cheaper model works.

Attribution therefore comes from **assigned scope**, not isolation: the dispatch says which paths a child owns, so changes to those paths are that child's. This is simpler and cheaper than isolation and it is what makes the fallback detector work.

### Where this lives — the pty fleet, in the pty host child process

*(Established during the feature-level reconciliation pass; this plan previously left "terminal" ambiguous, and the ambiguity spans two processes.)*

Switchboard has **two unrelated terminal backends**, and this contract belongs to exactly one of them:

| | `vscode.Terminal` | pty fleet |
|---|---|---|
| Owner | extension host, in-process | **separate pty host child process** (`src/standalone/ptyHost.ts`), or the standalone `npx` host in-process (`src/standalone/bootstrap.ts:1462`) |
| Created by | `vscode.window.createTerminal` | `PtyFleetService.create()` (`src/standalone/ptyFleetService.ts:74`) |
| Host sees output? | **No** | Yes — `TerminalWsGateway` sees every byte |
| Can the host spawn one on demand? | Yes | Yes, via the `ptyCreateTerminal` verb (`ptyHost.ts` `handlePtyVerb`) |
| Used by Phone-a-Friend | **Yes, exclusively** (`allowPtyFleet=false`; `TaskViewerProvider.ts:4673`) | No |

`TaskViewerProvider.ts:24-28` states the split outright: *"PtyFleetService is imported for purgePtyTerminals ONLY — the fleet itself, the WebSocket gateway and the prompt-delivery helpers now live in the pty host child. The extension is control plane: it never constructs a fleet and never sees terminal bytes."*

**The contract must target the pty fleet**, for two independent reasons:

1. **Only the pty fleet can be spawned and cost-routed.** `ptyCreateTerminal` takes a role, name, cwd and worktree path; a child terminal running a *different CLI* is only reachable through this path (see `…180002`). There is no equivalent for `vscode.Terminal` that the host controls end to end.
2. **Only the pty fleet gives the host output visibility, which the evidence detector requires.** The quiescence half of "scope change + quiescence" needs pty output. The extension cannot read a `vscode.Terminal`'s bytes at all, so an evidence detector over `vscode.Terminal` children is not implementable.

**Architectural consequence: the endpoints live on `LocalApiServer`, but the state lives with the fleet.** Dispatch, join bookkeeping, and completion detection all need the fleet's handles and its output stream. In the extension deployment those are in the pty host child, reached over `this._ptyHostPort` (`TaskViewerProvider.ts:552`, `:8276`) via the existing `/terminals/verb/<verb>` forwarding route (`LocalApiServer.ts:3527`). Two viable placements, and the choice must be made before coding:

- **(A) Delegation state in the pty host**, exposed as new pty verbs, with `LocalApiServer` forwarding. Keeps state next to the handles and the output stream. Costs: the long-lived join must be held across the forwarding hop.
- **(B) Delegation state in `LocalApiServer`**, consuming fleet events over the existing channel. Keeps the long-poll on one server. Costs: it must subscribe to per-child output/quiescence signals across the process boundary, which does not exist today.

**Decision: (A).** The completion detectors are the expensive part and they are useless away from the output stream; adding a cross-process output-signal channel purely to relocate the state is strictly more work than holding a proxied request. The standalone host collapses the hop entirely (same process), so (A) is also the shape that is identical in both deployments.

### Naming — `subagent` is already taken, and means something else

*(Found during reconciliation; not previously recorded.)*

A **shipped** per-role addon already owns this word:

- `subagentPolicy?: 'default' | 'noSubagents' | 'useSubagents' | 'customSubagent'` and `customSubagentName?: string` (`agentConfig.ts:31-32`, sanitized `:258-264`)
- `featureSubagentPolicy` / `featureCustomSubagentName`, plus `SUBAGENT_POLICY_RADIO` labelled **"Subagent Policy"** with the tooltip *"Control how the agent handles subagent spawning"* (`sharedDefaults.js:87-95`) — present on **every** role (`:22-34`)
- `CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE`, `buildFeatureSubagentClause` (`agentPromptBuilder.ts:861`, `:1058-1068`, `:1880-1889`)

That feature is **prompt text telling the CLI whether to use its own in-process sub-agents** (e.g. Claude Code's Task tool). It spawns no terminals and involves no host state. This feature's "subagents" are host-spawned sibling terminals with their own ptys running different models. They are unrelated mechanisms that would sit next to each other in the Agents tab under the same word.

> **Superseded:** endpoints named `POST /subagents/dispatch`, `GET /subagents/await`, `POST /subagents/result`, and a child-side skill describing "subagents".
> **Reason:** Direct collision with the shipped `subagentPolicy` addon family, which means the opposite thing (in-CLI sub-agents, no terminals). An operator configuring "Subagent Policy: No Subagents" on an agent that has host-spawned "subagents" defined is reading one word for two mechanisms — and so is every future maintainer grepping `subagent`.
> **Replaced with:** the new concept is **delegate** / **delegate terminal** throughout code, config, endpoints and the child-side skill: `POST /delegates/dispatch`, `GET /delegates/await`, `POST /delegates/result`, config key `delegates`. The **feature keeps its name** ("Subagent Delegation — Cost-Routed Child Terminals") — this is an identifier-level decision, not a product rename, and the feature name already carries "Delegation". Do not introduce any new identifier containing `subagent`.

### Problem analysis — why the existing model does not extend

There is no bug here. Phone-a-Friend works correctly for what it is. The issue is that its design has three properties that are each fatal to delegation, and all three follow from one thing: **it never has to cross a turn boundary.**

**1. There is no return path, because nothing waits.**
The whole flow is: prompt text tells the agent to curl; the agent curls; the host injects a prompt into another terminal. Nobody blocks, nothing is returned, and no value ever reaches the caller. A subagent system needs dispatch → work → **return** → parent continues. A pty gives you dispatch. It gives you nothing for the return, because a pty is one-way text injection into stdin: the host can write into it and cannot ask it anything.

**2. The parent is not listening when the answer arrives.**
A CLI agent is a request/response loop. Mid-turn it is not reading anything a host could hand it; idle at a prompt, injected text *starts a new turn* rather than resuming the old one. So "the child returns a result to the parent" can only mean one of three things, and only one of them composes:

| Shape | Mechanism | Joins? |
|---|---|---|
| **Blocking read** | Parent's next action is a long-polled HTTP call that returns when children finish | **Yes** — results arrive as that call's return value, inside the parent's turn |
| Mailbox + drain | Children write to an inbox; parent is told to poll between steps | No — relies on the agent remembering an instruction |
| Injection as new turn | Host writes "child N returned X" into the parent's terminal | No — two children returning become two unrelated turns, no ordering, no fan-in |

Blocking read is the only shape that produces a real fan-in, keeps results in the parent's context, and survives the parent being mid-reasoning. **This plan builds the blocking read.** Injection stays available as a breadcrumb/notification channel only. Mailbox-and-drain is rejected as a result path: Phone-a-Friend already demonstrates the failure mode, where agents faithfully curl and nothing tells them the far end was never listening.

**2b. The parent's own tool timeout bounds the block, so the join must be resumable.**
*(Added during reconciliation — this is the largest unrecorded risk in the original plan.)*

The blocking read is correct, but "the parent blocks until children finish" is not achievable as a single call, because the parent does not control how long its own shell invocation may run. A CLI agent issues the join through its shell/bash tool, and **that tool's timeout is the binding constraint** — not the network, and not the server.

Measured ceilings per host CLI (external research, confirmed 2026-08-06):

| CLI | Default | Max configurable | On timeout |
|---|---|---|---|
| GitHub Copilot CLI | **30 s** | ~1380 s | `TimeoutError` + partial output |
| Claude Code | **120 s** | 600 s | `SIGINT`/`SIGTERM`, `[Command timed out after X seconds]` + partial output |
| Cursor | **120 s** | 600 s+ | `^C`, "interrupted / timed out" + partial stdout |
| Aider | 300 s | unlimited | `subprocess.TimeoutExpired` + partial output |
| Devin | 600 s | 600 s (hard, not configurable) | `SIGKILL`/`SIGTERM` on the process group + partial logs |
| Google Antigravity | 600 s | 1200 s | sandbox cancels + partial stream |

The **defaults** are what matter, because an agent will not reconfigure its own harness mid-task. The floor across the CLIs this feature targets is 30–120 s — an order of magnitude below the 600 s a single blocking join would need for a real delegation. A cheaper model implementing two files routinely exceeds ten minutes.

> **Superseded:** "Independently, the Node HTTP server sets **no** `requestTimeout` / `headersTimeout` / `keepAliveTimeout` (verified: no such assignment exists in `LocalApiServer.ts`), so Node's defaults govern a held request."
> **Reason:** The verification (no assignment in `LocalApiServer.ts`) is correct, but the inference from it was wrong. Node's `requestTimeout` (default 300 s) bounds **only receipt of the incoming request** — headers plus body. Once the request stream ends and the `request` event fires, Node clears that timer and stops caring how long the handler takes to write the response. `headersTimeout` (60 s) is cleared as soon as headers parse; `keepAliveTimeout` (5 s) applies *between* requests; `server.timeout` has defaulted to `0` (disabled) since Node v13. These defaults are identical across Node 18/20/22/24, which covers every runtime in play (VS Code 1.101+ ships Node 22.15.x under `ELECTRON_RUN_AS_NODE=1`; older builds 20.x/18.x). **Node was never the constraint.** Presenting it as a co-equal reason weakened the argument by attaching it to a false claim.
> **Replaced with:** The constraint is the **caller's tool timeout, alone**. Node still needs two defensive measures, but for socket hygiene rather than duration: set `req.setTimeout(0)` / `res.setTimeout(0)` on the join route so no inactivity timer can abort a deliberately-held response, and register `req.on('close', …)` to release the wait slot the instant the client disconnects.

Therefore the join is specified as a **bounded, resumable long-poll**, not an unbounded block:

- **`timeoutMs` defaults to 60 s and is hard-capped server-side at 90 s.** That fits inside the 120 s default of Claude Code and Cursor with real margin, and inside every configurable ceiling above. It does *not* fit GitHub Copilot CLI's 30 s default — a Copilot-hosted parent must raise `timeoutSec`, and the skill should say so rather than leaving it to be discovered as a mystery failure. Cap server-side; do not trust a caller-supplied value.
- **A repeat `await` on the same `batchId` is idempotent and resumes**: it returns current per-child state and keeps waiting for the rest. Re-joining is the normal path, not an error path. A 15-minute delegation is ~10–15 cheap iterations.
- The child-side and parent-side skills teach the loop explicitly: *join → if `complete:false` and no per-child terminal status, join again.* Each iteration is one cheap tool call returning promptly; the parent stays idle-but-cheap across many of them.
- **The taught curl MUST carry `--max-time`** — see the orphaned-client hazard in Side Effects. This is a correctness requirement, not a nicety.

This preserves every property the blocking read was chosen for — results land in the parent's turn, fan-in is real, ordering is kept — while surviving a bounded tool timeout. A single unbounded block would appear to work in a fast test and fail exactly when delegation pays off, on the long jobs.

**A child that forgets to report is recoverable, and the join must treat it that way.**
Self-reporting is an instruction in a prompt, so some children will not do it. That is survivable here in a way it is not for most RPC, because **the parent has to inspect the child's work regardless** — a subagent's answer is a claim, not a result. So the join resolves on *evidence of completion* as well as on a report, and says which it got:

| Detector | Signal | Strength |
|---|---|---|
| **Reported** | child POSTs `/delegates/result` | Authoritative — carries the child's own account |
| **Evidence** | files under the child's *assigned scope* changed, then quiescent | Strong — scope was assigned at dispatch, so attribution is by construction |
| **Plan-file advance** | plan file mtime advances | Already this system's completion contract, and plan files are written at the end, so it is a terminal signal rather than a mid-work one |
| **Quiescence** | no pty output for N seconds *and* one of the above | Never sufficient alone — an idle child may be stuck, not done |

The parent then receives `status: "reported"` (here is what it said) or `status: "inferred"` (it stopped and left these changes; go look). Both are successful joins. Only "nothing happened at all, and it went quiet" is a timeout.

**Assigned scope is what makes this work in a shared tree.** The dispatch names the paths a child owns; changes under those paths are that child's by definition. No isolation is required, and none should be added — the head agent is reviewing the diff either way, which is the whole point of delegating.

**3. Identity is a role, and roles are not instances.**
The current payload is `{ planFile, originRole }` and the target resolves through `_getAgentNameForRole('phone_a_friend', …)` — a workspace singleton. There is no caller identity, no target identity beyond a role, and no correlation id. A tree needs all three.

**And its failure semantics are exactly inverted for this use.**
`_dispatchPhoneAFriend` is documented as silent-drop, "MUST NOT throw", because a throw becomes a 500 and the directive tells the agent the call succeeds regardless. Correct for a best-effort nudge. Catastrophic for a subagent: a parent blocking on a join for a child that was never dispatched hangs until timeout with no diagnosis. This contract fails **fast on dispatch** and **hard on join timeout**.

### Why HTTP and not MCP

Dropping MCP costs typed tool schemas and buys transport simplicity plus reach — anything that can curl can participate, which is the actual prize. The cost is that the protocol must be *taught* to the child in its prompt. That is a solved pattern here: the `switchboard-orchestration` skill already teaches fleet agents to read the board, plans, worktrees, inbox and session log over localhost HTTP. The delegate contract is a natural extension of that surface, not a new one.

## Metadata

- **Complexity:** 8
- **Tags:** feature, backend, reliability, api

> **Superseded:** Complexity 7.
> **Reason:** Reconciliation added three items of real weight that were not scoped: the delegation state must live in the **pty host child process** and the long-lived join must survive the `LocalApiServer → pty host` forwarding hop (a shape with no precedent in this codebase — there is no existing long-poll on this server); `agentInstanceId` must be threaded through the fleet handle *and* the `ptyCreateTerminal` / `ptyListTerminals` verb payloads, which today expose no id at all; and the join must be resumable rather than a single block. Still 8 rather than 9 — no new framework, and every endpoint is individually simple.
> **Replaced with:** Complexity 8.

## User Review Required

None. The four decisions worth surfacing are made here rather than deferred: **blocking join over mailbox-drain** (reasoned above), **bounded + resumable rather than unbounded** (§2b), **fail-fast dispatch** (below), and **delegation state in the pty host, not `LocalApiServer`** (option A above).

## Complexity Audit

**Substantial — this is the load-bearing piece.** Not because any single endpoint is hard, but because the contract is what every later phase is built on, and getting identity or failure semantics wrong is expensive to unwind once terminals and UI depend on it.

### Routine

- The three endpoint shells and their JSON shapes.
- Idempotency keyed on `correlationId` — a map lookup before create.
- Depth and live-count caps — counters checked at dispatch.
- Result size cap with a `resultRef` pointer, mirroring the session-log pointer pattern the orchestration surface already uses.
- Adding an `agentInstanceId` field to `ExtendedTerminalHandle` and minting it in `PtyFleetService.create()`.

### Complex / Risky

| Area | Why it costs |
|---|---|
| Durable agent identity, across a process boundary | Terminal display names are renameable and reused. Identity must survive that *and* be visible to the control plane, which does not own the fleet. `ptyListTerminals` currently returns `friendlyName, role, status, pid, startTime, worktreePath, cwd` — **no id** — so every id-keyed operation needs new payload surface. |
| Blocking join across the forwarding hop | Long-poll needs timeouts, partial results, cancellation on parent death, and a bound on held connections — and in the extension deployment the request is proxied `LocalApiServer → pty host`. Both hops must release together. No existing long-poll in this server to copy. |
| Completion detectors | Two-signal (change **+** quiescence) with a settle window that must survive a thinking pause without firing mid-work. The failure mode is a false success, which is worse than a timeout. |
| Result envelope | Must carry success, failure, and *partial* outcomes distinguishably, or the parent cannot reason about a mixed batch. |
| Teaching the contract | A skill document the child reads. Wrong or vague here and agents improvise, which is unrecoverable at runtime. Must also teach the re-join loop. |

## Edge-Case & Dependency Audit

### Race Conditions

- **The evidence detector must not fire mid-work.** This is the main risk in the fallback. A child that has written one file is indistinguishable from one that has finished, on file-presence alone. Changes must be paired with a settle window over both further changes and pty output, and the window must be long enough to survive an agent pausing to think between edits. Too short and the parent reviews half-written work believing it complete — worse than a timeout, because it looks like a success.
- **A quiet child is not necessarily a finished child.** Stuck, awaiting input, and crashed all look like silence. Quiescence qualifies a positive signal; it never constitutes one.
- **The head agent edits the same tree concurrently.** It may be implementing file 1 while children do 2 and 3. The detector must not attribute the parent's own changes to a child — another reason scope is required rather than inferred, and a reason the parent's own paths should be excluded from every child's scope at dispatch.
- **A late report after an `inferred` join is not an error.** The child may POST its result after the join already resolved on evidence. Accept and record it (the parent may join again, or a later reader may want the account); never 500, and never resurrect a settled batch.
- **A re-join must not double-consume.** With a resumable join (§2b), two overlapping `await` calls for one batch are possible (a retry issued before the first returned). Both must observe the same state; neither may clear a pending result the other has not seen.
- **Idempotency.** An agent retrying a dispatch (network blip, its own retry logic) must not spawn a second child. Key dispatch on the correlation id; a repeat returns the existing dispatch rather than creating one.
- **Do not reuse `_phoneAFriendInFlight`.** That chain serializes *all* dispatches because there is one target. Delegates need per-child concurrency with per-target locking, and the pty-level `withTerminalLock` (`src/standalone/ptyPromptDelivery.ts:9`) already prevents input splicing at the terminal — note it is **per-process state** (`ptyHost.ts:182`), which is another reason delegation state belongs in the pty host.

### Security

- **The localhost surface is unauthenticated, but the pty host already has a token — reuse it.**
  > **Superseded:** "Decide the auth posture for `/subagents/*` explicitly before it ships."
  > **Reason:** Deferring a decision that has an obvious answer already present in the code. The pty host mints a per-session token (`crypto.randomBytes(32).toString('hex')`) and hands `TerminalWsGateway` a `async () => token` resolver (`ptyHost.ts:43-45`); the WS terminal gateway is already gated by it, and `bootstrap.ts:1492` does the same in the standalone host.
  > **Replaced with:** `/delegates/*` reuses the existing pty-host session token, matching the WS gateway. This is non-negotiable here in a way it is not for the read-only verb rail: **these endpoints start processes and inject prompts into them**, so an unauthenticated caller on the loopback interface can run arbitrary CLIs in the user's tree. Phone-a-Friend stays open (it cannot spawn anything, and tokenising it would break in-flight prompts) — the asymmetry is deliberate.
- **Scope is not a permission boundary and must not be described as one.** Children share the tree; nothing enforces scope at the filesystem level. Its jobs are attribution and a stated expectation to review against. Any wording implying enforcement will be believed.
- **Nested trees need a depth cap.** A child that can dispatch is a parent. Without a hard depth limit, one prompt can fan out exponentially. Cap depth and total live delegates per root, and make exceeding it a dispatch-time error with a clear reason — a runaway fan-out discovered at runtime is unrecoverable.

### Side Effects

- **Bound the held connections.** Every blocking join holds a socket. Cap concurrent waits and cap duration; a parent that dies mid-join must release its slot (tie the wait to the request lifetime, not to a timer alone). In the extension deployment, the proxied inner request must be aborted when the outer one is — otherwise the pty host leaks a slot per abandoned join.
- **Result size.** A child returning a large diff or log into the parent's context is a context-budget problem, not a transport one. Cap result payload size and return a pointer (file path / session-log offset) above the cap, in the same shape the orchestration surface already uses for the session log.
- **Partial results are the normal case, not an error.** Three of five children succeed, one errors, one times out. The envelope must express that per child so the parent can act on what it has. A shape that can only say "the batch succeeded/failed" forces the parent to discard good work.
- **A dispatched child's prompt is delivered through the pty, so delivery is `sendRobustText`-class, not raw writes.** Use the existing `ptyPromptDelivery` helpers (`sendPromptToPty`, `:26`) rather than a new write path; they hold `withTerminalLock` and handle chunking.
- **Adding `agentInstanceId` to the fleet handle changes registry persistence.** `PtyFleetService.updateRegistryState()` writes handles to the DB, and `purgePtyTerminals` clears them on boot. A new field must round-trip or the id is fresh on every restore, silently breaking correlation across a reload.

### Dependencies & Conflicts

- **Identity must not be the terminal name — and today it is the *only* identity.** `PtyFleetService.create()` (`ptyFleetService.ts:74-80`) derives the name by collision-counting (`${role}-${counter}` while `this.terminals.has(name)`), stores handles in `Map<name, handle>`, and `rename()` mutates `handle.name` in place while the gateway `moveMap`s every name-keyed collection (`terminalWsGateway.ts:610-651`, with the sync warning at `:622` and a contract test that *parses* the collection list — `src/test/terminal-rename-rekey-contract.test.js:19,55`). So: mint an opaque `agentInstanceId` in `create()`, add it to `ExtendedTerminalHandle`, persist it through `updateRegistryState`, and let the display name stay a label. Correlation, dispatch, and join all key on the id. **This is the single decision most expensive to change later.**
- **The id must be exposed on the verb payloads, which today omit it entirely.** `ptyCreateTerminal` returns only `{ friendlyName, role, status }` and `ptyListTerminals` returns `{ friendlyName, role, status, pid, startTime, worktreePath, cwd }` (`ptyHost.ts`, `handlePtyVerb`). Both must carry `agentInstanceId`, or a head agent cannot enumerate its children by id and the contract is unusable from outside the pty host. This is a required step, not a nicety.
- **`agentInstanceId` does not exist anywhere in the codebase today** (verified by grep) — it is entirely net-new, so there is no prior shape to stay compatible with and no migration burden. Unreleased work: clean break, no compat shim.
- **Dispatch fails fast; join fails on timeout.** `POST /delegates/dispatch` returns non-2xx when a child cannot be reached, is not configured, or is already busy — the parent must learn this at dispatch, not by waiting. `GET /delegates/await` must always terminate: on all-children-done, on timeout, or on cancellation. Never an unbounded wait.
- **A child dispatched without a scope has no evidence detector.** Report-or-timeout only. Do not fall back to "any change anywhere in the tree" — in a shared tree that attributes the head agent's own edits, and every sibling's, to whichever child happens to be waiting.
- **Overlapping scopes are the caller's error, and must be rejected at dispatch.** Two children assigned the same path make both detectors ambiguous. Refuse the batch and name the overlap rather than resolving it silently.
- **Evidence detection needs no attached viewer.** The gateway sees all output whether or not a panel is watching, and file changes are filesystem facts. This keeps the fallback compatible with the lazy-attach requirement in `…180002` — dispatch, completion detection, and join must all work with the panel closed.
- **Project PRD contracts apply to every new endpoint** (`.switchboard/projects/browser-switchboard/prd.md`):
  - **#4 return-in-body** — each endpoint returns its data in the HTTP body; failure branches including the aggregate `catch` return `{success:false, error}`, never a bare ack and never a false success.
  - **#5 schema validation at the boundary** — validate each payload at dispatch (`verbSchemas.ts`), permissive and field-accurate: require only fields the handler dereferences. Note `verbSchemas.ts` is a shared file — serialise edits to it against other provider work.
  - **#6 capability-gating honesty** — in the extension deployment the pty host may not be running (`ptyReady` false, `_ptyHostPort` undefined; `TaskViewerProvider.ts:1901`, `:1916`, `:1951`). `/delegates/*` must then report the capability as **absent** with a stated reason, never a stub success and never a hang. A parent that gets a clean "delegation unavailable: pty host not running" can do the work itself; one that gets a false 202 blocks forever.
  - **#7 two-layer completion** — the endpoints must be wired in **both** the extension host and `src/standalone/bootstrap.ts`. Wired-but-unimplemented and implemented-but-unwired are both incomplete.
- **Depends on nothing in `…180002`.** This ships and is testable with curl against manually-created pty terminals. `…180002` depends on it, not the reverse.
- **Independent of `…180000`.** Phone-a-Friend's per-instance addressing operates on `vscode.Terminal` display names in the extension process and shares no primitive with this contract (see the table in the Goal). Do not couple the two config surfaces.

## Dependencies

- **Prerequisite for:** `feature_plan_20260805180002_subagent-terminals-lifecycle-and-lazy-view` (needs `agentInstanceId` and the dispatch/join endpoints).
- **Depends on:** nothing in this feature.
- **Shared-file contention:** `verbSchemas.ts` (shared across all provider work — serialise), `LocalApiServer.ts`, `src/standalone/ptyHost.ts`, `src/standalone/ptyFleetService.ts`.
- No session-id dependencies recorded for this plan.

## Adversarial Synthesis

**Risk summary.** The two risks that can make this ship broken-but-green are (1) the join appearing to work in tests while failing on real workloads — a single unbounded block dies to the caller's own tool timeout (Claude Code's Bash tool caps at 600 s) and to Node's default request timeout, which is why the join is specified bounded **and resumable**; and (2) the evidence detector firing mid-work, which returns a *false success* and sends the parent to review half-written code — strictly worse than a timeout, and only prevented by requiring change **plus** quiescence with a settle window long enough to survive a thinking pause. Third is identity: `agentInstanceId` must reach the `ptyCreateTerminal`/`ptyListTerminals` payloads (which expose no id today) and round-trip through registry persistence, or correlation silently breaks on reload. Mitigations: cap `timeoutMs` server-side and teach the re-join loop in the skill; two-signal detection with a generous settle window and an explicit mid-work test; add the id to the handle, both verb payloads, and `updateRegistryState` in one change.

## Proposed Changes

### 1. Agent identity — `src/standalone/ptyFleetService.ts`

**Context.** `create()` at `:74`; `ExtendedTerminalHandle` assembled at `:88-98`; `updateRegistryState()` around `:212`; `rename()` interacts with the gateway's `moveMap` list.

**Logic.** Mint an opaque `agentInstanceId` (crypto-random, not derived from the name) in `create()`, add it to `ExtendedTerminalHandle`, and persist it through `updateRegistryState` so it survives a reload. `rename()` must leave it untouched — the name changes, the id does not.

**Edge cases.** `purgePtyTerminals` on boot clears registry rows; ids do not need to survive a purge, but a *restored* handle must carry its original id or correlation breaks silently. Do not key any new map on the name.

### 2. Expose the id — `src/standalone/ptyHost.ts` (`handlePtyVerb`)

**Context.** `ptyCreateTerminal` returns `{ friendlyName, role, status }`; `ptyListTerminals` returns `{ friendlyName, role, status, pid, startTime, worktreePath, cwd }`.

**Logic.** Add `agentInstanceId` to both payloads. Without this the id exists but is invisible to every caller outside the pty host, and the head agent cannot enumerate its children.

**Edge cases.** Additive field only — existing consumers (`terminals.js`, the Agents tab) ignore unknown keys, so this is behaviour-preserving.

### 3. Dispatch envelope — `POST /delegates/dispatch`

```jsonc
{
  "parentInstanceId": "…",      // caller identity, interpolated into the parent's prompt
  "correlationId": "…",         // minted by the caller; idempotency key
  "children": [
    { "childInstanceId": "…",
      "prompt": "…",
      "scope": ["src/services/Foo.ts", "src/webview/foo.js"]   // paths this child owns
    }
  ]
}
```

`scope` is the attribution key, **not** a permission boundary — children share the tree and nothing enforces it at the filesystem level. Its jobs are to tell the evidence detector where to look and to give the head agent a stated expectation to review against.

Returns `202` with a `batchId` when every child was accepted; non-2xx naming the first child that could not be dispatched and why. **No partial acceptance** — a half-dispatched batch that the parent then joins on is the ambiguity this avoids.

**Implementation.** Delivery to each child goes through `sendPromptToPty` (`ptyPromptDelivery.ts:26`), which holds `withTerminalLock`. Reject at dispatch on: unknown/exited child id, child already in a live batch, overlapping scopes, depth cap, live-delegate cap, and pty host unavailable.

### 4. Result envelope + join — `GET /delegates/await?batchId=…&timeoutMs=…`

Waits until all children in the batch are terminal or `timeoutMs` expires (server-capped), then returns per-child outcomes:

```jsonc
{ "batchId": "…", "complete": true,
  "children": [
    { "childInstanceId": "…",
      "status": "reported" | "inferred" | "error" | "timeout" | "cancelled" | "pending",
      "detectedBy": "result" | "scopeChange" | "planFile",  // absent unless terminal-by-detection
      "result": "…", "resultRef": "…",
      "changedFiles": ["…"],          // what actually changed under scope
      "outOfScopeFiles": ["…"],       // changed files the child did NOT own — review signal
      "error": "…" }
  ] }
```

`complete: false` with per-child statuses is the partial-result case and is a normal 200, not an error.

**Resumability (§2b).** A repeat `await` on the same `batchId` returns current state and continues waiting; `pending` is the status for a child still working. This is the designed access pattern, not a retry path. Cap `timeoutMs` server-side.

**`inferred` is a success, not a degraded failure.** The child stopped and left changes under its assigned scope; the envelope hands the parent the changed-file list so it can review directly. The parent's prompt block should say plainly that an `inferred` child produced no account of its own and must be reviewed from the diff — which the head agent was going to do anyway.

**`outOfScopeFiles` is the shared-tree safety net.** Nothing stops a child editing outside its assignment, so instead of preventing it, report it. A child that touched files it did not own is the one case the head agent must look at closely, and it is also how a collision between two children surfaces.

**Edge cases.** Tie the wait to the request lifetime so a dead parent releases its slot; in the extension deployment, abort the proxied inner request when the outer one aborts. Cap concurrent waits.

### 4b. Completion detectors

The join watches three signals per child, all host-side so none of them require an attached viewer:

- **Result POST** — authoritative, ends that child's wait immediately.
- **Scope change + quiescence** — files under the child's assigned scope changed *and* no further changes and no pty output for a settle window. Both halves are required: changes alone fire mid-work, because a child that has written its first file looks identical to one that has finished.
- **Plan-file mtime advance** — reuses this system's existing completion contract, which holds because plan files are written once at the end rather than incrementally.

Quiescence is never a detector on its own. A child that is stuck, waiting on input, or crashed is also quiet, and joining on silence alone would report a hung child as complete.

**Implementation.** Output signals come from the fleet's change stream inside the pty host — the same source `TerminalWsGateway` consumes — so detection is independent of any attached WebSocket.

### 5. Child completion — `POST /delegates/result`

How a child reports back: `{ correlationId, childInstanceId, status, result }`. Taught to the child in its prompt, exactly as the Phone-a-Friend curl is today, with identity interpolated at build time — a child cannot discover its own instance id at runtime, and a non-Claude CLI cannot be assumed to know where the port file lives.

**Edge cases.** A late POST after an `inferred` join is accepted and recorded, never a 500, and never resurrects a settled batch.

### 6. The child-side skill

A skill document teaching the contract: how to know your own instance id, what to POST on completion, what to do on failure, and the size cap on results. Modelled on `switchboard-orchestration`, which already teaches the localhost HTTP surface to fleet agents. Must also state that terminal output is **not** a result channel and that early output ages out of a 256 KB scrollback ring (`terminalWsGateway.ts:5`) — the result must go through the endpoint.

### 7. Prompt plumbing — `src/services/agentPromptBuilder.ts`

`agentPromptBuilder` gains the delegate block for head-agent roles, interpolating port, session token, parent instance id, and child ids — mirroring how `PHONE_A_FRIEND_DIRECTIVE` interpolates the port today (`:597`). The parent block must teach the **re-join loop**, not a single blocking call.

**Edge cases.** Do not name any new identifier `subagent*` — that namespace belongs to the shipped in-CLI policy addon (`:1880-1889`).

## Uncertain Assumptions

The following are not certain and the user has been advised to run web research to confirm them before implementation:

1. **Node's `http.Server` default timeouts for a long-held response.** Whether `requestTimeout` / `headersTimeout` / `keepAliveTimeout` defaults abort a request whose response is deliberately withheld for minutes, in the Node versions in play (VS Code's bundled Electron/Node for the extension deployment, and whatever `npx` resolves for standalone). The mitigation (cap `timeoutMs` low, make the join resumable) holds either way, but the safe ceiling depends on these numbers.
2. **Per-CLI shell-tool command ceilings.** Claude Code's Bash tool is documented at 120 s default / 600 s maximum. The equivalent limits for the other CLIs this feature explicitly targets as cheap children and as head agents — Devin, Google Antigravity, Cursor — are unknown, and they bound the maximum useful `timeoutMs`.
3. **`curl` / shell-wrapper behaviour on a long-held connection**, specifically whether a cancelled tool call reliably closes the socket so the server-side slot is released promptly, or whether an explicit `--max-time` is needed on the taught command for the slot-release guarantee in §4 to hold.

## Verification Plan

Everything below is exercisable with `curl` alone; no terminal UI is required. Create the child pty terminals via the `ptyCreateTerminal` verb.

1. Dispatch two children, both report, join returns both results in one response with `complete: true`.
2. Dispatch to an unreachable/unconfigured child → non-2xx **at dispatch**, naming the child. No batch created, nothing to join.
3. One child reports, one never does → join returns at timeout with `complete: false`, one terminal status and one `timeout`. The good result is intact and usable.
4. Repeat a dispatch with the same `correlationId` → same `batchId`, no second child spawned.
5. Kill the joining client mid-wait → the held slot is released; verify by exhausting the concurrent-wait cap and confirming recovery. In the extension deployment, confirm the pty host's inner slot released too, not just `LocalApiServer`'s.
6. Exceed the depth cap → dispatch-time error naming the limit.
7. Exceed the live-delegate cap → dispatch-time error, no partial spawn.
8. Oversized result → `resultRef` pointer returned instead of inline payload; the pointer resolves.
9. A child erroring reports `status: "error"` with its message; siblings are unaffected.
10. Confirm Phone-a-Friend still behaves exactly as before — it does not route through this contract and its silent-drop semantics are unchanged.
11. **Fallback, the motivating case:** dispatch a child with a scope, have it edit those files and exit **without** reporting. Join returns `status: "inferred"`, `detectedBy: "scopeChange"`, and the correct `changedFiles`.
12. **Mid-work must not fire:** a child that writes one file of three and keeps working stays `pending` until it settles. Verify the settle window survives a long pause between edits.
13. **Parent's own edits are not attributed:** the head agent edits file 1 in the shared tree while a child owns files 2–3. The child's `changedFiles` contains only 2–3.
14. **Out-of-scope reporting:** a child edits a file it does not own → it appears in `outOfScopeFiles`, and the join still succeeds.
15. **Overlapping scopes** → dispatch rejected, overlap named, no batch created.
16. **No scope** → report-or-timeout only; no change-based join, even with changes present in the tree.
17. **Cross-CLI:** run one child as a non-Claude CLI (e.g. a Devin terminal) using only the skill's instructions. It must be able to report, and must be joinable by evidence if it does not.
18. **Resumable join:** join with a short `timeoutMs` while a child still works → `complete:false`, child `pending`. Join again on the same `batchId` → same batch, state advanced, no duplicate dispatch. Repeat until complete; confirm no result is lost across iterations.
19. **`timeoutMs` cap:** request a `timeoutMs` far above the cap → server clamps it and says so, rather than honouring it.
20. **Identity survives rename:** rename a child terminal mid-batch → the join still resolves it by `agentInstanceId`.
21. **Identity survives reload:** restart, confirm restored handles carry their original `agentInstanceId` rather than fresh ones.
22. **Capability absent:** with the pty host not running, dispatch → explicit "delegation unavailable" failure in the body, no hang, no false 202.
23. **Both hosts:** repeat 1, 11 and 22 against the standalone `npx` host as well as the extension host (PRD contract #7).

### Automated Tests

Not run in this planning pass (session directive). Recorded for the implementer:

- `src/test/terminal-rename-rekey-contract.test.js` — parses the name-keyed collection list from `untrackTerminalData`; any new name-keyed delegation map will trip it (and should, per the identity decision — key on the id instead).
- The PRD's machine-checked gates (`verb-returns:check`, `parity:check`, `push-routing:check`) apply to any new verb surface added here.
- Five regression tests are already red at HEAD; stash-verify before attributing a failure to this change.

## Recommendation

**Complexity 8 → Send to Lead Coder.**
