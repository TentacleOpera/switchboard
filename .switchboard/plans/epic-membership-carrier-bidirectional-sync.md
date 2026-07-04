# `**Epic:**` membership carrier + bidirectional sync (model C)

## Goal

Make epic membership (`plans.epic_id`) reconcile bidirectionally between a subtask's
`**Epic:** <epic-plan-id>` frontmatter line and the DB, per the model in
`state-ownership-and-reconciliation-model.md`. Remote agents can link/re-group subtasks by
editing the file; local UI link/unlink writes back into the file so it never lies.

### Core problem & root cause

`epic_id` is DB-only today — no file carries it, `parsePlanMetadata` doesn't parse it, and no
path writes it to subtask files (`_regenerateEpicFile` writes only the *epic's* SUBTASKS block).
So remote agents cannot link/re-group subtasks without the manifest, and improve-epic's core job
(merge/split/re-group) is unreachable remotely except via the buggy manifest. Model C closes
this — but epic membership is exactly where set-vs-unset ambiguity and resurrection bite, so it
must implement the foundation's guards, not a naive mirror.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, watcher, epics, frontmatter, reconciliation
- **Complexity:** 8

## Implementation

1. **Parse.** Add `epicRef?: string` to `PlanMetadata` (`planMetadataUtils.ts:47-54`) via
   `extractEmbeddedMetadata(content, 'Epic')` (`:27`). Recognize the unlink sentinel
   (`**Epic:** none`) distinctly from an absent key (absent = no-op; sentinel = explicit unlink).

2. **file→DB (guarded).** In `_handlePlanFile`'s existing-plan branch
   (`GlobalPlanWatcherService.ts:617-696`), after `parsePlanMetadata`:
   - Resolve `epicRef` → an epic `plan_id` (it may be given directly as the id, or resolved via
     `getPlanByPlanId`); **defer** if the epic row isn't imported yet (mirror
     `PlanManifestService.ts:314-325`).
   - Apply via `updateEpicStatus(subtaskPlanId, 0, resolvedEpicId)` **only** under the foundation
     guards: positive-payload (absent key never clears), compare-and-swap (`DB.epic_id ==
     base_epic_id`), and consumed-fingerprint (skip if this file-state was already applied).
   - Sentinel `none`: apply `updateEpicStatus(subtaskPlanId, 0, '')` under the same CAS guard.
   - On apply, set `base_epic_id := resolvedEpicId` and record the fingerprint. On CAS failure
     that isn't a known fingerprint → raise a reconciliation conflict (dialog).

3. **DB→file writeback.** Add an `**Epic:**` writer (targeted, position-stable — template
   `applyManualComplexityOverride`, `planMetadataUtils.ts:123-157`) and call it from every
   membership mutator so the subtask file tracks the DB:
   - `addSubtaskToEpic` (`KanbanProvider.ts:8837`), `assignPlansToEpic` (`:10152`),
     `createEpicFromPlanIds` subtask-link loop (`:10074`) → write `**Epic:** <epicId>`.
   - `removeSubtaskFromEpic` (`:8952`), `clearEpicIdForEpic` (`KanbanDatabase.ts:1679`) → write
     the sentinel / remove the line.
   - Each writeback: register the path in the pending-write set, write, set `base_epic_id := new`,
     bump `updated_at ≥ file mtime` (loop prevention per the foundation). Reuse the byte-identical
     no-op guard.

4. **Ledger reuse.** The consumed-fingerprint store is the one built in
   `manifest-redelivery-idempotency-and-reaping.md` (generalized). This subtask consumes it; it
   must land after (or with) the ledger.

## User Review Required

- Confirm `**Epic:**` carries the epic's `plan_id` (stable, filename-derived) rather than a
  human-facing epic name.
- Confirm writeback fires from all four membership mutators listed (so no path leaves the file
  stale).
- Confirm defer-and-retry when the epic row isn't imported yet (vs reject).

## Complexity Audit

### Routine
- Adding a parsed field and a position-stable frontmatter writer (both have templates).

### Complex / Risky
- **Two-master reconciliation** is the crux — CAS + ledger + base, exactly as the foundation
  specifies. A naive "file wins" or "DB wins" reintroduces resurrection or loses UI changes.
- **Writeback loop** across three watcher ingest paths — one missed pending-suppress = infinite
  loop. Test each ingest path.
- **Cascade coupling:** `updateEpicStatus` triggers `recomputeEpicComplexity` and membership
  affects epic column-cascade; writeback must not fire mid-cascade transaction.
- **Locked-column guards** (`epic_lock_columns`) already reject some links (`:8823-8835`) — the
  file path must honor the same guards or files could bypass them.

## Edge-Case & Dependency Audit

- **Depends on:** `state-ownership-and-reconciliation-model.md` (base + rules) and
  `manifest-redelivery-idempotency-and-reaping.md` (the ledger). Hard ordering.
- **Re-group:** subtask moved epic A→B remotely: `**Epic:** B`, base=A, DB=A → CAS ok → relink to
  B, base:=B, writeback confirms B. If a human simultaneously moved it to C in the UI (DB=C≠base
  A) → conflict dialog.
- **Already-on-another-epic** rejection (`:8827`) must apply on the file path too.
- **Epic delete interaction:** handled with `delete-epic-file-resurrect-fix.md` — clearing links
  on delete must also writeback/sentinel the subtask files, or they resurrect the dead epic.
- **`is_epic` unaffected:** this only touches the subtask link; epic-ness stays folder-derived.
