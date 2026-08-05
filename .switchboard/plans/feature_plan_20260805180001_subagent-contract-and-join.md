# Subagent contract: dispatch, correlation, and a real join

## Goal

Define and implement the protocol layer for head-agent → subagent delegation over localhost HTTP: a dispatch envelope with durable agent identity, a correlation id, a typed result envelope, and a **blocking join** endpoint that lets a parent agent wait for its children and receive their results inside its own turn.

No terminal lifecycle work and no UI. When this lands, a subagent tree is drivable entirely by hand with `curl` — which is the point: if the contract is right, whether the child is Claude Code, Google Antigravity, or anything else that can make an HTTP request becomes an implementation detail.

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

**A child that forgets to report is recoverable, and the join must treat it that way.**
Self-reporting is an instruction in a prompt, so some children will not do it. That is survivable here in a way it is not for most RPC, because **the parent has to inspect the child's work regardless** — a subagent's answer is a claim, not a result. So the join resolves on *evidence of completion* as well as on a report, and says which it got:

| Detector | Signal | Strength |
|---|---|---|
| **Reported** | child POSTs `/subagents/result` | Authoritative — carries the child's own account |
| **Evidence** | changes in the child's worktree, quiescent | Strong when the child is isolated; attribution is unambiguous |
| **Plan-file advance** | plan file mtime advances | Already this system's completion contract, and plan files are written at the end, so it is a terminal signal rather than a mid-work one |
| **Quiescence** | no pty output for N seconds *and* one of the above | Never sufficient alone — an idle child may be stuck, not done |

The parent then receives `status: "reported"` (here is what it said) or `status: "inferred"` (it stopped and left these changes; go look). Both are successful joins. Only "nothing happened at all, and it went quiet" is a timeout.

This is why **worktree isolation is close to mandatory for children that write code**: without it, changes cannot be attributed to a particular child and the evidence detector degrades to guesswork.

**3. Identity is a role, and roles are not instances.**
The current payload is `{ planFile, originRole }` and the target resolves through `_getAgentNameForRole('phone_a_friend', …)` — a workspace singleton. There is no caller identity, no target identity beyond a role, and no correlation id. A tree needs all three. (Per-instance addressing for the *existing* feature is `feature_plan_20260805180000`; this plan defines identity for the *new* contract and the two must agree on the key.)

**And its failure semantics are exactly inverted for this use.**
`_dispatchPhoneAFriend` is documented as silent-drop, "MUST NOT throw", because a throw becomes a 500 and the directive tells the agent the call succeeds regardless. Correct for a best-effort nudge. Catastrophic for a subagent: a parent blocking on a join for a child that was never dispatched hangs until timeout with no diagnosis. This contract fails **fast on dispatch** and **hard on join timeout**.

### Why HTTP and not MCP

Dropping MCP costs typed tool schemas and buys transport simplicity plus reach — anything that can curl can participate, which is the actual prize. The cost is that the protocol must be *taught* to the child in its prompt. That is a solved pattern here: the `switchboard-orchestration` skill already teaches fleet agents to read the board, plans, worktrees, inbox and session log over localhost HTTP. The subagent contract is a natural extension of that surface, not a new one.

## Metadata

- **Complexity:** 7
- **Tags:** feature, backend, reliability

## User Review Required

None. The two decisions worth surfacing are made here rather than deferred: **blocking join over mailbox-drain** (reasoned above), and **fail-fast dispatch** (below), which deliberately diverges from Phone-a-Friend's silent-drop contract.

## Complexity Audit

**Substantial — this is the load-bearing piece.** Not because any single endpoint is hard, but because the contract is what every later phase is built on, and getting identity or failure semantics wrong is expensive to unwind once terminals and UI depend on it.

| Area | Why it costs |
|---|---|
| Durable agent identity | Terminal display names are renameable and reused. Identity must survive that or every correlation breaks on a rename. |
| Blocking join | Long-poll needs timeouts, partial results, cancellation on parent death, and a bound on held connections. |
| Result envelope | Must carry success, failure, and *partial* outcomes distinguishably, or the parent cannot reason about a mixed batch. |
| Teaching the contract | A skill document the child reads. Wrong or vague here and agents improvise, which is unrecoverable at runtime. |

## Edge-Case & Dependency Audit

- **Identity must not be the terminal name.** Names are renamed (there is machinery that migrates every name-keyed collection on rename) and reused across sessions. Mint an opaque `agentInstanceId` at terminal creation, persist it with the terminal, and let the display name be a label. Correlation, dispatch, and join all key on the id. This is the single decision most expensive to change later.
- **Dispatch fails fast; join fails on timeout.** `POST /subagents/dispatch` returns non-2xx when a child cannot be reached, is not configured, or is already busy — the parent must learn this at dispatch, not by waiting. `GET /subagents/await` must always terminate: on all-children-done, on timeout, or on cancellation. Never an unbounded wait.
- **Partial results are the normal case, not an error.** Three of five children succeed, one errors, one times out. The envelope must express that per child so the parent can act on what it has. A shape that can only say "the batch succeeded/failed" forces the parent to discard good work.
- **The evidence detector must not fire mid-work.** This is the main risk in the fallback. A child that has written one file is indistinguishable from one that has finished, on file-presence alone. Changes must be paired with a settle window over both further changes and pty output, and the window must be long enough to survive an agent pausing to think between edits. Too short and the parent reviews half-written work believing it complete — worse than a timeout, because it looks like a success.
- **A quiet child is not necessarily a finished child.** Stuck, awaiting input, and crashed all look like silence. Quiescence qualifies a positive signal; it never constitutes one.
- **Evidence detection needs no attached viewer.** The pty host sees all output whether or not a panel is watching, and worktree/plan-file changes are filesystem facts. This keeps the fallback compatible with the lazy-attach requirement in `feature_plan_20260805180002` — dispatch, completion detection, and join must all work with the panel closed.
- **Unisolated children degrade the fallback to guesswork.** Two children sharing a tree produce changes that cannot be attributed. Children that write code should default to worktree isolation; if a child opts out, the worktree detector must be disabled for it rather than attributing shared-tree changes to it.
- **A late report after an `inferred` join is not an error.** The child may POST its result after the join already resolved on evidence. Accept and record it (the parent may join again, or a later reader may want the account); never 500, and never resurrect a settled batch.
- **Bound the held connections.** Every blocking join holds a socket. Cap concurrent waits and cap duration; a parent that dies mid-join must release its slot (tie the wait to the request lifetime, not to a timer alone).
- **Nested trees need a depth cap.** A child that can dispatch is a parent. Without a hard depth limit, one prompt can fan out exponentially. Cap depth and total live subagents per root, and make exceeding it a dispatch-time error with a clear reason — a runaway fan-out discovered at runtime is unrecoverable.
- **Idempotency.** An agent retrying a dispatch (network blip, its own retry logic) must not spawn a second child. Key dispatch on the correlation id; a repeat returns the existing dispatch rather than creating one.
- **The localhost surface is unauthenticated.** Anything that can reach the API port can dispatch. The WS terminal gateway already uses a token; the verb rail is more open. Decide the auth posture for `/subagents/*` explicitly before it ships, since it can start processes.
- **Result size.** A child returning a large diff or log into the parent's context is a context-budget problem, not a transport one. Cap result payload size and return a pointer (file path / session-log offset) above the cap, in the same shape the orchestration surface already uses for the session log.
- **Do not reuse `_phoneAFriendInFlight`.** That chain serializes *all* dispatches because there is one target. Subagents need per-child concurrency with per-target locking (see `feature_plan_20260805180000`), and the pty-level `withTerminalLock` already prevents input splicing at the terminal.
- **Depends on nothing in phase 3.** This ships and is testable with curl alone. Phase 3 (`…180002`) depends on it, not the reverse.

## Proposed Changes

### 1. Agent identity

Mint and persist an `agentInstanceId` per terminal at creation. Expose it on the fleet listing so the head agent can enumerate its children. Make the rename path carry it (name changes, id does not).

### 2. Dispatch envelope — `POST /subagents/dispatch`

```jsonc
{
  "parentInstanceId": "…",      // caller identity, interpolated into the parent's prompt
  "correlationId": "…",         // minted by the caller; idempotency key
  "children": [                  // one or more, dispatched concurrently
    { "childInstanceId": "…", "prompt": "…", "isolation": "worktree" | "none" }
  ]
}
```

Returns `202` with a `batchId` when every child was accepted; non-2xx naming the first child that could not be dispatched and why. **No partial acceptance** — a half-dispatched batch that the parent then joins on is the ambiguity this avoids.

### 3. Result envelope + join — `GET /subagents/await?batchId=…&timeoutMs=…`

Blocks until all children in the batch are terminal or the timeout expires, then returns per-child outcomes:

```jsonc
{ "batchId": "…", "complete": true,
  "children": [
    { "childInstanceId": "…",
      "status": "reported" | "inferred" | "error" | "timeout" | "cancelled",
      "detectedBy": "result" | "worktree" | "planFile",   // absent on timeout/cancelled
      "result": "…", "resultRef": "…",
      "changedFiles": ["…"],                               // populated for "inferred"
      "worktreePath": "…",
      "error": "…" }
  ] }
```

`complete: false` with per-child statuses is the partial-result case and is a normal 200, not an error.

**`inferred` is a success, not a degraded failure.** The child stopped and left attributable changes; the envelope hands the parent the worktree path and the changed-file list so it can review directly. The parent's prompt block should say plainly that an `inferred` child produced no account of its own and must be reviewed from the diff.

### 3b. Completion detectors

The join watches three signals per child, all host-side so none of them require an attached viewer:

- **Result POST** — authoritative, ends that child's wait immediately.
- **Worktree change + quiescence** — changes present in the child's isolated worktree *and* no further changes and no pty output for a settle window. Both halves are required: changes alone fire mid-work, because a child that has written its first file looks identical to one that has finished.
- **Plan-file mtime advance** — reuses this system's existing completion contract, which holds because plan files are written once at the end rather than incrementally.

Quiescence is never a detector on its own. A child that is stuck, waiting on input, or crashed is also quiet, and joining on silence alone would report a hung child as complete.

### 4. Child completion — `POST /subagents/result`

How a child reports back: `{ correlationId, childInstanceId, status, result }`. Taught to the child in its prompt, exactly as the Phone-a-Friend curl is today, with identity interpolated at build time (a worktree CWD cannot read the port file, and cannot discover its own instance id at runtime either).

### 5. The child-side skill

A skill document teaching the contract: how to know your own instance id, what to POST on completion, what to do on failure, and the size cap on results. Modelled on `switchboard-orchestration`, which already teaches the localhost HTTP surface to fleet agents.

### 6. Prompt plumbing

`agentPromptBuilder` gains the subagent block for head-agent roles, interpolating port, parent instance id, and child ids — mirroring how `PHONE_A_FRIEND_DIRECTIVE` interpolates the port today.

## Verification Plan

Everything below is exercisable with `curl` alone; no terminal UI is required.

1. Dispatch two children, both report, join returns both results in one response with `complete: true`.
2. Dispatch to an unreachable/unconfigured child → non-2xx **at dispatch**, naming the child. No batch created, nothing to join.
3. One child reports, one never does → join returns at timeout with `complete: false`, one `ok` and one `timeout`. The `ok` result is intact and usable.
4. Repeat a dispatch with the same `correlationId` → same `batchId`, no second child spawned.
5. Kill the joining client mid-wait → the held slot is released; verify by exhausting the concurrent-wait cap and confirming recovery.
6. Exceed the depth cap → dispatch-time error naming the limit.
7. Exceed the live-subagent cap → dispatch-time error, no partial spawn.
8. Oversized result → `resultRef` pointer returned instead of inline payload; the pointer resolves.
9. A child erroring reports `status: "error"` with its message; siblings are unaffected.
10. Confirm Phone-a-Friend still behaves exactly as before — it does not route through this contract and its silent-drop semantics are unchanged.
