# Fix Cross-Workspace Brain File Contamination

## Problem Summary

When two IDEs are open simultaneously on different workspaces, brain files from one workspace are incorrectly mirrored into the other workspace's `.switchboard/plans/` directory. This causes plans from unrelated projects to appear in the kanban board and plan dropdowns.

### Root Cause

The brain directory (`~/.gemini/antigravity/brain/`) is a **shared global directory** across all workspaces. The current mirroring logic (`_mirrorBrainPlan` in TaskViewerProvider.ts) only checks:
1. If the plan is already in the local registry (eligibility check)
2. If the plan can be auto-claimed within a 15-second window

**Missing**: Content validation to verify the brain file actually belongs to the current workspace before mirroring.

### Example Contamination Flow

1. User opens IDE A on workspace `/patrickwork`
2. User opens IDE B on workspace `/switchboard`
3. IDE A creates a brain file with content referencing `/patrickwork/designs/index.html`
4. IDE B's brain watcher detects the file, wins the claim race (or file is older than claim window)
5. IDE B mirrors the file to `.switchboard/plans/brain_<hash>.md`
6. Database accepts it, plan appears in switchboard's kanban

## Solution: Content-Based Workspace Validation

Validate brain file content before mirroring to ensure it references paths within the current workspace.

### Validation Strategy

Extract and check file paths from brain file content:
- Look for `file:///` references in the plan content
- Check `**Repo:**` metadata if present
- Verify at least one referenced path is within the current workspace root
- Reject the mirror if content clearly belongs to a different workspace

### Implementation

#### 1. Add Content Validation Method

Location: `src/services/TaskViewerProvider.ts`

```typescript
/**
 * Validates that brain file content belongs to this workspace.
 * Checks for file path references and repo metadata.
 */
private _isBrainContentRelevantToWorkspace(content: string, workspaceRoot: string): boolean {
    // Extract file:// references from content
    const fileRefs = content.match(/file:\/\/[^\s\)]+/g) || [];
    
    // Check if any referenced path is within current workspace
    for (const ref of fileRefs) {
        try {
            const filePath = decodeURIComponent(ref.replace('file://', ''));
            if (this._isPathWithin(workspaceRoot, filePath)) {
                return true;
            }
        } catch {
            // Invalid URI, skip
        }
    }
    
    // Check Repo metadata if present
    const repoMatch = content.match(/\*\*Repo:\*\*\s*(.+)/i);
    if (repoMatch) {
        const repoValue = repoMatch[1].trim();
        // If repo is explicitly set and doesn't match workspace name, reject
        const workspaceName = path.basename(workspaceRoot);
        if (repoValue && repoValue !== workspaceName) {
            return false;
        }
    }
    
    // If no clear workspace indicators found, default to true (be permissive)
    // This handles brain files that don't yet have file references
    return true;
}
```

#### 2. Integrate Validation in `_mirrorBrainPlan`

Location: `src/services/TaskViewerProvider.ts:9915-9927`

Add validation right after reading content:

```typescript
const content = await fs.promises.readFile(brainFilePath, 'utf8');

// NEW: Validate brain file belongs to this workspace
if (!this._isBrainContentRelevantToWorkspace(content, resolvedWorkspaceRoot)) {
    console.log(`[TaskViewerProvider] Skipping brain file from different workspace: ${path.basename(brainFilePath)}`);
    return;
}
```

#### 3. Also Apply to Staging Directory Watcher

Location: `src/services/TaskViewerProvider.ts:7444-7487`

The mirror → brain sync direction should also validate on read-back:

```typescript
// In the staging watcher callback, before syncMirrorToBrain:
const content = await fs.promises.readFile(mirrorPath, 'utf8');
if (!this._isBrainContentRelevantToWorkspace(content, workspaceRoot)) {
    console.log(`[TaskViewerProvider] Skipping mirror sync for different workspace: ${filename}`);
    return;
}
```

## Files to Modify

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`
  - Add `_isBrainContentRelevantToWorkspace()` method (around line 8876, near `_isPlanEligibleForWorkspace`)
  - Modify `_mirrorBrainPlan()` to call validation (line ~9917)
  - Modify staging watcher callback to validate on mirror → brain sync (line ~7452)

## Verification Plan

### Unit Tests

Create test in `src/test/`:

```typescript
describe('Brain Content Workspace Validation', () => {
    it('should accept brain files with matching file references', () => {
        const content = '### [file](file:///Users/patrickwork/src/index.ts)';
        expect(isContentRelevant(content, '/patrickwork')).toBe(true);
    });
    
    it('should reject brain files with only foreign file references', () => {
        const content = '### [file](file:///Users/otherproject/src/index.ts)';
        expect(isContentRelevant(content, '/myproject')).toBe(false);
    });
    
    it('should handle mixed paths when at least one matches', () => {
        const content = 'Files: file:///Users/myproject/a.ts file:///Users/other/b.ts';
        expect(isContentRelevant(content, '/myproject')).toBe(true);
    });
    
    it('should accept files without any file references (permissive default)', () => {
        const content = '# Simple Plan\nNo file references here.';
        expect(isContentRelevant(content, '/myproject')).toBe(true);
    });
});
```

### Manual Testing

1. Open two VS Code windows on different workspaces
2. Create a plan in workspace A
3. Verify it does NOT appear in workspace B's plan dropdown
4. Check console logs for "Skipping brain file from different workspace" message

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| False positives (rejecting valid workspace files) | Be permissive: if no clear workspace indicators, accept the file. Only reject when we have evidence it belongs elsewhere |
| Files with no file references get auto-accepted | These are likely new/empty plans, which is acceptable behavior |
| Performance impact of path parsing | File content is already being read; we're just adding a regex match and path comparison |
| Breaking existing cross-workspace plan sharing | This is intentional - cross-workcase sharing should be explicit, not automatic via brain contamination |

## Rollback Plan

If issues arise:
1. Revert the validation call sites in `_mirrorBrainPlan` and staging watcher
2. Keep the helper method (it's harmless if not called)
3. Or add a feature flag: `switchboard.enableBrainContentValidation` setting

## Metadata

**Complexity:** Medium  
**Tags:** brain-mirror, workspace-scoping, kanban  
**Dependencies:** None  
**Repo:** switchboard
