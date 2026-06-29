# Claude.ai Artifact Round-Trip in the planning.html HTML Tab

## Goal

Add a **claude.ai artifact round-trip** workflow to the planning.html **HTML tab**: paste a claude.ai artifact URL, copy a **download prompt** that drives Claude Code to fetch the artifact into a local HTML folder (where the existing HTML previewer immediately renders it), edit it locally with **any** agent (Gemini, etc.), then copy an **upload prompt** that drives Claude Code to re-publish the edited file back to the same artifact URL.

The feature is **prompt-generation only** — two "copy prompt to clipboard" buttons that mirror the existing Claude design-import button. The webview never touches the network; Claude Code does the actual `WebFetch` (download) and `Artifact`-tool publish (upload).

### Core problem & background

The user shares **stakeholder document artifacts** (PRDs, briefs, proposals — *documents, not designs*) as hosted claude.ai artifacts, and wants a repeatable loop: pull an artifact down → hand it to any coding agent for edits → push it back up. Today there is no in-product affordance for this; it is manual copy-paste.

Two architectural facts make the design:

1. **The webview cannot do the fetch/publish itself.** planning.html runs in a sandboxed VS Code webview iframe under a strict CSP — it cannot fetch `claude.ai`, and it has no access to agent tools. **Only Claude Code can** round-trip an artifact: download = `WebFetch <url>` → write a local file; upload = read the local file → `Artifact` tool with `url=<url>` to redeploy to the same page. So the correct architecture is a **prompt bridge**: the webview builds a prompt string and copies it to the clipboard; the user pastes it into Claude Code, which executes it. This exact pattern already ships as the Claude design tab's "Copy import prompt" button (`design.js:4387` → `copyClaudeImportPrompt` → `DesignPanelProvider.ts:1592` → `vscode.env.clipboard.writeText`).

2. **The HTML tab already is the document previewer.** The HTML tab (`planning.html:3469`) is a folder-backed HTML previewer: a configured-folder sidebar + a sandboxed `<iframe id="planning-html-frame">` preview pane with a zoom toolbar. If the download prompt saves the artifact **into a configured HTML folder**, the downloaded document **automatically appears in the sidebar and renders in the preview pane** with zero new preview code. The HTML tab — not the design tab — is the right home precisely because these are stakeholder **documents**; the design tab is reserved for designs.

So the work is almost entirely **wiring existing pieces**: add a small controls sub-row to the HTML tab, two prompt-builder functions (clones of `CLAUDE_IMPORT_PROMPT`), one new clipboard message handler (clone of `copyChatPrompt`), and a "Copied!" confirmation (the established button-text-flash pattern).

### Root cause

There has never been an in-product bridge between a hosted claude.ai artifact and the local repo. The plumbing to build it (prompt-copy bridge + folder-backed HTML previewer) already exists but has never been pointed at artifacts.

## Metadata

- **Tags:** [frontend, backend, ui, feature]
- **Complexity:** 3

## User Review Required

- None. The design decisions are made:
  1. **Home = HTML tab** of planning.html (per the user: design tab is for designs; these are stakeholder documents).
  2. **Prompt-bridge, not direct fetch** — forced by the webview CSP/sandbox (see Core problem #1).
  3. **Round-trip is self-describing via an embedded source marker** — the download prompt stamps a `<!-- switchboard-artifact-source: <url> -->` comment as the file's first line; the upload prompt reads it to know which URL to redeploy to. This avoids any new persistence/metadata store.
  4. **Ownership caveat is worded into the upload prompt** — redeploying to an existing URL only overwrites if the user owns that artifact; otherwise the `Artifact` tool mints a new URL, and the prompt instructs Claude Code to report the new URL.

## Complexity Audit

### Routine
- Adding a second `controls-strip-row` to `#controls-strip-planning-html` with a URL input + two buttons (mirror the tickets tab's multi-row controls strip, `planning.html:3580`).
- Two prompt-builder template functions in planning.js (mirror `CLAUDE_IMPORT_PROMPT`, `design.js:4387`).
- One new `case 'copyArtifactPrompt'` in the provider that writes to the clipboard and posts a confirmation (mirror `copyChatPrompt`, `PlanningPanelProvider.ts:2769`).
- "Copied!" button-text flash on confirmation (mirror `planning.js:3835`, `:9077`).

### Complex / Risky
- **Resolving the download target folder** so the saved file lands somewhere the HTML previewer scans. Must reuse the HTML tab's configured-folder data (the `html-folder-modal` / `listPlanningHtmlFolders` / `planningHtmlFoldersListed` flow, `planning.js:6741`, `:4312`) with a sensible fallback when no folder is configured.
- **Resolving the upload target file** — the upload prompt needs a concrete local file. Reuse the previewer's current selection (`state.activeDocName` / `state.activeDocId`, set in `loadPlanningHtmlPreview`, `planning.js:6726`). Fall back to a filename derived from the URL when nothing is selected.

## Edge-Case & Dependency Audit

- **No folder configured:** If the HTML tab has no configured folder, the download prompt must still be useful — fall back to instructing Claude Code to save into the active workspace root (or a sensible `docs/` subfolder) and tell the user to add that folder via **Manage HTML Folders** to see the preview. Do NOT silently produce a prompt with an empty path.
- **No file selected for upload:** If `state.activeDocName` is empty, derive a filename from the URL slug and word the upload prompt to "read the file you downloaded from `<url>`". Never emit an upload prompt with a blank file path.
- **Ownership / new-URL on upload:** A teammate-owned artifact cannot be overwritten; the `Artifact` tool will mint a new URL. The upload prompt explicitly tells Claude Code to surface the new URL in that case. (No way for the webview to know ownership ahead of time — this is correctly deferred to Claude Code at execution.)
- **Marker round-trips cleanly:** The `<!-- switchboard-artifact-source: <url> -->` marker is an HTML comment, so it renders invisibly in the iframe preview and survives editing by other agents. For Markdown artifacts it is still a valid (HTML) comment line. The upload prompt instructs Claude Code to preserve/refresh the marker.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): both buttons act immediately — they copy to clipboard and flash "Copied!". No `confirm()`, no modal gate. (`confirm()` is a silent no-op in webviews anyway.)
- **Security / path construction:** The webview only assembles a *prompt string*; it never constructs a real filesystem write. Actual file writes happen inside Claude Code. The provider handler only calls `clipboard.writeText` — no path handling, no fs.
- **Dependencies & conflicts:** Self-contained. New message type `copyArtifactPrompt` + confirmation `artifactPromptCopied` do not collide with existing types. No DB, no migration, no settings change. Independent of the design tab's Claude flow (different surface, different message types).

## Dependencies

- None. No other plan blocks or is blocked by this.

## Adversarial Synthesis

Key risks and mitigations: (1) **Webview tries to fetch directly** and silently fails under CSP — mitigated by the prompt-bridge architecture; the webview only builds strings. (2) **Downloaded file lands where the previewer can't see it** — mitigated by resolving the target to a configured HTML folder and falling back with an explicit "add this folder" instruction rather than an empty path. (3) **Upload overwrites the wrong artifact or fails on a non-owned URL** — mitigated by the self-describing source-marker (upload targets exactly the URL the file came from) plus explicit "report the new URL if it mints one" wording. (4) **A banned `confirm()`/modal sneaks in** — mitigated by spec'ing immediate-action buttons with a text-flash only. (5) **New message type clobbers an existing handler** — mitigated by using distinct names (`copyArtifactPrompt` / `artifactPromptCopied`) verified absent from current handlers. (6) **Marker comment breaks rendering or gets stripped** — mitigated by using a standard HTML comment as line 1 (invisible in iframe, valid in HTML and Markdown) and instructing the upload prompt to preserve it.

## Proposed Changes

### 1. `src/webview/planning.html` — add a round-trip controls sub-row to the HTML tab
In `#controls-strip-planning-html` (line 3470), add a second row (use the `controls-strip-row` pattern from the tickets tab, `planning.html:3580`) containing:
- `<input type="text" id="planning-html-artifact-url" class="sidebar-search-input" placeholder="claude.ai artifact URL…">`
- `<button id="btn-copy-artifact-download" class="strip-btn" title="Copy a prompt that downloads this artifact into the selected HTML folder">Copy download prompt</button>`
- `<button id="btn-copy-artifact-upload" class="strip-btn" title="Copy a prompt that re-publishes the previewed file back to claude.ai">Copy upload prompt</button>`

Keep it inside the existing controls strip so the sidebar + preview layout below is untouched.

### 2. `src/webview/planning.js` — prompt builders + listeners + confirmation
- Add two template functions next to where HTML-tab logic lives (model on `CLAUDE_IMPORT_PROMPT`, `design.js:4387`):

  ```js
  const ARTIFACT_DOWNLOAD_PROMPT = ({ url, folder, filename }) =>
    `Download a claude.ai artifact into this repo so I can preview and edit it locally.\n\n` +
    `1. Use WebFetch to retrieve the content at: ${url}\n` +
    `2. Save the full content to: ${folder ? folder + '/' : ''}${filename}\n` +
    (folder ? `` : `   (No HTML folder is configured in Switchboard — after saving, add this file's folder via "Manage HTML Folders" to preview it in the HTML tab.)\n`) +
    `3. Make the FIRST line of the saved file this marker so the round-trip knows the source:\n` +
    `   <!-- switchboard-artifact-source: ${url} -->\n` +
    `4. Report the local path you saved.`;

  const ARTIFACT_UPLOAD_PROMPT = ({ url, folder, filename }) =>
    `Publish a local document back to claude.ai as an Artifact.\n\n` +
    `1. Read the file: ${folder ? folder + '/' : ''}${filename}\n` +
    `2. If it contains a \`switchboard-artifact-source:\` marker comment, redeploy to that existing URL by passing it as the Artifact tool's \`url\`. NOTE: this only overwrites if I own that artifact; if the tool mints a NEW url instead, tell me the new url.\n` +
    (url ? `   (Expected source url: ${url})\n` : ``) +
    `3. If there is no marker, publish as a new Artifact and report the new url.\n` +
    `4. Preserve (or refresh) the marker comment, and use the file's <title>/first heading as the artifact title.`;
  ```

- Wire `#btn-copy-artifact-download`: read the URL input, resolve the target folder from the HTML-tab folder config (the data backing `listPlanningHtmlFolders`/`planningHtmlFoldersListed`, `planning.js:4312`/`:6741`) with workspace-root fallback, derive a filename from the URL slug, build the prompt, and `vscode.postMessage({ type: 'copyArtifactPrompt', prompt, kind: 'download' })`.
- Wire `#btn-copy-artifact-upload`: resolve the previewed file from `state.activeDocName` (set in `loadPlanningHtmlPreview`, `planning.js:6726`) + its source folder; fall back to a URL-derived filename if nothing is selected; build the prompt; post `{ type: 'copyArtifactPrompt', prompt, kind: 'upload' }`.
- Handle the confirmation: add a `case 'artifactPromptCopied'` in the webview message switch that flashes the relevant button's text to `Copied!` then restores it (mirror `kanbanPlanPromptCopied`, `planning.js:3835`).

### 3. `src/services/PlanningPanelProvider.ts` — clipboard handler
In `_handleMessage` (the big switch starting `:1935`), add:

```ts
case 'copyArtifactPrompt': {
    await vscode.env.clipboard.writeText(msg.prompt || '');
    const targetPanel = isProject ? this._projectPanel : this._panel;
    targetPanel?.webview.postMessage({ type: 'artifactPromptCopied', kind: msg.kind });
    break;
}
```

This mirrors `copyChatPrompt` (`:2769`) and `copyClaudeImportPrompt` (`DesignPanelProvider.ts:1592`). No fs, no path handling, no DB.

## Testing & Verification

- **Build:** `npm run compile` succeeds (only needed for VSIX; `src/` is source of truth for dev/test).
- **Download path:** In the HTML tab, paste a claude.ai artifact URL, click **Copy download prompt**, paste into Claude Code → it `WebFetch`es the URL, writes the file with the `switchboard-artifact-source` marker as line 1 into the configured HTML folder, and the file appears in the HTML sidebar and renders in the iframe.
- **Edit hand-off:** Open the saved file in any agent (e.g. Gemini), make an edit, confirm the marker comment survives.
- **Upload path:** With that file previewed, click **Copy upload prompt**, paste into Claude Code → it reads the marker and redeploys to the same URL (or reports a new URL if not owned).
- **No-folder fallback:** With no HTML folder configured, the download prompt still produces a valid path + the "add this folder" instruction.
- **No-selection fallback:** With nothing previewed, the upload prompt uses a URL-derived filename, no blank path.
- **House rules:** Buttons act immediately (no confirm dialog); "Copied!" flashes; clipboard contains the expected prompt.
