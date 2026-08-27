---
description: 'Cloud-Driven Switchboard — Commands, Dispatch And Visibility'
---

# Cloud-Driven Switchboard — Commands, Dispatch And Visibility

**Complexity:** 6

## Goal

Let a cloud session drive a Switchboard board it cannot reach over the network — request explicit board actions, dispatch work to a local coder, and see how that work is going — and make the record of what the fleet did searchable.

The workflow this exists for: author plans in a cloud session, run `improve-plan` in the cloud, dispatch remotely to the local coder, then read whether the coder is moving or wedged.

**This feature was rescoped on 2026-08-27 after an audit against five live plans it had been duplicating.** The transport, the destination and the storage topology were all already decided, and two of the original subtasks contradicted those decisions rather than extending them. Both are now superseded stubs recording why, and the surviving work is layered on the existing designs:

- **Transport** is `board-state-remote-mirror-channels.md` §3's `GitStateProvider` — the poll loop, the commit-SHA cursor, the fetch-and-reconcile push, and the inbound trust guard. No second poller is built.
- **Destination** is whatever `boardStateExport` resolves to. `board-state-remote-mirror-channels.md` already rejected a per-project private companion repo in favour of the control plane, and `storage-topology-one-choice-three-stores.md` exists specifically to stop new storage placements being invented.
- **Storage** for the log record is the topology plan's **Archive** store, placement derived from the one operator choice.

What the git channel could not do, and this feature adds: carry **commands** rather than only signals (a column value and a comment cannot express "star this" or "dispatch this"), give remote-originated dispatch an **identity** so it is attributable, and make terminal work **findable**.

## How the Subtasks Achieve This

- **Board control instructions — a structured command payload on the channel that already exists**: the JSON schema, a closed action allowlist that is the security boundary (the schema has no field for an endpoint, verb, SQL or shell string), execution order fixed by the allowlist rather than by JSON key order, and receipts. Its idempotency is keyed to an instruction id rather than a commit SHA, which matters because the transport's cursor cannot survive a force-push or the ref-squashing that `git-carried-shared-board-state.md` plans — and a replayed move is cosmetic where a replayed dispatch starts a second agent. Answers that plan's open question about whether a remote agent may write the ref directly: yes, through a validated schema, not by hand-editing board state.

- **Remote dispatch is its own seam — audited and attributable, not stripped down**: one entry point replacing two callers of the local dispatch command, whose docstring is the finding — *"the same command a manual drag uses."* Any role the configured team seats is reachable, coder included, because containment belongs to the deployment (Switchboard already serves the board loopback-only with tunnel setup documented) rather than to endpoint restrictions. What it adds is provenance as a value, an untrusted-data envelope around remote-authored card bodies, and per-dispatch logging. Also carries a finding about the git channel's inbound trust guard: the commit author email it relies on is self-asserted, so push access is the real boundary and the check is a filter rather than a gate.

- **A cloud agent fills the template and pushes it**: the authoring skill and shipped template, built around the rule that a successful `git push` means the instruction was *filed*, not that the board changed — and that a rejected push means the machine pushed mirror content, to be replayed rather than forced.

- **Terminal logs are named for what they record**: adds CLI, plan slug and short plan id to the filename, keeps the terminal name first because the listing endpoint's prefix filter depends on it, and makes a plan change roll the file so a name claiming a plan cannot be a lie.

- **Terminal logs go to the Archive store; a Runtime-safe status goes to the board destination**: the record becomes queryable by plan, CLI, terminal, time and content — which a directory of files cannot be. The status payload was redesigned during the audit: terminal names and log tails are Runtime tier, which the topology plan says never leaves the machine and `git-carried-shared-board-state.md` enforces with a contract test, so the default payload carries plan id, state and idle seconds and nothing else. Output tails are a separate opt-in that names itself as an exception.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## ⚠ Blocked items

**The log Archive subtask is blocked on an open decision in another plan.** `storage-topology-one-choice-three-stores.md`'s User Review item 2 — whether DuckDB is demoted to a never-load-bearing analytics export — is unresolved, and `retention-and-archive-for-unbounded-growth.md` assumes the opposite answer (*"Changing what the archive is (DuckDB stays)"*). A searchable log archive is load-bearing by definition, so the two answers give incompatible destinations. That subtask supplies the evidence and should not be coded until the decision lands.

## Dependencies & sequencing

External prerequisite for three subtasks: `board-state-remote-mirror-channels.md` §3 must exist, since the instruction payload and the status publishing both ride its provider and its outbound cycle.

1. **Remote dispatch seam** and **log naming** are independent of everything and can start immediately.
2. **Instruction format and executor** needs mirror-channels §3 for transport, and the dispatch seam before its `dispatch` action is enabled.
3. **Cloud agent skill** ships in the same release as the executor — a skill describing a channel that is not live would have agents filing instructions nothing reads.
4. **Logs to Archive and status** needs log naming, the Archive store from the topology plan, and the DuckDB decision above.

Nothing here depends on the milestone feature or the priority/ordering plans.
