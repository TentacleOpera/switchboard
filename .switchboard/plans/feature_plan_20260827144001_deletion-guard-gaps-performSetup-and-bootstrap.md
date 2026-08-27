# Deletion guard gaps: performSetup and _bootstrapControlPlaneLayout restore retired .agents files

## Goal

The `.agents/` deletion guard — which prevents a workspace's deliberate file retirement from being silently undone — only covers the activation seed loop (`refreshWorkspaceControlPlane` → `seedBundleSurface`). Two other creation paths copy files unconditionally with no ledger check:

1. **`performSetup`** (extension.ts:4341–4474) — the Setup tab's "Set Up Control Plane" button. It crawls the entire bundled `.agents/` tree and copies every file via content-hash logic, but never consults the bundle ledger on the creation path (dest absent). A file the workspace deliberately deleted gets re-copied because `dest absent → copy new file` (line 4411–4413) has no ledger gate.

2. **`_bootstrapControlPlaneLayout` → `_copyDirectoryRecursive`** (ControlPlaneMigrationService.ts:677–710, 1055–1103) — reached by `npx switchboard init` and the control-plane migration flows. `_copyDirectoryRecursive` copies files with `overwrite: false` / `overwriteIfDiffers: true`, but when the target doesn't exist it copies unconditionally (line 1088–1090: `else if (targetExists) { continue; }` — the absent case falls through to copy). No ledger snapshot is read or consulted.

**Root cause:** The deletion guard was added only to `seedBundleSurface`, which is the activation-path seed function. The two whole-tree copy paths predate the guard and were never updated to consult the ledger. Since `npx switchboard init` is explicitly documented as safe to re-run, re-running it silently undoes any workspace retirement.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Reading the bundle ledger is already implemented (`readBundleLedger`).
- The guard pattern (check ledger on dest-absent, skip if in-ledger) is already proven in `seedBundleSurface`.
- Both copy paths are well-isolated functions.

**Complex/Risky:**
- `performSetup` copies the ENTIRE `.agents/` tree (skills, workflows, protocols, personas), not just `skills/` and `workflows/`. The ledger currently only tracks `skills/` and `workflows/`. Extending the guard to protocols requires either extending the ledger or scoping the guard to the two tracked surfaces.
- `_copyDirectoryRecursive` is a private static method with no access to the ledger snapshot — it would need the snapshot threaded through as a parameter, changing its signature and all call sites.
- The `performSetup` path uses `vscode.workspace.fs` while `_copyDirectoryRecursive` uses `fs.promises` — the ledger check must work in both APIs.

## Edge-Case & Dependency Audit

- **First-run (no ledger):** `readBundleLedger` returns `null` → empty set → all absent files copied (fresh workspace not starved). Already handled by the existing pattern.
- **Ledger scope mismatch:** The ledger tracks `skills/<rel>` and `workflows/<rel>` only. `performSetup` copies `protocols/`, `personas/`, `rules/` too. The guard must either (a) only apply to skills/workflows (leaving protocols unguarded — see Issue 3) or (b) extend the ledger to all surfaces. Option (a) is the minimal fix; (b) is a separate plan.
- **`_copyDirectoryRecursive` call sites:** Called from `_bootstrapControlPlaneLayout` (line 704) and recursively from itself (line 1069). The ledger snapshot must be threaded through the recursive calls.
- **Migration flows:** `_mergeSharedAgentContent` calls `_bootstrapControlPlaneLayout` (line 869). The guard must not block legitimate migration copies into a fresh control plane.
- **Blocklist interaction:** `performSetup` has a separate blocklist step (line 4426–4456) that deletes specific files. The guard and blocklist are independent — the guard prevents re-creation, the blocklist forces deletion.

## Proposed Changes

### 1. `performSetup` (src/extension.ts:4357–4418)

Read the bundle ledger before the copy loop and skip in-ledger absent files:

```typescript
// 2. Discover and Copy .agents assets (Recursive & Depth-Limited)
const agentSourceUri = vscode.Uri.joinPath(extensionUri, '.agents');
const agentFiles = await crawlDirectory(agentSourceUri);

// Deletion guard: read the bundle ledger once before the copy loop.
// In-ledger AND absent = workspace deliberately deleted → skip.
// Not-in-ledger AND absent = genuinely new → copy.
// null/empty ledger → all absent files copied (fresh workspace not starved).
const ledgerRaw = ControlPlaneMigrationService.readBundleLedger(workspaceRoot);
const ledgerSnapshot = new Set<string>(ledgerRaw ?? []);
```

Then in the dest-absent branch (line 4410–4417), add the ledger check:

```typescript
} catch {
    // dest absent → check ledger before copying (deletion guard).
    // Only skills/ and workflows/ are ledger-tracked; other surfaces
    // (protocols/, personas/) are always copied when absent.
    const relativePathPosix = relativePath.split(path.sep).join('/');
    const isLedgerTracked = relativePathPosix.startsWith('skills/') || relativePathPosix.startsWith('workflows/');
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

### 2. `_copyDirectoryRecursive` (src/services/ControlPlaneMigrationService.ts:1055–1103)

Add an optional `ledgerSnapshot` parameter and consult it on the dest-absent path:

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
    // Deletion guard: skip in-ledger absent files for skills/ and workflows/.
    if (!targetExists && ledgerSnapshot) {
        const relativePathPosix = entryRelativePath.split(path.sep).join('/');
        if ((relativePathPosix.startsWith('skills/') || relativePathPosix.startsWith('workflows/'))
            && ledgerSnapshot.has(relativePathPosix)) {
            continue;
        }
    }
    // ... existing copy logic ...
```

Thread the snapshot through the recursive call (line 1069):

```typescript
written += await this._copyDirectoryRecursive(sourcePath, targetPath, options, entryRelativePath, ledgerSnapshot);
```

### 3. `_bootstrapControlPlaneLayout` (src/services/ControlPlaneMigrationService.ts:677–710)

Read the ledger and pass it to `_copyDirectoryRecursive`:

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

## Verification Plan

1. **Unit test:** Create a temp workspace, seed it with the bundle, delete a skill file, record the ledger, then run `performSetup` — assert the deleted file is NOT restored.
2. **Unit test:** Same setup, run `_bootstrapControlPlaneLayout` — assert the deleted file is NOT restored.
3. **Unit test:** Fresh workspace (no ledger) — run both paths — assert all bundle files are copied (no starvation).
4. **Unit test:** Delete a `protocols/` file — run both paths — assert it IS restored (protocols are not ledger-tracked yet; this is the expected behavior until Issue 3 is fixed).
5. **Manual test:** Run `npx switchboard init` twice after deleting a skill — assert the skill stays deleted on the second run.
