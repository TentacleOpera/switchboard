# .agents file lifecycle fixes

**Complexity:** 6

## Goal

Fix the .agents file lifecycle: deletion guard gaps in performSetup and _bootstrapControlPlaneLayout, .claude mirror not regenerating on deletion, and protocols/ directory lacking ledger/drift/retirement mechanism.

## How the Subtasks Achieve This

- **.claude mirror regenerates on deletion-respected skip**: Adds a `deletionSkipped` return flag to `seedBundleSurface` and a separate `else if (deletionRespected)` scaffold-gate branch in `refreshWorkspaceControlPlane` (no version stamp) so that when the activation-path deletion guard skips a retired skill, `generateClaudeMirror` runs and its stale-skill cleanup removes the retired entry from `.claude/skills/`. Closes the "mirror shrinks one activation late" gap.
- **Deletion guard and bundle ledger cover all .agents surfaces and all copy paths**: Threads the bundle-ledger deletion guard into the two whole-tree copy paths (`performSetup` and `_bootstrapControlPlaneLayout` → `_copyDirectoryRecursive`) that currently copy unconditionally, and extends the ledger/guard/prune/drift machinery from `skills/`+`workflows/` to also cover `protocols/`. Closes both the copy-path guard gap and the protocols-no-ledger gap in one coherent owner of the ledger-guard surface.

## Dependencies & sequencing

- **Ship ".claude mirror regenerates on deletion-respected skip" FIRST.** It introduces the `deletionSkipped` return flag on `seedBundleSurface` and the `deletionRespected` scaffold-gate branch. The merged plan widens `seedBundleSurface`'s surface type to `'protocols'` and wires `protocolResult.deletionSkipped` into the `deletionRespected` OR — both assume the flag already exists.
- **Ship "Deletion guard and bundle ledger cover all .agents surfaces and all copy paths" SECOND.** It depends on the sibling plan's `deletionSkipped` flag. Its `refreshWorkspaceControlPlane` block is the reconciled combination of the sibling plan's `deletionRespected` branch plus this plan's protocols seed call.
- **Prerequisite/guard:** both plans extend a single proven pattern (the `seedBundleSurface` ledger guard at ControlPlaneMigrationService.ts:1264–1271). No external prerequisite beyond the existing `readBundleLedger` helper.
- **Note:** the auto-generated Subtasks block below still lists the three pre-merge subtask files; it regenerates from the board DB after the watcher reconciles the `git rm` of the two merged-away plans and the import of the new consolidated plan file. The two subtasks named above are the post-restructure delivery set.

## Team Dispatch Instructions

### .claude mirror regenerates on deletion-respected skip

- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - After `refreshWorkspaceControlPlane` with a ledger-tracked skill deleted from `.agents/skills/`, the file `.claude/skills/<deleted-skill>/SKILL.md` is absent from the workspace.
  - `setLastCopiedAgentVersion` is NOT called on a deletion-respected-only run (no version stamp advance).
  - On a fresh workspace (no ledger), `seedBundleSurface` returns `deletionSkipped === false` and the scaffold fires normally via `needsAgentRefresh`.
  - `seedBundleSurface`'s return type includes `deletionSkipped: boolean`.
- **Must not touch:** None specified beyond the two named functions (`seedBundleSurface` return type, `refreshWorkspaceControlPlane` scaffold gate). Do not modify the `_bootstrapControlPlaneLayout` mirror gate (line 741) — that gap is a tracked follow-up, not this plan's scope.

### Deletion guard and bundle ledger cover all .agents surfaces and all copy paths

- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - After `performSetup` and after `_bootstrapControlPlaneLayout` with a ledger-tracked skill/workflow/protocol deleted, the deleted file is absent from `.agents/<surface>/` (not resurrected).
  - On a fresh workspace (no ledger), all bundle files including protocols are copied by both whole-tree paths (no starvation).
  - After `refreshWorkspaceControlPlane`, every `protocols/<name>/SKILL.md` shipped by the bundle is resolvable at `.agents/protocols/<name>/SKILL.md`, and the ledger contains `protocols/` entries.
  - Removing a protocol from the bundle and running activation prunes it from `.agents/protocols/`; deleting a protocol and running activation does NOT re-copy it.
  - A `personas/` file deleted from `.agents/` IS restored (confirms the guard scope does not over-reach into untracked surfaces).
- **Must not touch:** Do NOT add a "skip protocols" branch to `performSetup` or `_copyDirectoryRecursive` (superseded — see the plan's Superseded callout; it strands protocols on the setup/init paths). Do not modify the `_bootstrapControlPlaneLayout` mirror gate (line 741) — tracked follow-up. Do not change the `.claude/` mirror generation logic (owned by the sibling plan).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [.claude/ mirror keeps retired skill until next version bump after .agents/ deletion](../plans/feature_plan_20260827144002_claude-mirror-not-regenerating-on-deletion.md) — **PLAN REVIEWED** — ID: 4044524c-c4c3-442c-986d-027491f67b5b
- [ ] [Deletion guard and bundle ledger cover all .agents surfaces and all copy paths](../plans/feature_plan_20260827144004_deletion-guard-and-ledger-cover-all-agents-surfaces.md) — **CREATED** — ID: d8c023a3-cbb7-4ee0-a765-9d1831b094a6
<!-- END SUBTASKS -->

