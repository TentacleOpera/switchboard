# A libSQL shared store, hosted on Turso or self-hosted sqld, as an opt-in authoritative target

## Goal

Let an operator point the shared tier at a libSQL server — Turso, or sqld they run themselves, on their machine or a box they own — so board state is authoritative off-machine and reachable from every machine and cloud session they work in. Local reads stay local and microsecond-fast via an embedded replica; offline keeps working. Bring-your-own credential, always: Switchboard ships a client and never an account.

### Problem Analysis

**The board is unreachable from most of the places work happens.** `board-state-remote-mirror-channels.md` states the gap plainly: "a remote/web-only agent (e.g. a claude.ai session with no DB or local API access) has **no other way** to read current board state — it reads these files from the repo." That is why `.switchboard/kanban-board.md` is regenerated into the working tree on every persist, why its timestamp line broke `planAutoFetch`'s clean-tree guard, and why two agent PRs merged during that plan's own investigation each carried a conflicting regenerated copy. `RemoteControlService` drives the board through Notion and Linear because there is no shared writable state to drive instead. An entire subsystem exists to route board changes through a third-party ticket tracker.

**The storage feature ruled networked stores out, and the reasoning does not survive contact with libSQL.** It says: "Deliberately not a networked database of any kind. The measured dialect coupling (18 load-bearing `rowid` sites, 13 `AUTOINCREMENT`, 6 `PRAGMA`, 15 `datetime('now')`), the loss of offline operation, and a mandatory data migration across ~4,000 installs buy nothing that a real SQLite binding does not already deliver." Every clause of that is aimed at a foreign-dialect server, and libSQL is a SQLite fork:

- **Dialect coupling** — `rowid`, `AUTOINCREMENT`, `PRAGMA` and `datetime('now')` are SQLite semantics that libSQL preserves. The 52 measured sites are not a migration cost here.
- **Loss of offline operation** — an embedded replica keeps a local SQLite file as the read path. Offline is the default mode, not a degraded one.
- **Mandatory migration across 4,000 installs** — there is none. Local file stays the default; this is opt-in per install.

What the rejection correctly kills is a *foreign-dialect local engine*. It does not reach libSQL, and the feature's paragraph has been amended to say so.

> **Amended — the rejection does not kill a foreign-dialect REMOTE either, and this plan should not claim it does.** The paragraph above establishes that the three clauses miss libSQL. Re-run them against the shared tier and they miss a foreign remote for the same reasons: the 52 dialect sites execute against the local store, which stays SQLite here by construction; offline is a property of the two-tier split (local store is the read path) rather than of the remote's engine; and no install is migrated because local stays the default and any remote is opt-in. The tier this plan targets is roughly sixteen scalar fields per card changing at human pace — `split-shared-board-state-from-machine-local-runtime.md` measures it six orders of magnitude below the machine-local write volume. Nothing about holding sixteen fields requires SQLite semantics.
>
> The sibling target settles it: `git-carried-shared-board-state.md` proposes `board.json` on an orphan branch for the *same* tier — not SQLite, not SQL, not a database. A dialect argument that admits a JSON blob cannot exclude Postgres.
>
> This plan's case for libSQL therefore rests on the two reasons that actually survive, and it should be argued on those alone: **schema symmetry**, so the shared tier needs no mapping layer in either direction and the local-side conversion is a no-op; and **no sync engine to write**, because the embedded replica supplies one. Both are real. Neither is a dialect-compatibility requirement, and a competing proposal that pays for a mapping layer and its own sync is not disqualified — it is a different trade.

**Why a remote and not just a hot local DB.** The remote's job is **arbitration and durability**, not query serving. A shared store is authoritative because it *orders* writes: two machines write, the server serialises, and the loser can tell it lost. That property is what a backup, a mirror, or a Notion database cannot supply at any price — and it is the only reason to accept a network dependency at all.

**And one capability is Turso's alone, for now.** Turso has an MCP server, so a cloud agent — a claude.ai session, a hosted runner, anything whose host loads an MCP — can write to the store directly, with no git credentials and no local machine. A self-hosted sqld cannot match that without a Switchboard MCP that does not exist, or an exposed API a cloud agent cannot tunnel to. Remote authoring itself is not new — `switchboard-remote.md` already has cloud agents author plans into Linear or Notion, and `LinearSyncService.ts:2715` materialises them to a plan file. What the store adds is doing it without a SaaS dependency, which matters most for an operator self-hosting precisely to avoid one. `remote-authoring-over-the-shared-store-as-a-provider-kind.md` covers it as a fourth provider kind rather than a new pipeline. Note the parity gap it implies: a Switchboard MCP would let self-hosted remotes do the same, and is worth building for that reason.

### Root Cause

Board state was designed as single-machine state, so the only distribution channels ever built were one-directional exports. Every multi-machine capability since has been an approximation layered on a channel that cannot carry writes.

### Non-goals

- A Switchboard-hosted service. There is no SaaS and no Switchboard-operated database, now or planned. Every target is infrastructure the operator owns.
- Access control. Switchboard cannot enforce what it does not operate; see the security section for what this means and what it does not.
- Moving the local tier remote. Only the shared tier travels (`split-shared-board-state-from-machine-local-runtime.md`).
- Postgres, MySQL, or any foreign dialect **as the local engine**. The storage feature's rejection stands there, on the 52 dialect sites, offline operation and forced migration. It is *not* a non-goal of the wider storage topology to consider a foreign-dialect remote for the shared tier — that would be an operational choice (auth, hosting, cost, concurrency, mapping-layer ownership), and this plan does not pre-empt it. What this plan asserts is narrower: libSQL is a good target because of schema symmetry and a supplied sync engine, not because rival dialects are ineligible.

### Verified against upstream 2026-09-05 — naming, stability, and where the server should run

**The name in this plan is out of date.** The standalone `sqld` repository is reported archived; the server now lives as `libsql-server` inside `tursodatabase/libsql`. Distribution is Homebrew, Docker, or a Rust toolchain. Read replicas are documented. Rename before coding, or the install instructions will point at an archived repo.

**Stability could not be established from the primary source.** The `libsql-server` README states no lifecycle designation — not beta, not production-ready, nothing. A secondary source puts it at v0.24.x and describes it as beta, and warns that libSQL moves fast and older write-ups disagree with current behaviour.

That uncertainty is material for a store this plan proposes to make *authoritative* for board state. **Establish the current stability position from upstream before committing**, and record the answer here. If it is beta, that is not necessarily disqualifying — the embedded replica keeps a local SQLite file as the read path, so a remote outage degrades to offline rather than to data loss — but it must be a decision taken with the fact in hand, not by omission.

**Put the server on the always-on machine, not the capable one.** The obvious instinct is to host it on the workstation. That is backwards for an operator whose reason for a second machine is powering the workstation down: the store would disappear exactly when running lean.

Host it on the low-power always-on box — a Pi serving a 9 MB database is trivial work. The workstation then keeps an embedded replica, works offline from it when the store is unreachable, and syncs on return. The always-on box holds the truth; the powerful box does the work.

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
- **Read volume, not just write volume, argues for replica-only.** The plan scanner performs a `db.hasPlan()` read per candidate every 10 seconds (`switchboard.planScanner.intervalSeconds`, default 10). Against an embedded replica those are local and free; against a remote-only connection they are a round trip per candidate per tick, indefinitely. This compounds the board-paint latency argument in decision 2 — remote-only is not merely slower to paint, it holds a standing per-tick read cost.
- **The free tier is load-bearing in the product rationale and unverified in detail.** Secondary sources put it at 10M row writes and 500M row reads per month, 5GB, ~100 databases — `turso.tech` and `docs.turso.tech` were unreachable from the authoring session, so the numbers need confirming at the source. Against them: human-paced shared-tier writes are trivially inside budget, but only *because* the tier split keeps liveness local. Unverified amplifiers: whether index maintenance counts toward rows-written, and how embedded-replica frame sync is metered. Both must be measured before the free tier is stated as a supported configuration.
- **Keep token scoping in proportion: it is defence-in-depth, not a control this design rests on.** The controls that actually hold are structural and hold with a fully-privileged token: a typed switch schema with no free-text column cannot carry an instruction whoever writes it; plans materialise through the file-and-import path so column canonicalisation, resolve-only project semantics and the feature cascade apply regardless of the writer; and the review gate keys on a column role, not a credential. An earlier revision of this plan called a shared token "a shared root password", which is true in the abstract and mostly irrelevant given those controls — but it made scoping look load-bearing, and the execution-trigger gate and the sqld research both inherited that framing.
  The one thing scoping would convert from convention to enforcement is "a remote agent writes the queue, never `plans` directly" — and that is better handled by making the file path the obviously cheaper route than by policing the alternative. A direct row insert produces a **card with no file behind it**, which is the defect class the board-integrity feature already describes ("a plan file removed while nothing was watching leaves its row active forever with no tool to find it") and which `add-board-disk-reconciliation-skill.md` exists to detect; plus a wrong `workspace_id` silently placing a card on another workspace's board, and `is_feature`, the field with a clobber investigation open since July 2025. Real consequences, but lingering-and-findable rather than a security event. Do not build a scoped-minting flow on the assumption something depends on it.
- **Token scoping is real, and better than first assumed — but it is not row-level.** Turso's docs (`tursodatabase/turso-docs`, `sdk/authorization.mdx`) document five scoping levels: group, database, read-only, **table + action** via `-p <table>:<actions>`, and expiry. So a credential can be least-privileged — `-p all:data_read -p plan_inbox:data_add` reads the board and may only insert into the authoring queue. An earlier revision of this plan asserted "a shared token is a shared root password"; that is true of a **default full-access** token, not of a scoped one, and the difference is load-bearing for the agent-authoring story.
  What scoping does **not** give is row-level isolation: a holder of `all:data_read` reads every row, so `device_id = os.hostname()` plus `user_id` remains attribution and not authorisation, and per-person data boundaries are still out of reach. The panel must state which of the two it is rather than implying Switchboard protects them.
  **Verify empirically, not from docs.** Mint a scoped token, then attempt a write it should not have and confirm rejection. Docs and CLI drift, and this is the control the agent-authoring design rests on.
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
- **Token scoping enforced by the store:** mint a token scoped `-p all:data_read -p <queue>:data_add`. Assert a read succeeds, an insert into the queue succeeds, and an insert or update against `plans`, `features` and `projects` is **rejected by the database**. This is the test that converts a documented capability into a relied-upon control.
- **Self-hosted parity:** run the same suite against a local sqld instance, including a private-CA connection.

## Outstanding Questions

- Confirm at source: free-tier row-write/row-read ceilings, whether index maintenance counts toward rows-written, how embedded-replica frame sync is metered, and what point-in-time restore the free tier includes.
- Confirm the `libsql` package's better-sqlite3 API compatibility and its actual prebuild matrix. Both are load-bearing for the per-target binding recommendation and were asserted from memory during authoring, not verified.
- **Answered: sqld does not support table+action scoping. This is the first real capability difference between the two targets.** A research pass returned NOT SUPPORTED, and the architectural argument is the convincing part rather than the citations: SQLite has no native table-level authorization, so enforcing it requires registering an authorizer via `sqlite3_set_authorizer` or rewriting statements before execution. sqld maps JWT claims to whole-connection read-only versus read-write and registers no such authorizer, so table scoping cannot be enforced whatever the token asserts. `-p <table>:<action>` is a Turso Cloud control-plane feature, not a property of the open-source server.
  **Consequence:** Turso can issue a cloud agent a queue-only credential; a self-hosted sqld can issue only read-only or read-write. The application-level execution gate in `the-remote-command-vocabulary-is-closed.md` therefore **stays for the sqld target** even where Turso's scoping allows relaxing it, and the Database panel must not present the two targets as equivalent on least-privilege.
  **One sub-claim is deliberately not relied upon.** The same pass asserted that sqld *silently ignores* unrecognised fine-grained claims and defaults to read-write — failing open. That is plausible but was inferred from general `serde` behaviour without quoting the claims struct (whether it carries `deny_unknown_fields` decides it), reported without line-level citation, and not confirmed by the empirical container test that would settle it. **Design around it instead of resolving it:** never offer scoped-credential minting for a sqld target. If the product cannot produce a table-scoped token for sqld, no operator can hold one under a false belief that it is scoped, and the server's unverified behaviour becomes unreachable. That is cheaper than the research and strictly safer than trusting either answer.
- Should the panel refuse to *offer* a libSQL target when the tier split has not landed, rather than trusting sequencing?

## Settled — do not re-raise

**REJECTED. The operator does not want libSQL, stated plainly on 2026-09-01.** This plan is not
deferred, not sequenced behind anything, and not a candidate to revisit when other work lands.
Do not cite it as a prerequisite. Do not propose it as an option in a storage comparison.

Three independent reasons, any one of which is sufficient:

**1. Its own stated niche is a mode that is refused.** This plan's sibling puts it exactly:
"For a team where people mostly move their own cards, [git] is the better default. **For live
multi-machine coordination, libSQL is.**" Live multi-machine coordination is remote-board with
local agents as a second host — refused in
`switchboard-as-a-local-app-and-a-self-hosted-remote.md`. The niche and the refused mode are the
same thing.

**2. The cloud-agent justification is served twice over without it.** `RemoteControlService`
already drives the board through Linear, with `switchboard-remote.md` and the
`improve-remote-plan` skill built on it; and `BoardSnapshotPublisher` already publishes
`board.json` to the orphan branch `switchboard/board` for any agent holding a checkout. Neither
needs a database server.

**3. It asks the operator to run infrastructure to use a kanban board.** Bring-your-own
credential means standing up sqld or a Turso account, pointing hosts at it, managing the
credential, and reasoning about a lease model when a write loses. That cost is not proportionate
to the problem at any team size this product targets.

**What covers the surviving cases:** `git-carried-shared-board-state.md` — a team sharing a
board through a remote they already trust, and a private board over a public repo. It needs no
server, no account and no credential beyond the repo's own. That plan is **not** settled and
retains its own justifications; so does its hard prerequisite,
`split-shared-board-state-from-machine-local-runtime.md`, which defines what a snapshot may
contain.

**What would reopen this:** nothing currently foreseen. A future need for live, sub-second,
multi-writer board coordination would be a new requirement, and would have to justify itself from
scratch rather than by pointing at this plan.
