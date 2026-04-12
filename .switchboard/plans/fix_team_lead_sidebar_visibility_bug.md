# Fix Team Lead Sidebar Visibility Bug

## Goal
Fix the false red Team Lead sidebar row **and** ensure Team Lead can actually be launched from `OPEN AGENT TERMINALS` when the user explicitly enables Team Lead and provides a non-empty Team Lead startup command. The sidebar should hide Team Lead when the role is unreachable in the current window, but it must not strand a correctly configured Team Lead behind a UI that can never launch it.

## Metadata
**Tags:** frontend, backend, UI, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> - Clarification: `OPEN AGENT TERMINALS` must include Team Lead when `visibleAgents['team-lead'] === true` **and** `startupCommands['team-lead']` is non-empty. The previous draft guidance to keep Team Lead out of `createAgentGrid` was incorrect and must not be followed.
> - Clarification: a blank Team Lead startup command should still prevent `OPEN AGENT TERMINALS` from creating a Team Lead terminal. This bugfix is about matching the launch path to explicit configuration, not about creating an empty shell for Team Lead.
> - Clarification: do not generalize this Team Lead rule to all built-in agents. Team Lead is special here because it is configured in the dedicated orchestration surface and is not part of the existing always-grid-created built-in agent list.
> - Clarification: if a Team Lead terminal is already registered or dispatch readiness already exposes a concrete Team Lead route, the sidebar row should remain visible even when the saved Team Lead command is blank. The bug is the false unreachable red row, not the existence of Team Lead as a dispatch role.

## Complexity Audit
### Routine
- Tighten the two cached `visibleAgents['team-lead']` persistence sites in `src/webview/implementation.html` from `!== false` to `=== true` so Team Lead stays opt-in when the sidebar re-saves visibility state.
- Add a Team Lead-specific sidebar visibility helper in `src/webview/implementation.html`.
- Replace the Team Lead checks in the onboarding “agents not connected” guard and the actual Team Lead row render path with the new helper.
- Update `src/extension.ts` so `createAgentGrid()` conditionally includes Team Lead when the role is enabled and has a non-empty startup command.
- Extend Team Lead regression coverage so it verifies both the sidebar rule and the corrected `createAgentGrid` launch rule.

### Complex / Risky
- **Sidebar rule and launch rule must agree:** if the sidebar hides Team Lead unless a command exists, but `createAgentGrid()` still ignores a configured Team Lead, the UI remains misleading. Conversely, if `createAgentGrid()` launches Team Lead but the sidebar still counts a blank-command Team Lead as expected, the red-row bug remains. Both surfaces must be updated together.
- **Do not create duplicate Team Lead terminals:** `createAgentGrid()` already reuses matching terminals when they exist. The Team Lead addition must follow the same matching/reuse flow instead of introducing a second Team Lead launch mechanism.
- **Test drift from reviewed Team Lead setup work:** existing regex tests in `src/test/team-lead-visibility-defaults-regression.test.js` currently encode the buggy `!== false` sidebar conditions and know nothing about Team Lead’s absence from `createAgentGrid()`. The updated test must preserve the reviewed setup-panel architecture while locking down the new conditional Team Lead launch behavior.

## Edge-Case & Dependency Audit
- **Race Conditions:** `lastStartupCommands`, `lastVisibleAgents`, `lastTerminals`, and `lastDispatchReadiness` hydrate asynchronously in `src/webview/implementation.html`. The Team Lead visibility helper must tolerate partial state and return `false` until a real Team Lead route appears, then naturally re-render when later messages update those caches. Separately, `createAgentGrid()` must read the latest `visibleAgents` and `startupCommands` together so it does not launch Team Lead from stale mixed state.
- **Security:** No credential, filesystem, or command-execution surface changes are required beyond reusing the existing `startupCommands` path. Team Lead should launch only from the user-configured command already persisted in workspace state.
- **Side Effects:** Team Lead will now be included in `OPEN AGENT TERMINALS` when explicitly enabled with a command. That is an intentional correction, not scope creep. At the same time, Team Lead will no longer count toward the sidebar’s “expected agents” list unless the role is both enabled and reachable.
- **Dependencies & Conflicts:** `get_kanban_state` shows no other active New / Planned plan besides this one, so there are no active Kanban blockers. The plans folder contains nearby reviewed work that should be treated as merge hotspots:
  - `fix_team_lead_default_active_and_move_to_dedicated_accordion.md`
  - `fix_team_lead_ui_visibility.md`
  - `make_team_lead_column_visibility_consistent_with_other_agents.md`
  - `setup_view_improvements.md`
  
  These are not active blockers under the planning rules, but they matter because this fix must preserve the current reviewed state where:
  - Team Lead remains configured in `src/webview/setup.html`
  - Team Lead remains a sidebar dispatch role in `src/webview/implementation.html`
  - Team Lead remains hidden by default at the provider/webview default level until explicitly enabled

## Adversarial Synthesis
### Grumpy Critique
The previous version of this plan did, in fact, try to “fix” the symptom by keeping Team Lead out of `createAgentGrid()`. That would have been sabotage by omission: the user could enable Team Lead, provide a valid command, click `OPEN AGENT TERMINALS`, and still never get a Team Lead terminal. Spectacularly bad.

Worse, that version was smug about being “narrow.” Narrow is not the same as correct. If the product surface says Team Lead can be enabled and configured, then the standard terminal-launch button cannot silently pretend Team Lead does not exist. That is not a careful scope boundary; that is a broken contract.

And the sidebar bug is still not a two-line fairy tale. If you fix only the render condition, the onboarding guard still counts Team Lead as an expected local agent when unreachable. If you fix only the sidebar helper, `createAgentGrid()` still refuses to launch Team Lead even when configured. If you fix only `createAgentGrid()`, the false red row remains. Three linked symptoms, one linked fix.

### Balanced Response
The corrected plan must do two things together:
1. make the sidebar Team Lead row command-aware so unreachable Team Lead does not show as a fake red local agent, and
2. make `OPEN AGENT TERMINALS` honor an explicitly enabled, explicitly configured Team Lead so the feature is actually usable.

That keeps the fix faithful to the current product model:
- Team Lead stays opt-in.
- Team Lead still uses the existing setup-panel command and visibility state.
- A blank Team Lead command still means “do not create a Team Lead terminal.”
- A valid Team Lead command now means the launch button actually launches Team Lead.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The implementation below is intentionally scoped to the current Team Lead state model. Do not move Team Lead configuration back into `implementation.html`, do not rewrite setup-panel persistence, and do not introduce a separate Team Lead launcher outside `createAgentGrid()`.

### 1. Conditionally include Team Lead in `OPEN AGENT TERMINALS`
#### [MODIFY] `src/extension.ts`
- **Context:** `createAgentGrid()` currently builds `allBuiltInAgents` without Team Lead, so `OPEN AGENT TERMINALS` can never launch a Team Lead terminal even when the user has enabled Team Lead and provided a valid command.
- **Logic:**
  1. Read `startupCommands` near the top of `createAgentGrid()` alongside `visibleAgents` and `customAgents`.
  2. Compute `teamLeadCommand = (startupCommands['team-lead'] || '').trim()`.
  3. Conditionally append `{ name: 'Team Lead', role: 'team-lead' }` to the built-in grid agent list only when:
     - `visibleAgents['team-lead'] === true`
     - `teamLeadCommand` is non-empty
  4. Reuse the same `startupCommands` object later in the auto-execute loop instead of re-fetching it.
  5. Keep Team Lead out of the grid when visibility is false or the command is blank.
- **Implementation:**

```diff
--- a/src/extension.ts
+++ b/src/extension.ts
@@
         const visibleAgents = await taskViewerProvider.getVisibleAgents();
         const includeJulesMonitor = visibleAgents.jules !== false;
         const customAgents = await taskViewerProvider.getCustomAgents();
+        const startupCommands = await taskViewerProvider.getStartupCommands();
+        const teamLeadCommand = (startupCommands['team-lead'] || '').trim();
         const allBuiltInAgents = [
             { name: 'Planner', role: 'planner' },
             { name: 'Lead Coder', role: 'lead' },
             { name: 'Coder', role: 'coder' },
             { name: 'Intern', role: 'intern' },
             { name: 'Reviewer', role: 'reviewer' },
-            { name: 'Analyst', role: 'analyst' }
+            { name: 'Analyst', role: 'analyst' },
+            ...(visibleAgents['team-lead'] === true && teamLeadCommand
+                ? [{ name: 'Team Lead', role: 'team-lead' as const }]
+                : [])
         ];
@@
             // Auto-execute startup commands for each agent terminal
             try {
-                const startupCommands = await taskViewerProvider.getStartupCommands();
                 for (const agent of agents) {
                     let cmd = startupCommands[agent.role];
                     // Fallback: jules_monitor defaults to 'jules' when configured command is missing/blank
                     if (agent.role === 'jules_monitor' && (!cmd || !cmd.trim())) {
                         cmd = 'jules';
```

- **Edge Cases Handled:** This does not create a useless empty Team Lead terminal. It also reuses the existing grid terminal reuse/matching logic automatically, so an already-open Team Lead terminal is reused instead of duplicated.

### 2. Sidebar visibility and onboarding-guard gating
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The current sidebar logic uses simple visibility checks (`va['team-lead'] !== false`) in places that determine whether Team Lead is counted as an expected agent and whether the Team Lead row is rendered at all. That is too permissive because Team Lead can now be launched only when explicitly configured, and should otherwise be hidden unless an existing route already exists.
- **Logic:**
  1. Keep `lastVisibleAgents['team-lead']` as the primary opt-in flag.
  2. Add a helper that returns `true` only when Team Lead is both intentionally enabled **and** actually reachable in this window.
  3. Treat Team Lead as reachable when **any** of the following is true:
     - `lastStartupCommands['team-lead']` is a non-empty string
     - a registered terminal in `lastTerminals` already has `role === 'team-lead'`
     - `lastDispatchReadiness['team-lead']` exposes a concrete route (`terminalName`) or a ready/recoverable dispatch state
  4. Use this helper in both:
     - the onboarding “Agents not connected” guard (`allRoles`)
     - the actual Team Lead row render block
  5. Tighten the two cached visibility-persistence sites from `!== false` to `=== true` so Team Lead remains truly opt-in in sidebar-originated saves.
- **Implementation:**

```diff
--- a/src/webview/implementation.html
+++ b/src/webview/implementation.html
@@
                 const commands = {
                     ...lastStartupCommands,
                     'team-lead': lastStartupCommands['team-lead'] || ''
                 };
                 const visibleAgents = {
                     ...lastVisibleAgents,
-                    'team-lead': lastVisibleAgents['team-lead'] !== false
+                    'team-lead': lastVisibleAgents['team-lead'] === true
                 };
                 const julesAutoSyncEnabled = !!document.getElementById('jules-auto-sync-toggle')?.checked;
@@
         function isAgentGreen(roleId) {
             // jules is a built-in cloud feature, always considered available
             if (roleId === 'jules') return false;
             const dispatchInfo = lastDispatchReadiness && roleId ? lastDispatchReadiness[roleId] : null;
             const dispatchState = dispatchInfo?.state ?? null;
             if (dispatchState === 'ready') return true;
             if (dispatchState === 'recoverable' || dispatchState === 'not_ready') return false;
             // Fallback: check terminal heartbeat for agents with no dispatch info
             const HEARTBEAT_THRESHOLD_MS = 120_000;
             const matchedTermName = Object.keys(lastTerminals).find(key => lastTerminals[key]?.role === roleId);
             if (!matchedTermName) return false;
             const termData = lastTerminals[matchedTermName];
             if (!termData) return false;
             const lastSeenMs = Date.parse(termData.lastSeen || '');
             const heartbeatAlive = !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < HEARTBEAT_THRESHOLD_MS;
             return termData.alive !== undefined ? !!termData.alive : (!!termData._isLocal || heartbeatAlive);
         }
+
+        function shouldShowTeamLeadSidebarRow() {
+            if (lastVisibleAgents['team-lead'] !== true) {
+                return false;
+            }
+
+            if ((lastStartupCommands['team-lead'] || '').trim()) {
+                return true;
+            }
+
+            if (Object.keys(lastTerminals).some(key => lastTerminals[key]?.role === 'team-lead')) {
+                return true;
+            }
+
+            const dispatchInfo = lastDispatchReadiness ? lastDispatchReadiness['team-lead'] : null;
+            if (!dispatchInfo) {
+                return false;
+            }
+
+            if (dispatchInfo.terminalName) {
+                return true;
+            }
+
+            return dispatchInfo.state === 'ready' || dispatchInfo.state === 'recoverable';
+        }
 
         function renderAgentList() {
@@
                 const allRoles = [
                     ...(va.planner !== false ? ['planner'] : []),
                     ...(va.lead !== false ? ['lead'] : []),
-                    ...(va['team-lead'] !== false ? ['team-lead'] : []),
+                    ...(shouldShowTeamLeadSidebarRow() ? ['team-lead'] : []),
                     ...(va.coder !== false ? ['coder'] : []),
                     ...(va.intern !== false ? ['intern'] : []),
                     ...(va.reviewer !== false ? ['reviewer'] : []),
                     ...(va.tester !== false ? ['tester'] : []),
                     ...(va.analyst !== false ? ['analyst'] : []),
                     ...lastCustomAgents.filter(a => va[a.role] !== false).map(a => a.role)
                 ];
@@
             // 5b. Team Lead
-            if (va['team-lead'] !== false) {
+            if (shouldShowTeamLeadSidebarRow()) {
                 agentListStandard.appendChild(createAgentRow('TEAM LEAD', 'team-lead',
                     'START CODING',
                     terminals => Object.keys(terminals).find(key => terminals[key].role === 'team-lead')
                 ));
             }
@@
-            const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': lastVisibleAgents['team-lead'] !== false, jules: true };
+            const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': lastVisibleAgents['team-lead'] === true, jules: true };
             document.querySelectorAll('.onboard-agent-toggle').forEach(cb => {
                 const role = cb.dataset.role;
                 if (role) visibleAgents[role] = cb.checked;
             });
```

- **Edge Cases Handled:** This does **not** hide a legitimately reachable Team Lead. A configured Team Lead command, an already-running Team Lead terminal, or a dispatch-readiness route still makes the row appear. It also prevents Team Lead from polluting the onboarding “no agents connected” detection when the role is enabled but unreachable.

### 3. Regression coverage for the sidebar and launch-path rule
#### [MODIFY] `src/test/team-lead-visibility-defaults-regression.test.js`
- **Context:** The existing regression test currently locks in the buggy implementation details by asserting `lastVisibleAgents['team-lead'] !== false` in the sidebar save path, the onboarding save path, the onboarding guard, and the Team Lead row render condition. It also has no awareness that Team Lead should be conditionally launchable from `createAgentGrid()`.
- **Logic:**
  1. Add `extension.ts` to the test’s read set.
  2. Update the two save-path assertions so they require `=== true` instead of `!== false`.
  3. Replace the direct render/guard assertions with helper-based assertions that encode the real behavior:
     - `implementation.html` defines `shouldShowTeamLeadSidebarRow()`
     - the helper requires explicit Team Lead visibility plus at least one of:
       - configured Team Lead startup command
       - registered Team Lead terminal
       - dispatch readiness with `terminalName`
       - dispatch readiness state `ready` / `recoverable`
     - `renderAgentList()` uses that helper in both `allRoles` and the Team Lead row render block
  4. Add an assertion that `createAgentGrid()` conditionally appends Team Lead when visibility is true and the Team Lead startup command is non-empty.
  5. Keep the rest of the test intact, especially the reviewed assertions that Team Lead remains configured in `src/webview/setup.html`.
- **Implementation:**

```diff
--- a/src/test/team-lead-visibility-defaults-regression.test.js
+++ b/src/test/team-lead-visibility-defaults-regression.test.js
@@
     const kanbanProviderSource = readSource('src', 'services', 'KanbanProvider.ts');
     const taskViewerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
+    const extensionSource = readSource('src', 'extension.ts');
     const implementationSource = readSource('src', 'webview', 'implementation.html');
     const kanbanSource = readSource('src', 'webview', 'kanban.html');
     const setupSource = readSource('src', 'webview', 'setup.html');
     const agentConfigSource = readSource('src', 'services', 'agentConfig.ts');
@@
     assert.match(
         implementationSource,
-        /const visibleAgents = \{ lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': lastVisibleAgents\['team-lead'\] !== false, jules: true \};/,
-        'Expected onboarding save path to preserve the hidden Team Lead visibility state.'
+        /const visibleAgents = \{ lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': lastVisibleAgents\['team-lead'\] === true, jules: true \};/,
+        'Expected onboarding save path to keep Team Lead opt-in only.'
     );
@@
     assert.match(
         implementationSource,
-        /const visibleAgents = \{\s*\.\.\.lastVisibleAgents,\s*'team-lead': lastVisibleAgents\['team-lead'\] !== false\s*\};/m,
-        'Expected terminal-operations launches to use cached visibility state after the built-in controls moved to setup.'
+        /const visibleAgents = \{\s*\.\.\.lastVisibleAgents,\s*'team-lead': lastVisibleAgents\['team-lead'\] === true\s*\};/m,
+        'Expected terminal-operations launches to keep Team Lead opt-in only.'
     );
+
+    assert.match(
+        implementationSource,
+        /function shouldShowTeamLeadSidebarRow\(\) \{[\s\S]*lastVisibleAgents\['team-lead'\] !== true[\s\S]*lastStartupCommands\['team-lead'\][\s\S]*Object\.keys\(lastTerminals\)\.some\(key => lastTerminals\[key\]\?\.role === 'team-lead'\)[\s\S]*dispatchInfo\.terminalName[\s\S]*dispatchInfo\.state === 'ready' \|\| dispatchInfo\.state === 'recoverable'[\s\S]*\}/m,
+        'Expected implementation.html to gate Team Lead sidebar visibility on explicit enablement plus a configured command or known route.'
+    );
@@
-    assert.match(
-        implementationSource,
-        /\.\.\.\(va\['team-lead'\] !== false \? \['team-lead'\] : \[\]\),/,
-        'Expected connected-agent guard logic to keep Team Lead available when enabled.'
-    );
+    assert.match(
+        implementationSource,
+        /\.\.\.\(shouldShowTeamLeadSidebarRow\(\) \? \['team-lead'\] : \[\]\),/,
+        'Expected connected-agent guard logic to count Team Lead only when it is actually reachable.'
+    );
 
     assert.match(
         implementationSource,
-        /createAgentRow\('TEAM LEAD', 'team-lead',[\s\S]*terminals => Object\.keys\(terminals\)\.find\(key => terminals\[key\]\.role === 'team-lead'\)/m,
-        'Expected sidebar agent list to keep the Team Lead dispatch row.'
+        /if \(shouldShowTeamLeadSidebarRow\(\)\) \{[\s\S]*createAgentRow\('TEAM LEAD', 'team-lead',[\s\S]*terminals => Object\.keys\(terminals\)\.find\(key => terminals\[key\]\.role === 'team-lead'\)/m,
+        'Expected sidebar agent list to keep the Team Lead dispatch row only when Team Lead is reachable.'
+    );
+
+    assert.match(
+        extensionSource,
+        /const startupCommands = await taskViewerProvider\.getStartupCommands\(\);[\s\S]*const teamLeadCommand = \(startupCommands\['team-lead'\] \|\| ''\)\.trim\(\);[\s\S]*visibleAgents\['team-lead'\] === true && teamLeadCommand[\s\S]*\{ name: 'Team Lead', role: 'team-lead'/m,
+        'Expected createAgentGrid() to include Team Lead only when enabled and configured with a startup command.'
     );
```

- **Edge Cases Handled:** This regression update prevents future refactors from either reintroducing the false red Team Lead row or removing the ability to launch a configured Team Lead from `OPEN AGENT TERMINALS`.

## Verification Plan
### Automated Tests
- `node src/test/team-lead-visibility-defaults-regression.test.js`
- `npm run compile`

### Manual Verification Steps
1. Start from a workspace where `visibleAgents['team-lead']` is `true`, but `startupCommands['team-lead']` is blank and no Team Lead terminal is registered.
2. Open the sidebar and verify the Team Lead row does **not** appear.
3. Verify the onboarding / “Agents not connected” empty-state logic no longer counts Team Lead as an expected local agent in that blank-command state.
4. Configure a Team Lead startup command in Setup and verify the Team Lead row appears in the sidebar.
5. Click `OPEN AGENT TERMINALS` and verify a Team Lead terminal is created when Team Lead is enabled and has a command.
6. Clear the Team Lead startup command again and verify `OPEN AGENT TERMINALS` no longer creates a Team Lead terminal unless a Team Lead terminal is already registered from an earlier run.

## Original Draft Notes (Preserved)

## Problem
The Team Lead agent appears in the sidebar as red (not ready) even when the user has never set a startup command for it. The expected behavior is that if no startup command is configured, the agent should not appear in the sidebar at all since no terminal is being created for it.

## Root Cause
In `src/webview/implementation.html`, there are two locations where team-lead visibility is forced using the condition `!== false`:

1. **Line 1583** (in the create agent grid logic):
   ```javascript
   const visibleAgents = {
       ...lastVisibleAgents,
       'team-lead': lastVisibleAgents['team-lead'] !== false
   };
   ```

2. **Line 3831** (in the onboarding logic):
   ```javascript
   const visibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': lastVisibleAgents['team-lead'] !== false, jules: true };
   ```

The condition `!== false` evaluates to `true` when the value is `undefined` (which happens if the user never set a startup command for team-lead). This forces team-lead to appear in the sidebar even though the backend default visibility is `false` (from `TaskViewerProvider.ts` line 1671).

## Proposed Fix
Change both locations from `!== false` to `=== true` to properly respect the backend default:

1. **Line 1583**: Change `'team-lead': lastVisibleAgents['team-lead'] !== false` to `'team-lead': lastVisibleAgents['team-lead'] === true`

2. **Line 3831**: Change `'team-lead': lastVisibleAgents['team-lead'] !== false` to `'team-lead': lastVisibleAgents['team-lead'] === true`

This ensures that team-lead only appears in the sidebar when the user explicitly enables it (sets visibility to `true`), rather than appearing by default when the value is undefined.

## Files to Modify
- `src/webview/implementation.html` (2 locations)

## Testing
1. Verify that team-lead does not appear in the sidebar when no startup command is set
2. Verify that team-lead appears in the sidebar only when explicitly enabled in setup
3. Verify that the red status (not ready) only shows when a terminal is expected but not running

## Execution Notes

### Fixed Items
- Reviewer pass completed against the implemented Team Lead sidebar visibility fix.
- Confirmed the implementation now keeps Team Lead opt-in in both sidebar-originated visibility persistence sites by using `=== true` instead of the previous permissive check.
- Confirmed `src/webview/implementation.html` now uses a dedicated `shouldShowTeamLeadSidebarRow()` helper for both:
  - the onboarding / "Agents not connected" expected-role guard
  - the Team Lead row render path
- Confirmed the helper matches the approved rule: Team Lead must be explicitly enabled and then become reachable via a configured startup command, an existing Team Lead terminal, or Team Lead dispatch readiness metadata.
- Confirmed `src/extension.ts#createAgentGrid()` now conditionally includes Team Lead only when:
  - `visibleAgents['team-lead'] === true`
  - the saved Team Lead startup command is non-empty
- No reviewer code fixes were required beyond this review update; the implementation already matched the approved plan requirements.

### Files Changed
- Reviewer update:
  - `.switchboard/plans/fix_team_lead_sidebar_visibility_bug.md`
- Reviewed implementation surfaces:
  - `src/webview/implementation.html`
  - `src/extension.ts`
  - `src/test/team-lead-visibility-defaults-regression.test.js`
  - `src/services/TaskViewerProvider.ts`
  - `src/services/KanbanProvider.ts`
  - `src/services/agentConfig.ts`

### Validation Results
- `node src/test/team-lead-visibility-defaults-regression.test.js` ✅
- `npm run compile` ✅

### Remaining Risks
- The regression coverage is strong for the intended rule, but it is still regex-driven and may be somewhat brittle to harmless formatting or markup reshuffles.
- Manual verification steps from this plan were not executed in this reviewer pass, so the verdict is based on code inspection plus automated verification.

### Unresolved Issues
- None. The implemented sidebar rule, onboarding guard, and `OPEN AGENT TERMINALS` launch path now agree with the plan.
