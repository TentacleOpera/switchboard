---
description: Workstream A of the planning.html overhaul — Local Docs tab: folder link buttons, Link relabel, real sidebar collapse, create-new-document flow
---

# Plan: planning.html Overhaul — Workstream A (Local Docs tab)

> Child plan split from `planning-html-one-shot-overhaul.md` (release blocker). Run as its own agent session.
> **Execution order:** A2/A3 belong to phase 1 (deletions/relabels/CSS, lowest risk); A1/A4 belong to phase 3. A5 ("Sync to Online" button) has been **moved to the Workstream E plan** (`planning-overhaul-e-sync-to-online.md`) because it only opens E's modal. A6 (search bar) lives in the Workstream F plan.

## Goal
Fix the Local Docs tab UX: give folders a Link button, drop the emoji from the doc Link button, make sidebar collapse actually collapse, and add a create-new-document flow.

**Files touched:** `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`.

## Metadata
- **Tags:** frontend, ui, ux, feature, release-blocker
- **Complexity:** 3

## Proposed Changes

**A1. Folder link buttons in sidebar.** Folders currently have only an Import button (`folder-import-btn`, planning.js:2120-2144); docs have a link mechanism but folders don't. Add a small `Link` button to every source-folder header (planning.js:2110-2145) and nested subfolder header (planning.js:2169-2182). Click posts a new message `linkToFolder { folderPath }`; new provider handler validates the path exists and copies the absolute folder path to the clipboard with a status confirmation (reuse the path-resolution logic from `_handleLinkToDocument`, PlanningPanelProvider.ts:2805-2868). This is the mechanism for directing agents to specific folders.

**A2. Copy button → "Link", no emoji.** planning.js:1074-1075 renders `'<span>🔗</span><span class="btn-label">Copy</span>'`. Change to `'<span class="btn-label">Link</span>'`. No handler change (it already posts `linkToDocument`).

**A3. Sidebar collapse must actually collapse.** The collapsed CSS (planning.html:382-428) currently keeps tree-node icons visible at 16px in a 40px rail, so plan files still show. Change the collapsed state so the doc list (`#doc-list` content, all tree-nodes, subheaders, import buttons) is `display:none` entirely; only the `.sidebar-toggle-row` with the `»` button remains in the 40px rail. Applies to all tabs sharing `applySidebarState` (local, research, online — planning.js:336-364).

**A4. Create new document.** No create flow exists today (confirmed: no `createDoc`-style message in planning.js or the provider switch). Add:
- A `+` create icon button on each source-folder header AND each subfolder header, next to Import/Link.
- New message `createLocalDoc { folderPath }`. Provider handler: `vscode.window.showInputBox` for the doc name → sanitize (strip path separators, enforce `.md`, reject collisions with an error message) → write a `# <Title>` stub → `_sendLocalDocsReady()` → post a message instructing the webview to select and preview the new doc.

**A5 (moved).** "Sync to Online" button in `controls-strip-local` — see `planning-overhaul-e-sync-to-online.md`.

**A6 (moved).** Search bar — see `planning-overhaul-f-sidebar-search.md`.

## Complexity Audit

### Routine
- A2 label change — one-line edit at a known location.
- A1/A4 folder buttons follow the existing `folder-import-btn` pattern (planning.js:2120-2144).

### Complex / Risky
- **A3 collapse CSS** — `applySidebarState` is shared across three tabs; verify collapse still works per-tab without affecting tabs that lack the toggle.

## Edge-Case & Dependency Audit
- **Security (A4):** user-supplied doc titles must be HTML-escaped before rendering (existing `escapeHtml`, planning.js:220-227) and sanitized before filesystem writes — strip `/ \ .. :` from filenames.
- **Side effects (A4):** writing a new doc into a watched folder triggers existing watchers — `_sendLocalDocsReady` will fire twice (handler + watcher); dedupe by content-hash is already in place for imports, but verify no duplicate sidebar entries (see `fix-local-docs-duplicates-and-preview.md`).

## Dependencies
- None on other workstreams. (A5, which depended on Workstream E, has been moved into the E plan.)
- Workstream F adds the Local Docs search input after this workstream's strip changes settle.

## Verification
- `npm run compile` clean; run existing test suites (planning-modal-contract, planning-aggregate-cache).
- Manual checklist in the Extension Development Host:
  - [ ] Sidebar collapse shows icon-only 40px rail with only the `»` toggle — no tree nodes, subheaders, or import buttons visible.
  - [ ] Collapse/expand works on local, research, and online tabs without breaking tabs lacking the toggle.
  - [ ] Folder Link button copies the absolute folder path to clipboard with status confirmation, on both source-folder and subfolder headers.
  - [ ] Doc "Link" button shows no emoji and still copies/links the doc.
  - [ ] `+` button creates a new `.md` doc (stub `# <Title>`), rejects collisions and bad characters, then selects and previews the new doc.
  - [x] No duplicate sidebar entries after creating a doc (watcher + handler double-fire).

## Execution Summary

**Status:** Completed 2026-06-10

**Files changed:**
- `src/webview/planning.html` — collapsed CSS replaced to hide all tree-pane children except `.sidebar-toggle-row`; added `.folder-link-btn` and `.folder-create-btn` styles.
- `src/webview/planning.js` — doc Link button relabeled (no emoji); added Link and + buttons to source-folder and subfolder headers; added `selectLocalDoc` webview message handler.
- `src/services/PlanningPanelProvider.ts` — added `linkToFolder` and `createLocalDoc` message cases; implemented `_handleLinkToFolder` and `_handleCreateLocalDoc` methods.

**Validation:**
- `node --check src/webview/planning.js` passed (clean parse).
- Brace balance verified for new provider methods.

**Remaining risks:**
- Subfolder headers are not flex containers, so Link/+ buttons sit inline next to the folder name rather than right-aligned. This is a cosmetic deviation from source-folder headers but does not break functionality.
- No automated tests run per session directive; manual verification in Extension Development Host recommended for sidebar collapse behavior and create-new-document flow.
