# Claude.ai Artifact Round-Trip in the planning.html HTML Tab

## Goal

Add a **claude.ai artifact round-trip** workflow to the planning.html **HTML tab**: paste a claude.ai artifact URL, copy a **download prompt** that drives Claude Code to fetch the artifact into a local HTML folder (where the existing HTML previewer immediately renders it), edit it locally with **any** agent (Gemini, etc.), then copy an **upload prompt** that drives Claude Code to re-publish the edited file back to the same artifact URL.

The feature is **prompt-generation only** — two "copy prompt to clipboard" buttons that mirror the existing Claude design-import button. The webview never touches the network; Claude Code does the actual `WebFetch` (download) and `Artifact`-tool publish (upload).

### Core problem & background

The user shares **stakeholder document artifacts** (PRDs, briefs, proposals — *documents, not designs*) as hosted claude.ai artifacts, and wants a repeatable loop: pull an artifact down → hand it to any coding agent for edits → push it back up. Today there is no in-product affordance for this; it is manual copy-paste.

Two architectural facts make the design:

1. **The webview cannot do the fetch/publish itself.** planning.html runs in a sandboxed VS Code webview iframe under a strict CSP — it cannot fetch `claude.ai`, and it has no access to agent tools. **Only Claude Code can** round-trip an artifact: download = `WebFetch <url>` → write a local file; upload = read the local file → `Artifact` tool with `url=<url>` to redeploy to the same page. So the correct architecture is a **prompt bridge**: the webview builds a prompt string and copies it to the clipboard; the user pastes it into Claude Code, which executes it. This exact pattern already ships as the Claude design tab's "Copy import prompt" button (`design.js:4387` → `copyClaudeImportPrompt` → `DesignPanelProvider.ts:1592` → `vscode.env.clipboard.writeText`).

   **Research-confirmed constraints (see ## Research Findings):** The round-trip only works for **Claude Code-native artifacts** (`claude.ai/code/artifact/{uuid}`), not standard chat share links (`claude.ai/share/{uuid}`, which are immutable snapshots). `WebFetch` retrieves the rendered content only when Claude Code has an active authenticated session (`/login`). The `Artifact` tool requires a **Team or Enterprise plan** and org-level "Artifacts" capability enabled. The download/upload prompts must encode these prerequisites so the user gets a actionable prompt, not a silent failure.

2. **The HTML tab already is the document previewer.** The HTML tab (`planning.html:3469`) is a folder-backed HTML previewer: a configured-folder sidebar + a sandboxed `<iframe id="planning-html-frame">` preview pane with a zoom toolbar. If the download prompt saves the artifact **into a configured HTML folder**, the downloaded document **automatically appears in the sidebar and renders in the preview pane** with zero new preview code. The HTML tab — not the design tab — is the right home precisely because these are stakeholder **documents**; the design tab is reserved for designs.

So the work is almost entirely **wiring existing pieces**: add a small controls sub-row to the HTML tab, two prompt-builder functions (clones of `CLAUDE_IMPORT_PROMPT`), one new clipboard message handler (clone of `copyChatPrompt`), and a "Copied!" confirmation (the established button-text-flash pattern).

### Root cause

There has never been an in-product bridge between a hosted claude.ai artifact and the local repo. The plumbing to build it (prompt-copy bridge + folder-backed HTML previewer) already exists but has never been pointed at artifacts.

## Metadata

- **Tags:** [frontend, backend, ui, feature]
- **Complexity:** 4

## User Review Required

- None. The design decisions are made:
  1. **Home = HTML tab** of planning.html (per the user: design tab is for designs; these are stakeholder documents).
  2. **Prompt-bridge, not direct fetch** — forced by the webview CSP/sandbox (see Core problem #1).
  3. **Round-trip is self-describing via an embedded source marker** — the download prompt stamps a `<!-- switchboard-artifact-source: <url> -->` comment as the file's first line; the upload prompt reads it to know which URL to redeploy to. This avoids any new persistence/metadata store.
  4. **Ownership caveat is worded into the upload prompt** — redeploying to an existing URL only overwrites if the user owns that artifact; otherwise the `Artifact` tool errors out (server-side permission denial) and may fall back to minting a new URL. The prompt instructs Claude Code to report either outcome.
  5. **Claude Code-native artifacts only** (`claude.ai/code/artifact/{uuid}`) — standard chat share links (`claude.ai/share/{uuid}`) are immutable snapshots and cannot be round-tripped. The download prompt detects the URL type and warns if a share link is pasted.
  6. **Auth/plan prerequisites are baked into the prompts** — the download prompt instructs Claude Code to run `/login` first if not authenticated; both prompts note the Team/Enterprise plan + org-capability requirement so the user understands why a prompt might fail.
  7. **Single canonical publish-form file** — the on-disk file is wrapperless + fully inlined (publish-ready), normalized once at download. It both previews locally and republishes with no per-edit reformatting, so there is no separate "source" vs "build" copy. The upload prompt re-asserts the no-wrapper / inline-only constraints to guard against edits by non-Claude agents.

## Complexity Audit

### Routine
- Adding a second `controls-strip-row` to `#controls-strip-planning-html` with a URL input + two buttons. **Note:** the base `.controls-strip` (`planning.html:185`) is a row (`display:flex`); only `#controls-strip-tickets` stacks because of its `flex-direction: column` override (`planning.html:2682`). To stack a second row under the HTML tab's existing controls, add the same `#controls-strip-planning-html { flex-direction: column; align-items: stretch; gap: 6px; }` override AND wrap the existing select/input/span in a `.controls-strip-row` so both rows are siblings inside the column-oriented strip.
- Two prompt-builder template functions in planning.js (mirror `CLAUDE_IMPORT_PROMPT`, `design.js:4387`).
- One new `case 'copyArtifactPrompt'` in the provider that writes to the clipboard and posts a confirmation (mirror `copyChatPrompt`, `PlanningPanelProvider.ts:2782`).
- "Copied!" button-text flash on confirmation (mirror `kanbanPlanPromptCopied`, `planning.js:3832`).

### Complex / Risky
- **Resolving the download target folder** so the saved file lands somewhere the HTML previewer scans. Must reuse the HTML tab's configured-folder data (the `html-folder-modal` / `listPlanningHtmlFolders` / `planningHtmlFoldersListed` flow, `planning.js:6741`, `:4312`) with a sensible fallback when no folder is configured.
- **Resolving the upload target file** — the upload prompt needs a concrete local file. Reuse the previewer's current selection (`state.activeDocName` / `state.activeDocId`, set in `loadPlanningHtmlPreview`, `planning.js:6730`). **Gap:** `loadPlanningHtmlPreview` currently sets `state.activeSource/activeDocId/activeDocName` but does NOT stash `sourceFolder` on `state` (it only passes `sourceFolder` into the `fetchPreview` message). The upload prompt builder needs the folder to construct `${folder}/${filename}`. **Fix:** add `state.activeDocSourceFolder = sourceFolder;` inside `loadPlanningHtmlPreview` (alongside `state.activeDocName = docName;` at `planning.js:6744`) so the upload button can resolve the full path. Fall back to a filename derived from the URL when nothing is selected.

## Edge-Case & Dependency Audit

- **Format normalization (wrappers + inline-only assets) — the main churn/breakage risk:** The two ends of the round-trip use different HTML forms. `WebFetch` returns the host-**wrapped** full document (`<!DOCTYPE><html><head>…</head><body>…`), but the `Artifact` tool **re-wraps** on publish — **confirmed empirically: it double-wraps**, nesting the file inside its own skeleton, and the wrapper + host-injected script/CSS layers accumulate on every round-trip if not stripped on download — and its CSP **blocks all external resources**. So (a) the **download** prompt normalizes the fetched page to publish-form **once** — strip the outer document wrappers, keep inner `<title>`/`<style>`/`<script>`, add `<meta charset="utf-8">` — making the on-disk file the single canonical form that both previews locally AND uploads with zero reformat; (b) the **upload** prompt re-asserts the constraints (no wrappers, all assets inlined as `data:` URIs) because the file may have been edited by a non-Claude agent (Gemini, etc.) that doesn't know the inline-only rule and could reintroduce an external `<link>`/`<img>` that renders locally but vanishes once published. A wrapperless, fully-inlined fragment renders fine in a browser/iframe (the browser supplies the missing structure; inlined assets work offline), so **one** publish-form file serves both preview and publish — no separate "source" + "build" copy, and no per-edit reformatting.
- **No folder configured:** If the HTML tab has no configured folder, the download prompt must still be useful — fall back to instructing Claude Code to save into the active workspace root (or a sensible `docs/` subfolder) and tell the user to add that folder via **Manage HTML Folders** to see the preview. Do NOT silently produce a prompt with an empty path.
- **No file selected for upload:** If `state.activeDocName` is empty, derive a filename from the URL slug and word the upload prompt to "read the file you downloaded from `<url>`". Never emit an upload prompt with a blank file path.
- **Ownership / permission-error on upload:** A teammate-owned artifact cannot be overwritten; the `Artifact` tool returns a server-side permission error. The agent may fall back to minting a new URL under the active user's ownership. The upload prompt explicitly tells Claude Code to report either the successful redeploy OR the permission error + any new URL it minted as a fallback. (No way for the webview to know ownership ahead of time — this is correctly deferred to Claude Code at execution.)
- **Wrong URL type (share link vs. code artifact):** Standard chat share links (`claude.ai/share/{uuid}`) are immutable snapshots — `WebFetch` retrieves only a React shell / 403, and the `Artifact` tool cannot redeploy to them. The download prompt builder must detect the URL pattern: if the URL contains `/share/`, emit a warning in the prompt ("this is a share link, not a Claude Code artifact — the content may not be retrievable and cannot be republished to this URL; ask the owner to share the `claude.ai/code/artifact/` URL instead"). If the URL contains `/code/artifact/`, proceed normally.
- **Auth/session not established:** `WebFetch` only returns rendered content when Claude Code has an active authenticated session. The download prompt instructs Claude Code to run `/login` first if not already authenticated. Both prompts note the Team/Enterprise plan + org-capability prerequisite so the user understands a potential failure cause.
- **Marker round-trips cleanly:** The `<!-- switchboard-artifact-source: <url> -->` marker is an HTML comment, so it renders invisibly in the iframe preview and survives editing by other agents. For Markdown artifacts it is still a valid (HTML) comment line. The upload prompt instructs Claude Code to preserve/refresh the marker.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): both buttons act immediately — they copy to clipboard and flash "Copied!". No `confirm()`, no modal gate. (`confirm()` is a silent no-op in webviews anyway.)
- **Security / path construction:** The webview only assembles a *prompt string*; it never constructs a real filesystem write. Actual file writes happen inside Claude Code. The provider handler only calls `clipboard.writeText` — no path handling, no fs.
- **Dependencies & conflicts:** Self-contained. New message type `copyArtifactPrompt` + confirmation `artifactPromptCopied` do not collide with existing types. No DB, no migration, no settings change. Independent of the design tab's Claude flow (different surface, different message types).

## Dependencies

- None. No other plan blocks or is blocked by this.

## Adversarial Synthesis

Key risks and mitigations: (1) **Webview tries to fetch directly** and silently fails under CSP — mitigated by the prompt-bridge architecture; the webview only builds strings. (2) **Downloaded file lands where the previewer can't see it** — mitigated by resolving the target to a configured HTML folder and falling back with an explicit "add this folder" instruction rather than an empty path. (3) **Upload overwrites the wrong artifact or fails on a non-owned URL** — mitigated by the self-describing source-marker (upload targets exactly the URL the file came from) plus explicit "report the permission error or new URL" wording. (4) **A banned `confirm()`/modal sneaks in** — mitigated by spec'ing immediate-action buttons with a text-flash only. (5) **New message type clobbers an existing handler** — mitigated by using distinct names (`copyArtifactPrompt` / `artifactPromptCopied`) verified absent from current handlers. (6) **Marker comment breaks rendering or gets stripped** — mitigated by using a standard HTML comment as line 1 (invisible in iframe, valid in HTML and Markdown) and instructing the upload prompt to preserve it. (7) **User pastes a `/share/` link instead of a `/code/artifact/` link** — mitigated by URL-type detection in the download prompt builder that emits a warning. (8) **User's Claude Code session is unauthenticated or on a non-Team plan** — mitigated by baking the `/login` prerequisite and plan-requirement note into both prompts. (9) **Format mismatch causes silent breakage or reformat churn** — `WebFetch` returns a wrapped document and external agents may reintroduce external assets, while the host re-wraps and blocks external resources; mitigated by normalizing to publish-form once on download (strip wrappers, inline assets, add charset) and re-asserting no-wrappers / inline-only in the upload prompt, so one canonical file both previews and publishes with no per-edit reformat.

## Proposed Changes

### 1. `src/webview/planning.html` — add a round-trip controls sub-row to the HTML tab
In `#controls-strip-planning-html` (line 3470), the existing controls (select + search input + status span) are direct children of a row-oriented `.controls-strip`. To stack a second row beneath them:
- **CSS:** add an override next to the existing `#controls-strip-tickets` rule (`planning.html:2682`):
  ```css
  #controls-strip-planning-html {
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
  }
  ```
- **Markup:** wrap the existing `<select id="planning-html-workspace-filter">`, `<input id="planning-html-docs-search">`, and `<span id="status-planning-html">` in a `<div class="controls-strip-row">…</div>` (the `.controls-strip-row` class is defined at `planning.html:2687`), then add a **second** `<div class="controls-strip-row">` containing:
  - `<input type="text" id="planning-html-artifact-url" class="sidebar-search-input" placeholder="claude.ai artifact URL…">`
  - `<button id="btn-copy-artifact-download" class="strip-btn" title="Copy a prompt that downloads this artifact into the selected HTML folder">Copy download prompt</button>`
  - `<button id="btn-copy-artifact-upload" class="strip-btn" title="Copy a prompt that re-publishes the previewed file back to claude.ai">Copy upload prompt</button>`

Keep both rows inside the existing `#controls-strip-planning-html` so the sidebar + preview layout below is untouched.

### 2. `src/webview/planning.js` — prompt builders + listeners + confirmation
- Add two template functions next to where HTML-tab logic lives (model on `CLAUDE_IMPORT_PROMPT`, `design.js:4387`):

  ```js
  const isShareLink = (url) => /claude\.ai\/share\//i.test(url);

  const ARTIFACT_DOWNLOAD_PROMPT = ({ url, folder }) => {
    if (isShareLink(url)) {
      return `WARNING: The URL ${url} is a claude.ai SHARE link, not a Claude Code artifact.\n` +
        `Share links are immutable snapshots — WebFetch will retrieve only a React shell or a 403, ` +
        `and the Artifact tool cannot republish to this URL.\n` +
        `Ask the artifact owner to share the claude.ai/code/artifact/ URL instead.\n` +
        `If you want to proceed anyway, WebFetch may return the rendered content if you are logged in, ` +
        `but you will not be able to push edits back to this URL.`;
    }
    return `Download a claude.ai artifact into this repo so I can preview and edit it locally.\n\n` +
      `PREREQUISITES: This requires a Claude Code Team or Enterprise plan with the Artifacts capability ` +
      `enabled in your org settings. If you are not logged in, run /login first.\n\n` +
      `1. Use WebFetch to retrieve the content at: ${url}\n` +
      `   (WebFetch passes your active claude.ai session credentials, so it gets the rendered content, not the React shell.)\n` +
      `2. Normalize to publish-ready form so the file round-trips without reformatting later. WebFetch returns the HOST-WRAPPED page — claude.ai's own skeleton (a frame-navigation <script>, a viewport meta, a CSS reset) PLUS the original document nested inside its <body>. Discard the host skeleton AND strip the document's own outer <!DOCTYPE>/<html>/<head>/<body> tags, keeping only the real inner content (the real <title>, the author's <style>/<script>, meta description). Add a single <meta charset="utf-8"> line so special characters render in local preview. Keep ALL assets inlined (data: URIs / inline <style>/<script>) and do NOT add external fonts/CSS/JS/images — the artifact host's CSP blocks them. This strip is REQUIRED, not cosmetic: the platform double-wraps rather than strips (confirmed), so skipping it nests another host skeleton on every round-trip.\n` +
      `3. Name the file from the artifact's <title> or first heading (slugify it, .html extension). ` +
      `If no title is available, fall back to a slug derived from the URL path.\n` +
      `4. Save the normalized content to: ${folder ? folder + '/' : ''}<chosen-filename>\n` +
      (folder ? `` : `   (No HTML folder is configured in Switchboard — after saving, add this file's folder via "Manage HTML Folders" to preview it in the HTML tab.)\n`) +
      `5. Make the FIRST line of the saved file this marker so the round-trip knows the source:\n` +
      `   <!-- switchboard-artifact-source: ${url} -->\n` +
      `6. Report the local path you saved.`;
  };

  const ARTIFACT_UPLOAD_PROMPT = ({ url, folder, filename }) =>
    `Publish a local document back to claude.ai as an Artifact.\n\n` +
    `PREREQUISITES: This requires a Claude Code Team or Enterprise plan with the Artifacts capability enabled.\n\n` +
    `1. Read the file: ${folder ? folder + '/' : ''}${filename}\n` +
    `2. Verify it is publish-ready before uploading — the host re-wraps and blocks external resources: ensure there are NO <!DOCTYPE>/<html>/<head>/<body> wrappers (strip them if an editor re-added any), and ALL assets are inlined as data: URIs / inline <style>/<script> (no external fonts, CSS, JS, or images — they render locally but silently disappear once published). If an edit introduced an external resource, inline it before publishing.\n` +
    `3. If it contains a \`switchboard-artifact-source:\` marker comment, redeploy to that existing URL by passing it as the Artifact tool's \`url\`. ` +
    `NOTE: this only overwrites if I own that artifact. If the tool returns a permission error, publish as a NEW artifact instead and tell me the new url.\n` +
    (url ? `   (Expected source url: ${url})\n` : ``) +
    `4. If there is no marker, publish as a new Artifact and report the new url.\n` +
    `5. Preserve (or refresh) the marker comment, and use the file's <title>/first heading as the artifact title.`;
  ```

  **Clarification (filename strategy):** the webview no longer bakes a UUID-slug filename into the prompt. Claude.ai artifact URLs are UUID-shaped, so a webview-derived slug yields a useless filename. Instead the download prompt instructs Claude Code (which sees the fetched content) to name the file from the artifact's `<title>`/first heading, with a URL-slug fallback. The webview stays dumb; the agent that sees the content picks a human-readable name.

- Wire `#btn-copy-artifact-download`: read the URL input, resolve the target folder from the HTML-tab folder config (the data backing `listPlanningHtmlFolders`/`planningHtmlFoldersListed`, `planning.js:4312`/`:6741`, via `getCurrentFolderPaths(state.planningHtmlFolderPathsByRoot, state.planningHtmlWorkspaceRootFilter)`, `planning.js:2079`) with workspace-root fallback, build the prompt (no filename arg — Claude Code derives it), and `vscode.postMessage({ type: 'copyArtifactPrompt', prompt, kind: 'download' })`.
- Wire `#btn-copy-artifact-upload`: resolve the previewed file from `state.activeDocName` + `state.activeDocSourceFolder` (see the `loadPlanningHtmlPreview` fix below); fall back to a URL-derived filename if nothing is selected; build the prompt; post `{ type: 'copyArtifactPrompt', prompt, kind: 'upload' }`.
- **Stash the active doc's source folder:** in `loadPlanningHtmlPreview` (`planning.js:6730`), add `state.activeDocSourceFolder = sourceFolder;` alongside the existing `state.activeDocName = docName;` (line 6744). Without this, the upload button has the filename but no folder and cannot construct `${folder}/${filename}`.
- Handle the confirmation: add a `case 'artifactPromptCopied'` in the webview message switch that flashes the relevant button's text to `Copied!` then restores it (mirror `kanbanPlanPromptCopied`, `planning.js:3832`).

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

This mirrors `copyChatPrompt` (`:2782`) and `copyClaudeImportPrompt` (`DesignPanelProvider.ts:1592`). No fs, no path handling, no DB.

## Research Findings

Web research was conducted to confirm the two assumptions that were initially uncertain. Both are now **confirmed with caveats** that have been integrated into the prompts and edge-case handling above:

1. **`WebFetch` returns the rendered artifact body — CONFIRMED with auth caveat.** Claude Code's `WebFetch` tool has a system-level authentication exception: when the `Artifact` tool is enabled and the user has an active `/login` session, `WebFetch` passes the claude.ai session credentials to the server and retrieves the full rendered HTML/Markdown content, not just the React shell. Without authentication, a standard GET returns only the SPA shell or a Cloudflare 403. **Integrated into the plan:** the download prompt instructs Claude Code to run `/login` first and notes the session-credential behavior.

2. **The `Artifact` tool supports URL-based redeploy — CONFIRMED.** The `Artifact` tool accepts the original URL and performs an in-place overwrite/republish (minting a new history version) rather than creating a new URL. For unowned artifacts, the backend returns a server-side permission error; the agent may fall back to minting a new URL. **Integrated into the plan:** the upload prompt instructs Claude Code to redeploy to the marker URL, and to publish as a new artifact + report the new URL if a permission error occurs.

**Additional constraints discovered by research (now encoded in the plan):**
- **Two URL types:** `claude.ai/code/artifact/{uuid}` (Claude Code-native, mutable) vs. `claude.ai/share/{uuid}` (standard chat, immutable snapshot). The round-trip only works for the former. The download prompt builder detects `/share/` URLs and emits a warning.
- **Plan requirement:** The `Artifact` tool requires a **Team or Enterprise** Claude Code plan with org-level "Artifacts" capability enabled. Both prompts now include a prerequisites note.
- **Artifact IDs are UUIDv4**, not slugs — reinforcing the filename-from-title strategy (a URL-slug filename would be a UUID, useless to humans).
- **Publish form ≠ fetched form — EMPIRICALLY CONFIRMED (tested 29 Jun 2026).** Publishing a file that contains full `<!DOCTYPE>/<html>/<head>/<body>` wrappers does NOT error and is NOT stripped — the platform **double-wraps**: it injects the file verbatim inside its own `<head>…</head><body>…</body>` skeleton (which also adds a frame-navigation `<script>`, a viewport meta, and a CSS reset). It still renders (browsers normalize nested document tags) and the `<title>` is still extracted correctly even when nested. **Consequence:** `WebFetch` returns that whole host-wrapped page, so re-uploading it verbatim wraps it AGAIN — host-skeleton-inside-host-skeleton, with the host's script/reset re-embedded as body content — and the layers **accumulate on every round-trip**. The download step MUST therefore strip back to the inner content (discard the host skeleton AND the file's own wrappers) to keep a clean single-wrap canonical file.

## Verification Plan

### Automated Tests
- None required for this session (test suite will be run separately by the user). No compilation step is run for this session either.

### Manual Verification
- **Download path:** In the HTML tab, paste a `claude.ai/code/artifact/{uuid}` URL, click **Copy download prompt**, paste into Claude Code (with active `/login` session on a Team/Enterprise plan) → it `WebFetch`es the URL (getting rendered content via session credentials), writes the file with the `switchboard-artifact-source` marker as line 1 into the configured HTML folder, and the file appears in the HTML sidebar and renders in the iframe.
- **Layout:** the new URL input + two buttons render as a stacked second row beneath the existing workspace/search/status row (not crammed horizontally beside them).
- **Edit hand-off:** Open the saved file in any agent (e.g. Gemini), make an edit, confirm the marker comment survives.
- **Upload path:** With that file previewed, click **Copy upload prompt**, paste into Claude Code → it reads the marker and redeploys to the same URL (or reports a permission error + new URL if not owned). Confirm the prompt contains a concrete `${folder}/${filename}` path (not a blank folder) sourced from `state.activeDocSourceFolder`.
- **Share-link detection:** Paste a `claude.ai/share/{uuid}` URL and click **Copy download prompt** → the copied prompt contains the share-link warning, not the normal download instructions.
- **Auth prerequisite in prompt:** The download prompt text includes the `/login` instruction and the Team/Enterprise plan note.
- **No-folder fallback:** With no HTML folder configured, the download prompt still produces a valid path + the "add this folder" instruction.
- **No-selection fallback:** With nothing previewed, the upload prompt uses a URL-derived filename, no blank path.
- **House rules:** Buttons act immediately (no confirm dialog); "Copied!" flashes; clipboard contains the expected prompt.
- **Format round-trip (double-wrap confirmed):** After download, confirm the saved file contains ONLY the real content — NO claude.ai host skeleton (no frame-navigation `<script>` / reset CSS) and NO `<!DOCTYPE>/<html>/<head>/<body>` wrappers — includes `<meta charset="utf-8">`, and renders in the iframe. Round-trip it twice and confirm no extra wrapper/host-skeleton layers accumulate. Then add an external `<link>` font, run the upload prompt, and confirm the prompt instructs inlining external assets before publish (so the published artifact doesn't lose the font).

## Recommendation

Complexity is 4 (routine wiring with small, well-scoped refinements: the CSS column override, the `state.activeDocSourceFolder` stash, and URL-type detection in the prompt builder). **Send to Coder.**
