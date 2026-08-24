# Shared Board Stores - libSQL and the Git-Carried Snapshot

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
- [ ] [Make the orphan-branch board snapshot bidirectional, so a team that shares a repo shares a board with no infrastructure](../plans/git-carried-shared-board-state.md) — **CREATED**
- [ ] [A libSQL shared store, hosted on Turso or self-hosted sqld, as an opt-in authoritative target](../plans/libsql-shared-store-turso-and-self-hosted-sqld.md) — **CREATED**
- [ ] [Remote plan authoring over the shared store — a fourth provider kind, not a new pipeline](../plans/remote-authoring-over-the-shared-store-as-a-provider-kind.md) — **CREATED**
- [ ] [One machine owns provider sync, and every board write says who made it](../plans/sync-owner-lease-and-write-attribution.md) — **CREATED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

**Storage Topology and the Shared/Runtime Schema Split** is a hard prerequisite in full — it decides what a shared store is allowed to hold. Within this feature: the sync-owner lease lands before either store target goes multi-writer, and remote authoring lands last because it needs a store to write into. The two store targets are independent of each other and an operator will choose one, not both.

