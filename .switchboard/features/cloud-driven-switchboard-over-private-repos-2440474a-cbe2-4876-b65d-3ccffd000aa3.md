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
- **Destination** is a sibling of the control plane, one per purpose, under the canonical layout: `-plans` for plans and board state, `-remote` for instructions and receipts, `-backups` for plan and DB backups, `-logs` for logs. The control plane is the **container** that agents start in, and holds no board data — it carries the personas, workflows and skills agents execute, so a command channel there could rewrite the prompt the agent runs on, which no action allowlist can contain. One purpose per sibling means one access grant per purpose: a remote author gets write on `-remote` and read on `-plans`, and nothing else. Linear and Notion appear nowhere in the layout — that path is the in-process sync service (`KanbanProvider.ts:2730`), not a git channel, so the two remote-control paths are separated by mechanism rather than both getting folders.
- **Storage** for the log record is the topology plan's **Archive** store, placement derived from the one operator choice.

What the git channel could not do, and this feature adds: carry **commands** rather than only signals (a column value and a comment cannot express "star this" or "dispatch this"), give remote-originated dispatch an **identity** so it is attributable, and make terminal work **findable**.

## How the Subtasks Achieve This

- **The canonical layout: a control plane containing one sibling per purpose**: defines the shape (`Switchboard-Agents/` holding `Switchboard/`, `-plans`, `-remote`, `-backups`, `-logs`), derives every path from the one control-plane root the operator sets, and adds the guided Setup panel that detects, proposes and — only when asked — creates and links them. Supersedes mirror-channels' `control-plane` destination, which pushed mirror content *into* the control plane; the rest of that plan stands. Degrades to today's behaviour for every sibling that is absent, and moves no file without an explicit action.

- **Board control instructions — a structured command payload on the channel that already exists**: the JSON schema, a closed action allowlist that is the security boundary (the schema has no field for an endpoint, verb, SQL or shell string), execution order fixed by the allowlist rather than by JSON key order, and receipts. Its idempotency is keyed to an instruction id rather than a commit SHA, which matters because the transport's cursor cannot survive a force-push or the ref-squashing that `git-carried-shared-board-state.md` plans — and a replayed move is cosmetic where a replayed dispatch starts a second agent. Answers that plan's open question about whether a remote agent may write the ref directly: yes, through a validated schema, not by hand-editing board state.

- **Remote dispatch is its own seam — audited and attributable, not stripped down**: one entry point replacing two callers of the local dispatch command, whose docstring is the finding — *"the same command a manual drag uses."* Any role the configured team seats is reachable, coder included, because containment belongs to the deployment (Switchboard already serves the board loopback-only with tunnel setup documented) rather than to endpoint restrictions. What it adds is provenance as a value, an untrusted-data envelope around remote-authored card bodies, and per-dispatch logging. Also carries a finding about the git channel's inbound trust guard: the commit author email it relies on is self-asserted, so push access is the real boundary and the check is a filter rather than a gate.

- **A cloud agent fills the template and pushes it**: the authoring skill and shipped template, built around the rule that a successful `git push` means the instruction was *filed*, not that the board changed — and that a rejected push means the machine pushed mirror content, to be replayed rather than forced.

- **Terminal logs are named for what they record**: adds CLI, plan slug and short plan id to the filename, keeps the terminal name first because the listing endpoint's prefix filter depends on it, and makes a plan change roll the file so a name claiming a plan cannot be a lie.

- **Terminal logs live in the logs sibling, with an index**: logs are files in `-logs`, addressable by the naming subtask and indexed for lookup without a scan. Retention is deleting files, and the default — a plain non-git folder — discloses nothing because it has nowhere to disclose to; making `-logs` a repo *is* the opt-in for sharing them. A tier-safe status (plan id, state, idle seconds — no terminal name, no path, no output) publishes with board state so a remote reader can tell moving from wedged, without breaking the invariant that Runtime data never leaves the machine.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Open decision carried, not resolved here

The `boardStateExport` setting has four proposed value sets across four plans and one shipped pair (`none | read-only-snapshot`); mirror-channels drops a shipped value and git-carried adds a bidirectional mode. The layout subtask needs one value meaning "use the canonical siblings", and reconciling the enum belongs to `storage-topology-one-choice-three-stores.md`, which already owns retiring the ten placement mechanisms. Flagged there rather than picked here — it is a migration hazard on a setting real installs hold.

**No longer blocked:** the logs subtask was blocked on the topology plan's DuckDB decision while logs were headed for the Archive store. As files in a sibling folder they need no store, so that dependency is gone.

## Dependencies & sequencing

External prerequisite for three subtasks: `board-state-remote-mirror-channels.md` §3 must exist, since the instruction payload and the status publishing both ride its provider and its outbound cycle.

1. **The canonical layout**, the **remote dispatch seam** and **log naming** are independent of everything and can start immediately. The layout leads: it supplies the destination every other subtask resolves against.
2. **Instruction format and executor** needs mirror-channels §3 for transport, the layout for a private `-cloud` destination, and the dispatch seam before its `dispatch` action is enabled.
3. **Cloud agent skill** ships in the same release as the executor — a skill describing a channel that is not live would have agents filing instructions nothing reads.
4. **Logs in the sibling, plus status** needs log naming and the layout's derived path. Nothing else.

Nothing here depends on the milestone feature or the priority/ordering plans.
