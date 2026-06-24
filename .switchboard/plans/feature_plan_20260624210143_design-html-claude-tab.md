# Feature: Add a "Claude" Tab to design.html with Copy-Prompt and Send-to-Terminal Buttons

## Goal

Add a new top-level tab named **CLAUDE** to `design.html`, positioned in the shared tab bar alongside STITCH / BRIEFS / HTML PREVIEWS / IMAGES / DESIGN SYSTEM. The Claude tab behaves **exactly like the HTML PREVIEWS tab** (folder sidebar + zoomable HTML iframe preview), but adds a prompt action bar with two buttons:

1. **Copy Claude prompt** — copies a ready-made prompt to the clipboard that the user can paste into a Claude terminal, instructing Claude to run the `/design` command to import designs from Claude design.
2. **Send prompt to terminal** — sends that same prompt directly into a terminal (no manual paste).

### Problem Analysis & Context

`design.html` already has a fully working HTML previews tab — a folder tree (`#tree-pane-html`), a sandboxed preview iframe (`#html-preview-frame`), zoom/pan, and a backend refresh pipeline. The relevant pieces:

- **Tab bar:** [design.html:3610-3616](../../src/webview/design.html#L3610-L3616) — five `.shared-tab-btn` buttons with `data-tab` attributes.
- **Tab content panes:** each `<div id="<tab>-content" class="shared-tab-content">`; the HTML previews pane is [design.html:3744-3790](../../src/webview/design.html#L3744-L3790).
- **Tab switching JS:** `switchTab(tabName)` in [design.js:130-187](../../src/webview/design.js#L130-L187) is fully generic — it toggles `.active` on the button whose `data-tab` matches and the pane whose id is `<tabName>-content`. It also fires `refreshDocsForTab` for `html-preview` / `images` / `briefs` ([design.js:170-172](../../src/webview/design.js#L170-L172)).
- **File selection → preview:** clicking an `html-folder` tree node sets `state.activeDocId` / `state.activeDocName` and posts `fetchPreview` ([design.js:870-896](../../src/webview/design.js#L870-L896)).
- **Backend message routing:** `DesignPanelProvider._handleMessage` ([DesignPanelProvider.ts:1267](../../src/services/DesignPanelProvider.ts#L1267)) already handles `refreshDocsForTab` → `_sendHtmlDocsReady()` ([1236-1248](../../src/services/DesignPanelProvider.ts#L2236-L2248)), and `linkToDocument` shows the existing clipboard pattern via `vscode.env.clipboard.writeText` ([1460-1472](../../src/services/DesignPanelProvider.ts#L1460-L1472)).

There is **no existing `/design` command** in the repo's `.claude/` directory and **no terminal-send capability in `DesignPanelProvider`** — both are net-new for this feature. The send-to-terminal capability can reuse `pasteTextViaClipboard` from [terminalUtils.ts:21](../../src/services/terminalUtils.ts#L21) (already used by `TaskViewerProvider`).

### Design decision: reuse the HTML previews source

"Same as the HTML previews tab" is best satisfied by having the Claude tab **render the same HTML folder source** the previews tab uses, into its own DOM ids, so a user browses the same HTML designs and can act on the selected one. To avoid duplicating the entire tree/preview pipeline, the lowest-risk approach is to make the Claude pane reuse the **html-folder** source id and the existing `fetchPreview`/`_sendHtmlDocsReady` plumbing, distinguished only by its own container ids and an added prompt bar.

## Metadata

- **Tags:** `feature`, `design.html`, `frontend`, `backend`, `DesignPanelProvider`, `terminals`, `claude`
- **Complexity:** 5/10

## Complexity Audit

**Moderate, leaning routine.** The tab framework and the HTML-preview pipeline already exist and the tab switcher is generic, so adding the tab button + pane is low-risk. The genuinely new surface is: (a) a prompt action bar with two buttons, (b) a backend clipboard handler (trivial — mirror `linkToDocument`), and (c) a backend **send-to-terminal** handler, which is the only novel capability in `DesignPanelProvider` and the main place to get right (terminal resolution, paced send, CLI `/clear` concatenation hazard). No DB or schema changes.

## Edge-Case & Dependency Audit

- **Reusing the html-folder source:** If the Claude pane reuses `sourceId: 'html-folder'`, confirm `fetchPreview` responses are routed to the Claude pane's iframe when the Claude tab is active. Either (a) give the Claude pane distinct ids and have the preview-ready handler target whichever tab is active, or (b) duplicate the html source as a `claude-folder` source in the backend. Option (a) is less code; option (b) is cleaner isolation. Recommend (a).
- **`switchTab` generic contract:** the new pane MUST be `<div id="claude-content" class="shared-tab-content">` and the button MUST be `data-tab="claude"` so the existing switcher works with zero JS changes to the toggling logic. Add `'claude'` to the `refreshDocsForTab` trigger list ([design.js:170](../../src/webview/design.js#L170)) so the folder list refreshes on entry.
- **Prompt with no file selected:** Both buttons must work even when no HTML file is selected — the prompt then references the configured design folder generically rather than a specific file. Guard against `state.activeDocName` being null.
- **`/clear` concatenation hazard:** When sending to a CLI agent terminal, a raw `sendText('/design …')` can be mis-parsed if the terminal is mid-prompt. Reuse `pasteTextViaClipboard` + a paced submit (the same approach `TaskViewerProvider._handleDeliver` uses) rather than naive `sendText`.
- **Terminal resolution:** "Send to terminal" needs a target. Options: the VS Code **active terminal** (`vscode.window.activeTerminal`), or a dedicated terminal created/reused by name (e.g. "Claude"). Recommend: use the active terminal if one exists, else create a terminal named "Claude", `show()` it, then send. Surface a warning if creation fails.
- **Clipboard restore:** `pasteTextViaClipboard` overwrites the clipboard; confirm whether it restores prior contents (terminalUtils behavior) so the Copy button and Send button don't interfere with each other's clipboard expectations.
- **CSP / nonce:** New buttons are plain DOM with handlers in `design.js` (already nonce-loaded at [design.html:4063](../../src/webview/design.html#L4063)); no inline scripts, no new external resources — CSP unaffected.
- **Theme parity:** The Claude pane must carry the same theme classes/structure as the html pane (`.preview-panel-wrapper`, `.cyber-scanlines`, `.zoomable-container`) so cyber/claudify themes render correctly. Copy the html pane's structure verbatim and only add the action bar.
- **`/design` command does not exist yet:** This feature only emits a prompt that *asks Claude to run* `/design`. Whether `/design` is a real Claude Code slash command the user has installed is out of scope — the prompt text is the deliverable. Make the prompt template a single named constant so it's easy to tune.

## Proposed Changes

### File 1: `src/webview/design.html`

**1a. Add the tab button** ([design.html:3613](../../src/webview/design.html#L3613), after HTML PREVIEWS):

```html
<button class="shared-tab-btn" data-tab="claude">CLAUDE</button>
```

**1b. Add the Claude pane** — clone the HTML previews pane ([3744-3790](../../src/webview/design.html#L3744-L3790)) with `claude-`-prefixed ids and an added prompt action bar in the controls strip:

```html
<!-- Claude Tab -->
<div id="claude-content" class="shared-tab-content">
    <div class="controls-strip" id="controls-strip-claude">
        <select id="claude-workspace-filter" class="workspace-filter-select">
            <option value="">All Workspaces</option>
        </select>
        <input type="text" id="claude-docs-search" class="sidebar-search-input" placeholder="Search previews..." />
        <span id="status-claude" style="margin-left:0;font-size:12px;color:var(--text-secondary);">No folder configured</span>
        <span style="flex:1;"></span>
        <button id="btn-copy-claude-prompt" class="strip-btn" title="Copy a prompt to paste into a Claude terminal">Copy Claude prompt</button>
        <button id="btn-send-claude-prompt" class="strip-btn" title="Send the prompt directly to a terminal">Send prompt to terminal</button>
    </div>
    <div class="content-row">
        <div id="tree-pane-claude">
            <div class="sidebar-toggle-row"><button class="sidebar-toggle-btn" title="Toggle sidebar">«</button></div>
            <div class="empty-state">Configure a folder to browse HTML files</div>
        </div>
        <div class="preview-panel-wrapper">
            <div id="preview-pane-claude" style="flex:1;width:100%;box-sizing:border-box;height:100%;display:flex;flex-direction:column;overflow:hidden;">
                <!-- initial / loading / iframe wrapper: same markup as #preview-pane-html, with claude- ids -->
                <div id="claude-preview-wrapper" class="zoomable-container" style="display:none;flex:1;">
                    <div class="zoomable-viewport" style="width:100%;height:100%;">
                        <iframe id="claude-preview-frame" sandbox="allow-scripts allow-same-origin" style="border:none;background:var(--panel-bg);width:100%;height:100%;display:block;"></iframe>
                    </div>
                    <div class="zoom-event-layer"></div>
                    <div class="zoom-toolbar">
                        <button class="zoom-btn" data-action="zoom-in">+</button>
                        <button class="zoom-btn" data-action="zoom-out">−</button>
                        <button class="zoom-btn" data-action="reset">⟲</button>
                        <button class="zoom-btn" data-action="fit">⤢</button>
                    </div>
                </div>
            </div>
            <div class="cyber-scanlines"></div>
        </div>
    </div>
</div>
```

(Include the `claude-initial-state` / `claude-loading-state` blocks mirroring the html pane for parity.)

### File 2: `src/webview/design.js`

**2a. Refresh-on-entry:** add `'claude'` to the tab list that triggers a folder rescan ([design.js:170](../../src/webview/design.js#L170)):

```js
if (tabName === 'html-preview' || tabName === 'images' || tabName === 'briefs' || tabName === 'claude') {
    vscode.postMessage({ type: 'refreshDocsForTab', tab: tabName });
}
```

**2b. Tree rendering + selection:** wire the Claude tree pane to the same html-folder source and route its selection to `#claude-preview-frame`. Reuse the existing tree-render function with the Claude container ids, and on node click post `fetchPreview` with a marker (e.g. `target: 'claude'`) so the preview-ready handler renders into the Claude iframe. Track `state.activeClaudeDocName` / `state.activeClaudeDocPath` for the prompt.

**2c. Zoom init:** register the Claude iframe with the zoom engine, mirroring [design.js:357](../../src/webview/design.js#L357):

```js
initZoomListeners('claude-preview-wrapper', '.zoomable-viewport', 'claude');
```
(add a `claude` entry to `zoomState`, [design.js:190-194](../../src/webview/design.js#L190-L194).)

**2d. Button handlers:**

```js
const CLAUDE_DESIGN_PROMPT = (fileRef) =>
    `Use the /design command to import the latest designs from Claude design into this project.` +
    (fileRef ? `\n\nReference design file: ${fileRef}` : ``);

document.getElementById('btn-copy-claude-prompt')?.addEventListener('click', () => {
    vscode.postMessage({
        type: 'copyClaudeDesignPrompt',
        prompt: CLAUDE_DESIGN_PROMPT(state.activeClaudeDocPath || null)
    });
});

document.getElementById('btn-send-claude-prompt')?.addEventListener('click', () => {
    vscode.postMessage({
        type: 'sendClaudeDesignPrompt',
        prompt: CLAUDE_DESIGN_PROMPT(state.activeClaudeDocPath || null)
    });
});
```

### File 3: `src/services/DesignPanelProvider.ts`

**3a. Import the paced terminal sender** (top of file):

```ts
import { pasteTextViaClipboard } from './terminalUtils';
```

**3b. Handle `copyClaudeDesignPrompt`** in `_handleMessage` ([DesignPanelProvider.ts:1271](../../src/services/DesignPanelProvider.ts#L1271)), mirroring `linkToDocument`:

```ts
case 'copyClaudeDesignPrompt': {
    const prompt = String(message.prompt || '');
    if (!prompt) break;
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Copied Claude /design prompt to clipboard.');
    break;
}
```

**3c. Handle `sendClaudeDesignPrompt`** — resolve a terminal and paced-send:

```ts
case 'sendClaudeDesignPrompt': {
    const prompt = String(message.prompt || '');
    if (!prompt) break;
    let terminal = vscode.window.activeTerminal;
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name: 'Claude' });
    }
    terminal.show();
    try {
        await pasteTextViaClipboard(terminal, prompt); // avoids /clear-style slash concatenation
        await new Promise(r => setTimeout(r, 300));
        terminal.sendText('', true);                   // submit
    } catch (err: any) {
        vscode.window.showErrorMessage('Failed to send prompt to terminal: ' + err.message);
    }
    break;
}
```

**3d. (If routing approach (a) is used) Claude preview source:** ensure `refreshDocsForTab` with `tab: 'claude'` returns the same html docs. Either add a `case 'claude':` that calls `await this._sendHtmlDocsReady();` (tagging the response so the webview routes it to the Claude tree), or share the html docs payload. Keep the html and Claude panes reading the same configured HTML folders.

## Verification Plan

**Step 1 — Tab appears & switches.** Open the design panel. Confirm a CLAUDE tab sits in the tab bar after HTML PREVIEWS, switching to it shows the Claude pane, and switching away/back works. Confirm the other tabs are unaffected.

**Step 2 — Preview parity.** With an HTML folder configured, confirm the Claude tab lists the same files as HTML PREVIEWS, clicking a file renders it in the Claude iframe, and zoom/pan works identically. Confirm theme (cyber/claudify) renders correctly in the Claude pane.

**Step 3 — Copy button.** With a file selected, click **Copy Claude prompt**; confirm an info toast appears and the clipboard contains the prompt including the selected file reference. With no file selected, confirm the prompt is copied without a file reference (no crash).

**Step 4 — Send button (existing terminal).** Open a terminal, select it as active, click **Send prompt to terminal**; confirm the prompt is pasted into that terminal and submitted as one intact line (no `/clear`-style concatenation, no truncation).

**Step 5 — Send button (no terminal).** With no open terminal, click **Send prompt to terminal**; confirm a terminal named "Claude" is created, shown, and receives the prompt.

**Step 6 — Build & install.** Build the extension, reload, and re-run Steps 1–5 against the installed extension (not `dist/`) to confirm the source edits to `design.html` / `design.js` / `DesignPanelProvider.ts` are what's exercised.
