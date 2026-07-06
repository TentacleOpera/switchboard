# Plan-authoring frontmatter facts (feature + project on import)

**Plan ID:** 1f6e6092-ff12-4df5-9c9a-5e70869f7c97

## Goal

Let a remote-authored plan file declare two **durable facts** in its frontmatter — its feature and
its project — so that committing plan `.md` files (the legitimate git use) can express structure
without the retired `manifest.json`. This is the *lightweight* survivor of the abandoned model-C
work: durable authored facts applied on import, **not** a bidirectional control channel.

### Core problem & root cause

With the manifest retired as a control channel (`retire-file-based-git-control-plane.md`), remote
plan authoring still needs to set two things the plain body can't: which feature a subtask belongs
to, and which project it's in. These are **durable facts** (they describe the plan and are meant
to stay true), unlike a column move (a one-shot action / live state that belongs to a provider or
the DB). Durable facts are safe in per-plan frontmatter: different plans are different files (no
shared-mutable-file concurrency problem), and two branches editing the *same* plan's feature
conflict — which is correct.

`**Project:**` already works this way (`planMetadataUtils.ts:95-102`, parsed into `PlanMetadata.project`,
honored on import — first-import for active-project auto-assign, explicit-override on existing saves
at `GlobalPlanWatcherService.ts:527-539` / `:627-639`). The watcher/import path also **already
auto-creates** the `projects` row for unknown names via `_resolveOrCreateProjectId`
(`KanbanDatabase.ts:1389-1403`, called by `_resolveProjectForInsert` at `:1426-1449`) — so the
"project_id stays NULL" hazard is already closed on the import path. `**Feature:**` does not exist
yet: there is no parser, no `PlanMetadata.feature` field, and no defer/link logic in the watcher.

## Metadata

- **Project:** Switchboard
- **Tags:** feature, backend
- **Complexity:** 5

## Implementation

1. **`**Feature:** <feature-plan-id>` carrier.** Parse via `extractEmbeddedMetadata(content, 'Feature')`
   into `PlanMetadata`. On import (`GlobalPlanWatcher._handlePlanFile`), resolve to the feature row
   (feature `plan_id` is the feature filename's UUID) and link via `updateFeatureStatus(subtaskPlanId, 0,
   featureId)`; **defer** if the feature isn't imported yet. Apply with **apply-if-empty / first-import**
   semantics (positive-payload guard, borrowed from `PlanManifestService.ts:326-339`): an omitted
   key never clears a link, and the file does not overwrite an feature link the DB already has — so a
   human's later UI regroup is not clobbered on re-import. **No writeback, no reconciliation
   ledger** — this is authored metadata, not a synced control field.
2. **`**Project:**` hardening (mostly verification — auto-create already exists).** The
   watcher/import path **already** auto-creates the `projects` row for unknown names via
   `_resolveOrCreateProjectId` (`KanbanDatabase.ts:1389-1403`, `INSERT OR IGNORE`) called from
   `_resolveProjectForInsert` (`:1426-1449`). So this step is **verification + normalization**, not
   new auto-create logic: confirm `_resolveOrCreateProjectId` trims/normalizes the name (it does not
   today — add `.trim()` on the name before lookup/insert), and add a debug log when a project row is
   created from a file-named project (currently silent). Do NOT touch the manifest-path
   `resolveProjectId` (`:2031-2045`, lookup-only) — that path is being retired with the manifest.
3. **Explicit change, not omission.** Because this is first-import/apply-if-empty, changing an
   existing plan's feature/project after import is a UI/provider action, not a file re-edit. (Full
   file-driven re-grouping was the model-C path we dropped as over-engineered.)

## User Review Required

- Confirm `**Feature:**` carries the feature `plan_id` (stable, filename-derived).
- Confirm apply-if-empty / first-import semantics (vs file-always-wins) — the former avoids
  clobbering UI/provider changes and is the low-risk choice.
- Confirm auto-creating a `projects` row from a file-named project.

## Complexity Audit

### Routine
- Adding a parsed `**Feature:**` field via the proven `extractEmbeddedMetadata` helper.
- Add-project-if-missing before id resolution (reuses `addProject`).

### Complex / Risky
- **Set-vs-unset:** absence of `**Feature:**` must never unlink; only apply positive payloads. This
  is the one guard that matters (the manifest already scarred on it).
- **Defer/ordering:** subtask imported before its feature → defer and retry (mirror the manifest's
  `getPlanByPlanId` defer).

## Edge-Case & Dependency Audit

- **Depends on:** `retire-file-based-git-control-plane.md` (this is where the manifest's
  feature/project role lands). Independent of the Issues provider and the activity light.
- **Scope guard:** this deliberately does NOT do column (provider/DB-owned), status, writeback, or
  reconciliation — those were the model-C complexity we cut once control moved to API providers.
- **Concurrency:** per-plan files; different plans never collide; same-plan concurrent edits
  conflict correctly. No shared mutable file.
- **Migration:** additive; existing `**Project:**` behavior unchanged except unknown names now
  auto-create the row (an improvement, matching V35/V38 intent).

## Dependencies

- `retire-file-based-git-control-plane.md` — this plan is where the retired manifest's
  feature/project role lands. The manifest must be retired (or at least its feature/project
  application path removed) so there is no double-application; this plan takes over via per-plan
  frontmatter. If the manifest is retired first, this plan fills the gap; if they ship together,
  the manifest deletion + frontmatter addition are one atomic swap.
- `delete-epic-file-resurrect-fix.md` — depends on THIS plan's `**Feature:**` carrier existing so it
  has a line to strip on delete. Reverse dependency: this plan must land with/before the delete fix
  for the strip step to be meaningful.

## Adversarial Synthesis

Key risks: (1) Subtask imported before its feature → `**Feature:** <id>` references a feature row
that doesn't exist yet; without defer/retry (which the watcher lacks today, unlike the manifest at
`PlanManifestService.ts:249-262`), the link is silently dropped and never retried. Mitigation: add a
defer queue in `_handlePlanFile` keyed on the unresolved feature id, retried on the next watcher
cycle or when a feature file is imported. (2) The positive-payload guard (apply-if-empty) must be
exact — absence of `**Feature:**` must NEVER unlink, or a human's UI regroup is clobbered on every
re-import (the manifest already scarred on this at `:326-339`). (3) `_resolveOrCreateProjectId` does
not `.trim()` the name today — `" Switchboard "` and `"Switchboard"` create two project rows.
Mitigation: add `.trim()` before lookup/insert. Mitigations converge: borrow the manifest's
positive-payload guard verbatim; add a defer queue mirroring the manifest's defer; trim project names.

## Proposed Changes

### `src/services/planMetadataUtils.ts` — `**Feature:**` parsing

- **Context:** `extractEmbeddedMetadata(content, label)` (`:27-31`) is the proven helper for
  `**Label:** value` parsing. `PlanMetadata` interface (`:47-54`) has `project?: string` but no
  `feature`/`featureId` field.
- **Logic:** Add `feature?: string` to `PlanMetadata`. Parse `**Feature:**` alongside `**Project:**`
  (reuse the same tolerant list-item-prefix regex pattern from `:95-102`, or call
  `extractEmbeddedMetadata(content, 'Feature')` in the `extractPlanMetadata` function). Store the
  raw feature plan-id string (the feature's filename UUID) in `metadata.feature`.
- **Edge Cases:** (a) `**Feature:**` with empty value — treat as absent (don't link to empty id).
  (b) Malformed UUID — log a warning and treat as absent (don't link to a non-existent feature).

### `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (`:445-707`) feature linking

- **Context:** Today the watcher only sets `is_feature=1` for files in `.switchboard/features/`
  (`:582-588`, `:648-660`); it never links a subtask to a feature via `**Feature:**` frontmatter.
  There is no defer/retry for a feature not yet imported (the manifest has this at
  `PlanManifestService.ts:249-262`; the watcher does not).
- **Logic:** After extracting `metadata.feature`, if present and non-empty:
  1. Resolve the feature row via `db.getPlanByPlanId(metadata.feature)`.
  2. If found → link via `db.updateFeatureStatus(subtaskPlanId, 0, featureId)` (the manifest's
     pattern at `:326-339`), but ONLY if the subtask's current `feature_id` is empty (apply-if-empty
     / positive-payload guard — an omitted key never clears, and the file does not overwrite a link
     the DB already has).
  3. If NOT found → add to a defer queue (`_pendingFeatureLinks: Map<featureId, planId[]>`); retry on
     the next watcher cycle or when a feature file import fires (hook into the feature-import branch
     at `:582-588`).
- **Implementation:** The defer queue must be bounded (cap entries, drop after N retries with a
  warning log) so a permanently-unresolved `**Feature:** <badId>` doesn't leak memory.
- **Edge Cases:** (a) Feature deleted while subtask pending in defer queue → on retry, feature row
  is gone; drop the link silently (don't resurrect the feature). (b) Subtask re-saved with
  `**Feature:**` removed → the apply-if-empty guard means the existing DB link is preserved (correct
  — ungrouping is a UI action, not a file edit).

### `src/services/KanbanDatabase.ts` — `_resolveOrCreateProjectId` (`:1389-1403`) name normalization

- **Context:** Auto-create already works (`INSERT OR IGNORE`), but the name is not trimmed before
  lookup/insert → `" Switchboard "` and `"Switchboard"` create duplicate project rows.
- **Logic:** Add `.trim()` on `projectName` at the top of `_resolveOrCreateProjectId` before
  `getProjectIdByName` and the `INSERT OR IGNORE`. Add a `console.debug` log when a new row is
  inserted (currently silent).
- **Edge Cases:** Empty string after trim → return `null` early (already guarded by
  `if (!projectName) return null`, but the trim must happen before that check moves).

## Verification Plan

### Automated Tests

> Per session directive: automated tests skipped. Verification is manual code-review only.

### Manual Verification

1. **Feature link (happy path):** Commit a subtask `.md` with `**Feature:** <feature-plan-id>` where
   the feature is already imported → confirm the subtask's `feature_id` is set on import; confirm
   the subtask appears under the feature on the board.
2. **Defer/retry:** Commit a subtask `.md` with `**Feature:** <id>` BEFORE the feature file exists →
   confirm the link is deferred; commit the feature file → confirm the deferred link resolves on the
   next watcher cycle.
3. **Apply-if-empty guard:** Import a subtask with `**Feature:** <id>`; then in the UI, move the
   subtask to a different feature; then re-save the subtask file WITHOUT `**Feature:**` → confirm the
   UI-changed link is NOT clobbered (the absent key does not clear the DB link).
4. **Project auto-create + trim:** Commit a plan with `**Project:** MyNewProject` → confirm a
   `projects` row is created; commit another with `**Project:**  MyNewProject ` (leading/trailing
   spaces) → confirm it links to the SAME project row (not a duplicate).
5. **Bad feature id:** Commit a subtask with `**Feature:** not-a-uuid` → confirm a warning is logged
   and the subtask imports standalone (no link, no crash).

## Recommendation

Complexity 5 → **Send to Coder**.
