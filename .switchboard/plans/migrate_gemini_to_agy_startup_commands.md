# Plan: Migrate Gemini CLI to Antigravity CLI (agy) in Startup Commands

## Goal
Update all placeholder startup command examples and the CLI agent detection regex to reference `agy` (Antigravity CLI) instead of `gemini`, ensuring both UI display and terminal detection logic reflect the migration.

## Context
Google is sunsetting Gemini CLI for individual users on June 18, 2026, and replacing it with Antigravity CLI (binary name: `agy`). This plan updates the placeholder startup command examples in the Switchboard UI to reflect this migration, and adds `agy` to the CLI agent detection regex so that Antigravity terminals are properly recognized.

## Metadata
- **Tags:** [frontend, UX]
- **Complexity:** 2

## User Review Required
- Confirm that `--approval-mode auto_edit` is a valid flag for `agy` (assumed compatible based on migration research; if not, placeholder text should be updated accordingly).
- Confirm whether IDE config entries in `extension.ts` (key: `gemini`, name: "Gemini CLI", path: `.gemini`) should also be renamed in a follow-up plan.

## Complexity Audit

### Routine
- Replacing `gemini` with `agy` in 8 HTML placeholder attributes (5 in kanban.html, 3 in implementation.html)
- Adding `agy` to the CLI agent detection regex in terminalUtils.ts
- Updating the corresponding test assertion for the regex pattern

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — all changes are static text/regex with no runtime state.
- **Security:** No security implications — placeholder text and terminal name detection only.
- **Side Effects:** If `agy` is added to the detection regex but the binary isn't installed, no harm — the regex only matches terminal names, not binary availability.
- **Dependencies & Conflicts:** The `review-comment-transport-regression.test.js` test asserts the exact regex pattern in `terminalUtils.ts`. Updating the regex without updating the test will cause a test failure.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The `terminalUtils.ts` CLI detection regex omits `agy`, causing Antigravity terminals to bypass clipboard-paste delivery and potentially truncate long prompts. (2) The `--approval-mode auto_edit` flag compatibility with `agy` is assumed but unverified. Mitigations: Add `agy` to the regex (functional necessity); flag compatibility noted as user-review item.

## Objective
Update all placeholder startup command examples that reference `gemini` to use `agy` instead, and add `agy` to the CLI agent detection regex, ensuring users see the correct recommended command and Antigravity terminals are properly detected.

## Files to Change

### 1. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Line 2020** - Planner agent:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

**Line 2024** - Coder agent:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

**Line 2028** - Reviewer agent:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

**Line 2034** - Ticket Updater agent:
- Current: `placeholder="e.g. gemini"`
- Change to: `placeholder="e.g. agy"`

**Line 2038** - Research Planner agent:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

### 2. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

**Line 1733**:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

**Line 1745**:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

**Line 1757**:
- Current: `placeholder="e.g. gemini --approval-mode auto_edit"`
- Change to: `placeholder="e.g. agy --approval-mode auto_edit"`

### 3. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/terminalUtils.ts`

**Line 73** - CLI agent detection regex:
- Current: `const isCliAgent = /\b(copilot|gemini|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);`
- Change to: `const isCliAgent = /\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);`
- **Rationale:** Without `agy` in this regex, Antigravity CLI terminals won't be detected as CLI agents, causing the `sendRobustText` function to skip clipboard-paste delivery for long payloads. This can silently truncate input. Note: `gemini` is kept in the regex for backward compatibility with users who haven't migrated yet.

### 4. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/test/review-comment-transport-regression.test.js`

**Line 114** - Test assertion for the regex pattern:
- Current: `/const\s+isCliAgent\s*=\s*\/\\b\(copilot\|gemini\|claude\|windsurf\|cursor\|cortex\)\\b\/i\.test\(terminal\.name\);/`
- Change to: `/const\s+isCliAgent\s*=\s*\/\\b\(copilot\|gemini\|agy\|claude\|windsurf\|cursor\|cortex\)\\b\/i\.test\(terminal\.name\);/`
- **Rationale:** This test asserts the exact regex pattern. It must be updated to match the new pattern including `agy`.

## Implementation Steps

1. Update kanban.html placeholders (5 changes)
2. Update implementation.html placeholders (3 changes)
3. Add `agy` to the CLI agent detection regex in terminalUtils.ts (1 change)
4. Update the test assertion in review-comment-transport-regression.test.js (1 change)
5. Verify no other gemini references in startup command contexts
6. Run tests to ensure no regressions
7. Test UI to ensure placeholders display correctly

## Notes

- These are placeholder examples only - they don't affect actual stored startup commands
- Users who have already configured startup commands will need to manually update them
- The `--approval-mode auto_edit` flag should remain the same as it's compatible with both Gemini CLI and Antigravity CLI (Clarification: assumed compatible based on migration research; user review recommended)
- This change aligns with Google's official migration from Gemini CLI to Antigravity CLI
- `gemini` is intentionally kept in the `terminalUtils.ts` regex for backward compatibility with users who haven't migrated yet

## Related Context

From the migration research:
- Antigravity CLI binary name is `agy` (not `antigravity`)
- One-command migration available: `agy plugin import gemini`
- Enterprise users retain access to Gemini CLI, but these placeholders should still reflect the new default for individual users

## Out of Scope (Potential Follow-Up Plans)

- Renaming IDE config entries in `extension.ts` (key: `gemini`, name: "Gemini CLI", path: `.gemini`) — these reference the config directory structure, not the binary name
- Updating `.gemini/antigravity/` filesystem path references throughout the codebase — these are directory paths, not CLI binary names
- Updating `send-message-guards.test.js` references to `interface: 'gemini'` — these test MCP interface routing, not startup commands

## Verification Plan

### Automated Tests
- Run `review-comment-transport-regression.test.js` to verify the updated regex assertion passes
- Run full test suite to confirm no regressions from the placeholder text changes
- Manual: Open Switchboard UI, verify that Planner, Coder, Reviewer, Ticket Updater, and Research Planner fields show `agy` placeholders instead of `gemini`

## Recommendation
**Send to Intern** — Complexity 2: trivial text replacements in HTML placeholders plus one regex addition with its corresponding test update. All changes are localized, low-risk, and follow existing patterns.

---

## Review Pass (Grumpy Principal Engineer → Balanced Synthesis)

### Stage 1: Adversarial Findings

| # | Finding | Severity | Detail |
|---|---------|----------|--------|
| 1 | Unrelated refactoring mixed into terminalUtils.ts diff | NIT | `pasteTextViaClipboard()` extracted as named function + timing constants `PRE_PASTE_SETTLE_MS`/`POST_PASTE_SETTLE_MS` added. Functionally identical to inlined code. Not part of this plan but benign. |
| 2 | JSDoc comment changed on `sendRobustText` | NIT | "Shared by InboxWatcher..." → "Used by TaskViewerProvider...". Unrelated doc change, harmless. |
| 3 | All 8 HTML placeholders correctly updated | — | kanban.html: 5/5 (lines 2020, 2024, 2028, 2034, 2038). implementation.html: 3/3 (lines 1733, 1745, 1757). All `gemini` → `agy`. |
| 4 | Regex correctly updated with backward compat | — | `agy` added, `gemini` retained. Pattern: `/\b(copilot\|gemini\|agy\|claude\|windsurf\|cursor\|cortex)\b/i` |
| 5 | Test assertion correctly updated | — | `review-comment-transport-regression.test.js` line 114 includes `agy`. |
| 6 | No stray `gemini` in placeholder contexts | — | Searched `src/` for `placeholder.*gemini` and `e.g.\s*gemini` — zero hits. All remaining `gemini` refs are filesystem paths, IDE config entries, or MCP routing — all Out of Scope per plan. |
| 7 | No other tests assert the CLI detection regex | — | Only `review-comment-transport-regression.test.js` asserts the pattern. No other test files need updating. |

### Stage 2: Balanced Synthesis

- **No CRITICAL or MAJOR findings.** Implementation matches the plan exactly for all 4 target files.
- **NITs kept as-is:** The unrelated refactoring in `terminalUtils.ts` is benign (functionally identical extraction) and not worth reverting. Noted for diff traceability only.
- **All plan requirements verified:** 8/8 HTML placeholders, regex update, test update, no stray references.

### Stage 3: Code Fixes Applied

None required — no CRITICAL or MAJOR findings.

### Stage 4: Verification Results

| Check | Result |
|-------|--------|
| `review-comment-transport-regression.test.js` | **3/3 PASS** |
| `plan-ingestion-target-regression.test.js` | **PASS** |
| No `gemini` in placeholder contexts (`placeholder.*gemini`) | **0 hits — Confirmed** |
| `agy` in all 8 placeholder fields | **8/8 Confirmed** (5 kanban + 3 implementation) |
| `agy` in CLI detection regex (terminalUtils.ts:73) | **Confirmed** |
| `gemini` retained in regex for backward compat | **Confirmed** |
| TypeScript compilation | Pre-existing errors in ClickUpSyncService.ts and KanbanProvider.ts (unrelated) |
| Other test suite failures | Pre-existing, unrelated to this plan |

### Files Changed (by this plan's implementation)

- `src/webview/kanban.html` — 5 placeholder updates (gemini → agy)
- `src/webview/implementation.html` — 3 placeholder updates (gemini → agy)
- `src/services/terminalUtils.ts` — `agy` added to CLI detection regex + unrelated benign refactor (pasteTextViaClipboard extraction)
- `src/test/review-comment-transport-regression.test.js` — regex assertion updated to include `agy`

### Remaining Risks

- **Unverified flag compatibility:** `--approval-mode auto_edit` with `agy` is assumed but not confirmed (noted in User Review Required). If incompatible, placeholder text needs a follow-up update.
- **IDE config entries still reference `gemini`:** extension.ts key/name/path entries remain as `gemini` — explicitly Out of Scope but may confuse users who see `agy` in placeholders but `Gemini CLI` in IDE config UI.
- **Unrelated diff pollution:** The `terminalUtils.ts` refactoring (pasteTextViaClipboard extraction) is in the same diff. Not harmful but reduces signal-to-noise for this plan's changes.
