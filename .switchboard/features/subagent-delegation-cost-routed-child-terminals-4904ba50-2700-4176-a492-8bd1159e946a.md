# Subagent Delegation — Cost-Routed Child Terminals

**Complexity:** 7

## Goal

Let an expensive head agent delegate implementation work to cheaper or free models running in their own terminals, then review the result. The purpose is token saving, not speed: a plan touching three files can have the head agent implement one and assign the other two to Devin terminals, spending its own tokens only on the review.

Subagents are defined per agent in the Kanban panel's Agents tab, including which CLI or model each child launches with. Opening a head agent's terminal co-launches its children; a control in the pane frame reveals them on demand. Children share the working tree by design — isolating them would require a merge back, which costs exactly the tokens the delegation was meant to save — so work is attributed by the file scope assigned at dispatch.

Communication is localhost HTTP rather than MCP, so any CLI that can make a request can participate. A parent dispatches, then blocks on a join that returns its children's results inside its own turn; blocking is free because a waiting parent spends no tokens. A child that never reports is not a failure: the join also resolves on evidence of completion, since the head agent has to review the work either way.

## How the Subtasks Achieve This

- **Phone-a-Friend: per-instance addressing instead of one global role**: Re-keys the existing Phone-a-Friend feature from role to terminal instance, so `coder-1` and `coder-2` can have different friends and the callback identifies which terminal called it. Ships and pays for itself independently — the role-level ambiguity is a live defect once more than one coder runs — while establishing the caller-identity and per-target-locking primitives the subagent contract then builds on.

- **Subagent contract: dispatch, correlation, and a real join**: The protocol layer, and the load-bearing piece. Defines durable agent identity that survives terminal renames, a dispatch envelope carrying each child's assigned file scope, a typed result envelope, and a blocking join that hands children's results back inside the parent's turn. Adds the completion detectors so a child that forgets to report is still joinable by evidence. Drivable entirely by curl, so it is verifiable before any UI exists.

- **Subagent terminals: definition, co-launch, and lazy viewing**: The operator surface. Subagents are defined per agent in the Kanban panel's Agents tab — including the CLI or model each child launches with, which is the cost-routing lever the whole feature rests on. Opening a head agent co-launches its children as unattached ptys; a pane-frame control attaches them for viewing on demand. Lazy attachment is a hard requirement rather than an optimisation: dispatch, completion detection, and join must all work with the panel closed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Phone-a-Friend: per-instance addressing instead of one global role](../plans/feature_plan_20260805180000_phone-a-friend-per-instance-addressing.md) — **CREATED**
- [ ] [Subagent contract: dispatch, correlation, and a real join](../plans/feature_plan_20260805180001_subagent-contract-and-join.md) — **CREATED**
- [ ] [Subagent terminals: definition, co-launch, and lazy viewing](../plans/feature_plan_20260805180002_subagent-terminals-lifecycle-and-lazy-view.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Phone-a-Friend per-instance addressing is independent** — it improves a shipped feature and can land first, last, or alongside anything else. It is sequenced first only because it is the cheapest way to prove the instance-identity model before the contract commits to it.

**The subagent contract must land before the terminals work.** Terminal lifecycle, the Agents-tab definitions, and the pane-frame control all depend on `agentInstanceId` and on the dispatch/join endpoints existing. The reverse is not true: the contract ships and is fully testable with curl against manually-started terminals.

Two decisions are fixed across the set and should not be relitigated per subtask:

- **Identity is an opaque `agentInstanceId`, never a terminal name.** Names are renameable and reused, and there is existing machinery migrating name-keyed collections on rename. This is the decision most expensive to unwind once terminals and UI depend on it.
- **Failure semantics are inverted from Phone-a-Friend.** Its silent-drop, must-not-throw contract is correct for a best-effort nudge and fatal for delegation — a parent blocking on a child that was never dispatched would hang. Subagent dispatch fails fast; the join always terminates.
