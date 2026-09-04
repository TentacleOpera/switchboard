# Remote plan authoring over the shared store — a fourth provider kind, not a new pipeline

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit).** This plan names `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` as complementary. That plan has been **deleted** (decision 11) — its layers were already closed, void, or attached to a function the sidecar removes. Nothing this plan does depends on it. This plan is also **parked in Backlog** behind the storage programme.


## Goal

Let an agent with no repository access author a plan by writing a row to the shared store, reusing the remote-authoring pipeline that already exists for Linear rather than building a second one. The point is a new *transport* into a proven materialiser, and the Turso MCP is what makes that transport reachable from a cloud agent with no local machine.

> **Correction — this plan's first draft over-scoped by a wide margin.** It proposed building an inbox table, a materialiser, filename sanitisation, size caps and loop prevention. All of that exists. `LinearSyncService.ts:2715` already materialises a remote-authored plan to `path.join(plansDir, 'linear_import_${issue.id}.md')`, and `RemoteControlService._pollDescriptions()` (L594–675) already carries per-issue description cursors, sha256 hash-based loop prevention, an empty-body guard that never clobbers with empty, a 100 KB size guard, and H1-title preservation on rewrite. `remote-content-pull-all-providers.md` establishes that the wiring is **already kind-generic** over `RemoteProviderKind` and that only two things gate it to Linear. So this is a provider kind, complexity 3, and most of the first draft's proposed changes were reinventions.
>
> Two of its claims were also simply wrong, and are corrected in the analysis below: the draft-exposure risk, and the auto-advance control.

### Problem Analysis

**Remote authoring is a shipped capability, and its transport is a third-party SaaS.** `switchboard-remote.md` documents the flow: a remote agent creates a Linear issue or Notion page with status "Created", column transitions are picked up by the startup reconciler, and setting a designated status triggers local execution. The workflow is explicit that in remote mode plans live in Linear/Notion and the agent must *not* write `.switchboard/plans/` — because it has no repo access. That is the whole design: capture where the agent can reach, materialise where the plan belongs.

**What the store adds is reachability, not a new idea.** Turso has an MCP server, so a cloud agent — a claude.ai session, a hosted runner, anything whose host loads an MCP — can write the store directly with no git credentials and no local machine. Today the equivalent requires a Linear or Notion workspace and its MCP. For an operator who is self-hosting their board precisely to avoid depending on a SaaS, the remote-authoring path currently forces the dependency back in. A store-backed provider kind removes it.

**The file path is the cheaper correct route, which is why this rides the provider path rather than inserting rows.** `POST /kanban/move` canonicalises column ids and 400s on unknown ones; the importer is resolve-only for projects and never mints a `projects` row (`CLAUDE.md`: an unknown pin "leaves the plan unassigned instead of auto-creating a `projects` row"); the feature path cascades column and project onto subtasks; `is_feature` has semantics a wrong value silently corrupts. Routing through the file-and-import path inherits every one of those guards for free — the same reason the Linear path writes a file rather than a row. Stated as a preference rather than a prohibition on purpose: a direct insert is not a security problem, it is a worse deal. It forfeits the guards and produces a card with no file behind it, which is the state the board-integrity feature describes as a row that "stays active forever with no tool to find it" and which needed a reconciliation skill to detect. Framing this as a rule to enforce is what previously dragged credential scoping into the design; framing it as the cheaper path needs no enforcement at all.

**The boundary rule is satisfied by the existing shape, not threatened by it.** The programme-wide rule from `sidecar-owned-db-real-sqlite-binding.md` — the database "must never become the sole home of a user artifact" — holds because materialisation writes markdown into the repo. A store-backed transport keeps that: the row is a queue entry, the file is the home.

**Correction 1 — the draft-exposure risk runs the other way.** The first draft warned that unmaterialised drafts would live only in the store, narrowing the recovery floor. That is already the status quo for remote authoring, and today it is *worse*: an unmaterialised Linear-authored plan lives only in a third party's database. Under a self-hosted or Turso store it lives in infrastructure the operator owns. This plan improves that property rather than degrading it.

**Correction 2 — "never auto-advance" contradicts a shipped capability.** The first draft asserted that a materialised plan must land in CREATED and never advance, as an injection control. But `switchboard-remote.md` documents setting a remote status to the execution-trigger state specifically *to* trigger local execution. The existing trust model is: whoever can write the remote surface can drive the board, execution included. That is defensible for a Linear workspace the operator controls. Whether it is defensible for a store token handed to an agent platform is a real question — but it is a **decision about trust levels**, not a defect this plan gets to close unilaterally. It is raised below.

### Root Cause

Remote authoring was built when the only reachable remote surfaces were SaaS trackers, so the transport and the tracker were the same thing. Making the transport pluggable was already half-done — the wiring is kind-generic — but no non-tracker transport existed to motivate finishing it.

### Non-goals

- Building a materialiser, sanitiser, size cap or loop-prevention mechanism. All present; reuse them.
- Moving plan or feature bodies into the store. The row is a queue entry.
- Letting anything write `plans`, `features` or `projects` directly.
- Replacing the Linear/Notion remote path. This is a peer transport.
- A Switchboard MCP. Still worth building so self-hosted remotes reach cloud agents without Turso, but out of scope.

## Metadata

**Complexity:** 3
**Tags:** api, backend, database, feature, refactor, security

## User Review Required

Yes — two decisions. The one that used to be first is now answered.

**Answered: yes, exactly as a Linear-authored plan can, with no extra gate for this transport.** Two earlier revisions got this wrong in opposite directions — the first added an application-level opt-in because a store token looked coarser than a tracker login; the second removed it because Turso's table+action scoping could make the database refuse the write. Both reasoned from the credential. The control that actually holds is the **review gate** in `the-remote-command-vocabulary-is-closed.md`: transport-neutral, keyed on a column's role, and it stops any trigger path dispatching an unreviewed plan regardless of what wrote it or what credential it held. Credential scoping is defence-in-depth over that, not a substitute for it — and it is unavailable on self-hosted sqld anyway.
The residual, once the review gate holds, is that a store-authored surface could advance an *already reviewed* plan at a moment nobody intended. That is precisely the posture already accepted for the shipped Linear path — dispatching reviewed work at the wrong time, bad and bounded and recoverable. Same posture, so this transport gets no special gate.
2. **Where do the two Linear gates get opened?** `remote-content-pull-all-providers.md` already opens them for Notion and ClickUp. Recommendation: **land this after that plan**, so the store kind is the fourth through a door already widened rather than the reason for widening it.
3. **Filename convention.** Recommendation: follow `linear_import_${id}.md` with a store-kind prefix. It sidesteps title sanitisation entirely, which is why the Linear path does it.

## Complexity Audit

### Routine

- A `RemoteProviderKind` for the store, whose fetch is a SQL read of a queue table rather than an HTTP call.
- The queue table itself: id, idempotency key, `workspace_id`, title, body, provenance, status, materialised path, error.
- Reusing `_pollDescriptions`' cursor, hashing and guards for the new kind.
- Panel surface: pending count, last materialisation, failures.

### Complex / Risky

- **The transport differs from every existing kind in one way that matters:** the other providers are polled over HTTP with their own auth; this one reads the same store the board already uses. So the poll is local (or replica-local) and effectively free, which is good — but it also means a malformed queue row is inside the board's own database rather than behind an API boundary. Validation happens on read, not on write, and cannot be assumed.
- **`workspace_id` must be explicit.** `CLAUDE.md`'s workspace-detection tree keys on an active editor a cloud agent does not have. An unresolvable value parks the row as an error; guessing puts a plan on the wrong project's board.
- **Who polls.** With several hosts against one shared store, the store-kind poll must be lease-held (`sync-owner-lease-and-write-attribution.md`) or two hosts materialise one row twice.
- **Idempotency across a crash** between file write and row marking. The Linear path keys the filename on the provider id, so a retry rewrites the same path rather than creating a duplicate — inherit that property rather than inventing one.
- **The credential is the trust boundary, and it can be made narrow — if the scoping is verified.** Turso documents table+action scoping, so "may author a plan" *is* separable from "may edit the board". That makes this design substantially safer than a default token, and it moves the load-bearing work from an application gate to correct token minting: the operator must actually mint a scoped token, and the product should say so wherever it asks for one. A default full-access token silently reinstates the coarse boundary, so the panel should distinguish a scoped credential from an unscoped one rather than treating any working token as equivalent.

## Edge-Case & Dependency Audit

**Race conditions**
- Two hosts polling the queue: lease-gated.
- A row written while no host is online: it waits, visibly, and materialises once when one returns.
- The same logical plan submitted twice: dedupe on the idempotency key, since a legitimate revision has a different body and the existing hash logic handles revision-versus-loop.

**Security**
- Bodies inherit the existing 100 KB cap and empty-body guard.
- Filenames derived from the row id, never author-supplied.
- Provenance is attribution, not authorisation, consistent with the lease plan. Record the submitting credential; do not treat it as a person.
- Handing a store token to an agent platform confers store write access, which is broader than "author a plan". Document that plainly so an operator knows what the grant is. A table-scoped token would narrow it materially.

**Side effects**
- `remote-content-pull-all-providers.md` overlaps directly — it opens the same gates. Coordinate rather than duplicate.
- The memo protocol is the local sibling of this shape (append-only capture, deliberate processing). Keeping the two consistent means a plan authored remotely is indistinguishable from a memo-processed one.
- The plan-sizing and project-pin protocols apply unchanged; the authoring guidance a cloud agent follows should say so.

**Migration**
- Additive and opt-in: a new table and a new provider kind, inert without a configured store target.

## Dependencies

- **Requires** `libsql-shared-store-turso-and-self-hosted-sqld.md` — the queue lives in the shared store.
- **Requires** `sync-owner-lease-and-write-attribution.md` for single-poller election and provenance.
- **Best sequenced after** `remote-content-pull-all-providers.md`, which opens the two Linear-specific gates.
- **Respects** the boundary rule from `sidecar-owned-db-real-sqlite-binding.md`.
- **Complements** `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` by giving a remote agent a sanctioned write target, which is what makes the prohibition tenable rather than merely stated.

## Adversarial Synthesis

Key risks: a coarse store credential makes "may author" inseparable from "may edit the board" absent table-scoped tokens; validation happens on read because the queue sits inside the board's own database rather than behind an API; an unresolvable `workspace_id` would put a plan on the wrong board; and multiple hosts against one store double-materialise without a lease. Mitigations: execution-triggering gated behind a separate opt-in for this kind until the token-scoping question resolves; validate on read and never assume write-side validation; explicit `workspace_id` with an error park rather than a guess; lease-gated polling; and filenames keyed on the row id so a crash retry rewrites rather than duplicates.

## Proposed Changes

1. **A store-backed `RemoteProviderKind`** whose fetch is a SQL read of the queue table, plugged into the existing kind-generic wiring.
2. **The queue table** in the shared tier, with an explicit `workspace_id` and an idempotency key.
3. **Reuse** `_pollDescriptions`' cursor, hashing, empty-body and size guards, and the `*_import_${id}.md` filename convention — no new sanitiser, no new materialiser.
4. **Lease-gated polling** so exactly one host materialises.
5. **No transport-specific execution gate.** Triggering is governed by the transport-neutral review gate; adding an opt-in here would duplicate it for one provider kind and leave the equivalent path open for the others.
6. **Panel surface** for pending, materialised and failed rows.
7. **Authoring guidance** for cloud agents restating the plan-sizing and project-pin protocols.

### Migration

Additive and opt-in; inert without a configured store target. No existing remote path changes.

## Verification Plan

- **End to end, no git:** from a client with no repository access, write one queue row. Assert a plan file appears, imports, and is indistinguishable from a Linear-authored one.
- **Guard inheritance:** assert the new kind actually exercises the existing empty-body guard, 100 KB cap, hash loop prevention and H1 preservation — a test that the reuse is real rather than a parallel implementation.
- **Workspace resolution:** valid, unknown and absent `workspace_id`. Assert correct placement, error park, error park — never a guess.
- **Project pin:** valid pin, unknown pin, workspace name, literal `<project>`. Assert the resolve-only backstop leaves the last three unassigned rather than minting projects.
- **Idempotency:** same key twice → one plan. Kill between file write and row marking, restart → one plan.
- **Lease:** two hosts, one row, exactly one materialisation. Holder offline → row waits, shown waiting, materialises once on return.
- **Review gate governs triggering, not the credential:** with a full-access store credential and no transport-specific gate, assert a store-authored plan cannot be dispatched until it reaches a reviewed column, and that it then behaves exactly as a Linear-authored one does. Assert the same with a scoped credential, to confirm the outcome does not depend on scoping.
- **Scoped credential is optional hardening, where available:** on a Turso target, a token minted `-p all:data_read -p <queue>:data_add` should still permit queue inserts and be refused on `plans`/`features`/`projects`. Assert this as defence-in-depth, and assert nothing in the product requires it — a self-hosted sqld target cannot offer it and must work identically.
- **Boundary rule:** assert no plan or feature body is written to `plans`/`features` by this path.
- **Parity:** author the same plan via Linear and via the store. Assert the resulting files and board rows are equivalent apart from provenance.

## Outstanding Questions

- **Resolved:** Turso supports table+action token scoping (`-p <table>:<actions>`), so a cloud agent's credential can reach the queue and not the board. Confirm empirically before relying on it — mint the token and assert the forbidden write is rejected.
- **Still open:** does self-hosted sqld honour the same claims? If not, the self-hosted target cannot match Turso on least-privilege here, and the application-level gate has to stay for that target only — which would be the first capability difference between the two.
- Should a store-authored plan carry a visible provenance marker, so a reviewer knows what wrote it without consulting the queue?
- Once a Switchboard MCP exists, does a self-hosted remote use this queue or call the API directly and skip it?
- Do the other provider kinds want the same execution-trigger opt-in, or is the coarse-credential concern genuinely specific to a store token?
