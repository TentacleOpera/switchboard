# Fix UAT Manual Testing Detection - Verification Plan Sections

## Goal
Update the verification step parser in KanbanProvider.ts to detect manual testing steps in all common section formats: "## Verification Plan" sections with manual subheadings, "### Manual Verification Steps" (with "Steps" suffix), and "### Manual Checklist" — not just the two patterns currently supported.

## Metadata
- **Tags:** [bugfix, testing, workflow]
- **Complexity:** 3

## User Review Required
- Confirm that the expanded Pattern 1 regex (accepting "Steps" suffix and "Checklist") matches intended headings only — no false positives on unrelated `### Manual ...` headings.
- Confirm the dedup strategy (skip Pattern 3 if Pattern 1 already found steps) is acceptable; alternative would be to merge and deduplicate step text.

## Complexity Audit

### Routine
- Adding optional "Steps" suffix to Pattern 1 regex — single character class change
- Adding "Checklist" as an alternation in Pattern 1 — single alternation addition
- Adding Pattern 3 for "## Verification Plan" detection — follows same structure as Patterns 1 & 2
- All changes localized to one method (`_parseVerificationSteps`) in one file
- Backward compatible — existing matched formats continue to work identically

### Complex / Risky
- Pattern overlap: if a plan has both `### Manual Verification Steps` (caught by fixed Pattern 1) AND `Manual verification steps:` under `## Verification Plan` (caught by Pattern 3), steps could be extracted twice. Mitigation: skip Pattern 3 if Pattern 1 already found steps for the same content.
- The non-manual subheading detection regex in Pattern 3 is an enumeration of known automated-test heading variants; it may miss future variants. Mitigation: add a comment noting this may need extension, and the fallback (extracting too much) is less harmful than extracting nothing.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — parser is synchronous and called on demand
- **Security:** No security implications — purely parsing logic for display
- **Side Effects:** None — only affects display of manual testing steps in the UAT/dependency tab
- **Dependencies & Conflicts:** Pattern 1 and Pattern 3 could both match the same plan content; dedup guard required

## Dependencies
None

## Adversarial Synthesis
Key risks: Pattern 1 regex gap affects 10 plans (7 with "Steps" suffix, 3 with "Checklist"); Pattern 3 blank-line bug would silently drop steps; Pattern overlap could cause duplicate entries. Mitigations: expand Pattern 1 regex with optional suffixes, remove blank-line reset in Pattern 3, add dedup guard to skip Pattern 3 when Pattern 1 already found steps.

## Problem
The `_parseVerificationSteps` function in `KanbanProvider.ts` only looks for two patterns:
1. "### Manual Verification" or "### Manual Testing" sections with numbered steps
2. "## Testing Checklist" sections with "- [ ]" checkbox items

However, many plans use formats not matched by either pattern, causing plans with manual testing steps to show as "No manual verification steps defined" in the dependency tab.

**Formats not detected (workspace audit results):**

| Format | Count | Matched? |
|:-------|------:|:---------|
| `### Manual Verification` | 26 | Yes (Pattern 1) |
| `### Manual Testing` | 11 | Yes (Pattern 1) |
| `### Manual Verification Steps` | 7 | **No** — Pattern 1 requires heading to end after "Verification" |
| `### Manual Checklist` | 3 | **No** — Pattern 1 doesn't include "Checklist" |
| `Manual verification steps:` (no ###) under `## Verification Plan` | 2 | **No** — no pattern matches this |
| `## Testing Checklist` | 0 | N/A (no plans use this) |

Example from `fix_kanban_copy_flash_incomplete_implementation.md`:
```markdown
## Verification Plan

### Automated Tests
- No automated tests exist for this UI interaction. Manual verification required.

Manual verification steps:
1. Click "Copy Prompt" on a card → verify green flash animation plays, no visual flash/glitch
2. Click "Copy Prompt" on a card → verify card advances to next column smoothly
...
```

Example from `fix_implementation_default_tab_when_terminals_not_open.md`:
```markdown
## Verification Plan

### Automated Tests
- No automated test infrastructure exists for this webview UI component. Manual verification required.

### Manual Verification Steps
1. Open implementation.html with no terminals running → verify "Terminals" sub-tab is active by default
2. Open agent terminals → verify the tab can be switched to "Agents" and selection is preserved
...
```

## Root Cause Analysis

### Current Parser Logic (KanbanProvider.ts lines 5733-5762)
The `_parseVerificationSteps` function has two regex patterns:
- Pattern 1: `/###\s*Manual\s+(?:Verification|Testing)\s*\n([\s\S]*?)(?=\n###|\n##|$)/i`
- Pattern 2: `/##\s*Testing\s+Checklist\s*\n([\s\S]*?)(?=\n##|$)/i`

### Why It Fails
1. **Pattern 1 requires heading to end immediately after "Verification" or "Testing"** — the regex `\s*\n` expects only optional whitespace before the newline. Headings like `### Manual Verification Steps` have additional text ("Steps") and are not matched.
2. **Pattern 1 doesn't include "Checklist"** — `### Manual Checklist` is semantically equivalent but not in the alternation.
3. **No pattern matches "## Verification Plan"** — 92 plans use this as their top-level verification section, but neither Pattern 1 nor Pattern 2 targets it.
4. **No pattern matches "Manual verification steps:" (no ###)** — this plain-text subheading under `## Verification Plan` is invisible to all patterns.
5. Result: `plan.steps` array is empty for affected plans, causing "No manual verification steps defined" to display.

## Solution
1. **Expand Pattern 1** to accept optional "Steps" suffix and "Checklist" keyword
2. **Add Pattern 3** to detect "## Verification Plan" sections and extract numbered steps from manual-specific subheadings
3. **Add dedup guard** to prevent duplicate extraction when both Pattern 1 and Pattern 3 match

### Implementation Steps

1. **Expand Pattern 1 regex in `_parseVerificationSteps`**
   - File: `src/services/KanbanProvider.ts`
   - Location: Line 5738
   - Change regex from `/###\s*Manual\s+(?:Verification|Testing)\s*\n/` to `/###\s*Manual\s+(?:Verification|Testing|Checklist)(?:\s+Steps)?\s*\n/`
   - This adds: optional "Steps" suffix and "Checklist" as a valid keyword
   - Also update the checkbox extraction: when the heading is "Checklist", extract `- [ ]` items in addition to numbered steps

2. **Add Pattern 3 to `_parseVerificationSteps`**
   - File: `src/services/KanbanProvider.ts`
   - Location: After Pattern 2 (after line 5759), before `return steps;`
   - Add regex to match "## Verification Plan" section
   - Extract numbered steps ONLY from subheadings like "Manual verification steps:" or similar
   - Do NOT extract steps from "Automated Tests" or other non-manual subheadings
   - **Critical**: Do NOT reset `inManualStepsSection` on empty lines — only reset on new headings or non-manual subheadings. Blank lines commonly appear between a subheading and the first step.

3. **Add dedup guard**
   - Before executing Pattern 3, check if `steps.length > 0` (Pattern 1 or 2 already found steps)
   - If so, skip Pattern 3 to avoid duplicate extraction
   - This handles plans that have both `### Manual Verification Steps` AND `## Verification Plan` with manual subheadings

### Files to Modify

- `src/services/KanbanProvider.ts`:
  - Update `_parseVerificationSteps` method (lines 5733-5762)
  - Expand Pattern 1 regex (line 5738)
  - Add checkbox extraction for "Checklist" headings (after line 5746)
  - Add Pattern 3 for "## Verification Plan" detection (after line 5759)
  - Add dedup guard before Pattern 3

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_parseVerificationSteps` method (lines 5733-5762)

**Change 1: Expand Pattern 1 regex (line 5738)**

Replace:
```typescript
const manualVerifMatch = content.match(/###\s*Manual\s+(?:Verification|Testing)\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
```
With:
```typescript
const manualVerifMatch = content.match(/###\s*Manual\s+(?:Verification|Testing|Checklist)(?:\s+Steps)?\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
```

**Change 2: Add checkbox extraction for "Checklist" headings (after line 5746, inside Pattern 1 block)**

After the existing numbered-step extraction loop, add checkbox extraction:
```typescript
// Also extract checkbox items (common in "Manual Checklist" format)
const checkboxMatch = line.match(/^\s*- \[[ x]\]\s+(.+)/i);
if (checkboxMatch && !numberedMatch) {
    steps.push(checkboxMatch[1].trim());
}
```

Note: This requires restructuring the loop slightly — the `numberedMatch` variable needs to be available for the checkbox check. The full restructured Pattern 1 block becomes:

```typescript
// Pattern 1: "### Manual Verification/Testing/Checklist" section with numbered steps or checkboxes
// Updated to accept optional "Steps" suffix and "Checklist" keyword
const manualVerifMatch = content.match(/###\s*Manual\s+(?:Verification|Testing|Checklist)(?:\s+Steps)?\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
if (manualVerifMatch) {
    const lines = manualVerifMatch[1].split('\n');
    for (const line of lines) {
        const numberedMatch = line.match(/^\s*\d+\.\s+(.+)/);
        if (numberedMatch) {
            steps.push(numberedMatch[1].trim());
        } else {
            const checkboxMatch = line.match(/^\s*- \[[ x]\]\s+(.+)/i);
            if (checkboxMatch) {
                steps.push(checkboxMatch[1].trim());
            }
        }
    }
}
```

**Change 3: Add Pattern 3 with dedup guard (after line 5759, before `return steps;`)**

```typescript
// Pattern 3: "## Verification Plan" section with manual-specific subheadings
// Only runs if Patterns 1 and 2 didn't find any steps (dedup guard)
// This handles plans that use "## Verification Plan" as the main section
// and extract steps ONLY from manual-specific subheadings like "Manual verification steps:"
// NOT from "Automated Tests" or other non-manual sections
if (steps.length === 0) {
    const verificationPlanMatch = content.match(/##\s*Verification\s+Plan\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (verificationPlanMatch) {
        const lines = verificationPlanMatch[1].split('\n');
        let inManualStepsSection = false;

        for (const line of lines) {
            // Look for manual-specific subheadings that indicate manual steps follow
            // Accepts: "Manual verification steps:", "Manual testing steps:", "Manual verification:", etc.
            if (/(?:^|\s)manual\s*(?:verification|testing)\s*steps?\s*:/i.test(line)) {
                inManualStepsSection = true;
                continue;
            }

            // Stop extraction if we hit a non-manual subheading (### or ## level)
            if (/^#{1,3}\s/i.test(line)) {
                inManualStepsSection = false;
                continue;
            }

            // Extract numbered steps ONLY if we're in a manual steps section
            if (inManualStepsSection) {
                const numberedMatch = line.match(/^\s*\d+\.\s+(.+)/);
                if (numberedMatch) {
                    steps.push(numberedMatch[1].trim());
                }
                // Note: we do NOT reset inManualStepsSection on empty lines,
                // because blank lines commonly appear between subheading and first step.
            }
        }
    }
}
```

**Key design decisions in Pattern 3:**
- **Dedup guard** (`if (steps.length === 0)`): Prevents duplicate extraction when Pattern 1 already found steps from a `### Manual Verification Steps` heading within the same `## Verification Plan` section.
- **No blank-line reset**: Empty lines between "Manual verification steps:" and the first numbered step are common in markdown; resetting on them would silently drop all steps.
- **Heading-only reset**: Only `###` or `##` level headings reset `inManualStepsSection`, which is simpler and more robust than enumerating all possible automated-test heading variants.
- **Subheading regex**: Uses `(?:^|\s)manual\s*(?:verification|testing)\s*steps?\s*:` to match "Manual verification steps:" and "Manual testing step:" variants, requiring a colon to avoid false matches on prose.

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for the UAT parser. Manual verification required.

### Manual Verification Steps
1. Open a plan with "## Verification Plan" + "Manual verification steps:" subheading (e.g., `fix_kanban_copy_flash_incomplete_implementation.md`)
2. Navigate to the dependency/UAT tab in kanban.html
3. Verify that the manual testing steps are now displayed (not "No manual verification steps defined")
4. Open a plan with "### Manual Verification Steps" heading (e.g., `fix_implementation_default_tab_when_terminals_not_open.md`)
5. Verify that the manual testing steps are displayed (previously broken due to "Steps" suffix)
6. Open a plan with "### Manual Checklist" heading (e.g., `fix_sidebar_dropdown_ghost_plans.md`)
7. Verify that the checkbox items are displayed as steps
8. Open a plan with "### Manual Verification" (no "Steps") to ensure Pattern 1 still works for the original format
9. Open a plan with both "### Manual Verification Steps" AND "Manual verification steps:" to verify no duplicate steps appear

### Edge Cases
- Plans with "## Verification Plan" but no manual-specific subheading should not extract steps from automated sections
- Plans with both "Manual verification steps:" and "### Automated Tests" should only show manual steps in UAT tab
- Plans with "Manual verification steps:" subheading but no numbered steps should show "No manual verification steps defined"
- Plans with blank lines between "Manual verification steps:" and the first numbered step should still extract all steps
- Plans with "### Manual Verification Steps" should not have steps extracted twice (dedup guard)

### Follow-Up (Out of Scope)
- Plans that embed manual steps as prose under "### Automated Tests" (e.g., "1. Open Switchboard kanban panel...") without a manual-specific subheading — these require a different detection strategy (e.g., looking for numbered steps after "Manual verification required" prose) and should be addressed in a separate plan if needed.
- "### Manual Checklist" with `- [ ]` checkbox items is now handled; however, plans using `## Testing Checklist` (Pattern 2) with checkboxes are also supported — no changes needed there.

## Review Pass (2026-05-21)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | Pattern 3 subheading regex `steps?` requires "step"/"steps" before colon — does NOT match "Manual verification:" (without "step/steps"). Real plan file `clickup-linear-detail-ui-compact.md` uses this format with numbered steps that would be silently missed. Plan's own comment claims it accepts "Manual verification:" but the regex doesn't. | **MAJOR** | Fix now |
| 2 | Pattern 3 doesn't extract checkbox items (`- [ ]`), only numbered steps. `customisable_clear_delay_20260515.md` uses "Manual verification steps:" with checkbox items that would be missed. | NIT | Defer — out of plan scope |
| 3 | Pattern 1 checkbox extraction applies to ALL headings (Verification, Testing, Checklist), not just "Checklist" as plan specifies. | NIT | Keep — behavior is more correct |
| 4 | Heading reset regex `^#{1,3}\s` includes h1, plan says only h2/h3. | NIT | Keep — more defensive |
| 5 | Missing test for "Manual Testing Steps" (Pattern 1 with Testing + Steps suffix). | NIT | Add test |
| 6 | Missing test for "## Verification Plan" with no manual subheading returning empty. | NIT | Add test |
| 7 | Pattern 3 subheading regex `(?:^|\s)` could match prose mid-line. | NIT | Accept — colon + numbered-step filter sufficient |

### Stage 2: Balanced Synthesis — Fixes Applied

**Fixed (MAJOR):**
- Finding #1: Changed Pattern 3 subheading regex from `steps?` (requires "step"/"steps") to `(?:\s+steps?)?` (optional "step"/"steps"). Now matches both "Manual verification steps:" AND "Manual verification:".

**Fixed (NITs):**
- Finding #2: Added checkbox extraction (`- [ ]` items) to Pattern 3, matching Pattern 1's behavior. Now handles plans like `customisable_clear_delay_20260515.md` that use "Manual verification steps:" with checkbox items.
- Finding #5: Added test for "Manual Testing Steps" (Pattern 1 with Testing + Steps suffix).
- Finding #6: Added test for "## Verification Plan" with no manual subheading returning empty.
- Added test for "Manual verification:" without "step/steps" under "## Verification Plan" (validates Finding #1 fix).
- Added test for checkbox items under "Manual verification steps:" in "## Verification Plan" (validates Finding #2 fix).

**Kept as-is:**
- Finding #3: Broader checkbox extraction is better behavior.
- Finding #4: h1 heading reset is more defensive.

**Deferred:**
- Finding #7: Prose-matching risk is theoretical and mitigated by numbered-step filter.

### Files Changed

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` line 6100 | Pattern 3 subheading regex: `steps?` → `(?:\s+steps?)?` to match "Manual verification:" without "step/steps" |
| `src/services/KanbanProvider.ts` lines 6111-6124 | Pattern 3: added checkbox extraction (`- [ ]` items) alongside numbered steps |
| `src/services/__tests__/KanbanProvider.test.ts` lines 348-394 | Added 4 new tests: "Manual Testing Steps", "## Verification Plan with no manual subheading returns empty", "Manual verification: without step/steps", "checkbox items under Manual verification steps: in ## Verification Plan" |

### Validation Results

- **Tests**: 13/13 passing (9 original + 4 new)
  - `npx vscode-test --grep "_parseVerificationSteps"` → 13 passing (67ms)
- **Build**: webpack compiled successfully (no errors)
- **TypeScript**: Pre-existing TS2835 errors in unrelated files (ClickUpSyncService.ts, KanbanProvider.ts dynamic imports) — not introduced by this change

### Remaining Risks

1. **Prose subheading false positive**: The `(?:^|\s)` prefix in Pattern 3's subheading regex could match "Manual verification:" in prose mid-line (e.g., "For manual verification: see docs"). Mitigated by the colon requirement and the numbered-step extraction filter, but not eliminated.

## Recommendation
Complexity 3 → **Send to Intern**
