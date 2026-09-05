# Shared Board Stores - libSQL and the Git-Carried Snapshot

<!-- board-collapse-07 -->
> **PARKED IN BACKLOG 2026-09-04 (Board Collapse 07).** Not cancelled — **unreachable until the storage programme's first step lands**: *Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding*. sql.js holds the whole database in memory and rewrites the entire image on each persist, so nothing here that assumes concurrent or remote writers can be built on it. The full seven-step order is stated once, in the *Storage layer overhaul* feature file. Leaving these in Planned invited a coder to start one; move it back when step 1 lands.


**Complexity:** 9

## Goal

Give the shared tier two concrete targets an operator can actually point at: a libSQL server (Turso, or sqld they run themselves), or the orphan-branch board snapshot made bidirectional so a team that shares a repo shares a board with no infrastructure at all. Both need the same two things the moment a second machine writes: exactly one elected sync owner, and attribution on every board write. Remote plan authoring then reuses the existing pipeline to write into whichever store the operator chose.

## How the Subtasks Achieve This

- **A libSQL shared store, hosted on Turso or self-hosted sqld** — the hosted or self-hosted target that makes board state authoritative off-machine.
- **Make the orphan-branch board snapshot bidirectional** — the zero-infrastructure target: the same board.json on the same orphan branch, read back in as well as written out.
- **One machine owns provider sync, and every board write says who made it** — the lease that stops two machines both running outbound sync, plus person-level write attribution.
- **Remote plan authoring over the shared store as a provider kind** — lets an agent with no repository access author by writing a row, reusing the existing remote-authoring pipeline rather than building a second one.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Make the orphan-branch board snapshot bidirectional, so a team that shares a repo shares a board with no infrastructure](../plans/git-carried-shared-board-state.md) — **BACKLOG** — ID: 29e871f0-14ff-4349-8e8c-dc657328e30b
- [ ] [A libSQL shared store, hosted on Turso or self-hosted sqld, as an opt-in authoritative target](../plans/libsql-shared-store-turso-and-self-hosted-sqld.md) — **BACKLOG** — ID: a974763c-b52f-4f09-af93-ed65d9f3c48c
- [ ] [Remote plan authoring over the shared store — a fourth provider kind, not a new pipeline](../plans/remote-authoring-over-the-shared-store-as-a-provider-kind.md) — **BACKLOG** — ID: c5b2c3d3-309e-4436-8975-5b7f5d5beb88
- [ ] [One machine owns provider sync, and every board write says who made it](../plans/sync-owner-lease-and-write-attribution.md) — **BACKLOG** — ID: 540be267-fd7b-4300-8de8-74dc995c34e6
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Storage Topology and the Shared/Runtime Schema Split** is a hard prerequisite in full — it decides what a shared store is allowed to hold. Within this feature: the sync-owner lease lands before either store target goes multi-writer, and remote authoring lands last because it needs a store to write into. The two store targets are independent of each other and an operator will choose one, not both.

## Settled 2026-09-05: one identifier, hostname-derived, used by both

**Which identifier does a snapshot entry carry?** The same one the lease uses: a hostname-derived
`device_id`. Both subtasks use it; there is no second machine id.

The concern that prompted this — `os.hostname()` not being globally unique — is not worth a second
identifier. Two machines a person actually works across have different names, and someone who gives
two machines the same hostname has bigger problems than a board snapshot: SSH host keys, mDNS, and
their own ability to tell the two apart all break first. Buying a stable uuid to survive that case
costs an extra store, a mapping between the two ids, and the exact divergence this question was
raised about — a lost-write detector and an ownership lease that disagree about who is who.

**Consequences for the two subtasks, both of which must follow this:**

- *Make the orphan-branch board snapshot bidirectional* keeps `device_id` as it has it.
- *One machine owns provider sync* drops its separate stable machine id and uses `device_id` too.
  Its `user_id` from `git config user.email` is a different thing and stays — it identifies the
  person, not the machine.

**If the collision ever matters**, the fix is to tell the operator their two machines share a name,
not to invent an id behind their back. A duplicate hostname is a misconfiguration to surface, not a
condition to route around silently.
