# Notion Integration — Part 3: Planning Tab UI Restructure

## Goal

Rename the "Airlock" sub-tab in the Agents panel to "Planning" and restructure it into three self-contained panels in this order: **Clipboard Import → Notion → NotebookLM**. The Notion panel becomes the home for design-doc configuration and Notion page syncing. The CONFIG section's Design Doc row is simplified to a toggle + read-only status indicator — the URL input and Sync button move out of CONFIG entirely. This plan supersedes the `implementation.html` changes in `notion_2_setup_and_fetch.md`; the backend (service layer, prompt builder, TaskViewerProvider message handlers) from that plan is unchanged.

## Metadata

**Tags:** frontend, UI
**Complexity:** 5

## User Review Required

> [!NOTE]
> - **Tab rename only — no data changes**: Renaming "Airlock" → "Planning" is a label change only. The `data-tab="webai"` attribute, the `agentListWebai` JS variable, and the `switchAgentTab('webai')` call all stay as-is. Only the visible button text changes.
> - **`createAirlockPanel()` renamed to `createNotebookLMPanel()`**: The function is renamed and its internal header label changes from "AIRLOCK" to "NOTEBOOKLM". Its content (bundle, upload, sprint prompt, import) is identical. All `airlock_*` message types and `webai-*` element IDs remain unchanged — no backend work required.
> - **Cross-panel DOM dependency preserved**: `createNotebookLMPanel()` reads `#airlock-separator-preset` and `#airlock-separator-input` from the DOM (elements created by `createClipboardImportPanel()`). Panel render order — Clipboard Import first — must be preserved to guarantee these elements exist when NotebookLM needs them.
> - **Design doc URL input moves from CONFIG to the Notion panel**: The `#design-doc-link-input` HTML element is removed from CONFIG. A JS variable `lastDesignDocLink` takes its place in the `saveStartupCommands` construction. The Notion panel owns the URL input and updates `lastDesignDocLink` on change.
> - **CONFIG retains only the toggle**: The toggle (`#design-doc-toggle`) and a new read-only one-liner status (`#design-doc-status-line`) remain in CONFIG. The security warning `<div>` is removed from CONFIG (it was tied to the URL input).
> - **Notion panel handles both Notion and non-Notion URLs**: For Notion URLs, the Sync button is shown and enables content caching. For non-Notion URLs and local paths, the Sync button is hidden and the URL is passed directly to the prompt builder (existing behaviour). This makes the Notion panel the single location for all design doc configuration.

## Complexity Audit

### Routine
- **Tab rename**: One string change in the HTML sub-tab button.
- **`createAirlockPanel()` → `createNotebookLMPanel()`**: Function rename + header label text. Pure find-and-replace with no logic changes.
- **Panel render order**: Two lines in two render sites (normal render + onboarding fallback render).
- **`setDesignDocUrl` message handler in `TaskViewerProvider`**: 3-line handler that updates `switchboard.planner.designDocLink` workspace config and echoes back a `designDocSetting` push.

### Complex / Risky
- **`saveStartupCommands` construction**: `designDocLink` is currently read inline from `#design-doc-link-input` at two separate callsites (exact lines 2206 and 2370). Both must be updated to read `lastDesignDocLink` instead. If either callsite is missed, the saved design doc URL silently becomes `''` on next config save.
- **`createNotionPanel()` function**: Self-contained panel with URL input, Notion-URL detection, conditional Sync button visibility, status badge, size warning, and `notionFetchState` message handler. The panel must initialise its input from the `designDocSetting` push — it runs after the DOM is ready, but the `designDocSetting` message may arrive before or after the panel is rendered. The handler must check if the element exists before setting its value.
- **`designDocSetting` message case update**: Currently sets `#design-doc-link-input` value. After this plan, it must instead set the Notion panel input `#notion-url-input` AND update `lastDesignDocLink`. The `#design-doc-link-input` element no longer exists — reading it returns `null`, which is safe, but the value would be lost. The case must be updated before the element is removed.

## Edge-Case & Dependency Audit

- **`saveStartupCommands` called before Notion panel renders** (onboarding flow): `lastDesignDocLink` is initialised to `''` at script load. The onboarding path posts `saveStartupCommands` before `renderAgentList()` populates the Planning tab. Since the URL would legitimately be empty during onboarding, `lastDesignDocLink = ''` is correct — no data loss.
- **Non-Notion URL in Notion panel input**: Sync button hidden; `lastDesignDocLink` is updated and saved via `setDesignDocUrl`; prompt builder uses the URL directly (no cache read). Existing behaviour preserved.
- **Empty URL in Notion panel**: `setDesignDocUrl` sends `''`; CONFIG status line shows "Not configured"; prompt builder skips design doc section. Correct.
- **`designDocSetting` arrives before panel is in DOM**: The `case 'designDocSetting':` handler calls `document.getElementById('notion-url-input')` — returns `null` if panel not yet rendered. Guard with `if (notionInput)` before assigning value. `lastDesignDocLink` is always set regardless.
- **Notion panel `notionFetchState` handler**: Same handler as described in `notion_2_setup_and_fetch.md` — just relocated from the CONFIG section to the Notion panel function scope. Logic is identical.
- **Tab persistence across re-renders**: `switchAgentTab(currentAgentTab)` is called after every `renderAgentList()`. If the user is on the Planning tab when a re-render fires, the tab stays active. No change needed here.
- **Dependencies & Conflicts**: The only file conflict risk is with `notion_2_setup_and_fetch.md`. This plan's implementer must NOT apply the `implementation.html` changes from that plan. All other files from notion_2 (NotionFetchService, TaskViewerProvider backend handlers, agentPromptBuilder) apply as written.

### Cross-Plan Conflict Analysis

**Dependencies:**
- This plan depends on `notion_1_foundation.md` (Part 1 — foundation types, config schema, settings contributions).
- This plan depends on `notion_2_setup_and_fetch.md` (Part 2 — backend only). The backend files from Part 2 (`NotionFetchService.ts`, `TaskViewerProvider.ts` message handlers for `fetchNotionContent`, `agentPromptBuilder.ts`, `KanbanProvider.ts`, `extension.ts` command registration, `package.json` contributions) are **NOT** superseded and **must land before this plan**.

**Supersedes (partial):**
- This plan **supersedes** the `implementation.html` UI changes from Part 2 (`notion_2_setup_and_fetch.md`). Specifically, **Target File 2 sections A through E** are superseded:
  - **(A)** Notion sync area HTML
  - **(B)** URL detection JS
  - **(C)** `notionFetchState` handler
  - **(D)** `_relativeTime` helper
  - **(E)** `designDocSetting` area initialisation
- Do NOT implement those sections from Part 2; implement this plan instead for all webview UI.

**New Handlers (no Part 2 conflict):**
- This plan adds **two additional handlers** to `TaskViewerProvider.ts`: `setDesignDocUrl` and `getNotionFetchState`. These are NOT present in Part 2. Part 2's `fetchNotionContent` handler is a separate message type — no conflict. All three handlers (`fetchNotionContent` from Part 2, `setDesignDocUrl` and `getNotionFetchState` from this plan) coexist in the same message switch with distinct `case` labels.

## Adversarial Synthesis

### Grumpy Critique

1. **You are silently breaking `saveStartupCommands` if either callsite is missed.** There are two places where `document.getElementById('design-doc-link-input')?.value` is read and included in `saveStartupCommands`. The plan says "both must be updated" — but it doesn't enumerate which line numbers they're at, leaving it to the implementer to grep. One miss means every CONFIG save wipes the design doc URL. This is a silent data-loss bug.

2. **`lastDesignDocLink` is a global-ish JS variable that can get out of sync.** If the Notion panel is re-rendered (which happens on every `renderAgentList()` call), the new input element starts empty until `designDocSetting` is re-pushed. Between re-render and the push, if the user triggers a `saveStartupCommands`, `lastDesignDocLink` holds the correct value — but the input shows blank. The user sees a blank URL field and thinks their config was lost. Confusing even if technically correct.

3. **The CONFIG status line has no defined element ID.** The plan describes a `#design-doc-status-line` but the existing `designDocSetting` case doesn't know to update it. If the status line text is set only at initial push and never updated when the user syncs a new Notion page, it goes stale. The `notionFetchState` handler (in the Notion panel) updates the Notion panel's status badge, but nothing updates the CONFIG status line after a sync.

4. **Precise line numbers now verified**: The plan says "~line 2206 and ~line 2370" for `saveStartupCommands`. Codebase analysis confirms these are EXACT: line 2206 and line 2370. Good — but the plan should state them as exact, not approximate.

5. **`container.dataset.panel = 'notion'` placement is vague**: Change 9 says "Add `container.dataset.panel = 'notion';` inside `createNotionPanel()` after the container is created". This should specify: immediately after `container.className = 'agent-row';` (the line right after `document.createElement('div')`). An implementer scanning a 150-line function shouldn't have to guess.

6. **The onboarding `saveStartupCommands` at line 4439 doesn't include `designDocLink`**: The plan only fixes the two main callsites (lines 2206 and 2370). The onboarding path at line 4439 calls `saveStartupCommands` without `designDocLink` — this is correct because onboarding doesn't set a design doc. But if the backend handler doesn't guard against missing `designDocLink` (i.e., treats `undefined` differently from `''`), this could cause the existing design doc URL to be wiped during onboarding re-save. Verify the backend handler preserves existing config when `designDocLink` is not in the payload.

7. **`_relativeTime` name collision risk**: The function name `_relativeTime` uses an underscore prefix convention that typically indicates a private method. In a global script block, this is just a naming convention — but if any future code adds a `_relativeTime` to the window or a class, it'll shadow this. Low risk but worth a `// Global helper — no class scope` comment.

### Balanced Response

1. **Both callsites enumerated — FIXED**: The two `saveStartupCommands` callsites are at exact lines 2206 and 2370 (search: `design-doc-link-input`). Both are listed explicitly in the Proposed Changes below, with their exact surrounding context. The implementer must replace both before removing the HTML element.

2. **Re-render blank input — FIXED**: `createNotionPanel()` reads `lastDesignDocLink` directly when constructing the input element (`notionInput.value = lastDesignDocLink`). Since `lastDesignDocLink` is a closure-free global set on `designDocSetting` and on every `setDesignDocUrl` response, the input is pre-populated at render time. No blank-field flash.

3. **CONFIG status line staleness — FIXED**: The `notionFetchState` handler (inside `createNotionPanel()`) posts a secondary `designDocStatusUpdate` message back to the extension, which is not needed — instead, the handler directly updates `#design-doc-status-line` via `document.getElementById`. This works because the CONFIG section is always in the DOM (it's not dynamically rendered like the Planning tab panels). The `designDocSetting` case also updates `#design-doc-status-line` on startup.

4. **Line numbers updated from approximate to exact** in the plan text (Complexity Audit, Change 5, Balanced #1). Codebase-verified: line 2206 and line 2370.

5. **`container.dataset.panel` placement specified precisely**: Change 8 now shows `container.dataset.panel = 'notion';` immediately after `container.className = 'agent-row';` in the code block. No ambiguity for the implementer.

6. **Onboarding path at line 4439 confirmed safe**: The onboarding `saveStartupCommands` sends `onboardingComplete: true` which triggers a different backend code path that does NOT update `planner.designDocLink`. The backend handler at line 3327 of `TaskViewerProvider.ts` guards `designDocLink` updates behind `if (data.designDocLink !== undefined)` — so omitting it from the payload preserves the existing config value.

7. **`_relativeTime` naming is acceptable** — underscore prefix is just a convention in the global scope. Added a brief `// Global helper — no class scope` comment in the function declaration (Change 10).

## Proposed Changes

### Change Complexity Grouping

**Routine Changes (Low Risk):**
- Change 1: Tab rename (one string)
- Change 3: Initialize `lastDesignDocLink` variable (one `let`)
- Change 6: Function rename `createAirlockPanel` → `createNotebookLMPanel` (find-and-replace)
- Change 10: `_relativeTime` helper (pure function, no side effects)
- TaskViewerProvider: `setDesignDocUrl` handler (3-line config write)

**Complex Changes (Higher Risk):**
- Change 2: CONFIG design doc row simplification (removes existing HTML, adds status element)
- Change 4: `designDocSetting` message case rewrite (must populate new element IDs, update global var)
- Change 5: Both `saveStartupCommands` callsite fixes at lines 2206 and 2370 (silent data loss if missed)
- Change 7: Panel render order update (two sites — normal render and onboarding fallback)
- Change 8: Full `createNotionPanel()` function (~150 lines, new panel with URL input, sync button, state handler)
- Change 9: `notionFetchState` routing (depends on `container.dataset.panel` from Change 8)
- TaskViewerProvider: `getNotionFetchState` handler (reads from NotionFetchService, async)

---

### Target File: `src/webview/implementation.html`

#### Change 1 — Rename sub-tab button
```html
<!-- BEFORE -->
<button class="sub-tab-btn" data-tab="webai">Airlock</button>

<!-- AFTER -->
<button class="sub-tab-btn" data-tab="webai">Planning</button>
```

#### Change 2 — Simplify CONFIG design doc row
Remove the URL input label and security warning div entirely. Replace with a one-line status indicator:

```html
<!-- REMOVE these elements: -->
<label class="startup-row" style="display:block; margin-top:4px;">
    <input id="design-doc-link-input" type="text"
        placeholder="https://example.com/prd or /path/to/design.md" style="width:100%;">
</label>
<div style="font-size:10px; color:var(--accent-orange); margin-top:4px; font-family:var(--font-mono);">
    ⚠️ Security: File contents are embedded in AI prompts. Do not link files containing API keys,
    passwords, or sensitive data.
</div>

<!-- ADD in their place: -->
<div id="design-doc-status-line"
     style="font-size:10px; color:var(--text-secondary); margin-top:4px; font-family:var(--font-mono);">
    Not configured — configure in Planning tab
</div>
```

#### Change 3 — Initialise `lastDesignDocLink` global variable
Add near the top of the `<script>` block (alongside other `let` declarations):

```javascript
let lastDesignDocLink = '';
```

#### Change 4 — Update `designDocSetting` message case
Replace the existing case body:

```javascript
// BEFORE:
case 'designDocSetting': {
    const ddToggle = document.getElementById('design-doc-toggle');
    const ddLink = document.getElementById('design-doc-link-input');
    if (ddToggle) ddToggle.checked = !!message.enabled;
    if (ddLink) ddLink.value = message.link || '';
    break;
}

// AFTER:
case 'designDocSetting': {
    const ddToggle = document.getElementById('design-doc-toggle');
    if (ddToggle) ddToggle.checked = !!message.enabled;

    lastDesignDocLink = message.link || '';

    // Populate Notion panel input if it exists (may not be rendered yet)
    const notionUrlInput = document.getElementById('notion-url-input');
    if (notionUrlInput) { notionUrlInput.value = lastDesignDocLink; }

    // Update CONFIG status line
    const statusLine = document.getElementById('design-doc-status-line');
    if (statusLine) {
        statusLine.textContent = lastDesignDocLink
            ? `Source: ${lastDesignDocLink.length > 60 ? lastDesignDocLink.slice(0, 57) + '...' : lastDesignDocLink}`
            : 'Not configured — configure in Planning tab';
    }
    break;
}
```

#### Change 5 — Fix both `saveStartupCommands` callsites
At both locations where `saveStartupCommands` is constructed, replace the inline read:

```javascript
// BEFORE (appears at exact line 2206 and line 2370):
const designDocLink = document.getElementById('design-doc-link-input')?.value.trim() || '';

// AFTER (both locations):
const designDocLink = lastDesignDocLink;
```

#### Change 6 — Rename `createAirlockPanel()` → `createNotebookLMPanel()`
Rename the function declaration and update the two render callsites. Inside the function, change the header text:

```javascript
// Function declaration:
// BEFORE: function createAirlockPanel() {
// AFTER:  function createNotebookLMPanel() {

// Header name element inside the function:
// BEFORE: name.innerText = 'AIRLOCK';
// AFTER:  name.innerText = 'NOTEBOOKLM';
```

#### Change 7 — Update Planning tab comment and render order (two sites)
Both normal render and onboarding fallback render:

```javascript
// BEFORE:
// === AIRLOCK TAB: Bundle, Convert to Plan, Send to Coder ===
agentListWebai.appendChild(createClipboardImportPanel());
agentListWebai.appendChild(createAirlockPanel());

// AFTER:
// === PLANNING TAB: Clipboard Import, Notion, NotebookLM ===
agentListWebai.appendChild(createClipboardImportPanel());
agentListWebai.appendChild(createNotionPanel());
agentListWebai.appendChild(createNotebookLMPanel());
```

#### Change 8 — Add `createNotionPanel()` function
Add immediately after `createClipboardImportPanel()` (before `createNotebookLMPanel()`):

```javascript
function createNotionPanel() {
    const container = document.createElement('div');
    container.className = 'agent-row';
    container.dataset.panel = 'notion'; // needed for Change 9's querySelector('[data-panel="notion"]')

    // Header
    const header = document.createElement('div');
    header.className = 'row-header';
    const identity = document.createElement('div');
    identity.className = 'agent-identity';
    const name = document.createElement('div');
    name.className = 'agent-name';
    name.style.cssText = 'color:var(--text-secondary);';
    name.innerText = 'NOTION DESIGN DOC';
    identity.appendChild(name);
    header.appendChild(identity);
    container.appendChild(header);

    // Description
    const desc = document.createElement('div');
    desc.style.cssText = 'padding:6px 8px; font-size:10px; color:var(--text-secondary); line-height:1.4;';
    desc.innerText = 'Fetch a Notion page and embed its full content in every planner prompt. The page is cached locally — no MCP call at prompt time. Also accepts regular URLs and file paths.';
    container.appendChild(desc);

    // URL input
    const urlRow = document.createElement('div');
    urlRow.style.cssText = 'padding:0 8px 4px;';
    const urlInput = document.createElement('input');
    urlInput.id = 'notion-url-input';
    urlInput.type = 'text';
    urlInput.placeholder = 'https://notion.so/... or /path/to/design.md';
    urlInput.style.cssText = 'width:100%; box-sizing:border-box; font-family:var(--font-mono); font-size:10px; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); padding:3px 4px; border-radius:3px;';
    urlInput.value = lastDesignDocLink; // pre-populate from persisted value
    urlRow.appendChild(urlInput);
    container.appendChild(urlRow);

    // Sync row (button + status) — shown only for Notion URLs
    const syncRow = document.createElement('div');
    syncRow.id = 'notion-sync-row';
    syncRow.style.cssText = 'display:none; align-items:center; gap:8px; padding:0 8px 4px;';

    const syncBtn = document.createElement('button');
    syncBtn.id = 'notion-sync-btn';
    syncBtn.style.cssText = 'font-size:11px; padding:3px 8px; cursor:pointer; white-space:nowrap;';
    syncBtn.innerText = 'Sync from Notion';

    const syncStatus = document.createElement('span');
    syncStatus.id = 'notion-sync-status';
    syncStatus.style.cssText = 'font-size:10px; color:var(--text-secondary); font-family:var(--font-mono);';
    syncStatus.textContent = 'Not synced';

    syncRow.appendChild(syncBtn);
    syncRow.appendChild(syncStatus);
    container.appendChild(syncRow);

    // Size warning
    const sizeWarn = document.createElement('div');
    sizeWarn.id = 'notion-size-warning';
    sizeWarn.style.cssText = 'display:none; padding:0 8px 4px; font-size:10px; color:var(--accent-orange); font-family:var(--font-mono);';
    container.appendChild(sizeWarn);

    // ── Helpers ──────────────────────────────────────────────────

    function isNotionUrl(val) {
        return val && (val.includes('notion.so') || val.includes('notion.site'));
    }

    function updateSyncRowVisibility(val) {
        syncRow.style.display = isNotionUrl(val) ? 'flex' : 'none';
    }

    function updateConfigStatusLine(url) {
        const sl = document.getElementById('design-doc-status-line');
        if (!sl) { return; }
        sl.textContent = url
            ? `Source: ${url.length > 60 ? url.slice(0, 57) + '...' : url}`
            : 'Not configured — configure in Planning tab';
    }

    // Initialise visibility from pre-populated value
    updateSyncRowVisibility(urlInput.value);

    // ── URL input event ──────────────────────────────────────────

    let urlDebounce = null;
    urlInput.addEventListener('input', () => {
        clearTimeout(urlDebounce);
        urlDebounce = setTimeout(() => {
            const val = urlInput.value.trim();
            lastDesignDocLink = val;
            updateSyncRowVisibility(val);
            updateConfigStatusLine(val);

            // If URL changed from last synced page, reset status
            if (isNotionUrl(val) && lastNotionSyncedUrl && val !== lastNotionSyncedUrl) {
                syncStatus.textContent = 'URL changed — sync required';
                syncStatus.style.color = 'var(--accent-orange)';
            }

            // Persist the URL immediately (no wait for saveStartupCommands)
            vscode.postMessage({ type: 'setDesignDocUrl', url: val });
        }, 400);
    });

    // ── Sync button event ────────────────────────────────────────

    let lastNotionSyncedUrl = null;
    syncBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) { return; }
        syncBtn.disabled = true;
        syncBtn.innerText = '⏳ Syncing...';
        syncStatus.textContent = 'Fetching...';
        syncStatus.style.color = 'var(--text-secondary)';
        vscode.postMessage({ type: 'fetchNotionContent', url });
    });

    // ── notionFetchState message handler ─────────────────────────
    // Registered on the container so it's cleaned up with the panel.
    // The global message listener routes 'notionFetchState' here.
    container._handleNotionFetchState = function(msg) {
        syncBtn.disabled = false;
        syncBtn.innerText = 'Sync from Notion';

        if (msg.error) {
            syncStatus.textContent = `⚠️ ${msg.error}`;
            syncStatus.style.color = 'var(--accent-orange)';
            return;
        }

        if (msg.syncedAt) {
            lastNotionSyncedUrl = msg.pageUrl || null;
            const ago = _relativeTime(new Date(msg.syncedAt));
            syncStatus.textContent = `✅ Synced ${ago}${msg.pageTitle ? ` — ${msg.pageTitle}` : ''}`;
            syncStatus.style.color = 'var(--text-secondary)';
            updateConfigStatusLine(msg.pageUrl || urlInput.value.trim());
        }

        if (msg.charCount && msg.charCount > 40000) {
            sizeWarn.style.display = 'block';
            sizeWarn.textContent = `⚠️ Content is large (${(msg.charCount / 1000).toFixed(0)}k chars). Consider linking a shorter summary page.`;
        } else {
            sizeWarn.style.display = 'none';
        }
    };

    // Request initial Notion state from extension
    vscode.postMessage({ type: 'getNotionFetchState' });

    return container;
}
```

#### Change 9 — Route `notionFetchState` to the Notion panel
Inside the global `window.addEventListener('message', ...)` switch, update the existing `notionFetchState` case (from `notion_2_setup_and_fetch.md`) to route through the panel's handler:

```javascript
case 'notionFetchState': {
    // Route to the Notion panel's handler (the panel registers it on its container element)
    // Requires container.dataset.panel = 'notion' set in createNotionPanel() (Change 8)
    const notionPanel = document.querySelector('[data-panel="notion"]');
    if (notionPanel && notionPanel._handleNotionFetchState) {
        notionPanel._handleNotionFetchState(message);
    }
    break;
}
```

> **Note**: The `container.dataset.panel = 'notion';` line is already included in Change 8 immediately after `container.className = 'agent-row';`. This is what makes the `querySelector('[data-panel="notion"]')` above work.

#### Change 10 — Add `_relativeTime` helper
Add once in the `<script>` block (if not already present — do not add twice):

```javascript
// Global helper — no class scope (underscore prefix is convention only, not enforced)
function _relativeTime(date) {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) { return 'just now'; }
    if (diff < 3600) { return `${Math.floor(diff / 60)}m ago`; }
    if (diff < 86400) { return `${Math.floor(diff / 3600)}h ago`; }
    return `${Math.floor(diff / 86400)}d ago`;
}
```

---

### Target File: `src/services/TaskViewerProvider.ts`

#### Add `setDesignDocUrl` message handler
In the webview message switch (near the existing `saveStartupCommands` handler):

```typescript
case 'setDesignDocUrl': {
    const url: string = data.url || '';
    await vscode.workspace.getConfiguration('switchboard').update(
        'planner.designDocLink', url, vscode.ConfigurationTarget.Workspace
    );
    break;
}
```

#### Add `getNotionFetchState` message handler
In the webview message switch, for when the Notion panel initialises and requests current state:

```typescript
case 'getNotionFetchState': {
    const wsRoot = this._getWorkspaceRoot();
    if (!wsRoot) { break; }
    try {
        const notionService = this._getNotionService(wsRoot);
        const config = await notionService.loadConfig();
        if (config?.setupComplete && config.lastFetchAt) {
            const cached = await notionService.loadCachedContent();
            this._view?.webview.postMessage({
                type: 'notionFetchState',
                syncedAt: config.lastFetchAt,
                pageTitle: config.pageTitle,
                pageUrl: config.pageUrl,
                charCount: cached?.length ?? 0
            });
        }
    } catch { /* non-blocking */ }
    break;
}
```

Note: `_getNotionService()` is defined in `notion_2_setup_and_fetch.md`. Implement that plan first.

## Verification Plan

- **Tab label**: Open Agents panel → confirm sub-tab reads "Planning", not "Airlock".
- **Panel order**: Click Planning tab → confirm order is Clipboard Import → Notion → NotebookLM.
- **NotebookLM panel**: Confirm "BUNDLE CODE", "OPEN NOTEBOOKLM", and "COPY SPRINT PROMPT" buttons all function identically to before the rename.
- **Clipboard Import cross-dependency**: Confirm the NotebookLM "COPY SPRINT PROMPT" button still reads `#airlock-separator-preset` correctly (element exists because Clipboard Import rendered first).
- **Notion panel — non-Notion URL**: Enter `/path/to/design.md` → Sync button hidden → URL persisted → prompt builder uses raw path.
- **Notion panel — Notion URL**: Enter a `notion.so` URL → Sync button appears → click Sync → progress notification → status updates → CONFIG status line updates.
- **CONFIG section**: Confirm URL input is gone, toggle is present, status line shows correct source.
- **`saveStartupCommands` roundtrip**: Toggle design doc on/off → save → reload VS Code → design doc toggle state restored. Confirm URL from Notion panel is also restored.
- **Re-render persistence**: Trigger a board refresh (move a card) → Planning tab re-renders → Notion panel input is pre-populated with the saved URL.
- **`npx tsc --noEmit`**: No new type errors.

## Files to Modify

1. `src/webview/implementation.html` — MODIFY (tab rename, panel order, panel rename, Notion panel, CONFIG simplification, `saveStartupCommands` fix, `designDocSetting` update, `_relativeTime` helper)
2. `src/services/TaskViewerProvider.ts` — MODIFY (add `setDesignDocUrl` and `getNotionFetchState` handlers)

## Agent Recommendation

**Send to Coder** — Complexity 5 (≤6 → Coder). The logic is entirely within `implementation.html`'s script block and a two-handler addition to `TaskViewerProvider`. The primary risk is the two-site `saveStartupCommands` fix — missing either callsite causes silent data loss. The implementer must grep for `design-doc-link-input` to confirm zero remaining references before closing this plan.

---

## Post-Implementation Review

**Reviewer**: Grumpy Principal Engineer + Balanced Synthesis
**Date**: Post-implementation
**Verdict**: ✅ **PASS — No changes needed**

### Findings

| # | Severity | Finding | Action |
|---|----------|---------|--------|
| 1 | NIT | `createNotebookLMPanel()` intro text (line 3811) still says "The Airlock allows you to upload all your code into NotebookLM..." — plan explicitly said content is "identical" so this is plan-compliant, but a cosmetic inconsistency with the "Planning" tab and "NOTEBOOKLM" header | Defer — cosmetic only |
| 2 | NIT | `createNotionPanel()` fires `getNotionFetchState` on every render (line 3786). Lightweight handler but redundant when startup push already covers initial state. Ensures fresh state after re-renders. | Keep — correct behavior, ensures panel state is always fresh |

### Verification

- `npx tsc --noEmit`: Only pre-existing ArchiveManager error (KanbanProvider.ts:2149)
- `npm run compile`: webpack compiled successfully
- Zero remaining references to `design-doc-link-input` in implementation.html ✅
- All 10 plan changes verified in implementation:
  - Change 1: Tab button text "Planning" (line 1587) ✅
  - Change 2: CONFIG simplified — toggle + `#design-doc-status-line`, no URL input (lines 1700-1706) ✅
  - Change 3: `lastDesignDocLink` global (line 1906) ✅
  - Change 4: `designDocSetting` handler updated (lines 2826-2841) ✅
  - Change 5: Both `saveStartupCommands` callsites fixed (lines 2212, 2376) ✅
  - Change 6: `createNotebookLMPanel()` with "NOTEBOOKLM" header (lines 3791, 3803) ✅
  - Change 7: Both render sites correct — Clipboard Import → Notion → NotebookLM (lines 3397-3399, 3512-3514) ✅
  - Change 8: Full `createNotionPanel()` function (lines 3657-3788) ✅
  - Change 9: `notionFetchState` routing via `querySelector('[data-panel="notion"]')` (lines 2996-3001) ✅
  - Change 10: `_relativeTime` helper with comment (lines 1908-1914) ✅
  - TaskViewerProvider `setDesignDocUrl` handler (line 3436) ✅
  - TaskViewerProvider `getNotionFetchState` handler (line 3443) ✅

### Files Changed

None — implementation is faithful to plan.
