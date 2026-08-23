# A plan inbox so cloud agents can author without git, without making the database a plan's only home

## Goal

Let an agent with no repository access and no local machine author a plan by writing one row to the shared store, and have Switchboard materialise it into `.switchboard/plans/` through the normal import path. The store carries the draft; the repo remains the plan's home. Capability gained, boundary rule intact.

### Problem Analysis

**Turso offers a capability no self-hosted remote can match today.** It has an MCP server, so a cloud agent — a claude.ai session, a hosted runner, any agent whose host can load an MCP — can write to the database directly. No git credentials, no local machine, no Switchboard-authored MCP. A self-hosted Mac mini cannot do this without a Switchboard MCP that does not exist, or an exposed API a cloud agent cannot tunnel to. That asymmetry is real and it is the strongest argument for the libSQL target beyond durability.

**And the obvious use of it is forbidden by the programme's central invariant.** `sidecar-owned-db-real-sqlite-binding.md` states it, and the storage feature restates it as a programme-wide rule:

> The database may hold control-plane definitions as bodies. It must never become the sole home of a user artifact. […] the global-database and backup plans both rest on "the DB is a derived index over committed markdown, so plan identity and relationships survive a total loss by re-ingesting the repo." […] Control-plane definitions are safe because they are regenerable from the extension bundle; user artifacts are not regenerable from anything.

Authoring a plan whose only copy is a row makes the database that plan's sole home. Lose the store and the plan is gone — and every recovery story in the programme (consolidation's blast-radius reasoning, the backup plan's risk calculus, the N-to-1 merge's safety floor) assumes it cannot be.

**A second, independent objection: a raw insert bypasses every guard.** `POST /kanban/move` canonicalises column ids and 400s on unknown ones; the importer is **resolve-only** for projects and deliberately never mints a `projects` row (`CLAUDE.md`: "An unknown pin […] leaves the plan unassigned instead of auto-creating a `projects` row"); the feature path cascades columns and project onto subtasks; `is_feature` has semantics a wrong value silently corrupts, with a clobber investigation open since July 2025. A cloud agent writing `INSERT INTO plans` gets none of it and fails silently rather than with a 400. This is `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md`'s failure class arriving through a door that plan does not cover, because it assumed the writer was local.

**The shape that satisfies both already exists locally.** `/switchboard-memo` appends each message to `.switchboard/memo.md` and does no analysis; `process memo` then converts entries into plan files, one per entry, and clears the memo on success. Capture is cheap, dumb and append-only; materialisation is deliberate and goes through the real authoring path. An inbox table is that protocol with a remote transport instead of a local file — which is why this is a small plan rather than a new subsystem.

### Root Cause

Plan authoring has always assumed the author can write the repository. Every capture path — the memo file, the plan watcher, `improve-plan` — starts from a filesystem the author can reach. A cloud agent cannot reach one, so it has no way in, and the only writable surface it *can* reach is the database, which is the one place a plan must not solely live.

### Non-goals

- Moving plan or feature bodies into the store. The boundary rule stands; this plan exists to satisfy the use case without touching it.
- Letting anything write `plans`, `features` or `projects` directly. The importer keeps sole ownership.
- Replacing the memo protocol. This is its remote sibling and should reuse its processing wherever possible.
- A Switchboard MCP. Worth building later so self-hosted remotes reach parity, but out of scope here.
- Auto-dispatch. A materialised plan never advances on its own; see the security section for why that is load-bearing rather than conservative.

## Metadata

**Complexity:** 5
**Tags:** api, backend, database, feature, security, reliability

## User Review Required

Yes — four decisions.

1. **Does materialisation commit?** Recommendation: **write the file, do not commit.** The plan lands in the working tree as an untracked or modified file the operator commits like any other plan. Auto-committing means a remote agent can put commits in your history, and the board-state export work already found per-persist writes into the tree causing merge conflicts and breaking `planAutoFetch`'s clean-tree guard.
2. **Who materialises?** Recommendation: **the sync-owner lease holder**, reusing `sync-owner-lease-and-write-attribution.md`. Two hosts materialising one inbox row produces two plan files.
3. **What happens to an inbox row after materialisation?** Recommendation: **mark it materialised with the resulting plan path, and retain it** for the retention plan to prune. Deleting it loses the provenance trail for a plan whose author was not a person at a keyboard.
4. **Is the inbox the *only* thing a cloud agent may write?** Recommendation: **yes for authoring; reads stay reads.** A cloud agent may read the board through the store and write only the inbox. Anything more re-opens the guard-bypass problem.

## Complexity Audit

### Routine

- A `plan_inbox` table: id, raw markdown, declared title, provenance (agent, session, timestamp), status, materialised-path, error.
- A materialiser on the lease holder: claim a pending row, write the file, import, mark done.
- Inbox state in the Database panel — pending count, last materialisation, failures.

### Complex / Risky

- **Inbox rows are untrusted input, and the trust boundary is not where it looks.** A materialised plan file is read by the operator's agents *as instructions*. So anyone holding the Turso token can place text into the operator's own agent fleet's instruction path. The token is a shared root password (already noted in the libSQL plan) — but this turns "can vandalise the board" into "can inject instructions". Materialisation must therefore treat the body as data: size-capped, no execution, no path control by the author, landing in CREATED, never auto-advanced and never auto-dispatched.
- **The author does not control the filename or location.** A `path` field in the inbox is a directory-traversal primitive. The materialiser derives the filename from the title, sanitises it, and writes only into the workspace's plans directory — the author supplies content, never a destination.
- **Which workspace?** A cloud agent may not know, and `CLAUDE.md`'s workspace-detection tree assumes an active editor. The inbox row must carry an explicit `workspace_id`, and an unresolvable one parks the row as an error rather than guessing. Guessing puts a plan in the wrong project's board.
- **The project pin rules apply unchanged, and that is the reason to route through the file.** The importer is resolve-only; an unknown pin, a workspace name, or a literal `<project>` placeholder leaves the plan unassigned. Materialising via a file gets that backstop for free — an `INSERT` would not.
- **Idempotency across a crash.** Claim-then-write-then-mark, with the claim conditional, or a crash between write and mark duplicates the plan on retry. The file write itself should be atomic-rename and content-hash checked so a retry recognises its own prior output.
- **Unmaterialised drafts are the one thing the store solely holds.** That is a real narrowing of the recovery floor, and it should be stated rather than glossed: losing the store loses pending drafts. The mitigation is that the window is minutes-to-hours and the panel shows the count, so the exposure is visible and bounded — not that it is zero.

## Edge-Case & Dependency Audit

**Race conditions**
- Two hosts racing to materialise: the lease decides, and the claim is a conditional write.
- A row inserted while the lease holder is offline: it waits, and the panel shows it waiting. It must not be lost, and it must not be materialised twice when the holder returns.
- The same logical plan submitted twice by a retrying agent: dedupe on a client-supplied idempotency key, not on body hash, since a legitimate revision has a different body.

**Security**
- Treat every field as hostile: cap body size, reject control characters in the title, sanitise the derived filename, refuse any author-supplied path.
- Provenance is attribution, not authorisation — consistent with the lease/attribution plan. Record which credential submitted a row; do not pretend that authenticates a person.
- The Turso MCP means the agent's MCP host holds a DB-write credential. That is a broader grant than "may author a plan", and it is worth documenting so an operator understands what handing that token to an agent platform actually confers. A scoped token that can only write the inbox would be better if libSQL permits it — an open question below.
- Materialised plans landing in CREATED and never auto-advancing is the control that stops injection becoming execution. It should be a contract test, not a convention.

**Side effects**
- The memo protocol's processing path is the closest existing code; reuse rather than reimplement, and keep the two consistent so a plan authored remotely is indistinguishable from one processed from a memo.
- `PlanFileImporter` / `GlobalPlanWatcherService` do the import; materialisation should hand off to them rather than writing rows.
- The plan-sizing and project-pin protocols in `CLAUDE.md` apply to remotely-authored plans exactly as to local ones, and the authoring guidance a cloud agent follows should say so.

**Migration**
- Purely additive: a new table, off by default, no existing behaviour changed. No install is affected until someone configures a libSQL target and an agent that writes to it.

## Dependencies

- **Requires** `libsql-shared-store-turso-and-self-hosted-sqld.md` — the inbox lives in the shared store, and this is the capability that most distinguishes it.
- **Requires** `sync-owner-lease-and-write-attribution.md` for single-materialiser election and provenance.
- **Respects** the boundary rule from `sidecar-owned-db-real-sqlite-binding.md`; this plan is the mechanism for not breaking it.
- **Complements** `sql-write-guardrail-prevent-agents-from-writing-to-kanban-db.md` by giving a remote agent a sanctioned write target, which is the thing that makes the prohibition tenable rather than merely stated.
- **Should be followed by** a Switchboard MCP so self-hosted remotes reach the same capability — noted as a non-goal here, but the parity gap is real.

## Adversarial Synthesis

Key risks: a materialised plan is read by the operator's agents as instructions, so the inbox is a prompt-injection path writable by anyone holding the store credential; an author-supplied path or filename is a traversal primitive; an unresolvable workspace guess puts a plan on the wrong board; a crash between file write and row marking duplicates plans; and unmaterialised drafts are genuinely the one artifact the store solely holds. Mitigations: bodies treated as data with size caps and derived, sanitised filenames, never an author-supplied destination; materialised plans land in CREATED and never auto-advance, enforced by contract test; explicit `workspace_id` with an error park rather than a guess; conditional claim plus atomic rename and content-hash recognition for retry; and the pending-draft exposure stated plainly with a visible count rather than treated as zero.

## Proposed Changes

1. **A `plan_inbox` table** in the shared tier: id, idempotency key, `workspace_id`, title, body, provenance, status, materialised path, error.
2. **A materialiser** on the lease holder: conditionally claim a pending row, derive and sanitise a filename, write atomically into the workspace's plans directory, hand off to the existing importer, mark the row materialised with its path.
3. **Reuse the memo processing path** so remote authoring and memo processing produce identical results.
4. **Hard constraints:** author supplies content only, never a path; body size-capped; unresolvable `workspace_id` parks as an error; materialised plans land in CREATED and never auto-advance or auto-dispatch.
5. **Panel surface:** pending count, last materialisation, failures with reasons, and the pending-drafts-only-live-in-the-store caveat stated in the UI.
6. **Authoring guidance** for cloud agents that restates the plan-sizing and project-pin protocols, so a remotely-authored plan is held to the same standard.
7. **Retention:** materialised rows retained with provenance, pruned by the retention policy.

### Migration

Additive and opt-in. Nothing changes for an install without a libSQL target.

## Verification Plan

- **End to end, no git:** from a client with no repository access, insert one inbox row. Assert a plan file appears in `.switchboard/plans/`, imports, lands in CREATED, and is indistinguishable from a locally-authored plan.
- **No auto-advance:** assert a materialised plan never leaves CREATED without an explicit human or orchestrator action — a contract test, since this is the control that keeps injection from becoming execution.
- **Traversal:** submit titles containing `../`, absolute paths, null bytes, path separators and reserved Windows names. Assert every file lands inside the plans directory with a sanitised name.
- **Hostile body:** submit an oversized body, control characters, and text that impersonates system instructions. Assert the size cap holds, the file is written as data, and nothing in the pipeline executes or interprets it.
- **Workspace resolution:** submit rows with a valid, an unknown, and an absent `workspace_id`. Assert correct placement, an error park, and an error park — never a guess.
- **Project pin:** submit rows with a valid pin, an unknown pin, a workspace name, and a literal `<project>`. Assert the resolve-only backstop leaves the last three unassigned rather than minting projects.
- **Idempotency:** submit the same idempotency key twice; assert one plan. Kill the materialiser between file write and row marking; restart; assert one plan, not two.
- **Lease:** two hosts, one pending row. Assert exactly one materialises it. Take the holder offline; assert the row waits, is shown waiting, and materialises once on return.
- **Draft exposure:** with pending rows present, assert the panel shows the count and states that pending drafts exist only in the store.
- **Boundary rule:** assert no plan or feature *body* is written to `plans`/`features` by this path — the inbox is a queue and the repo is the home. Grep-level and behavioural.

## Outstanding Questions

- Does libSQL/Turso support a token scoped to a single table's writes? If so, a cloud agent's credential should reach only `plan_inbox`, which would shrink the blast radius from "the whole board" to "a draft queue" and make this substantially safer.
- Should a materialised plan carry a visible marker that it was remotely authored, so a reviewer knows its provenance without checking the inbox?
- Is there a case for inbox entries that are *not* plans — memo lines, review notes, ticket links — or does that belong to the memo protocol proper?
- If a self-hosted remote later gets a Switchboard MCP, does the inbox remain the write target, or does the MCP call the API directly and skip the queue?
