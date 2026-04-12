# Fix Terminal Operations Periodic Reopen

## Goal
Remove the periodic retry timer that causes the Terminal Operations panel to repeatedly auto-expand when no agents are assigned, while preserving the initial auto-expand behavior on plugin startup. The panel should auto-open once when the plugin starts (as it contains main controls users need), but should not periodically reopen if the user has closed it during the session.

## Metadata
**Tags:** frontend, bugfix
**Complexity:** 3

## User Review Required
> [!NOTE]
> This fix respects the user's manual collapse preference within the current session. The panel will still auto-open on plugin startup (first load), but once the user manually collapses it, it will not auto-expand again during that session. The collapse preference is session-scoped (in-memory) and resets on webview reload; that is intentional to keep the change minimal.

## Complexity Audit
### Routine
- Remove the retry scheduling branch inside `renderAgentList()` in `src/webview/implementation.html` so the no-agent state returns cleanly instead of queuing another render.
- Keep the initial auto-expand behavior that runs only after no agents are detected for more than `RECOVERY_THRESHOLD_MS` on first load.
- Keep the `hasManuallyCollapsedThisSession` guard so user-driven collapses are respected after the first auto-open.
- Add a focused regression test in `src/test/terminal-operations-no-periodic-reopen.test.js` that proves the retry timer is gone and the onboarding branch still exists.

### Complex / Risky
- Ensure the no-agent onboarding branch still preserves the existing startup messages (`getStartupCommands`, `getVisibleAgents`, `getCustomAgents`, `getJulesAutoSyncSetting`) exactly once when the panel auto-opens.
- Keep the edit isolated to the Terminal Operations accordion logic so adjacent webview work does not accidentally rename selectors or change the open/close contract.
- Clarification: the manual-collapse preference remains in-memory only; do not introduce persistence or sessionStorage in this fix.

## Edge-Case & Dependency Audit
- **Race Conditions:** The old retry loop could re-trigger `renderAgentList()` after the user had already collapsed the panel; removing it eliminates that repeated scheduling. Existing render triggers still happen through message updates and state changes, so there is no new concurrency model to manage.
- **Security:** No credential, filesystem, or IPC surface changes.
- **Side Effects:** The panel will no longer periodically reopen after the first onboarding detection. It will still auto-open on startup when the no-agent condition persists for the grace period, and it will still stay collapsed if the user manually collapses it during the session.
- **Dependencies & Conflicts:** `get_kanban_state` shows no active plans in **New**. In **Planned**, the relevant overlaps are:
  - `Move Open Setup Button in Terminal Operations` — likely touches the same `src/webview/implementation.html` accordion region, so coordinate DOM/class-name edits and keep `terminal-operations-fields` stable.
  - `Cleanup: Remove Central Setup Panel Header` — adjacent webview UI work that may share layout helpers and accordion assumptions.
  - `Fix: Team Lead Should Not Be Active by Default and Should Be Moved to Dedicated Accordion` — nearby accordion behavior that may change shared open/close helpers.
  - `Bug: ClickUp Setup Button Throws API Key Error Instead of Prompting for Token` — nearby setup-panel work that could alter the same section of the webview markup.
  - None of the planned items are direct dependencies for this timer fix; the risk is merge overlap, not behavioral coupling.

## Adversarial Synthesis
### Grumpy Critique
> Oh, brilliant: a “temporary” retry loop that keeps resurrecting Terminal Operations like a stubborn zombie every time the panel dares to be closed. The bug is tiny, but the behavior is obnoxious because it undermines the one user choice that matters: collapsing the panel and leaving it collapsed.  
>
> But don’t get cocky and assume “remove one timeout” is the whole story. If you gut the grace-period gate, you break the startup onboarding. If you forget the manual-collapse guard, the panel will still reopen and the fix becomes theater. If you touch the surrounding accordion markup carelessly, you’ll create needless conflicts with the other Terminal Operations plans and spend time untangling DOM churn instead of shipping a bugfix.  
>
> The regression test also needs to prove something real. A vague “source exists” check is worthless unless it specifically proves the retry scheduler is gone while the onboarding branch and manual-collapse guard remain intact.

### Balanced Response
This is still a surgical fix: remove only the retry scheduling path inside `src/webview/implementation.html`, keep the startup grace-period branch intact, and preserve `hasManuallyCollapsedThisSession` so the user’s collapse preference continues to win for the rest of the session. The regression test should read the source and assert the exact timer pattern is absent while the onboarding guard and auto-open messaging remain present. That keeps the scope narrow, protects the intended startup behavior, and reduces the chance of regressions during adjacent accordion work.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep this change narrow. The only production file change should be the onboarding guard in `src/webview/implementation.html`; the test file should assert the behavior does not regress.

### 1. Remove Periodic Retry Timer
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The onboarding guard around the Terminal Operations section currently uses `_onboardingRetryTimer` to reschedule `renderAgentList()` while no agents are connected. That retry loop is what causes the panel to reopen repeatedly during the session.
- **Logic:**
  1. Leave the `greenCount > 0` branch intact so connected agents still reset `noAgentsDetectionTime`, clear any pending timer handle, and fall through to normal rendering.
  2. In the `greenCount === 0` branch, keep the `noAgentsDetectionTime` initialization and the `elapsed` calculation unchanged.
  3. Replace the current “schedule follow-up and bail out early” behavior with a plain `return` while `elapsed < RECOVERY_THRESHOLD_MS`; the grace period should only suppress rendering, not schedule a new render.
  4. Once `elapsed >= RECOVERY_THRESHOLD_MS`, render the onboarding state exactly once and keep the existing `if (!hasManuallyCollapsedThisSession)` auto-open block unchanged.
  5. Remove any remaining use of `_onboardingRetryTimer` from this onboarding branch so there is no periodic retry path left.
  6. Clarification: do not add any new persistence or sessionStorage logic; the manual-collapse preference remains in-memory only.
- **Implementation:**
```javascript
if (elapsed < RECOVERY_THRESHOLD_MS) {
    // Still within grace period — keep the current display unchanged and do not reschedule.
    return;
}
// Grace period expired — render onboarding state once
```
- **Edge Cases Handled:** This keeps the initial startup auto-open intact, prevents repeated reopen behavior after the user collapses the panel, and still allows the normal connected-agents render path to function when agents come back online.

### 2. Add Regression Coverage
#### [CREATE] `src/test/terminal-operations-no-periodic-reopen.test.js`
- **Context:** There is no focused regression test that proves the onboarding guard no longer schedules periodic reopen attempts.
- **Logic:**
  1. Read `src/webview/implementation.html` from disk with `fs.readFileSync`.
  2. Assert that `_onboardingRetryTimer = setTimeout(() => renderAgentList()` is no longer present.
  3. Assert that `if (elapsed < RECOVERY_THRESHOLD_MS)` still exists so the grace-period gate remains.
  4. Assert that `hasManuallyCollapsedThisSession` still exists so manual collapse behavior is preserved.
  5. Assert that the terminal-operations auto-open branch still contains the `toFields.classList.add('open')` path and the `getStartupCommands` / `getVisibleAgents` messages.
  6. Keep the test as a simple Node script so it can run without a browser harness.
- **Implementation:**
```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const implementationSource = fs.readFileSync(implementationPath, 'utf8');

    // Assert retry timer is removed
    assert.doesNotMatch(
        implementationSource,
        /_onboardingRetryTimer = setTimeout\(\(\) => renderAgentList\(\)/,
        "Expected retry timer scheduling to be removed from onboarding guard."
    );

    // Assert grace period check is still present
    assert.match(
        implementationSource,
        /if \(elapsed < RECOVERY_THRESHOLD_MS\) \{[\s\S]*return;[\s\S]*\}/,
        "Expected grace period check to still be present."
    );

    // Assert auto-expand logic is still present
    assert.match(
        implementationSource,
        /if \(!hasManuallyCollapsedThisSession\) \{[\s\S]*toFields\.classList\.add\('open'\)/,
        "Expected auto-expand logic to still be present."
    );

    // Assert hasManuallyCollapsedThisSession flag is still present
    assert.match(
        implementationSource,
        /let hasManuallyCollapsedThisSession = false;/,
        "Expected hasManuallyCollapsedThisSession flag to still be present."
    );

    console.log('terminal operations no periodic reopen test passed');
}

try {
    run();
} catch (error) {
    console.error('terminal operations no periodic reopen test failed:', error);
    process.exit(1);
}
```
- **Edge Cases Handled:** This protects the exact regression path without depending on UI timing, while still confirming the onboarding gate and manual-collapse logic remain in the file.

## Verification Plan
### Automated Tests
- Run `node src/test/terminal-operations-no-periodic-reopen.test.js`.

### Manual Checks
- Open Switchboard with no agents assigned; confirm Terminal Operations auto-expands on startup.
- Manually collapse Terminal Operations; confirm it does not auto-expand again during the session.
- Reload the webview; confirm Terminal Operations auto-expands again on startup (session-scoped preference).
- Assign an agent and then remove it; confirm Terminal Operations does not periodically reopen after the initial onboarding detection.

## Agent Recommendation
Send to Coder

## Reviewer-Executor Pass Results

### Fixed Items
- Confirmed the onboarding guard in `src/webview/implementation.html` no longer schedules periodic retry renders in the no-agent grace-period path.
- Confirmed the one-time startup auto-open branch still posts `getStartupCommands`, `getVisibleAgents`, `getCustomAgents`, and `getJulesAutoSyncSetting` exactly once when it opens.
- Confirmed the in-memory `hasManuallyCollapsedThisSession` guard remains in place so manual collapse still wins for the rest of the session.

### Files Changed
- `.switchboard/plans/fix_terminal_operations_periodic_reopen.md`

### Validation Results
- `node src/test/terminal-operations-no-periodic-reopen.test.js` ✅
- `npm run compile` ✅
- `npx tsc --noEmit` ⚠️ pre-existing `src/services/KanbanProvider.ts:2405` dynamic import extension complaint (`./ArchiveManager`)

### Remaining Risks
- The regression test is source-based, so it verifies the structure of the onboarding branch rather than exercising the UI timing path directly.
- The session-scoped collapse preference is intentionally in-memory only, so a webview reload still resets the auto-open behavior.

### Unresolved Issues
- None caused by this pass.
