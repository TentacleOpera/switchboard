---
topic: Filename Fallback for Plans Without topic: or #H1
sessionId: filename-fallback-untitled-plans
complexity: low
kanbanColumn: CREATED
---

## Goal
When a plan file has neither `topic:` frontmatter nor an `# H1` heading, derive a readable title from the filename instead of showing "Untitled Plan" in the Kanban, Review panel, and other UI surfaces.

## Metadata
**Tags:** backend, bugfix, UI, workflow
**Complexity:** 3

## User Review Required
- [ ] Confirm that `inferTopicFromPath` returning `'(untitled)'` for hash-only filenames is acceptable (e.g., `a1b2c3d4e5f6...md`). Such files are rare in practice but possible.
- [ ] Confirm the review.html approach: port `inferTopicFromPath` logic to JS in the webview, or send a pre-computed `planFileAbsolute` from the provider and derive the title client-side.

## Complexity Audit
### Routine
- Extract `_inferTopicFromPath` from `TaskViewerProvider.ts` into a shared utility in `planMetadataUtils.ts`. Pure function, no side effects.
- Update `parsePlanMetadata` fallback from `'Untitled Plan'` to `inferTopicFromPath(planFile)`. Single-line change.
- Update `TaskViewerProvider.ts` to import and use the shared helper instead of the private method. Mechanical refactor.
- Add test cases for the new fallback behavior.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. `parsePlanMetadata` is synchronous (regex-based) and `inferTopicFromPath` is a pure string function.
- **Security:** None. File path manipulation only; no user input reaches shell or network.
- **Side Effects:** The existing test `'handles missing metadata gracefully'` in `planMetadataUtils.test.ts` (line 61) asserts `metadata.topic === 'Untitled Plan'`. This test MUST be updated to expect a filename-derived topic (or `'(untitled)'` for the empty-content case).
- **Dependencies & Conflicts:** `KanbanProvider.ts` has 8 instances of `row.topic || row.planFile || 'Untitled'` fallback (lines 747, 760, 1487, 1502, 1618, 1631, 2434). These are downstream consumers that will naturally receive the improved topic from the DB once `parsePlanMetadata` is fixed — no direct changes needed there. The `planFile` fallback in those expressions was already unreachable because `'Untitled Plan'` is truthy; after this fix, the `topic` will be the filename-derived title, so the `planFile` fallback remains unreachable but harmlessly so.
- **Hash-only filenames:** `inferTopicFromPath` strips leading 32+ char hex hashes. If the entire filename is a hash (e.g., `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2.md`), the result is `'(untitled)'`. This is an existing behavior in `TaskViewerProvider` and is not worsened by this change.

## Dependencies
- None

## Adversarial Synthesis
**Risk Summary:** The core change is a one-line fallback swap in a pure function — extremely low risk. The only material risk is the existing test that asserts `'Untitled Plan'` as the fallback value, which must be updated. The review.html changes require a design decision (JS port vs. provider-sent value) but either approach is low-risk. No cross-plan conflicts detected.

## Problem

`parsePlanMetadata` (`src/services/planMetadataUtils.ts:42`) is the single source of truth for extracting plan titles from file content. Its current fallback is:

```ts
const topic = topicMatch?.[1] || 'Untitled Plan';
```

This `'Untitled Plan'` string is then stored in the Kanban DB. Both `KanbanProvider.ts` and `TaskViewerProvider.ts` have `row.topic || row.planFile || 'Untitled'` style fallbacks, but because `'Untitled Plan'` is truthy the filename fallback never executes. The result is that every plan missing a `topic:` or `# H1` displays as "Untitled Plan" everywhere.

## Proposed Changes

### 1. Extract shared filename-to-title helper
`TaskViewerProvider.ts` already has a robust `_inferTopicFromPath` method (`~line 8782`) that:
- Strips known prefixes (`brain_`, `feature_plan_`, `plan_`)
- Strips leading 32+ character hex hashes
- Replaces `_` and `-` with spaces
- Title-cases the result

Extract this into a shared utility in `src/services/planMetadataUtils.ts` (e.g., `export function inferTopicFromPath(filePath: string): string`).

Update `TaskViewerProvider.ts` to import and use the shared helper, removing the private method.

### 2. Update `parsePlanMetadata` fallback
In `src/services/planMetadataUtils.ts` (`~line 42`), change:

```ts
const topic = topicMatch?.[1] || inferTopicFromPath(planFile);
```

This ensures that freshly parsed plans get a human-readable filename-derived topic instead of `'Untitled Plan'`.

### 3. Update Review Panel fallback
`src/webview/review.html` has several hardcoded `'Untitled Plan'` fallbacks (`~lines 935, 937, 959, 999`). Update the display logic so that if the received topic equals `'Untitled Plan'` (case-insensitive), it falls back to deriving a title from `planFileAbsolute` or `planFile` using the same `inferTopicFromPath` logic (re-implemented in JS for the webview, or sent down from the provider).

### 4. Update tests
In `src/services/__tests__/planMetadataUtils.test.ts`:
- **CRITICAL:** Update the existing `'handles missing metadata gracefully'` test (line 58-63). It currently asserts `metadata.topic === 'Untitled Plan'` for empty content with filename `brain_test.md`. After the fix, this should expect `'Test'` (derived from `brain_test.md` after stripping `brain_` prefix).
- Add a test case: a plan file with no `topic:` and no `# H1` should return a filename-derived topic (e.g., `fix_kanban_column_sorting.md` → `'Fix Kanban Column Sorting'`).
- Add a test case: verify prefix stripping (`brain_`, `feature_plan_`, `plan_`) and title-casing works correctly.
- Add a test case: hash-only filename (e.g., `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2.md`) returns `'(untitled)'`.

## Files to Change
- `src/services/planMetadataUtils.ts` — add `inferTopicFromPath`, update `parsePlanMetadata` fallback (line 42)
- `src/services/TaskViewerProvider.ts` — replace `_inferTopicFromPath` (line 8782) with shared import; update all 7 call sites (lines 8883, 9246, 9326, 9338, 10602, 10857, 11824)
- `src/webview/review.html` — add filename fallback in review panel JS (lines 935-936, 998-999, 1059)
- `src/services/__tests__/planMetadataUtils.test.ts` — update existing test (line 61), add new test cases

## Acceptance Criteria
- [ ] A plan file named `fix_kanban_column_sorting.md` with no `topic:` and no `# H1` displays as "Fix Kanban Column Sorting" in the Kanban.
- [ ] Same plan shows the filename-derived title in the Review panel.
- [ ] Plans with explicit `topic:` still use the provided topic.
- [ ] Plans with an `# H1` heading still use the heading text.
- [ ] Existing `_inferTopicFromPath` tests in `TaskViewerProvider` still pass (or are migrated to `planMetadataUtils` tests).
- [ ] A plan file named `brain_test.md` with empty content shows "Test" (not "Untitled Plan").
- [ ] A plan file whose name is entirely a 32+ char hex hash shows "(untitled)" (existing behavior, unchanged).

## Verification Plan
### Automated Tests
1. Run `npx jest --testPathPattern="planMetadataUtils"` to verify:
   - New fallback returns filename-derived topic for plans without `topic:` or `# H1`
   - Prefix stripping works (`brain_`, `feature_plan_`, `plan_`)
   - Hash-only filenames return `'(untitled)'`
   - Existing tests pass with updated expectation
2. Run `npx jest --testPathPattern="TaskViewerProvider"` to verify no regressions from the refactor.

### Manual Verification
1. Create a test plan file at `.switchboard/plans/test_no_topic.md` with no `topic:` frontmatter and no `# H1` heading.
2. Open the Kanban view and confirm the plan displays with a title derived from the filename ("Test No Topic").
3. Open the Review panel for the same plan and confirm the title is filename-derived.
4. Edit the plan to add `topic: Custom Title` in frontmatter, refresh, and confirm "Custom Title" is used.
5. Edit the plan to add `# My Heading` as first line, refresh, and confirm "My Heading" is used.

---
**Recommendation:** Send to Coder (complexity 3).

## Review Results (In-Place Pass)

### Stage 1: Grumpy Principal Engineer Findings

#### CRITICAL-1: TypeScript compilation broken — `inferTopicFromPath` type too strict

**File:** `src/services/TaskViewerProvider.ts`, lines 8914 and 8960

The `inferTopicFromPath` function signature was `(filePath: string): string`, but at lines 8914 and 8960, the argument is `entry.brainSourcePath || entry.localPlanPath`, which evaluates to `string | undefined` because both properties are optional on the entry type. Running `npx tsc -p tsconfig.test.json --noEmit` produced:

```
src/services/TaskViewerProvider.ts(8914,48): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/services/TaskViewerProvider.ts(8960,52): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
```

**You shipped a refactor that doesn't compile.** The function already handles falsy input gracefully (returns `'(untitled)'` on line 38), and the test on line 94 even passes `undefined as any` — so the type signature should match the runtime behavior.

#### CRITICAL-2: Compiled output was stale — tests ran against OLD code

**File:** `out/services/planMetadataUtils.js`, line 34

The compiled JS still had `const topic = topicMatch?.[1] || 'Untitled Plan';` — the old fallback. The `inferTopicFromPath` function didn't exist in the compiled output at all. The test file `out/services/__tests__/planMetadataUtils.test.js` still asserted `metadata.topic === 'Untitled Plan'` and didn't include the `inferTopicFromPath` test block. The 7 "passing" tests were running against stale compiled code that predated the implementation. **The real tests had never been executed.** This is a deployment integrity issue — if someone ships the `out/` directory, they ship the old behavior.

#### MAJOR-1: `_isGenericTopic` doesn't recognize `'Untitled Plan'` as generic

**File:** `src/services/TaskViewerProvider.ts`, line 8826-8828

```ts
private _isGenericTopic(s: string): boolean {
    return !s || s === '(untitled)' || /^(simple\s+)?implementation\s+plan$/i.test(s.trim());
}
```

This method is the gatekeeper for whether the recovery code tries to find a better topic from the filename. It recognized `'(untitled)'` and `'Implementation Plan'` as generic, but **NOT `'Untitled Plan'`**. The entire point of this plan is to eliminate `'Untitled Plan'` as a dead-end fallback. But existing DB rows with `topic = 'Untitled Plan'` would sail right past `_isGenericTopic`, never triggering the `inferTopicFromPath` fallback at lines 8914 and 8960. **The migration path was broken for existing data.**

#### MAJOR-2: `inferTopicFromPath` hash-stripping regex misses hash+text without underscore separator

**File:** `src/services/planMetadataUtils.ts`, line 42

```ts
name = name.replace(/^[0-9a-f]{32,}$/i, '').replace(/^[0-9a-f]{32,}_/i, '');
```

If the name starts with a 32+ hex hash followed by text **without an underscore** (e.g., `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2testplan.md`), NEITHER regex matches. The first fails because of `testplan` after the hash (no `$` anchor). The second fails because there's no `_` separator. The result would be the entire hash+text string title-cased. The JS port in `review.html` (line 621) has the same issue. While this is an unlikely filename pattern in practice, it should be documented or handled.

#### NIT-1: Duplicate test — "strips leading hex hashes" and "handles hash-only filenames"

**File:** `src/services/__tests__/planMetadataUtils.test.ts`, lines 83-90

Both test cases assert the identical thing:
```ts
assert.strictEqual(inferTopicFromPath('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2.md'), '(untitled)');
```
Line 85 and line 89 are identical assertions. Harmless but sloppy.

#### NIT-2: `review.html` JS port extension regex differs from `path.extname()`

**File:** `src/webview/review.html`, line 618

```js
name = name.replace(/\.[^/.]+$/, ''); // remove extension
```
The regex `[^/.]+` won't match extensions containing dots (e.g., `.tar.gz`). The TS version uses `path.extname()` which handles this correctly. For plan files (always `.md`), this is fine, but the comment says "mirrors planMetadataUtils.ts" which is slightly misleading.

#### NIT-3: `createDraftPlanTicket` still uses hardcoded `'Untitled Plan'`

**File:** `src/services/TaskViewerProvider.ts`, line 13857

```ts
const title = 'Untitled Plan';
```

The review.html now treats `'Untitled Plan'` as a default title and falls back to `inferTopicFromPath`. This creates a roundabout flow: draft content has `# Untitled Plan` H1 → `parsePlanMetadata` extracts it → stored as `'Untitled Plan'` in DB → review.html detects it as default → falls back to filename-derived title. It works but is circuitous.

### Stage 2: Balanced Synthesis

#### Fix Now (CRITICAL/MAJOR — valid findings)

| # | Finding | Action | File | Line |
|---|---------|--------|------|------|
| C1 | TS compilation broken | Change `inferTopicFromPath` param type to `string \| undefined` | `planMetadataUtils.ts` | 37 |
| C2 | Compiled output stale | Recompile with `npx tsc -p tsconfig.test.json` and re-run tests | `out/` | — |
| M1 | `_isGenericTopic` missing `'Untitled Plan'` | Add `\|\| s.toLowerCase() === 'untitled plan'` to the check | `TaskViewerProvider.ts` | 8827 |

#### Defer (NIT-level)

| # | Finding | Reason to defer |
|---|---------|-----------------|
| M2 | Hash+text without underscore | Extremely unlikely filename pattern; no real-world occurrence expected |
| N1 | Duplicate test case | Harmless; cosmetic cleanup |
| N2 | JS port extension regex | Only `.md` files in practice |
| N3 | `createDraftPlanTicket` hardcoded title | Works correctly via fallback chain |

### Stage 3: Code Fixes Applied

1. **`src/services/planMetadataUtils.ts` line 37** — Changed `inferTopicFromPath(filePath: string)` to `inferTopicFromPath(filePath: string | undefined)`. The function already handled falsy input at line 38 (`if (!filePath) return '(untitled)'`), so this is a type-only fix that makes the signature match the runtime behavior.

2. **`src/services/TaskViewerProvider.ts` line 8827** — Added `|| s.toLowerCase() === 'untitled plan'` to `_isGenericTopic`. This ensures existing DB rows with `topic = 'Untitled Plan'` are recognized as generic and trigger the `inferTopicFromPath` recovery fallback, fixing the migration path for existing data.

3. **Recompiled** — Ran `npx tsc -p tsconfig.test.json` to update the `out/` directory with the new code. The stale compiled output that still had `'Untitled Plan'` fallback is now replaced.

### Stage 4: Verification Results

**TypeScript check (post-fix):**
```
npx tsc -p tsconfig.test.json --noEmit → 0 errors (clean compilation)
```

**Mocha test run (post-recompile, against fresh compiled output):**
```
  planMetadataUtils
    sanitizeTags
      ✔ returns empty string for empty input
      ✔ returns empty string for "none"
      ✔ filters out invalid tags
      ✔ normalizes case
    parsePlanMetadata
      ✔ extracts basic metadata correctly
      ✔ prefers Manual Complexity Override
      ✔ handles missing metadata gracefully
      ✔ derives topic from filename when no topic or H1
    inferTopicFromPath
      ✔ strips common prefixes
      ✔ converts underscores and hyphens to spaces with title casing
      ✔ strips leading hex hashes
      ✔ handles hash-only filenames
      ✔ handles empty or undefined input

  13 passing (14ms)
```

All 13 tests pass, including the new `inferTopicFromPath` test suite and the updated `derives topic from filename when no topic or H1` test.

### Remaining Risks

1. **Existing DB migration** — Even after adding `'Untitled Plan'` to `_isGenericTopic`, existing DB rows won't be updated until the recovery code path runs for those plans. There's no proactive migration that updates all existing `'Untitled Plan'` topics in the DB. The KanbanProvider's `row.topic || row.planFile || 'Untitled'` fallback chain will still show `'Untitled Plan'` for existing rows until they're recovered or re-parsed.
2. **Hash-without-underscore edge case** (deferred) — Filenames like `abc123...def_myplan.md` work correctly, but `abc123...defmyplan.md` (no separator) would not strip the hash prefix. Extremely unlikely in practice.
3. **`createDraftPlanTicket` roundabout flow** (deferred) — New draft plans still create content with `# Untitled Plan` H1, which `parsePlanMetadata` will extract as the topic, which review.html will then detect as default and fall back to filename. This works but is unnecessarily indirect.
