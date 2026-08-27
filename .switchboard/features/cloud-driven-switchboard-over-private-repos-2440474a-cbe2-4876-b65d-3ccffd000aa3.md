---
description: 'Cloud-Driven Switchboard Over Private Repos'
---

# Cloud-Driven Switchboard Over Private Repos

**Complexity:** 6

## Goal

Let a cloud session drive a Switchboard board it cannot reach over the network — author plans, dispatch work to a local coder, and check on progress — using private git repositories as the transport, with the machine boundary rather than endpoint restrictions doing the containment.

The workflow this exists for: author plans in a cloud session, run `improve-plan` in the cloud, dispatch remotely to the local coder, then read the coder's live output to see how it is going.

Two structural decisions run through every subtask. **Access is isolated by repository, not by branch** — read access on a repo is repo-wide, so an orphan branch in the code repo is readable by every collaborator and every CI token, and a branch cannot be permissioned the way the risk requires. And **each repo has exactly one writer** — the machine writes board state, receipts and logs; the cloud agent writes instructions. That drops every non-fast-forward retry loop and means a compromised agent credential can file work but cannot rewrite published state or fabricate a receipt claiming its instruction ran.

The security posture is isolation first. Switchboard already serves the board loopback-only with tunnel setup documented, so the recommended deployment is a machine you are willing to hand to an agent. The channels are therefore audited and attributable rather than stripped down — capability limits that break `dispatch remotely to the local coder` buy nothing on an isolated workstation.

## How the Subtasks Achieve This

- **Board state publishes to a private repo of its own, not a branch of the code repo**: moves `BoardSnapshotPublisher` off the `switchboard/board` orphan ref into a private state repo via a cached clone, and stops force-pushing (force would destroy accumulated receipts if the cache were stale). Carries the migration: the `boardStateExport` setting shipped, so it keeps its meaning, and with no repo URL configured publishing *stops* rather than falling back to the branch — a fallback would mean the fix ships and changes nothing. The stale ref is offered for cleanup, never auto-deleted from someone's remote.

- **Board control instructions — the file format and the executor that fires them**: the JSON template a cloud agent fills, and the thing that validates and applies it. Booleans for which actions to take, a sibling params block for their arguments (a bare boolean map cannot express "move to CODED", and JSON key order cannot express sequence), execution order fixed by the allowlist rather than by the file, and idempotency keyed to the instruction id rather than the commit SHA so a force-push cannot replay. The allowlist is the security boundary: the schema has no field for an endpoint, verb, SQL or shell string, so nothing outside it is expressible.

- **Switchboard watches a private control repo and fires the instructions it finds**: `ls-remote` cursor polling (one round trip, no object transfer), fetch only on change, a cached clone so the user's checkout is never touched, and receipts published to the state repo. Read-only against control, which is what keeps the one-writer invariant true rather than aspirational.

- **Remote dispatch is its own seam — audited and attributable, not stripped down**: one entry point for every remote channel, replacing two callers of the local dispatch command. Any role the configured team seats is reachable, coder included; what it gains is provenance threaded as a value, an untrusted-data envelope around remote-authored card bodies, per-dispatch logging, and a switch independent of local dispatch. Also fixes a standing bug: remote framing is currently keyed on whether the board is under remote control rather than on whether the request arrived remotely.

- **A cloud agent fills the template and pushes it**: the authoring skill and shipped template — two clones with different access on each, no worktrees, no force-push — built around the rule that a successful `git push` means the instruction was *filed*, not that the board changed. An agent must read a receipt before telling anyone a card moved.

- **Terminal logs are named for what they record**: logs are currently `<terminal>-<session-id>.md`, so the only searchable field is which terminal the work happened in. Adds CLI, plan slug and short plan id, keeps the terminal first because the listing endpoint's prefix filter depends on it, and makes a plan change roll the file so a name claiming a plan cannot be a lie.

- **Terminal logs publish to the board state repo**: full log on session close, a bounded tail on a timer while in flight, and an index keyed by plan so a cloud agent answers "what is happening on this card" in one fetch. Off by default with the disclosure stated at the toggle, because pty output carries secrets and git history keeps whatever is pushed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ordered, with two independent starting points.

1. **Board state private repo** first — it establishes the state repo, its clone cache, and the serialized `withStateRepo` write path that both receipts and logs use.
2. **Instruction format and executor** can be built in parallel with (1): it takes a parsed object and returns a result, with no git involved, so it is fully testable on its own.
3. **Control repo poller** needs both — it delivers files to the executor and publishes receipts through the state repo's write path.
4. **Remote dispatch seam** is independent of (1)–(3) and can land any time; the executor's `dispatch` action routes through it, so it should land before that action is enabled.
5. **Cloud agent skill** ships in the same release as the poller — a skill describing a channel that is not live would have agents filing instructions nothing reads.
6. **Log naming** is independent and useful on its own.
7. **Log publishing** needs (1) for the repo and (6) for meaningful filenames.

Nothing here depends on the milestone feature or on the priority/ordering plans.
