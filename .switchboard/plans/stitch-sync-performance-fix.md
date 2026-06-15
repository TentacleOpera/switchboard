# Rewrite Stitch Image Cache to Be Simple and Reliable

## Goal
Rewrite the Stitch image cache to follow a simple, reliable pattern:
1. Get list of screen IDs
2. Download screens and save by ID to `.switchboard/stitch/` (not `.stitch/screens/`)
3. On future loads, display saved screen per ID
4. Fetch any outstanding IDs

Additionally, simplify the confusing folder management UI that allows saving to multiple locations.

The current implementation relies on panel-specific `asWebviewUri()` URIs that break on panel recreation, an in-memory promise cache that is cleared on dispose, and a cache location under `.stitch/screens/` that is inconsistent with other Switchboard data. The root cause is over-engineering: panel-bound URIs and in-memory caches were chosen instead of stable `file://` URIs and disk-based checks.

## Metadata
**Complexity:** 5
**Tags:** bugfix, performance, ui, frontend

## User Review Required
- Confirm that removing the "Manage Folders" button from the Stitch tab does not block any existing workflow (users can still configure folders via other tabs if needed).
- Confirm that moving cached images from `.stitch/screens/` to `.switchboard/stitch/` is acceptable, and whether a one-time migration or cleanup of the old path is desired.

## Complexity Audit

### Routine
- Remove `_imageCachePromises` map and `_evictImageCache` function
- Remove "Manage Folders" button from `design.html`
- Add `_fetchWithTimeout` helper
- Change cache path from `.stitch/screens/` to `.switchboard/stitch/`
- Rename private method parameters (`workspaceRoot` → `destination`) to align with UI intent

### Complex / Risky
- Modifying `_updateWebviewRoots` to include `.switchboard/stitch/` for all workspace roots without breaking existing `localResourceRoots` behavior
- Switching from `asWebviewUri()` to `file://` URIs and ensuring the webview CSP and `localResourceRoots` allow loading them across panel recreations
- Ensuring no code path misses the parameter rename in private methods or callers
- Preventing path traversal via `screen.id` when writing to disk

## Edge-Case & Dependency Audit

### Race Conditions
Concurrent screen fetches for the same screen ID could trigger duplicate downloads. The new implementation checks disk with `stat` before downloading, but two parallel checks could still race. The impact is low (one overwrites the other) and can be accepted given the session scope.

### Security
`file://` URIs from `.switchboard/stitch/` are added to `localResourceRoots`. `path.basename(screen.id)` is used to prevent path traversal, but an attacker-controlled `screen.id` with embedded separators could still be a risk if not sanitized. Ensure `destination` (workspace root) is resolved and validated against actual workspace folders before constructing cache paths.

### Side Effects
Old `.stitch/screens/` caches will be orphaned; the plan does not migrate or clean them up. `_updateWebviewRoots` is called from multiple document-readiness handlers; adding new URIs must not degrade startup performance.

### Dependencies & Conflicts
`_updateWebviewRoots` already manages folder URIs from `LocalFolderService`; the new stitch dirs must coexist. The webview's existing CSP source and `localResourceRoots` must include the new `.switchboard/stitch/` paths. No external package dependencies are introduced.

## Dependencies
- `sess_stitch_workspace_root` — workspace root resolution via `message.workspaceRoot`
- `sess_local_folder_service` — `_getLocalFolderService` used for existing folder paths but not for the new cache dir
- `sess_webview_resource_roots` — VS Code webview `localResourceRoots` configuration

## Adversarial Synthesis
Key risks: concurrent downloads overwriting cache files for the same screen ID, stale `file://` URIs if `.switchboard/stitch/` is not included in `localResourceRoots`, and orphaned `.stitch/screens/` caches left behind. Mitigations: use `path.basename(screen.id)` for safe filenames, extend `_updateWebviewRoots` to include stitch directories for every workspace root, and document the old cache path as abandoned.

## Root Cause Analysis

The current cache implementation is over-engineered and broken:

### Problem 1: Panel-Specific URIs
**Location:** `src/services/DesignPanelProvider.ts:704-705`

The cache uses `this._panel.webview.asWebviewUri()` to generate URIs. These URIs are **panel-specific** and become invalid when the panel is recreated.

**Impact:** When you close and reopen design.html, the cached files exist on disk but the URIs don't work.

### Problem 2: In-Memory Promise Cache Cleared on Dispose
**Location:** `src/services/DesignPanelProvider.ts:167`

The `_imageCachePromises` map is cleared on panel dispose, so no in-memory cache survives panel recreation.

**Impact:** Every panel recreation requires re-checking disk and re-generating URIs.

### Problem 3: Complex URI Generation Logic
**Location:** `src/services/DesignPanelProvider.ts:701-716`

The `_resolveImageCache` function has complex fallback logic that tries to use panel-specific URIs, then falls back to API calls if the panel isn't ready.

**Impact:** Race conditions during panel initialization cause unnecessary API calls.

### Problem 4: Confusing Folder Management UI
**Location:** `src/webview/design.html:3717-3726`

The UI has:
- A "Sync Destination" dropdown that allows selecting multiple locations
- A "Manage Folders" button that allows configuring multiple save locations
- The ability to save to multiple folders at once

**Impact:** Users don't understand where screens are being saved, and the multi-folder option is unnecessary complexity.

### Problem 5: Wrong Default Cache Location
**Location:** `src/services/DesignPanelProvider.ts:626-628`

The cache saves to `{workspaceRoot}/.stitch/screens/` instead of `.switchboard/stitch/`.

**Impact:** Inconsistent with other Switchboard data, confusing location.

## Implementation Plan

### Phase 1: Simplify Cache Logic

**File:** `src/services/DesignPanelProvider.ts`

Replace the entire cache implementation with simple file-based logic:

```typescript
private _getImageCacheDir(destination: string): string {
    // Changed from .stitch/screens/ to .switchboard/stitch/
    // Uses the selected destination from the Sync Destination dropdown
    return path.join(destination, '.switchboard', 'stitch');
}

private async _getCachedImageUri(screen: any, destination: string): Promise<string> {
    if (!destination) {
        try {
            return await screen.getImage() || '';
        } catch {
            return '';
        }
    }
    
    const cacheDir = this._getImageCacheDir(destination);
    const safeId = path.basename(screen.id);
    const cachePath = path.join(cacheDir, `${safeId}.png`);
    
    // Check if file exists on disk
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(cachePath));
        // Return file:// URI - works across panel recreations
        return vscode.Uri.file(cachePath).toString();
    } catch {
        // File doesn't exist - download it
    }
    
    // Download from API
    try {
        const url = await screen.getImage();
        if (!url) {
            return '';
        }
        
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(cacheDir));
        
        const res = await this._fetchWithTimeout(url, 60000);
        if (!res.ok) {
            throw new Error(`Failed to fetch image: ${res.statusText}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await vscode.workspace.fs.writeFile(vscode.Uri.file(cachePath), buffer);
        
        // Return file:// URI
        return vscode.Uri.file(cachePath).toString();
    } catch (err) {
        console.error('Failed to download image to cache:', err);
        return '';
    }
}
```

**Note:** The `workspaceRoot` parameter is the active workspace root (from the `stitch-workspace-filter` dropdown), not the asset download `destination`. The image cache is per-workspace-root at `{workspaceRoot}/.switchboard/stitch/`.

### Phase 2: Update Webview Resource Roots

**File:** `src/services/DesignPanelProvider.ts`

Modify the existing `_updateWebviewRoots` method to include `.switchboard/stitch/` directories:

1. In the `for (const r of allRoots)` loop, after the existing `service.getBriefsFolderPaths()` block (line 596), add:

```typescript
// Include the Stitch image cache directory in resource roots
const stitchCacheDir = path.join(r, '.switchboard', 'stitch');
try {
    folderUris.push(vscode.Uri.file(stitchCacheDir));
} catch {}
```

**Note:** The existing `_updateWebviewRoots` at `src/services/DesignPanelProvider.ts:574-619` already manages `localResourceRoots`. Adding the `.switchboard/stitch/` paths there ensures the webview can load `file://` URIs from the cache across panel recreations. Do not create a separate method — extend the existing one.

### Phase 3: Simplify Folder Management UI

**File:** `src/webview/design.html`

Keep the "Sync Destination:" dropdown (stitch-workspace-filter) as-is, but remove the confusing "Manage Folders" button:
1. Remove the "Manage Folders" button (line 3717)

**Rationale:** The Sync Destination dropdown is needed to let users choose where to save screens. The Manage Folders button is unnecessary complexity.

**Note:** The cache will save to `{destination}/.switchboard/stitch/` where `destination` is the selected value from the Sync Destination dropdown.

### Phase 4: Remove Broken Cache Infrastructure

**File:** `src/services/DesignPanelProvider.ts`

Remove the broken infrastructure:
1. Remove `_imageCachePromises` map (line 63)
2. Remove `_evictImageCache` function (lines 630-641)
3. Remove calls to `_evictImageCache` in `stitchRefreshScreen` (line 1323) and `stitchEdit` (line 1739)
4. Remove `_imageCachePromises.clear()` in dispose (line 167)

### Phase 4.5: Update Function Signatures (Parameter Rename Clarification)

**File:** `src/services/DesignPanelProvider.ts`

**Clarification:** Keep the `workspaceRoot` parameter name. Do NOT rename to `destination`. The image cache is per-workspace-root; `destination` is used only for asset downloads (HTML/PNG). Steps:

1. Keep `_formatScreen` signature: `private async _formatScreen(screen: any, workspaceRoot: string): Promise<any>`
2. Keep `_getCachedImageUri` signature: `private async _getCachedImageUri(screen: any, workspaceRoot: string): Promise<string>`
3. Keep `_getImageCacheDir` signature: `private _getImageCacheDir(workspaceRoot: string): string`
4. Update `_getImageCacheDir` body to return `path.join(workspaceRoot, '.switchboard', 'stitch')` instead of `path.join(this._getStitchOutputDir(workspaceRoot), 'screens')`
5. Keep message handlers using `message.workspaceRoot`; do not change to `message.destination`

### Phase 5: Add Fetch Timeout

**File:** `src/services/DesignPanelProvider.ts`

Add a simple timeout wrapper around fetch:

```typescript
private async _fetchWithTimeout(url: string, timeoutMs: number = 30000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        return response;
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs}ms`);
        }
        throw err;
    }
}
```

Use it in the cache download: `const res = await this._fetchWithTimeout(url, 60000);`

## Verification Plan

### Automated Tests
No automated tests required per session directive. The test suite will be run separately by the user.

### Manual Verification
1. **Cache persistence**: Load screens, close design.html, reopen design.html. Verify images load instantly from cache without new API calls.
2. **Cache miss**: Delete a cached PNG from `.switchboard/stitch/`, reopen design.html. Verify it re-downloads from API.
3. **`file://` URI loading**: Verify cached images render correctly in the webview after panel recreation.
4. **Fetch timeout**: Temporarily block the image URL endpoint and verify the request aborts after ~60 seconds with a console error.
5. **Multi-root workspaces**: In a multi-root workspace, verify each root gets its own `.switchboard/stitch/` cache and the webview can load images from all of them.

## Files Changed

- `src/services/DesignPanelProvider.ts` - Simplify cache logic, change cache location to `.switchboard/stitch/`, extend `_updateWebviewRoots` to include stitch cache dirs, remove broken infrastructure (`_imageCachePromises`, `_evictImageCache`), update `_getImageCacheDir` body, add `_fetchWithTimeout`
- `src/webview/design.html` - Remove "Manage Folders" button (line 3717) only; keep Sync Destination dropdown

---

**Recommendation:** Send to Coder
