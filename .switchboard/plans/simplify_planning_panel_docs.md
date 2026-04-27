# Simplify Planning Panel Docs Architecture

## Goal
Simplify the Planning Panel docs architecture by separating local-folder docs from online docs so local files load independently of adapter registration and online source availability. Success means the local folder area appears immediately on panel open, local handling is direct and small, and Notion/ClickUp/Linear continue using the existing adapter system.

## Metadata
**Tags:** frontend, backend, UI, UX, bugfix, reliability, performance
**Complexity:** 7

## User Review Required
> [!NOTE]
> This plan intentionally does **not** add net-new product behavior. It preserves the original requirements: direct local-folder handling, online docs via adapters, `localDocsReady`, `onlineDocsReady`, immediate local-folder display, no local dependency on adapter registration, and a target of less than 50 lines of local-folder handling in `PlanningPanelProvider.ts`.
>
> Clarification: The design doc reference at `.switchboard/research-aggregate-cache.md` is treated as foundational context only. It does not add additional Planning Panel product requirements for this isolated plan.
>
> Clarification: The implementation must update all consumers of removed contracts (`LocalFolderResearchAdapter`, `PlanningPanelAdapterFactories.getLocalFolderService`, and `rootsReady` local/online mixing), otherwise TypeScript compilation or webview behavior will break.

## Current Problem
The local folder docs feature is broken due to over-engineering:
- 6 layers of abstraction (factory → service → adapter → registration → fetch → render)
- Tight coupling between local files and online sources (Notion/ClickUp/Linear)
- Adapter pattern adds complexity for no benefit

Concrete current-state findings:
- `src/services/ResearchImportService.ts` defines and exports `LocalFolderResearchAdapter` at lines 242-300, wrapping `LocalFolderService` solely to satisfy `ResearchSourceAdapter`.
- `src/services/PlanningPanelProvider.ts` imports `LocalFolderResearchAdapter` at lines 5-10 and registers it in `_ensureAdaptersRegistered()` at lines 62-67.
- `src/services/PlanningPanelProvider.ts` still exposes `getLocalFolderService` through `PlanningPanelAdapterFactories` at line 22 and uses that factory in `browseLocalFolder`, `setLocalFolderPath`, `_handleFetchRoots`, `_handleFetchChildren`, and `_handleFetchPreview`.
- `src/extension.ts` wires `getLocalFolderService: (root) => new LocalFolderService(root)` into the planning panel factory at lines 1330-1337.
- `src/webview/planning.js` currently consumes one mixed `rootsReady` message in `handleRootsReady()` beginning at line 379 and splits local vs online in the browser, which keeps local rendering coupled to the online source payload shape.

## Proposed Solution
Separate local-folder from online sources completely.

### Phase 1: Remove Adapter System for Local-Folder
1. Delete `LocalFolderResearchAdapter` class.
2. Delete local-folder registration from `_ensureAdaptersRegistered()`.
3. Keep direct service calls in `_handleFetchRoots`, `_handleFetchChildren`, `_handleFetchPreview`.

Clarification: “Keep direct service calls” means instantiate `new LocalFolderService(workspaceRoot)` inside Planning Panel local-folder paths instead of asking `PlanningPanelAdapterFactories` for a local-folder service.

### Phase 2: Simplify Factory
1. Remove `getLocalFolderService` from `PlanningPanelAdapterFactories` interface.
2. Create `LocalFolderService` directly in methods that need it.
3. Pass `workspaceRoot` to constructor, read folderPath from VS Code config on demand.

Clarification: `PlannerPromptWriterOptions.getLocalFolderService` in `src/services/PlannerPromptWriter.ts` is out of scope for removal because `PlannerPromptWriter` still needs local cached content through its own dependency injection contract. This plan only removes local-folder service factory usage from `PlanningPanelProvider` and its construction in `src/extension.ts`.

### Phase 3: Flatten Message Handling
Current: Message → _handleMessage → _handleFetchRoots → factory → service → files
New: Message → _handleMessage → readConfig → readDir → respond

### Phase 4: UI Separation
Current: Single `rootsReady` message with mixed local/online
New:
- `localDocsReady` - always sent, contains local files or "not configured"
- `onlineDocsReady` - only sent if adapters exist

Clarification: For backward compatibility during the transition, `rootsReady` can be left for online-only payloads if existing helper code expects it, but local-folder rendering must move to `localDocsReady` and must not depend on online adapters.

## Complexity Audit
### Routine
- Remove the `LocalFolderResearchAdapter` import and registration from `src/services/PlanningPanelProvider.ts`.
- Remove `getLocalFolderService` from `PlanningPanelAdapterFactories` in `src/services/PlanningPanelProvider.ts`.
- Remove the `getLocalFolderService` property from the Planning Panel factory object in `src/extension.ts`.
- Convert existing local-folder branches in `browseLocalFolder`, `setLocalFolderPath`, `_handleFetchRoots`, `_handleFetchChildren`, and `_handleFetchPreview` to instantiate `new LocalFolderService(workspaceRoot)` directly.
- Add local helper functions in `src/services/PlanningPanelProvider.ts` to map `LocalFolderService.listFiles()` results into `TreeNode[]`.
- Update `src/webview/planning.js` message handling to accept `localDocsReady` and `onlineDocsReady` in addition to any remaining online-compatible `rootsReady` path.
- Run compile/lint/contract checks after implementation.

### Complex / Risky
- Separating local and online message contracts can break the Planning Panel tree if `planning.js` selection, refresh, and path update code still assumes a mixed `rootsReady` payload.
- Removing the adapter class from `ResearchImportService.ts` must not remove shared types (`ResearchFile`, `TreeNode`, `ResearchSourceAdapter`, `NotionResearchAdapter`, `ResearchImportService`) that Notion/ClickUp/Linear still require.
- `src/services/PlanningPanelProvider.ts` currently calls `_ensureAdaptersRegistered(workspaceRoot)` before every message. Local-folder messages must tolerate online adapter registration errors and still respond with `localDocsReady`.
- Race behavior changes because local and online payloads will arrive independently. The webview must update only the relevant pane and must not clear the online pane when local docs refresh, or clear the local pane when online docs refresh.
- The “< 50 lines of code for local-folder handling” success criterion is at risk if repeated inline mapping logic is copied across handlers. Use a small private helper for service creation and node mapping.
- Existing plan `fix_slow_local_docs_loading_fix_local_docs_taking_forever_to_load_in_planning_view_fix_local_docs_taking_forever_to_load_in_planning_view.md` in the plans folder targets overlapping local-docs performance code. It is already in the Reviewed column and therefore not an active Kanban dependency under `.agent/rules/how_to_plan.md`, but if its changes are not merged, this plan may require rebasing around `LocalFolderService.listFiles()` and `PlanningPanelProvider` local-folder handlers.

## Edge-Case & Dependency Audit
- **Race Conditions:** `localDocsReady` and `onlineDocsReady` are intentionally independent. The webview must preserve separate local and online DOM regions (`#tree-pane` and `#tree-pane-online`) so whichever message arrives second does not wipe the other pane. Preview request IDs in `PlanningPanelProvider._handleFetchPreview()` should remain source-keyed through `_latestRequestIds`, preserving current stale-response protection.
- **Security:** `LocalFolderService.fetchDocContent()` already validates path traversal with `path.resolve()` and a root prefix check. This plan must keep all local file reads routed through `LocalFolderService` rather than adding direct `fs.readFile()` calls in `PlanningPanelProvider`.
- **Side Effects:** Removing local-folder adapter registration means `ResearchImportService.getAvailableSources()` will no longer contain `local-folder`. Any source enumeration in `_handleFetchRoots()` must treat this as expected and build local docs separately. Online adapter behavior must remain unchanged for Notion, ClickUp, and Linear.
- **Dependencies & Conflicts:** Kanban check found `sess_1777206335666` in New (“Replace MCP Operations with Direct DB Access Skill”) and `sess_1777250066578` in Planned (this plan). `sess_1777206335666` concerns direct DB access skill work and does not overlap with `src/services/PlanningPanelProvider.ts`, `src/services/ResearchImportService.ts`, `src/webview/planning.js`, or `src/extension.ts`; no dependency is required. Plans-folder scan found a Reviewed plan, “Fix: Local Docs Taking Forever to Load in Planning View”, that touches `LocalFolderService` and Planning Panel local-docs handlers. Because it is in Reviewed, it is excluded as an active dependency by the planning guide, but implementers should check the current working tree before applying this plan to avoid duplicate or contradictory edits.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

None

## Adversarial Synthesis
### Grumpy Critique
*🎭 Grumpy Principal Engineer storms in, clutching the architecture diagram like it personally insulted him.*

This plan has the right instinct — rip local folders out of the adapter circus — but the original version was basically a sticky note taped to a moving train. “Delete adapter, simplify factory, flatten message handling.” Lovely. Where? Which files? Which consumers explode when the interface changes? What happens when the webview still waits for `rootsReady` while the backend proudly emits `localDocsReady` into the void?

The nastiest trap is that local-folder behavior is already half-direct and half-adapter. `_handleFetchChildren()` and `_handleFetchPreview()` special-case `sourceId === 'local-folder'`, but `_ensureAdaptersRegistered()` still registers `LocalFolderResearchAdapter`, and `_handleFetchRoots()` still mixes local and online concepts. That is not architecture; that is a haunted duplex.

Also, removing `getLocalFolderService` from `PlanningPanelAdapterFactories` without touching `src/extension.ts` is a TypeScript faceplant waiting to happen. And deleting `LocalFolderResearchAdapter` from `ResearchImportService.ts` without auditing exports risks collateral damage to the actual online adapters. We are removing one adapter, not performing a bonfire ceremony on the whole import service.

Finally, `localDocsReady` and `onlineDocsReady` are a protocol change. If the UI clears both panes on each message, the user gets flicker, disappearing trees, or a local pane that only works when ClickUp had a good breakfast. The whole point is independence; the webview must update panes independently.

### Balanced Response
The critique is valid. The strengthened plan below turns the original architectural direction into a bounded implementation spec with exact files, exact responsibilities, and verification gates.

The backend work is constrained to four files: `src/services/PlanningPanelProvider.ts`, `src/services/ResearchImportService.ts`, `src/extension.ts`, and `src/webview/planning.js`. `LocalFolderService` remains the only local filesystem abstraction, preserving existing path safety. Online adapters remain registered through `ResearchImportService`; only `LocalFolderResearchAdapter` is removed.

The message contract is split deliberately: `localDocsReady` always updates only the local pane, while `onlineDocsReady` updates only the online pane. This directly supports the original success criterion that local docs appear immediately even if online adapters are missing, slow, or broken.

The implementation also preserves existing user flows (`browseLocalFolder`, `setLocalFolderPath`, `fetchChildren`, `fetchPreview`) by changing service construction, not behavior. The final verification checks compile-time interface drift and webview message compatibility so the simplification does not become another invisible regression.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Implement the following changes in order. Do not add product behavior beyond the original requirements. Use the exact paths below; do not assume alternate locations.

### High Complexity Steps

#### Step H1 — Split backend root loading into local and online payloads
#### MODIFY `src/services/PlanningPanelProvider.ts`
- **Context:** `_handleFetchRoots()` currently constructs one mixed `rootsReady` message that includes a synthetic `local-folder` root and online roots from `ResearchImportService.getAvailableSources()`. This keeps local rendering tied to adapter registration and online source enumeration.
- **Logic:**
  1. Add a private helper `_getLocalFolderService(workspaceRoot: string): LocalFolderService` that returns `new LocalFolderService(workspaceRoot)`.
  2. Add a private helper `_mapLocalFilesToTreeNodes(files)` that returns `TreeNode[]` with `id`, `name`, `kind`, `parentId`, and `hasChildren`.
  3. In `_handleFetchRoots(workspaceRoot)`, fetch local docs first using direct `LocalFolderService` construction.
  4. Always post `localDocsReady` with `sourceId: 'local-folder'`, `nodes`, and `folderPath`. On failure, post `localDocsReady` with empty `nodes`, empty `folderPath`, and an `error` string.
  5. Then enumerate online sources from `ResearchImportService.getAvailableSources()`, excluding `local-folder` defensively even though it should no longer be registered.
  6. Post `onlineDocsReady` only for online roots. If no online adapters exist, post `onlineDocsReady` with an empty `roots` array so the webview can show “No online sources available”.
- **Implementation:**
  1. Insert these two private helpers in `src/services/PlanningPanelProvider.ts` immediately before `_handleFetchRoots()`:
```typescript
private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
    return new LocalFolderService(workspaceRoot);
}

private _mapLocalFilesToTreeNodes(files: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string }>): TreeNode[] {
    return files.map(f => ({
        id: f.relativePath || f.id,
        name: f.name,
        kind: f.isFolder ? 'folder' : 'document',
        parentId: f.parentId,
        hasChildren: f.isFolder === true
    }));
}
```
  2. Replace the full `_handleFetchRoots(workspaceRoot: string)` method in `src/services/PlanningPanelProvider.ts` with this complete method body:
```typescript
private async _handleFetchRoots(workspaceRoot: string): Promise<void> {
    try {
        const localFolderService = this._getLocalFolderService(workspaceRoot);
        const files = await localFolderService.listFiles();
        this._panel?.webview.postMessage({
            type: 'localDocsReady',
            sourceId: 'local-folder',
            folderPath: localFolderService.getFolderPath(),
            nodes: this._mapLocalFilesToTreeNodes(files)
        });
    } catch (err) {
        console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
        this._panel?.webview.postMessage({
            type: 'localDocsReady',
            sourceId: 'local-folder',
            folderPath: '',
            nodes: [],
            error: String(err)
        });
    }

    const roots = this._researchImportService
        .getAvailableSources()
        .filter(sourceId => sourceId !== 'local-folder')
        .map(sourceId => ({ sourceId, nodes: [] as TreeNode[] }));

    this._panel?.webview.postMessage({
        type: 'onlineDocsReady',
        roots,
        enabledSources: {
            clickup: true,
            linear: true,
            notion: true
        }
    });
}
```
- **Edge Cases Handled:** Local docs still render if online adapter registration fails. Online docs no longer receive a synthetic `local-folder` source. Local errors produce an empty local state instead of blocking the whole root load.

#### Step H2 — Update the webview message protocol without cross-pane resets
#### MODIFY `src/webview/planning.js`
- **Context:** `handleRootsReady(msg)` currently clears both `treePane` and `treePaneOnline`, then splits mixed roots into local and online arrays. After backend separation, this must become two independent handlers.
- **Logic:**
  1. Extract local rendering logic from `handleRootsReady()` into `renderLocalDocs(rootEntry)`.
  2. Extract online rendering logic into `renderOnlineDocs(roots, enabledSources)`.
  3. Add `handleLocalDocsReady(msg)` that updates only `#tree-pane`.
  4. Add `handleOnlineDocsReady(msg)` that updates only `#tree-pane-online`.
  5. Keep `handleRootsReady(msg)` as a compatibility shim that delegates to both renderers if any existing backend path still emits it during transition.
  6. In the existing Planning Panel message event handler in `src/webview/planning.js`, add switch cases for `localDocsReady` and `onlineDocsReady`.
- **Implementation:**
  1. Extract the existing local section of `handleRootsReady(msg)` into `renderLocalDocs(rootEntry)`. The complete behavior must create the local folder config row, preserve the existing refresh/browse/path controls, render `rootEntry.nodes` into `#tree-pane`, and show the existing empty-state text when no local nodes exist.
  2. Extract the existing online section of `handleRootsReady(msg)` into `renderOnlineDocs(roots, enabledSources)`. The complete behavior must render only `ONLINE_SOURCES` entries into `#tree-pane-online` and show `No online sources available` when `roots` is empty after filtering.
  3. Replace `handleRootsReady(msg)` with these complete functions:
```javascript
function handleLocalDocsReady(msg) {
    renderLocalDocs({
        sourceId: msg.sourceId || 'local-folder',
        nodes: msg.nodes || [],
        folderPath: msg.folderPath || '',
        error: msg.error
    });
}

function handleOnlineDocsReady(msg) {
    renderOnlineDocs(msg.roots || [], msg.enabledSources || {
        clickup: true,
        linear: true,
        notion: true
    });
}

function handleRootsReady(msg) {
    const roots = msg.roots || [];
    const localRoot = roots.find(({ sourceId }) => sourceId === 'local-folder');
    if (localRoot) {
        renderLocalDocs(localRoot);
    }
    renderOnlineDocs(
        roots.filter(({ sourceId }) => ONLINE_SOURCES.includes(sourceId)),
        msg.enabledSources
    );
}
```
  4. Add these exact switch cases to the existing `message` event switch:
```javascript
case 'localDocsReady':
    handleLocalDocsReady(msg);
    break;
case 'onlineDocsReady':
    handleOnlineDocsReady(msg);
    break;
```
- **Edge Cases Handled:** Local refresh does not blank online docs. Online refresh does not blank local docs. Existing `rootsReady` payloads remain readable during transition.

#### Step H3 — Remove local-folder adapter registration while preserving online adapters
#### MODIFY `src/services/PlanningPanelProvider.ts`
- **Context:** `_ensureAdaptersRegistered()` still registers `LocalFolderResearchAdapter`, which contradicts the plan’s central requirement that local-folder docs have no adapter registration dependency.
- **Logic:**
  1. Remove `LocalFolderResearchAdapter` from the import list.
  2. Remove the `getLocalFolderService` field from `PlanningPanelAdapterFactories`.
  3. Delete the local-folder block in `_ensureAdaptersRegistered()`.
  4. Keep Notion, Linear, and ClickUp registration unchanged.
- **Implementation:**
```diff
diff --git a/src/services/PlanningPanelProvider.ts b/src/services/PlanningPanelProvider.ts
--- a/src/services/PlanningPanelProvider.ts
+++ b/src/services/PlanningPanelProvider.ts
@@
 import {
     ResearchImportService,
     TreeNode,
-    NotionResearchAdapter,
-    LocalFolderResearchAdapter
+    NotionResearchAdapter
 } from './ResearchImportService';
@@
 export interface PlanningPanelAdapterFactories {
     getNotionService: (root: string) => NotionFetchService;
     getNotionBrowseService: (root: string) => NotionBrowseService;
-    getLocalFolderService: (root: string) => LocalFolderService;
     getLinearDocsAdapter: (root: string) => LinearDocsAdapter;
     getClickUpDocsAdapter: (root: string) => ClickUpDocsAdapter;
     getCacheService: (root: string) => PlanningPanelCacheService;
 }
@@
-        const localFolderService = this._adapterFactories.getLocalFolderService(workspaceRoot);
-        if (localFolderService) {
-            this._researchImportService.registerAdapter(
-                new LocalFolderResearchAdapter(localFolderService)
-            );
-        }
-
         const linearAdapter = this._adapterFactories.getLinearDocsAdapter(workspaceRoot);
```
- **Edge Cases Handled:** Online adapters remain registered exactly as before. The local source cannot be accidentally included in `ResearchImportService.getAvailableSources()`.

### Low Complexity Steps

#### Step L1 — Replace remaining Planning Panel local-folder factory calls
#### MODIFY `src/services/PlanningPanelProvider.ts`
- **Context:** `browseLocalFolder`, `setLocalFolderPath`, `_handleFetchChildren`, and `_handleFetchPreview` still call `this._adapterFactories.getLocalFolderService(workspaceRoot)`.
- **Logic:**
  1. In `browseLocalFolder`, replace the factory call with `this._getLocalFolderService(workspaceRoot)`.
  2. In `setLocalFolderPath`, replace the factory call with `this._getLocalFolderService(workspaceRoot)`.
  3. In `_handleFetchChildren`, replace the factory call with direct construction and map files using `this._mapLocalFilesToTreeNodes(files).filter(node => node.parentId === parentId || (!parentId && !node.parentId))`.
  4. In `_handleFetchPreview`, replace the factory call with direct construction.
  5. Remove impossible “service not found” branches for local-folder direct construction.
- **Implementation:**
```diff
diff --git a/src/services/PlanningPanelProvider.ts b/src/services/PlanningPanelProvider.ts
--- a/src/services/PlanningPanelProvider.ts
+++ b/src/services/PlanningPanelProvider.ts
@@
-                    const service = this._adapterFactories.getLocalFolderService(workspaceRoot);
+                    const service = this._getLocalFolderService(workspaceRoot);
@@
-                const service = this._adapterFactories.getLocalFolderService(workspaceRoot);
+                const service = this._getLocalFolderService(workspaceRoot);
@@
-            const localFolderService = this._adapterFactories.getLocalFolderService(workspaceRoot);
-            if (!localFolderService) {
-                this._panel?.webview.postMessage({ type: 'childrenReady', sourceId, parentId, nodes: [] });
-                return;
-            }
+            const localFolderService = this._getLocalFolderService(workspaceRoot);
@@
-            const localFolderService = this._adapterFactories.getLocalFolderService(workspaceRoot);
-            if (!localFolderService) {
-                this._panel?.webview.postMessage({ type: 'previewError', sourceId, requestId, error: 'Local folder service not found' });
-                return;
-            }
+            const localFolderService = this._getLocalFolderService(workspaceRoot);
```
- **Edge Cases Handled:** Direct construction prevents a missing factory from blocking local docs. Existing `LocalFolderService` path safety and config lookup remain centralized.

#### Step L2 — Delete `LocalFolderResearchAdapter`
#### MODIFY `src/services/ResearchImportService.ts`
- **Context:** The local adapter adds indirection with no benefit once Planning Panel handles local-folder messages directly.
- **Logic:**
  1. Remove `import { LocalFolderService } from './LocalFolderService';`.
  2. Delete `export class LocalFolderResearchAdapter implements ResearchSourceAdapter`.
  3. Leave `ResearchFile`, `TreeNode`, `ResearchSourceAdapter`, `NotionResearchAdapter`, and `ResearchImportService` unchanged.
  4. Leave Linear/ClickUp imports untouched because their adapters are referenced by the shared interface and online docs flow.
- **Implementation:**
  1. Delete this import from the top of `src/services/ResearchImportService.ts`:
```typescript
import { LocalFolderService } from './LocalFolderService';
```
  2. Delete the entire `LocalFolderResearchAdapter` class block beginning at:
```typescript
export class LocalFolderResearchAdapter implements ResearchSourceAdapter {
```
  and ending immediately before:
```typescript
export class ResearchImportService {
```
  3. Confirm the file still contains `export class ResearchImportService` exactly once after the deletion.
- **Edge Cases Handled:** Removing only the local adapter avoids breaking online docs. TypeScript will catch any lingering import of `LocalFolderResearchAdapter`.

#### Step L3 — Update Planning Panel construction
#### MODIFY `src/extension.ts`
- **Context:** `PlanningPanelAdapterFactories` will no longer accept `getLocalFolderService`, so construction at lines 1330-1337 must match the new interface.
- **Logic:**
  1. Remove only `getLocalFolderService: (root) => new LocalFolderService(root),` from the `PlanningPanelProvider` factory object.
  2. Keep `PlannerPromptWriter` construction at lines 1312-1319 unchanged because that is a separate dependency injection contract.
  3. Keep the top-level `LocalFolderService` import because `PlannerPromptWriter` still uses it.
- **Implementation:**
```diff
diff --git a/src/extension.ts b/src/extension.ts
--- a/src/extension.ts
+++ b/src/extension.ts
@@
         {
             getNotionService: (root) => (kanbanProvider as any)._getNotionService(root),
             getNotionBrowseService: (root) => (kanbanProvider as any)._getNotionBrowseService(root),
-            getLocalFolderService: (root) => new LocalFolderService(root),
             getLinearDocsAdapter: (root) => (kanbanProvider as any)._getLinearDocsAdapter(root),
             getClickUpDocsAdapter: (root) => (kanbanProvider as any)._getClickUpDocsAdapter(root),
             getCacheService
         },
```
- **Edge Cases Handled:** Avoids broad DI churn. `PlannerPromptWriter` still receives the local service factory it requires.

#### Step L4 — Preserve online docs behavior
#### MODIFY `src/services/PlanningPanelProvider.ts`
- **Context:** Online docs must continue working via the existing adapter system.
- **Logic:**
  1. Keep `_ensureAdaptersRegistered(workspaceRoot)` execution at the start of `_handleMessage()`.
  2. Keep Notion, Linear, and ClickUp registration in `_ensureAdaptersRegistered()`.
  3. Keep online `fetchChildren`, `fetchPreview`, `fetchContainers`, `fetchFilteredDocs`, `fetchDocPages`, and `fetchPageContent` adapter branches unchanged except where needed to consume `onlineDocsReady` root state.
  4. Confirm `ResearchImportService.getAdapter(sourceId)` is still used for `clickup`, `linear`, and `notion`.
- **Implementation:**
```diff
diff --git a/src/services/PlanningPanelProvider.ts b/src/services/PlanningPanelProvider.ts
--- a/src/services/PlanningPanelProvider.ts
+++ b/src/services/PlanningPanelProvider.ts
@@
         const notionService = this._adapterFactories.getNotionService(workspaceRoot);
         const notionBrowseService = this._adapterFactories.getNotionBrowseService(workspaceRoot);
@@
         const linearAdapter = this._adapterFactories.getLinearDocsAdapter(workspaceRoot);
@@
         const clickUpAdapter = this._adapterFactories.getClickUpDocsAdapter(workspaceRoot);
```
- **Edge Cases Handled:** This is a guardrail step: do not simplify away online adapter code while removing local-folder adapter code.

## Success Criteria
- Local folder appears immediately on panel open (even if empty/unconfigured).
- No dependency on adapter registration.
- < 50 lines of code for local-folder handling.
- Online docs continue working via existing adapter system.
- `src/services/ResearchImportService.ts` no longer exports `LocalFolderResearchAdapter`.
- `src/services/PlanningPanelProvider.ts` no longer imports or registers `LocalFolderResearchAdapter`.
- `PlanningPanelAdapterFactories` no longer contains `getLocalFolderService`.
- `src/extension.ts` no longer passes `getLocalFolderService` into `PlanningPanelProvider`, while still passing it into `PlannerPromptWriter`.
- `src/webview/planning.js` handles `localDocsReady` and `onlineDocsReady` independently.

## Verification Plan
### Automated Tests
- Run `npm run compile` from `/Users/patrickvuleta/Documents/GitHub/switchboard`.
- Run `npm run lint` from `/Users/patrickvuleta/Documents/GitHub/switchboard`.
- Run `npm run test:contract:research-modal` from `/Users/patrickvuleta/Documents/GitHub/switchboard` to check research/planning modal message contract behavior.

### Manual Verification
- Open the Planning Panel with no local folder configured. Confirm the Local Docs pane appears immediately and shows an empty/not-configured state without waiting for online docs.
- Configure a valid local folder. Confirm files appear in Local Docs and previews still load through `fetchPreview` with `sourceId: 'local-folder'`.
- Configure or leave online sources unchanged. Confirm Online Docs still lists Notion/ClickUp/Linear roots and children through adapter-backed flows.
- Trigger refresh for local docs. Confirm the online pane is not cleared.
- Trigger online source refresh. Confirm the local pane and selected local preview are not cleared.
- Confirm compile errors do not reference `LocalFolderResearchAdapter` or `getLocalFolderService` on `PlanningPanelAdapterFactories`.

## Reviewer Pass Results

### Review Date
2026-04-27

### Stage 1: Grumpy Adversarial Findings

| ID | Severity | Finding |
|----|----------|---------|
| R1 | CRITICAL | `refreshSource` handler called `_handleFetchRoots()` for all sources, sending both `localDocsReady` and `onlineDocsReady` on every refresh. This wiped both panes on any single-source refresh, violating the core pane-independence requirement. |
| R2 | MAJOR | `enabledSources` in `onlineDocsReady` is hardcoded to `{ clickup: true, linear: true, notion: true }` regardless of actual adapter registration. Not a functional bug today (webview only renders headers for sources in `roots`), but a protocol lie for future consumers. |
| R3 | NIT | `renderLocalDocs` always sends `fetchImportedDocs` on every `localDocsReady` message, causing unnecessary re-fetches on refresh. Pre-existing. |
| R4 | NIT | `_handleFetchChildren` for local-folder re-reads entire directory tree via `listFiles()` then filters by `parentId`. Pre-existing inefficiency. |

### Stage 2: Balanced Synthesis

- **R1 (CRITICAL) — Fixed.** Split `_handleFetchRoots` into `_sendLocalDocsReady` and `_sendOnlineDocsReady`. `refreshSource` now calls only the relevant method based on `sourceId`. `_handleFetchRoots` delegates to both for initial panel load.
- **R2 (MAJOR) — Deferred.** Not a functional bug; `renderOnlineDocs` only renders sources present in `roots`. Should be derived from actual adapter registration in a follow-up.
- **R3 (NIT) — Deferred.** Pre-existing, low impact.
- **R4 (NIT) — Deferred.** Pre-existing, low impact.

### Code Fixes Applied

| File | Change |
|------|--------|
| `src/services/PlanningPanelProvider.ts` | Extracted `_sendLocalDocsReady(workspaceRoot)` and `_sendOnlineDocsReady()` from `_handleFetchRoots`. `_handleFetchRoots` now delegates to both. `refreshSource` handler routes to only the relevant method based on `sourceId === 'local-folder'`. |

### Validation Results

- **`npm run compile`**: ✅ Passes (webpack 5.105.4 compiled successfully)
- **`npx tsc --noEmit`**: 2 pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (module resolution — unrelated to plan changes)
- **`LocalFolderResearchAdapter` removed**: ✅ Confirmed — no references in `src/` (only in `.bak3` backup file)
- **`PlanningPanelAdapterFactories.getLocalFolderService` removed**: ✅ Confirmed — interface and factory object no longer contain it
- **`extension.ts` still passes `getLocalFolderService` to `PlannerPromptWriter`**: ✅ Confirmed at line 1314
- **Webview handles `localDocsReady`/`onlineDocsReady`**: ✅ Confirmed — switch cases at planning.js lines 1127-1132
- **`handleRootsReady` compatibility shim preserved**: ✅ Confirmed at planning.js lines 577-587

### Remaining Risks

1. **`enabledSources` hardcoding** — `onlineDocsReady` always claims all three online sources are enabled. If a future consumer uses `enabledSources` for feature gating, it will incorrectly show unavailable sources as available. Low risk today.
2. **`renderLocalDocs` re-fetches imported docs** — Every `localDocsReady` triggers a `fetchImportedDocs` message. On rapid refresh, this could cause duplicate imported-docs fetches. Low impact.
3. **No automated contract test for `localDocsReady`/`onlineDocsReady`** — The plan references `npm run test:contract:research-modal` but no specific test for the new message types was added. Manual verification required.

## Recommended Agent
Send to Lead Coder
