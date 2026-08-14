# `DELETE /kanban/plans` Leaves the Markdown and the Feature File Behind — Bring It to Parity With the Board's Delete

## Goal

Make the HTTP delete-plan endpoint do what the board's delete button does: remove the DB row, unlink the plan's `.md` file, and regenerate the parent feature's subtask block. Today it does only the first, so an API delete silently reverses itself and can corrupt a feature file.

### Root cause: parallel delete implementations, one of which was never finished

Switchboard deletes a plan from more than one place, and they disagree.

> **Superseded:** "Switchboard deletes a plan two ways, and they disagree." (the board button and the HTTP endpoint)
> **Reason:** There are **three** delete implementations at HEAD, not two. The third — `TaskViewerProvider._handleDeletePlan` (`src/services/TaskViewerProvider.ts:18405-18447`, the sidebar/run-sheet delete) — is the most complete of the set: it captures `featureId`, `linearIssueId` and `clickupTaskId` before mutating, deliberately orders the DB delete before the unlink so the watcher's post-unlink read no-ops (guaranteeing exactly one feature regeneration), removes cross-workspace claim markers, writes a tombstone, and *does* call `regenerateFeatureFile`. Describing the landscape as two paths understates the divergence and hides the fact that the HTTP handler is the only one of three that skips both the unlink and the regeneration.
> **Replaced with:** Three delete paths exist. Two are correct in different ways (the board button and the sidebar path); the HTTP endpoint is the outlier. This plan brings the outlier to parity with the board button — the closest analogue in scope — and explicitly does **not** attempt to unify all three (see *Scope boundary*).

**The board button** — `deleteKanbanPlan` in `src/services/PlanningPanelProvider.ts:3764-3818`. It:
1. captures `featureId` before the row is destroyed, with a comment explaining that the parent link is unrecoverable afterwards (`:3783-3788`)
2. deletes the DB row (`:3790`)
3. unlinks the `.md` — *"Delete the .md file from disk so the watcher doesn't re-import it"* (`:3791-3803`)
4. calls `regenerateFeatureFile(wsRoot, featureId)` when the plan was a subtask (`:3806-3814`)

**The HTTP endpoint** — `_handleDeletePlan` in `src/services/LocalApiServer.ts:3036-3081`. It does step 2. It fetches the record first (`:3059`) but uses only `record.planFile`. Step 3 is behind an opt-in query param (`:3067`), and step 4 does not exist at all.

Two defects follow.

**Defect 1 — the delete undoes itself.** Without `?deleteFile=true`, the row is removed and the file is left on disk, so the plan watcher re-imports it and the card comes back. The handler's own comment concedes this (`:3064-3065`): *"deletePlanByPlanId removes the DB row only; the .md file re-imports on the next `import_plans` unless the caller opts into unlinking it too."* The response is `{"success":true,"fileDeleted":false}`, which reads as a completed delete. A caller has no way to know the deletion is temporary unless it inspects `fileDeleted` and knows what that implies.

This is also inconsistent with how deletion works everywhere else in this product: deletes execute immediately and mean it. A delete that reappears is the same broken promise as a delete that silently no-ops.

**Defect 2 — deleting a subtask corrupts its feature file.** The board regenerates the parent feature's `## Subtasks` block; the API does not. Deleting a subtask over HTTP leaves an entry in a block marked *"auto-generated, do not edit"* pointing at a plan that no longer exists in the DB — and, once defect 1 is fixed, at a file that no longer exists on disk either. The feature then misreports its own composition to every agent and every rollup that reads it.

**Defect 3 (found during this review) — deleting a *feature* over HTTP is silently a no-op on disk, even after the flip.** A feature card is itself a row in `plans` (`is_feature = 1`, exposed on the record as `isFeature`; schema at `KanbanDatabase.ts:202`), and its `plan_file` points into **`.switchboard/features/`**, not `.switchboard/plans/` — verified against this workspace's DB, where the parent feature of this very plan carries `plan_file = .switchboard/features/external-orchestration-surface-…-4a799200-….md`. The endpoint's traversal guard (`abs.startsWith(plansDir + path.sep)`, `:3070`) therefore **never matches a feature row**, so flipping the default changes nothing for features: the row goes, the feature `.md` stays, the watcher re-imports it, and the feature returns — now with its subtasks' `feature_id` pointing at a resurrected row whose column state has been reset. `LocalApiServerOptions` already carries a dedicated `deleteFeature` callback (`LocalApiServer.ts:110-119`) that abandons child worktrees, detaches or tombstones subtasks, and unlinks external trackers. A partial feature delete through the plan endpoint is strictly worse than a refusal.

### Blast radius

No in-tree caller passes `deleteFile`. Grepping the extension for the param finds only the handler and its doc comment (`LocalApiServer.ts:3036`, `:3067`); the board button uses the `deleteKanbanPlan` planning verb, a different path that is already correct. The endpoint's consumers are therefore external agents and orchestrators following the documented contract.

Every such caller is today getting a delete that reverses itself. The flip moves them onto the behaviour they already believe they have.

### Scope boundary

This plan brings **one** handler to parity with the board button. It deliberately does **not** unify the three delete implementations behind a single routine, even though the PRD's anti-divergence contract argues for that eventually: the sidebar path (`TaskViewerProvider._handleDeletePlan`) additionally handles brain-source files, mirror files, tombstones, cross-workspace claim markers and Linear/ClickUp archival, and folding those into a shared primitive is a multi-day refactor of shipped, ~4,000-install behaviour. Parity is achievable now and is what unblocks external orchestrators; unification is a separate plan with its own safety case.

---

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, api, reliability, docs
**Project:** Browser Switchboard

---

## User Review Required

**None.** Four decisions made here:

* **`deleteFile` becomes opt-out, not opt-in.** Absent means delete. This is a behaviour change on a documented endpoint, and it is the correct one: every current caller believes it already has this behaviour, and the pre-flip behaviour has no legitimate use as a default.
* **The opt-out survives.** `deleteFile=false` keeps the file, and the docs say plainly that a kept file re-imports on the next scan. That is the only way the flag can be used correctly, and it is genuinely wanted when detaching a row while keeping the markdown for a re-import elsewhere.
* **Features are refused, not half-deleted.** A `DELETE /kanban/plans` against a row with `isFeature = 1` returns 409 and names the feature-delete path. See Defect 3.
* **Feature regeneration reaches the provider through a new injected callback**, matching how every other provider-owned operation is exposed to `LocalApiServer` — not through a direct provider reference, which the server does not have.

---

## Complexity Audit

* **Score:** 4 / 10

### Routine

* Inverting one query-param check and its default.
* Reusing an already-fetched `record` for `featureId` rather than issuing a second query.
* Adding two response fields.
* Rewriting a documentation table row and two prose callouts.

### Complex / Risky

* **It flips a destructive default on a published HTTP endpoint.** The failure direction is asymmetric: a wrong flip deletes files callers expected to keep. The traversal guard is the only thing standing between `record.planFile` and `fs.unlink`, and it now guards a default rather than an opt-in — it becomes more load-bearing, not less.
* **Two-host wiring, not one.** `LocalApiServer` is constructed in both hosts (`TaskViewerProvider.ts:2362` and `src/standalone/bootstrap.ts:1936`). A callback wired in only one host produces a delete that regenerates the feature file under VS Code and silently skips it under `npx switchboard` — PRD contract #7's "migrated-but-unreachable" failure, and invisible because the response would still say `success: true`.
* **The feature-row case (Defect 3)** is not a variant of the plan case; it needs its own branch and its own refusal.
* **The documented contract lives in more places than the plan originally named** — two skills, each mirrored under `.claude/`. A partial doc update leaves agents following an instruction that is now wrong.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **Watcher re-import between row delete and unlink.** The row is deleted first, then the file is unlinked. In that window a plan scan can re-import the still-present `.md` and recreate a row, which the unlink then orphans. The sidebar path documents this exact hazard and deliberately orders DB-delete-before-unlink so `GlobalPlanWatcherService._handlePlanDelete`'s post-unlink `getPlanByPlanFile` returns null and no-ops (`TaskViewerProvider.ts:18424-18430`). Keep the same order here and rely on the same property; do not reorder to "unlink first" on the theory that it closes the window — it opens a worse one (a double regeneration).
* **Concurrent delete of two subtasks of the same feature.** Both regenerate the same feature file. `_regenerateFeatureFile`'s byte-identical skip makes the second a no-op when the content matches; when it does not, last-write-wins produces the correct final block because it is regenerated from the DB, not patched. No lock needed — but do not "optimise" regeneration into an in-place line removal, which would not be convergent.

### Security

* The endpoint is auth-gated (`_checkAuth(req, true)`, `:3038`) and stays that way.
* **The traversal guard is the security control of this change.** `path.resolve` + `startsWith(plansDir + path.sep)` must remain exactly as written. A `planFile` resolving outside `.switchboard/plans` must skip the unlink and say so in the response — never widen the guard to accommodate a path, and never fall back to a workspace-root check (the board path's looser check is not the model to copy here).
* Note the guard's second job, discovered in this review: it is also what stops a feature row's `.switchboard/features/` path from being unlinked. After the explicit feature refusal is added, the guard is no longer the only thing preventing that — but it remains the backstop.

### Side Effects

* Callers that relied on the old default to keep files will lose them. This is the intended change and is documented; there is no in-tree caller, and the flip is a clean break on unreleased-in-this-form behaviour.
* Feature regeneration rewrites a `.md` in `.switchboard/features/`, which the plan watcher observes. That is the same write the board button already performs — no new watcher interaction.

### Dependencies & Conflicts

* **`KanbanProvider.regenerateFeatureFile(workspaceRoot, featureId)`** — `src/services/KanbanProvider.ts:13007` (public wrapper over the private `_regenerateFeatureFile` at `:12814`). Owns the `## Subtasks` block format. Never reimplement subtask-block rewriting.
* **Existing wiring precedent** — both hosts already build precisely this lambda for the plan-ingestion engine: `src/extension.ts:868-870` (`(ws, fid) => kanbanProvider?.regenerateFeatureFile(ws, fid) ?? Promise.resolve()`) and `src/standalone/bootstrap.ts:769-771` (`(ws, fid) => kanbanProvider.regenerateFeatureFile(ws, fid)`). Copy that shape.
* **`LocalApiServerOptions`** — `src/services/LocalApiServer.ts:37+`. Every provider-owned operation reaches the server as an optional injected callback (`moveCard`, `createFeature`, `assignToFeature`, `removeSubtaskFromFeature`, `deleteFeature`, `splitFeature`, `reconcileFeatures`). There is **no** provider reference on the server. Follow the established pattern.
* **Sibling subtask (governance)** — touches `KanbanProvider`, `ScheduledJobsService`, `PipelineOrchestrator` and the Connections panel. **No file is shared with this plan.** The two subtasks can land in any order.
* **Documentation surfaces** — `.agents/skills/switchboard-orchestration/SKILL.md` (line 84 table row, line 102 curl example, lines 105-106 gotcha callout) and `.agents/skills/rearrange-feature/SKILL.md` (line 43 table row, line 57 prose, line 65 bullet). `.agents/` is the source of truth; `.claude/skills/**` are generated mirrors — regenerate them, never hand-edit, and verify with `npm run mirror:check`.

---

## Dependencies

* No session dependencies. This plan is self-contained and can land against HEAD.
* Requires no schema change, no migration, and no new npm dependency.

---

## Adversarial Synthesis

Key risks: (1) **the flip is destructive by default** on a documented endpoint, so the traversal guard at `LocalApiServer.ts:3070` goes from a nicety to the only control preventing an out-of-tree unlink and must not be widened or replaced with the board path's looser workspace-root check; (2) **two-host wiring** — the regeneration callback must be injected at both `TaskViewerProvider.ts:2362` and `standalone/bootstrap.ts:1936`, or subtask deletes under `npx switchboard` silently skip feature regeneration while still reporting success (PRD contract #7); (3) **feature rows** live under `.switchboard/features/`, so the flip does nothing for them and a plan-endpoint feature delete would leave a resurrectable file — refuse with 409 and name the `deleteFeature` path rather than half-deleting; (4) **doc drift** — the contract is stated in two skills and two generated mirrors, and `rearrange-feature/SKILL.md:43` currently instructs agents that `deleteFile=true` is *required*, which the flip falsifies. Mitigations: keep the guard byte-identical and report a guard skip in the response; wire and manually verify both hosts; branch on `record.isFeature` before any mutation; update all six doc sites and regenerate the mirrors under `npm run mirror:check`.

---

## Proposed Changes

**Build order:** (1) feature refusal → (2) flip the default → (3) regeneration callback + both-host wiring → (4) response fields → (5) docs. Step 1 lands before step 2 so the destructive default is never live without the feature branch in front of it.

### 1. Refuse feature rows — `src/services/LocalApiServer.ts` (`_handleDeletePlan`)

**Context:** the handler already reads `record` at `:3059` before any mutation. `record.isFeature` is on the returned shape (`KanbanDatabase.ts:114`).

**Implementation:** immediately after the 404 not-found check, before `deletePlanByPlanId`:

```
if (Number(record.isFeature) > 0) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        success: false,
        error: `Plan ${planId} is a feature. Use the feature-delete path (delete-feature.js / the deleteFeature option) so child worktrees, subtask links and tracker records are handled.`
    }));
    return;
}
```

**Logic:** the plan endpoint cannot delete a feature correctly — the `.md` lives outside the directory its traversal guard permits, and the subtask detach / worktree abandon / tracker unlink work belongs to `deleteFeature`. A refusal that names the right path is strictly better than a delete that half-succeeds and resurrects.

**Edge cases:** 409 (conflict — wrong resource kind for this endpoint), not 400; the request is well-formed. `success: false` in the body per PRD contract #4, so an HTTP caller reading only the body still sees the failure.

### 2. Flip the `deleteFile` default — same handler

**Implementation:** replace the opt-in check at `:3067`:

```
const keepFile = url.searchParams.get('deleteFile') === 'false';
```

Unlink unless `keepFile`. Parse strictly as an opt-out: absent, empty, or any value other than the literal `false` means delete.

**Keep the existing traversal guard** at `:3070` — `abs.startsWith(plansDir + path.sep)` — **unchanged**. It is stricter than the board path's workspace-root check and now guards a destructive default. A `planFile` resolving outside `.switchboard/plans` must skip the unlink and report it (see change 4), never widen the guard to accommodate it.

Preserve the existing swallow of a missing file: an already-gone file is not an error.

**Edge cases:** `record.planFile` empty (rows imported without a file) — nothing to unlink, `fileDeleted: false`, not an error. `root` unresolvable — the existing `&& root` conjunct already skips the unlink; report it as a guard skip rather than as a successful delete.

### 3. Regenerate the parent feature file — `LocalApiServer` options + both hosts

**Implementation, part A —** add to `LocalApiServerOptions` (`src/services/LocalApiServer.ts:37+`), documented in the same style as its neighbours:

```
/**
 * Regenerate a feature's auto-generated `## Subtasks` block after one of its
 * subtasks is deleted, so the feature file does not keep listing a plan that no
 * longer exists. Mirrors the board delete path
 * (PlanningPanelProvider.deleteKanbanPlan). Optional — absent in headless/test
 * harnesses, in which case the regeneration is skipped and reported.
 */
regenerateFeatureFile?: (workspaceRoot: string, featureId: string) => Promise<void>;
```

**Part B —** capture `featureId` from the already-read `record` **before** `deletePlanByPlanId`, mirroring the board path's capture-before-mutate comment (`PlanningPanelProvider.ts:3783-3788`) — the parent link is unrecoverable once the row is gone.

**Part C —** after a successful row delete and the unlink, when `featureId` is non-empty, call `this._options.regenerateFeatureFile?.(root, featureId)` inside its own try/catch. A regeneration failure must **not** fail the delete — the row and file are already gone. Log it (`console.warn`, as the board path does) and report it (change 4).

**Part D — wire both hosts. This is not optional and is the step most likely to be dropped:**
* Extension host, in the option bag at `src/services/TaskViewerProvider.ts:2362`:
  `regenerateFeatureFile: async (ws, fid) => { await this._kanbanProvider?.regenerateFeatureFile(ws, fid); }`
* Standalone host, in the option bag at `src/standalone/bootstrap.ts` (alongside `createFeature`/`assignToFeature`/`removeSubtaskFromFeature` at `:1878-1895`):
  `regenerateFeatureFile: async (ws, fid) => { await kanbanProvider.regenerateFeatureFile(ws, fid); }`

**Logic:** reach the provider through the same injected-callback seam every other provider-owned operation uses. `LocalApiServer` holds no provider reference and must not acquire one — that would couple the host-agnostic server to a VS Code-side provider and break the standalone composition root.

**Edge cases:** callback absent (test harness) — skip and report `featureRegenerated: false` with a reason; never throw. `featureId` present but the feature row itself already deleted — `regenerateFeatureFile` owns that case; catch and report.

### 4. Report what actually happened — same handler

**Implementation:** the response becomes:

```
{ success, fileDeleted, fileSkipReason?, featureId?, featureRegenerated?, featureRegenerationError? }
```

* `fileDeleted` keeps its meaning.
* `fileSkipReason` is present only when the unlink was skipped, and says which reason: `'opted-out'`, `'outside-plans-dir'`, `'no-plan-file'`, or `'already-missing'`.
* `featureRegenerated` is present only when the deleted plan had a `featureId`.

**Logic:** a caller must be able to distinguish "row gone, file gone, feature updated" from "row gone, everything else skipped". The current `{success:true, fileDeleted:false}` collapses four different outcomes into one shape.

**Edge cases:** omit the feature fields entirely for non-subtask deletes rather than emitting `featureRegenerated: false` — absent means "not applicable", `false` means "was applicable and did not happen".

### 5. Update the documented contract — `.agents/skills/**` (source of truth), then regenerate mirrors

**`.agents/skills/switchboard-orchestration/SKILL.md`:**
* **line 84** (table row) currently: `DELETE /kanban/plans?planId=<id>[&deleteFile=true]` | — | Delete the DB row; `deleteFile=true` also unlinks the `.md`.
  Rewrite for the new default: the delete removes the row, unlinks the `.md`, and refreshes the parent feature's subtask block; `deleteFile=false` keeps the file; features are refused with 409.
* **line 102** (curl example) — drop `&deleteFile=true` from the "also remove the file" example and add a second example showing `deleteFile=false` as the keep-the-file case.
* **lines 105-106** (the `delete_plan` gotcha callout) — invert it. It currently warns that *without* `deleteFile=true` the plan re-appears. After the flip, the warning belongs on the opt-out: `deleteFile=false` keeps the `.md`, and a kept file **re-imports on the next `import_plans`** (or a webview reset) — which is the whole reason the opt-out exists and the only way a caller can use it correctly.

**`.agents/skills/rearrange-feature/SKILL.md`:**
* **line 43** (table row) currently asserts **"`deleteFile=true` is required"**. That becomes false. Rewrite to: `DELETE /kanban/plans?planId=<id>` deletes the row and the file.
* **line 57** (merge prose) and **line 65** (bullet: *"`deleteFile=true` on real deletes — otherwise the `.md` re-imports"*) — drop the now-redundant flag and the now-false justification.

**Then regenerate the `.claude/` mirrors** (`.claude/skills/switchboard-orchestration/SKILL.md`, `.claude/skills/rearrange-feature/SKILL.md`) through the control-plane scaffold rather than hand-editing them, and verify with `npm run mirror:check`.

**Edge cases:** do not add the declared-move channel or any governance copy to these files — that is the sibling subtask's surface, and it currently touches no skill file at all.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive. The checks below are the acceptance criteria for the coding pass.

### Automated Tests (target coverage for the coding pass)

* Default deletes the file: `DELETE` with no flag ⇒ row gone, `.md` gone, `fileDeleted: true`.
* Opt-out: `deleteFile=false` ⇒ row gone, file present, `fileDeleted: false`, `fileSkipReason: 'opted-out'`.
* Any other value (`deleteFile=0`, `deleteFile=no`, empty) ⇒ file **deleted** (strict opt-out parse).
* Traversal guard: a record whose `planFile` resolves outside `.switchboard/plans` ⇒ nothing unlinked, `fileSkipReason: 'outside-plans-dir'`, `success` still reflects the row delete.
* Feature refusal: a row with `isFeature = 1` ⇒ 409, `success: false`, **row not deleted**, file not touched.
* Subtask delete ⇒ `regenerateFeatureFile` called once with the captured `featureId`.
* Non-subtask delete ⇒ regeneration never attempted, feature fields absent from the response.
* Regeneration throws ⇒ row and file still deleted, `featureRegenerated: false`, `featureRegenerationError` populated, HTTP 200.
* Callback absent (headless harness) ⇒ no throw, `featureRegenerated: false`.

### Manual Verification

1. **Anchor the regression first.** Create a plan, confirm it imports, `DELETE` it with no flag on the **current** build, and watch it re-appear after a watcher scan. Only then apply the change and repeat: the row is gone, the `.md` is gone, and it does not come back.
2. **Opt-out preserved.** Delete with `deleteFile=false`. Row goes, file remains, and — as documented — the card re-imports.
3. **Subtask delete cleans its feature.** Create a feature with three subtasks, delete one via the API. The feature file's `## Subtasks` block lists two, with no dangling entry, and the result is identical to deleting the same subtask from the board.
4. **Board parity.** Delete one plan via the board and an equivalent one via the API. Identical end state on disk and in the DB.
5. **Feature refusal.** `DELETE` a feature's planId. 409, the feature row survives, the feature `.md` survives, and the error names the feature-delete path.
6. **Missing file.** Delete a plan whose `.md` is already gone. Success, not a 500, `fileSkipReason: 'already-missing'`.
7. **Standalone host parity (the PRD check).** Under `npx switchboard`, delete a subtask via the API and confirm the feature file's subtask block is regenerated there too. This is the check that catches a callback wired in only one host — and the response looks identical whether or not the wiring is present, so it must be verified on disk, not from the response body.
8. **Docs.** Re-read all six doc sites and confirm none still instructs an agent to pass `deleteFile=true`; run `npm run mirror:check`.

---

## Recommendation

Complexity 4 → **Send to Coder.**

The handler change itself is small; the two things that make it a 4 rather than a 3 are the both-host callback wiring (which fails silently and identically-looking if half-done) and the feature-row refusal, which was not visible from the original framing. Land the feature refusal before the default flip so a destructive default is never live without its guard branch in place.

**Migration:** none. No schema change and no persisted state. The behaviour change is on an HTTP contract with no in-tree callers; external callers move onto the behaviour the documentation already led them to expect.
