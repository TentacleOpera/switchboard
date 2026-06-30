# Planning HTML Tab — Remove Duplicate Send-to-Claude Buttons & Flatten Controls Strip

## Goal

### Problem
The **HTML** tab of `planning.html` has a bloated controls strip with **two rows** and **four artifact buttons**, including **two identical "⇨ Send to Claude" buttons** (one for download, one for upload). This is inconsistent with the Design panel's Claude tab (which has a single "Copy import prompt" button) and is unnecessarily bulky.

### Background
The HTML tab in `planning.html` is a stakeholder HTML previewer with claude.ai artifact round-tripping: users can download an artifact from claude.ai into a local folder, and re-upload a local file back to claude.ai. Each direction (download / upload) has two buttons: "Copy ... prompt" (copies to clipboard) and "⇨ Send to Claude" (sends directly to a terminal). That's 4 buttons plus an artifact URL input, all crammed into a second `controls-strip-row` below the workspace/search row.

### Root Cause
The HTML tab's controls strip (`src/webview/planning.html`, lines ~3527–3543) uses two `controls-strip-row` divs:
- **Row 1** (line ~3529): workspace filter, search input, status text — standard.
- **Row 2** (line ~3536): artifact URL input + 4 buttons (`btn-copy-artifact-download`, `btn-send-artifact-download`, `btn-copy-artifact-upload`, `btn-send-artifact-upload`).

The second row is the "bulky" part the user objects to. The two "⇨ Send to Claude" buttons (lines 3539, 3541) are visually identical — both say "⇨ Send to Claude" with only the `title` tooltip differing ("download" vs "upload"). A user cannot tell them apart at a glance.

The JS handlers (`src/webview/planning.js`, lines ~7262–7312) wire each button to either `ARTIFACT_DOWNLOAD_PROMPT` or `ARTIFACT_UPLOAD_PROMPT`, and either `copyArtifactPrompt` (clipboard) or `sendArtifactPromptToTerminal` (direct send). The "Copy" and "Send" variants differ only in the message type — the prompt text is identical.

## Metadata
- **Tags**: `planning-panel`, `html-tab`, `ux-consistency`, `ui-cleanup`, `artifact-roundtrip`
- **Complexity**: 3/10

## Complexity Audit
- **Routine**: Removing redundant buttons from HTML, removing their JS event listeners, and flattening the two-row controls strip into one row.
- **Complex/Risky**: Deciding which button to keep. The "Copy" and "Send" variants serve different workflows (clipboard vs direct-to-terminal). The user's complaint is specifically about the **two "Send to Claude" buttons** and the **second row**. The cleanest fix: collapse to one row with a single artifact URL input, a direction toggle (Download ⇅ Upload), and two buttons: "Copy prompt" and "⇨ Send to Claude". This halves the button count and eliminates the duplicate "Send" labels.

## Edge-Case & Dependency Audit
- **Download vs Upload semantics**: Download fetches from a URL and saves locally; Upload reads a local file and publishes to claude.ai. They use different prompt templates and different state (`getHtmlFolderFallback` vs `state.activeDocSourceFolder` + `state.activeDocName`). The direction toggle must switch both the prompt template and the state inputs.
- **`artifactPromptCopied` / `artifactPromptSent` message handlers** (lines ~4413–4434): These look up buttons by ID (`btn-copy-artifact-download` / `btn-copy-artifact-upload` / `btn-send-artifact-download` / `btn-send-artifact-upload`). If button IDs change, these handlers must be updated to target the new single pair of buttons.
- **Backend message types**: `copyArtifactPrompt` and `sendArtifactPromptToTerminal` both carry a `kind: 'download' | 'upload'` field. The backend uses `kind` to route the confirmation message back. This is unchanged — we just send the right `kind` based on the toggle.
- **`isShareLink(url)` guard**: `ARTIFACT_DOWNLOAD_PROMPT` (line ~7218) checks for share links and returns a warning. This logic stays in the prompt function — no change needed.
- **No folder configured**: When no HTML folder is configured, `getHtmlFolderFallback()` returns `''`. The prompt handles this case (tells the user to configure a folder). No change needed.
- **Other tabs**: The `controls-strip-row` class is also used by the Research tab (line ~3648). Removing the second row from the HTML tab does not affect Research.

## Proposed Changes

### `src/webview/planning.html` — Flatten HTML tab controls strip (lines ~3527–3543)

Replace the two-row controls strip with a single row containing a direction toggle, the artifact URL input, and two buttons.

**Before** (lines ~3527–3543):
```html
<div class="controls-strip" id="controls-strip-planning-html">
    <div class="controls-strip-row">
        <select id="planning-html-workspace-filter" class="workspace-filter-select">
            <option value="">All Workspaces</option>
        </select>
        <input type="text" id="planning-html-docs-search" class="sidebar-search-input" placeholder="Search HTML files..." />
        <span id="status-planning-html" style="margin-left: 0; font-size: 12px; color: var(--text-secondary);">No folder configured</span>
    </div>
    <div class="controls-strip-row">
        <input type="text" id="planning-html-artifact-url" placeholder="claude.ai artifact URL..." style="flex: 1;" />
        <button id="btn-copy-artifact-download" class="strip-btn" title="Copy a prompt that downloads this artifact into the selected HTML folder">Copy download prompt</button>
        <button id="btn-send-artifact-download" class="strip-btn" title="Send a prompt to Claude to download this artifact into the selected HTML folder">⇨ Send to Claude</button>
        <button id="btn-copy-artifact-upload" class="strip-btn" title="Copy a prompt that re-publishes the previewed file back to claude.ai">Copy upload prompt</button>
        <button id="btn-send-artifact-upload" class="strip-btn" title="Send a prompt to Claude to re-publish the previewed file back to claude.ai">⇨ Send to Claude</button>
    </div>
</div>
```

**After**:
```html
<div class="controls-strip" id="controls-strip-planning-html">
    <select id="planning-html-workspace-filter" class="workspace-filter-select">
        <option value="">All Workspaces</option>
    </select>
    <input type="text" id="planning-html-docs-search" class="sidebar-search-input" placeholder="Search HTML files..." />
    <span id="status-planning-html" style="margin-left: 0; font-size: 12px; color: var(--text-secondary);">No folder configured</span>
    <button id="btn-artifact-direction" class="strip-btn" title="Toggle between download (claude.ai → local) and upload (local → claude.ai)">⇅ Download</button>
    <input type="text" id="planning-html-artifact-url" placeholder="claude.ai artifact URL..." style="flex: 1; min-width: 120px;" />
    <button id="btn-copy-artifact-prompt" class="strip-btn" title="Copy the prompt to clipboard">Copy prompt</button>
    <button id="btn-send-artifact-prompt" class="strip-btn stitch-btn-primary" title="Send the prompt to Claude">⇨ Send to Claude</button>
</div>
```

Key changes:
- **Single row** — no `controls-strip-row` wrappers. The `controls-strip` is already `display: flex; flex-wrap: nowrap; overflow-x: auto`, so it handles overflow gracefully.
- **Direction toggle button** (`btn-artifact-direction`): cycles between "⇅ Download" and "⇅ Upload". Replaces the 4-button matrix with a 2-button pair + toggle.
- **One "Copy prompt" button** (`btn-copy-artifact-prompt`): replaces `btn-copy-artifact-download` and `btn-copy-artifact-upload`.
- **One "⇨ Send to Claude" button** (`btn-send-artifact-prompt`): replaces `btn-send-artifact-download` and `btn-send-artifact-upload`.

### `src/webview/planning.js` — Direction toggle state + unified handlers (lines ~7257–7312)

Replace the 4 separate button listeners with a direction toggle + 2 unified listeners.

**Before** (abridged, lines ~7262–7312):
```js
const btnCopyDownload = document.getElementById('btn-copy-artifact-download');
if (btnCopyDownload) { btnCopyDownload.addEventListener('click', () => { ... ARTIFACT_DOWNLOAD_PROMPT ... copyArtifactPrompt ... kind: 'download' }); }
const btnSendDownload = document.getElementById('btn-send-artifact-download');
if (btnSendDownload) { btnSendDownload.addEventListener('click', () => { ... ARTIFACT_DOWNLOAD_PROMPT ... sendArtifactPromptToTerminal ... kind: 'download' }); }
const btnCopyUpload = document.getElementById('btn-copy-artifact-upload');
if (btnCopyUpload) { btnCopyUpload.addEventListener('click', () => { ... ARTIFACT_UPLOAD_PROMPT ... copyArtifactPrompt ... kind: 'upload' }); }
const btnSendUpload = document.getElementById('btn-send-artifact-upload');
if (btnSendUpload) { btnSendUpload.addEventListener('click', () => { ... ARTIFACT_UPLOAD_PROMPT ... sendArtifactPromptToTerminal ... kind: 'upload' }); }
```

**After**:
```js
let artifactDirectionIsDownload = true; // default: download

const directionBtn = document.getElementById('btn-artifact-direction');
function updateDirectionLabel() {
    if (directionBtn) {
        directionBtn.textContent = artifactDirectionIsDownload ? '⇅ Download' : '⇅ Upload';
        directionBtn.title = artifactDirectionIsDownload
            ? 'Download: fetch artifact from claude.ai → save locally. Click to switch to Upload.'
            : 'Upload: publish local file → claude.ai. Click to switch to Download.';
    }
}
if (directionBtn) {
    directionBtn.addEventListener('click', () => {
        artifactDirectionIsDownload = !artifactDirectionIsDownload;
        updateDirectionLabel();
    });
}
updateDirectionLabel();

function buildArtifactPrompt() {
    const url = getArtifactUrlInput();
    if (artifactDirectionIsDownload) {
        const folder = getHtmlFolderFallback();
        return { prompt: ARTIFACT_DOWNLOAD_PROMPT({ url, folder }), kind: 'download' };
    }
    const folder = state.activeDocSourceFolder || getHtmlFolderFallback();
    const filename = state.activeDocName || (url ? url.split('/').pop() + '.html' : 'artifact.html');
    return { prompt: ARTIFACT_UPLOAD_PROMPT({ url, folder, filename }), kind: 'upload' };
}

const btnCopyPrompt = document.getElementById('btn-copy-artifact-prompt');
if (btnCopyPrompt) {
    btnCopyPrompt.addEventListener('click', () => {
        const { prompt, kind } = buildArtifactPrompt();
        vscode.postMessage({ type: 'copyArtifactPrompt', prompt, kind });
    });
}

const btnSendPrompt = document.getElementById('btn-send-artifact-prompt');
if (btnSendPrompt) {
    btnSendPrompt.addEventListener('click', () => {
        const { prompt, kind } = buildArtifactPrompt();
        vscode.postMessage({
            type: 'sendArtifactPromptToTerminal',
            prompt,
            kind,
            workspaceRoot: state.planningHtmlWorkspaceRootFilter || undefined
        });
    });
}
```

### `src/webview/planning.js` — Update confirmation handlers (lines ~4413–4434)

The `artifactPromptCopied` and `artifactPromptSent` handlers currently look up buttons by direction-specific IDs. Update them to target the unified button IDs.

**Before** (lines ~4413–4434):
```js
case 'artifactPromptCopied': {
    const isDownload = msg.kind === 'download';
    const btnId = isDownload ? 'btn-copy-artifact-download' : 'btn-copy-artifact-upload';
    const btn = document.getElementById(btnId);
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = originalText; }, 2000); }
    break;
}
case 'artifactPromptSent': {
    const isDownload = msg.kind === 'download';
    const btnId = isDownload ? 'btn-send-artifact-download' : 'btn-send-artifact-upload';
    const btn = document.getElementById(btnId);
    if (btn) { btn.textContent = 'Sent ✓'; setTimeout(() => { btn.textContent = originalText; }, 2000); }
    break;
}
```

**After**:
```js
case 'artifactPromptCopied': {
    const btn = document.getElementById('btn-copy-artifact-prompt');
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 2000); }
    break;
}
case 'artifactPromptSent': {
    const btn = document.getElementById('btn-send-artifact-prompt');
    if (btn) { const orig = btn.textContent; btn.textContent = 'Sent ✓'; setTimeout(() => { btn.textContent = orig; }, 2000); }
    break;
}
```

## Verification Plan
1. **Visual**: Open the Planning panel, switch to the HTML tab. Confirm the controls strip is a **single row** with: workspace filter, search, status, direction toggle, artifact URL input, "Copy prompt", "⇨ Send to Claude". No second row.
2. **Direction toggle**: Click the "⇅ Download" button. Confirm it switches to "⇅ Upload" and the tooltip updates. Click again — switches back.
3. **Download flow**: With direction = Download, paste an artifact URL, click "Copy prompt". Confirm the clipboard contains `ARTIFACT_DOWNLOAD_PROMPT` output (mentions "Download a claude.ai artifact"). Click "⇨ Send to Claude". Confirm the prompt is sent to the terminal.
4. **Upload flow**: Switch direction to Upload. Click "Copy prompt". Confirm the clipboard contains `ARTIFACT_UPLOAD_PROMPT` output (mentions "Publish a local document back to claude.ai"). Click "⇨ Send to Claude". Confirm the prompt is sent.
5. **Confirmation feedback**: After copying, confirm the "Copy prompt" button briefly shows "Copied!". After sending, confirm the "⇨ Send to Claude" button briefly shows "Sent ✓".
6. **Share-link warning**: Paste a `claude.ai/share/` URL with direction = Download, click "Copy prompt". Confirm the warning text about share links is in the clipboard.
7. **Other tabs unaffected**: Switch to Local, Online, Kanban, Tickets, Research tabs. Confirm their controls strips are unchanged.
8. **Sidebar collapse**: Collapse the sidebar. Confirm the single-row controls strip does not overflow or break layout (it should scroll horizontally via `overflow-x: auto`).
