# .claude/ mirror keeps retired skill until next version bump after .agents/ deletion

## Goal

When a workspace deletes a skill from `.agents/`, the deletion guard in `seedBundleSurface` correctly skips re-copying it (the file stays deleted in `.agents/`). However, the `.claude/` mirror is NOT regenerated, so the retired skill persists in `.claude/skills/` until the next version bump.

**Root cause:** In `refreshWorkspaceControlPlane` (extension.ts:329–424), the scaffold step (which calls `generateClaudeMirror`) is gated on `needsAgentRefresh || agentsChanged` (line 361). When the seed guard skips a deleted file, it does NOT set `changed = true` (the `continue` at line 1270 exits before any `changed = true` assignment). So `agentsChanged` stays `false`, and if there's no version change (`needsAgentRefresh = false`), `scaffoldProtocolLayers` is never called, and `generateClaudeMirror` never runs.

The `.claude/` mirror's own stale-skill cleanup (ClaudeCodeMirrorService.ts:387–403) only fires when `generateClaudeMirror` is actually called — it compares the previous ledger against the current run's generated skills and removes any that were not regenerated. Without the call, the stale mirror entry persists indefinitely.

The `<available_skills>` symptom — which the protocols migration existed to fix — therefore shrinks one activation late, or not at all on a same-version install.

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

No — the fix is a localized signal-addition with a traced end-to-end path. The one open scope question (bootstrap-path mirror regen) is recorded under Outstanding Questions and does not block implementation.

## Dependencies

- `feature_plan_<merged-deletion-guard-and-ledger>` — *Deletion guard and bundle ledger cover all .agents surfaces and all copy paths* (merged from the deletion-guard-gaps and protocols-no-ledger subtasks). This plan introduces the `deletionSkipped` return flag on `seedBundleSurface`; the merged plan extends the surface type to `protocols` and wires `protocolResult.deletionSkipped` into the `deletionRespected` OR. **Ship this plan FIRST** so the flag exists when the merged plan adds the protocols seed call.

## Complexity Audit

**Routine:**
- The fix is a one-line change: set a flag when the deletion guard fires and use it to trigger the scaffold.
- `generateClaudeMirror` already has the stale-skill cleanup logic.

**Complex/Risky:**
- Must decide whether a deletion should trigger ONLY the mirror regen, or the full protocol scaffold (which also rewrites AGENTS.md/CLAUDE.md). The full scaffold is heavier but already idempotent. The mirror-only path would require a new code path.
- Setting `agentsChanged = true` on a skip would also trigger the version stamp (line 368–370), which is semantically wrong — no files changed, the version shouldn't advance. The flag needs to be separate from `agentsChanged`.

## Edge-Case & Dependency Audit

- **Skip vs. change semantics:** `agentsChanged` currently means "files were added or overwritten." A deletion skip is neither — it's a no-op on `.agents/` but requires a mirror regen on `.claude/`. The signal must be distinct.
- **Version stamp:** If the scaffold fires on a deletion, `setLastCopiedAgentVersion` runs (line 368–370). This is harmless (same version re-stamped) but unnecessary. Could be gated separately.
- **First-run:** No ledger → no skips → no deletion signal → scaffold fires normally via `needsAgentRefresh`. No regression.
- **Multiple deletions:** Each skip sets the flag; the scaffold fires once. Correct.
- **Deletion + addition in same pass:** Both `agentsChanged` and the deletion flag are true; scaffold fires once. Correct.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the `deletionSkipped` signal must stay distinct from `agentsChanged` so the version stamp is not wrongly advanced on a no-op skip; (2) the full `scaffoldProtocolLayers` call rewrites AGENTS.md/CLAUDE.md managed blocks on every deletion-respected activation — idempotent but heavier than a mirror-only regen; (3) the `_bootstrapControlPlaneLayout` path has the same `needsAgentMigration || agentsChanged` mirror gate (ControlPlaneMigrationService.ts:741) and is NOT fixed here, so a deletion respected on the `npx switchboard init` path still strands the stale mirror entry. Mitigations: separate `else if (deletionRespected)` branch with no version stamp; scaffold idempotency makes the extra rewrite safe; the bootstrap gap is recorded under Outstanding Questions for a follow-up.

## Proposed Changes

### 1. `seedBundleSurface` return type (src/services/ControlPlaneMigrationService.ts:1236–1285)

Add a `deletionSkipped` flag to the return value:

```typescript
public static async seedBundleSurface(
    surface: 'skills' | 'workflows',
    bundleDir: string,
    workspaceRoot: string,
    ledgerSnapshot: Set<string>,
): Promise<{ changed: boolean; files: string[]; deletionSkipped: boolean }> {
    let changed = false;
    let deletionSkipped = false;
    let files: string[] = [];
    // ... existing code ...
    } else {
        // dest absent → check ledger before copying.
        const ledgerKey = surface + '/' + relativePath.split(path.sep).join('/');
        if (ledgerSnapshot.has(ledgerKey)) {
            deletionSkipped = true;  // NEW: signal that a deletion was respected
            continue;
        }
        // ... existing copy logic ...
    }
    // ... existing error handling ...
    return { changed, files, deletionSkipped };
```

### 2. `refreshWorkspaceControlPlane` (src/extension.ts:352–361)

Capture the deletion signal and use it to trigger the scaffold:

```typescript
const skillResult = await ControlPlaneMigrationService.seedBundleSurface(
    'skills', path.join(bundledAgentsPath, 'skills'), root, ledgerSnapshot);
const workflowResult = await ControlPlaneMigrationService.seedBundleSurface(
    'workflows', path.join(bundledAgentsPath, 'workflows'), root, ledgerSnapshot);
const agentsChanged = skillResult.changed || workflowResult.changed;
const deletionRespected = skillResult.deletionSkipped || workflowResult.deletionSkipped;
const skillFiles = skillResult.files;
const workflowFiles = workflowResult.files;

// 3. Scaffold protocol layers + stamp version iff refresh needed.
// A deletion-respected skip must trigger the mirror regen so the .claude/
// stale-skill cleanup fires — but it does NOT need the version stamp
// (no files changed, the stamp is for version-gated migrations).
if (needsAgentRefresh || agentsChanged) {
    try {
        await scaffoldProtocolLayers(
            vscode.Uri.file(root),
            context.extensionUri,
            'Migration'
        );
        const currentVersion = getExtensionVersion(context.extensionUri.fsPath);
        if (currentVersion) {
            setLastCopiedAgentVersion(root, currentVersion);
        }
        // ... existing spark context generation ...
    } catch (err) {
        console.error(`[Switchboard] Protocol-file migration failed for ${root}, continuing:`, err);
    }
} else if (deletionRespected) {
    // A workspace deletion was respected — regenerate the .claude/ mirror
    // so the stale-skill cleanup removes the retired entry. No version stamp:
    // no files changed, only the mirror needs to catch up.
    try {
        await scaffoldProtocolLayers(
            vscode.Uri.file(root),
            context.extensionUri,
            'DeletionMirror'
        );
    } catch (err) {
        console.error(`[Switchboard] Deletion mirror regen failed for ${root}, continuing:`, err);
    }
}
```

> **Note (cross-subtask):** The sibling merged plan (*Deletion guard and bundle ledger cover all .agents surfaces and all copy paths*) adds a third `seedBundleSurface('protocols', ...)` call and extends both `agentsChanged` and `deletionRespected` to include `protocolResult`. This plan lands first and shows the skills/workflows-only block; the merged plan reconciles the combined block.

## Verification Plan

1. **Unit test:** Seed a workspace with the bundle, delete a skill from `.agents/`, record the ledger, then run `refreshWorkspaceControlPlane` — assert the corresponding `.claude/skills/<name>/SKILL.md` is removed.
2. **Unit test:** Same setup but without the fix — assert the stale mirror entry persists (regression proof).
3. **Unit test:** Fresh workspace (no ledger) — run `refreshWorkspaceControlPlane` — assert no deletion flag is set and the scaffold fires normally.
4. **Unit test:** Delete a skill AND add a new one in the same pass — assert both the mirror regen and the new skill copy happen.
5. **Manual test:** Delete a skill from `.agents/`, reload the VS Code window — assert the `.claude/skills/` mirror no longer contains the deleted skill.

### Goal Invariants

- After `refreshWorkspaceControlPlane` with a ledger-tracked skill deleted from `.agents/skills/`, the file `.claude/skills/<deleted-skill-name>/SKILL.md` is ABSENT from the workspace.
- After `refreshWorkspaceControlPlane` with a ledger-tracked skill deleted, `setLastCopiedAgentVersion` is NOT called (no version stamp advance) — assert the stamped version file's mtime/content is unchanged across the run.
- After `refreshWorkspaceControlPlane` on a fresh workspace (no ledger), `seedBundleSurface` returns `deletionSkipped === false` for both skills and workflows.
- `seedBundleSurface`'s return type includes the `deletionSkipped: boolean` field (symbol resolvable in `ControlPlaneMigrationService.ts`).

## Outstanding Questions

- **[user]** The `_bootstrapControlPlaneLayout` path (ControlPlaneMigrationService.ts:741) gates `generateClaudeMirror` on `needsAgentMigration || agentsChanged` — the same pattern this plan fixes in the activation path. Once the sibling merged plan threads the deletion guard into bootstrap, a deletion respected on the `npx switchboard init` path will skip re-copy AND skip mirror regen, stranding the stale `.claude/` entry. Should the bootstrap path receive the same `deletionRespected` signal? — proceeding on the assumption that this is a follow-up, not part of this plan, because bootstrap is init-oriented and the recurring activation path is the one that hits existing workspaces.

## Recommendation

**Complexity 4 → Send to Coder.** Single signal-addition with a traced end-to-end path; the only design choice (full scaffold vs mirror-only) is resolved in favor of the idempotent full scaffold. Ship before the sibling merged plan so the `deletionSkipped` flag exists when it extends the surface type.
