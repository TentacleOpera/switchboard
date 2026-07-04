# Foundation: epic/project/column state-ownership & reconciliation model

## Goal

Define the single coherent model that governs how plan/epic **file frontmatter** and
**kanban.db** stay in agreement across every mutation path (create/link/unlink/edit/delete/
reassign/move), so that making files able to *write* state does not create silent divergence
or resurrect deleted state. This is the **foundation subtask** — the `**Epic:**` carrier,
project hardening, delete-resurrect fix, `**Column:**` transition, and manifest work all
implement rules defined here and must not be built before it.

### Core problem & root cause

The DB is currently the sole writer of most state; files only *seed* it on first import. The
user chose **model C** (full bidirectional sync) for epic membership: files can write state and
the UI can write state, for the same facts. That creates a **two-master problem**. Two failure
classes recur throughout the codebase and must be designed out, not patched per-symptom:

1. **Resurrection of deleted/changed state.** A git-tracked file re-presents a value the DB
   already deleted or changed. Confirmed in two independent places: the un-reaped
   `manifest.json` (PR #31 entry), and `deleteEpic` → `tombstonePlan` leaving the epic `.md` on
   disk so the watcher re-imports it as a fresh active epic (`purgeOrphanedPlans` only tombstones
   plans whose *file is missing*).
2. **Set-vs-unset ambiguity.** Frontmatter expresses "set X" but not "unlink X." Absence of a
   key is ambiguous (never-set / human-cleared-in-UI / agent-forgot). The manifest already
   carries a scar: its guard that `isEpic:false` with no `epicId` must never clobber a link
   (`PlanManifestService.ts:326-339`).

### Root cause

Without an ancestry/ordering signal you cannot distinguish *a new edit* from *a stale copy* —
that is precisely why the resurrect bugs exist. The fix is a **reconciliation ledger + 3-way
merge with a stored common-ancestor value per (plan, field)**, reused by every file→DB path.

## Ownership matrix (the model)

| Field | Owner | Direction(s) | Notes |
|---|---|---|---|
| `is_epic` | **Folder** (`.switchboard/epics/`) | file→DB, sticky-on | Unchanged. Create-epic = write file into epics/. Clear only via `updateEpicStatus(…,0,…)`. |
| `project` (name) | **File-authoritative** | file→DB (existing) + DB→file writeback (new) | Must **auto-create the `projects` row on import** so `project_id` resolves (board JOINs on id). Clear is explicit, never by omission. |
| `epic_id` (membership) | **Bidirectional (C)** | file↔DB w/ reconciliation | The core of this epic. Set/change via `**Epic:** <id>`; unlink only via explicit sentinel; UI changes write back to the file. |
| `kanban_column` | **DB-owned** | file→DB *intent* only (compare-and-swap) | `**Column:**` is a guarded forward-transition intent; never a mirror. Do NOT make it file-authoritative — it fights tombstone-restore + epic cascade. |

## The reconciliation mechanism (careful C)

**Store a per-plan common-ancestor ("base") for each reconciled field** — e.g. `base_epic_id`,
`base_project` columns on `plans` (or a `sync_base` table). The base is the last value file and
DB agreed on. Then, on any change to `epic_id`/`project`:

- **DB→file (local UI/CLI mutation) — the easy, authoritative direction.** The extension is
  online and authoritative. On link/unlink/reassign it (a) updates the DB, (b) **writes the
  frontmatter line into the file** via a targeted, position-stable edit (template:
  `planMetadataUtils.applyManualComplexityOverride`), (c) sets `base := new value`, (d) suppresses
  the self-triggered watcher event (see loop prevention). This is what makes files stop lying for
  local operations and covers the majority of mutations safely.

- **file→DB (remote edit) — the guarded direction.** Apply only under ALL of:
  - **positive-payload only** — an omitted key never clears a link (borrow the manifest
    isEpic:false guard);
  - **compare-and-swap** — apply the file's value only if `DB == base` (DB unchanged since last
    agreement); if `DB != base` and `file != base` and `file != DB`, it's a genuine conflict;
  - **consumed-fingerprint ledger** — record a fingerprint of each applied file-state; a
    resurrected identical file matches the ledger and is a **no-op** (this is the generalization
    of `manifest-redelivery-idempotency-and-reaping.md` — the ledger underpins *all* file→DB
    application, manifest and frontmatter alike, and is what actually defeats resurrection).
  On apply, set `base := file value` and record the fingerprint.

- **Conflict** (compare-and-swap fails and it is not a known-consumed fingerprint) → surface the
  **3-way resolution dialog** (file value vs DB value vs base). Multi-choice conflict dialogs are
  explicitly permitted by CLAUDE.md (unlike plain confirm gates). Never silently pick a winner.

- **Unlink** is explicit: local unlink writes the removal back to the file (writeback); remote
  unlink requires a sentinel (`**Epic:** none`), never bare omission.

## Loop prevention (mandatory)

DB→file writeback edits a file the watcher watches → could re-fire → re-apply → re-write → loop.
Prevent with the existing machinery: register the path in the **pending-write set**
(`registerPendingCreation` precedent) before writing; **bump `updated_at` to ≥ the post-write
file mtime** so the watcher's `mtime ≤ updatedAt` short-circuit (`GlobalPlanWatcherService.ts:481`)
skips it; and keep the **byte-identical no-op guard** (`:9875`) so a writeback that changes
nothing never touches disk.

## Rollout / seeding (careful — no mass rewrite)

Existing subtasks have DB `epic_id` links but no `**Epic:**` line and no base. Do NOT mass-rewrite
hundreds of files (huge diff, migration risk on ~4,000 installs). Instead **seed lazily**: stamp
`**Epic:**` + initialize `base` the next time each file is legitimately touched (regenerated,
moved, re-linked), and treat "no base yet" as first-import semantics (positive-payload set, no
clobber). Optionally offer a one-time explicit backfill command the user can run deliberately.

## Git control-plane integration (mandatory constraints)

The remote-control subsystem is DB-centric with two git-inbound channels (`manifest.json` →
`PlanManifestService`, quiet; `**Column:**` lines in the exported mirror → `GitStateProvider`,
with agent dispatch), one API channel (`RemoteControlService` polling Notion/Linear/ClickUp), and
a DB→file mirror export (`exportStateToFile` on every `_persist`, default `boardStateExport:
'none'`). Model C must fit this, not fight it:

1. **Writeback MUST commit its own plan-file edits — HARD REQUIREMENT.** `PlanAutoFetchService`
   ff-merges only when the working tree is clean *ignoring mirror files* (`MIRROR_FILE_RE`,
   `PlanAutoFetchService.ts:227/327`). DB→file writeback edits **plan/epic files** (not mirror
   files), so an uncommitted writeback leaves the tree dirty and **blocks inbound auto-pull
   entirely**. The existing `pushExportedState` auto-commit stages only `kanban-board.md`/
   `kanban-state-*.md`, never plan files. So writeback must commit its edits itself (a dedicated
   `switchboard: sync plan metadata` commit, reconciled fetch+ff like `GitStateProvider.pushExportedState`),
   respecting the control-plane-root resolution and default-branch-only semantics.
2. **Subsumes manifest for epic_id/project; leaves column to the manifest.** Model C's carriers
   replace the manifest's `epicId`/`project` fields (with the ledger providing the idempotency the
   manifest lacked), and work even when `boardStateExport: 'none'` because `GlobalPlanWatcher`
   always scans plan files. Column is NOT subsumed: the manifest is the *only* git-inbound channel
   on a stock install, so column retirement is deferred (see the column subtask).
3. **Echo-safe by construction — do not break it.** `GitStateProvider` only diffs `**Column:**`,
   never `**Epic:**`/`**Project:**`, so epic/project writeback is never re-ingested as a phantom
   remote move. This holds *only* while column has no writeback — never add a `**Column:**`
   writeback to plan files.
4. **API providers as DB-side writers.** Notion/Linear/ClickUp changes apply to the DB via the
   same path as a manual drag; they mostly move columns/comments (not epic/project), so
   epic/project reconciliation is effectively two-master. Guard: any API path that ever sets
   `project`/`epic_id` must route through the writeback-triggering mutator, or it becomes a hidden
   third writer the base/CAS model can't see.
5. **Per-branch / control-plane-root aware.** Writeback and reconciliation must use the resolved
   control-plane root (`resolveEffectiveWorkspaceRoot`) and honor default-branch-only pull
   semantics, matching `exportStateToFile._resolveExportRoot` and `PlanAutoFetchService`.

## User Review Required

- Confirm base storage: columns on `plans` (`base_epic_id`, `base_project`) vs a `sync_base` table.
- Confirm the unlink sentinel spelling (`**Epic:** none`).
- Confirm lazy-seeding (no mass rewrite) over an eager one-time backfill.
- Confirm conflicts surface the 3-way dialog rather than a documented default winner.

## Complexity Audit

### Routine
- Adding base columns + idempotent migration (additive; no backfill — "no base" = first-import).
- Reusing `applyManualComplexityOverride` for position-stable frontmatter writes.

### Complex / Risky
- **The whole feature is the reconciliation correctness.** Get compare-and-swap + the ledger
  right or resurrection returns. The ledger is load-bearing; design it first (it is the
  generalized `manifest-redelivery` fix).
- **Loop prevention** must be airtight across all three watcher ingest paths (FileSystemWatcher,
  fs.watch, periodic scan) — a missed suppression is an infinite writeback loop.
- **Ancestry gap:** compare-and-swap alone cannot distinguish a *new* remote edit from a *stale
  older* copy; the consumed-fingerprint ledger is what covers that. Do not ship CAS without it.

## Edge-Case & Dependency Audit

- **Depends on:** nothing (foundation). **Depended on by:** `epic-membership-carrier-bidirectional-sync.md`,
  `project-carrier-hardening.md`, `delete-epic-file-resurrect-fix.md`,
  `column-transition-frontmatter-retire-manifest.md`, `manifest-redelivery-idempotency-and-reaping.md`
  (which becomes the ledger implementation).
- **Cascade interaction:** epic column moves cascade to subtasks in one transaction
  (`cascadeEpicByPlanId`); reconciliation must not race the cascade — column stays DB-owned
  precisely to avoid this.
- **project_id divergence:** the file carries the name; the board needs the id — auto-create the
  row on import or the card silently drops off its board (V35/V38 backfill migrations exist for
  exactly this).
- **Migration safety:** all additive; manifests + existing links keep working. Per CLAUDE.md,
  assume shipped, migrate, never drop legacy state.
