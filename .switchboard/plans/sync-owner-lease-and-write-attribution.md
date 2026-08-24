# One machine owns provider sync, and every board write says who made it

## Goal

Elect exactly one machine to run outbound provider sync against a shared store, and stamp board writes with a person as well as a hostname. Both are consequences of more than one machine writing one board — the first prevents a feedback loop that only exists once they do, the second makes a shared board legible about who did what.

### Problem Analysis

**Provider sync becomes a feedback loop the moment two machines share a store, and today's guards were written for one.** `notion-overwrite-guard.md` and `provider-sync-inbound-delete.md` exist because outbound push and inbound delta pull already interfere with a single writer. Add a second machine against one shared store and it stops being an interference bug and becomes structural: machine A pushes the board to Notion; machine B's delta pull sees A's push as an inbound remote change and writes it back to the shared store; A's next pull sees B's write and pushes again. Three machines make three loops. Nothing in the existing sync plans anticipates this, because one machine owning one database made it impossible to express.

**This is a failure mode created by combining two features, which is why neither plan would have found it.** The Turso/git store plans do not touch provider sync; the provider-sync plans assume a single writer. The defect lives only in the composition — the class of bug that is otherwise discovered in production.

**Attribution is machine-level and half-built.** `plan_events` declares `device_id` and `vector_clock` (`KanbanDatabase.ts:329-330`); the INSERT sites (`:9578`, `:9745`) write only `device_id`, as `os.hostname()`. So the board can say a card was moved by `patricks-mbp` and cannot say who was sitting at it. For one operator across three machines that is sufficient. For the team story it is not: a shared board where every change is attributed to a hostname is unreadable the first time two people use it.

**And attribution is all that is available, which the product must be honest about.** Switchboard operates no service, so it enforces no permissions. A shared libSQL token grants unrestricted write access; a shared git remote grants whatever the remote grants. Stamping `user_id` records who *said* they did something; it is not a permission boundary and must never be presented as one.

### Root Cause

Both gaps are the same root cause as the tier split: one database, one machine, one implicit writer. Sync ownership never needed electing because there was only one candidate, and identity never needed a person because there was only one.

### Non-goals

- Access control or authorisation of any kind. Out of reach without a service, and this plan must not imply otherwise.
- Reviving `vector_clock`. Under a serialising store the server orders writes; the tier-split plan deletes the column.
- Changing what any provider syncs. This decides *which machine* runs it, not what it does.
- Inbound provider writes as authoritative. Projections stay non-authoritative; restore stays break-glass.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, database, infrastructure, feature

## User Review Required

Yes — three decisions.

1. **Lease location.** The shared store is the only place all candidates can see, so the lease lives there — but that means a machine cannot acquire it while offline. Recommendation: lease row in the shared store; when there is no shared store (local-file target) the single machine is trivially the owner and the lease is a no-op.
2. **Lease behaviour on owner death.** Recommendation: short TTL with renewal (60s TTL, 20s renewal), so a crashed owner's lease expires and another machine takes over within a minute. Longer TTLs risk a sync gap; shorter ones risk churn.
3. **Where `user_id` comes from.** Recommendation: `git config user.email` as the default, overridable by an explicit setting, and never blocking — an unset identity records `unknown` rather than refusing the write. It is attribution, so a missing value degrades rather than fails.

## Complexity Audit

### Routine

- A lease table in the shared tier, and acquire/renew/release around the existing sync schedulers.
- Resolving and caching `user_id`; adding it to the attribution write sites.
- Reporting the current sync owner in the Database panel's status contract, so an operator can see which machine holds it.

### Complex / Risky

- **Every scheduler that pushes outbound needs to consult the lease, and there are several.** `ClickUpSyncService`, `LinearSyncService`, `NotionBackupService`, `ContinuousSyncService`, `IntegrationAutoPullService`, `ScheduledJobsService` and `RemoteControlService` all have their own timers. Missing one leaves the loop open, so the gate belongs at a single choke point rather than in each service.
- **`RemoteControlService` is a control path, not just a mirror.** It accepts remote *commands*. Standing down a non-owner from *pushing* is right; standing it down from *acting on commands* may not be, since a command addressed to a specific machine must reach that machine. The lease governs sync, not command execution, and the distinction needs to be explicit or remote control will silently stop working on non-owner machines.
- **Lease handoff mid-sync.** A partially completed push when the lease expires. Sync operations need to be idempotent and resumable, or handoff must wait for the in-flight operation to finish.
- **A single owner is a single point of failure for freshness.** If the owning machine sleeps, projections go stale while other machines are wide awake and forbidden from pushing. The TTL bounds it, but the panel should show staleness rather than let it be invisible.
- **`device_id = os.hostname()` is not unique.** Two machines named `localhost`, or a rebuilt laptop reusing a name, collide — and the lease is keyed on identity. Needs a stable generated machine id persisted in the home store, with the hostname kept as a human-readable label only.

## Edge-Case & Dependency Audit

**Race conditions**
- Two machines acquiring simultaneously: the acquire must be a conditional write, which is exactly what the shared store's arbitration provides. Under the git-carried store it is a ref CAS; under libSQL a conditional update.
- Clock skew between machines makes TTL comparison unsafe if evaluated locally. Evaluate expiry against the store's own time (`datetime('now')` server-side), never the client's.

**Security**
- `user_id` from `git config user.email` is a personal email. It lands in the shared store and in projections. That is expected for a team board, but it must be stated, and the override must exist for anyone who does not want their email in a Notion database.
- Attribution is forgeable by anyone with write access. Documented as attribution, never as audit.

**Side effects**
- Existing `device_id` values are hostnames. Introducing a stable machine id means historical rows keep hostnames while new rows carry both — the reader must tolerate the mix rather than assuming one format.
- The status contract gains sync-owner and staleness fields the Database panel renders.

**Migration**
- `device_id` shipped and is populated in existing `plan_events` rows. Adding `user_id` is additive with a default; existing rows keep an empty value and must render as unknown, not as a blank name. Never backfill a guess — attributing historical writes to whoever is configured now would be a fabrication.

## Dependencies

- **Requires** a shared store to hold the lease (libSQL or git-carried); degenerates to a no-op for local-file targets.
- **Requires** the tier split, which owns the `user_id` column and the `vector_clock` deletion.
- **Feeds** the Database panel's status contract.

## Adversarial Synthesis

Key risks: the sync gate must sit at one choke point or a missed scheduler leaves the feedback loop open; standing down non-owners could silently disable remote *control* as well as sync; `device_id = os.hostname()` is not unique and the lease is keyed on identity; and a sleeping owner starves projections while other machines are forbidden to push. Mitigations: a single gate rather than per-service checks, with a grep-level test that no scheduler pushes without consulting it; an explicit lease-governs-sync-not-commands boundary; a stable generated machine id with the hostname as a label; server-evaluated TTL with staleness surfaced in the panel.

## Proposed Changes

1. **A lease row in the shared tier** — owner machine id, acquired-at, expires-at, evaluated against store time. Acquire and renew are conditional writes; release on clean shutdown.
2. **A single outbound-sync gate** that every scheduler passes through, so ownership is enforced in one place. Non-owners stand down from pushing and from inbound delta pull.
3. **An explicit boundary** that the lease governs sync, not command execution: `RemoteControlService` command handling stays active on non-owners.
4. **A stable machine id** persisted in the home store, with `os.hostname()` retained as a display label.
5. **`user_id` resolution** from `git config user.email` with a setting override, written alongside `device_id` at the attribution sites, degrading to unknown.
6. **Status reporting** of current owner, lease age and projection staleness into the Database panel.

### Migration

Additive. Existing `device_id` hostnames stay; new rows carry both machine id and user id. No backfill of historical attribution — unknown stays unknown.

## Verification Plan

- **Loop prevention:** three simulated machines against one shared store with a projection configured. Run 10 minutes. Assert exactly one machine pushes, the projection converges once, and no write is pushed more than once — the test that fails today by construction.
- **Single gate:** grep-level regression asserting every outbound scheduler routes through the gate, and a test that adding an ungated push path fails CI.
- **Lease handoff:** kill the owner mid-sync. Assert another machine acquires within TTL, the interrupted operation resumes or restarts idempotently, and no duplicate push results.
- **Simultaneous acquire:** two machines racing. Assert exactly one wins under both store types.
- **Clock skew:** set one client's clock ten minutes ahead. Assert lease expiry is unaffected.
- **Remote control on non-owners:** send a command addressed to a non-owner machine. Assert it executes.
- **Identity collision:** two machines with identical hostnames. Assert distinct machine ids and a correctly-held single lease.
- **Attribution:** with `git config user.email` set, unset, and overridden, assert writes carry the expected value and never block. Assert historical rows render as unknown and were not backfilled.

## Outstanding Questions

- Should lease ownership be steerable by the operator (pin sync to the always-on machine), or strictly first-come?
- When the owner sleeps nightly, is TTL-based takeover enough, or should the panel offer a manual takeover?
- Does inbound delta pull need the same gate as outbound push, or is a non-owner pulling harmless as long as it does not write back?
