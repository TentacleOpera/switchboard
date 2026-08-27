# .agents/protocols/ has no ledger, drift line, or retirement mechanism

## Goal

The `.agents/protocols/` directory — containing 32 relocated protocol files — is delivered ONLY by the whole-tree copy paths (`performSetup` and `_bootstrapControlPlaneLayout` → `_copyDirectoryRecursive`). The activation seed loop (`seedBundleSurface`) and the bundle-ledger prune (`pruneRetiredBundleFiles`) are both scoped to `skills/` and `workflows/` only.

This means the 32 protocol files have:
- **No ledger entry:** The bundle ledger (`readBundleLedger`) only records `skills/<rel>` and `workflows/<rel>` paths. `protocols/<rel>` is never written to the ledger.
- **No drift line:** The activation log's drift counts (missing/extra/pruned) only scan `skills/` and `workflows/` (line 1387: `const scopes = ['skills', 'workflows']`).
- **No retirement mechanism:** `pruneRetiredBundleFiles` only deletes files that were previously in the ledger. Since protocols are never in the ledger, a protocol file removed from the bundle strands in every workspace forever.

**Root cause:** The protocols directory was relocated from `.agents/skills/` (where it would have been covered by the existing surface) to `.agents/protocols/` (a new top-level surface), but the seed/prune/ledger machinery was never extended to cover the new surface.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- The `seedBundleSurface` function already handles a generic `surface` parameter — it's called with `'skills'` and `'workflows'`. Adding `'protocols'` is a third call.
- The `pruneRetiredBundleFiles` scope list (line 1387) is a simple array — adding `'protocols'` is one line.
- The ledger writer (line 1411) takes `currentBundlePaths` which is built by the caller — adding protocols paths is a caller-side change.

**Complex/Risky:**
- Protocols are structured differently from skills: each protocol is a directory with a `SKILL.md` inside (e.g., `protocols/dispatch-analysis/SKILL.md`), not a flat `.md` file. The crawl must handle nested directories.
- `seedBundleSurface` crawls with `_crawlRelative` which already handles directories recursively. The ledger key format (`protocols/<rel>`) must match what the prune resolves.
- The `performSetup` and `_copyDirectoryRecursive` paths already copy protocols (they copy the whole tree). Adding protocols to the seed loop means protocols are now copied by BOTH the seed loop AND the whole-tree copy. The seed loop's content-hash logic is more precise (it checks the ledger), so the whole-tree copy should skip protocols to avoid duplication — or the seed loop should run first and the whole-tree copy should be the fallback.

## Edge-Case & Dependency Audit

- **Nested directory structure:** `protocols/dispatch-analysis/SKILL.md` → ledger key `protocols/dispatch-analysis/SKILL.md`. The `_crawlRelative` function returns `path.sep`-joined paths; the ledger key conversion (`split(path.sep).join('/')`) already handles this.
- **Blocklist interaction:** The `AGENT_COPY_BLOCKLIST` (line 1045–1048) uses `entryRelativePath` which is built from `basePath` — protocols paths would be `protocols/<name>/SKILL.md`. No blocklisted protocols exist today, but the mechanism must work if one is added.
- **Deletion guard interaction:** Once protocols are ledger-tracked, the deletion guard (Issue 1) would also protect protocol retirements. This is correct and desirable.
- **Mirror interaction:** `generateClaudeMirror` scans `.agents/skills/` for `switchboard-*.md` files (line 353). Protocols are not mirrored to `.claude/` — they're consumed in-place by the agent. No mirror change needed.
- **First-run:** No ledger → protocols copied normally (fresh workspace not starved). The ledger is seeded for the next run.

## Proposed Changes

### 1. Add protocols to the seed loop (src/extension.ts:352–358)

```typescript
const skillResult = await ControlPlaneMigrationService.seedBundleSurface(
    'skills', path.join(bundledAgentsPath, 'skills'), root, ledgerSnapshot);
const workflowResult = await ControlPlaneMigrationService.seedBundleSurface(
    'workflows', path.join(bundledAgentsPath, 'workflows'), root, ledgerSnapshot);
const protocolResult = await ControlPlaneMigrationService.seedBundleSurface(
    'protocols', path.join(bundledAgentsPath, 'protocols'), root, ledgerSnapshot);
const agentsChanged = skillResult.changed || workflowResult.changed || protocolResult.changed;
const skillFiles = skillResult.files;
const workflowFiles = workflowResult.files;
const protocolFiles = protocolResult.files;
```

### 2. Add protocols to the bundle-reconcile step (src/extension.ts:407–409)

```typescript
const currentBundlePaths = new Set<string>();
for (const rel of skillFiles) currentBundlePaths.add('skills/' + rel.split(path.sep).join('/'));
for (const rel of workflowFiles) currentBundlePaths.add('workflows/' + rel.split(path.sep).join('/'));
for (const rel of protocolFiles) currentBundlePaths.add('protocols/' + rel.split(path.sep).join('/'));
```

### 3. Add protocols to the prune scope (src/services/ControlPlaneMigrationService.ts:1387)

```typescript
const scopes = ['skills', 'workflows', 'protocols'];
```

### 4. Update the `seedBundleSurface` type signature (src/services/ControlPlaneMigrationService.ts:1237)

```typescript
public static async seedBundleSurface(
    surface: 'skills' | 'workflows' | 'protocols',
    bundleDir: string,
    workspaceRoot: string,
    ledgerSnapshot: Set<string>,
): Promise<{ changed: boolean; files: string[]; deletionSkipped: boolean }> {
```

### 5. Skip protocols in the whole-tree copy paths

In `performSetup` (extension.ts:4367), skip `protocols/` files since the seed loop now handles them:

```typescript
for (const relativePath of agentFiles) {
    // Protocols are seeded by the seedBundleSurface loop in refreshWorkspaceControlPlane;
    // skip them here to avoid a redundant copy that bypasses the ledger guard.
    if (relativePath.startsWith('protocols' + path.sep)) continue;
    // ... existing copy logic ...
}
```

In `_copyDirectoryRecursive` (ControlPlaneMigrationService.ts:1064–1070), add a similar skip when called from `_bootstrapControlPlaneLayout` — or thread the ledger snapshot (per Issue 1's fix) so the guard applies.

## Verification Plan

1. **Unit test:** Seed a workspace with the bundle — assert all 32 protocol files are copied and the ledger contains `protocols/<name>/SKILL.md` entries.
2. **Unit test:** Remove a protocol from the bundle, run activation — assert the protocol file is pruned from the workspace's `.agents/protocols/`.
3. **Unit test:** Delete a protocol from the workspace, run activation — assert it is NOT re-copied (deletion guard).
4. **Unit test:** Fresh workspace (no ledger) — run activation — assert all protocols are copied (no starvation).
5. **Drift log test:** Run activation with a missing protocol — assert the drift log line includes protocols in its counts.
