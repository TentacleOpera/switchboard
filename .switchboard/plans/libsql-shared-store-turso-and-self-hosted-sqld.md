# A libSQL shared store, hosted on Turso or self-hosted sqld, as an opt-in authoritative target

## Goal

Let an operator point the shared tier at a libSQL server — Turso, or sqld they run themselves, on their machine or a box they own — so board state is authoritative off-machine and reachable from every machine and cloud session they work in. Local reads stay local and microsecond-fast via an embedded replica; offline keeps working. Bring-your-own credential, always: Switchboard ships a client and never an account.

### Problem Analysis

**The board is unreachable from most of the places work happens.** `board-state-remote-mirror-channels.md` states the gap plainly: "a remote/web-only agent (e.g. a claude.ai session with no DB or local API access) has **no other way** to read current board state — it reads these files from the repo." That is why `.switchboard/kanban-board.md` is regenerated into the working tree on every persist, why its timestamp line broke `planAutoFetch`'s clean-tree guard, and why two agent PRs merged during that plan's own investigation each carried a conflicting regenerated copy. `RemoteControlService` drives the board through Notion and Linear because there is no shared writable state to drive instead. An entire subsystem exists to route board changes through a third-party ticket tracker.

**The storage feature ruled networked stores out, and the reasoning does not survive contact with libSQL.** It says: "Deliberately not a networked database of any kind. The measured dialect coupling (18 load-bearing `rowid` sites, 13 `AUTOINCREMENT`, 6 `PRAGMA`, 15 `datetime('now')`), the loss of offline operation, and a mandatory data migration across ~4,000 installs buy nothing that a real SQLite binding does not already deliver." Every clause of that is aimed at a foreign-dialect server, and libSQL is a SQLite fork:

- **Dialect coupling** — `rowid`, `AUTOINCREMENT`, `PRAGMA` and `datetime('now')` are SQLite semantics that libSQL preserves. The 52 measured sites are not a migration cost here.
- **Loss of offline operation** — an embedded replica keeps a local SQLite file as the read path. Offline is the default mode, not a degraded one.
- **Mandatory migration across 4,000 installs** — there is none. Local file stays the default; this is opt-in per install.

What the rejection correctly kills is Postgres. It does not reach libSQL, and the feature's paragraph needs amending to say which of the two it meant.

**Why a remote and not just a hot local DB.** The remote's job is **arbitration and durability**, not query serving. A shared store is authoritative because it *orders* writes: two machines write, the server serialises, and the loser can tell it lost. That property is what a backup, a mirror, or a Notion database cannot supply at any price — and it is the only reason to accept a network dependency at all.

**And one capability is Turso's alone, for now.** Turso has an MCP server, so a cloud agent — a claude.ai session, a hosted runner, anything whose host loads an MCP — can write to the store directly, with no git credentials and no local machine. A self-hosted sqld cannot match that without a Switchboard MCP that does not exist, or an exposed API a cloud agent cannot tunnel to. Remote authoring itself is not new — `switchboard-remote.md` already has cloud agents author plans into Linear or Notion, and `LinearSyncService.ts:2715` materialises them to a plan file. What the store adds is doing it without a SaaS dependency, which matters most for an operator self-hosting precisely to avoid one. `remote-authoring-over-the-shared-store-as-a-provider-kind.md` covers it as a fourth provider kind rather than a new pipeline. Note the parity gap it implies: a Switchboard MCP would let self-hosted remotes do the same, and is worth building for that reason.

### Root Cause

Board state was designed as single-machine state, so the only distribution channels ever built were one-directional exports. Every multi-machine capability since has been an approximation layered on a channel that cannot carry writes.

### Non-goals

- A Switchboard-hosted service. There is no SaaS and no Switchboard-operated database, now or planned. Every target is infrastructure the operator owns.
- Access control. Switchboard cannot enforce what it does not operate; see the security section for what this means and what it does not.
- Moving the local tier remote. Only the shared tier travels (`split-shared-board-state-from-machine-local-runtime.md`).
- Postgres, MySQL, or any foreign dialect. The storage feature's rejection stands for those.

## Metadata

**Complexity:** 9
**Tags:** database, backend, infrastructure, reliability, security, devops, feature

## User Review Required

Yes — four decisions.

1. **Binding placement.** The sidecar plan decided `better-sqlite3`, and that decision should stand: `libsql`'s prebuild matrix is narrower, and unlike `node-pty` behind `isPtyAvailable()` a missing database binding has no graceful degradation. Recommendation: the sidecar resolves its binding **per storage target** — `better-sqlite3` for local, `libsql` lazily loaded as an `optionalDependency` only when a libSQL target is configured. Local-only installs never load it, so they take no prebuild risk for a feature they do not use.
2. **Write path.** Embedded replica (local read path, writes forwarded to the remote, periodic `.sync()`) versus remote-only. Recommendation: embedded replica only. Remote-only makes every board paint a network round-trip against read paths the storage feature already flags as N+1.
3. **Sync cadence.** Recommendation: sync on local write, on board focus, and on a slow timer (30–60s) — not a fast poll. The number should be set after the write-volume measurement, not before.
4. **Offline write posture.** Recommendation: reads served from the replica, writes **refused with a visible state** rather than queued. A queue means a divergent local branch of board state with no arbitration on reconnect, which is the property this plan exists to buy.

## Complexity Audit

### Routine

- Target configuration: URL, auth token into `encryptedSecretsStore`, reachability probe, fingerprint display.
- The `optionalDependency` pin (exact version, following the `node-pty 1.1.0` precedent) and the `.vscodeignore` allowlist entry.
- Health reporting into the Database panel's status contract.

### Complex / Risky

- **Schema migration against a shared remote is the sharpest risk in this plan, sharper than latency.** Today migrations are per-file and single-machine: `migration_meta` is local, and version-gated ALTERs assume one writer. Two machines on different extension versions both migrating one Turso database is how a shared board gets corrupted rather than one local file. Needs a migration lock row plus a version gate, and a client that refuses to open a store migrated *ahead* of it rather than running a downgrade.
- **The free tier is load-bearing in the product rationale and unverified in detail.** Secondary sources put it at 10M row writes and 500M row reads per month, 5GB, ~100 databases — `turso.tech` and `docs.turso.tech` were unreachable from the authoring session, so the numbers need confirming at the source. Against them: human-paced shared-tier writes are trivially inside budget, but only *because* the tier split keeps liveness local. Unverified amplifiers: whether index maintenance counts toward rows-written, and how embedded-replica frame sync is metered. Both must be measured before the free tier is stated as a supported configuration.
- **A shared token is a shared root password.** Turso has no row-level security. Every holder can write or drop everything, and `device_id = os.hostname()` records a machine, not a person. For one operator across three machines that is the correct trust level. For a team it is the ceiling of this tier, and the panel must say so rather than implying Switchboard is protecting them.
- **Stale-read window.** Between syncs a replica can serve a card's old column. Two operators can each move the same card believing it unmoved; the server orders the writes, so nothing corrupts, but the second move silently wins. Needs a defined sync-before-write for board moves specifically, or an explicit "moved under you" surfacing.
- **The switch is a data migration.** Adopting a libSQL target means copying the shared tier up, verifying it, and cutting over — with the source left intact as `.migrated.bak` per project rule, and a verified rollback.

## Edge-Case & Dependency Audit

**Race conditions**
- First-adopter race: two machines both initialising the same empty remote. Needs a claim row so the second machine adopts rather than overwrites.
- `.sync()` mid-write, and sync racing a schema migration. Serialise both behind the sidecar's single ownership.

**Security**
- Token in `encryptedSecretsStore`, never `settings.json`, never echoed to a webview in full.
- TLS verification is not optional, including for self-hosted sqld with a private CA — support supplying a CA, never a "skip verification" toggle.
- The privacy tension with `retire-cloud-file-sync-db-path-presets.md` must be stated, not left implicit. That plan counts removing third-party cloud upload of board state as a privacy improvement. This plan reintroduces off-machine storage — but as an explicit, opt-in, named target the operator chooses, rather than a preset button that looked like picking a folder. That difference is the whole justification and belongs in the release note.

**Side effects**
- `RemoteControlService`'s reason for existing weakens once shared writable state exists. Not retired here, but the plan should note that its Notion/Linear control path becomes one option rather than the only one.
- `BoardSnapshotPublisher` and `.switchboard/kanban-board.md` keep being written per-repo — agent-facing surfaces and `/switchboard-cloud` depend on them regardless of store.
- Backups become *more* load-bearing, not less: an authoritative remote you do not operate still needs `board-backup-and-per-project-export`. Check what point-in-time restore the free tier actually provides.

**Migration**
- No forced migration for anyone. Adopting is opt-in; reverting to local must be equally supported and equally verified, because the first operator to try this will want out.

## Dependencies

- **Hard prerequisites:** the sidecar/real-binding plan (single owner), the tier split (only shared state travels), the unscoped-tables plan (workspace scoping), and the backup plan (durability of an authority you do not run).
- **Amends** the storage-layer-overhaul feature's "deliberately not a networked database" paragraph, and the sidecar plan's binding decision, to add per-target resolution.
- **Pairs with** the sync-owner lease plan: multiple machines against one shared store multiplies provider-sync loops.

## Adversarial Synthesis

Key risks: concurrent schema migration against a shared remote can corrupt a shared board rather than one local file; the free-tier budget is quoted from secondary sources with two unmeasured amplifiers (index maintenance, replica frame sync); a shared token grants unrestricted write access with only machine-level attribution; and the stale-read window lets a second card move silently win. Mitigations: migration lock plus version gate with refusal to open a store migrated ahead of the client; measure write volume and confirm quotas at source before declaring the free tier supported; state the shared-token ceiling in the panel rather than implying protection; sync-before-write for board moves with explicit "moved under you" surfacing; opt-in adoption with a verified rollback to local.

## Proposed Changes

1. **A store-target abstraction in the sidecar** — `local-file` and `libsql` targets behind one interface: open, health, sync, and a declared arbitration guarantee the panel renders verbatim.
2. **Per-target binding resolution** — `better-sqlite3` for local; `libsql` lazily required for libSQL targets, pinned exactly, as an `optionalDependency` with a `.vscodeignore` allowlist entry, and a clear failure message when the prebuild is missing.
3. **Embedded-replica configuration** — the consolidation plan's `~/.switchboard/switchboard.db` becomes the replica file; writes forward to the remote; `.sync()` on write, on focus, and on a slow timer.
4. **Migration lock and version gate** on the shared store, with refusal (never downgrade) when the remote is ahead of the client.
5. **Adoption and rollback flows** — copy shared tier up, verify row counts and integrity, cut over, leave the source as `.migrated.bak`; the reverse path is a first-class, tested operation.
6. **Offline posture** — replica reads, refused writes, visible state in the Database panel.
7. **Write-volume instrumentation** feeding a quota estimate the panel can show against the configured plan.

### Migration

Opt-in only; no install is moved without an explicit action. Adoption imports before deleting nothing — the local file is retained as `.migrated.bak` and never unlinked. Rollback to local is supported and verified.

## Verification Plan

- **Read latency:** board paint against an embedded replica versus a local file; assert no material regression, and assert remote-only is not reachable as a configuration.
- **Arbitration:** two clients, same remote, simultaneous moves of the same card for 60s. Assert zero lost writes, a serialised final state, and that the losing client can detect it lost.
- **Concurrent migration:** two clients at different schema versions open one remote simultaneously. Assert exactly one migrates, the other waits or refuses, and the remote is never left half-migrated. Assert an older client refuses a store migrated ahead of it.
- **Offline:** sever the network. Assert reads succeed from the replica, writes are refused with a visible state, and reconnect resumes without a divergent local branch.
- **Quota:** run a representative 24h session with instrumentation; report measured shared-tier row writes and extrapolate against the confirmed free-tier ceiling. Assert index-maintenance and replica-sync accounting were measured, not assumed.
- **Adoption and rollback:** adopt a remote from a populated local store; assert row-for-row equality, source retained as `.migrated.bak` with original bytes. Roll back; assert equality again.
- **Secret hygiene:** assert the token is absent from `settings.json`, absent from webview payloads, and that no configuration path disables TLS verification.
- **Self-hosted parity:** run the same suite against a local sqld instance, including a private-CA connection.

## Outstanding Questions

- Confirm at source: free-tier row-write/row-read ceilings, whether index maintenance counts toward rows-written, how embedded-replica frame sync is metered, and what point-in-time restore the free tier includes.
- Confirm the `libsql` package's better-sqlite3 API compatibility and its actual prebuild matrix. Both are load-bearing for the per-target binding recommendation and were asserted from memory during authoring, not verified.
- Does sqld support scoped tokens well enough to give a team read-only members, or is per-person authorisation strictly out of reach at this tier?
- Should the panel refuse to *offer* a libSQL target when the tier split has not landed, rather than trusting sequencing?
