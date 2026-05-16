# Eliminate Spurious Registry Warning on Managed-Import Completion

## Goal

Eliminate the spurious warning logged when completing managed-import plans. The `_updatePlanRegistryStatus(pathHash, 'completed')` call is a guaranteed no-op for managed imports because the registry entry uses `sessionId` as the key, not `pathHash`.

## Metadata

- **Tags:** frontend, code-hygiene, logging
- **Complexity:** 2

## User Review Required

No

## Complexity Audit

### Routine

- Single-file change (`TaskViewerProvider.ts`).
- Simple conditional to skip the pathHash registry update for managed imports.
- No logic changes to the actual registry update (that still happens with `sessionId`).

### Complex / Risky

- None. The pathHash registry update is a no-op for managed imports; skipping it has no functional impact.

## Edge-Case & Dependency Audit

- **Race Conditions**: None.
- **Security**: No security implications; changes are localized to completion flow.
- **Side Effects**: None — only affects logging.
- **Dependencies & Conflicts**: None.

## Dependencies

None

## Adversarial Synthesis

Key risk: If we gate the pathHash registry update on `!isManagedImport`, we need to ensure `isManagedImport` is computed BEFORE the `if (originalBrainPath)` block. Currently, `isManagedImport` is computed AFTER the pathHash registry update. We need to move the `isManagedImport` computation earlier, or duplicate the check.

Simplest approach: Compute `isManagedImport` before the `if (originalBrainPath)` block and use it to gate the pathHash registry update.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### `_handleCompletePlan` (line ~12300)

- **Context**: The `isManagedImport` check at line 12349 uses the same logic as the managed import block. The pathHash registry update at line 12341 is a no-op for managed imports and logs a warning.
- **Logic**: Compute `isManagedImport` BEFORE the `if (originalBrainPath)` block. Gate the pathHash registry update on `!isManagedImport`.
- **Implementation**:

```typescript
// After line 12307 (after getting the sheet):

// Compute this early to gate the pathHash registry update
const isManagedImport = sheet?.source === 'managed-import' ||
    (sheet?.planFile && /^ingested_[0-9a-f]{64}\.md$/i.test(path.basename(sheet.planFile)));

// In the if (originalBrainPath) block (line 12330-12341):
if (originalBrainPath) {
    const stablePath = this._getStablePath(this._getBaseBrainPath(originalBrainPath));
    const archived = this._context.workspaceState.get<string[]>('switchboard.archivedBrainPaths', []);
    if (!archived.includes(stablePath)) {
        await this._context.workspaceState.update(
            'switchboard.archivedBrainPaths', [...archived, stablePath]
        );
    }
    const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
    await this._addTombstone(resolvedWorkspaceRoot, pathHash);
    // Skip pathHash registry update for managed imports (registry uses sessionId as key)
    if (!isManagedImport) {
        await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'completed');
    }
} else {
    // Local plan: use sessionId as planId
    await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'completed');
}

// Remove the duplicate isManagedImport computation at line 12349 (now computed earlier)
// The managed import block at line 12351-12371 can use the already-computed isManagedImport
```

## Verification Plan

### Manual Tests

1. Complete a managed-import plan.
2. **Expected**: No warning logged about "no registry entry found for planId=<pathHash>".
3. Complete a brain plan (non-managed-import).
4. **Expected**: Registry still updates correctly with pathHash for brain plans; no functional change.
5. Complete a local plan (no brainSourcePath).
6. **Expected**: Registry updates correctly with sessionId; no functional change.

## Files to Modify

1. `src/services/TaskViewerProvider.ts`
   - `_handleCompletePlan` — compute `isManagedImport` early, gate pathHash registry update on `!isManagedImport`, remove duplicate computation

## Risks

- **Very low**: The pathHash registry update is a no-op for managed imports; skipping it has no functional impact. The managed import block still calls `_updatePlanRegistryStatus(sessionId, 'completed')` which is the correct update.

---

**Recommendation:** Send to Coder. Complexity is 2 — trivial code hygiene fix with negligible risk.
