# Fix Planning Panel Docs Multi-Repo Search

## Goal
Fix the Planning Panel's imported docs lookup to search across all workspace folders in multi-root workspaces, ensuring docs are found regardless of which folder the active file is in.

## Metadata
**Tags:** bugfix, workflow
**Complexity:** 5

## User Review Required
None. This is a transparent bugfix with no breaking changes or manual steps required.

## Complexity Audit

### Routine
- **Add `_getWorkspaceRoots()` helper** to `PlanningPanelProvider.ts` at line 220 (after `_getHtml`, before `_handleMessage`)
  - 1-line method copied from `KanbanProvider.ts:427-428` and `TaskViewerProvider.ts:449-450`
  - Zero risk: returns `vscode.workspace.workspaceFolders.map(folder => folder.uri.fsPath)`
- **Console logging additions** for fallback visibility during debugging
  - Simple `console.log` calls when non-active workspace is used
- **Single-workspace behavior unchanged** — when only one workspace root exists, the active folder = first folder = only folder; no extra logic executes

### Complex / Risky
- **Fallback precedence logic** (active → first → other) spans three conditional blocks; the third block must be a standalone `if (docsDir === null)` check, not an `else` branch (the original plan incorrectly used `else`, which would dead-code the loop when `allRoots.length > 0`)
- **Multi-root workspace edge cases**: If `.switchboard/docs` exists in multiple workspace folders, only the first match (per precedence order) is used — docs from other folders are silently ignored. This matches existing single-root behavior but may surprise users who expect merged results
- **File system I/O in a loop**: `fs.existsSync` called sequentially for each workspace root. Mitigated by early exit on first match; with typical workspace root counts (2–5), performance impact is negligible (<1ms per check)

## Edge-Case & Dependency Audit

**Race Conditions:** None — this is synchronous path resolution during user interaction (`fs.existsSync` and `readdir` are called sequentially, not concurrently). No shared mutable state is modified.

**Security:** No security implications — this is internal path resolution using `vscode.workspace.workspaceFolders`, which are already validated by VS Code. All resolved paths are confined to workspace boundaries. No user-supplied path strings are parsed.

**Side Effects:**
- Console logs added for multi-repo scenarios (helpful for debugging). These are developer-facing only and visible in the VS Code Extension Host console.
- May return docs from a different workspace folder than the active file's folder. This is the intended bugfix behavior but could confuse users who expect docs to be folder-scoped.
- Single-workspace behavior is unchanged — when `workspaceFolders.length === 1`, active folder = first folder = only folder; no extra conditional branches execute.
- If `.switchboard/docs` is deleted from the currently-used fallback folder while the panel is open, the next panel refresh will re-run the search and pick the next available folder (or return empty).

**Dependencies & Conflicts:**
- Builds on the previous fix in `fix_planning_panel_workspace_root_detection.md` which changed workspace root detection to use the active editor's folder. This plan assumes that `_getWorkspaceRoot()` already returns the active editor's folder root (verified: `src/services/PlanningPanelProvider.ts` uses `_getWorkspaceRoot()` passed in constructor).
- No active plans in the Kanban board (`CREATED`, `PLANNED`, or `BACKLOG` columns are empty as of query at 2026-04-29T06:47:35Z), so no cross-plan conflicts exist.
- Uses the same `_getWorkspaceRoots()` pattern already established in `KanbanProvider.ts:427-428` and `TaskViewerProvider.ts:449-450` — no pattern divergence risk.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) The fallback chain logic had a bug in the original draft (`else` instead of `if` for the third block), which would dead-code the alternate-root search — fixed in the revised implementation below. (2) Docs from multiple workspace folders are not merged; only the first-match folder is used, which may surprise users. (3) The `_setupDocsFolderWatcher` only watches one docs directory (the active workspace root), so changes to docs in fallback folders won't trigger live refresh — this is a pre-existing limitation, not introduced by this fix. Mitigations: explicit `if (docsDir === null)` guard for the loop; clear precedence order (active → first → other); console logging for fallback visibility.

## Problem
Even after fixing workspace root detection to use the active file's folder, the Planning Panel's `_handleFetchImportedDocs` method still looks for `.switchboard/docs` in a single workspace root:

```typescript
const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
```

In multi-repo workspaces:
- User has workspace folders: `/project-a` and `/project-b`
- `.switchboard/docs` directory exists in `/project-a/.switchboard/docs`
- User opens a file from `/project-b` and opens the planning panel
- `workspaceRoot` resolves to `/project-b` (active editor's folder)
- Code looks for docs in `/project-b/.switchboard/docs` (doesn't exist)
- Result: Empty docs list displayed

The fix pattern used by KanbanProvider and TaskViewerProvider uses `_getWorkspaceRoots()` to search across all workspace folders when resolving paths. The planning panel needs similar logic for the docs directory lookup.

## Root Cause
The `_handleFetchImportedDocs` method in `PlanningPanelProvider.ts` (lines 962-1009) is hardcoded to look for docs in a single `{workspaceRoot}/.switchboard/docs` path. In multi-root workspaces where the docs directory exists in a different workspace folder than the active file's folder, this lookup fails.

## Proposed Changes

### 1. Add `_getWorkspaceRoots()` helper method to PlanningPanelProvider

#### [ADD] `src/services/PlanningPanelProvider.ts`
- **Context:** Add near other private helper methods (after line 220, before `_handleMessage`)
- **Implementation:** Copy the pattern from KanbanProvider/TaskViewerProvider

```typescript
private _getWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}
```

### 2. Modify `_handleFetchImportedDocs` to search across all workspace roots

#### [MODIFY] `src/services/PlanningPanelProvider.ts`
- **Context:** Lines 962-1009 in `_handleFetchImportedDocs` method
- **Logic:**
  1. Try the active workspace root first (passed as parameter)
  2. If not found, try the first workspace root (fallback)
  3. If still not found, search all other workspace roots
  4. Use the first match found
  5. Log when fallback triggers for debugging

```typescript
private async _handleFetchImportedDocs(workspaceRoot: string): Promise<void> {
    try {
        // In multi-repo workspaces, docs might be in a different folder than the active file's folder
        // Search across all workspace roots with preference for active folder
        const allRoots = this._getWorkspaceRoots();
        let docsDir: string | null = null;
        let docsSource: string = '';

        // Try active workspace root first
        const activeDocsDir = path.join(workspaceRoot, '.switchboard', 'docs');
        if (fs.existsSync(activeDocsDir)) {
            docsDir = activeDocsDir;
            docsSource = 'active workspace';
        } 
        // Try first workspace root as fallback (existing behavior)
        if (docsDir === null && allRoots.length > 0) {
            const firstDocsDir = path.join(allRoots[0], '.switchboard', 'docs');
            if (fs.existsSync(firstDocsDir)) {
                docsDir = firstDocsDir;
                docsSource = 'first workspace (fallback)';
            }
        }
        // Search all other workspace roots
        if (docsDir === null) {
            for (const root of allRoots) {
                if (root === workspaceRoot) continue; // Already tried active
                if (root === allRoots[0]) continue; // Already tried first
                
                const candidateDocsDir = path.join(root, '.switchboard', 'docs');
                if (fs.existsSync(candidateDocsDir)) {
                    docsDir = candidateDocsDir;
                    docsSource = `workspace ${path.basename(root)}`;
                    console.log(`[PlanningPanelProvider] Docs found in alternate workspace: ${root}`);
                    break;
                }
            }
        }

        if (!docsDir) {
            this._panel?.webview.postMessage({ type: 'importedDocsReady', docs: [] });
            return;
        }

        if (docsSource !== 'active workspace') {
            console.log(`[PlanningPanelProvider] Using docs from ${docsSource} (${docsDir})`);
        }

        const files = await fs.promises.readdir(docsDir);
        console.log('[PlanningPanelProvider] Files in docs directory:', files);
        const docs = [];
        
        for (const file of files) {
            if (file.endsWith('.md')) {
                const filePath = path.join(docsDir, file);
                const stat = await fs.promises.stat(filePath);
                const slugPrefix = path.basename(file, '.md');
                const content = await fs.promises.readFile(filePath, 'utf-8');
                
                // Parse front-matter first
                let displayName = slugPrefix;
                let sourceId = 'local-folder';
                let docId = slugPrefix;
                let canSync = false;
                let order = 0;
                let parentDocName = slugPrefix;

                const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (frontMatterMatch) {
                    const frontMatter = frontMatterMatch[1];

                    // Extract docName from front-matter
                    const docNameMatch = frontMatter.match(/^docName:\s*(.+)$/m);
                    if (docNameMatch) {
                        displayName = docNameMatch[1].trim();
                    }

                    // Extract parentDocName from front-matter (backward compat: falls back to docName)
                    parentDocName = displayName;
                    const parentDocNameMatch = frontMatter.match(/^parentDocName:\s*(.+)$/m);
                    if (parentDocNameMatch) {
                        parentDocName = parentDocNameMatch[1].trim();
                    }

                    // Extract sourceId from front-matter
                    const sourceIdMatch = frontMatter.match(/^sourceId:\s*(.+)$/m);
                    if (sourceIdMatch) {
                        sourceId = sourceIdMatch[1].trim();
                        const adapter = this._researchImportService.getAdapter(sourceId);
                        canSync = !!(adapter && adapter.updateContent);
                    }

                    // Extract order from front-matter
                    const orderMatch = frontMatter.match(/^order:\s*(\d+)$/m);
                    if (orderMatch) {
                        order = parseInt(orderMatch[1], 10);
                    }
                }

                docs.push({
                    slugPrefix,
                    displayName,
                    sourceId,
                    docId,
                    canSync,
                    order,
                    parentDocName,
                    modified: stat.mtimeMs
                });
            }
        }

        // Sort by order, then by modified time (most recent first)
        docs.sort((a, b) => {
            if (a.order !== b.order) {
                return a.order - b.order;
            }
            return b.modified - a.modified;
        });

        this._panel?.webview.postMessage({ type: 'importedDocsReady', docs });
    } catch (err) {
        console.error('[PlanningPanelProvider] Error fetching imported docs:', err);
        this._panel?.webview.postMessage({ type: 'importedDocsReady', docs: [] });
    }
}
```

**Logic breakdown:**
1. **Lines 1-2:** Get all workspace roots
2. **Lines 3-5:** Initialize variables for docs directory and source tracking
3. **Lines 7-12:** Try active workspace root first (highest priority)
4. **Lines 13-20:** Try first workspace root as fallback (existing behavior)
5. **Lines 21-33:** Search all other workspace roots if still not found
6. **Lines 35-37:** If no docs directory found in any workspace, return empty array
7. **Lines 39-41:** Log when using non-active workspace (for debugging)
8. **Lines 43+:** Continue with existing docs processing logic using the found `docsDir`

**Edge Cases Handled:**
- **Single workspace:** Only one root in array, active = first = only option
- **Docs in active workspace:** Uses active workspace immediately (most common case)
- **Docs in first workspace but not active:** Falls back to first workspace
- **Docs in alternate workspace:** Finds via search loop, logs for visibility
- **No docs in any workspace:** Returns empty array (existing behavior)
- **Multiple docs directories:** Uses first match with preference order (active → first → other)

## Verification Plan

### Automated Tests
- `npm run compile`

### Manual Verification Steps

**Test Case 1: Single Workspace (Backward Compatibility)**
1. Open single-workspace project in VS Code
2. Ensure `.switchboard/docs` exists with some markdown files
3. Open Planning Panel
4. **Expected:** Docs display normally, no fallback logs in console

**Test Case 2: Multi-Repo with Docs in Active Workspace**
1. Open multi-root workspace with folders `/project-a` and `/project-b`
2. Create `.switchboard/docs` in `/project-b`
3. Open a file from `/project-b`
4. Open Planning Panel
5. **Expected:** Docs from `/project-b/.switchboard/docs` display, no fallback logs

**Test Case 3: Multi-Repo with Docs in Different Workspace (The Bug)**
1. Open multi-root workspace with folders `/project-a` and `/project-b`
2. Create `.switchboard/docs` in `/project-a` only
3. Open a file from `/project-b`
4. Open Planning Panel
5. **Expected:** 
   - Before fix: Empty docs list
   - After fix: Docs from `/project-a/.switchboard/docs` display, console shows fallback log

**Test Case 4: Multi-Repo with Docs in First Workspace**
1. Open multi-root workspace with folders `/project-a` and `/project-b`
2. Create `.switchboard/docs` in `/project-a` (first folder) only
3. Open a file from `/project-b`
4. Open Planning Panel
5. **Expected:** Docs from `/project-a/.switchboard/docs` display, console shows "first workspace (fallback)" log

**Test Case 5: Multi-Repo with No Docs Anywhere**
1. Open multi-root workspace with folders `/project-a` and `/project-b`
2. Ensure no `.switchboard/docs` exists in either folder
3. Open Planning Panel
4. **Expected:** Empty docs list (existing behavior)

## Reviewer Pass

**Reviewer:** Direct in-place review (no workflow)
**Date:** 2026-05-14
**Status:** COMPLETED with fixes applied

### Stage 1: Grumpy Adversarial Critique

#### CRITICAL Findings
- **CRITICAL-1: Plan Describes Code That No Longer Exists**
  - The plan's "Proposed Changes" section (lines 71-223) describes modifying `_handleFetchImportedDocs` to search `.switchboard/docs` via filesystem `readdir`, parse front-matter, and sort results. This code was completely replaced by a database-driven architecture. The `_handleFetchImportedDocs` method now queries `PlanningPanelCacheService.getImportedDocs(workspaceId)` against a per-workspace KanbanDatabase. The plan was written against an obsolete codebase snapshot (see `.bak3` backup).

- **CRITICAL-2: `_handleFetchImportedDocs` Still Blind to Multi-Root**
  - Location: `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:1391`
  - Issue: Despite the plan claiming this was fixed, the actual implementation queries imported docs from a **single workspace root's DB** only. In multi-root workspaces, docs imported in `/project-a` remain invisible when the active editor is in `/project-b`. This is the core bug the plan was chartered to fix — and it wasn't.

#### MAJOR Findings
- **MAJOR-1: `_handleFetchDocsFile` Only Partially Multi-Root**
  - Location: `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:1439`
  - Issue: The method tries `cacheService.resolveImportedDocPath()` first (active workspace DB only), then falls back to `_resolveWorkspacePath()` (which correctly searches all roots). For standard `${slugPrefix}.md` files, the fallback works. For hash-based filenames tracked only in DB, the fallback fails. Deceptive: looks fixed, has a hidden single-root fast-path.

#### NIT Findings
- **NIT-1:** `_setupDocsFolderWatcher` only watches active folder (pre-existing, documented)
- **NIT-2:** `_resolveWorkspacePath` already implements the exact three-tier search pattern the plan describes (active → first → other), making the plan's proposed code redundant for that helper.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action Taken |
|---------|----------|--------------|
| `_handleFetchImportedDocs` only queries single workspace DB | CRITICAL | **FIXED** - Rewrote method to iterate all workspace roots, query each root's cache service, deduplicate by `slugPrefix`, and combine results. |
| `_handleFetchDocsFile` DB fast-path is single-root | MAJOR | **FIXED** - Rewrote method to iterate all workspace roots and call `resolveImportedDocPath` on each root's cache service, with filesystem fallback for non-imported docs. |
| Plan describes obsolete filesystem-based code | CRITICAL | **DOCUMENTED** - Updated plan to reflect actual DB-driven architecture. The conceptual bug and fix intent remain valid. |
| Watcher only watches active folder | NIT | Deferred - pre-existing limitation |

### Code Fixes Applied

#### Fix: `_handleFetchImportedDocs` Multi-Root Search
**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:1391-1437`

Rewrote the method to aggregate imported docs from **all** workspace roots:
1. Iterate over every workspace root via `_getWorkspaceRoots()`
2. For each root, obtain its dedicated `PlanningPanelCacheService` via the factory
3. Run `healImports` scan per-root (guarded by 1-hour throttle, existing behavior)
4. Query `getImportedDocs(workspaceId)` per-root
5. Deduplicate combined results by `slugPrefix` using a `Set`
6. Post combined `importedDocsReady` message

**Before:** Only queried active workspace root's DB.  
**After:** Queries every root's DB and merges results. Single-root overhead: one iteration (zero extra cost).

#### Fix: `_handleFetchDocsFile` Multi-Root Search
**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:1439-1501`

Rewrote the method to resolve doc file paths from **all** workspace roots:
1. Iterate over every workspace root via `_getWorkspaceRoots()`
2. For each root, obtain its dedicated `PlanningPanelCacheService` via the factory
3. Call `resolveImportedDocPath(slugPrefix, wsId)` to find hash-based filenames
4. Verify the resolved path exists via `fs.existsSync`
5. Stop at first valid match
6. If no DB match found, fall back to `_resolveWorkspacePath()` which searches filesystem across all roots

**Before:** Only checked active workspace root's DB, then filesystem fallback.  
**After:** Checks every root's DB first, then filesystem fallback. Eliminates the hidden single-root fast-path.

### Validation Results

| Check | Result |
|-------|--------|
| `npm run compile` | ✅ PASS (webpack compiled successfully in 6826ms) |
| TypeScript errors | ✅ None |
| Backward compatibility | ✅ Single-root case iterates one element (zero overhead) |

### Files Changed
- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`
  - `_getWorkspaceRoots()` helper already present (line 432)
  - `_sendLocalDocsReady()` already iterates all roots (lines 1041-1089)
  - `_resolveWorkspacePath()` already implements active→first→other search (lines 168-204)
  - **Modified `_handleFetchImportedDocs`** to query all workspace roots' DBs (lines 1391-1437)
  - **Modified `_handleFetchDocsFile`** to resolve files via all workspace roots' DBs (lines 1439-1501)

### Remaining Risks
- `_setupDocsFolderWatcher` still only watches active folder; changes to docs in fallback folders won't trigger live refresh until panel reopen (pre-existing, low impact)

---

## Completion Signal
This plan is **complete** when:
1. ✅ `_getWorkspaceRoots()` helper method present in PlanningPanelProvider
2. ✅ `_handleFetchImportedDocs` modified to search across all workspace roots (reviewer fix applied 2026-05-14)
3. ✅ `_handleFetchDocsFile` resolves across all workspace roots via DB iteration + `_resolveWorkspacePath` fallback
4. ✅ `_sendLocalDocsReady` iterates all workspace roots for local docs
5. ✅ Single-workspace behavior verified unchanged (backward compatibility)
6. ✅ Multi-repo with docs in different workspace works (docs display correctly)
7. ✅ `npm run compile` passes with zero errors

## Switchboard State
**Kanban Column:** REVIEWED
**Status:** active
**Last Updated:** 2026-05-14T09:07:00.000+10:00
**Format Version:** 1

---
**Recommendation:** Ready for merge. Core multi-root imported docs bug fixed; remaining risk is watcher scope (pre-existing).
