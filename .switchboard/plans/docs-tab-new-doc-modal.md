# Docs tab: replace New Doc native prompts with an in-webview create modal

> Imported from user request

## Goal

Replace the Docs tab's **+ New Doc** flow — which currently fires two native VS Code modal prompts and produces a bare stub — with a single **in-webview modal** matching the panel's own UI. The modal has:

- a **document name** entry field (required),
- a **location picker** that chooses from the managed docs folders,
- an optional **description** field, and
- two buttons: **Create** and **Create with agent** (the latter creates the doc *and* copies the existing "Draft with agent" prompt to the clipboard).

### Problem analysis & root cause

Today **+ New Doc** (`#btn-create-doc`) posts `createLocalDoc` ([planning.js:8516-8533](../../src/webview/planning.js#L8516)), and the host handler `_handleCreateLocalDoc` ([PlanningPanelProvider.ts:7649](../../src/services/PlanningPanelProvider.ts#L7649)) drives the whole flow through **native OS modals**:

1. If no folder is implied, a native `showQuickPick` to choose a configured folder ([7670](../../src/services/PlanningPanelProvider.ts#L7670)).
2. A native `showInputBox` for the filename ([7678](../../src/services/PlanningPanelProvider.ts#L7678)).
3. Writes a **one-line stub** (`# title\n`, [7747-7748](../../src/services/PlanningPanelProvider.ts#L7747)), refreshes the list, and selects the new doc in the previewer — in **preview** mode, empty.

**Why it's poor UX (all by design, not a bug):**
- **It leaves the webview.** Every other docs action lives in-panel; New Doc breaks out to native modals that don't match the tab. The file already ships an in-webview modal pattern (`.folder-modal`, e.g. `#create-ticket-modal` at [planning.html:4160](../../src/webview/planning.html#L4160)) it could use.
- **Two sequential prompts** (folder, then name) with no description and no way to go straight into authoring.
- **Dead-ends on an empty stub** — no content, no editor open, no path to the agent draft at creation time.

**Root cause:** the create flow was implemented host-side with `vscode.window` prompts instead of a webview modal, and it has no notion of a description or an agent hand-off. The fix is to move name/folder/description capture into a webview modal and reduce the host handler to a pure "write file (+ optional agent prompt)" operation.

### Approach

**Data is already client-side.** The managed folder list is in `state.localFolderPathsByRoot` (populated at [planning.js:4249](../../src/webview/planning.js#L4249) in `handleLocalDocsReady`) and read via the existing helper `getCurrentFolderPaths(state.localFolderPathsByRoot, state.docsWorkspaceRootFilter)` ([planning.js:3610](../../src/webview/planning.js#L3610)). So the location picker is populated with **zero new backend round-trips** — the same absolute folder paths the Docs tab already knows.

**Backend already accepts absolute folder paths.** `_handleCreateLocalDoc`'s else-branch ([7727-7737](../../src/services/PlanningPanelProvider.ts#L7727)) resolves an absolute `folderPath` and validates it against `getFolderPaths()` (`allowedPaths.includes(...)`). The modal supplies the picked absolute path, so that validation path is exercised as the primary route and the native prompts become dead code for this button.

**Message shape.** Extend the existing `createLocalDoc` message (already in the verb allowlist — `PLANNING_VERBS` at [verbAllowlist.ts:9](../../src/generated/verbAllowlist.ts#L9)) to carry the modal's fields:
```js
vscode.postMessage({ type: 'createLocalDoc', folderPath, name, description, withAgent });
```

**Reuse the draft prompt.** The Draft/Improve prompt text is built inline in the `draftImproveLocalDoc` case ([PlanningPanelProvider.ts:3302-3339](../../src/services/PlanningPanelProvider.ts#L3302)). Extract it into a private helper `_buildLocalDocDraftPrompt(filePath, title, hasContent)` and call it from **both** `draftImproveLocalDoc` and the `withAgent` branch of `createLocalDoc`, so the "Create with agent" prompt is identical to the existing button's. Note: `draftImproveLocalDoc` performs its own path validation (3308-3323) before building the prompt; the `createLocalDoc` handler already validates the folder path, so the `withAgent` branch can call `_buildLocalDocDraftPrompt` directly without re-validating.

## Metadata

- **Tags:** frontend, backend, ui, ux, docs
- **Complexity:** 4

## User Review Required

No — the design is fully specified by the request (name + location picker + optional description + Create / Create with agent). Mechanics reuse the in-repo `.folder-modal` pattern, the existing `getCurrentFolderPaths` helper, and the existing draft-prompt builder. No architectural decisions outstanding.

## Complexity Audit

### Routine

1. **Add the modal markup** in `planning.html`, mirroring `#create-ticket-modal` ([4160](../../src/webview/planning.html#L4160)): a `.folder-modal#new-doc-modal` with
   - `#new-doc-name` (text, required),
   - `#new-doc-location` (`<select>`, populated on open from `getCurrentFolderPaths(...)`; option value = absolute folder path, label = `path.basename`),
   - `#new-doc-description` (textarea, optional),
   - footer buttons `#btn-new-doc-create` (Create) and `#btn-new-doc-create-agent` (Create with agent), plus Cancel / close-`×`.
2. **Open on click.** Change `#btn-create-doc`'s handler ([planning.js:8516-8533](../../src/webview/planning.js#L8516)) to **open the modal** instead of posting `createLocalDoc`. On open: populate `#new-doc-location` from `getCurrentFolderPaths(...)`; if a local doc is currently selected, pre-select its folder (derive from `state.activeDocId`'s `N:relDir`, the same logic the old handler used at [8519-8527](../../src/webview/planning.js#L8519)); if the list is empty, show "Add a folder via Manage Folders first." and disable Create.
3. **Submit handlers.** `#btn-new-doc-create` and `#btn-new-doc-create-agent` both validate a non-empty name and a selected folder, then post `createLocalDoc` with `{ folderPath: <picked abs path>, name, description, withAgent: <false|true> }`, and close the modal. Reuse the existing modal open/close/escape/backdrop conventions (see `#create-ticket-modal` wiring around [planning.js:10185-10213](../../src/webview/planning.js#L10185)).
4. **Backend: accept the new fields.** In `_handleCreateLocalDoc` ([7649](../../src/services/PlanningPanelProvider.ts#L7649)), when `msg.name` is present, **skip the `showQuickPick`/`showInputBox`** entirely and use `name`/`folderPath` from the message (keep the server-side sanitize at [7690-7693](../../src/services/PlanningPanelProvider.ts#L7690) as defense-in-depth). Stub body becomes `# ${title}\n` plus, when a description is provided, `\n${description.trim()}\n`.
5. **Backend: agent hand-off.** Extract `_buildLocalDocDraftPrompt(filePath, title, hasContent)` from the `draftImproveLocalDoc` case ([PlanningPanelProvider.ts:3329-3336](../../src/services/PlanningPanelProvider.ts#L3329)) and, in the `withAgent` branch, after writing + `selectLocalDoc`, call it and `clipboard.writeText(...)` + `showTemporaryNotification('Doc prompt copied to clipboard')`. For a freshly created doc, pass `hasContent = !!description` so a description seeds the "improve" variant and an empty doc uses the "write from scratch" variant.

### Complex / Risky

- **Low risk — signature/back-compat of `createLocalDoc`.** The handler currently takes `(workspaceRoot, folderPath)`. Widen it to read `name`/`description`/`withAgent` from the message object (pass `msg` through, or add params). The no-`name` path (native prompts) becomes **dead code** once the modal always sends `name` — retain it as a safety net, not as a live fallback, since the Docs button is the only sender of `createLocalDoc`.
- **Low risk — folder path forms.** The modal sends an **absolute** path → else-branch validation ([7727-7737](../../src/services/PlanningPanelProvider.ts#L7727)). The pre-select-current-folder convenience may instead send the `N:relDir` form → the `/^\d+:/` branch ([7699](../../src/services/PlanningPanelProvider.ts#L7699)). Both are already implemented; pick one form for the `<option>` value (recommend absolute, since `getCurrentFolderPaths` yields absolute paths) and let the existing branches handle it.
- **Low risk — prompt-builder extraction.** Extracting `_buildLocalDocDraftPrompt` must preserve the three existing branches verbatim (large >200 KB, has-content, empty) so the standalone Draft-with-agent button is byte-for-byte unchanged. Verify by diffing the produced prompt before/after for a known doc.
- **Low risk — multi-root / workspace filter.** `getCurrentFolderPaths` already scopes by `state.docsWorkspaceRootFilter`; the picker reflects the active workspace filter, which is the correct scope. Backend still validates the path against `getFolderPaths()` for the resolved root, so a stale/foreign path is rejected safely.

## Edge-Case & Dependency Audit

- **No managed folders configured.** Modal opens with an empty picker, a "Add a folder via Manage Folders first." hint, and disabled Create buttons — replaces the old `showTemporaryNotification` toast ([7664](../../src/services/PlanningPanelProvider.ts#L7664)).
- **Duplicate name.** Backend already guards `fs.existsSync(filePath)` and shows "A document named X already exists." ([7741-7743](../../src/services/PlanningPanelProvider.ts#L7741)); surface that back to the modal (keep it open, show inline error) rather than only a native error toast. Minimal: post a `localDocCreateError` message the modal renders; acceptable fallback: existing `showErrorMessage`.
- **Name without `.md`.** Server-side appends `.md` ([7691-7693](../../src/services/PlanningPanelProvider.ts#L7691)); keep this so the field is forgiving.
- **Name sanitization.** Keep the server-side strip of `\ / : ..` ([7690](../../src/services/PlanningPanelProvider.ts#L7690)); optionally mirror lightweight validation client-side, but the server remains the trust boundary.
- **Description with markdown.** Written verbatim under the heading; no escaping needed (it's a `.md` file). Trim trailing whitespace only.
- **`selectLocalDoc` after create.** Unchanged — the new doc is refreshed into the list and selected in the previewer ([7752-7756](../../src/services/PlanningPanelProvider.ts#L7752)). With **Create with agent**, the prompt is copied on top of that selection.
- **Description seeds agent context.** With a description + `withAgent`, the "improve" prompt variant includes the description as current content, so the agent expands the user's seed rather than starting blank — the intended behavior.
- **Escape/backdrop close & focus.** Follow the existing modal conventions (`#create-ticket-modal`) for close-on-escape, backdrop click, and initial focus on the name field.
- **Dependencies & conflicts:** Touches `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`. Independent of `docs-tab-inline-preview-meta-bar.md` (that relocates existing buttons; this rewrites the create flow) — no overlapping elements, safe to ship in either order. `createLocalDoc` is already allowlisted; no `verbAllowlist` change needed.

## Dependencies

- None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) prompt-builder extraction must be byte-for-byte identical to preserve the standalone Draft-with-agent button's output; (2) the no-`name` fallback path becomes dead code — retained as safety net, not a live fallback; (3) duplicate-name error surfacing requires a new `localDocCreateError` message or falls back to the existing native toast. Mitigations: diff prompt output before/after extraction; keep server-side validation as the trust boundary; minimal error path is the existing `showErrorMessage` if inline modal error is too costly.

## Verification Plan

### Automated Tests

- None — manual verification per steps below (skip compilation and automated tests per session directives).

1. **Build/reload**, open Planning → Docs, click **+ New Doc** → the in-webview modal appears (no native VS Code prompt).
2. **Picker** lists the managed docs folders for the active workspace filter; if a doc is selected, its folder is pre-selected.
3. **Create:** enter a name + pick a folder (+ optional description) → file is created with `# name` and the description below it, appears in the sidebar, and is selected in the previewer. No `.md` needed in the name; it's appended.
4. **Create with agent:** same as Create, plus a "Doc prompt copied to clipboard" toast; paste shows the Draft/Improve prompt for the new file (improve-variant when a description was given, write-variant when empty). Confirm it matches the standalone **Draft with agent** button's output.
5. **Duplicate name** → modal reports the conflict and stays open (or native error, per chosen minimal path); no file overwritten.
6. **No folders configured** → empty picker, hint shown, Create disabled.
7. **Regression:** the standalone **Draft with agent** button (`#btn-agent-doc`) still copies an identical prompt after the `_buildLocalDocDraftPrompt` extraction.
8. **Escape / backdrop / ×** all close the modal without creating anything.

## Completion Summary

Replaced the native-prompt New Doc flow with an in-webview modal. Added `#new-doc-modal` markup (name + location picker + optional description + Create / Create with agent / Cancel / ×) mirroring `#create-ticket-modal`. Changed `#btn-create-doc`'s handler to open the modal, populate the location picker from `getCurrentFolderPaths(state.localFolderPathsByRoot, state.docsWorkspaceRootFilter)` (zero backend round-trips), pre-select the active local doc's folder, and disable Create when no folders are configured. Submit handlers post `createLocalDoc` with `{ folderPath, name, description, withAgent }`. Backend `_handleCreateLocalDoc` widened to accept `name`/`description`/`withAgent`; when `name` is present it skips the native `showQuickPick`/`showInputBox` (retained as safety-net fallback), builds the stub with the description under the heading, and on `withAgent` copies a Draft/Improve prompt via the extracted `_buildLocalDocDraftPrompt` helper (byte-for-byte identical to the standalone Draft-with-agent button's output; `hasContent = !!description` seeds the improve variant). Files changed: `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`. Duplicate-name errors still surface via the existing native `showErrorMessage` toast (minimal path per plan). No other issues encountered.
