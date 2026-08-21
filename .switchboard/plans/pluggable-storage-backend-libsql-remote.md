# Pluggable storage backend with libSQL as the one supported remote option

## Goal

> **Status: NOT SCHEDULED — revisit on demonstrated demand.** This plan is written so the option is costed and the reasoning is on record, not because it is queued. It entered the programme to answer a hypothetical ("what if someone wants their data in a cloud database?"), and none of the four actually-stated drivers — stability, memory, storage location, one global store — needs it. `NotionBackupService` already provides a cloud *mirror* of plans, which is what most people asking for "my data in the cloud" want: durability and access, not authority. Schedule this only when a real user asks for a remote database as the authority, and treat the repository seam (change 1 below) as the part worth building regardless.

Introduce a repository-level storage seam and implement a second backend behind it: a libSQL/Turso remote database with a local embedded replica, so a user who wants their board state held in a cloud database can have it without the board becoming unusable offline. One blessed provider, not bring-your-own-connection-string.

### Problem Analysis

There is currently no storage seam at all. `src/services/KanbanDatabase.ts` is 10,820 lines with 222 public methods and roughly 460 direct `sql.js` call sites, imported by 62 files with 158 instance-acquisition sites. `src/services/` contains `ClickUpDocsAdapter`, `LinearDocsAdapter`, `PanelStateStore` and `encryptedSecretsStore` — no repository, adapter, store, or driver abstraction for the database. The class *is* the interface, and it is a very wide one. Any backend change today is a rewrite of that class rather than an implementation behind it.

There is also no existing remote-database configuration surface: a search for `dbUrl`, `connectionString`, `databaseUrl`, `postgres`, `turso`, or `libsql` across `src/` returns only `NotionBackupService`'s own Notion API fields. So this is new capability, not a migration of existing config.

**The dialect coupling is measurable, and it decides the provider.** Counted in `KanbanDatabase.ts`: 18 `rowid` references, 13 `AUTOINCREMENT`, 18 `ON CONFLICT`, 15 `INSERT OR IGNORE`, 6 `INSERT OR REPLACE`, 6 `PRAGMA`, 15 `datetime('now')`. The `rowid` usage is load-bearing rather than incidental — the plan dedupe SQL at `:607-610`, `:677-678` and `:7490-7503` is built on `SELECT MAX(rowid)` / `WHERE rowid IN (...)` patterns, and `:4094` reads `SELECT last_insert_rowid() as id`.

For libSQL that entire list costs nothing: libSQL *is* SQLite, so the dialect, the file format and the semantics are unchanged. For Postgres, `rowid` has no equivalent at all — those 18 sites need real primary keys and rewritten dedupe queries — plus `AUTOINCREMENT` becomes `GENERATED ... AS IDENTITY`, `PRAGMA` disappears, and `datetime('now')` becomes `now()`.

**Offline is the constraint that actually decides this.** Switchboard is a local development tool; the board has to work on a plane and in a tunnel. A backend where the network is a hard dependency of rendering the board is not viable as the primary store. libSQL embedded replicas resolve this directly: reads are served from a local SQLite file at local speed, writes go to the remote, and replication is asynchronous. That is simultaneously the long-term-persistence answer, the multi-device answer, and the offline answer. Postgres provides none of the three without building a sync layer.

**Latency is a second-order constraint the code is not written for.** All ~460 call sites assume microsecond in-memory reads. `getWorktrees()` inside a board refresh is free at 0 microseconds and expensive at 30ms multiplied by card count. Chatty N+1 patterns that are invisible today become visible stalls against any network backend — which is another reason the embedded replica (local reads) is the right shape, and why the sidecar must own the replica.

### Root Cause

The database layer was written as a concrete class against a single engine, at a time when there was exactly one deployment target. Every subsequent capability — cloud paths, workspace mappings, `db-pointer` — was added by widening that class rather than by introducing a seam behind it.

### Non-goals

- Postgres or MySQL support. Recorded as an explicit non-goal pending demonstrated demand; the `rowid` bill above is the reason.
- Bring-your-own connection string. With ~4,000 installs, permitting arbitrary endpoints means owning every TLS, permission, pool-exhaustion and schema-drift report. One blessed provider.
- Multi-user or multi-tenant sharing of one board between people. This plan gives one user several machines, not several users one board.
- Replacing the local default. Local-first stays the default; remote is opt-in.

## Metadata

**Complexity:** 9
**Tags:** database, backend, api, infrastructure, feature, security, performance

## User Review Required

Yes — three decisions:

1. **Confirm libSQL as the single supported remote.** The alternative is shipping the seam only, and no remote backend, until demand is proven.
2. **Conflict policy for a diverged replica.** Two machines writing offline then reconnecting will conflict. Recommendation: last-writer-wins per row on `updated_at`, with the losing version retained in an audit table so nothing is silently destroyed. A real merge UI is out of scope.
3. **Does remote replace the global local database or mirror it?** Recommendation: replace — the embedded replica *is* the local database, so there is one authority, not two. Mirroring creates a two-writer problem identical to the clobber this program removes.

## Complexity Audit

### Routine

- Adding the libSQL client dependency and a second driver implementation behind the existing `sqliteDriver` interface, then verifying it independently against the full suite. The sidecar plan ships `node:sqlite`, so this is a genuine second implementation — that cost is accepted deliberately rather than prepaid in the foundation (see that plan's binding decision for why prepaying was rejected).
- A Setup-panel section for remote configuration: endpoint, token, connect/test, and current replication status.
- Storing endpoint and token in `encryptedSecretsStore`, never in `config` or settings JSON.
- Config keys for backend selection, defaulting to local.

### Complex / Risky

- **The seam must be at the repository layer, not the SQL layer.** Abstracting to "execute this SQL string" abstracts nothing — the dialect leaks straight through and the seam provides no value beyond indirection. It has to be the 222 typed methods (ideally consolidated first), each independently implementable. This is the bulk of the work, and it is worth doing regardless of whether a remote backend ever ships, because it is also what makes the DB layer testable.
- **Distributed migrations are a genuinely new failure mode.** Today `migration_meta` is per-file and single-writer, so migration is trivially safe. Against a shared remote database, two clients on different extension versions will both attempt to migrate. This needs an advisory lock plus a version floor that refuses to open ("this Switchboard is too old for this database") rather than migrating backwards or partially. With ~4,000 installs on widely varying versions, this is the item most likely to cause real damage, and it has no analogue in the current codebase to copy from.
- **Read-path batching must precede this.** The N+1 patterns are tolerable against a local replica but any cache miss or write round-trip exposes them. The per-card read paths need auditing and batching first.
- **Replication lag is user-visible state.** A write that has not yet replicated is durable locally and not durable remotely. The UI must be able to say which, or users will trust the wrong thing after a machine loss.
- **Token handling.** A leaked token is full access to every project's board state. It belongs only in `encryptedSecretsStore`, must never be logged, and must never be written into a plan file, a snapshot, or `kanban-board.md`.
- **`PRAGMA` and `last_insert_rowid()` behaviour on a remote connection** need verifying rather than assuming — libSQL is SQLite, but remote-protocol statement semantics for connection-scoped state are worth testing explicitly (`:4094` is the specific site).

## Edge-Case & Dependency Audit

**Race conditions**
- Two machines writing the same plan offline, then both reconnecting: covered by the conflict policy, and the losing version must be retained.
- Two clients racing a migration: the advisory lock plus version floor is the whole answer; without it, one client migrates while the other writes against the old schema.
- Replica bootstrap on a fresh machine while the user starts working: reads must serve from the partially-synced replica or block explicitly, never silently return an empty board that then gets written back as truth.

**Security**
- Endpoint and token in `encryptedSecretsStore` only. TLS verification must never be disabled, even behind a config flag.
- The remote holds every project the user works on. The Setup UI should say so plainly before the first connection.
- An endpoint is untrusted input: validate scheme and host shape, and refuse anything that is not the blessed provider's form.

**Side effects**
- With remote enabled, the backup plan's Online Backup API path applies to the local replica, not the remote. Remote durability is the provider's; local backups remain useful for the offline window. This distinction must be stated in the UI or users will assume one covers the other.
- The retention plan's rotation runs against the authority, so with remote enabled it becomes a networked operation and needs its own care.
- `NotionBackupService` already provides a cloud *mirror* of plans. For many users "I want my data in the cloud" means durability and access rather than authority, and the mirror satisfies that without making the network a dependency. Worth surfacing as the lighter option in the Setup UI.

**Migration**
- Opt-in and reversible. Enabling remote seeds the remote from the local global database via the export machinery; disabling it promotes the local replica back to the authority. Both directions must be lossless, and the pre-switch state must be archived per the project rule.
- The version floor is itself a migration concern: a user on an old extension must get a clear refusal, not a broken board.

## Dependencies

- **Requires** the sidecar/real-binding plan — the sidecar owns the replica, and the driver interface it introduces is what this plan implements a second time. Note that the operational risks below (distributed migrations, conflict policy, replication lag, token handling) are properties of putting a database on a network and are unchanged by any client-library choice. They, not the driver, are the real cost of this plan.
- **Requires** the unscoped-tables plan — a shared database needs every table scoped.
- **Requires** the single-global-database plan — that topology (one store, many workspaces) is the remote topology; without it there is nothing coherent to replicate.
- **Requires** the backup/export plan — seeding the remote and promoting the replica both use the export machinery.

## Adversarial Synthesis

**"Notion and every other cloud tool does this with a hosted database, so we should use Postgres."** Notion's cloud is a consequence of being a hosted product with a server team and an ops budget, not the thing that gives it its data model. What is worth taking from Notion is the *shape* — one store, many projects, stable ids, cross-project views — and that shape is already achieved by the global local database. Adopting Postgres to imitate the deployment model buys the 18-`rowid` rewrite, loses offline, and adds a service to operate.

**"Build the seam and stop there; skip the remote backend."** A defensible position, and the reason the seam is separable in the change list below. The counter is that a seam with only one implementation is unverified — the second mode is what proves the abstraction is real rather than nominal. Which is why the seam is the one part of this plan marked worth building regardless — it is valuable for testability alone, and it is what keeps this decision cheap to defer instead of expensive to reverse.

**"Users will want their own Postgres."** Some will ask. The support-burden argument stands on its own: arbitrary endpoints across 4,000 installs means owning every operational failure in someone else's database. If demand is proven, Postgres becomes a third implementation behind the same seam, which is exactly what the seam is for — and the seam is what makes that decision cheap to defer rather than expensive to reverse.

**"Offline conflict resolution is being hand-waved."** Accurate, and stated as such: last-writer-wins with a retained loser is a policy, not a merge. It is chosen because a genuine merge UI for board state is a product in itself, and because the retained loser means the policy is never silently destructive. This is the plan's weakest point and should be reviewed as such.

## Proposed Changes

1. **Consolidate and extract the repository seam.** Reduce the 222-method surface where methods are near-duplicates, then define it as an interface. This is the deliverable that has value independent of any remote backend.
2. **`src/services/storage/localSqlite.ts`** — the existing behaviour, moved behind the interface. No functional change.
3. **`src/services/storage/libsqlRemote.ts`** — `@libsql/client` with an embedded local replica, implementing the same interface, plus replica lifecycle (bootstrap, sync cadence, lag reporting).
4. **Distributed migration safety** — advisory lock plus a schema version floor that refuses to open a database newer than the client understands, with a clear user-facing message.
5. **Read-path batching** for the per-card N+1 patterns, done before the remote backend is enabled.
6. **Setup-panel remote section** — endpoint, token (into `encryptedSecretsStore`), test, replication status, and an explicit statement of what is being uploaded. Present the `NotionBackupService` mirror as the lighter alternative.
7. **Enable/disable paths** — seed remote from local, and promote replica to local, both via the export machinery, both archiving the pre-switch state.
8. **Conflict audit table** retaining losing row versions.

### Migration

Opt-in, reversible, lossless in both directions, pre-switch state archived. The version floor prevents an old client from touching a newer shared database.

## Verification Plan

- **Interface parity:** run the entire existing test suite against both backends. Identical results is the acceptance bar for the seam being real.
- **Offline:** disconnect the network, drive 100 card moves, reconnect. Assert every write replicates, no data is lost, and the board was fully usable while disconnected.
- **Divergence:** two replicas write the same plan offline; reconnect both. Assert the conflict policy applies deterministically and every losing version is present in the audit table.
- **Version floor:** point an older client at a database migrated by a newer one. Assert a clear refusal with no write and no partial migration.
- **Concurrent migration:** two clients at the same older version race a migration. Assert the advisory lock serialises them and the schema ends at head exactly once.
- **Dialect:** assert all 18 `rowid` sites, `last_insert_rowid()` at `:4094`, the 6 `PRAGMA` uses, and the 15 `datetime('now')` calls behave identically on the remote backend.
- **Latency:** measure board refresh against a local replica and against a deliberately delayed remote. Assert the replica path is within noise of local-only, and record the delayed-remote number so the N+1 exposure is known rather than assumed.
- **Secrets:** assert the token appears only in `encryptedSecretsStore` — grep logs, `config`, settings JSON, plan files, snapshots, and `kanban-board.md`.
- **Round-trip:** enable remote, seed, disable, promote replica. Assert the local database matches the pre-enable state plus everything written in between.

## Outstanding Questions

- How much of the 222-method surface is genuinely distinct? The consolidation pass answers this and sets the real cost of the seam.
- Should the embedded replica be per-machine or per-sidecar? Per-machine matches the global-store topology.
- Is there a supported path for a user to take their data *out* of the blessed provider, beyond the per-project export? A full remote-to-local promotion covers it, but it should be a documented operation rather than an implementation detail.
