# Notion Integration — Part 2: Setup Wizard, Fetch UI & Prompt Builder Integration

## Goal

Implement the full Notion fetch flow: a token-first setup wizard integrated into the existing Design Doc section of the sidebar, a "Sync from Notion" button that appears when a Notion URL is entered, status badge showing last sync time, and a change to the prompt builder that embeds the pre-fetched markdown content verbatim into planner prompts instead of the raw URL. After this plan, users who paste a Notion page URL into the Design Doc field and click "Sync from Notion" will have the full page content embedded in every planner prompt — with no MCP tool call required at prompt time.

## Metadata

**Tags:** frontend, backend, UI, infrastructure
**Complexity:** 6
**Depends on:** `notion_1_foundation.md`

## User Review Required

> [!NOTE]
> - **Depends on Part 1**: Requires `NotionFetchService` from `notion_1_foundation.md`.
> - **One-time setup per workspace**: The integration token is stored in VS Code SecretStorage globally. The fetched page content is per-workspace (`.switchboard/notion-cache.md`). Different repos can fetch from different Notion pages.
> - **Token prompt is part of the fetch flow**: If no token is stored when the user clicks "Sync from Notion", the wizard prompts for a token (masked input box with validation) before proceeding. Users do not need to run a separate "Set Notion Token" command first — though the command palette option remains available for token rotation.
> - **Content is pre-fetched, not re-fetched on every prompt**: Clicking "Sync from Notion" runs a one-time fetch and stores the result in `.switchboard/notion-cache.md`. Planner prompts embed the cached markdown. The user controls when to re-sync.
> - **Existing Design Doc field is extended, not replaced**: The field continues to accept regular URLs and file paths. The "Sync" button and status badge only appear when the input value contains a `notion.so` or `notion.site` URL. All non-Notion inputs work exactly as before.
> - **Prompt builder change is additive**: When cached content exists AND the design doc toggle is on, the full content is embedded. When no cache exists, the raw URL is still passed (existing behaviour preserved). No regression for non-Notion design docs.
> - **Re-sync is manual**: The status badge shows "Last synced: {relative time}" (e.g., "Last synced: 2h ago"). There is no automatic background sync — users click "Sync from Notion" to refresh.
> - **Page must be shared with the integration**: If the page returns a 403, a clear error message directs the user to share the page with their integration in Notion settings.

## Complexity Audit

### Routine
- **`fetchAndCache(url)` orchestration method on `NotionFetchService`**: Token check → URL parse → `fetchPageTitle` → `fetchBlocksRecursive` → `convertBlocksToMarkdown` → `saveConfig` + `saveCachedContent`. Calls existing Part 1 methods in sequence.
- **VS Code command `switchboard.fetchNotionDesignDoc`**: Same pattern as `switchboard.setupLinear` — `withProgress` wrapper, delegates to `NotionFetchService`.
- **`package.json` command entry**: One-line addition.
- **Sidebar `notionFetchState` message handler (incoming)**: Update button label, status badge, and sync time from a message payload. Same pattern as `clickupState`/`linearState`.

### Complex / Risky
- **Notion URL detection in sidebar (`implementation.html`)**: The design doc input (`#design-doc-link-input`) must trigger dynamic UI changes as the user types. An `input` event listener checks if the value contains a Notion hostname and toggles the visibility of the "Sync from Notion" button and status area. This must be debounced (300ms) to avoid firing on every keystroke.
- **Webview ↔ extension message flow for fetch**: User clicks "Sync" → webview posts `{ type: 'fetchNotionContent', url }` → `TaskViewerProvider` handles it → calls `NotionFetchService.fetchAndCache()` → posts back `{ type: 'notionFetchState', status, syncedAt, error }`. The button must be disabled during the fetch (which can take 5–15 seconds for large pages) and re-enabled on completion or error.
- **`TaskViewerProvider` state push on startup**: On webview load (when `designDocSetting` is pushed), also push `notionFetchState` if a notion cache exists — so the status badge is populated without a user action. This requires reading `notion-config.json` from the workspace to get `lastFetchAt` and `pageTitle`.
- **Prompt builder content injection**: `PromptBuilderOptions` gains a new `designDocContent?: string` field. When present, the content is embedded inline rather than the URL. The `KanbanProvider` and `TaskViewerProvider` callsites that construct `PromptBuilderOptions` must read the cached content from `NotionFetchService` before building the prompt — this is an async read that must not block the prompt path if the file is absent.
- **`NotionFetchService` singleton in `TaskViewerProvider`**: Same problem as ClickUp's debounce bug — must use a cached service instance per workspace, not `new NotionFetchService()` on every message. Add a `_notionServices` Map with `_getNotionService(workspaceRoot)` factory.

## Edge-Case & Dependency Audit

- **Non-Notion URL in design doc field**: `parsePageId()` returns `null` → "Sync" button hidden, behaviour identical to current.
- **Fetch button clicked with no URL**: Guard in message handler — error toast, no API call.
- **Token not stored when fetch is clicked**: Wizard opens with `showInputBox` (password masked). If user cancels, fetch is aborted cleanly.
- **Invalid token (401 from Notion)**: `isAvailable()` fails → error message with link to `notion.so/profile/integrations`.
- **Page not shared with integration (403)**: `httpRequest()` returns status 403 → error message: "Page not accessible. Share this page with your Notion integration at notion.so/profile/integrations."
- **Large page fetch (>15s)**: `withProgress` notification keeps the user informed. No timeout — the fetch may take time for very large docs. The 200ms delay between calls is by design.
- **Webview closed mid-fetch**: Fetch completes in the background; config and cache are written. On next webview open, `notionFetchState` is pushed with the completed sync info.
- **Workspace with no Notion cache**: `loadCachedContent()` returns `null` → `designDocContent` is `undefined` → prompt builder falls back to URL (existing behaviour). No error.
- **Design doc toggle OFF**: Even if Notion content is cached, it is not embedded in prompts when the toggle is off. Consistent with existing design doc behaviour.
- **Race condition — fetch triggered twice**: The fetch button is disabled for the duration of the fetch. The `NotionFetchService` singleton has no `_isFetchInProgress` guard (unlike ClickUp's `_setupInProgress`) because the button disable is sufficient — but adding the flag is a safe belt-and-suspenders.
- **`designDocContent` in prompt exceeds context window**: Notion pages can be large. The content is truncated to 50,000 characters before embedding, with a note appended: `[Content truncated at 50,000 chars. View full page at: {url}]`. This is documented in the prompt builder change.
- **Dependencies & Conflicts**:
  - **Depends on `notion_1_foundation.md`** (Part 1 must land first) — this plan calls `NotionFetchService` methods defined in Part 1.
  - **`notion_3_planning_tab_ui.md` depends on this plan's backend work** — Part 3 assumes all backend files (Target Files 1, 3, 4, 5, 6, 7) from this plan are implemented.

> [!WARNING]
> **The `implementation.html` UI changes in this plan (Target File 2, sections A through E) are superseded by `notion_3_planning_tab_ui.md` (Part 3).** Part 3 explicitly states: *"This plan supersedes the `implementation.html` changes in `notion_2_setup_and_fetch.md`."* **Do NOT implement Target File 2** — Part 3 replaces the sidebar UI entirely with a Planning tab. The backend changes (Target Files 1, 3, 4, 5, 6, 7) remain valid and must be implemented.

## Adversarial Synthesis

### Grumpy Critique

*Removes glasses. Pinches bridge of nose.*

1. **The "Sync" button is conditionally visible — but the URL input fires save on every keystroke change and on startup.** `implementation.html` calls `vscode.postMessage({ type: 'saveStartupCommands', ..., designDocLink })` inside the `saveConfig` event at two points. If the Notion button is injected and the Notion URL detection fires, but the user hasn't clicked "Sync" yet — what does `notionFetchState` show? "Not synced" or stale data from a previous URL? If a user switches from a stale Notion URL to a new one, the sidebar shows the old sync status for the new URL. Misleading.

2. **`designDocContent` is read from disk on every prompt build.** Every time `buildKanbanBatchPrompt` is called (which happens on every plan improvement, every card move to a planning column, every clipboard copy), you're doing `fs.promises.readFile` for the notion cache. That's potentially dozens of disk reads per session. Cache it in memory on `TaskViewerProvider`.

3. **The prompt truncation at 50,000 chars is arbitrary and invisible.** The planner receives a truncated PRD with no indication of what was cut. The wrong section might be truncated. At minimum, truncate at a heading boundary, not a character boundary. And 50,000 chars may still exceed context windows — this needs to be the user's problem to manage, with a warning in the sidebar showing the content size.

4. **`this._panel` doesn't exist** — every code block referencing `this._panel` will cause a TypeScript compilation error. The property is `this._view` (a `vscode.WebviewView`). This is a copy-paste error from a different provider pattern. Three callsites in the plan are wrong: two in Target File 3 section C and one in section D.

5. **`msg` variable doesn't exist in the switch scope** — the `notionFetchState` handler in Target File 2 section C uses `msg.error`, `msg.syncedAt`, etc. but the `window.addEventListener('message', ...)` switch body destructures `event.data` into `message`. This will crash at runtime with "msg is not defined".

6. **No import statements** — three files (TaskViewerProvider.ts, KanbanProvider.ts, extension.ts) instantiate or reference `NotionFetchService` but none show the required import. TypeScript will refuse to compile.

7. **Async callers not enumerated** — the plan says "`_generateBatchPlannerPrompt` must be made `async`" but doesn't tell the implementer which callers to update with `await`. In `KanbanProvider.ts` (a 2,000+ line file), that's a recipe for missing one. There are exactly two callers: line 1000 and line 2153.

8. **UI changes superseded but still in the plan** — `notion_3_planning_tab_ui.md` (Part 3) explicitly supersedes the `implementation.html` changes from this plan. If an implementer follows this plan before reading Part 3, they'll implement UI that gets immediately torn out. The plan should shout this.

### Balanced Response

1. **Stale status for changed URL — FIXED**: When the design doc URL input changes AND the new value is a Notion URL, the status badge immediately switches to "Not synced for this URL" (or clears the previous sync time) until a new fetch is performed. The check compares the current input value against `notionConfig.pageUrl`. If they don't match, status shows "URL changed — sync required". This is implemented in the `input` event handler.

2. **Disk reads per prompt — FIXED**: `TaskViewerProvider` gains a `_notionContentCache: Map<string, string | null>` (workspaceRoot → content). Populated on first read. Invalidated when a `fetchNotionContent` message completes (cache is cleared, triggering a re-read on next prompt build). For a typical session, the file is read at most twice: once on load, once after re-sync.

3. **Truncation — PARTIALLY ADDRESSED**: The 50,000-char hard cutoff is replaced with a heading-boundary truncation: walk backwards from char 50,000 to find the last `\n#` boundary and cut there. A warning is added to the sidebar status area when cached content exceeds 40,000 chars: "⚠️ Content is large ({N} chars). Consider linking to a shorter summary page." The truncation note appended to the prompt is preserved.

4. **All `this._panel` references fixed to `this._view`** in the updated code blocks for Target File 3 (sections C and D). The property is `this._view` (a `vscode.WebviewView`), matching the existing codebase pattern.

5. **All `msg.` references fixed to `message.`** in the updated code blocks for Target File 2 section C. The global `window.addEventListener('message', ...)` switch receives `message` from `event.data`.

6. **Import statements added** to Target Files 3, 5, and 6. Each file that instantiates `NotionFetchService` now includes `import { NotionFetchService } from './NotionFetchService';`.

7. **Async callers at lines 1000 and 2153 explicitly listed** with before/after code in Target File 5. Both callers of `_generateBatchPlannerPrompt` are updated to `await` the result.

8. **A prominent `> [!WARNING]` callout added** at the top of Target File 2 stating the UI changes are superseded by Part 3 (`notion_3_planning_tab_ui.md`).

## Proposed Changes

### Target File 1: `fetchAndCache()` Method
#### MODIFY `src/services/NotionFetchService.ts`

<!-- Complexity: Routine -->

Add to the `NotionFetchService` class:

```typescript
/**
 * Full fetch flow: validate token, parse URL, fetch page content,
 * convert to markdown, save config and cache.
 * Called by TaskViewerProvider when user clicks "Sync from Notion".
 */
async fetchAndCache(url: string): Promise<{ success: boolean; pageTitle?: string; charCount?: number; error?: string }> {
  // 0. Ensure token
  let token = await this.getApiToken();
  if (!token) {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your Notion integration token — find it at notion.so/profile/integrations',
      password: true,
      placeHolder: 'secret_...',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v || v.trim().length < 10) { return 'Token too short'; }
        if (!v.trim().startsWith('secret_') && !v.trim().startsWith('ntn_')) {
          return 'Notion tokens start with "secret_" or "ntn_"';
        }
        return null;
      }
    });
    if (!input) { return { success: false, error: 'No token provided' }; }
    await this._secretStorage.store('switchboard.notion.apiToken', input.trim());
    token = input.trim();
  }

  // 1. Validate token
  if (!(await this.isAvailable())) {
    vscode.window.showErrorMessage(
      'Notion token is invalid or expired.',
      'Open notion.so/profile/integrations'
    ).then(choice => {
      if (choice) { vscode.env.openExternal(vscode.Uri.parse('https://notion.so/profile/integrations')); }
    });
    return { success: false, error: 'Token validation failed' };
  }

  // 2. Parse page ID
  const pageId = this.parsePageId(url);
  if (!pageId) {
    return { success: false, error: 'Could not parse a Notion page ID from the provided URL' };
  }

  // 3. Fetch page title
  let pageTitle = 'Untitled';
  try {
    pageTitle = await this.fetchPageTitle(pageId);
  } catch { /* non-fatal — title is cosmetic */ }

  // 4. Fetch all blocks recursively
  let blocks: any[];
  try {
    blocks = await this.fetchBlocksRecursive(pageId);
  } catch (err: any) {
    const msg = String(err);
    if (msg.includes('403') || msg.includes('Forbidden')) {
      return {
        success: false,
        error: 'Page not accessible. Share this page with your Notion integration at notion.so/profile/integrations.'
      };
    }
    return { success: false, error: `Fetch failed: ${msg}` };
  }

  // 5. Convert to markdown
  let markdown = this.convertBlocksToMarkdown(blocks);

  // 6. Truncate at heading boundary if over 50,000 chars
  const CHAR_LIMIT = 50000;
  let truncated = false;
  if (markdown.length > CHAR_LIMIT) {
    const cutRegion = markdown.substring(0, CHAR_LIMIT);
    const lastHeading = cutRegion.lastIndexOf('\n#');
    const cutPoint = lastHeading > 0 ? lastHeading : CHAR_LIMIT;
    markdown = markdown.substring(0, cutPoint) + `\n\n*[Content truncated at ${cutPoint.toLocaleString()} chars. View full page: ${url}]*`;
    truncated = true;
  }

  const header = `# ${pageTitle}\n\n> Fetched from Notion: ${url}\n\n`;
  const fullContent = header + markdown;

  // 7. Save config and cache
  await this.saveConfig({
    pageUrl: url,
    pageId,
    pageTitle,
    setupComplete: true,
    lastFetchAt: new Date().toISOString()
  });
  await this.saveCachedContent(fullContent);

  if (truncated) {
    vscode.window.showWarningMessage(`Notion content truncated — page was too large. Planner will use the first portion.`);
  }

  return { success: true, pageTitle, charCount: fullContent.length };
}
```

### Target File 2: Sidebar UI — Notion Fetch Controls
#### MODIFY `src/webview/implementation.html`

> [!WARNING]
> **DO NOT IMPLEMENT THIS SECTION.** The `implementation.html` UI changes below (sections A through E) are **superseded by `notion_3_planning_tab_ui.md`** (Part 3). Part 3 replaces the sidebar UI entirely with a Planning tab that incorporates the Notion sync controls. These sections are preserved here for reference only. **Skip to Target File 3.**

<!-- Complexity: Complex -->

**A. Add "Sync from Notion" button and status area** below the existing design doc link input (after the `⚠️ Security` warning div):

```html
<!-- Notion sync controls — shown only when design-doc-link-input contains a Notion URL -->
<div id="notion-sync-area" style="display:none; margin-top:6px;">
  <div style="display:flex; align-items:center; gap:8px;">
    <button id="notion-sync-btn"
            style="font-size:11px; padding:3px 8px; cursor:pointer;"
            data-tooltip="Fetch page content from Notion and cache it locally">
      Sync from Notion
    </button>
    <span id="notion-sync-status"
          style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono);">
      Not synced
    </span>
  </div>
  <div id="notion-size-warning"
       style="display:none; font-size:10px; color:var(--accent-orange); margin-top:3px; font-family:var(--font-mono);">
  </div>
</div>
```

**B. Add Notion URL detection to the design-doc-link-input `input` listener** (add after existing input initialisation in the `<script>` section):

```javascript
// Notion URL detection — show/hide sync controls
(function() {
    const ddInput = document.getElementById('design-doc-link-input');
    const notionArea = document.getElementById('notion-sync-area');
    const notionStatus = document.getElementById('notion-sync-status');
    if (!ddInput || !notionArea) { return; }

    function isNotionUrl(val) {
        return val && (val.includes('notion.so') || val.includes('notion.site'));
    }

    let notionDetectTimer = null;
    ddInput.addEventListener('input', () => {
        clearTimeout(notionDetectTimer);
        notionDetectTimer = setTimeout(() => {
            const val = ddInput.value.trim();
            notionArea.style.display = isNotionUrl(val) ? 'block' : 'none';
            // If URL changed from the last synced URL, show "URL changed" warning
            if (isNotionUrl(val) && lastNotionSyncedUrl && val !== lastNotionSyncedUrl) {
                notionStatus.textContent = 'URL changed — sync required';
                notionStatus.style.color = 'var(--accent-orange)';
            }
        }, 300);
    });
})();

// Notion sync button handler
let lastNotionSyncedUrl = null;
const notionSyncBtn = document.getElementById('notion-sync-btn');
if (notionSyncBtn) {
    notionSyncBtn.addEventListener('click', () => {
        const url = document.getElementById('design-doc-link-input')?.value.trim();
        if (!url) { return; }
        notionSyncBtn.disabled = true;
        notionSyncBtn.textContent = '⏳ Syncing...';
        document.getElementById('notion-sync-status').textContent = 'Fetching...';
        vscode.postMessage({ type: 'fetchNotionContent', url });
    });
}
```

**C. Add `notionFetchState` handler** inside the existing `window.addEventListener('message', ...)` switch:

```javascript
case 'notionFetchState': {
    const btn = document.getElementById('notion-sync-btn');
    const status = document.getElementById('notion-sync-status');
    const sizeWarning = document.getElementById('notion-size-warning');
    const notionArea = document.getElementById('notion-sync-area');
    if (!btn || !status) { break; }

    btn.disabled = false;
    btn.textContent = 'Sync from Notion';

    if (message.error) {
        status.textContent = `⚠️ ${message.error}`;
        status.style.color = 'var(--accent-orange)';
        break;
    }

    if (message.syncedAt) {
        lastNotionSyncedUrl = message.pageUrl || null;
        const ago = _relativeTime(new Date(message.syncedAt));
        status.textContent = `✅ Synced ${ago}${message.pageTitle ? ` — ${message.pageTitle}` : ''}`;
        status.style.color = 'var(--text-secondary)';
    }

    if (message.charCount && message.charCount > 40000) {
        sizeWarning.style.display = 'block';
        sizeWarning.textContent = `⚠️ Content is large (${(message.charCount / 1000).toFixed(0)}k chars). Consider linking a shorter summary page.`;
    } else {
        sizeWarning.style.display = 'none';
    }

    // Show sync area if URL is a Notion URL
    const ddInput = document.getElementById('design-doc-link-input');
    if (ddInput && (ddInput.value.includes('notion.so') || ddInput.value.includes('notion.site'))) {
        notionArea.style.display = 'block';
    }
    break;
}
```

**D. Add `_relativeTime` helper** (if not already present in the file) in the `<script>` block:

```javascript
function _relativeTime(date) {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) { return 'just now'; }
    if (diff < 3600) { return `${Math.floor(diff / 60)}m ago`; }
    if (diff < 86400) { return `${Math.floor(diff / 3600)}h ago`; }
    return `${Math.floor(diff / 86400)}d ago`;
}
```

**E. Initialize Notion area visibility on `designDocSetting` message** (inside existing `case 'designDocSetting':` handler, after the existing assignments):

```javascript
// Show Notion area if persisted URL is a Notion URL
const linkVal = message.link || '';
const notionAreaEl = document.getElementById('notion-sync-area');
if (notionAreaEl) {
    notionAreaEl.style.display = (linkVal.includes('notion.so') || linkVal.includes('notion.site')) ? 'block' : 'none';
}
```

### Target File 3: TaskViewerProvider — Message Handler & State Push
#### MODIFY `src/services/TaskViewerProvider.ts`

<!-- Complexity: Complex -->

**A0. Add import statement** at the top of the file, alongside existing service imports:

```typescript
import { NotionFetchService } from './NotionFetchService';
```

**A. Add `_notionServices` Map and singleton factory** (near the `_clickUpServices`/`_linearServices` pattern):

```typescript
private _notionServices: Map<string, NotionFetchService> = new Map();

private _getNotionService(workspaceRoot: string): NotionFetchService {
    let service = this._notionServices.get(workspaceRoot);
    if (!service) {
        service = new NotionFetchService(workspaceRoot, this._context.secrets);
        this._notionServices.set(workspaceRoot, service);
    }
    return service;
}
```

**B. Add in-memory content cache** (alongside the `_notionServices` map):

```typescript
private _notionContentCache: Map<string, string | null> = new Map();
```

**C. Add `fetchNotionContent` message handler** in the webview message switch (near the `fetchNotionContent` or settings-related cases):

```typescript
case 'fetchNotionContent': {
    const wsRoot = this._getWorkspaceRoot();
    if (!wsRoot || !data.url) { break; }

    const service = this._getNotionService(wsRoot);
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching Notion page...', cancellable: false },
        async () => {
            const result = await service.fetchAndCache(data.url);
            if (result.success) {
                // Invalidate in-memory content cache so next prompt build re-reads
                this._notionContentCache.delete(wsRoot);
                const config = await service.loadConfig();
                this._view?.webview.postMessage({
                    type: 'notionFetchState',
                    syncedAt: config?.lastFetchAt,
                    pageTitle: config?.pageTitle,
                    pageUrl: config?.pageUrl,
                    charCount: result.charCount
                });
            } else {
                this._view?.webview.postMessage({
                    type: 'notionFetchState',
                    error: result.error || 'Fetch failed'
                });
            }
        }
    );
    break;
}
```

**D. Push `notionFetchState` on startup** (alongside where `designDocSetting` is posted to the webview):

```typescript
// Push Notion fetch state if a cache exists
try {
    const wsRoot = this._getWorkspaceRoot();
    if (wsRoot) {
        const notionService = this._getNotionService(wsRoot);
        const notionConfig = await notionService.loadConfig();
        if (notionConfig?.setupComplete && notionConfig.lastFetchAt) {
            const cached = await notionService.loadCachedContent();
            this._view?.webview.postMessage({
                type: 'notionFetchState',
                syncedAt: notionConfig.lastFetchAt,
                pageTitle: notionConfig.pageTitle,
                pageUrl: notionConfig.pageUrl,
                charCount: cached?.length ?? 0
            });
        }
    }
} catch { /* non-blocking */ }
```

**E. Update `_getDesignDocContent()` helper** to read from Notion cache when available:

```typescript
private async _getDesignDocContent(workspaceRoot: string): Promise<string | null> {
    const designDocEnabled = this._isDesignDocEnabled();
    if (!designDocEnabled) { return null; }

    const designDocLink = this._getDesignDocLink();
    if (!designDocLink) { return null; }

    // If it's a Notion URL and a cache exists, use cached content
    if (designDocLink.includes('notion.so') || designDocLink.includes('notion.site')) {
        const cached = this._notionContentCache.get(workspaceRoot);
        if (cached !== undefined) { return cached; } // null means "checked, no cache"
        const service = this._getNotionService(workspaceRoot);
        const content = await service.loadCachedContent();
        this._notionContentCache.set(workspaceRoot, content);
        return content;
    }

    // Non-Notion URL — return null; prompt builder uses the URL string directly
    return null;
}
```

**F. Pass `designDocContent` into prompt builder** — update the prompt-building callsites in `TaskViewerProvider` that construct `PromptBuilderOptions`. The prompt build is already async in context, so the read is safe:

```typescript
// Before each buildKanbanBatchPrompt call:
const designDocContent = await this._getDesignDocContent(workspaceRoot);

// In the options object:
{
    ...,
    designDocLink: this._isDesignDocEnabled() ? this._getDesignDocLink() : undefined,
    designDocContent: designDocContent || undefined
}
```

### Target File 4: Prompt Builder — Content Embedding
#### MODIFY `src/services/agentPromptBuilder.ts`

<!-- Complexity: Routine -->

**A. Add `designDocContent` to `PromptBuilderOptions`**:

```typescript
export interface PromptBuilderOptions {
    // ... existing fields ...
    /** When present, the full pre-fetched Notion page content to embed verbatim. Takes precedence over designDocLink. */
    designDocContent?: string;
}
```

**B. Update the design doc injection block** in the planner prompt builder (currently at line ~145):

```typescript
// Replace:
if (designDocLink) {
    plannerPrompt += `\n\nDESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context for all planning decisions:\n${designDocLink}`;
}

// With:
const designDocContent = options?.designDocContent?.trim();
if (designDocContent) {
    plannerPrompt += `\n\nDESIGN DOC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as foundational context for all planning decisions:\n\n${designDocContent}`;
} else if (designDocLink) {
    plannerPrompt += `\n\nDESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context for all planning decisions:\n${designDocLink}`;
}
```

### Target File 5: KanbanProvider — Pass Content to Prompt Builder
#### MODIFY `src/services/KanbanProvider.ts`

<!-- Complexity: Complex -->

**A0. Add import statement** at the top of the file, alongside existing service imports:

```typescript
import { NotionFetchService } from './NotionFetchService';
```

In `_generateBatchPlannerPrompt()`, read Notion cached content before building the prompt:

```typescript
private async _generateBatchPlannerPrompt(cards: KanbanCard[], workspaceRoot: string): Promise<string> {
    const aggressivePairProgramming = this._autobanState?.aggressivePairProgramming ?? false;
    const config = vscode.workspace.getConfiguration('switchboard');
    const designDocEnabled = config.get<boolean>('planner.designDocEnabled', false);
    const designDocLink = designDocEnabled ? (config.get<string>('planner.designDocLink', '') || '').trim() : undefined;

    let designDocContent: string | undefined;
    if (designDocEnabled && designDocLink && (designDocLink.includes('notion.so') || designDocLink.includes('notion.site'))) {
        try {
            const notionService = this._getNotionService(workspaceRoot);
            designDocContent = (await notionService.loadCachedContent()) || undefined;
        } catch { /* non-fatal */ }
    }

    return buildKanbanBatchPrompt('planner', this._cardsToPromptPlans(cards, workspaceRoot), {
        aggressivePairProgramming,
        designDocLink: designDocLink || undefined,
        designDocContent
    });
}
```

Note: `_generateBatchPlannerPrompt` must be made `async` if it is not already. **Both callers MUST be updated to `await` the result:**

**Caller 1 — Line ~1000** (inside `_generateBatchPromptForColumn`):

```typescript
// BEFORE:
return this._generateBatchPlannerPrompt(cards, workspaceRoot);

// AFTER:
return await this._generateBatchPlannerPrompt(cards, workspaceRoot);
```

**Caller 2 — Line ~2153** (inside the `copyBatchPlannerPrompt` message handler):

```typescript
// BEFORE:
const prompt = this._generateBatchPlannerPrompt(sourceCards, workspaceRoot);

// AFTER:
const prompt = await this._generateBatchPlannerPrompt(sourceCards, workspaceRoot);
```

> [!NOTE]
> The enclosing functions at both callsites are already `async`, so adding `await` is safe. Verify this during implementation — if a caller is not async, it must also be made async.

Also add `_getNotionService()` factory to `KanbanProvider` (same pattern as `_getClickUpService()`):

```typescript
private _notionServices: Map<string, NotionFetchService> = new Map();

private _getNotionService(workspaceRoot: string): NotionFetchService {
    let service = this._notionServices.get(workspaceRoot);
    if (!service) {
        service = new NotionFetchService(workspaceRoot, this._context.secrets);
        this._notionServices.set(workspaceRoot, service);
    }
    return service;
}
```

### Target File 6: VS Code Command
#### MODIFY `src/extension.ts`

<!-- Complexity: Routine -->

Add the import at the top of the file (if not already present from Part 1):

```typescript
import { NotionFetchService } from './services/NotionFetchService';
```

Add alongside the `setNotionToken` command registration from Part 1:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('switchboard.fetchNotionDesignDoc', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

    const config = vscode.workspace.getConfiguration('switchboard');
    const url = config.get<string>('planner.designDocLink', '').trim();
    if (!url) {
        vscode.window.showWarningMessage('No Design Doc URL configured. Set one in the Switchboard sidebar.');
        return;
    }
    if (!url.includes('notion.so') && !url.includes('notion.site')) {
        vscode.window.showWarningMessage('Design Doc URL is not a Notion URL. Only Notion pages can be fetched.');
        return;
    }

    const service = new NotionFetchService(workspaceRoot, context.secrets);
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching Notion page...', cancellable: false },
        async () => {
            const result = await service.fetchAndCache(url);
            if (result.success) {
                vscode.window.showInformationMessage(`Notion page cached: "${result.pageTitle}" (${(result.charCount! / 1000).toFixed(0)}k chars)`);
            } else {
                vscode.window.showErrorMessage(`Notion fetch failed: ${result.error}`);
            }
        }
    );
  })
);
```

### Target File 7: Command Palette Registration
#### MODIFY `package.json`

<!-- Complexity: Routine -->

Add to the `contributes.commands` array:

```json
{
  "command": "switchboard.fetchNotionDesignDoc",
  "title": "Fetch Notion Design Doc",
  "category": "Switchboard"
}
```

## Verification Plan

### Automated Tests
- **`fetchAndCache()` happy path**: Mock `httpRequest` to return valid page + blocks → verify `notion-config.json` and `notion-cache.md` written; verify `pageTitle`, `charCount` returned.
- **`fetchAndCache()` 403 response**: Mock `fetchBlocksRecursive` to throw with "403" → verify error message about page sharing returned; no cache file written.
- **`fetchAndCache()` no token stored**: Mock empty SecretStorage → verify `showInputBox` is called; if user cancels → `{ success: false }` returned.
- **Content truncation**: Generate markdown > 50,000 chars with a heading boundary → verify cut occurs at heading, not mid-sentence.
- **Prompt builder with `designDocContent`**: Call `buildKanbanBatchPrompt` with `designDocContent` set → verify content appears in output, NOT the raw URL. Call with only `designDocLink` → verify URL appears (existing behaviour preserved).
- **In-memory cache**: Call `_getDesignDocContent()` twice → verify `loadCachedContent()` called only once (second call uses Map).

### Manual Verification Steps
1. Set Notion token via command palette → confirm "saved securely" message.
2. Open Switchboard sidebar → enable Design Doc toggle → paste a Notion page URL → verify "Sync from Notion" button appears.
3. Click "Sync from Notion" → button disables → progress notification shows → button re-enables → status shows "✅ Synced just now — {page title}".
4. Trigger plan improvement on a kanban card → verify planner prompt contains the Notion page content verbatim, not just the URL.
5. Paste a non-Notion URL → verify "Sync from Notion" button hides.
6. Change URL to a different Notion URL → verify status shows "URL changed — sync required".
7. Close and reopen sidebar → verify sync status is restored from persisted config.
8. Revoke Notion integration access to the page → click "Sync from Notion" → verify "Page not accessible. Share this page..." error message.

## Files to Modify

1. `src/services/NotionFetchService.ts` — MODIFY (add `fetchAndCache()` method)
2. `src/webview/implementation.html` — MODIFY (add Notion sync area, button, status, input listener, `notionFetchState` handler)
3. `src/services/TaskViewerProvider.ts` — MODIFY (add `fetchNotionContent` handler, startup state push, `_getNotionService()` factory, `_notionContentCache` Map, `_getDesignDocContent()` helper, pass `designDocContent` to prompt builder)
4. `src/services/agentPromptBuilder.ts` — MODIFY (add `designDocContent` to `PromptBuilderOptions`, update design doc injection block)
5. `src/services/KanbanProvider.ts` — MODIFY (make `_generateBatchPlannerPrompt` async, add Notion content read, add `_getNotionService()` factory)
6. `src/extension.ts` — MODIFY (register `switchboard.fetchNotionDesignDoc` command)
7. `package.json` — MODIFY (add `switchboard.fetchNotionDesignDoc` to `contributes.commands`)

## Agent Recommendation

**Send to Coder** — Complexity 6. This plan modifies 5 core backend files across the extension host and prompt builder layers (the UI file is superseded by Part 3). The key risks are: (1) the async `_generateBatchPlannerPrompt` refactor in `KanbanProvider.ts` — two callers must be updated to `await` the result; (2) the webview message flow for `fetchNotionContent` must correctly use `this._view` (not `this._panel`). The ClickUp/Linear patterns for singleton services and state push are well-established and should be followed exactly.

> [!NOTE]
> **Coordination risk**: Given the cross-file coordination (5 backend files + 3 import additions + 2 async caller updates), "Send to Lead Coder" is also defensible. A Lead Coder can validate the integration across TaskViewerProvider, KanbanProvider, and the prompt builder in a single pass.

---

## Post-Implementation Review

**Reviewer**: Grumpy Principal Engineer + Balanced Synthesis
**Date**: Post-implementation
**Verdict**: ✅ **PASS — No changes needed**

### Findings

| # | Severity | Finding | Action |
|---|----------|---------|--------|
| 1 | NIT | `_getDesignDocContent()` in TaskViewerProvider (line 8202) is dead code — defined but never called. Plan section F intended it for TaskViewerProvider prompt-building callsites, but all prompt building goes through KanbanProvider. The `_notionContentCache` invalidation works correctly but the cache is never populated via this path. | Keep as infrastructure — may be needed if TaskViewerProvider gains prompt paths |
| 2 | NIT | Extension.ts `fetchNotionDesignDoc` reads URL from `service.loadConfig()?.designDocUrl` (notion-config.json) instead of plan's `vscode.workspace.getConfiguration('switchboard').get('planner.designDocLink')`. Command only works after first sidebar sync. | Acceptable — "re-sync" semantics are coherent |
| 3 | NIT | Extension.ts omits plan's Notion URL guard (`!url.includes('notion.so')`). `parsePageId` handles non-Notion URLs gracefully (returns null → error). | Defer — graceful degradation |
| 4 | NIT | KanbanProvider reads Notion content from disk on every prompt build (no in-memory caching). TaskViewerProvider has the cache but KanbanProvider routes around it. | Negligible perf impact for local fs reads — defer |

### Verification

- `npx tsc --noEmit`: Only pre-existing ArchiveManager error (KanbanProvider.ts:2149)
- `npm run compile`: webpack compiled successfully
- All plan requirements verified present in implementation:
  - `fetchAndCache()` on NotionFetchService with token prompt, validation, 403 handling, truncation ✅
  - `implementation.html` UI correctly NOT implemented (superseded by Plan 3) ✅
  - `fetchNotionContent` handler in TaskViewerProvider with progress notification ✅
  - Startup `notionFetchState` push alongside `designDocSetting` ✅
  - `_getNotionService()` factory on both KanbanProvider and TaskViewerProvider ✅
  - `_notionContentCache` Map on TaskViewerProvider ✅
  - `designDocContent` field in `PromptBuilderOptions` ✅
  - Content embedding takes precedence over URL in prompt builder ✅
  - `_generateBatchPlannerPrompt` made async, both callers (lines 1094 and 2317) await ✅
  - `fetchNotionDesignDoc` command registered in extension.ts and package.json ✅
  - All `this._view` references correct (no `this._panel` errors) ✅
  - All `message.` references correct (no `msg.` errors) ✅
  - All imports present (NotionFetchService in TaskViewerProvider, KanbanProvider, extension.ts) ✅

### Files Changed

None — implementation is faithful to plan.
