# Deletion guard and bundle ledger cover all .agents surfaces and all copy paths

<!-- board-collapse-02 -->
> **RESCOPED 2026-09-04 (Board Collapse 02).** This plan's stated dependency, *.claude/ mirror keeps retired skill until next version bump*, has been **deleted**: it exists only to re-run `generateClaudeMirror` so its stale-skill cleanup fires, and the generator is being removed. Two consequences: (1) the `deletionSkipped` return value on `seedBundleSurface` is now **this plan's** to add, not something to inherit; (2) drop the mirror-regeneration step entirely — with `.claude/skills/` committed as source, a skill deleted from `.agents/` is deleted from `.claude/` in the same commit and needs no generator pass. The ledger, guard, prune and `protocols/` widening are unaffected.


## Goal

The `.agents/` deletion guard — which prevents a workspace's deliberate file retirement from being silently undone — has two coverage gaps that leave files stranded or resurrected: (1) it only protects the activation seed loop (`seedBundleSurface`), while the two whole-tree copy paths (`performSetup` and `_bootstrapControlPlaneLayout` → `_copyDirectoryRecursive`) copy unconditionally with no ledger check; and (2) it only covers `skills/` and `workflows/`, while the relocated `protocols/` surface (32 files) has no ledger entry, no drift line, and no retirement mechanism. This plan closes both gaps so the ledger, the deletion guard, and the prune/drift reconcile cover every bundle-shipped surface across every copy path.

**Root cause (gap 1 — copy paths):** The deletion guard was added only to `seedBundleSurface`, the activation-path seed function. The two whole-tree copy paths predate the guard and were never updated to consult the ledger:

1. **`performSetup`** (extension.ts:4334–4467) — the Setup tab's "Set Up Control Plane" button. It crawls the entire bundled `.agents/` tree and copies every file via content-hash logic, but never reads the bundle ledger. A file the workspace deliberately deleted gets re-copied because the dest-absent branch (line 4403–4410: `vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false })`) has no ledger gate.
2. **`_bootstrapControlPlaneLayout` → `_copyDirectoryRecursive`** (ControlPlaneMigrationService.ts:677–710, 1055–1103) — reached by `npx switchboard init` and the control-plane migration flows. `_copyDirectoryRecursive` copies files with `overwrite: false` / `overwriteIfDiffers: true`, but when the target doesn't exist it copies unconditionally (line 1088–1090: `else if (targetExists) { continue; }` — the absent case falls through to copy). No ledger snapshot is read or consulted. Since `npx switchboard init` is explicitly documented as safe to re-run, re-running it silently undoes any workspace retirement.

**Root cause (gap 2 — protocols surface):** The `protocols/` directory was relocated from `.agents/skills/` (where it would have been covered by the existing surface) to `.agents/protocols/` (a new top-level surface), but the seed/prune/ledger machinery was never extended to cover the new surface. The bundle ledger (`readBundleLedger`) only records `skills/<rel>` and `workflows/<rel>` paths; the activation log's drift counts (line 1387: `const scopes = ['skills', 'workflows']`) only scan those two surfaces; and `pruneRetiredBundleFiles` only deletes files that were previously in the ledger — so a protocol file removed from the bundle strands in every workspace forever.

## Metadata

**Complexity:** 6
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard
**Feature:** 8bf2c976-1437-46e1-a000-0998bc522146
**Consolidated From:** feature_plan_20260827144001_deletion-guard-gaps-performSetup-and-bootstrap.md, feature_plan_20260827144003_protocols-directory-no-ledger-drift-retirement.md

## User Review Required

No — the fix extends a single proven pattern (the `seedBundleSurface` ledger guard) to two more copy paths and one more surface. The one superseded approach (skip protocols in the whole-tree copy) and one open scope question (bootstrap-path mirror regen) are documented below and do not block implementation.

## Dependencies

- `feature_plan_20260827144002_claude-mirror-not-regenerating-on-deletion.md` — *.claude mirror regenerates on deletion-respected skip*. That plan introduces the `deletionSkipped` return flag on `seedBundleSurface` and the `deletionRespected` scaffold-gate branch in `refreshWorkspaceControlPlane`. **Ship it FIRST.** This plan then extends `seedBundleSurface`'s `surface` type to include `'protocols'` and wires `protocolResult.deletionSkipped` into the `deletionRespected` OR — both assume the flag already exists.

## Complexity Audit

### Routine

- Reading the bundle ledger is already implemented (`readBundleLedger`, ControlPlaneMigrationService.ts:1158) and shared by the seed guard and the prune.
- The guard pattern (check ledger on dest-absent, skip if in-ledger) is already proven in `seedBundleSurface` (line 1264–1271).
- `seedBundleSurface` already takes a generic `surface` parameter — adding `'protocols'` is a third call site and a one-token type-union widening.
- `pruneRetiredBundleFiles`'s scope list (line 1387) is a simple array — adding `'protocols'` is one line.
- The ledger writer (line 1411) takes `currentBundlePaths` built by the caller — adding protocols paths is a caller-side change.
- Both whole-tree copy paths (`performSetup`, `_copyDirectoryRecursive`) are well-isolated functions.

### Complex / Risky

- `performSetup` copies the ENTIRE `.agents/` tree (skills, workflows, protocols, personas, rules), not just `skills/` and `workflows/`. The guard must apply to the three ledger-tracked surfaces (`skills/`, `workflows/`, `protocols/`) while leaving untracked surfaces (`personas/`, `rules/`) copied unconditionally when absent.
- `_copyDirectoryRecursive` is a private static method with no access to the ledger snapshot — it needs the snapshot threaded through as a parameter, changing its signature and all call sites (the recursive self-call at line 1069 plus the `_bootstrapControlPlaneLayout` call at line 704).
- The `performSetup` path uses `vscode.workspace.fs` while `_copyDirectoryRecursive` uses `fs.promises` — the ledger check must work in both APIs (it does: the check is pure string/Set logic, the copy API differs).
- Protocols are structured as directories with a `SKILL.md` inside (e.g. `protocols/dispatch-analysis/SKILL.md`), not flat `.md` files. `_crawlRelative` already handles nested directories recursively; the ledger key (`protocols/<name>/SKILL.md`) must match what the prune resolves (it does — both use `split(path.sep).join('/')`).
- Once protocols are ledger-tracked AND seeded by `seedBundleSurface`, the whole-tree copy paths would copy protocols redundantly. The guard (not a skip) resolves this: an in-ledger absent protocol is skipped by the guard; a present protocol is left alone (no overwrite); a genuinely-new protocol is copied. No separate "skip protocols" branch is needed (see Superseded callout in §5).

## Edge-Case & Dependency Audit

- **First-run (no ledger):** `readBundleLedger` returns `null` → empty set → all absent files copied (fresh workspace not starved). Already handled by the existing pattern in `seedBundleSurface`; the same empty-set semantics apply to the two newly-guarded copy paths.
- **Ledger scope:** After this plan, the ledger tracks `skills/<rel>`, `workflows/<rel>`, and `protocols/<rel>`. `personas/`, `rules/`, `scripts/` remain untracked and are always copied when absent by the whole-tree paths. This is intentional — only the three bundle-managed surfaces need retirement protection.
- **`_copyDirectoryRecursive` call sites:** Called from `_bootstrapControlPlaneLayout` (line 704) and recursively from itself (line 1069). The new optional `ledgerSnapshot` parameter defaults to `undefined` (no guard) so any other call site is unaffected; the bootstrap call site passes the snapshot explicitly.
- **Migration flows:** `_mergeSharedAgentContent` calls `_bootstrapControlPlaneLayout` (line 869). The guard must not block legitimate migration copies into a fresh control plane — on a fresh control plane the ledger is absent (`null` → empty set), so nothing is skipped. Safe.
- **Blocklist interaction:** `performSetup` has a separate blocklist step (line 4419–4449) that deletes specific files. The guard (prevents re-creation on the copy path) and the blocklist (forces deletion) are independent and compatible — the blocklist runs AFTER the copy loop, so even if a blocklisted file were re-copied it is deleted afterward. The guard and blocklist do not conflict.
- **Deletion guard interaction across surfaces:** Once protocols are ledger-tracked, the deletion guard (gap 1 fix) protects protocol retirements on all three copy paths. This is correct and desirable — the two gaps close together.
- **Mirror interaction:** `generateClaudeMirror` scans `.agents/skills/` for `switchboard-*.md` files. Protocols are not mirrored to `.claude/` — they are consumed in-place by the agent. No mirror change needed for protocols. (The `.claude/` mirror regen on a deletion-respected skip is owned by the sibling plan.)
- **Bootstrap-path mirror regen:** `_bootstrapControlPlaneLayout` (line 741) gates `generateClaudeMirror` on `needsAgentMigration || agentsChanged`. After this plan threads the ledger guard into bootstrap, a deletion respected on the `npx switchboard init` path skips re-copy but does NOT trigger mirror regen — the stale `.claude/` entry survives the init path. See Outstanding Questions.
- **Drift log:** Adding `'protocols'` to the prune scopes (line 1387) means the drift log's `extra` count now includes stranded protocol files. The drift line format is unchanged.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) threading `ledgerSnapshot` through `_copyDirectoryRecursive` changes a private static signature and its recursive self-call — a missed call site silently disables the guard on that branch; (2) the guard scope condition (`skills/ || workflows/ || protocols/`) must be identical across all three copy paths or a surface is protected on one path and not another; (3) adding protocols to the seed loop AND the whole-tree copy creates a redundant-copy window if the guard scope is inconsistent — the guard (not a skip) is what prevents the redundancy, so the scope condition is load-bearing; (4) the bootstrap mirror-regen gap (line 741) is not closed here. Mitigations: the `ledgerSnapshot` parameter is optional with `undefined` default so untouched call sites fail-open (copy, no guard) rather than fail-closed (starve); the scope condition is a single helper expression repeated verbatim; the redundancy is self-resolving once the guard is consistent; the bootstrap mirror gap is recorded under Outstanding Questions.

## Proposed Changes

### 1. `performSetup` — read ledger + guard the dest-absent branch (src/extension.ts:4350–4411)

Read the bundle ledger once before the copy loop and skip in-ledger absent files for the three tracked surfaces:

```typescript
// 2. Discover and Copy .agents assets (Recursive & Depth-Limited)
const agentSourceUri = vscode.Uri.joinPath(extensionUri, '.agents');
const agentFiles = await crawlDirectory(agentSourceUri);

// Deletion guard: read the bundle ledger once before the copy loop.
// In-ledger AND absent = workspace deliberately deleted → skip.
// Not-in-ledger AND absent = genuinely new → copy.
// null/empty ledger → all absent files copied (fresh workspace not starved).
// Only skills/, workflows/, protocols/ are ledger-tracked; personas/, rules/
// are always copied when absent.
const ledgerRaw = ControlPlaneMigrationService.readBundleLedger(workspaceRoot);
const ledgerSnapshot = new Set<string>(ledgerRaw ?? []);
```

Then in the dest-absent `catch` branch (line 4403–4410), add the ledger check before the copy:

```typescript
} catch {
    // dest absent → check ledger before copying (deletion guard).
    const relativePathPosix = relativePath.split(path.sep).join('/');
    const isLedgerTracked =
        relativePathPosix.startsWith('skills/') ||
        relativePathPosix.startsWith('workflows/') ||
        relativePathPosix.startsWith('protocols/');
    if (isLedgerTracked && ledgerSnapshot.has(relativePathPosix)) {
        continue; // workspace deliberately deleted this file → skip
    }
    try {
        await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
    } catch (copyErr) {
        console.warn(`[Setup] Agent file copy failed for ${relativePath}, skipping:`, copyErr);
    }
}
```

### 2. `_copyDirectoryRecursive` — thread the ledger snapshot (src/services/ControlPlaneMigrationService.ts:1055–1103)

Add an optional `ledgerSnapshot` parameter and consult it on the dest-absent path. The parameter is optional (`undefined` default) so any call site that does not pass it fails open (copies, no guard) rather than starving the workspace:

```typescript
private static async _copyDirectoryRecursive(
    sourceDir: string,
    targetDir: string,
    options: { overwrite: boolean; overwriteWorkflows?: boolean; overwriteIfDiffers?: boolean },
    basePath: string = '',
    ledgerSnapshot?: Set<string>,
): Promise<number> {
    // ... existing code ...
    if (!shouldOverwrite) {
        if (options.overwriteIfDiffers && targetExists) {
            // ... existing content-hash path ...
        } else if (targetExists) {
            continue;
        }
        // target absent and not overwriting → fall through to copy,
        // BUT check the ledger first (deletion guard).
    }
    // Deletion guard: skip in-ledger absent files for the three tracked surfaces.
    if (!targetExists && ledgerSnapshot) {
        const relativePathPosix = entryRelativePath.split(path.sep).join('/');
        if ((relativePathPosix.startsWith('skills/')
                || relativePathPosix.startsWith('workflows/')
                || relativePathPosix.startsWith('protocols/'))
            && ledgerSnapshot.has(relativePathPosix)) {
            continue;
        }
    }
    // ... existing copy logic ...
```

Thread the snapshot through the recursive self-call (line 1069):

```typescript
written += await this._copyDirectoryRecursive(sourcePath, targetPath, options, entryRelativePath, ledgerSnapshot);
```

### 3. `_bootstrapControlPlaneLayout` — read the ledger and pass it through (src/services/ControlPlaneMigrationService.ts:701–710)

```typescript
const bundledAgentDir = path.join(extensionPath, BUNDLED_AGENT_DIR);
let agentsChanged = false;
if (fs.existsSync(bundledAgentDir)) {
    // Deletion guard: read the bundle ledger before copying.
    const ledgerRaw = this.readBundleLedger(parentDir);
    const ledgerSnapshot = new Set<string>(ledgerRaw ?? []);
    const written = await this._copyDirectoryRecursive(
        bundledAgentDir,
        path.join(parentDir, '.agents'),
        { overwrite: false, overwriteIfDiffers: true },
        '',
        ledgerSnapshot,
    );
    agentsChanged = written > 0;
}
```

### 4. `seedBundleSurface` — extend the surface type to `protocols` (src/services/ControlPlaneMigrationService.ts:1236–1241)

This widens the `surface` type union. The `deletionSkipped` return field is introduced by the sibling plan (*claude-mirror-not-regenerating-on-deletion*); this plan assumes it already exists and only adds `'protocols'` to the surface type:

```typescript
public static async seedBundleSurface(
    surface: 'skills' | 'workflows' | 'protocols',
    bundleDir: string,
    workspaceRoot: string,
    ledgerSnapshot: Set<string>,
): Promise<{ changed: boolean; files: string[]; deletionSkipped: boolean }> {
```

### 5. `refreshWorkspaceControlPlane` — add the protocols seed call + reconcile (src/extension.ts:344–401)

This is the reconciled block that combines the sibling plan's `deletionRespected` branch with this plan's protocols seed call. If the sibling plan has already landed, edit the existing block; the end-state is:

```typescript
const skillResult = await ControlPlaneMigrationService.seedBundleSurface(
    'skills', path.join(bundledAgentsPath, 'skills'), root, ledgerSnapshot);
const workflowResult = await ControlPlaneMigrationService.seedBundleSurface(
    'workflows', path.join(bundledAgentsPath, 'workflows'), root, ledgerSnapshot);
const protocolResult = await ControlPlaneMigrationService.seedBundleSurface(
    'protocols', path.join(bundledAgentsPath, 'protocols'), root, ledgerSnapshot);
const agentsChanged = skillResult.changed || workflowResult.changed || protocolResult.changed;
const deletionRespected =
    skillResult.deletionSkipped || workflowResult.deletionSkipped || protocolResult.deletionSkipped;
const skillFiles = skillResult.files;
const workflowFiles = workflowResult.files;
const protocolFiles = protocolResult.files;
```

The scaffold gate (`if (needsAgentRefresh || agentsChanged) { ... } else if (deletionRespected) { ... }`) is owned by the sibling plan and is unchanged by this plan — `deletionRespected` now also reflects a respected protocol deletion, which correctly triggers the `.claude/` mirror regen (a protocol deletion does not mirror, but the scaffold is idempotent and the skills mirror cleanup still runs).

Add protocols to the bundle-reconcile step (line 399–401):

```typescript
const currentBundlePaths = new Set<string>();
for (const rel of skillFiles) currentBundlePaths.add('skills/' + rel.split(path.sep).join('/'));
for (const rel of workflowFiles) currentBundlePaths.add('workflows/' + rel.split(path.sep).join('/'));
for (const rel of protocolFiles) currentBundlePaths.add('protocols/' + rel.split(path.sep).join('/'));
```

### 6. `pruneRetiredBundleFiles` — add protocols to the drift scope (src/services/ControlPlaneMigrationService.ts:1387)

```typescript
const scopes = ['skills', 'workflows', 'protocols'];
```

### 7. Superseded approach — do NOT skip protocols in the whole-tree copy paths

> **Superseded:** Skip `protocols/` files in `performSetup` and `_copyDirectoryRecursive` since the seed loop (`seedBundleSurface`) now handles them — `if (relativePath.startsWith('protocols' + path.sep)) continue;`.
>
> **Reason:** `performSetup` is the Setup-button whole-tree copy path — it does NOT call `seedBundleSurface` or `refreshWorkspaceControlPlane`. Skipping protocols there strands them on the Setup path: the user clicks "Set Up Control Plane" and protocols are never copied (the seed loop that the skip defers to runs on activation, not on the setup button). The same defect applies to `_copyDirectoryRecursive` when reached from `npx switchboard init` — bootstrap is a standalone init path that does not run the activation seed loop. The skip optimizes for a redundancy that the guard already prevents (an in-ledger absent protocol is skipped by the guard; a present protocol is not overwritten; a genuinely-new protocol is copied) while introducing a starvation bug on two copy paths.
>
> **Replaced with:** Extend the ledger guard scope to `protocols/` on all three copy paths (§1, §2, §4). The guard condition `startsWith('skills/') || startsWith('workflows/') || startsWith('protocols/')` is the single mechanism that both prevents redundant copies AND protects protocol retirements, with no starvation risk.

## Verification Plan

1. **Unit test (performSetup guard):** Create a temp workspace, seed it with the bundle, delete a skill file, record the ledger, then run `performSetup` — assert the deleted skill is NOT restored.
2. **Unit test (bootstrap guard):** Same setup, run `_bootstrapControlPlaneLayout` — assert the deleted skill is NOT restored.
3. **Unit test (fresh workspace, no starvation):** Fresh workspace (no ledger) — run both `performSetup` and `_bootstrapControlPlaneLayout` — assert all bundle files (skills, workflows, protocols) are copied.
4. **Unit test (untracked surface unaffected):** Delete a `personas/` file — run both paths — assert it IS restored (personas are not ledger-tracked; expected until a future plan extends the ledger).
5. **Unit test (protocols ledger):** Seed a workspace with the bundle via `refreshWorkspaceControlPlane` — assert all 32 protocol files are copied and the ledger contains `protocols/<name>/SKILL.md` entries.
6. **Unit test (protocols prune):** Remove a protocol from the bundle, run activation — assert the protocol file is pruned from the workspace's `.agents/protocols/`.
7. **Unit test (protocols deletion guard):** Delete a protocol from the workspace, run activation — assert it is NOT re-copied (deletion guard), on all three copy paths.
8. **Unit test (drift log):** Run activation with a missing protocol — assert the drift log line includes protocols in its `extra` count.
9. **Manual test:** Run `npx switchboard init` twice after deleting a skill — assert the skill stays deleted on the second run.

### Goal Invariants

- After `performSetup` with a ledger-tracked skill/workflow/protocol deleted from `.agents/`, the deleted file is ABSENT from `.agents/<surface>/` (negative — not resurrected by the setup path).
- After `_bootstrapControlPlaneLayout` with a ledger-tracked skill/workflow/protocol deleted, the deleted file is ABSENT from `.agents/<surface>/` (negative — not resurrected by the init path).
- After `refreshWorkspaceControlPlane` on a workspace whose bundle ships protocols, every `protocols/<name>/SKILL.md` present in the bundle is RESOLVABLE at `.agents/protocols/<name>/SKILL.md` (positive — no starvation on the activation path).
- After `refreshWorkspaceControlPlane` on a fresh workspace (no ledger), the count of `protocols/` entries in the bundle ledger equals the count of protocol files shipped by the bundle.
- The `seedBundleSurface` symbol in `ControlPlaneMigrationService.ts` accepts `'protocols'` as a `surface` argument (type-union member resolvable).
- The `pruneRetiredBundleFiles` scopes array in `ControlPlaneMigrationService.ts` contains `'protocols'`.
- A `personas/` file deleted from `.agents/` IS restored by `performSetup` (untracked surface — confirms the guard scope does not over-reach).

## Outstanding Questions

- **[user]** The `_bootstrapControlPlaneLayout` path (ControlPlaneMigrationService.ts:741) gates `generateClaudeMirror` on `needsAgentMigration || agentsChanged` — the same pattern the sibling plan fixes in the activation path. After this plan threads the deletion guard into bootstrap, a deletion respected on the `npx switchboard init` path skips re-copy but does NOT trigger mirror regen, stranding the stale `.claude/` entry. Should bootstrap receive a `deletionRespected` signal too? — proceeding on the assumption that this is a follow-up, not part of this plan, because bootstrap is init-oriented and the recurring activation path is the one that hits existing workspaces.

## Recommendation

**Complexity 6 → Send to Coder.** Six touch points across two files, all extending one proven pattern (the `seedBundleSurface` ledger guard). The only design decision (guard-scope vs skip-protocols) is resolved in favor of the guard scope (see Superseded callout). Ship AFTER the sibling plan (*claude-mirror-not-regenerating-on-deletion*) so the `deletionSkipped` flag exists when this plan widens the surface type and wires `protocolResult.deletionSkipped` into `deletionRespected`.
