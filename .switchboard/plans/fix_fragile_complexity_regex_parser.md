# Fix Fragile Complexity Regex Parser

## Goal
Make the complexity and tags regex parsers in KanbanProvider.ts and planMetadataUtils.ts robust against markdown list markers and indentation in plan Metadata sections. The current regexes fail when fields have leading dashes, asterisks, or inconsistent whitespace.

## Metadata
**Tags:** bugfix, reliability
**Complexity:** 3
**Repo:** *(single-repo workspace)*

## User Review Required
No — regex-only fix, no UX or product logic changes.

## Root Cause
The regexes in two files fail when bold fields are prefixed with list markers:

**File 1: `src/services/KanbanProvider.ts`**
- Line 2657: `/\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/i`
- Line 2693: `/\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/i`

**File 2: `src/services/planMetadataUtils.ts`**
- Line 67: `/\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/i`
- Line 80: `/\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/i`
- Line 94: `/\*\*Tags:\*\*\s*(.+)/i` — same fragility for Tags field

All five regexes only match the exact pattern `**Field:**` and fail with:
- `- **Complexity:** 5` (dash list marker)
- `* **Complexity:** 5` (asterisk list marker)
- `  **Complexity:** 5` (indented)

## Complexity Audit

### Routine
- Adding `^[\s\-\*]*` prefix and `im` flags to 5 existing regex patterns (2 in KanbanProvider.ts, 3 in planMetadataUtils.ts)
- Adding test cases for list-marker variations to existing test file `planMetadataUtils.test.ts`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — regex parsing is synchronous and stateless within each call.
- **Security:** No user input is executed; regex only extracts values from plan files already on disk.
- **Side Effects:** More permissive regex means previously "Unknown" plans may now resolve to a numeric complexity. This is the *intended* fix, not a side effect.
- **Dependencies & Conflicts:** Kanban state query failed — unable to verify active kanban plans for conflicts. No known conflicts based on plan scope (regex-only change, no shared state mutations). Uncertainty noted.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) plan originally missed `planMetadataUtils.ts` which has identical fragility — must fix both files in same change, (2) proposed `[:\-]?` regex addition doesn't actually solve the "missing colon outside bold" case and adds unnecessary complexity — dropped in favor of simpler list-marker-only fix, (3) code-block false positives are pre-existing (not a regression). Mitigations: expanded scope to both files, simplified regex, documented code-block limitation as pre-existing.

## Proposed Changes

### src/services/KanbanProvider.ts

#### 1. Update Manual Complexity Override regex (line 2657)

**Before:**
```typescript
const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/i);
```

**After:**
```typescript
const overrideMatch = content.match(/^[\s\-\*]*\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/im);
```

- `^[\s\-\*]*` — optional leading whitespace, dashes, or asterisks at start of line
- `im` flags — case-insensitive + multiline

#### 2. Update Metadata Complexity regex (line 2693)

**Before:**
```typescript
const metadataComplexity = content.match(/\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/i);
```

**After:**
```typescript
const metadataComplexity = content.match(/^[\s\-\*]*\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/im);
```

- Same pattern: `^[\s\-\*]*` prefix + `im` flags
- No `[:\-]?` — the "colon outside bold" case (`**Complexity**: 5`) is extremely rare in practice and adds unnecessary regex complexity. If needed later, it can be addressed as a separate fix.

### src/services/planMetadataUtils.ts

#### 3. Update Manual Complexity Override regex (line 67)

**Before:**
```typescript
const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/i);
```

**After:**
```typescript
const overrideMatch = content.match(/^[\s\-\*]*\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/im);
```

#### 4. Update Metadata Complexity regex (line 80)

**Before:**
```typescript
const metadataMatch = content.match(/\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/i);
```

**After:**
```typescript
const metadataMatch = content.match(/^[\s\-\*]*\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/im);
```

#### 5. Update Tags regex (line 94)

**Before:**
```typescript
const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)/i);
```

**After:**
```typescript
const tagsMatch = content.match(/^[\s\-\*]*\*\*Tags:\*\*\s*(.+)/im);
```

- Same list-marker tolerance pattern applied to Tags field

**Supported variations (all fields):**
- `**Complexity:** 5`
- `- **Complexity:** 5`
- `* **Complexity:** 5`
- `  **Complexity:** 5` (indented)

**Known limitation (pre-existing):** Fields inside fenced code blocks may match. This is not a regression — the original regexes had the same behavior. No plan in the repo places metadata fields inside code blocks.

## Test Cases

### Complexity Variations (apply to both files)
1. `**Complexity:** 5` ✓
2. `- **Complexity:** 5` ✓ (current bug)
3. `* **Complexity:** 5` ✓
4. `  **Complexity:** 5` ✓

### Manual Complexity Override Variations
1. `**Manual Complexity Override:** 7` ✓
2. `- **Manual Complexity Override:** 7` ✓
3. `* **Manual Complexity Override:** 7` ✓
4. `  **Manual Complexity Override:** 7` ✓

### Tags Variations
1. `**Tags:** frontend, backend` ✓
2. `- **Tags:** frontend, backend` ✓
3. `* **Tags:** frontend, backend` ✓
4. `  **Tags:** frontend, backend` ✓

### Legacy Format Compatibility
1. `**Complexity:** Low` → should convert to numeric via `legacyToScore()`
2. `**Complexity:** High` → should convert to numeric via `legacyToScore()`

### Edge Cases to Verify
1. Multiple occurrences in file → should match first occurrence
2. Field name as plain text (not bold) → should NOT match (intentional)
3. Field in code block → known pre-existing limitation, may match (not a regression)
4. Field with extra spaces → `**Complexity:**   5` → should match (`\s*` handles this)
5. Field with tabs → `**Complexity:**\t5` → should match (`\s*` includes tabs)

## Verification Plan

### Automated Tests
Add test cases to existing file `src/services/__tests__/planMetadataUtils.test.ts`:

```typescript
describe('parsePlanMetadata - list-marker tolerance', () => {
    const listMarkerCases = [
        { label: 'dash list marker', content: '## Metadata\n- **Complexity:** 5', expected: '5' },
        { label: 'asterisk list marker', content: '## Metadata\n* **Complexity:** 5', expected: '5' },
        { label: 'indented', content: '## Metadata\n  **Complexity:** 5', expected: '5' },
        { label: 'dash list marker (override)', content: '- **Manual Complexity Override:** 8\n**Complexity:** 5', expected: '8' },
        { label: 'dash list marker (tags)', content: '## Metadata\n- **Tags:** frontend, backend', expectedTags: ',frontend,backend,' },
    ];

    listMarkerCases.forEach(({ label, content, expected, expectedTags }) => {
        it(`handles ${label}`, async () => {
            const metadata = await parsePlanMetadata(content, 'test.md');
            if (expected) assert.strictEqual(metadata.complexity, expected);
            if (expectedTags) assert.strictEqual(metadata.tags, expectedTags);
        });
    });
});
```

### Manual Testing
1. Reload kanban board
2. Verify plan with `- **Complexity:** 5` now displays complexity correctly
3. Test plan with `* **Complexity:** 5` (asterisk list marker)
4. Test plan with `**Manual Complexity Override:** 7` (manual override still works)
5. Test plan with legacy `Low`/`High` values still convert correctly

### Regression Testing
- Verify existing plans with `**Complexity:** 5` format still work (no breaking change)
- Verify DB-based complexity still takes precedence over file parsing
- Verify manual override still takes highest precedence
- Verify Tags extraction still works for standard format

## Files to Modify
- `src/services/KanbanProvider.ts`:
  - Line 2657: Update Manual Complexity Override regex
  - Line 2693: Update Metadata Complexity regex
- `src/services/planMetadataUtils.ts`:
  - Line 67: Update Manual Complexity Override regex
  - Line 80: Update Metadata Complexity regex
  - Line 94: Update Tags regex
- `src/services/__tests__/planMetadataUtils.test.ts`:
  - Add list-marker tolerance test cases

## Risk Assessment
**Low Risk**
- Changes are regex-only, no logic flow modifications
- More permissive regex means existing valid formats continue to work
- Backward compatible — all existing plan formats remain supported
- Fallback to 'Unknown' if no match remains unchanged
- Code-block false positive is pre-existing, not a regression

## Recommendation
Complexity 3 — **Send to Coder**
