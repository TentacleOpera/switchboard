# Cache Stitch Images Locally

## Goal

Eliminate redundant Stitch API calls for immutable screen images by downloading each image once, caching it locally in the workspace, and serving subsequent renders from disk instead of repeatedly fetching fresh presigned URLs.

### Problem Analysis

Currently, every time `_formatScreen()` is called (project load, screen refresh, poll response), it calls `screen.getImage()` which returns a presigned URL from Stitch's cloud storage. These URLs expire. The webview loads thumbnails and previews directly from these transient URLs. The result:

- **Switching projects** re-fetches every image URL from Stitch even if the images never changed.
- **Polling** re-fetches URLs for screens that are still rendering — once they render, the URL is fetched again.
- **Presigned URL expiry** causes `<img>` load failures after a short time, triggering unnecessary error-handling and re-polling.
- **No deduplication** — the same screen's image is downloaded from Stitch's CDN every time the user views it.

Stitch screen images are immutable. If a user requests an edit, Stitch creates a new screen; the old screen and its image remain unchanged. This means every image URL is effectively permanent content that should be cached.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, bugfix, performance, reliability

## User Review Required

- [ ] Confirm local cache directory: `.stitch/screens/` or a different path?
- [ ] Confirm cache eviction policy: never evict, or age-based (e.g., 30 days)?
- [ ] Confirm whether HTML assets should also be cached locally, or only images.

## Complexity Audit

### Routine

- Add local image download on first `_formatScreen()` call.
- Convert local file path to webview-accessible URI.
- Track cached image state (a Set or Map of screen IDs).
- Add cache invalidation on `stitchEdit` and `stitchRefreshScreen`.
- Reuse existing `stitchDownloadAsset` fetch-and-write logic.

### Complex / Risky

- **Webview CSP and `localResourceRoots`**: Local image URIs must be served through the webview's content security policy. The provider's `localResourceRoots` already includes workspace folders, but a new sub-directory may need explicit registration.
- **Concurrent download races**: Two simultaneous `_formatScreen()` calls for the same screen could both try to download and write the same file. Needs an in-flight download deduplication promise.
- **Cache invalidation on edit**: `stitchEdit` returns an updated screen with the same ID but a new image URL, so the cached image becomes stale. Must delete the old file so the next `_formatScreen` re-downloads.
- **Disk usage**: Unbounded growth if screens are never evicted. Needs a cap or LRU policy.

## Edge-Case & Dependency Audit

- **Race Conditions:** Multiple `_formatScreen()` calls for the same screen during project load. First call starts download, second call must wait on the same promise, not start a second download.
- **Security:** Screen IDs must be sanitized before use as filenames. Stitch screen IDs appear to be UUIDs or similar safe strings, but `path.basename()` or a hash should be applied.
- **Side Effects:** Writing to `.stitch/screens/` will trigger any file watchers on that directory. Ensure this does not cause re-renders or sync loops.
- **Dependencies & Conflicts:** The existing `stitchDownloadAsset` handler already downloads images to `.stitch/`. The cache directory should be a sub-folder (`.stitch/screens/`) to avoid collision with user-initiated downloads.

## Dependencies

- `vscode.workspace.fs` for file I/O (already used in `stitchDownloadAsset`).
- `vscode.Uri` for converting local paths to webview URIs.
- Existing `_formatScreen()` and `_getStitchOutputDir()` helpers.

## Adversarial Synthesis

Key risks: (1) stale cached images after `stitchEdit` or `stitchRefreshScreen` because the cache invalidation path is missed or delayed, (2) concurrent `_formatScreen` calls race on file writes and corrupt the PNG if the promise map is checked after `stat`, (3) disk fills up over time with hundreds of screen images. Mitigations: evict cache immediately before `stitchEdit` and `stitchRefreshScreen`, check `_imageCachePromises` before `stat` in `_getCachedImageUri`, use `webview.asWebviewUri()` for all local image paths, and add an LRU cap or periodic cleanup as a follow-up.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

#### Add image cache directory and tracking state

- Add `private _imageCachePromises = new Map<string, Promise<string>>()` to deduplicate in-flight downloads keyed by screen ID.

#### Implement `_getImageCacheDir(workspaceRoot: string): string`

- Returns `path.join(this._getStitchOutputDir(workspaceRoot), 'screens')`.
- Creates the directory on first call via `vscode.workspace.fs.createDirectory()`.

#### Implement `_getCachedImageUri(screen: any, workspaceRoot: string): Promise<string>`

```typescript
private async _getCachedImageUri(screen: any, workspaceRoot: string): Promise<string> {
    const cacheDir = this._getImageCacheDir(workspaceRoot);
    const safeId = path.basename(screen.id); // Sanitize
    const cachePath = path.join(cacheDir, `${safeId}.png`);

    // Check in-flight deduplication FIRST to prevent races
    const existingPromise = this._imageCachePromises.get(screen.id);
    if (existingPromise) {
        return existingPromise;
    }

    // Check if already cached on disk
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(cachePath));
        return this._panel!.webview.asWebviewUri(vscode.Uri.file(cachePath)).toString();
    } catch {
        // Not cached — start download
    }

    const downloadPromise = this._downloadImageToCache(screen, cachePath);
    this._imageCachePromises.set(screen.id, downloadPromise);

    try {
        const uri = await downloadPromise;
        return uri;
    } finally {
        this._imageCachePromises.delete(screen.id);
    }
}
```

#### Implement `_downloadImageToCache(screen: any, cachePath: string): Promise<string>`

- Call `screen.getImage()` to get the presigned URL.
- If URL is null/empty, fall back to returning `null` immediately.
- `fetch(url)` → `Buffer.from(await res.arrayBuffer())`.
- `vscode.workspace.fs.writeFile(vscode.Uri.file(cachePath), buffer)`.
- Return `this._panel!.webview.asWebviewUri(vscode.Uri.file(cachePath)).toString()`.
- On any error, fall back to returning the raw presigned URL so the webview still has something to display.

#### Modify `_formatScreen()` to use cache

```typescript
private async _formatScreen(screen: any, workspaceRoot: string): Promise<any> {
    const imageUrl = await this._getCachedImageUri(screen, workspaceRoot);
    return {
        id: screen.id,
        projectId: screen.projectId,
        name: screen.data?.title || screen.data?.displayName || screen.id,
        deviceType: screen.data?.deviceType,
        imageUrl,
        htmlUrl: await screen.getHtml(),
        status: screen.data?.screenMetadata?.status || null,
        statusMessage: screen.data?.screenMetadata?.statusMessage || null
    };
}
```

**Note:** `_formatScreen` signature changes to accept `workspaceRoot`. Update all call sites.

#### Invalidate cache on mutable operations

In these handlers, delete the cached file before/after the operation:
- `stitchEdit` — `this._evictImageCache(message.screenId, workspaceRoot)`
- `stitchGenerate` — new screen has no cache entry yet, no action needed
- `stitchRefreshScreen` — evict cache before `_formatScreen` so a re-rendered image is re-downloaded

```typescript
private async _evictImageCache(screenId: string, workspaceRoot: string): Promise<void> {
    const cacheDir = this._getImageCacheDir(workspaceRoot);
    const safeId = path.basename(screenId);
    const cachePath = path.join(cacheDir, `${safeId}.png`);
    try {
        await vscode.workspace.fs.delete(vscode.Uri.file(cachePath));
    } catch {
        // File may not exist — ignore
    }
}
```

#### Update `stitchGetProjectScreens` to pass workspaceRoot to `_formatScreen`

```typescript
const formatted = await Promise.all(list.map(async (screen: any) => {
    this._activeScreens.set(screen.id, screen);
    return this._formatScreen(screen, workspaceRoot);
}));
```

Same update for `stitchRefreshScreen`, `stitchGenerate`, `stitchEdit`, `stitchVariants`.

### `src/webview/design.js`

#### No changes required for basic caching

The webview already renders `<img src="screen.imageUrl">`. If `imageUrl` is a `vscode-resource:` URI, the webview will load it normally. The CSP and `localResourceRoots` already include workspace folders, so `.stitch/screens/` is accessible.

**However**, if `localResourceRoots` does not dynamically include the `.stitch/screens/` subfolder, the webview may block the image load. The provider already covers this: `_updateWebviewRoots()` (line 600) includes `getStitchFolderPaths()` URIs and every workspace folder URI. Since `_getStitchOutputDir()` resolves to a workspace subfolder (e.g., `.stitch/`), `.stitch/screens/` is automatically included in `localResourceRoots`. No additional registration needed.

## Implementation Steps

1. **Add cache state and helpers to `DesignPanelProvider.ts`**
   - Add `_imageCachePromises` field.
   - Implement `_getImageCacheDir()`.
   - Implement `_getCachedImageUri()` with in-flight deduplication.
   - Implement `_downloadImageToCache()`.
   - Implement `_evictImageCache()`.

2. **Modify `_formatScreen()` to use cache**
   - Change signature to accept `workspaceRoot: string`.
   - Replace `await screen.getImage()` with `await this._getCachedImageUri(screen, workspaceRoot)`.

3. **Update all `_formatScreen()` call sites**
   - `stitchGetProjectScreens` (line 1188)
   - `stitchRefreshScreen` (line 1228)
   - `stitchGenerate` (line 1632)
   - `stitchEdit` (line 1645)
   - `stitchVariants` (line 1665)

4. **Add cache invalidation on mutable operations**
   - `stitchEdit` — evict before calling `screen.edit()` (line ~1638).
   - `stitchRefreshScreen` — evict before calling `_formatScreen(fresh)` (line ~1228) so a re-rendered image is fetched fresh.
   - `stitchVariants` — **do NOT evict**; variants creates new screens with new IDs, leaving the original unchanged.

5. **Verify webview can load local images**
   - Confirm `localResourceRoots` includes the `.stitch/screens/` path.
   - Test that a cached image renders correctly in the thumbnail and preview.

6. **Add optional cache cleanup / LRU**
   - On provider disposal or workspace switch, optionally delete old cache files.
   - Or add a simple size cap (e.g., keep only last 100 screens).
   - This can be deferred if disk usage is not an immediate concern.

## Verification Plan

### Automated / Static Verification

- Confirm `_formatScreen()` no longer calls `screen.getImage()` directly; it routes through `_getCachedImageUri()`.
- Confirm `_getCachedImageUri()` uses `this._imageCachePromises` to deduplicate concurrent downloads.
- Confirm `_evictImageCache()` is called in `stitchEdit` and `stitchRefreshScreen` handlers (not `stitchVariants`; variants creates new screens).
- Confirm no direct `screen.getImage()` calls remain outside `_downloadImageToCache()` and `stitchOpenManifest` (which needs public presigned URLs for markdown links).

### Manual Verification

1. Open a Stitch project with multiple screens.
2. Observe that `.stitch/screens/` directory is created and populated with `.png` files.
3. Switch to another project and back.
4. Confirm the screens render immediately without new Stitch API calls for images.
5. Select a screen, confirm the preview loads from the local cache.
6. Edit a screen via the preview panel.
7. Confirm the old cached image is deleted and a new one is downloaded after the edit completes.
8. Disconnect from the internet (or block Stitch API).
9. Confirm cached screens still render from local files.

## Files Changed

- `src/services/DesignPanelProvider.ts`

## Risk Assessment

- **Low-Medium risk.** The change is localized to `_formatScreen()` and adds a caching layer. No webview changes.
- **Primary risk:** stale cached images after `stitchEdit` or `stitchRefreshScreen` if eviction is missed or ordered incorrectly.
- **Mitigation:** evict immediately before editing or refreshing, and verify `_getCachedImageUri` checks `_imageCachePromises` before `stat`.
- **Secondary risk:** disk usage grows unbounded.
- **Mitigation:** add LRU or periodic cleanup as a follow-up if needed.

## Recommendation

Send to Coder. This is a self-contained backend change with clear boundaries. The caching logic is straightforward; the main risk is cache invalidation ordering on edit/refresh, which is easily verified manually.

## Review Findings

**Files changed:** `src/services/DesignPanelProvider.ts` only.

**Issues found and fixed:**
1. **CRITICAL — Concurrent download race:** `_getCachedImageUri` registered the download promise AFTER `await stat`, allowing two simultaneous calls to start separate downloads. Fixed by extracting the async work into `_resolveImageCache` and registering the promise in the map before any `await`.
2. **MAJOR — `_imageCachePromises` leak on dispose:** The map was never cleared when the panel closed. Fixed by adding `this._imageCachePromises.clear()` in `dispose()`.
3. **MAJOR — Stale in-flight promise after eviction:** `_evictImageCache` deleted the file but left a live download promise in the map, causing the next caller to receive a URI for a deleted file. Fixed by adding `this._imageCachePromises.delete(screenId)` before the file delete.
4. **MAJOR — Null panel cached-hit fell through to re-download:** When the cached file existed but `this._panel` was null, the function fell through and started an unnecessary download instead of returning the presigned URL. Fixed in `_resolveImageCache` by returning `screen.getImage()` directly in that branch.

**Validation results:** Verified by static analysis. All `_formatScreen` call sites pass `workspaceRoot`. `stitchOpenManifest` correctly retains direct `getImage()` calls for markdown presigned URLs. `_evictImageCache` is called in `stitchEdit` and `stitchRefreshScreen`; `stitchVariants` correctly skips eviction.

**Remaining risks:**
- No LRU or disk cap on cache growth (plan already deferred).
- `path.basename(screen.id)` sanitization is weak if Stitch ever returns path-like IDs; mitigated by Stitch using UUIDs.
- No eviction on workspace switch; low risk because screen IDs are UUIDs and collisions across workspaces are unlikely.
