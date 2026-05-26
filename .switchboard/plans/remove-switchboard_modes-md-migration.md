---
description: Remove obsolete switchboard_modes.md file from all user workspaces
---

# Remove switchboard_modes.md Migration

## Context

The `.agent/rules/switchboard_modes.md` file is outdated by the new prompts builder system. It describes command-based mode triggers (`/accuracy`, `/chat`, `/handoff`) that are no longer the primary mechanism for activating these behaviors. The prompts tab now uses checkboxes to inject instructions directly.

**Current state:**
- `switchboard_modes.md` exists in user workspaces
- `accuracy.md` workflow references it for persona guidance (line 22)
- No other code or workflows use it
- The prompts builder doesn't enforce these mode rules

**Problem:**
- The file creates confusion about how modes are activated
- The "NON-NEGOTIABLE LAWS" language conflicts with the optional prompts tab checkboxes
- Users will have this file in their workspaces after upgrading

## Solution

Remove `switchboard_modes.md` from all user workspaces via extension migration logic.

## Implementation Steps

### 1. Remove reference from accuracy.md workflow

**File:** `.agent/workflows/accuracy.md`

**Change:** Remove line 22:
```diff
-   - Read `.agent/rules/switchboard_modes.md` for the "Lead Engineer" persona.
```

**Rationale:** The workflow is comprehensive without the persona. The persona only adds tone guidance (no apologies, no filler) which is not critical to the accuracy verification process.

**Status:** ⚠️ PENDING - This change must be made to the workflow file in the switchboard repo.

### 2. Add migration logic to extension.ts

**File:** `src/extension.ts`

**Location:** Add to the existing migration/cleanup logic (around line 2561 where `no_git_for_agents.md` is removed)

**Implementation:**
```typescript
// Remove obsolete switchboard_modes.md from all workspaces
const obsoleteRulesFiles = [
    '.agent/rules/switchboard_modes.md',
];
for (const relativePath of obsoleteRulesFiles) {
    const fullPath = path.join(workspaceRoot, relativePath);
    try {
        await fs.promises.access(fullPath);
        await fs.promises.unlink(fullPath);
        outputChannel?.appendLine(`[Switchboard] Removed obsolete rule file: ${relativePath}`);
    } catch {
        // File does not exist or cannot be removed — non-fatal
    }
}
```

**Alternative approach:** Add to the blocklist logic used for control plane migration (around line 2673).

### 3. Update extension version

Increment the extension version in `package.json` to trigger the migration for existing users.

### 4. Test migration

**Test cases:**
- Workspace with `switchboard_modes.md` present → file should be deleted
- Workspace without `switchboard_modes.md` → no error
- Verify `accuracy.md` workflow still works without the reference
- Verify prompts tab functionality unchanged

## Files Changed

1. `.agent/workflows/accuracy.md` - Remove persona reference
2. `src/extension.ts` - Add migration cleanup logic
3. `package.json` - Version bump

## Validation

- After upgrade, user workspaces should not contain `.agent/rules/switchboard_modes.md`
- The `/accuracy` workflow should execute successfully without the persona reference
- Prompts tab accuracy checkbox should continue to work as before

## Rollback Plan

If issues arise:
- Revert `accuracy.md` to restore the persona reference
- Remove the migration logic from `extension.ts`
- Users can manually restore the file if needed (but this is unlikely to be necessary)
