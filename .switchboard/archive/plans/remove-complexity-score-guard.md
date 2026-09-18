# Remove Complexity Score Guard for Plan Advancement

## Goal
Change the default value of `kanban.allowUnknownComplexityAutoMove` from `false` to `true` so that plans without complexity scores can advance through the kanban workflow when using copy prompt buttons, without requiring users to manually score every plan first.

## Metadata
- **Tags:** [workflow, reliability]
- **Complexity:** 2

## User Review Required
- Confirm that unscored plans routing to "lead" (the existing fallback in `scoreToRoutingRole`) is acceptable behavior when the guard is removed.

## Complexity Audit

### Routine
- Changing a boolean default parameter from `false` to `true` at two call sites in `KanbanProvider.ts`
- Changing a boolean default from `false` to `true` in the webview JS initialization in `kanban.html`
- No logic changes, no new code paths, no data migration

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The setting is read at construction time and on settings reload; both paths use the same default parameter.
- **Security:** No security implications. This is a UX preference, not an authorization gate.
- **Side Effects:** Plans without complexity scores will now route to the "lead" column by default (via `scoreToRoutingRole(0)` → `'lead'`). This is the pre-existing fallback behavior — the change simply removes the gate that prevented unscored plans from reaching routing logic at all.
- **Dependencies & Conflicts:** Existing users who have already toggled this setting (on or off) have a persisted value in `globalState`/`workspaceState` that takes precedence over the default. The default change only affects fresh installations or users who never touched the toggle. No migration needed.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The webview JS default in `kanban.html` must also be updated to `true` to avoid a brief flash of the wrong toggle state on panel load. (2) Existing users with persisted settings are unaffected — only new installs see the new default, which should be documented for QA. Mitigations: Both are addressed in the proposed changes below; no migration is required.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** The `_allowUnknownComplexityAutoMove` field controls whether `_filterUnknownComplexitySessions` filters out plans with unknown/unscored complexity. When `true`, all plans pass through; when `false`, unscored plans are skipped and a notification is shown.
- **Logic:** Change the default parameter value from `false` to `true` at both initialization sites.
- **Implementation:**
  - **Line 253** (constructor): Change `this._getSetting<boolean>('kanban.allowUnknownComplexityAutoMove', false)` → `this._getSetting<boolean>('kanban.allowUnknownComplexityAutoMove', true)`
  - **Line 321** (`_reloadSettingsFromStore`): Change `this._getSetting<boolean>('kanban.allowUnknownComplexityAutoMove', false)` → `this._getSetting<boolean>('kanban.allowUnknownComplexityAutoMove', true)`
- **Edge Cases:** The `_getSetting` method reads persisted state first; the default is only used when no value is persisted. Existing users with explicit settings are unaffected.

### `src/webview/kanban.html`
- **Context:** The webview JS initializes `allowUnknownComplexityAutoMove` to `false` as a transient default before the provider syncs the real value via `allowUnknownComplexityAutoMoveState` message.
- **Logic:** Change the initial value to `true` so the toggle UI matches the new default on first render, avoiding a visual flash of the wrong state.
- **Implementation:**
  - **Line 3029**: Change `let allowUnknownComplexityAutoMove = false;` → `let allowUnknownComplexityAutoMove = true;`
- **Edge Cases:** The provider immediately sends the real value on panel init, so this only affects the brief moment before that message arrives.

## Verification Plan

### Automated Tests
- N/A — this is a default-value change with no new logic paths. The existing `_filterUnknownComplexitySessions` unit tests (if any) should still pass since the method's logic is unchanged; only the default input differs.

### Manual Verification
1. On a fresh workspace (no persisted settings), create a plan without a complexity score
2. Drag it to the "Planned" column
3. Click the "copy coder prompt" button
4. Verify the card advances to the next column without error
5. Verify the prompt is copied to clipboard
6. Open the kanban setup panel and verify the "Allow Unknown Complexity" toggle shows as enabled by default
7. On an existing workspace where the setting was previously toggled off, verify the persisted `false` value still takes precedence (no regression)

**Recommendation:** Send to Intern (Complexity 2)

## Review Pass — Completed

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| 1 | Stale `false` defaults in tracked temp files (`temp.js:441`, `previous_kanban.html:2833`, `temp_script.js:441`) | NIT | These are orphaned repo artifacts with zero production references. Not shipped, not imported. Noise for anyone grepping the codebase, but not a functional issue. |
| 2 | Plan file "Proposed Changes" section still shows `false → true` diff notation | NIT | Historical record of the change — standard practice, no confusion for careful readers. |

**No CRITICAL or MAJOR findings.**

### Stage 2: Balanced Synthesis

- **All three production sites verified correct:** `KanbanProvider.ts:253` (`true`), `KanbanProvider.ts:321` (`true`), `kanban.html:3029` (`true`).
- **`TaskViewerProvider.ts:543,571`** — migration key lists only (no default values). Correctly untouched.
- **`scoreToRoutingRole(0)` → `'lead'`** confirmed at `complexityScale.ts:64` with explicit comment "Unknown defaults to lead". Plan's edge-case analysis is accurate.
- **`kanban.html:5149`** — `msg.enabled !== false` correctly treats `undefined` as truthy, consistent with `true` default.
- **Stale temp files** — defer to repo cleanup pass; not this plan's scope.

### Verification Results

- **Grep audit:** Zero stale `false` defaults in production code (`src/`). Only `msg.enabled !== false` (correct truthy-coercion pattern) found.
- **Compilation:** Skipped per session instructions.
- **Tests:** Skipped per session instructions.

### Files Changed (by this review)

- None — implementation was already correct; no code fixes needed.

### Remaining Risks

- **Low:** Tracked temp files (`temp.js`, `previous_kanban.html`, `temp_script.js`) still contain `false` defaults. These are not production code but could mislead developers grepping the repo. Recommend `git rm` in a follow-up cleanup.
- **None functional:** The implementation exactly matches the plan with no deviations.
