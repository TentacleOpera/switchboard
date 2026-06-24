# Add a "Claude" Tab to design.html for Importing claude.ai/design Work Into a Target Folder

## Goal

Add a "Claude" tab to `design.html` that clones the HTML PREVIEWS pane (workspace dropdown + folder/file tree + preview iframe + zoom) and adds a prompt action bar that generates a folder-scoped natural-language import instruction for claude.ai/design, then copies it or sends it to the active Claude terminal. Phase 2 adds a Kanban "Claude Designer" built-in agent (default OFF).

**Core problem & root cause:** The import capability exists but is awkward to invoke — there is no slash command to pull a design from claude.ai/design into a repo. The `DesignSync` tool is an *internal agent tool* that a running Claude session invokes itself; the user cannot trigger it directly. The tab's job is to generate a folder-scoped natural-language instruction and dispatch it to the already-running agent, which fulfils it via its internal tooling. This removes the friction of manually composing that instruction each time.

## Metadata

- **Tags:** feature, frontend, backend, ui, ux
- **Complexity:** 6/10

## User Review Required

Yes — before implementation, the user should confirm:
1. Approach (a) (reuse `html-folder` source + `target` marker) is acceptable despite the auto-refresh routing caveat (see Edge-Case & Dependency Audit → Race Conditions). The alternative is Approach (b) (parallel `claude-folder` backend source) which is cleaner but more code.

## Problem & Why

`design.html` already hosts an **HTML PREVIEWS** tab — a workspace-filtered folder/file tree plus a sandboxed preview iframe — that lets the user browse local HTML designs in a repo. What it does *not* do is help the user get a design **from claude.ai/design (Claude Design) down into a folder** of that repo.

There is real friction here that this tab removes: the import capability exists, but it is awkward to invoke. The user wants a one-click way to say "pull a design into *this* folder" from the same surface where they already browse designs.

## Verified reality about Claude's design infrastructure (this drove the whole design)

This was checked against the live Claude Code CLI (v2.1.187), not assumed. The earlier draft of this plan was wrong on every one of these points; the corrections below are load-bearing.

| Capability | What it actually is | Consequence for this tab |
|---|---|---|
| **Import a design into the repo** ("pull") | **No slash command exists.** It is an *internal agent tool* (`DesignSync`) that a running Claude session invokes itself. The user **cannot** trigger it directly. | The button must emit a **natural-language instruction** to the *already-running* agent. We do **not** emit a `/design` command — there is no such command. |
| `/design-sync` ("push" the repo's design system *up* to claude.ai/design) | A **real, native bundled** slash command. | **Out of scope.** Push belongs in the **Design System tab**, which already owns that direction for Stitch. This tab is pull-only. |
| `/design-login` | Auth command for claude.ai/design. | Surfaced only as a hint inside the generated prompt ("if not logged in, run /design-login first"). The agent itself also relays auth guidance. |

**Net:** the tab's job is to generate a folder-scoped, natural-language instruction and either copy it or drop it into the user's active Claude terminal, where the agent fulfils it via its internal `DesignSync` tool.

## What this tab IS (and explicitly is NOT)

**IS:**
- A clone of the HTML PREVIEWS tab (same workspace dropdown + folder/file tree + preview iframe + zoom), plus a prompt action bar.
- A generator of a **natural-language import instruction** targeted at a chosen folder.
- A dispatcher that **copies** that instruction or **sends it to the currently active terminal**.

**IS NOT:**
- Not a `/design` slash-command runner (no such command).
- Not a terminal *creator* — it sends to the **active** terminal only and never spawns one (per standing user rule: "none of this create-a-new-terminal business").
- Not a push/`/design-sync` surface — that lives in the Design System tab.

## Decisions made (no open review items)

These were settled during consultation; recording them so implementation has no ambiguity:

1. **Command form:** natural-language prompt (forced — there is no slash command to send).
2. **Folder target:** workspace dropdown picks the root; clicking a folder/file in the sidebar refines to a subfolder; if nothing is selected, fall back to the workspace root.
3. **Design source:** an **optional** "claude.ai/design project URL or ID" input. If filled, it's embedded in the instruction; if empty, the instruction tells the agent to list the user's projects and ask which one.
4. **Send target:** `vscode.window.activeTerminal` only. If there is no active terminal, show a warning toast and do nothing — never create one.
5. **Generated text is single-line** (no embedded `\n`) so it sends intact regardless of how the active terminal is named (see Edge Cases — newline hazard).
6. **Push (`/design-sync`) is out of scope** for this tab.
7. **Kanban "Claude Designer" agent is included** in this plan as Phase 2 (default visibility OFF), per explicit request.

## UX / Behaviour spec

The Claude pane mirrors the HTML PREVIEWS pane (controls strip → content row with tree pane + preview wrapper, same theme classes for cyber/claudify parity), with these additions to the controls strip:

- An **optional** text input: `claude.ai/design project URL or ID (optional)`.
- A small status line showing the **resolved target folder** (e.g. `Target: repo-a/src/webview`) so the user always sees where the import will land before acting.
- Two buttons: **Copy import prompt** and **Send to active terminal**.

Behaviour:
- Selecting a workspace in the dropdown scopes the tree (existing per-tab pattern) and sets the default target = that workspace root.
- Clicking a **folder** node sets target = that folder. Clicking a **file** node previews it (iframe) **and** sets target = that file's parent folder.
- With nothing selected, target = workspace root.
- **Copy** writes the generated instruction to the clipboard (info toast).
- **Send** drops the instruction into the active terminal (paced/robust send) and submits it. No active terminal → warning toast, no-op.

## Complexity Audit

### Routine
- Cloning the HTML PREVIEWS tab markup in `design.html` (button + content div with `claude-` ids) — mechanical copy with id renames.
- Adding `'claude'` to the `switchTab` refresh-trigger list (design.js ~L170).
- Registering `#claude-workspace-filter` via the existing `registerWorkspaceDropdown(...)` helper.
- Adding a `claude` entry to `zoomState` and an `initZoomListeners(...)` call.
- The `copyClaudeImportPrompt` handler (mirrors `linkToDocument` at DesignPanelProvider.ts ~L1460).
- The `sendClaudeImportPrompt` handler (active-terminal-only send via `sendRobustText`).
- The single-line prompt template constant.
- Phase 2: adding `claude_designer` to `sharedDefaults.js` default maps (mechanical, follows `jules`/`mcp_monitor` precedent).

### Complex / Risky
- **Preview/docs routing for the Claude pane (Approach a):** `handlePreviewReady` (design.js ~L964) and the `htmlDocsReady` handler (~L2681) both hardcode routing to `#html-preview-frame` / `#tree-pane-html` by checking `sourceId === 'html-folder'`. Reusing that sourceId requires a `target: 'claude'` field threaded through 4 touchpoints (webview send → backend `fetchPreview` → `_buildAndSendPreview` echo → webview `handlePreviewReady`/`htmlDocsReady` branches). Missing any one breaks the Claude tree or iframe.
- **`_activeHtmlPreview` auto-refresh collision:** the single-slot `_activeHtmlPreview` (DesignPanelProvider.ts ~L1442) is overwritten by Claude-pane clicks; the file-watcher auto-refresh (~L2960) then sends `previewReady` with `sourceId: 'html-folder'` + `requestId: -1`, which `handlePreviewReady` routes to the HTML tab's hidden iframe, not the Claude iframe. Cross-tab auto-refresh corruption.
- **`BuiltInAgentRole` type union (agentConfig.ts L1):** mirroring `claude_designer` in `BUILT_IN_AGENT_LABELS` requires updating the `BuiltInAgentRole` type union AND the `VALID_ROLES` array in `parseDefaultPromptOverrides` (~L394) or the TypeScript record won't compile. (Note: `jules`/`mcp_monitor` are *not* in `agentConfig.ts` — they live only in `sharedDefaults.js`. The plan must decide: full mirror or sharedDefaults-only.)
- **Migration safety for ~4,000 installs:** adding a shipped built-in agent must merge, not overwrite, persisted agent config.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Auto-refresh cross-tab collision (CRITICAL):** `_activeHtmlPreview` is a single slot shared by both the HTML and Claude panes under Approach (a). If the user previews a file in the Claude tab, then switches to the HTML tab, an external file edit triggers auto-refresh that sends `previewReady` routed to `#html-preview-frame` with the Claude-selected file's content — corrupting the HTML tab's preview. Mitigation options: (1) track an `activePreviewTab` field on the backend and only auto-refresh when it matches the originating tab; (2) store a separate `_activeClaudePreview` slot; (3) accept that auto-refresh is disabled for the Claude pane (document as known limitation). **Recommend (2)** — a separate `_activeClaudePreview` slot, cheapest correct fix.
- **`htmlDocsReady` debounce sharing:** `_sendHtmlDocsReady` uses a single `_htmlDocsDebounce` timer. If both tabs trigger `refreshDocsForTab` near-simultaneously, only one `htmlDocsReady` fires. Not a real problem (both tabs want the same data) but the message must be routed to *both* trees.

**Security:**
- `sendClaudeImportPrompt` sends user-controllable text (folder path + optional project ref) to the active terminal. The folder path comes from the workspace tree (trusted), the project ref is free-text input. No injection risk beyond the terminal itself (the agent interprets natural language). The `sourceFolder` allowed-list check in `_buildAndSendPreview` (~L2864-2877) already prevents path traversal for previews.
- CSP: all new handlers live in `design.js` (already nonce-loaded); no inline scripts, no new external resources. ✓

**Side Effects:**
- Overwriting `_activeHtmlPreview` (Approach a) — see Race Conditions above.
- Clipboard overwrite by `sendRobustText` for prompts >100 chars (it saves/restores, but there's an 800ms window). Existing behaviour — not new.

**Dependencies & Conflicts:**
- Depends on `sendRobustText` (terminalUtils.ts ~L63) — already name-detects `claude` terminals and flattens newlines. ✓
- Depends on the existing `html-folder` backend pipeline (`_sendHtmlDocsReady`, `_buildAndSendPreview`). Approach (a) reuses it; Approach (b) would duplicate it.
- No new npm dependencies.
- Phase 2 depends on the agent-config merge path (`getVisibleAgents` at TaskViewerProvider.ts ~L3618-3645 does `{ ...defaults, ...stored }` — unions, doesn't replace). ✓

## Dependencies

- No upstream plan dependencies. This plan is self-contained.
- `sess_existing_design_html_previews` — reuses the HTML PREVIEWS tab infrastructure (switchTab, renderHtmlDocs, zoom engine, fetchPreview pipeline).

## Adversarial Synthesis

Key risks: (1) the `target: 'claude'` routing marker must be threaded through 4 touchpoints or the Claude tree/iframe silently never populates; (2) the shared `_activeHtmlPreview` slot causes cross-tab auto-refresh corruption under Approach (a); (3) the `BuiltInAgentRole` type union in `agentConfig.ts` must be updated or Phase 2 won't compile. Mitigations: add a separate `_activeClaudePreview` slot for auto-refresh isolation; specify all 4 routing touchpoints concretely; decide sharedDefaults-only vs full mirror for the agent type (recommend sharedDefaults-only, matching `jules`/`mcp_monitor` precedent, to avoid touching the type union and `VALID_ROLES`).

## Technical design

### Patterns being reused (verified locations — implementer should confirm exact lines)

- **Generic tab switcher:** `switchTab()` in `src/webview/design.js` (~L126-187) toggles `.active` by `data-tab` / `#<tab>-content`. A new tab needs **zero** changes to the switch logic — only a button with `data-tab="claude"` and a `<div id="claude-content" class="shared-tab-content">`.
- **HTML previews pane markup:** `src/webview/design.html` `#html-preview-content` (~L3751-3797) — clone with `claude-` ids.
- **Tree render + workspace filter:** `renderHtmlDocs()` (~design.js L611-682) and the `html-workspace-filter` change listener (~design.js L2296). Data arrives via `htmlDocsReady` from `DesignPanelProvider` (~L476), which also ships `folderPathsByRoot` — the folder list we need for target resolution.
- **Clipboard (server side):** `vscode.env.clipboard.writeText` as used by `linkToDocument` (DesignPanelProvider ~L1470).
- **Robust terminal send:** `sendRobustText(terminal, text, paced)` in `src/services/terminalUtils.ts` (~L63-127) — handles chunking and a paced submit, and already name-detects `claude` terminals. Clipboard-paste threshold is 100 chars (~L80); newlines flattened for CLI agents (~L97).

### Routing the shared HTML source into the Claude pane (Approach (a) — RECOMMENDED, with caveats)

"Same as HTML previews" is cheapest if the Claude pane reuses the existing **html-folder** source rather than duplicating the backend pipeline. Two options:

- **(a) Reuse `sourceId: 'html-folder'`, tag preview responses by active tab.** Give the Claude pane its own DOM ids; when the Claude tab is active, route `fetchPreview` results to `#claude-preview-frame`. Less code. **Requires threading a `target: 'claude'` field through ALL four touchpoints** (see below).
- **(b) Add a parallel `claude-folder` source in the backend.** Cleaner isolation, more code, avoids the auto-refresh collision entirely.

**Recommend (a)** with a separate `_activeClaudePreview` slot to fix the auto-refresh collision. The `target: 'claude'` marker must be threaded through these four touchpoints:

1. **Webview send (`loadDocumentPreview` / tree click):** add a `claude-folder` branch in `loadDocumentPreview` (design.js ~L859-962) that posts `fetchPreview` with `sourceId: 'html-folder'`, `target: 'claude'`, and the `sourceFolder` from the tree node. Also toggle `#claude-initial-state` / `#claude-loading-state` / `#claude-preview-wrapper` display states.
2. **Backend `fetchPreview` handler (DesignPanelProvider.ts ~L1439-1457):** pass `message.target` through to `_buildAndSendPreview`. When `target === 'claude'`, set a separate `_activeClaudePreview` slot (NOT `_activeHtmlPreview`) so auto-refresh doesn't collide.
3. **Backend `_buildAndSendPreview` (~L2849-2937):** echo `target` in the `previewReady` message (add `target: opts.target` to the `postMessage` at ~L2923). Also thread `target` through the auto-refresh path (~L2977) from whichever slot originated it.
4. **Webview `handlePreviewReady` (design.js ~L964):** add a `if (msg.target === 'claude')` branch that routes to `#claude-preview-frame`, `#claude-preview-wrapper`, `#claude-initial-state`, `#claude-loading-state` instead of the `#html-*` ids. Keep the existing `sourceId === 'html-folder'` branch as the default (no target).

**`htmlDocsReady` routing to the Claude tree:** the `htmlDocsReady` handler (design.js ~L2681-2694) always calls `renderHtmlDocs` → `#tree-pane-html`. To populate `#tree-pane-claude`, either:
- Add a `renderClaudeDocs(...)` function (clone of `renderHtmlDocs` targeting `#tree-pane-claude`) and call it alongside `renderHtmlDocs` in the `htmlDocsReady` handler, OR
- Add a `target` field to `htmlDocsReady` and branch. Since `_sendHtmlDocsReady` fires once for both tabs, the simplest approach is to call both `renderHtmlDocs` and `renderClaudeDocs` in the same handler (same data, different DOM target). Store `state._lastClaudeDocsMsg = msg` for the workspace-filter re-render path.

### File 1 — `src/webview/design.html`

- **Tab button** (after the HTML PREVIEWS button, ~L3750):
  ```html
  <button class="shared-tab-btn" data-tab="claude">CLAUDE</button>
  ```
- **Claude pane** — clone `#html-preview-content` (~L3751-3797) with `claude-` ids; add to the controls strip: the optional project input (`#claude-design-project`), the resolved-target status (`#claude-target-folder`), and the two buttons (`#btn-copy-claude-prompt`, `#btn-send-claude-prompt`). Keep `.preview-panel-wrapper`, `.cyber-scanlines`, `.zoomable-container` etc. verbatim for theme parity. Include the initial/loading state blocks mirrored from the html pane (`#claude-initial-state`, `#claude-loading-state`, `#claude-preview-wrapper`, `#claude-preview-frame`).

### File 2 — `src/webview/design.js`

- **State additions** (~L7-60): add `claudeWorkspaceRootFilter: ''`, `claudeTargetFolder: ''`, `claudeDocsSearch: ''`, `_lastClaudeDocsMsg: null`, `claudePreviewCollapsed: false`.
- **Zoom state** (~L190-194): add `claude: { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null }`.
- **Zoom listener init** (~L357-360): add `initZoomListeners('claude-preview-wrapper', '.zoomable-viewport', 'claude');`
- **Refresh on entry** (~L170): add `'claude'` to the tab list that triggers `refreshDocsForTab`.
- **Workspace dropdown:** register `#claude-workspace-filter` via `registerWorkspaceDropdown(...)`; store `state.claudeWorkspaceRootFilter`; re-filter the tree on change (mirror the `html-workspace-filter` listener at ~L2296).
- **Tree render:** add `renderClaudeDocs(rootEntry)` — clone of `renderHtmlDocs` (~L611-682) targeting `#tree-pane-claude`. Call it in the `htmlDocsReady` handler (~L2681) alongside `renderHtmlDocs` (same data, different DOM target). Store `state._lastClaudeDocsMsg = msg`.
- **Tree + selection:** on Claude node click, call a `loadClaudePreview(sourceId, docId, docName)` function that posts `fetchPreview` with `target: 'claude'` and updates target-folder state:
  - file node → preview in `#claude-preview-frame`; `state.claudeTargetFolder = parentDir(node.path)`.
  - folder node → `state.claudeTargetFolder = node.path`.
  - default → workspace root from the dropdown.
  - Update the `#claude-target-folder` status text on every change.
- **`handlePreviewReady` (~L964):** add a `if (msg.target === 'claude')` branch routing to `#claude-preview-frame`, `#claude-preview-wrapper`, `#claude-initial-state`, `#claude-loading-state` (mirror the `html-folder` branch at ~L967-1018).
- **Prompt template (single named constant, single-line):**
  ```js
  const CLAUDE_IMPORT_PROMPT = ({ folder, projectRef }) =>
    `Import a design from claude.ai/design into this repository, writing the implementation into \`${folder}\`, built with the repo's existing components and styles. ` +
    (projectRef
      ? `Use the Claude Design project: ${projectRef}. `
      : `First list my available claude.ai/design projects and ask me which one (and which screen) to import. `) +
    `If you're not logged in to Claude Design, run /design-login first.`;
  ```
  (Single line — no `\n`. Folder is the workspace-relative resolved target.)
- **Button handlers:** build the prompt from `state.claudeTargetFolder` (fallback workspace root) and `#claude-design-project` value, then post `copyClaudeImportPrompt` / `sendClaudeImportPrompt` with the prompt string.

### File 3 — `src/services/DesignPanelProvider.ts`

- **`copyClaudeImportPrompt`** (mirror `linkToDocument` ~L1460):
  ```ts
  case 'copyClaudeImportPrompt': {
      const prompt = String(message.prompt || '');
      if (!prompt) break;
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage('Copied Claude import prompt to clipboard.');
      break;
  }
  ```
- **`sendClaudeImportPrompt`** — active terminal only, no creation:
  ```ts
  case 'sendClaudeImportPrompt': {
      const prompt = String(message.prompt || '');
      if (!prompt) break;
      const terminal = vscode.window.activeTerminal;
      if (!terminal) {
          vscode.window.showWarningMessage(
              'No active terminal. Focus your running Claude Code terminal, then send.');
          break;
      }
      terminal.show();
      try {
          const { sendRobustText } = require('./terminalUtils');
          await sendRobustText(terminal, prompt, true); // paced, robust, submits
      } catch (err: any) {
          vscode.window.showErrorMessage('Failed to send prompt to terminal: ' + err.message);
      }
      break;
  }
  ```
  > Note: this is the **first** active-terminal send path in the codebase — every existing sender resolves a specific terminal by name/role. That's intentional here: the user always has the Claude terminal focused before clicking. `require('./terminalUtils')` follows the existing inline-require precedent (js-yaml at ~L1423); alternatively add a top-level `import { sendRobustText } from './terminalUtils'` for cleanliness.
- **`fetchPreview` routing (~L1439-1457):** pass `message.target` through to `_buildAndSendPreview`. When `target === 'claude'`, set `this._activeClaudePreview` (new field) instead of `this._activeHtmlPreview`.
- **`_buildAndSendPreview` (~L2849-2937):** accept `target` in opts; echo `target` in the `previewReady` postMessage (~L2923).
- **Auto-refresh (~L2960-2984):** add a parallel `_autoRefreshClaudePreview` path that checks `_activeClaudePreview` and sends `previewReady` with `target: 'claude'`. Register a file watcher for the Claude preview's folder (or reuse the existing watcher and check both slots).
- **`refreshDocsForTab` (~L2236-2248):** add `case 'claude': await this._sendHtmlDocsReady(); break;` (same data; the webview routes to both trees).

## Phase 2 — Kanban "Claude Designer" agent (default OFF)

Adds a built-in agent role so the same import workflow can run through the kanban dispatch pipeline, not just the tab button.

- **`src/webview/sharedDefaults.js`:**
  - Add `{ key: 'claude_designer', label: 'Claude Designer' }` to `BUILT_IN_AGENT_LABELS` (~L39-54).
  - Add a `DEFAULT_ROLE_CONFIG` entry (~L20-36) whose addon instructs the agent to import a design from claude.ai/design into the target folder using its design tooling (same intent as the tab's prompt template — keep the wording in sync).
  - Add `claude_designer: false` to `DEFAULT_VISIBLE_AGENTS` (~L2-17) — **off by default** so existing boards don't suddenly grow an agent.
- **`src/services/agentConfig.ts`:** The `BuiltInAgentRole` type union (L1) and `BUILT_IN_AGENT_LABELS` record (~L87) do **not** include `jules` or `mcp_monitor` — those agents live only in `sharedDefaults.js`. **Recommend following that precedent: do NOT add `claude_designer` to `agentConfig.ts`** (avoids touching the type union, `VALID_ROLES` in `parseDefaultPromptOverrides` at ~L394, and `getReservedAgentNames`). If full mirroring is desired, the type union, the record, and `VALID_ROLES` must all be updated together or compilation fails.

### Migration (this is shipped state — handle per CLAUDE.md)

`BUILT_IN_AGENT_LABELS` / `DEFAULT_ROLE_CONFIG` / `DEFAULT_VISIBLE_AGENTS` are **shipped defaults**, and ~4,000 installs have their own persisted agent config/visibility in the db `config` table. Adding a new built-in must **merge**, not overwrite:
- Existing users' saved visibility/role maps must be preserved; the new `claude_designer` key is *added* with its default only where absent.
- **Verified:** `getVisibleAgents` (TaskViewerProvider.ts ~L3618-3645) does `{ ...defaults, ...stored }` — defaults spread first, stored values override. A new `claude_designer: false` in defaults survives because stored state won't have that key. ✓
- **Verified:** the deletion path at ~L7468-7471 only removes `custom_agent_*` roles not in the custom agents list — built-in roles are safe. The reset path at ~L7619-7622 only deletes roles from `buildKanbanColumns([])` (i.e. `DEFAULT_KANBAN_COLUMNS`), which won't include `claude_designer`. ✓
- Role config merge: per-role lookup `getSetting('switchboard.prompts.roleConfig_${role}')` (~L7336) — a new role with no stored config falls back to `DEFAULT_ROLE_CONFIG`. ✓
- A user who has never seen this agent gets it hidden (default OFF), so no board changes shape on upgrade.

> Phase 2 is separable: if you'd rather ship the tab alone first, Phase 1 stands on its own.

## Edge cases & guardrails

- **No active terminal:** warning toast, no-op, never create one.
- **Folder ≠ terminal mismatch:** the target folder is baked into the *text*; the terminal is just whoever's active. A user could have repo-A's terminal focused while the dropdown points at repo-B. The visible `Target: …` status is the guardrail — it always shows the folder going into the prompt. (A future enhancement could warn on mismatch; not in scope.)
- **Newline hazard:** `sendRobustText` only flattens newlines for terminals it name-detects as a CLI agent (`claude`, etc.). If the active terminal is named `zsh`/`bash` while running Claude, embedded newlines could submit early. Mitigated by keeping the template **single-line**.
- **Nothing selected:** prompt still valid — targets the workspace root; guard against null selection.
- **Theme parity:** copy the html pane structure verbatim so cyber/claudify render correctly in the Claude pane.
- **CSP:** all new handlers live in `design.js` (already nonce-loaded); no inline scripts, no new external resources.
- **No confirm dialogs** anywhere (per project rule) — buttons act immediately.
- **Auto-refresh cross-tab collision:** see Edge-Case & Dependency Audit → Race Conditions. Mitigated by a separate `_activeClaudePreview` slot.

## Out of scope

- Push / `/design-sync` (lives in the Design System tab).
- Auto-detecting or validating that `DesignSync`/login is available — the agent reports that itself.
- Mismatch warning between active-terminal repo and target folder (possible later enhancement).

## Proposed Changes

### `src/webview/design.html`
- **Context:** The HTML PREVIEWS tab markup (~L3751-3797) is the clone source. The tab button row contains `.shared-tab-btn` elements.
- **Logic:** Add a `CLAUDE` tab button after the HTML PREVIEWS button. Add a `#claude-content` div cloning `#html-preview-content` with `claude-` ids and the additional controls-strip elements (project input, target status, copy/send buttons).
- **Implementation:** Mechanical clone with id renames (`html-` → `claude-`). Preserve `.preview-panel-wrapper`, `.cyber-scanlines`, `.zoomable-container`, `.zoomable-viewport`, `.zoom-event-layer`, `.zoom-toolbar` structure verbatim.
- **Edge Cases:** Theme parity (cyber/claudify) depends on identical class structure — do not simplify the clone.

### `src/webview/design.js`
- **Context:** The largest change surface. Touches state init (~L7-60), zoom (~L190-194, ~L357-360), tab refresh (~L170), tree render (~L611-682 clone), workspace filter (~L2296 clone), preview loading (~L859-962 branch), preview handling (~L964 branch), docs handler (~L2681), and new button handlers.
- **Logic:** Add Claude-specific state fields, a `claude` zoom entry, a `renderClaudeDocs` clone, a `loadClaudePreview` function, a `handlePreviewReady` Claude branch, a `htmlDocsReady` dual-render call, workspace-filter listener, and the prompt template + button handlers.
- **Implementation:** See "File 2" in Technical Design above for per-section detail with line references.
- **Edge Cases:** The `target: 'claude'` field must be present on every `fetchPreview` post from the Claude pane, or `handlePreviewReady` falls through to the HTML branch. Null selection → workspace root fallback.

### `src/services/DesignPanelProvider.ts`
- **Context:** Message handler switch (~L1439 for `fetchPreview`, ~L1460 for `linkToDocument`, ~L2236 for `refreshDocsForTab`), preview builder (~L2849), auto-refresh (~L2960).
- **Logic:** Add `copyClaudeImportPrompt` + `sendClaudeImportPrompt` handlers. Thread `target` through `fetchPreview` → `_buildAndSendPreview` → `previewReady`. Add `_activeClaudePreview` slot + parallel auto-refresh path. Add `case 'claude'` to `refreshDocsForTab`.
- **Implementation:** See "File 3" in Technical Design above. Use `require('./terminalUtils')` (inline) or add a top-level import.
- **Edge Cases:** No active terminal → warning toast, no-op. Auto-refresh must check the correct slot (`_activeClaudePreview` for Claude, `_activeHtmlPreview` for HTML) to avoid cross-tab corruption.

### `src/webview/sharedDefaults.js` (Phase 2)
- **Context:** Shipped defaults consumed by the kanban/setup UI. ~4,000 installs have persisted overrides.
- **Logic:** Add `claude_designer` to `DEFAULT_VISIBLE_AGENTS` (false), `DEFAULT_ROLE_CONFIG` (addon with import instruction), and `BUILT_IN_AGENT_LABELS` (label).
- **Implementation:** Mechanical additions following the `jules`/`mcp_monitor` precedent.
- **Edge Cases:** Migration safe — merge path unions defaults with stored values (verified).

### `src/services/agentConfig.ts` (Phase 2 — OPTIONAL)
- **Context:** `BuiltInAgentRole` type (L1), `BUILT_IN_AGENT_LABELS` record (~L87), `VALID_ROLES` in `parseDefaultPromptOverrides` (~L394).
- **Logic:** **Recommend NOT touching this file** — `jules`/`mcp_monitor` are not in it. If full mirroring is desired, update all three locations together.
- **Edge Cases:** Partial update causes TypeScript compilation failure.

## Verification Plan

### Automated Tests

> Per session directives: no compilation or automated test execution is part of this verification plan. The test suite will be run separately by the user.

Manual verification steps (exercise against the installed VSIX, not `dist/`):

1. **Tab appears & switches** after HTML PREVIEWS; other tabs unaffected.
2. **Preview parity:** with an HTML folder configured, the Claude tree lists the same files, clicking a file previews it in the Claude iframe, zoom works, theme renders.
3. **Target resolution:** selecting workspace → status shows root; clicking a folder → status shows that folder; clicking a file → status shows its parent; clearing selection → root.
4. **Copy:** click Copy → info toast; clipboard holds the single-line instruction with the resolved folder (and project ref if provided).
5. **Send (active terminal):** focus a terminal → Send → instruction lands intact on one line and submits.
6. **Send (no terminal):** with no active terminal → warning toast, nothing created.
7. **Auto-refresh isolation:** preview a file in the Claude tab, switch to the HTML tab, externally edit the Claude-previewed file → the HTML tab's iframe must NOT update (no cross-tab corruption).
8. **Phase 2:** Claude Designer appears in the kanban agent list only when visibility is enabled; existing users' saved agent config is preserved on upgrade (default hidden).
9. **Build & install:** exercise all of the above against the installed VSIX (not `dist/`).

## Files to touch

- `src/webview/design.html` — tab button + Claude pane.
- `src/webview/design.js` — refresh trigger, workspace dropdown, tree/selection routing, zoom, target resolution, prompt template, button handlers, `handlePreviewReady` Claude branch, `htmlDocsReady` dual-render.
- `src/services/DesignPanelProvider.ts` — `copyClaudeImportPrompt` + `sendClaudeImportPrompt` handlers, `target` threading through `fetchPreview`/`_buildAndSendPreview`/`previewReady`, `_activeClaudePreview` slot + auto-refresh, `refreshDocsForTab` claude case.
- **Phase 2:** `src/webview/sharedDefaults.js` — new built-in agent + merge-safe defaults. (`src/services/agentConfig.ts` — optional, recommend skip.)

---

**Recommendation:** Complexity 6 → **Send to Coder**.
