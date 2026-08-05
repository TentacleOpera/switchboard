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
- [ ] [Phone-a-Friend: per-instance addressing instead of one global role](../plans/feature_plan_20260805180000_phone-a-friend-per-instance-addressing.md) — **PLAN REVIEWED**
- [ ] [Subagent contract: dispatch, correlation, and a real join](../plans/feature_plan_20260805180001_subagent-contract-and-join.md) — **PLAN REVIEWED**
- [ ] [Subagent terminals: definition, co-launch, and lazy viewing](../plans/feature_plan_20260805180002_subagent-terminals-lifecycle-and-lazy-view.md) — **PLAN REVIEWED**
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
- **The join is bounded and resumable, not an unbounded block.** The blocking read is still the right shape — results land inside the parent's turn — but the parent issues it through its own shell tool, and those tools cap command duration (Claude Code's Bash tool: 120 s default, 600 s max). A repeat `await` on the same `batchId` resumes and returns current state; the skill teaches the re-join loop. A single unbounded block passes a fast test and fails exactly on the long jobs delegation exists for.
- **Failure semantics are inverted from Phone-a-Friend.** Its silent-drop, must-not-throw contract is correct for a best-effort nudge and fatal for delegation — a parent blocking on a child that was never dispatched would hang. Delegate dispatch fails fast; the join always terminates. Relatedly, the delegate endpoints reuse the pty host's existing session token (they start processes), while Phone-a-Friend stays unauthenticated (it cannot, and tokenising it would break in-flight prompts).
