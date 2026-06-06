# Fix Imported Document Fallback Title from "Research" to "Imported Document"

## Metadata
- **Complexity:** 2
- **Tags:** bugfix, ui, backend

## Goal
When a user imports a document from clipboard via any of the **Import** buttons in the Planning panel and the pasted content contains no H1 heading and no custom title was provided, the fallback filename currently defaults to `Research-<timestamp>`. This is misleading because users import many kinds of documents, not just research. Change the fallback to `Imported Document <timestamp>`.

## Background & Root Cause
In `src/services/PlanningPanelProvider.ts`, the `_handleImportResearchDoc` method derives the document title in this priority:
1. Custom user-provided title (if any)
2. First `# Heading` from clipboard content
3. Fallback: `Research-${timestamp}` — hardcoded at line ~3332

The per-folder **Import** buttons in `planning.html` / `planning.js` do not pass a custom `docTitle`, so almost all clipboard imports via those buttons hit this fallback. The "Research" prefix is a legacy naming choice that no longer reflects the broad usage of the import feature.

## User Review Required
- None. This is a straightforward string replacement with no product-scope change.

## Complexity Audit

### Routine
- Single-string literal replacement in one file.
- Reuses existing timestamp formatting and slug-generation logic.
- No new API, pattern, or dependency introduced.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. The change is in a synchronous fallback branch after all async input gathering.
- **Security:** None. No user input is newly trusted or processed differently.
- **Side Effects:** New imports will produce slugs prefixed with `imported_document_` instead of `research_`. Existing registry entries and files are untouched.
- **Dependencies & Conflicts:** None. Verified via grep that `Research-${timestamp}` is the only occurrence of this pattern in the codebase.

## Dependencies
- None

## Adversarial Synthesis
Key risks: User expectation shift (some users may associate "Research-" prefix with their workflow); no automated tests cover the fallback branch. Mitigations: The fallback is only hit for new imports without H1 or custom title; manual verification steps are provided.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
- **Context:** Inside `_handleImportResearchDoc`, the `finalDocTitle` fallback assignment.
- **Logic:** Change the string template from `Research-${timestamp}` to `Imported Document ${timestamp}`.
- **Implementation:** One-line edit at line 3332.
- **Edge Cases:** Slug generation (`rawSlug`) automatically lowercases and replaces spaces with `_`, so no additional sanitization is needed. Existing files and registry entries are unaffected.

## Verification Plan

### Automated Tests
- Not applicable per session directive (skip tests). Manual verification steps below.

### Manual Verification
1. Open the Switchboard Planning panel.
2. Go to the **Local Docs** tab.
3. Click any per-folder **Import** button (pasting non-research content with no H1 heading).
4. Confirm the newly created file in the docs folder is named `Imported Document 2026-... .md` (the VS Code file explorer or the tree pane should show the title).
5. Confirm the Research tab's **IMPORT FROM CLIPBOARD** button (with no custom title and no H1 in clipboard) also uses the new fallback.

## Risks
- **Negligible.** This is a single-string change in a fallback branch. No API or data-model changes.

**Recommendation:** Send to Intern

