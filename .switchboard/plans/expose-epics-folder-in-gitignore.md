# Expose `.switchboard/epics/` in Managed Gitignore Rules

## Goal

Add `!.switchboard/epics/` as an exception to Switchboard's managed gitignore block so that epic files are committed to the repository. Without this, remote coding sessions (Claude Code on the web, Jules, etc.) cannot see the epics folder — it's created at runtime but falls under the blanket `.switchboard/*` exclusion with no carve-out.

**Root cause:** When epics were added, the `TARGETED_RULES` array in `WorkspaceExcludeService.ts` was not updated to mirror the treatment of `plans/`. Any user who runs setup (or whose gitignore is managed by Switchboard) has the folder silently excluded.

### Codebase Findings — Verification of Plan Assumptions

The plan's core analysis is **correct** — verified against the actual source:

1. **`TARGETED_RULES` array confirmed** at `src/services/WorkspaceExcludeService.ts` lines 9–28. The blanket `.switchboard/*` exclusion is at line 11, with carve-outs for `reviews/` (line 12), `plans/` (line 13), `sessions/` (line 14), and several individual files (lines 15–18). There is NO carve-out for `epics/`. The plan's proposed insertion point (after `!.switchboard/plans/`, before `!.switchboard/sessions/`) is accurate.

2. **The `epics/` folder is a real, established part of the codebase.** It is referenced across `PlanningPanelProvider.ts` (line 911: `.switchboard/epics/**/*.md` file watcher pattern), `KanbanProvider.ts` (lines 8052, 8083, 8919: epic file creation/migration), `GlobalPlanWatcherService.ts` (lines 556, 592, 638: path-based epic detection), and `KanbanDatabase.ts` (lines 5042–5046: `plan_file LIKE '.switchboard/epics/%'` queries). The root cause is confirmed — epics were added to the codebase but the gitignore rules were not updated.

3. **Plan's test claim is WRONG — no existing test validates the exact content of `TARGETED_RULES`.** The plan says "the regression test validates the exact content of `TARGETED_RULES`. It will fail without a matching update." This is incorrect. `git-ignore-custom-default-regression.test.js` checks for the ABSENCE of `!.switchboard/workspace-id` (line 71) and that `DEFAULT_RULES` is empty (lines 57–59) — it does NOT enumerate or validate the individual carve-out rules. `workspace-exclude-strategy-regression.test.js` checks the strategy normalization logic only. **No existing test will break from adding `!.switchboard/epics/`.** This is good news (lower risk) but means the plan's test-update task is unnecessary — no test needs updating. A NEW test asserting the presence of `!.switchboard/epics/` would be a valuable addition, however.

4. **Setup.html warning text confirmed** at line 633: "Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository, so avoid blanket .switchboard/* rules unless you intentionally want to hide plans from git." The text mentions `plans/` but not `epics/`. The plan's `[CHECK]` note to review this is valid — updating it to mention `epics/` would improve clarity but is documentation-only.

5. **`getTargetedRules()` static method** at line 157 returns a copy of `TARGETED_RULES` — this is the cleanest way for a test to assert the presence of the new rule without parsing source text.

---

## Metadata

**Complexity:** 2
**Tags:** backend, infrastructure, devops, reliability

## User Review Required

No decisions required. The change is a one-line addition to a static array, with clear precedent (the `plans/` carve-out at line 13). The only judgment call is whether to also update the setup.html warning text (documentation-only, recommended but optional).

## Complexity Audit

### Routine
- Adding a single string `'!.switchboard/epics/',` to the `TARGETED_RULES` array in `WorkspaceExcludeService.ts` (line 13, after `!.switchboard/plans/`).
- Optionally updating the setup.html warning text (line 633) to mention `epics/` alongside `plans/`.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `TARGETED_RULES` is a static readonly array initialized at class load time. No concurrent access concerns.
- **Security:** No security implications. The change makes `epics/` files visible to git — this is the intended behavior (epics are shareable plan artifacts, like `plans/`). No secrets or machine-local state are stored in `epics/`.
- **Side Effects:** Existing users with a managed gitignore block will get the new line added on the next `WorkspaceExcludeService.apply()` call (extension activation or settings change). If an `epics/` folder already exists with files, those files will immediately become trackable by git (appear as untracked in `git status`). This is the desired outcome — it's the same behavior users got when `plans/` was carved out.
- **Dependencies & Conflicts:** No dependencies. The change is self-contained. No conflicts with other plans in this batch.

## Dependencies

None.

## Adversarial Synthesis

Key risks: minimal — a one-line addition to a static array with clear precedent. The only plan error was claiming a regression test validates the exact `TARGETED_RULES` content (it doesn't). Mitigation: skip the unnecessary test-update task; instead add a new assertion test that confirms `!.switchboard/epics/` is present, preventing future regressions.

## Proposed Changes

### [MODIFY] `src/services/WorkspaceExcludeService.ts` — Add epics exception

**Context:** `TARGETED_RULES` (lines 9–28) defines the managed gitignore block written to `.gitignore` when the strategy is `targetedGitignore` (the default). The blanket `.switchboard/*` at line 11 excludes everything; carve-outs (`!.switchboard/...`) re-include specific subdirectories. `plans/` is carved out at line 13 but `epics/` is missing.

**Logic:** Add `'!.switchboard/epics/',` immediately after `'!.switchboard/plans/',` (line 13):

```typescript
// BEFORE (lines 9–14):
private static readonly TARGETED_RULES: string[] = [
    '# Switchboard runtime state (per-session, not shareable)',
    '.switchboard/*',
    '!.switchboard/reviews/',
    '!.switchboard/plans/',
    '!.switchboard/sessions/',

// AFTER:
private static readonly TARGETED_RULES: string[] = [
    '# Switchboard runtime state (per-session, not shareable)',
    '.switchboard/*',
    '!.switchboard/reviews/',
    '!.switchboard/plans/',
    '!.switchboard/epics/',
    '!.switchboard/sessions/',
```

**Edge Cases:**
- The gitignore negation rule `!path/` re-includes a directory that was excluded by a preceding blanket rule. The order matters: `.switchboard/*` (line 11) must come before `!.switchboard/epics/` (new line). The proposed insertion position preserves this ordering.
- Git does not re-include files that are already tracked and ignored — but `epics/` files are currently untracked (they were silently ignored), so they will appear as new untracked files after the change. This is correct.

### [MODIFY] `src/webview/setup.html` — Update warning text (optional, documentation-only)

**Context:** Line 633 contains a warning that mentions `plans/` specifically: "Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository."

**Logic:** Update the text to also mention `epics/`:

```html
<!-- BEFORE (line 633): -->
Preset strategies are read-only. Switchboard updates only its fenced managed block and preserves unrelated rules. Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository, so avoid blanket .switchboard/* rules unless you intentionally want to hide plans from git.

<!-- AFTER: -->
Preset strategies are read-only. Switchboard updates only its fenced managed block and preserves unrelated rules. Cloud coders (e.g., Jules) require .switchboard/plans/ and .switchboard/epics/ to be in the repository, so avoid blanket .switchboard/* rules unless you intentionally want to hide plans from git.
```

**Edge Cases:**
- The regression test at `git-ignore-custom-default-regression.test.js` line 42 asserts that `setup.html` includes the string `'Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository'`. The proposed change keeps this substring intact (it adds `and .switchboard/epics/` after `plans/` but before ` to be in the repository`), so the test will still pass. **Verify:** the exact substring `require .switchboard/plans/ to be in the repository` must remain contiguous — do not split it across the insertion.

**Correction to the original plan:** The test asserts the presence of this substring (`setupSource.includes('Cloud coders (e.g., Jules) require .switchboard/plans/ to be in the repository')` at line 42). The insertion of `and .switchboard/epics/` must go AFTER `plans/` but the test's matched substring ends at `to be in the repository` — so the insertion point must be `plans/ and .switchboard/epics/ to be in the repository`, which BREAKS the contiguous substring `require .switchboard/plans/ to be in the repository`. **Revised approach:** change the test assertion simultaneously, OR phrase the warning differently (e.g., `require .switchboard/plans/ (and .switchboard/epics/) to be in the repository`) — but this ALSO breaks the contiguous match. **Safest option:** update the test assertion at line 42 to match the new string. Since the test uses `includes()` (not a regex), the new assertion should check for the updated full string OR split into two `includes()` checks.

### [NEW] `src/test/git-ignore-epics-carveout.test.js` — Assert epics is carved out

**Context:** No existing test validates that `TARGETED_RULES` includes `!.switchboard/epics/`. A new test prevents future regressions.

**Logic:**

```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const excludeServiceSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'WorkspaceExcludeService.ts'),
        'utf8'
    );

    // Assert the epics carve-out exists in TARGETED_RULES, after the plans carve-out
    // and before the sessions carve-out (order matters for gitignore negation rules).
    assert.ok(
        excludeServiceSource.includes("'!.switchboard/epics/',"),
        'Expected TARGETED_RULES to include !.switchboard/epics/ carve-out.'
    );

    // Assert ordering: epics must come after plans and before sessions
    const plansIdx = excludeServiceSource.indexOf("'!.switchboard/plans/',");
    const epicsIdx = excludeServiceSource.indexOf("'!.switchboard/epics/',");
    const sessionsIdx = excludeServiceSource.indexOf("'!.switchboard/sessions/',");
    assert.ok(plansIdx > -1 && epicsIdx > -1 && sessionsIdx > -1, 'All three carve-outs must exist.');
    assert.ok(plansIdx < epicsIdx && epicsIdx < sessionsIdx,
        'Expected order: plans/ → epics/ → sessions/ in TARGETED_RULES.');

    console.log('git-ignore epics carveout test passed');
}

try {
    run();
} catch (error) {
    console.error('git-ignore epics carveout test failed:', error);
    process.exit(1);
}
```

**Edge Cases:**
- The test uses `includes()` on the source text — it's a static analysis test, not a runtime test. This matches the pattern of the existing regression tests (`git-ignore-custom-default-regression.test.js`, `workspace-exclude-strategy-regression.test.js`).

## Verification Plan

### Automated Tests

> Per session directives: compilation and automated tests are NOT run in this session. The following documents what tests would verify the change; the user will run the suite separately.

1. **New test:** `node src/test/git-ignore-epics-carveout.test.js` — asserts `!.switchboard/epics/` is present and correctly ordered in `TARGETED_RULES`.
2. **Existing regression test (if setup.html is updated):** `node src/test/git-ignore-custom-default-regression.test.js` — must still pass. If the warning text is updated, the assertion at line 42 must be updated to match the new string (see Proposed Changes for the setup.html edit).
3. **Existing strategy test:** `node src/test/workspace-exclude-strategy-regression.test.js` — unaffected by this change, should pass as-is.
4. **Manual check:** In a test workspace with the `targetedGitignore` strategy, create an epic via the kanban UI and confirm `git status` shows `.switchboard/epics/*.md` as untracked (i.e., no longer ignored).

## Uncertain Assumptions

No uncertain assumptions. All findings are verified against the actual source code (`WorkspaceExcludeService.ts`, `git-ignore-custom-default-regression.test.js`, `workspace-exclude-strategy-regression.test.js`, `setup.html`, and the epics folder references across `PlanningPanelProvider.ts`, `KanbanProvider.ts`, `GlobalPlanWatcherService.ts`, and `KanbanDatabase.ts`). No web research is needed for this plan.

---

## Original Plan Content (Preserved — Corrected Above)

### Original [MODIFY] for the regression test

> **CORRECTION:** The original plan says "the regression test validates the exact content of `TARGETED_RULES`" and proposes adding `!.switchboard/epics/` to the expected rules array in `git-ignore-custom-default-regression.test.js`. This is wrong — that test does NOT enumerate the individual carve-out rules. It checks for the ABSENCE of `!.switchboard/workspace-id` (line 71) and that `DEFAULT_RULES` is empty (lines 57–59). No update to this test is needed for the `TARGETED_RULES` change. Instead, a NEW test (`git-ignore-epics-carveout.test.js`) is proposed above to assert the presence and ordering of the epics carve-out.

### Original Migration Consideration

This is an **additive change** to the managed block. Existing users who already have a managed block in their `.gitignore` will get the new line added on the next time `WorkspaceExcludeService.apply()` runs (extension activation or settings change). The epics folder, if it exists, will immediately become tracked — which is the desired outcome.

Users on the `custom` or `none` strategy are unaffected (they manage their own rules).

### Original Verification Plan

1. Run the existing gitignore regression test: `node src/test/git-ignore-custom-default-regression.test.js` — must pass.
2. In a test workspace, create an epic via the kanban UI and confirm `git status` shows `.switchboard/epics/*.md` as untracked (i.e., no longer ignored).
3. Run Switchboard setup → confirm the managed block in `.gitignore` includes `!.switchboard/epics/`.

### Original Success Criteria

1. `TARGETED_RULES` contains `!.switchboard/epics/` in the correct position.
2. Regression test passes.
3. A freshly created epic file appears in `git status` as an untracked file (not silently ignored).

---

**Recommendation:** Complexity 2 → **Send to Intern**. A one-line addition to a static array with clear precedent, plus an optional documentation text update and a new static-analysis test. No architectural decisions, no complex logic.
