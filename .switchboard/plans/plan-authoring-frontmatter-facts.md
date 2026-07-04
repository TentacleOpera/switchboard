# Plan-authoring frontmatter facts (epic + project on import)

## Goal

Let a remote-authored plan file declare two **durable facts** in its frontmatter — its epic and
its project — so that committing plan `.md` files (the legitimate git use) can express structure
without the retired `manifest.json`. This is the *lightweight* survivor of the abandoned model-C
work: durable authored facts applied on import, **not** a bidirectional control channel.

### Core problem & root cause

With the manifest retired as a control channel (`retire-file-based-git-control-plane.md`), remote
plan authoring still needs to set two things the plain body can't: which epic a subtask belongs
to, and which project it's in. These are **durable facts** (they describe the plan and are meant
to stay true), unlike a column move (a one-shot action / live state that belongs to a provider or
the DB). Durable facts are safe in per-plan frontmatter: different plans are different files (no
shared-mutable-file concurrency problem), and two branches editing the *same* plan's epic
conflict — which is correct.

`**Project:**` already works this way (`planMetadataUtils.ts:96`, re-stamped on import when
present). `**Epic:**` does not exist yet, and project has a latent id-resolution gap.

## Metadata

- **Project:** Switchboard
- **Tags:** plans, watcher, frontmatter, epics, projects
- **Complexity:** 5

## Implementation

1. **`**Epic:** <epic-plan-id>` carrier.** Parse via `extractEmbeddedMetadata(content, 'Epic')`
   into `PlanMetadata`. On import (`GlobalPlanWatcher._handlePlanFile`), resolve to the epic row
   (epic `plan_id` is the epic filename's UUID) and link via `updateEpicStatus(subtaskPlanId, 0,
   epicId)`; **defer** if the epic isn't imported yet. Apply with **apply-if-empty / first-import**
   semantics (positive-payload guard, borrowed from `PlanManifestService.ts:326-339`): an omitted
   key never clears a link, and the file does not overwrite an epic link the DB already has — so a
   human's later UI regroup is not clobbered on re-import. **No writeback, no reconciliation
   ledger** — this is authored metadata, not a synced control field.
2. **`**Project:**` hardening.** Keep the existing first-import behavior, but **auto-create the
   `projects` row** when the named project has none (reuse `addProject`) before resolving
   `project_id` — otherwise `project_id` stays NULL and the card drops off its project board (the
   V35/V38-migration hazard). Trim/normalize names; log projects created from files.
3. **Explicit change, not omission.** Because this is first-import/apply-if-empty, changing an
   existing plan's epic/project after import is a UI/provider action, not a file re-edit. (Full
   file-driven re-grouping was the model-C path we dropped as over-engineered.)

## User Review Required

- Confirm `**Epic:**` carries the epic `plan_id` (stable, filename-derived).
- Confirm apply-if-empty / first-import semantics (vs file-always-wins) — the former avoids
  clobbering UI/provider changes and is the low-risk choice.
- Confirm auto-creating a `projects` row from a file-named project.

## Complexity Audit

### Routine
- Adding a parsed `**Epic:**` field via the proven `extractEmbeddedMetadata` helper.
- Add-project-if-missing before id resolution (reuses `addProject`).

### Complex / Risky
- **Set-vs-unset:** absence of `**Epic:**` must never unlink; only apply positive payloads. This
  is the one guard that matters (the manifest already scarred on it).
- **Defer/ordering:** subtask imported before its epic → defer and retry (mirror the manifest's
  `getPlanByPlanId` defer).

## Edge-Case & Dependency Audit

- **Depends on:** `retire-file-based-git-control-plane.md` (this is where the manifest's
  epic/project role lands). Independent of the Issues provider and the activity light.
- **Scope guard:** this deliberately does NOT do column (provider/DB-owned), status, writeback, or
  reconciliation — those were the model-C complexity we cut once control moved to API providers.
- **Concurrency:** per-plan files; different plans never collide; same-plan concurrent edits
  conflict correctly. No shared mutable file.
- **Migration:** additive; existing `**Project:**` behavior unchanged except unknown names now
  auto-create the row (an improvement, matching V35/V38 intent).
