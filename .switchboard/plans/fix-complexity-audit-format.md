# Fix Complexity Audit Format and Parser Flexibility

## Goal
Make the complexity audit parser more flexible to handle various reasonable markdown formats, and update improve-plan.md to specify the canonical format as guidance.

## Metadata
- **Tags:** documentation, workflow, reliability
- **Complexity:** 4

## User Review Required
No

## Complexity Audit

### Routine
- Update improve-plan.md to specify canonical format as guidance (not strict requirement)
- Relax KanbanProvider.ts parser to handle formats without strict blank line requirements
- Accept both bullet-point and plain text content under subsections
- Accept formats with or without blank lines after headings
- No breaking changes to existing plans

### Complex / Risky
- Parser changes affect complexity routing logic — ensure backward compatibility with existing plans
- Add test cases for various format variations to prevent regression

## Edge-Case & Dependency Audit
- **Race Conditions:** None
- **Security:** None
- **Side Effects:** Parser changes affect complexity routing — must ensure backward compatibility with existing plans
- **Dependencies & Conflicts:** None

## Dependencies
None

## Adversarial Synthesis
Key risks: Making the parser more permissive could incorrectly parse malformed sections, and changes to the regex impact routing logic, which must remain backward compatible. Mitigations: The root cause was identified as the regex failing to consume the ` / Risky` suffix, not missing blank lines; fixing this specific capture ensures backward compatibility while solving the parsing error. Comprehensive test coverage for format variations will prevent regressions.

## Root Cause Analysis

The `improve-plan.md` workflow specifies:

```markdown
4. **## Complexity Audit**
   - ### Routine
   - ### Complex / Risky (if empty, write "- None" explicitly)
```

However, the kanban parser in `KanbanProvider.ts` (lines 2986-3029) had a flaw when parsing the "Complex / Risky" heading. The original regex:
```typescript
const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex)\b/im);
```
Only matched the word "Complex" and stopped at the word boundary. This left the suffix ` / Risky` to be treated as the first line of the complex section's content.

The `normalizeBandBLine` function then processed ` / Risky` into `/ risky`. Because `/ risky` didn't match the list of labels to ignore (`isBandBLabel`), the parser treated it as a legitimate complex risk factor, returning a complexity of '8' (Lead Coder), regardless of the `- None` that followed.

The problem was not missing blank lines—the `nextSection` regex using `^` with the `/m` flag already correctly matches headings without preceding blank lines. The issue is purely the incomplete consumption of the "Complex / Risky" heading.

As a result, planners generate various inconsistent formats, and the trailing suffix breaks the parser when " / Risky" is appended.

## Proposed Changes

### `.agent/workflows/improve-plan.md`

**Context:** Lines 32-34 in the Required Sections list.

**Logic:** Add explicit formatting guidance (not strict requirement) and an example for the Complexity Audit section.

**Implementation:**

Replace lines 32-34:
```markdown
   4. **## Complexity Audit**
      - ### Routine
      - ### Complex / Risky (if empty, write "- None" explicitly)
```

With:
```markdown
   4. **## Complexity Audit**
      - **### Routine** — bullet points or plain text listing routine aspects
      - **### Complex / Risky** — bullet points or plain text listing complex/risky aspects (or "- None" if empty)
      
      **Recommended format** (parser is flexible):
      ```markdown
      ## Complexity Audit

      ### Routine
      - [routine aspect 1]
      - [routine aspect 2]

      ### Complex / Risky
      - [complex aspect 1]
      - [or "- None" if no complex aspects]
      ```
```

### `src/services/KanbanProvider.ts`

**Context:** `getComplexityFromPlan` method, lines 2986-3030 (Band B parsing logic).

**Logic:** Update the `bandBMatch` regex to fully consume "Complex / Risky" or other variations so the suffix doesn't bleed into the content payload.

**Implementation:**

Update the Band B parsing logic to explicitly match the optional suffix.

Current logic (lines 2986-2999):
```typescript
// Fallback: parse the Complexity Audit / Complex (Band B) section
const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
if (!auditMatch) {
    return 'Unknown';
}

const auditStart = auditMatch.index! + auditMatch[0].length;
const afterAudit = content.slice(auditStart);
const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex)\b/im);
if (!bandBMatch) return '3';
```

Updated logic:
```typescript
// Fallback: parse the Complexity Audit / Complex (Band B) section
const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
if (!auditMatch) {
    return 'Unknown';
}

const auditStart = auditMatch.index! + auditMatch[0].length;
const afterAudit = content.slice(auditStart);

// More lenient: accept various heading formats (Band B, Complex, Complex / Risky, etc.)
// Ensures the entire heading is consumed so suffixes like " / Risky" don't bleed into content.
const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex\s*(?:\/\s*Risky)?|Complex)\b/im);
if (!bandBMatch) return '3';
```

No changes are needed for the `nextSection` regex, as the `/m` flag already handles lines without preceding blank lines. The `normalizeBandBLine`, `isBandBLabel`, and `isEmptyMarker` functions (lines 3004-3025) already handle various formats well and should remain unchanged.

### `src/test/kanban-complexity.test.ts`

**Context:** Add test cases for format variations.

**Logic:** Add tests to verify the parser handles various reasonable format variations.

**Implementation:**

Add new test cases:
1. Test with no blank lines after headings
2. Test with plain text (no bullets) under subsections
3. Test with mixed bullet styles (`-`, `*`, `+`)
4. Test with "- None" vs "None" vs "n/a"
5. Test specifically that "Complex / Risky" suffix is correctly ignored

## Verification Plan

### Automated Tests
- Add test cases in `src/test/kanban-complexity.test.ts` for format variations:
  - Test with no blank lines after headings
  - Test with plain text (no bullets) under subsections
  - Test with mixed bullet styles (`-`, `*`, `+`)
  - Test with "- None" vs "None" vs "n/a"
  - Test specifically that "Complex / Risky" heading suffix doesn't fall through
- Run existing complexity tests to ensure backward compatibility

### Manual Testing
1. After updating improve-plan.md, trigger a planner to improve a plan
2. Verify the generated Complexity Audit section follows the recommended format
3. Test parser with various format variations:
   - Plan with no blank lines (like fix-research-tab-planning-html.md)
   - Plan with plain text under Routine
   - Plan with "None" vs "- None" under Complex
4. Verify the kanban board correctly parses complexity from all format variations
5. Verify existing plans still parse correctly (backward compatibility)

## Success Criteria
1. improve-plan.md specifies the recommended Complexity Audit format as guidance (not strict requirement)
2. KanbanProvider.ts parser accepts various reasonable format variations (no blank lines, plain text, different bullet styles)
3. Test cases added to kanban-complexity.test.ts cover format variations
4. Existing plans still parse correctly (backward compatibility maintained)
5. Planners generate plans that parse correctly regardless of minor format variations

---

**Recommendation:** Send to Coder (complexity 4)

## Review Results

### Stage 1 (Grumpy)
*   **[NIT] `KanbanProvider.ts` - Redundant Regex Branch:** The regex update `/Complex\s*(?:\/\s*Risky)?|Complex/` has a redundant `|Complex` branch at the end. Since `(?:\/\s*Risky)?` already makes the suffix optional, the first branch `Complex\s*(?:\/\s*Risky)?` already matches "Complex". This is a sloppy regex duplication! Do we really need to check for "Complex" twice? No. But does it break anything? No.

### Stage 2 (Balanced)
The implementation perfectly matches the plan requirements and handles the core issue accurately.
*   **`.agent/workflows/improve-plan.md`:** Successfully updated with canonical format guidance.
*   **`src/services/KanbanProvider.ts`:** The regex update successfully resolves the parser issue. The redundant `|Complex` in the regex is a minor NIT and doesn't affect performance or correctness in any meaningful way. It was left as-is since it is functionally sound.
*   **`src/test/kanban-complexity.test.ts`:** Comprehensive tests were added covering plain text, no blank lines, and mixed bullets.

**Fixes Applied:** None required. The implementation is solid.

**Validation Results:**
*   **Tests:** `npx vscode-test` passed successfully (47 passing tests).
*   **Build/Lint:** `npm run compile-tests` and `webpack` passed successfully.

**Files Changed:**
*   `.agent/workflows/improve-plan.md`
*   `src/services/KanbanProvider.ts`
*   `src/test/kanban-complexity.test.ts`

**Remaining Risks:** None. The fallback logic is robust against reasonable markdown variations and properly avoids routing failures for valid inputs.