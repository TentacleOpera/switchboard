# Planning HTML Tab — Remove Duplicate Send-to-Claude Buttons & Flatten Controls Strip

## Goal

Flatten the HTML tab's two-row controls strip into a single row and collapse the four artifact buttons (two of which are identically labeled "⇨ Send to Claude") into a direction toggle plus two buttons ("Copy prompt" and "⇨ Send to Claude"), eliminating the duplicate-label confusion and matching the Design panel's leaner Claude-tab convention.

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
- **Tags:** `ui`, `ux`, `refactor`
- **Complexity:** 3/10

## User Review Required
- **Direction toggle UX**: The toggle button ("⇅ Download" / "⇅ Upload") replaces 4 explicit buttons with a stateful control. Confirm this discoverability tradeoff is acceptable — the tooltip explains the toggle, but a first-time user must click to discover the upload direction.
- **Primary button styling**: The "⇨ Send to Claude" button uses a `stitch-btn-primary` class (ported from `design.html`) to give it visual prominence over "Copy prompt". Confirm the teal accent is desired in the Planning panel.

## Complexity Audit

### Routine
- Removing the second `controls-strip-row` wrapper and its 4 buttons from `planning.html` (lines 3536–3542).
- Removing the 4 corresponding `addEventListener` blocks in `planning.js` (lines 7262–7312).
- Adding a direction toggle button + 2 unified buttons to the single row.
- Adding 2 unified click handlers that branch on `artifactDirectionIsDownload`.
- Updating the 2 confirmation handlers (`artifactPromptCopied` / `artifactPromptSent`) to target the new unified button IDs.
- Porting the 4-line `.stitch-btn-primary` CSS rule from `design.html` into `planning.html`.

### Complex / Risky
- None. Single-pass frontend refactor across two files, no backend changes, no data/state migration, no breaking changes to message contracts.

## Edge-Case & Dependency Audit
- **Race Conditions**: None. The direction toggle is synchronous UI state (`artifactDirectionIsDownload` boolean). Click handlers read it at click time. No async races.
- **Security**: No new surface. Prompt text is generated from existing templates (`ARTIFACT_DOWNLOAD_PROMPT` / `ARTIFACT_UPLOAD_PROMPT`) and sent via existing `vscode.postMessage` channels. No injection vectors introduced.
- **Side Effects**: The `artifactDirectionIsDownload` closure variable resets to `true` (download) on every webview reload. This is acceptable — download is the sensible default and webview reloads are infrequent. Not persisted to `state`.
- **Dependencies & Conflicts**:
  - **Download vs Upload semantics**: Download fetches from a URL and saves locally; Upload reads a local file and publishes to claude.ai. They use different prompt templates and different state (`getHtmlFolderFallback` vs `state.activeDocSourceFolder` + `state.activeDocName`). The direction toggle must switch both the prompt template and the state inputs — handled by `buildArtifactPrompt()`.
  - **`artifactPromptCopied` / `artifactPromptSent` message handlers** (planning.js lines ~4413–4434): These look up buttons by direction-specific IDs. Must be updated to target the new unified IDs (`btn-copy-artifact-prompt` / `btn-send-artifact-prompt`).
  - **Backend message types**: `copyArtifactPrompt` and `sendArtifactPromptToTerminal` both carry a `kind: 'download' | 'upload'` field. The backend uses `kind` to route the confirmation message back. Unchanged — we send the right `kind` based on the toggle.
  - **`isShareLink(url)` guard**: `ARTIFACT_DOWNLOAD_PROMPT` (line ~7218) checks for share links and returns a warning. Stays in the prompt function — no change needed.
  - **No folder configured**: When no HTML folder is configured, `getHtmlFolderFallback()` returns `''`. The prompt handles this case. No change needed.
  - **Other tabs**: The `controls-strip-row` class is also used by the **Tickets tab** (line ~3648, `id="tickets-content"`). The Research tab (line 3581) uses a card-based layout and does **not** use `controls-strip-row`. Removing the second row from the HTML tab does not affect Tickets or Research.
  - **`stitch-btn-primary` CSS**: Defined in `design.html` (lines 3325–3334) but **not** in `planning.html`. Must be ported into `planning.html` for the primary send button to render with its teal accent. Uses `--accent-teal-dim` / `--accent-teal` CSS variables, which are already available in `planning.html` (shared theme variables).

## Dependencies
- None. This plan is self-contained within `src/webview/planning.html` and `src/webview/planning.js`. No backend, no other webview, no external session dependency.

## Adversarial Synthesis
Key risks: (1) the `stitch-btn-primary` class is not defined in `planning.html`, so the primary send button would render unstyled unless the CSS is ported; (2) the Edge-Case audit originally mislabeled the Tickets tab as "Research." Mitigations: port the 4-line CSS rule from `design.html` into `planning.html`; correct the tab citation. No backend or data-consistency risks — the `kind` field contract is preserved.

## Proposed Changes

### `src/webview/planning.html` — Add `.stitch-btn-primary` CSS rule (after line ~2732)

Port the class from `design.html` so the primary send button renders with a teal accent. Insert after the `.controls-strip-row` rule (line 2732).

```css
.stitch-btn-primary {
    background: var(--accent-teal-dim);
    border-color: var(--accent-teal);
    color: var(--accent-teal);
    font-weight: 600;
}
.stitch-btn-primary:hover:not(:disabled) {
    background: var(--accent-teal);
    color: #000;
}
```

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
- **Single row** — no `controls-strip-row` wrappers. The `controls-strip` is already `display: flex; flex-wrap: nowrap; overflow-x: auto` (planning.html lines 185–195), so it handles overflow gracefully.
- **Direction toggle button** (`btn-artifact-direction`): cycles between "⇅ Download" and "⇅ Upload". Replaces the 4-button matrix with a 2-button pair + toggle.
- **One "Copy prompt" button** (`btn-copy-artifact-prompt`): replaces `btn-copy-artifact-download` and `btn-copy-artifact-upload`.
- **One "⇨ Send to Claude" button** (`btn-send-artifact-prompt`): replaces `btn-send-artifact-download` and `btn-send-artifact-upload`. Uses `stitch-btn-primary` for visual prominence (CSS ported above).

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
    if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    }
    break;
}
case 'artifactPromptSent': {
    const isDownload = msg.kind === 'download';
    const btnId = isDownload ? 'btn-send-artifact-download' : 'btn-send-artifact-upload';
    const btn = document.getElementById(btnId);
    if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Sent ✓';
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    }
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

### Automated Tests
- None. This is a webview UI refactor with no unit-test coverage in the repo for webview DOM handlers. Verification is manual via the installed VSIX.

### Manual Verification
1. **Visual**: Open the Planning panel, switch to the HTML tab. Confirm the controls strip is a **single row** with: workspace filter, search, status, direction toggle, artifact URL input, "Copy prompt", "⇨ Send to Claude". No second row.
2. **Direction toggle**: Click the "⇅ Download" button. Confirm it switches to "⇅ Upload" and the tooltip updates. Click again — switches back.
3. **Download flow**: With direction = Download, paste an artifact URL, click "Copy prompt". Confirm the clipboard contains `ARTIFACT_DOWNLOAD_PROMPT` output (mentions "Download a claude.ai artifact"). Click "⇨ Send to Claude". Confirm the prompt is sent to the terminal.
4. **Upload flow**: Switch direction to Upload. Click "Copy prompt". Confirm the clipboard contains `ARTIFACT_UPLOAD_PROMPT` output (mentions "Publish a local document back to claude.ai"). Click "⇨ Send to Claude". Confirm the prompt is sent.
5. **Confirmation feedback**: After copying, confirm the "Copy prompt" button briefly shows "Copied!". After sending, confirm the "⇨ Send to Claude" button briefly shows "Sent ✓".
6. **Primary button styling**: Confirm the "⇨ Send to Claude" button renders with the teal accent (`stitch-btn-primary`) and is visually distinct from "Copy prompt".
7. **Share-link warning**: Paste a `claude.ai/share/` URL with direction = Download, click "Copy prompt". Confirm the warning text about share links is in the clipboard.
8. **Other tabs unaffected**: Switch to Local, Online, Kanban, Tickets, Research tabs. Confirm their controls strips are unchanged.
9. **Sidebar collapse**: Collapse the sidebar. Confirm the single-row controls strip does not overflow or break layout (it should scroll horizontally via `overflow-x: auto`).

---

**Recommendation:** Complexity 3/10 → **Send to Coder.**

## Review Findings

**Stage 1 (Grumpy Principal Engineer):** Welcome, mortals, to the review dungeon. You flattened a button strip. Congratulations, you did the bare minimum. Let's see if you tripped on the way out.

- **NIT** — `artifactDirectionIsDownload` resets to `true` on every webview reload; not persisted to `state`. Plan acknowledges this as acceptable (download is the sensible default), so I'll allow it — but a user who toggles to Upload and triggers a reload silently loses their intent. (planning.js:7258)
- **NIT** — Confirmation handlers (`artifactPromptCopied`/`artifactPromptSent`) now ignore `msg.kind`; the backend (`PlanningPanelProvider.ts:2866,2873`) still forwards it. Dead field on the wire — harmless, but a future reader may wonder why `kind` is sent at all. (planning.js:4413–4430)
- **NIT** — `updateDirectionLabel()` runs once at init (planning.js:7275), overwriting the static HTML `title` with the longer dynamic tooltip. Intentional and correct — the static title is the short version; this upgrades it. Not a bug, just noting the double-write.
- **PASS** — No orphaned references to the 4 removed button IDs (`btn-copy-artifact-download`, etc.) anywhere in `src/webview`. Grep confirms zero hits.
- **PASS** — `.stitch-btn-primary` CSS ported verbatim from `design.html`; `--accent-teal-dim`/`--accent-teal` variables resolve in `planning.html` (shared theme). Primary button will render.
- **PASS** — `.controls-strip-row` CSS rule (planning.html:2727) retained; still used by the Tickets tab. Correctly not removed.
- **PASS** — `buildArtifactPrompt()` correctly branches prompt template AND state inputs (`getHtmlFolderFallback` for download vs `state.activeDocSourceFolder`+`state.activeDocName` for upload). Matches the original per-direction logic.
- **PASS** — `ARTIFACT_DOWNLOAD_PROMPT` share-link guard (planning.js:7214) intact; warning still emitted for `claude.ai/share/` URLs.

**Stage 2 (Balanced):** No CRITICAL or MAJOR findings. All three NITs are either explicitly accepted by the plan (direction-state reset) or harmless dead-field/double-write artifacts that don't warrant a code change. The implementation is a faithful, clean execution of the plan. No fixes applied.

**Files changed (per plan, verified in place):**
- `src/webview/planning.html` — `.stitch-btn-primary` CSS (lines 2735–2744); HTML tab controls strip flattened to single row (lines 3540–3550).
- `src/webview/planning.js` — direction toggle state + `buildArtifactPrompt()` + unified handlers (lines 7258–7307); confirmation handlers retargeted to unified IDs (lines 4413–4430).

**Validation:** Compilation and automated tests skipped per session instructions. Static verification via grep confirms no orphaned references, no ID mismatches, backend message contract intact. Manual verification steps (plan §Manual Verification) remain for the user via installed VSIX.

**Remaining risks:** None material. The direction-toggle discoverability tradeoff is flagged in the plan's "User Review Required" section and is a UX judgment, not a defect.
