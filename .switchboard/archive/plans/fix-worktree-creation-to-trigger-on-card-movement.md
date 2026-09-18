# Fix Worktree Creation to Trigger on Card Movement to Coder Columns

## Goal
Move worktree creation from terminal dispatch time to card-movement time, and convert the worktree toggle from a global agents-tab setting to a per-role prompt addon defaulting to OFF.

## Summary
Worktree creation currently only happens during terminal dispatch and is configured in the agents tab. This is incorrect. Worktrees should be created when a plan is moved to any coder column (LEAD CODED, CODER CODED, INTERN CODED), regardless of dispatch method. The worktree option should be a prompt addon for coder roles (lead, coder, intern) and custom agents, defaulting to OFF.

## Problem
Current implementation has two issues:

1. **Wrong trigger location**: Worktree creation is tied to terminal dispatch (`_dispatchExecuteMessage` line 14533-14549) instead of card movement to coder columns
2. **Wrong configuration location**: Worktree option is in agents tab instead of being a prompt addon for coder roles

**Intended behavior:**
- Worktree should be created when the plan moves to LEAD CODED, CODER CODED, or INTERN CODED
- Worktree option should be a prompt addon for coder roles (lead, coder, intern) and custom agents
- Default to OFF for all roles
- If enabled for any role, worktree functionality activates for that role's dispatches
- All work on plans in coder columns should happen in the worktree (if enabled for that role)

## Metadata
- **Tags:** [workflow, reliability]
- **Complexity:** 6

## User Review Required
- Confirm that worktree cleanup should remain on reviewer-pass completion (existing behavior), NOT on column exit. Moving cleanup to column exit would destroy the worktree before the reviewer can see the code.
- Confirm that custom agent columns with `useWorktree` enabled should also trigger worktree creation.

## Complexity Audit

### Routine
- Remove worktree checkbox from agents tab HTML (kanban.html lines 2135-2140)
- Remove `gitWorktreesEnabled` from `agentsTabCollectConfig` (kanban.html lines 2903-2917)
- Remove `gitWorktreesEnabled` hydration in message handler (kanban.html lines 5374-5378)
- Remove `getGitWorktreesEnabled` from KanbanProvider (lines 2217-2220)
- Remove `gitWorktreesEnabled` from `_getStartupCommands` return (lines 2200-2215)
- Remove `gitWorktreesEnabled` from `_saveStartupCommands` (lines 2227-2244)
- Remove `_getGitWorktreesEnabled` from TaskViewerProvider (lines 16913-16916)
- Add `useWorktree` addon entry to `ROLE_ADDONS` in sharedDefaults.js for lead, coder, intern
- Add `useWorktree: false` to `DEFAULT_ROLE_CONFIG.addons` for lead, coder, intern
- Remove worktree creation block from `_dispatchExecuteMessage` (lines 14533-14574)
- Add worktree-path lookup in `_dispatchExecuteMessage` (read existing metadata, don't create)

### Complex / Risky
- Unifying column movement through `KanbanProvider.moveCardToColumn` as single entry point — `_updateKanbanColumnForSession` (TaskViewerProvider line 1704) currently bypasses it with direct `db.updateColumn()` calls from 7 call sites
- Capturing previous column BEFORE DB update for correct cleanup detection
- Reading per-role `useWorktree` addon from VS Code workspace state (via `getRoleConfig`) rather than state.json
- Ensuring worktree creation completes before dispatch reads metadata (timing dependency between card movement and terminal dispatch)

## Edge-Case & Dependency Audit

**Race Conditions:**
- Card movement → worktree creation → dispatch must be sequential. If `_updateKanbanColumnForSession` bypasses `moveCardToColumn`, dispatch won't find worktree metadata. Fix: make all column updates go through `KanbanProvider.moveCardToColumn`.
- Multiple rapid card moves for the same session could trigger duplicate worktree creation. Mitigation: existing `_createWorktree` already handles branch/path collisions, and `getWorktreeMeta` check prevents re-creation.

**Security:**
- Worktree paths are constructed from sessionId with sanitization (`replace(/[^a-zA-Z0-9_-]/g, '-')`). No new attack surface.
- `useWorktree` addon value comes from VS Code workspace state which is user-controlled but local-only.

**Side Effects:**
- Auto-commit before worktree creation modifies git state (existing behavior, not new).
- Removing global `gitWorktreesEnabled` from state.json is a breaking change for existing configs. Migration: on next save, the field is simply ignored.

**Dependencies & Conflicts:**
- The `mergeWorktrees` flow (KanbanProvider lines 5778-5815, TaskViewerProvider lines 14639-14682) depends on `has_worktree` flag. The new worktree creation path must still call `db.updateHasWorktree(sessionId, true)`. No conflict — same DB methods are used.
- The `_cleanupWorktree` call on reviewer-pass completion (line 13340-13352) must remain unchanged. Do NOT add cleanup on column exit.
- `_getWorktreeCounts` (KanbanProvider lines 6415-6429) reads `has_worktree` for UI badges. No change needed.

## Dependencies
- None — this plan is self-contained and does not depend on other plans.

## Adversarial Synthesis
Key risks: (1) `_updateKanbanColumnForSession` bypasses `moveCardToColumn`, so dispatch-path column moves would miss worktree creation — must unify through a single entry point. (2) The original plan's cleanup-on-column-exit would destroy worktrees before reviewers can see the code — cleanup must stay on reviewer-pass. (3) Addon storage was incorrectly specified as state.json; must use VS Code workspace state via `getRoleConfig`. Mitigations: route all column updates through `KanbanProvider.moveCardToColumn`, keep existing reviewer-pass cleanup, use existing addon resolution path.

## Requirements
- Worktree creation should trigger when a plan moves to any coder column
- Worktree creation should happen in the card movement logic, not terminal dispatch
- Worktree option should be a prompt addon (not agents tab)
- Prompt addon should be available for: lead, coder, intern, and custom agents
- Default to OFF for all roles
- If enabled for a role, worktree is created when plan moves to that role's column
- Worktree should be cleaned up when reviewer-pass workflow completes (existing behavior, NOT on column exit)
- Terminal dispatch should use existing worktree path (read metadata, don't create)
- Manual chat should use worktree path when plan is in coder column

## Implementation Plan

### 1. Remove Worktree from Agents Tab

**File: `src/webview/kanban.html`**

Remove worktree checkbox from agents tab (lines 2135-2140):
```html
<!-- REMOVE these lines -->
<label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
    <input id="agents-tab-git-worktrees" type="checkbox" style="width:auto;margin:0;">
    <span>Use git worktrees for coder agents</span>
</label>
<div id="worktree-auto-commit-note" style="display:none;font-size:10px;color:var(--text-muted);margin-left:24px;margin-top:2px;">
    Uncommitted changes are auto-committed to main before each worktree is created.
</div>
```

Remove `gitWorktreesEnabled` from `agentsTabCollectConfig` (around line 2910):
```javascript
// REMOVE this line from the return object:
gitWorktreesEnabled: document.getElementById('agents-tab-git-worktrees')?.checked ?? false,
```

Remove worktree hydration in message handler (lines 5374-5378):
```javascript
// REMOVE these lines:
const gitWorktreesCb = document.getElementById('agents-tab-git-worktrees');
if (gitWorktreesCb) gitWorktreesCb.checked = !!msg.gitWorktreesEnabled;
const worktreeHydrateNote = document.getElementById('worktree-auto-commit-note');
if (worktreeHydrateNote) worktreeHydrateNote.style.display = !!msg.gitWorktreesEnabled ? 'block' : 'none';
```

Remove worktree auto-commit note toggle (lines 2930-2935):
```javascript
// REMOVE these lines:
const worktreeCb = document.getElementById('agents-tab-git-worktrees');
const worktreeNote = document.getElementById('worktree-auto-commit-note');
if (worktreeCb && worktreeNote) {
    worktreeNote.style.display = worktreeCb.checked ? 'block' : 'none';
    worktreeCb.addEventListener('change', () => {
        worktreeNote.style.display = worktreeCb.checked ? 'block' : 'none';
    });
}
```

**File: `src/services/KanbanProvider.ts`**

Remove `getGitWorktreesEnabled` method (lines 2217-2220):
```typescript
// REMOVE this method:
public async getGitWorktreesEnabled(workspaceRoot: string): Promise<boolean> {
    const state = await this._getStartupCommands(workspaceRoot);
    return state.gitWorktreesEnabled ?? false;
}
```

Remove `gitWorktreesEnabled` from `_getStartupCommands` return value (around line 2213):
```typescript
// REMOVE gitWorktreesEnabled from the return object
```

Remove `gitWorktreesEnabled` handling from `_saveStartupCommands` (around line 2239):
```typescript
// REMOVE this line:
if (typeof msg.gitWorktreesEnabled === 'boolean') state.gitWorktreesEnabled = msg.gitWorktreesEnabled;
```

**File: `src/services/TaskViewerProvider.ts`**

Remove `_getGitWorktreesEnabled` method (lines 16913-16916):
```typescript
// REMOVE this method:
private async _getGitWorktreesEnabled(workspaceRoot: string): Promise<boolean> {
    if (!this._kanbanProvider) return false;
    return this._kanbanProvider.getGitWorktreesEnabled(workspaceRoot);
}
```

### 2. Add Worktree as Prompt Addon

**File: `src/webview/sharedDefaults.js`**

Add `useWorktree` to `DEFAULT_ROLE_CONFIG.addons` for lead, coder, intern (lines 17-33):
```javascript
// In DEFAULT_ROLE_CONFIG.lead.addons, add:
useWorktree: false,

// In DEFAULT_ROLE_CONFIG.coder.addons, add:
useWorktree: false,

// In DEFAULT_ROLE_CONFIG.intern.addons, add:
useWorktree: false,
```

Add `useWorktree` to `ROLE_ADDONS` for lead (after line 84), coder (after line 97), intern (after line 127):
```javascript
// In ROLE_ADDONS.lead array, add:
{ id: 'useWorktree', label: 'Use Worktree', tooltip: 'Create isolated git worktree when plan enters this column', default: false },

// In ROLE_ADDONS.coder array, add:
{ id: 'useWorktree', label: 'Use Worktree', tooltip: 'Create isolated git worktree when plan enters this column', default: false },

// In ROLE_ADDONS.intern array, add:
{ id: 'useWorktree', label: 'Use Worktree', tooltip: 'Create isolated git worktree when plan enters this column', default: false },
```

**Custom agents**: Custom agents dynamically receive all addons from their role template. The `renderRoleAddons` function (kanban.html line 2646) already handles custom agent roles by looking up `ROLE_ADDONS[role]`. For custom agents to get the worktree addon, the addon must be added to the custom agent's ROLE_ADDONS entry when custom agents are registered. This is handled by the existing custom agent registration flow — no special code needed beyond ensuring `useWorktree` appears in the role template used for custom agents.

### 3. Unify Column Movement Through KanbanProvider.moveCardToColumn

**CRITICAL ARCHITECTURAL FIX**: Currently, `_updateKanbanColumnForSession` (TaskViewerProvider line 1704) calls `db.updateColumn()` directly, bypassing `KanbanProvider.moveCardToColumn`. This means 7 call sites (lines 2325, 2524, 2709, 14398, 14486, 14783) move cards without going through the unified entry point. If worktree creation only lives in `moveCardToColumn`, these paths will miss it.

**Solution**: Make `_updateKanbanColumnForSession` delegate to `KanbanProvider.moveCardToColumn` instead of calling `db.updateColumn()` directly.

**File: `src/services/TaskViewerProvider.ts`**

Replace `_updateKanbanColumnForSession` (lines 1704-1717):
```typescript
// BEFORE (bypasses KanbanProvider):
private async _updateKanbanColumnForSession(workspaceRoot: string, sessionId: string, column: string | null): Promise<boolean> {
    if (!column) return false;
    const db = await this._getKanbanDb(workspaceRoot);
    if (!db) return false;
    const updated = await db.updateColumn(sessionId, column);
    if (!updated) return false;
    const plan = await db.getPlanBySessionId(sessionId);
    const planFile = typeof plan?.planFile === 'string' ? plan.planFile.trim() : '';
    if (!planFile) return false;
    return true;
}

// AFTER (delegates to KanbanProvider for unified worktree handling):
private async _updateKanbanColumnForSession(workspaceRoot: string, sessionId: string, column: string | null): Promise<boolean> {
    if (!column) return false;
    if (!this._kanbanProvider) {
        // Fallback: direct DB update if KanbanProvider not available
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return false;
        return !!(await db.updateColumn(sessionId, column));
    }
    return this._kanbanProvider.moveCardToColumn(workspaceRoot, sessionId, column);
}
```

**Note**: The existing `moveCardToColumn` already calls `queueIntegrationSyncForSession`, so the delegation automatically handles integration sync. The `_autoCommitIfCodeReviewTransition` is also handled by `moveCardToColumn`. No functionality is lost.

### 4. Move Worktree Creation to Card Movement Logic

**File: `src/services/KanbanProvider.ts`**

**Remove from:** `TaskViewerProvider._dispatchExecuteMessage` (lines 14533-14574) — remove the entire worktree creation block. Replace with a simple metadata lookup (see Step 7).

**Add to:** `KanbanProvider.moveCardToColumn` (lines 3766-3784):

```typescript
public async moveCardToColumn(
    workspaceRoot: string,
    sessionId: string,
    targetColumn: string
): Promise<boolean> {
    try {
        // Capture previous column BEFORE update (needed for worktree cleanup detection)
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) return false;
        const previousRecord = await db.getPlanBySessionId(sessionId);
        const previousColumn = previousRecord?.kanbanColumn || null;

        await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
        const moved = await db.updateColumn(sessionId, targetColumn);
        if (moved) {
            // Handle worktree creation for coder columns
            await this._handleWorktreeForColumnTransition(workspaceRoot, sessionId, previousColumn, targetColumn);

            await this.queueIntegrationSyncForSession(workspaceRoot, sessionId, targetColumn);
        }
        return moved;
    } catch (err) {
        console.error(`[KanbanProvider] moveCardToColumn failed for session ${sessionId}:`, err);
        return false;
    }
}
```

**Also update `moveCardToColumnByPlanFile`** (lines 3786-3810) with the same pattern:

```typescript
public async moveCardToColumnByPlanFile(
    workspaceRoot: string,
    planFile: string,
    targetColumn: string
): Promise<boolean> {
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) return false;
        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';

        // Capture previous column BEFORE update
        const previousRecord = await db.getPlanByPlanFile(planFile, workspaceId);
        const previousColumn = previousRecord?.kanbanColumn || null;
        const sessionId = previousRecord?.sessionId || null;

        if (targetColumn === 'CODE REVIEWED') {
            if (sessionId) {
                await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
            }
        }
        const moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
        if (moved) {
            if (sessionId) {
                await this._handleWorktreeForColumnTransition(workspaceRoot, sessionId, previousColumn, targetColumn);
            }
            await this.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
        }
        return moved;
    } catch (err) {
        console.error(`[KanbanProvider] moveCardToColumnByPlanFile failed for ${planFile}:`, err);
        return false;
    }
}
```

### 5. Create Worktree Handler Method in KanbanProvider

**File: `src/services/KanbanProvider.ts`**

New private method that handles worktree creation on column entry. Does NOT handle cleanup on column exit — cleanup remains on reviewer-pass completion (existing behavior at TaskViewerProvider line 13340-13352).

```typescript
private async _handleWorktreeForColumnTransition(
    workspaceRoot: string,
    sessionId: string,
    previousColumn: string | null,
    targetColumn: string
): Promise<void> {
    const targetRole = this._columnToRole(targetColumn);
    if (!targetRole) return;

    // Only consider worktree creation for coder roles and custom agents
    const isCoderColumn = ['lead', 'coder', 'intern'].includes(targetRole) || targetRole.startsWith('custom_agent_');
    if (!isCoderColumn) return;

    // Check if useWorktree addon is enabled for the target role
    const addonEnabled = await this._isWorktreeAddonEnabled(workspaceRoot, targetRole);
    if (!addonEnabled) return;

    // Delegate to TaskViewerProvider for actual worktree creation
    if (this._taskViewerProvider) {
        await this._taskViewerProvider.createWorktreeForSession(workspaceRoot, sessionId);
    }
}
```

New method to check addon from VS Code workspace state (NOT state.json):

```typescript
private async _isWorktreeAddonEnabled(
    workspaceRoot: string,
    role: string
): Promise<boolean> {
    if (!this._taskViewerProvider) return false;

    // Read role config from VS Code workspace state (same path as prompt building)
    const roleConfig = this._taskViewerProvider.getRoleConfig(`roleConfig_${role}`) as
        | { addons?: Record<string, boolean> }
        | undefined;

    if (roleConfig?.addons?.useWorktree === true) return true;

    // Fall back to default from sharedDefaults
    // The DEFAULT_ROLE_CONFIG defines useWorktree: false for all coder roles,
    // so if no override exists, worktree is disabled.
    return false;
}
```

**Why NOT read from state.json?** The addon system stores role configs in VS Code workspace state under keys like `switchboard.prompts.roleConfig_lead`. The `state.json` file only held the global `gitWorktreesEnabled` toggle which is being removed. The per-role `useWorktree` addon follows the same storage pattern as all other addons (gitProhibition, pairProgramming, etc.).

### 6. Add Worktree Creation Method to TaskViewerProvider

**File: `src/services/TaskViewerProvider.ts`**

New public method that wraps the existing private `_createWorktree`, `_autoCommitDirtyMain`, and `_isGitRepo` methods:

```typescript
public async createWorktreeForSession(
    workspaceRoot: string,
    sessionId: string
): Promise<void> {
    const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedWorkspaceRoot) return;

    // Check if this is a git repo
    const isGit = await this._isGitRepo(resolvedWorkspaceRoot);
    if (!isGit) {
        console.warn('[TaskViewerProvider] Worktree addon enabled but workspace is not a git repository.');
        return;
    }

    // Check if worktree already exists for this session
    const db = await this._getKanbanDb(resolvedWorkspaceRoot);
    if (db) {
        const existingMeta = await db.getWorktreeMeta(sessionId);
        if (existingMeta && existingMeta.worktreePath) {
            console.log(`[TaskViewerProvider] Worktree already exists for session ${sessionId}`);
            return;
        }
    }

    try {
        // Auto-commit any dirty working directory before creating worktree
        await this._autoCommitDirtyMain(resolvedWorkspaceRoot);

        const { worktreePath, worktreeBranch } = await this._createWorktree(resolvedWorkspaceRoot, sessionId);

        // Store metadata in kanban_meta
        if (db) {
            await db.setWorktreeMeta(sessionId, { worktreePath, worktreeBranch });
            await db.updateHasWorktree(sessionId, true);
        }

        console.log(`[TaskViewerProvider] Created worktree for session ${sessionId}: ${worktreePath}`);
    } catch (e: any) {
        console.error(`[TaskViewerProvider] Failed to create worktree for session ${sessionId}:`, e);
        // Non-fatal: card movement succeeds, dispatch will use main tree
    }
}
```

**Why this is safe as a cross-provider call**: KanbanProvider already holds a `_taskViewerProvider` reference and calls its methods (e.g., `autoCommitForCodeReview` at line 3753). This follows the same pattern.

### 7. Update Terminal Dispatch to Use Existing Worktree

**File: `src/services/TaskViewerProvider.ts`**

**Remove** the entire worktree creation block from `_dispatchExecuteMessage` (lines 14533-14574):
```typescript
// REMOVE this entire block:
const gitWorktreesEnabled = await this._getGitWorktreesEnabled(resolvedWorkspaceRoot);
if (gitWorktreesEnabled && ['coder', 'lead', 'intern'].includes(role)) {
    // ... all 40 lines of worktree creation logic ...
}
```

**Replace** with a simple metadata lookup that uses an existing worktree if one exists:

```typescript
// Check if session has an existing worktree — use it as working directory
let effectiveWorkspaceRoot = resolvedWorkspaceRoot;
if (sessionId) {
    const db = await this._getKanbanDb(resolvedWorkspaceRoot);
    if (db) {
        const worktreeMeta = await db.getWorktreeMeta(sessionId);
        if (worktreeMeta && worktreeMeta.worktreePath) {
            // Verify worktree path still exists on disk
            if (fs.existsSync(worktreeMeta.worktreePath)) {
                effectiveWorkspaceRoot = worktreeMeta.worktreePath;
                // Allow git in worktree (override gitProhibition)
                options = {
                    ...options,
                    workingDirectory: worktreeMeta.worktreePath,
                    gitProhibitionEnabled: false
                };
            } else {
                // Stale metadata — clear it
                console.warn(`[TaskViewerProvider] Worktree path ${worktreeMeta.worktreePath} no longer exists, using main tree`);
                await db.clearWorktreeMeta(sessionId);
                await db.updateHasWorktree(sessionId, false);
            }
        }
    }
}
```

**Key difference from original**: This code READS existing worktree metadata instead of CREATING a new worktree. The worktree was already created during card movement (Step 4). The dispatch just uses whatever worktree exists.

### 8. Worktree Cleanup — Keep Existing Behavior

**NO CHANGES to cleanup logic.** The existing cleanup on reviewer-pass completion (TaskViewerProvider lines 13340-13352) is correct and must be preserved:

```typescript
// Existing code at line 13340 — DO NOT MODIFY:
if (isStop && workflow === 'reviewer-pass') {
    const db = await this._getKanbanDb(resolvedWorkspaceRoot);
    if (db) {
        const plan = await db.getPlanBySessionId(sessionId);
        if (plan?.hasWorktree) {
            const lowOutcome = (outcome || '').toLowerCase();
            const isSuccess = !lowOutcome.includes('fail') && !lowOutcome.includes('error') && !lowOutcome.includes('conflict') && !lowOutcome.includes('abort') && !lowOutcome.includes('cancel');
            if (isSuccess) {
                await this._cleanupWorktree(resolvedWorkspaceRoot, sessionId);
            }
        }
    }
}
```

**Why NOT clean up on column exit?** When a plan moves from INTERN CODED → CODE REVIEWED, the reviewer needs the worktree to exist so they can review the code changes. Destroying the worktree on column exit would make review impossible. The reviewer-pass workflow completion is the correct cleanup trigger.

### 9. Update Manual Chat to Use Worktree

**File: `src/services/KanbanProvider.ts`**

When chat prompts are generated (around line 5071, `chatCopyPrompt` handler), the workspace root is already resolved. If the plan has a worktree, the chat prompt should reference the worktree path.

In the `chatCopyPrompt` handler, after resolving the selected cards, check for worktree metadata:

```typescript
// After building selectedCards, before constructing the prompt:
for (const card of selectedCards) {
    if (card.hasWorktree) {
        const db = this._getKanbanDb(workspaceRoot);
        if (db && await db.ensureReady()) {
            const meta = await db.getWorktreeMeta(card.sessionId);
            if (meta?.worktreePath) {
                // Include worktree path in plan section context
                planSection += `\nWorktree path: ${meta.worktreePath}\n`;
            }
        }
    }
}
```

**Clarification**: This is a lightweight addition — the chat workflow already reads the plan file and workspace root. Adding the worktree path to the context block ensures the chat agent knows where to find the code. This does not require changes to how chat resolves workspace context.

### 10. Prompts Tab UI — No Additional Changes

The `renderRoleAddons` function (kanban.html line 2646) dynamically renders addons from `ROLE_ADDONS[role]`. Adding `useWorktree` to the `ROLE_ADDONS` entries for lead, coder, and intern (Step 2) automatically makes it appear in the Prompts tab for those roles. No additional UI code is needed.

The addon checkbox will:
- Appear in the Prompts tab when lead, coder, or intern is selected
- Default to unchecked (OFF)
- Save to VS Code workspace state via `saveRoleConfig` when toggled
- Be read by `_isWorktreeAddonEnabled` during card movement

## Edge Cases

**Worktree already exists:**
- `createWorktreeForSession` checks `db.getWorktreeMeta(sessionId)` before creating
- Skip creation if metadata exists and path is valid
- Log info message

**Git repo check fails:**
- Skip worktree creation
- Log warning
- Continue with main tree (non-fatal)

**Worktree creation fails:**
- Log error
- Card movement still succeeds (worktree creation is non-blocking)
- Dispatch will use main tree (no worktree metadata exists)

**Stale worktree metadata (path deleted externally):**
- Dispatch checks `fs.existsSync(worktreeMeta.worktreePath)` before using
- If path doesn't exist, clear stale metadata and fall back to main tree

**Addon disabled:**
- Skip all worktree logic in `_handleWorktreeForColumnTransition`
- Card moves normally, no worktree created
- Dispatch uses main tree

**Custom agents:**
- Custom agent columns use `custom_agent_*` naming convention
- `_columnToRole` returns the column name itself for custom agents (line 6355)
- `_handleWorktreeForColumnTransition` checks `targetRole.startsWith('custom_agent_')` to include them
- Custom agents must have `useWorktree` in their ROLE_ADDONS entry to see the addon in UI

**Multiple card moves for same session:**
- First move to coder column creates worktree
- Subsequent moves (e.g., re-dispatch) find existing worktree and skip creation
- No duplicate worktrees

## Success Criteria

- Worktree option removed from agents tab
- Worktree addon added to prompts tab for lead, coder, intern roles
- Addon defaults to OFF
- Worktree created when plan moves to coder column AND addon enabled for that role
- Worktree NOT cleaned up on column exit (remains for reviewer)
- Worktree cleaned up on reviewer-pass completion (existing behavior preserved)
- Terminal dispatch uses existing worktree when addon enabled
- Manual chat includes worktree path in context when addon enabled
- All column movement paths go through `KanbanProvider.moveCardToColumn` (unified entry point)
- No regression in existing functionality (merge worktrees, worktree counts, auto-commit)

## Proposed Changes

### `src/webview/kanban.html`
- **Context**: Agents tab UI and Prompts tab rendering
- **Logic**: Remove worktree checkbox from agents tab (lines 2135-2140, 2910, 2930-2935, 5374-5378). No changes needed for Prompts tab — `renderRoleAddons` handles new addons automatically.
- **Implementation**: Delete HTML elements and JS references listed in Step 1
- **Edge Cases**: Ensure `agentsTabCollectConfig` still returns valid object without `gitWorktreesEnabled`

### `src/webview/sharedDefaults.js`
- **Context**: Role addon definitions and default config
- **Logic**: Add `useWorktree: false` to `DEFAULT_ROLE_CONFIG` for lead, coder, intern (lines 17-33). Add `useWorktree` addon entry to `ROLE_ADDONS` for lead, coder, intern (lines 72-128).
- **Implementation**: Insert addon entries after existing addons in each role's array
- **Edge Cases**: Custom agents inherit from their template role — ensure the template includes `useWorktree`

### `src/services/KanbanProvider.ts`
- **Context**: Card movement, worktree creation trigger, addon resolution
- **Logic**: (1) Remove `getGitWorktreesEnabled`, `gitWorktreesEnabled` from `_getStartupCommands` and `_saveStartupCommands`. (2) Add `_handleWorktreeForColumnTransition` and `_isWorktreeAddonEnabled` private methods. (3) Update `moveCardToColumn` to capture previous column and call worktree handler. (4) Update `moveCardToColumnByPlanFile` similarly. (5) Add worktree path to `chatCopyPrompt` handler.
- **Implementation**: See Steps 1, 4, 5, 9 for exact code
- **Edge Cases**: `getPlanBySessionId` may return null for new sessions — handle gracefully. `_columnToRole` returns null for COMPLETED — skip worktree logic.

### `src/services/TaskViewerProvider.ts`
- **Context**: Terminal dispatch, worktree creation/cleanup, column updates
- **Logic**: (1) Remove `_getGitWorktreesEnabled`. (2) Remove worktree creation block from `_dispatchExecuteMessage` (lines 14533-14574). (3) Add worktree metadata lookup in `_dispatchExecuteMessage`. (4) Add public `createWorktreeForSession` method. (5) Replace `_updateKanbanColumnForSession` to delegate to `KanbanProvider.moveCardToColumn`.
- **Implementation**: See Steps 3, 6, 7 for exact code
- **Edge Cases**: Stale worktree metadata (path deleted externally) — check `fs.existsSync` before using. `_resolveWorkspaceRoot` may return null — guard against it.

### `src/services/KanbanDatabase.ts`
- **Context**: Worktree metadata storage
- **Logic**: No changes needed. Existing methods (`setWorktreeMeta`, `getWorktreeMeta`, `clearWorktreeMeta`, `updateHasWorktree`) are sufficient.
- **Implementation**: N/A
- **Edge Cases**: N/A

### `src/services/agentPromptBuilder.ts`
- **Context**: Prompt building with addon directives
- **Logic**: No changes needed. The `useWorktree` addon does not inject a prompt directive — it controls worktree creation at the infrastructure level, not prompt content. The existing `gitProhibitionEnabled: false` override in dispatch options handles allowing git in worktrees.
- **Implementation**: N/A
- **Edge Cases**: N/A

## Verification Plan

### Automated Tests
- **Configuration**: Verify `useWorktree` addon appears in ROLE_ADDONS for lead, coder, intern
- **Configuration**: Verify `useWorktree` addon does NOT appear for planner, reviewer, tester
- **Configuration**: Verify default value is `false` for all roles

### Manual Verification
- **Card movement**: Move plan to LEAD CODED with addon enabled → worktree created
- **Card movement**: Move plan to CODER CODED with addon enabled → worktree created
- **Card movement**: Move plan to INTERN CODED with addon enabled → worktree created
- **Card movement**: Move plan to coder column with addon disabled → NO worktree created
- **Card movement**: Move plan out of coder column (to CODE REVIEWED) → worktree NOT cleaned up
- **Card movement**: Move plan to coder column when worktree already exists → skip creation
- **Terminal dispatch**: Dispatch to coder role with worktree → uses worktree path as working directory
- **Terminal dispatch**: Dispatch to coder role without worktree → uses main tree
- **Terminal dispatch**: Dispatch with stale worktree metadata → clears metadata, uses main tree
- **Reviewer-pass**: Complete reviewer-pass with worktree → worktree cleaned up
- **Reviewer-pass**: Complete reviewer-pass with failure → worktree NOT cleaned up
- **Merge worktrees**: Merge button in CODE REVIEWED column → still works correctly
- **Agents tab**: Worktree checkbox removed → no UI element present
- **Prompts tab**: Worktree addon visible for lead, coder, intern → checkbox appears
- **Prompts tab**: Toggle worktree addon → persists across reloads
- **Sidebar dispatch**: Dispatch via sidebar → card moves through `moveCardToColumn` (unified path)
- **Manual chat**: Chat with plan in coder column with worktree → worktree path included in context

### Skip Directives
- SKIP COMPILATION: Do NOT run any project compilation step
- SKIP TESTS: Do NOT run automated tests

## Recommendation
Complexity 6 → **Send to Coder**

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Finding |
|----|----------|---------|
| MAJOR-1 | MAJOR | `_isWorktreeAddonEnabled` reads from `getRoleConfig(`roleConfig_${role}`)` (VS Code workspace state). Custom agents store addons in `state.json` via `_getCustomAgents`, not in VS Code workspace state. Zero `roleConfig_custom_agent_*` entries exist in the codebase. Method always returns `false` for custom agents — the `custom_agent_` branch in `_handleWorktreeForColumnTransition` is dead code. |
| MAJOR-2 | MAJOR | `CustomAgentAddons` interface in `agentConfig.ts` has no `useWorktree` property. `parseCustomAgentAddons` doesn't parse it. TypeScript rejects the property and the parser silently drops it from `state.json`. |
| MAJOR-3 | MAJOR | No "Use Worktree" checkbox for custom agents in the Agents tab UI (kanban.html lines 2167-2210). The plan's claim that "custom agents dynamically receive all addons from their role template" via `renderRoleAddons` is factually wrong — custom agents use a separate hardcoded checkbox list, not `ROLE_ADDONS`. |
| NIT-1 | NIT | Dead code path for custom agents in `_handleWorktreeForColumnTransition` line 6240 — unreachable because `_isWorktreeAddonEnabled` always returns false for custom agents. |
| NIT-2 | NIT | Inconsistent `_autoCommitIfCodeReviewTransition` call pattern: `moveCardToColumn` calls unconditionally, `moveCardToColumnByPlanFile` guards with `if (targetColumn === 'CODE REVIEWED')`. Both work (method has own guard), but inconsistency is confusing. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| MAJOR-1 | **Fix now** | Add custom agent branch in `_isWorktreeAddonEnabled` that reads from `_getCustomAgents` |
| MAJOR-2 | **Fix now** | Add `useWorktree` to `CustomAgentAddons` interface and `parseCustomAgentAddons` parser |
| MAJOR-3 | **Fix now** | Add checkbox, loading code, and collection code for custom agent worktree addon |
| NIT-1 | **Fixed** (resolves with MAJOR-1) | Custom agent branch now live code |
| NIT-2 | **Defer** | Not a regression, both paths work correctly |

### Code Fixes Applied

**File: `src/services/agentConfig.ts`**
- Added `useWorktree?: boolean` to `CustomAgentAddons` interface (line 23)
- Added `if (s.useWorktree === true) a.useWorktree = true;` to `parseCustomAgentAddons` (line 173)

**File: `src/services/KanbanProvider.ts`**
- Rewrote `_isWorktreeAddonEnabled` (lines 6253-6275) to branch on `role.startsWith('custom_agent_')`:
  - Custom agents: reads from `_getCustomAgents(workspaceRoot)` → finds agent by id/role → checks `addons.useWorktree`
  - Built-in roles: reads from `getRoleConfig(`roleConfig_${role}`)` (unchanged)

**File: `src/webview/kanban.html`**
- Added "Use Worktree" checkbox with `id="ca-addon-use-worktree"` in custom agent addons section (line 2198-2201)
- Added loading code: `document.getElementById('ca-addon-use-worktree').checked = addons.useWorktree === true;` (line 2767)
- Added collection code: `useWorktree: document.getElementById('ca-addon-use-worktree').checked,` (line 2820)

### Verification

- **Consistency check**: All `useWorktree` references (13 total) use consistent property name across agentConfig.ts, KanbanProvider.ts, kanban.html, and sharedDefaults.js
- **Stale reference check**: Zero references to old global toggle (`gitWorktreesEnabled`, `getGitWorktreesEnabled`, `_getGitWorktreesEnabled`) remain in codebase
- **SKIP COMPILATION**: Per plan directives, no compilation step run
- **SKIP TESTS**: Per plan directives, no automated tests run

### Remaining Risks

1. **Deferred NIT-2**: Inconsistent `_autoCommitIfCodeReviewTransition` call pattern between `moveCardToColumn` and `moveCardToColumnByPlanFile`. Not a regression — both work correctly because the method has its own guard. Low priority cleanup.
2. **Custom agent worktree end-to-end**: The full pipeline (UI → state.json → parseCustomAgentAddons → _isWorktreeAddonEnabled → _handleWorktreeForColumnTransition → createWorktreeForSession) now exists for custom agents, but has not been manually tested. The code follows existing patterns exactly and should work, but a manual smoke test is recommended.
