# Back Up `integration-config.json` on Every Significant Write, and Make Restoring It a Ten-Second Operation

## Goal

Make any corruption of `~/.switchboard/integration-config.json` recoverable, regardless of cause. Snapshot the file before each *significant* write into a rotating generational store, and add a restore command that lists the snapshots with enough summary detail to pick the right one without opening a file. This is the only mitigation in this area that covers corruption classes no write-time guard anticipates.

### Problem

Every other defence for this file is a *predicate* — it blocks writes matching a known-bad shape. Predicates only catch what someone thought of in advance. The 2026-07-30 incident is the proof: a fixture write replaced a working `clickup` blob, and no guard existed because nobody had anticipated a test writing to the real home directory. A backup does not need to anticipate anything.

**This has already happened at least three times, and each recovery improvised its own backup.** `~/.switchboard/` currently contains three ad-hoc snapshots in three different naming schemes. They are **automated artifacts of prior repair sessions — agent-generated, not typed by hand** — and, critically, **no shipped code produces them.** Verified 2026-07-31 by string search across the working tree, the full git history (`git log --all -S`), and both installed bundles (`turnzero.switchboard-1.7.13` under `~/.devin/extensions`, `1.7.3` under `~/.windsurf/extensions`): zero hits for `pre-restore`, `before-wsid-repair`, or `integration-config.json.bak`. The only in-repo mention of `pre-restore` is a plan document describing the *`kanban.db`* backup zoo. So the automation that produced these files is per-session and ephemeral, which is exactly why each one invented a fresh naming scheme:

| File | mtime | `clickup.workspaceId` | `clickup.selectedListId` | keys |
| :--- | :--- | :--- | :--- | :--- |
| `integration-config.json.pre-restore.bak` | 2026-06-24 17:25 | `6909707` | `901613739289` | 20 |
| `integration-config.json.bak.20260630140139` | 2026-06-30 14:01 | `6909707` | `901613739289` | 20 |
| `integration-config.json.bak.before-wsid-repair` | 2026-07-31 05:05 | **`ws-123`** | **`""`** | 22 |
| `integration-config.json` (live) | 2026-07-31 05:05 | `6909707` | **`""`** | 22 |

Three things follow from that table, and they are the entire case for this plan:

1. **A `pre-restore` backup from 2026-06-24 means a restore already happened once**, five weeks before the incident that prompted this work. This is a recurring failure mode, not a one-off.
2. **An attempt to recover the 2026-07-30 collateral damage from these files was itself wrong, and had to be reverted.** Six `clickup.selected*` fields were copied from the 2026-06-30 snapshot on 2026-07-31 and reverted the same day (see Verification 20). The snapshot predated the corruption by a month and held `Sprint 116 (21/5 - 3/6)`, a sprint that ended eight weeks before. Nothing established what the selection was immediately *before* the bad write — only that it was populated a month earlier and blank a day after — and the ClickUp tickets directory had been inactive since 2026-07-02, so there was no newer selection to recover either. **This is a requirement, not an anecdote:** ad-hoc recovery from undated snapshots produces confidently wrong writes, and a restore feature that does not surface snapshot age will automate that error rather than prevent it. See §3's guardrails, which exist because of this.
3. **The recovery mechanism is already being improvised, inconsistently, by whatever agent happens to be doing the repair** — three incompatible naming conventions, no rotation, no pruning, no reason recorded in two of the three, and no guarantee a snapshot exists at all next time. That last point is the real gap: these three files exist because someone thought to make them *before* editing. Nothing takes a snapshot when the destructive write comes from a test, a sync, or a code path nobody is watching — which is precisely how 2026-07-30 happened. **The behaviour must move into the product, where it fires unconditionally.**

### Root cause

- **`saveGlobal` is a destructive in-place replace with no history.** `GlobalIntegrationConfigService.saveGlobal()` ([:175-197](../../src/services/GlobalIntegrationConfigService.ts#L175)) writes `${filePath}.tmp` then `rename`s it over the target. The rename is atomic, so a write is never *torn* — but the previous content is gone the instant it lands. Atomicity protects against partial writes; it does nothing about wrong ones.
- **A second writer bypasses `saveGlobal` entirely.** `_persistMigratedSchedulerIfAbsentSync()` ([:389-408](../../src/services/GlobalIntegrationConfigService.ts#L389)) reimplements the tmp-write-and-rename inline with `fs.writeFileSync` / `fs.renameSync`. Any history mechanism hooked only into `saveGlobal` misses it — and this is the *schema-migration* writer, the one whose writes are hardest to reconstruct by hand.
- **The codebase already knows how to do this, for a different file.** `KanbanDatabase.writeDbBackup(reason)` ([:6532-6554](../../src/services/KanbanDatabase.ts#L6532)) snapshots `kanban.db` into `.switchboard/dbbackup/` with a reason and timestamp, prunes to the 5 most recent, and swallows all errors so a backup failure can never break a write. That pattern was never extended to the machine-global config, which is the one file a user cannot rebuild from the repo.

### Verified against HEAD (2026-07-31, after subtasks 1 and 2 landed in the working tree)

This plan was authored **before** its two sibling subtasks were implemented. Both are now present (uncommitted) in the working tree, and they moved most of the lines this plan targets. Every reference was re-measured; the forensic prose above is preserved verbatim and corrected here.

| Claim as written | Measured at HEAD |
| :--- | :--- |
| `saveGlobal()` at `:175-197` | **`:176-198`** (body unchanged: `mkdir` → `.tmp` write `mode: 0o600` → `rename`) |
| `_persistMigratedSchedulerIfAbsentSync()` at `:389-408` | **`:469-488`** — drifted **80 lines**; still the inline tmp-write-and-rename bypass, unchanged |
| `loadGlobal()` / `loadGlobalSync()` `!existsSync` → `{}` branches at `:144`, `:157` | **`:145`, `:159`** — both still return `{}`, so the `copyFile`-not-`rename` argument in §1 holds exactly as written |
| `getFilePath()` is `stateFile('integration-config.json')` at `:128` | confirmed at **`:128`** (declaration `:127`) — the seam is real and is the only state root |
| `ClickUpSyncService._config` assignment at `:566` | **`:569`**, and now guarded by `if (res.saved !== false)` |
| `LinearSyncService._config` assignment at `:304` | **`:307`**, same guard, plus `_cachedProjects` / `_cachedMembers` nulled at `:308-309` |
| `config.lastSync = new Date().toISOString()` at `ClickUpSyncService.ts:3014-3015` | **`:3066-3067`** — still the only `lastSync` writer in the codebase |
| `setMcpMonitorConfig({ sourceLastCheckAt })` at `TaskViewerProvider.ts:22604` | confirmed at **`:22604`** — unchanged |
| `writeDbBackup` at `KanbanDatabase.ts:6532-6554` | confirmed unchanged, pruning flaw still present |
| "`saveGlobal` is the async write funnel for **8** call sites" | confirmed **8** — seven in-class (`:286`, `:293`, `:344`, `:368`, `:465`, `:520`, `:659`) plus one external, `MigrationService.ts:97`. The external caller inherits the hook for free |

**A third scheduler writer exists and is already covered.** `_persistMigratedSchedulerIfAbsent` (async, `:457-466`) is the sibling of the sync bypass and calls `saveGlobal`, so hooking `saveGlobal` covers it. Only the *sync* variant needs the second hook, exactly as this plan states — but do not assume the sync one is the only non-`saveGlobal` writer without re-checking, because it was not the only scheduler writer.

**The 5-minute churn writer's real target path, confirmed.** `setMcpMonitorConfig` ([:609-660](../../src/services/GlobalIntegrationConfigService.ts#L609)) does **not** write `mcpMonitor.sourceLastCheckAt`. It merges `sourceLastCheckAt` at `:626`, repacks the comms job, and assigns `globalConfig.scheduler = { schemaVersion, jobs }` at `:658` before `saveGlobal` at `:659`. So the load-bearing churn path is `scheduler.jobs[].sourceConfig.sourceLastCheckAt` — which §2 lists. `mcpMonitor` is now **legacy-read-only** (consumed by `_ensureSchedulerMigration` at `:447-448`, written by nothing); keeping `mcpMonitor.sourceLastCheckAt` in the churn list is harmless forward-compat, not live coverage. Note also that `linear.lastSync` and `notion.lastSync` have **no writer at all** — listing them is over-coverage, kept deliberately so a future sync loop inherits the gate.

**One consequence worth stating so it is not mistaken for a gate failure.** `setMcpMonitorConfig` rebuilds `sourceIntervals` as `{ ...DEFAULT_MCP_MONITOR_CONFIG.sourceIntervals, ...current, ...config }` (`:625`) and backfills job defaults (`id`, `label`, `target`, `intervalMinutes`) at `:635-640`. The **first** poll write after any upgrade that adds a default therefore differs in more than a churn field and is correctly classified significant — one extra snapshot, not a rotation storm, because the next read sees the materialised value. Do not "fix" this by adding `sourceIntervals` to the churn list: it is user-configurable, and §2's own edge-case rule forbids listing a user-editable field.

**Supporting evidence for the file-mode requirement (Security).** Of the four loose hand-made snapshots, `integration-config.json.pre-restore.bak` is mode **`0644`** while the live config and the other three are `0600`. The improvised backups already leaked the permission once. That is the concrete precedent for §1 step 4's explicit-mode requirement and verification item 12.

## Metadata

- **Complexity:** 5
- **Tags:** reliability, backend, feature

## User Review Required

None.

## Complexity Audit

### Routine

- The snapshot-and-prune shape already exists and is proven in `KanbanDatabase.writeDbBackup` — extend the pattern, do not invent one.
- A QuickPick-driven restore command follows the 53 existing `vscode.commands.registerCommand('switchboard.…')` registrations in `extension.ts`.
- File sizes are trivial (~3 KB), so retention costs nothing and needs no size budgeting.

### Complex / Risky

- **A naive every-write backup is worthless against the actual failure mode, and this is the central design risk.** Two writers update the config on a timer with no user intent: `setMcpMonitorConfig({ sourceLastCheckAt })` ([TaskViewerProvider.ts:22604](../../src/services/TaskViewerProvider.ts#L22604)), which fires once per comms-monitor poll — the GCD of `sourceIntervals`, default **5 minutes** — and `config.lastSync = new Date().toISOString()` followed by `saveConfig` ([ClickUpSyncService.ts:3014-3015](../../src/services/ClickUpSyncService.ts#L3014)) on every sync run. With polling enabled, a single-slot `.bak` is overwritten within 5 minutes and a flat 5-deep ring within ~25 minutes. **The 2026-07-30 corruption went unnoticed for eight hours.** Any rotation keyed on write *count* loses the good state long before anyone looks. The fix is to gate snapshots on *significance* (§2), which is what makes a 10-deep ring span weeks rather than minutes.
  - Worth stating precisely: on this machine **right now** those churn writers are dormant — `mcpMonitor.pollingEnabled: false`, the `comms-monitor` job is `enabled: false`, and `clickup.lastSync` is `null`. That dormancy is *why* the hand-made 2026-06-30 backup survived to be useful. It is a user-toggleable state, not a property of the system, so the design must hold when polling is on.
- **Backing up must not weaken the atomicity of the write it protects.** See §1 — the obvious `rename` implementation introduces a window with no config file at all, during which a concurrent reader legitimately observes "no config" and can persist a blob built from `{}`. That would convert this plan from a safety net into a new corruption vector.
- **Two writers, one of them synchronous.** `saveGlobal` is `async`; `_persistMigratedSchedulerIfAbsentSync` is sync. The snapshot helper therefore needs both an async and a sync form, or the sync writer stays uncovered.
- **Shipped state, ~4,000 installs.** This adds a new directory under `~/.switchboard` and a new command. It changes no existing key, path, or format, and reads nothing it did not read before — but the snapshot store is new on-disk state, so its naming must not collide with the `*.migrated.bak` convention that means "legacy file archived during migration" elsewhere in the codebase, nor with the three hand-made `.bak*` files already present.
- **The existing precedent has a pruning bug that must not be copied.** `writeDbBackup` builds `kanban.db.backup.${cleanReason}.${ts}` and prunes via a plain lexicographic `.sort()`. Because `reason` precedes the timestamp, the sort orders by reason first and time second — so "keep the 5 most recent" silently keeps the 5 highest *reason strings*, and can delete a newer backup while retaining an older one under an alphabetically-later reason. The new scheme puts the timestamp first specifically to make lexicographic order chronological.

## Edge-Case & Dependency Audit

### Race Conditions

- **Two windows writing concurrently.** Both may snapshot within the same millisecond and collide on filename. Append a short disambiguator (4 hex chars) after the timestamp; a collision then merely overwrites an identical-content snapshot, which is harmless.
- **Snapshot-then-write is not one transaction.** Between the snapshot and the rename, another process can land its own write, so the snapshot may capture a state one generation older than the write it is nominally protecting. This is acceptable and must not be "fixed" with locking: the snapshot's contract is "a recent known state", not "the exact predecessor of this write".
- **Prune racing a concurrent snapshot.** Two processes pruning simultaneously can both try to unlink the same oldest file. Use `.catch(() => {})` per unlink, exactly as `writeDbBackup` does — a double-unlink is not an error condition.
- **Restore racing a background write.** A comms poll or sync can land a write moments after a restore completes, rebuilding a blob from in-memory service caches that still hold pre-restore values and partially undoing the restore. This is the reason the restore flow ends by offering a window reload (§3) rather than assuming the restored file is authoritative in memory.

### Security

- Snapshots must be written `mode: 0o600`, matching `saveGlobal`'s existing mode. A rotating store of world-readable copies of a `0600` file would be a straightforward permissions downgrade.
- The snapshot directory itself should be created `0700`.
- Contents carry no credentials — API tokens live in `SecretStorage`, and the blobs here hold ids, mappings, and flags. The snapshot store is therefore config shape, not secrets. Do not relax the file mode on that basis; the original is `0600` and copies should match it.
- The restore command reads only from its own snapshot directory and writes only to the config path. It must not accept an arbitrary path argument — a command that restores from any file is a write-anywhere primitive reachable from other extensions.

### Side Effects

- **New on-disk state:** one directory (`~/.switchboard/configbackup/`) holding at most 10 files of ~3 KB — a 30 KB ceiling. No cleanup command is needed; the ring is self-limiting.
- **In-memory caches go stale on restore.** `ClickUpSyncService._config` (`:566`), `LinearSyncService._config` (`:304`), and the panels' cached reads all survive a file-level restore. The restore flow must surface this rather than pretend the restore is complete (§3).
- **The four pre-existing loose snapshots are deliberately left in place.** The three agent-generated ones (`*.pre-restore.bak`, `*.bak.20260630140139`, `*.bak.before-wsid-repair`) plus the `*.pre-selected-restore.json` written during the 2026-07-31 field recovery. No shipped code produces or reads them, so there is nothing to migrate — but they are the forensic record of three incidents and one is the provenance of the currently-restored `selected*` values. Do not move, rename, adopt, or delete them; the new store starts empty alongside them. The pruner must ignore anything not matching its own filename prefix (§4) precisely so these survive it.
- **No confirmation dialog anywhere in this plan.** Per CLAUDE.md this is non-negotiable: the QuickPick selection *is* the deliberate action, and a `confirm()`-style gate is both banned and a silent no-op in webview contexts. A multi-choice QuickPick is the explicitly permitted form of decision UI, which is exactly what the restore picker is.

### Dependencies & Conflicts

- **[sandbox-switchboard-state-home-in-tests](sandbox-switchboard-state-home-in-tests.md) has already landed in the working tree, so the seam exists and must be used.** As of 2026-07-31 `src/utils/stateHome.ts` is present and exports `isTestProcess()` / `stateHome()` / `stateFile(...segments)`, and `GlobalIntegrationConfigService.getFilePath()` is now `return stateFile('integration-config.json');` (`:128`). **Derive the snapshot directory as `stateFile('configbackup')`** — never a fresh inline `os.homedir()`. A new hard-coded home root here would be a third state-root site immediately after that plan reduced them to zero, and it would silently escape the test sandbox, letting the suite scribble snapshots into the developer's real `~/.switchboard`. That is the same bug class this whole group of plans exists to close.
  - Free consequence of using the seam: in a sandboxed test process, snapshots land under `$SWITCHBOARD_STATE_HOME` and are removed with it on exit, so the new tests need no cleanup logic of their own.
- **Independent of [integration-config-write-guards-and-stale-id-heal](integration-config-write-guards-and-stale-id-heal.md), and complementary by construction.** That plan makes anticipated bad writes *refused*; this one makes every write *reversible*. Order does not matter.

> **Superseded:** "Note the useful interaction: this plan snapshots **before** the guard runs, so even a write the guard would refuse leaves a snapshot of the good state — and a guard bug that lets something through is still recoverable."
> **Reason:** the first half is now false, and it is false because of where the sibling plan actually put its guards. In the implemented `saveConfig` ([:244-288](../../src/services/GlobalIntegrationConfigService.ts#L244)) the wipe guard (`:263-270`) and the identity-continuity guard (`:272-280`) both `return { saved: false }` **before** `saveGlobal` is reached at `:286`. Since this plan's hook lives *inside* `saveGlobal` (§1 Implementation), a refused write never reaches the snapshot at all. The claim describes an ordering the code does not have.
> **Replaced with:** the surviving half is the one that mattered — **a write that passes the guards snapshots the pre-write state first**, so a guard *bug* (a wrong-but-permitted write) is still recoverable. The lost half costs nothing: a refused write leaves the file byte-identical, so there is no state to recover and a snapshot would be pure noise in a 10-slot ring. **Do not "restore" the original interaction by hoisting the snapshot above the guards in `saveConfig`** — that would spend ring slots on writes that changed nothing, which is the same retention-starvation failure §2 exists to prevent, and it would also miss the seven non-`saveConfig` callers of `saveGlobal`. The hook belongs in `saveGlobal`.

  Two further interactions with that plan, both load-bearing for §2:
  - **Every `saveConfig` write now arrives as a full normalized blob.** Its §1b routes `ClickUpSyncService.saveConfig` (`:560-572`) and `LinearSyncService.saveConfig` (`:298-312`) through `{ ...stored, ...config }` → `_normalizeConfig`, which emits all 22 keys in normalizer order. So the incoming blob's **key order differs from the stored file's on every write**. This is precisely why §2 mandates canonical key-sorted stringify; with raw `JSON.stringify` the gate would classify **every** write as significant and silently disable itself. §2 already anticipated this — it is now confirmed against real code rather than predicted.
  - **The heal is a write from a read path, and it uses `{ replace: true }`.** `_requestWithWorkspaceId` persists a re-resolved id via `saveConfig(existingConfig, { replace: true })` ([ClickUpSyncService.ts:901](../../src/services/ClickUpSyncService.ts#L901)). That write changes `workspaceId` — a non-churn field — so it is significant and **will** snapshot. Correct and desirable: the pre-heal state is exactly what a user would want back if the heal resolved the wrong workspace. Budget one ring slot per heal, not per request.
- No new npm dependencies. `fs`, `path`, and the `vscode` QuickPick API only.

## Dependencies

**One hard dependency, already satisfied.** [sandbox-switchboard-state-home-in-tests](sandbox-switchboard-state-home-in-tests.md) must land first because this plan's snapshot directory **must** be `stateFile('configbackup')` — see Dependencies & Conflicts for why a fresh `os.homedir()` here would re-introduce the bug the whole feature exists to close. That plan is implemented in the working tree as of 2026-07-31, so the seam exists now; the dependency is a *constraint on the implementer*, not a wait.

Independent of [integration-config-write-guards-and-stale-id-heal](integration-config-write-guards-and-stale-id-heal.md) for ordering, but not for design: that plan is also already implemented, and two of its choices bind this one (canonical-stringify is now mandatory rather than prudent; the snapshot hook must stay in `saveGlobal` rather than being hoisted above the guards). Both are recorded in Dependencies & Conflicts.

**Migration:** none required. No existing key, path, or file format changes; nothing is read that was not read before. The snapshot directory is created lazily on first significant write, so an install that never writes config never grows one.

## Adversarial Synthesis

**Risk summary.** The dominant risk is that the obvious implementation is useless: a `.bak` rotated on every write is overwritten within 5 minutes by a dormant-but-user-enableable comms poll, while the incident this plan answers took 8 hours to notice — so snapshots must be gated on significance, not write count, and the gate must use canonical key-sorted comparison because the now-implemented sibling plan reorders keys on **every** write (a raw-string gate would classify everything as significant and silently disable itself). The second risk is that the mechanism the request named (`rename` the current file aside) would open a window in which no config file exists, letting a concurrent reader observe `{}` and persist from it, turning a safety net into a corruption vector; `copyFile` avoids this at negligible cost. Third, the in-repo precedent being copied (`writeDbBackup`) has a pruning bug that sorts by reason before timestamp, which the new naming scheme must not inherit. Fourth — new in this pass — the two sibling subtasks have landed and moved most of this plan's targets, including an 80-line drift on the second writer, and they invalidated this plan's "snapshots before the guard" claim: the hook must stay inside `saveGlobal` and must **not** be hoisted above the guards to restore it, or ring slots get spent on writes that changed nothing. Residual accepted risks: a snapshot may lag the write it protects by one generation (deliberately not locked), and a restore leaves service caches stale, which is surfaced as a reload offer rather than silently ignored.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts` — §1 the snapshot primitive

**Context.** `saveGlobal` (`:175-197`) is the async write funnel for 8 call sites; `_persistMigratedSchedulerIfAbsentSync` (`:389-408`) is a second, synchronous writer that bypasses it. Both need the hook, so the primitive needs both forms.

**Logic.**

Add `private static _snapshotBeforeWrite(reason: string, incoming: GlobalConfig): void` (sync, plus an async sibling if the extra `await` is preferred in `saveGlobal`):

1. Resolve `filePath`. If it does not exist, return — a first-ever write has no predecessor.
2. Read the existing file. If it parses, run the significance gate (§2) against `incoming`; if the write is churn-only, return without snapshotting. **If it does not parse, always snapshot** — an unparseable config is precisely when a byte-for-byte copy is most valuable, and the gate cannot be evaluated anyway.
3. `mkdir` the snapshot directory `{ recursive: true, mode: 0o700 }`.
4. **`fs.copyFileSync(filePath, snapshotPath)`**, then **unconditionally** `fs.chmodSync(snapshotPath, 0o600)`.

> **Superseded:** "then set `mode 0o600` explicitly **if** `copyFile` does not preserve it on the target platform."
> **Reason:** the conditional makes the security guarantee depend on a per-platform `fs.copyFile` behaviour the implementer would have to research, and it is ambiguous in the one case that actually matters — overwriting an *existing* snapshot on a same-millisecond collision, where the destination's prior mode may win. The condition buys nothing: an unconditional `chmod` to the mode the file already has is a no-op syscall on ~3 KB, and there is direct evidence in this very incident that improvised copies leak the bit — `integration-config.json.pre-restore.bak` is `0644` while its source was `0600`.
> **Replaced with:** always `chmod` after copy. No platform assumption, no research dependency, and verification item 12 becomes an unconditional assertion rather than a platform-conditional one. `fs.copyFile`/`copyFileSync` is already the established pattern in this codebase (8 call sites, e.g. `KanbanDatabase.ts:1234`, `ControlPlaneMigrationService.ts:1012`), so this is not a new dependency.
5. Prune to the newest 10 (§4).
6. Wrap the entire body in `try { … } catch (e) { console.error(…) }`. A failed snapshot must never fail or delay the write it was protecting — the same contract `writeDbBackup` uses.

**Copy, not rename** — a deliberate departure from the mechanism as originally proposed ("one `rename` to `integration-config.json.bak` before each save"):

> `rename(filePath, backupPath)` moves the live file aside, leaving **no config file on disk** until `rename(tempPath, filePath)` completes. Inside that window `loadGlobal()` / `loadGlobalSync()` hit their `!fs.existsSync(filePath)` branch (`:144`, `:157`) and return `{}` — not an error, a plausible-looking empty config. A concurrent reader in another window then reads `{}`, and any writer building on that read persists an empty blob over the real one. That is a *new* instance of the exact bug this plan exists to protect against, introduced by the protection itself. `copyFile` keeps the original in place for the whole operation and leaves the tmp-then-rename atomicity untouched. The cost is one extra ~3 KB read-plus-write per significant write, which after §2's gating is a handful of operations per week.

**Implementation.** Call it as the first statement inside `saveGlobal`'s existing `try`, and as the first statement of `_persistMigratedSchedulerIfAbsentSync`'s existing `try`. Reasons: `'save'` for the general path, `'scheduler-migration'` for the sync writer. Prefer refactoring the duplicated tmp-write-and-rename in `_persistMigratedSchedulerIfAbsentSync` into a shared private helper that includes the snapshot, so a third writer cannot be added later without inheriting it.

**Edge cases.** `copyFileSync` onto an existing target overwrites it, which is the desired behaviour for a same-millisecond collision. If the config file is a symlink, `copyFile` follows it and snapshots the *content*, which is correct. Never snapshot the `.tmp` file.

### §2 The significance gate — what makes the ring useful

**Context.** Without this, retention is measured in minutes (see Complexity Audit). This is the load-bearing part of the plan, not an optimisation.

**Logic.** A write is **churn** if the stored and incoming configs are identical after projecting away fields that change on a timer rather than by user intent:

- any provider's `lastSync` (`clickup.lastSync`, `linear.lastSync`, and the same key on `notion` if present)
- `mcpMonitor.sourceLastCheckAt`
- `scheduler.jobs[].sourceConfig.sourceLastCheckAt`

Compare with a **canonical** serialisation — recursively key-sorted `JSON.stringify` — not the raw string. Key insertion order is not stable across a load-modify-save cycle (and §1b of the write-guards plan introduces an object spread that can reorder keys outright), so a raw string comparison would report every write as significant and silently disable the gate.

**Implementation.** Deep-clone both sides via `structuredClone`, `delete` the churn paths, canonical-stringify, compare. Keep the churn key list as a single exported constant so it is greppable and so a future timer-driven field is added in one place.

*Clarification (2026-07-31):* `structuredClone` is available unconditionally — `package.json` declares `"node": ">=22.0.0"` with `@types/node: 22.x`, and the global has existed since Node 17. The originally-offered `JSON.parse(JSON.stringify(…))` fallback is therefore unnecessary and is dropped; there is no version question to resolve at implementation time. (It is also not currently used anywhere in `src/`, so this is its first use — no existing convention to match.)

**Edge cases.** An unparseable stored file bypasses the gate entirely (§1 step 2). A write that *only* clears a churn field — e.g. `lastSync` going from a timestamp to `null` on a config reset — is treated as churn and not snapshotted; acceptable, because a reset that matters will change something else too. If the churn list ever grows to cover a field a user can edit directly, that field must come off the list; note this in the constant's comment.

### §3 `src/extension.ts` + `package.json` — the restore command

**Context.** A snapshot store with no restore path is a strictly worse version of what the user is already doing by hand. "Ten-second recovery" requires that the right snapshot be identifiable *from the picker*, without opening files.

**Logic.**

- Register `switchboard.restoreIntegrationConfig` alongside the existing registrations, and add it to `contributes.commands` (currently **25** entries, verified) with the title **"Switchboard: Restore Integration Config from Backup"**. It must be palette-visible — the registered-but-uncontributed commands are internal, and an emergency recovery command that cannot be found is not a recovery command.

> **Superseded:** "alongside the existing **53** `vscode.commands.registerCommand('switchboard.…')` registrations … the other **28** registered-but-uncontributed commands are internal".
> **Reason:** both figures conflate two different measurements. `src/extension.ts` contains **53** `registerCommand(` calls in total, but only **46** of them use the `switchboard.` prefix (46 repo-wide, all in `extension.ts`, 46 unique ids). The "28" was then derived as 53 − 25, mixing the all-commands total against the switchboard-only `contributes` count.
> **Replaced with:** **46** `switchboard.`-prefixed registrations and **25** `contributes.commands` entries, so **21** switchboard commands are registered but not palette-contributed. The design point is unchanged and unaffected — this command must be the 26th `contributes` entry, not the 22nd invisible one.
- List snapshots newest-first. For each, build a QuickPick item whose `label` is a human-readable local timestamp, whose `description` is the reason, and whose `detail` is a **summary parsed from the snapshot itself**: which providers have a non-empty id, whether `setupComplete` is true, and whether `selectedListId` is populated. That last field is the concrete lesson of 2026-07-30 — the user's problem was not "which backup is newest" but "which backup still has my list id", and the picker should answer it at a glance.
- On selection: snapshot the current file with reason `'pre-restore'` (the reason string used by the 2026-06-24 agent-generated artifact, kept for continuity of vocabulary), then write the chosen snapshot over `integration-config.json` via the same tmp-then-rename path so the restore is itself atomic.
- **Whole-file restore is the default. Field-level restore is an expert option, and it must be dated.**

> **Superseded:** "Offer field-level restore, not only whole-file. … A second QuickPick step — *Restore whole file* / *Restore only fields that are empty here and set there* — turns the real recovery shape into one action instead of a hand-written script. The second option is the safer default and should be listed first."
> **Reason:** that option was written from a restore performed on 2026-07-31 which was then **reverted as wrong** — and the "copy fields that are empty here and set there" rule is exactly what made it wrong. The rule silently assumes that *blank-here* means *lost*, and that the snapshot's value is therefore the value to bring back. Neither holds. The six `selected*` fields were copied from a snapshot a **month** older than the corruption, carrying `Sprint 116 (21/5 - 3/6)` — a sprint that had already ended eight weeks earlier. Nothing established the fields were populated immediately before the bad write, and the ClickUp tickets directory had been inactive since 2026-07-02, so no newer selection existed to recover either. Presenting that rule as "the safer default, listed first" would ship the mistake as the recommended path.
> **Replaced with:** the ordering and the guardrails below.

- **Restore whole file** is the primary and first-listed action. It is the only option whose result is a state that genuinely existed as a coherent whole.
- **Restore selected fields** is offered second and explicitly labelled as advanced. It carries three guardrails, all of which the 2026-07-31 write violated:
  1. **Show the snapshot's age against every field it would write**, in the confirmation surface — "this value is from 2026-06-30, 31 days before the corruption you are recovering from." An undated value is not evidence.
  2. **Never treat blank-here-and-set-there as sufficient reason to copy.** A field can be blank because a user cleared it, because it was already blank before the incident, or because it was never set. The picker must present the field diff and let the user choose per-field; it must not pre-select on emptiness.
  3. **Refuse to field-restore from a snapshot older than the corruption window** where one is known, or warn prominently where it is not. The whole failure mode is reaching past the damage into an unrelated earlier state.
- **A blank field is a self-announcing state; a stale field is a silently wrong one.** This is the asymmetry the design must encode. Blank `selected*` leaves the Tickets dropdowns empty, so the user re-selects and gets a *current* list in two clicks. A stale `selectedListId` looks configured and quietly points ticket fetches at a finished sprint. **When in doubt, leave the field blank** — reverting to blank is the recovery, not a failure to recover.
- **No confirmation dialog.** The QuickPick selection is the deliberate act. Do not add one; see Side Effects.
- Finish with `showInformationMessage('Integration config restored.', 'Reload Window')` → `workbench.action.reloadWindow` when chosen. This is a post-action offer, not a gate, and it is the honest answer to the stale-cache problem: service `_config` fields and panel caches survive a file-level restore.
- Empty store → `showInformationMessage` naming the directory path, so the user learns where snapshots will appear.

**Edge cases.** A snapshot that fails to parse must still be *offered* (labelled `unreadable — raw restore`) rather than hidden; a corrupt-but-present snapshot may still be the best available copy, and hiding it would be the picker deciding for the user. The command must ignore any argument passed to it — no caller-supplied path (see Security).

### §4 Naming and retention

**Context.** Must sort chronologically, must not be confused with migration archives, must not collide with the three existing hand-made files.

**Logic.**

- Directory: `~/.switchboard/configbackup/` — a sibling of the existing `cache/`, and deliberately not the flat `~/.switchboard` root where the hand-made `.bak*` files live.
- Filename: `integration-config.<ISO-timestamp-with-colons-and-dots-replaced-by-dashes>.<reason>.<4-hex>.json`
- **Timestamp before reason** — the deliberate fix to the `writeDbBackup` flaw. With the timestamp leading, a plain lexicographic `.sort()` is chronological regardless of reason, so "keep the newest N" is correct by construction rather than dependent on the alphabetical ordering of reason strings.
- `.json` extension so the files are trivially readable and diffable by hand, which is how every recovery to date has actually been performed.
- Retention: **10**. The precedent keeps 5; 10 is chosen because significance-gating makes each slot a genuinely distinct configuration state rather than a timer tick, so 10 spans weeks, and 10 × ~3 KB is a 30 KB ceiling.
- Prune with per-file `.catch(() => {})`, matching `writeDbBackup`.

**Edge cases.** Sanitise `reason` to `[^a-zA-Z0-9_-] → _`, as `writeDbBackup` does, so a reason string can never inject a path separator. Files in the directory that do not match the expected prefix must be ignored by both the pruner and the picker, so a stray user file is never deleted.

## Verification Plan

### Build first

1. `npm run compile-tests` — tests load compiled `out/` via `loadOutModule()`, so nothing below is meaningful until this runs.

### Automated Tests — new `src/test/integration-config-backup.test.js`

Require `src/test/integrations/shared/test-harness.js` so the file inherits state-home sandboxing; **this test must never write to the real `~/.switchboard`**, which is the entire subject of the sibling plan.

2. **A significant write snapshots.** Seed a populated config; `saveConfig` a materially different blob; assert exactly one file appears in `configbackup/` and that its contents are byte-identical to the *pre-write* config.
3. **A churn-only write does not snapshot — the load-bearing assertion.** Seed a populated config; write a blob differing **only** in `clickup.lastSync`; assert the snapshot count is **unchanged**. Then repeat for `mcpMonitor.sourceLastCheckAt` and `scheduler.jobs[].sourceConfig.sourceLastCheckAt`. Then the composite case: 100 consecutive churn-only writes followed by one significant write, and assert the store holds exactly **one** snapshot and it is the pre-corruption state. This is the test that proves the ring survives eight hours of polling; without it the plan's central claim is unverified.
4. **Key reordering is not mistaken for significance.** Write a blob with identical content but different key insertion order; assert no snapshot. Guards the canonical-stringify requirement — a raw string comparison passes tests 2 and 3 but fails this one.
5. **The 2026-07-30 corruption, replayed and recovered — a round-trip test of the mechanism, not a recommendation to restore these values.** Seed the *good* state (a 22-key `clickup` blob with `workspaceId: '6909707'` and `selectedListId: '901613739289'`), then apply the real corrupted blob — available verbatim on this machine at `~/.switchboard/integration-config.json.bak.before-wsid-repair` (`workspaceId: 'ws-123'`, `selectedListId: ''`, 22 keys). **Copy both into the repo as committed fixtures; never read `~/.switchboard` at test time** (the state home is sandboxed, so the live path is unreachable from the suite by design — that is subtask 1's whole point). Assert a snapshot was taken, then run the whole-file restore against it and assert **both** `workspaceId === '6909707'` and `selectedListId === '901613739289'` are back — i.e. the restore reproduces the seeded snapshot **exactly**, field for field, with no field-level filtering.

> **Superseded:** "Recovering the second field is the thing the manual repair failed to do."
> **Reason:** that sentence recommends, as a success criterion, the specific action item 20 records as **attempted and reverted for being wrong**, and that §3's guardrails were rewritten to prevent. It reads as "a good restore brings `901613739289` back", when the plan's own conclusion is that `901613739289` is a dead sprint and blank is the correct live state. Left in, it invites a future pass to "finish the job" — the exact outcome item 20 exists to forbid.
> **Replaced with:** the assertion is a **fidelity** check on the restore primitive — whatever bytes are in the chosen snapshot come back whole — and `selectedListId` is the second field only because a one-field test cannot distinguish a whole-file restore from a single-key patch. It carries **no** claim that this value should be restored on the author's machine. The judgment about *which* snapshot deserves restoring is item 20's, is settled, and is not retested here.

   - **5b:** assert the negative that gives 5 its teeth: the restore must **not** be field-filtered. Seed a snapshot in which one field is populated and the live file has a *different* non-empty value for it; restore whole-file; assert the snapshot's value wins. A restore that silently preserved live values for populated fields would pass item 5 (whose live fields are empty) while being a field-merge masquerading as a whole-file restore.
6. **Atomicity is preserved — the `copyFile` decision, asserted.** Instrument the write so a read can be interleaved between snapshot and rename; assert `loadGlobalSync()` observes the **old complete config**, never `{}`. Then mutate the implementation to `rename` instead of `copyFile` and assert this test **fails** — that mutation is the whole reason for the departure from the originally proposed mechanism, and an unasserted rationale is a comment, not a design.
7. **Retention and ordering.** Perform 15 significant writes; assert exactly 10 files remain and they are the 10 newest. Then create snapshots whose reasons sort adversarially against their timestamps (e.g. reason `aaa` newest, reason `zzz` oldest) and assert the pruner keeps the newest by **time** — the regression test for the `writeDbBackup` flaw.
8. **Both writers are covered.** Assert `saveGlobal` snapshots, and separately that `_persistMigratedSchedulerIfAbsentSync` snapshots with reason `scheduler-migration`. Drive the latter by seeding a config with `mcpMonitor` present and `scheduler` absent, then calling `getSchedulerConfigSync()`.
9. **Unparseable stored file is always snapshotted.** Write `{not json` to the config path; perform any write; assert a snapshot exists containing those exact bytes.
10. **First-ever write does not snapshot and does not throw.** No config file present; `saveConfig`; assert no `configbackup/` directory is required to exist and no error is raised.
11. **A snapshot failure never breaks the write.** Make the snapshot directory unwritable (or stub `copyFileSync` to throw); assert `saveGlobal` still completes, the config file is correct, and an error was logged.
12. **File modes.** Assert snapshots are `0600` and the directory is `0700`. Skip on Windows.
13. **Restore is self-protecting.** Run a restore; assert a `pre-restore` snapshot of the pre-restore state was created first, so a wrong restore is itself reversible.
14. **Mutation checks** — restore after each: remove the significance gate → item 3 fails; use raw `JSON.stringify` instead of canonical → item 4 fails; swap `copyFile` for `rename` → item 6 fails; put reason before timestamp in the filename → item 7's adversarial-ordering case fails; hook only `saveGlobal` → item 8's second half fails.

### Automated — regression surface

15. `npm run test:integration:clickup`, `test:integration:linear`, `test:integration:notion`, and the full `test:contract:*` set. Every existing test that round-trips config now also exercises the snapshot path; none should change behaviour, and none should leave files outside the sandboxed state home.
16. `npm run lint` — 0 errors. Note the repo trap: `eslint.config.js` scopes every rule block to `files: ['**/*.ts']`, so the new `.js` test is unlinted by design and carries its weight through items 2-14.

### Manual

17. **The ten-second recovery, observed.** Hand-edit `~/.switchboard/integration-config.json` to break `workspaceId`, run **Switchboard: Restore Integration Config from Backup**, pick the most recent snapshot whose detail line shows a populated list id, reload the window, open the Tickets tab, and confirm the space/folder/list dropdowns populate. Time the whole operation — if it is not roughly ten seconds, the picker's `detail` line is not carrying enough information and should be improved before this ships.
18. **Retention spans a realistic window.** Enable the comms monitor (`pollingEnabled: true`) so the 5-minute churn writer is live, leave it running for an hour, then confirm the snapshot store still holds pre-existing significant states and has **not** rotated. This is the real-world version of item 3 and the only check that exercises the actual timer.
19. **Confirm the four pre-existing loose snapshots are untouched** after all of the above — `integration-config.json.pre-restore.bak`, `.bak.20260630140139`, `.bak.before-wsid-repair`, and `integration-config.2026-07-30T19-56-02-577Z.pre-selected-restore.json` must still exist, unmodified, in `~/.switchboard/`. They are the forensic record of three incidents plus one recovery, no shipped code reads them, and the pruner's prefix filter (§4) is what must keep them safe.
20. ~~**Recover the outstanding data loss.**~~ **ATTEMPTED AND REVERTED, 2026-07-31. Do not retry it.**

    Six `clickup.selected*` fields were copied from `integration-config.json.bak.20260630140139` into the live config (space `6922744`/TECH TEAM, folder `96726007`/Sprint Folder, list `901613739289`/`Sprint 116 (21/5 - 3/6)`), then reverted from the safety copy taken beforehand. `workspaceId` was never touched and remains `6909707`; key count stayed 22/22 throughout; the live `selected*` fields are blank, which is the correct state.

    **Why it was wrong** — this is the requirement, so do not let a future pass "finish the job":
    - The snapshot predates the corruption by a **month**. Two data points a month apart (populated 06-30, blank 07-31) do not establish what the value was immediately before the bad write.
    - The value was already dead: `Sprint 116 (21/5 - 3/6)` ended eight weeks earlier. Even if it *was* the lost value, it is not a wanted one.
    - No newer selection exists to recover: the ClickUp tickets directory last changed 2026-07-02.
    - A stale `selectedListId` is **worse than blank** — blank leaves the dropdowns empty so the user re-selects a current list; stale looks configured and silently fetches a finished sprint.

    **Correct recovery:** leave the fields blank and re-select space/folder/list in the Tickets tab, which yields a current list. With `workspaceId` correct, that also exercises `getSpaces()` and doubles as the end-to-end check for the sibling heal plan.

    **Two findings worth keeping:** (i) `columnMappings` was `{}` in the 2026-06-30 snapshot too, so it was **not** fixture collateral damage as the sibling write-guards plan states — it was already empty, which in turn undercuts the unevidenced claim that the `selected*` fields were blanked by that write at all. (ii) `completeSyncEnabled` is `false` in the snapshot and `true` live; live is correct (post-migration default) — a whole-file restore from that snapshot would have regressed it, which is why §3's whole-file path must also surface per-field age rather than assuming an older file is a better file.

## Recommendation

Complexity 5 → **Send to Coder.**
