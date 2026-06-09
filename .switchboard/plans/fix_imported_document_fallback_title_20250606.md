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

---

## Reviewer Pass — Completed

### Stage 1: Grumpy Adversarial Findings

- **[NIT]** *Line number drift.* The plan cites line ~3332 for the fallback. I found it at line 3369. If your line numbers are this stale, how do I trust any other locators in this plan? Update your copy-paste templates, intern.
- **[NIT]** *Semantic inconsistency within the method.* Line 3354 still says `"Copy research markdown first"` and line 3377 still passes `'research-clipboard'` as the content-type tag. You changed the filename but left the user-facing error message and internal registry tag untouched. The user now imports an "Imported Document" but gets told they forgot to copy "research markdown." Pick a lane.
- **[NIT]** *Zero test coverage.* The plan admits no automated tests cover the fallback branch and then shrugs. A two-line test that stubs `clipboard.readText()` with plain text and asserts on `finalDocTitle` would have taken thirty seconds. Thirty. Seconds.

### Stage 2: Balanced Synthesis

- **What to keep:** The single-string replacement at line 3369 is correct. The timestamp format, slug generation, and registry write all adapt naturally to the new prefix. No regressions introduced.
- **What to fix now:** Nothing. The error-message and content-type inconsistencies are pre-existing and out of the stated scope.
- **What to defer:** Update the `"Copy research markdown first"` string and the `'research-clipboard'` tag in a follow-up polish pass if product wants full terminology alignment. Add a unit test for the no-H1, no-title fallback branch.

### Code Fixes Applied

None. No CRITICAL or MAJOR findings.

### Verification Results

- **Grep scan:** `Research-\${timestamp}` returns zero matches in `src/`. Confirmed no stale fallback strings remain.
- **Code read:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:3368-3370` shows `finalDocTitle = \`Imported Document ${timestamp}\`;`.
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.

### Files Changed

- `src/services/PlanningPanelProvider.ts` (line 3369)

### Remaining Risks

- Negligible. The change is a single-string fallback replacement with no API or data-model impact.

**Reviewer Verdict:** Approved. Ship it.
