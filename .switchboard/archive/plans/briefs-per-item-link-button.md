# Add a Per-Brief "Link" Button to the Briefs Sidebar

## Goal

Give every brief card in the Briefs tab sidebar the same **Link** button (copy validated document path) that HTML Previews and Images cards already have — today the Briefs tab only offers a link at the folder level.

### Problem & root-cause analysis

`createBriefDocCard` (`design.js:826-841`) calls the shared `renderDocCard` **without an `actions` array**, so brief cards render title-only. The shared renderer already knows how to build the button — HTML/Images cards pass `'Link Doc'` and get the `card-icon-btn html-link-btn` treatment wired to the `linkToDocument` message (`design.js:1054-1090`). Brief nodes already carry the metadata the action needs: `createBriefDocCard` passes `nodeMetadata: node.metadata`, and `renderDocCard` copies `nodeMetadata.sourceFolder` onto the card and into the `linkToDocument` post (`:1027`, `:1089`) — the same `sourceFolder` that brief **preview** already relies on today (`loadDocumentPreview` briefs-folder branch, `:1224-1246`). The only per-item affordance briefs got was never built; the folder-level `folder-link-btn` (`design.js:530`) was the stopgap. This is a one-line wiring gap, not missing machinery.

## Metadata

**Complexity:** 2
**Tags:** ux, webview, briefs

## User Review Required

- **None.** Purely additive UI parity with existing tabs.

## Complexity Audit

### Routine
- A single `actions: ['Link Doc']` addition to `createBriefDocCard`; the renderer, message, and provider handler all exist and already receive the fields they need.

### Complex / Risky
- None.

> **Superseded:** (original Complex/Risky item) "Only the provider-side folder validation: if `linkToDocument` currently whitelists html/images folders only, briefs paths would be rejected at runtime while looking wired in the UI — verify the guard before calling this done." Also the original Proposed Change #2, which asked to "confirm the `linkToDocument` handler accepts briefs folders (it validates against configured folder lists…)".
> **Reason:** The premise is factually wrong. The provider's `linkToDocument` handler (`DesignPanelProvider.ts:1931-1944`) performs **no** allow-list validation of any kind — it strips the `folderIndex:` prefix, resolves `path.resolve(sourceFolder, relativePath)`, writes it to the clipboard, and shows a toast. There is no configured-folder check to pass or fail; briefs paths (like every other path) are accepted unconditionally. The stray-guard risk does not exist, and the "confirm the guard accepts briefs" step is a no-op that would send an implementer hunting for a whitelist that isn't there. (For contrast, the allow-list guard the original author was thinking of lives in `_buildAndSendPreview` at `:3511-3523` — that governs `fetchPreview`/preview reads, NOT `linkToDocument`.)
> **Replaced with:** No provider change and no guard verification. `copyStitchAssetLink` (`design.js:1905`) already proves briefs-style ad-hoc paths flow through `linkToDocument` unmodified. The change is confined to the webview: add `actions: ['Link Doc']` to `createBriefDocCard`.

## Edge-Case & Dependency Audit

- **Multi-workspace:** path resolution honors the card's own workspace root because it uses the card's `nodeMetadata.sourceFolder` (same source brief preview uses) — no shared/global root assumption.
- **Nested subfolders:** the node id carries the `folderIndex:relativePath` shape the handler already strips (`:1934`), so a brief inside a subfolder resolves to its true nested path.
- **Click isolation:** the `'Link Doc'` button's handler calls `e.stopPropagation()` (`:1068`), so clicking Link copies without selecting/opening the brief.
- **Dependencies & Conflicts:** none; independent of every other subtask in this feature (no shared symbols with the cache/tab/modal/send subtasks).

## Dependencies

- None.

## Adversarial Synthesis

**Risk Summary:** Effectively risk-free — a single additive prop on one card factory, reusing a renderer, message, and provider handler that are all already live for other tabs. The only thing worth stating is a correction: the plan's original headline risk (a `linkToDocument` allow-list rejecting briefs) is imaginary — that handler does no validation — so there is nothing to guard against and no provider change to make.

## Proposed Changes

1. **`design.js` `createBriefDocCard` (`:830`):** pass `actions: ['Link Doc']` into the `renderDocCard` call. The existing args (`sourceId`, `nodeId: node.id`, `nodeMetadata: node.metadata`) already supply everything the `'Link Doc'` branch needs; no other fields to thread.
2. **No provider change.** `linkToDocument` accepts the brief path unconditionally (see the Superseded note). Do not add or "verify" a guard.
3. **No new styling** — `card-icon-btn html-link-btn` is tab-agnostic.

## Non-Goals

- No Serve & Open for briefs (markdown, nothing to serve).
- No change to the folder-level link button.
- No renaming of the shared action identifier (`'Link Doc'` stays; cosmetic refactors are out of scope).

## Verification Plan

- Every brief card shows a Link button; clicking copies the brief's absolute path to the clipboard (same toast/status behavior as the HTML tab) without selecting/opening the brief.
- Cards inside subfolders resolve the correct nested path.
- Multi-workspace: a brief in workspace B copies B's path, not the active tab's default.

### Automated Tests

- Skipped this pass per session directive (SKIP TESTS). Manual verification above is the acceptance gate.

## Review Findings

Correct and complete: `createBriefDocCard` passes `actions: ['Link Doc']`, reusing the shared `renderDocCard`, the `linkToDocument` message, and the provider handler already live for HTML/Images cards; brief nodes already carry `nodeMetadata.sourceFolder`, so the button copies the correct per-workspace path with click isolation (`stopPropagation`). No provider change was needed — the handler does no allow-list validation, exactly as the plan's superseded note established. **No code changed for this subtask.** Validation: `design.js` syntax OK (compile/tests skipped per directive). No remaining risks.
