# Orchestrator role appears in terminals.html role picker but not in kanban.html agents list

## Goal

The orchestrator role appears as a selectable option in the terminals.html "+ New" role picker, but it is NOT present in the kanban.html Agents tab. This is inconsistent and confusing — the orchestrator is a system-managed terminal role launched by the Kanban AUTOMATION tab's "Start orchestrator" button, not a user-selectable agent role. Selecting it from the role picker spawns a plain shell with no orchestrator persona, which is useless.

### Problem Analysis

The terminals.html role picker (`onNewTerminalClicked` in `terminals.js`) fetches visible roles via `fetchPtyVisibleRoles()`, which calls `GET /terminals/verb/ptyVisibleRoles`. The backend handler (`GlobalIntegrationConfigService.getPtyVisibleRoles()`) reads the machine-global config file (`~/.switchboard/integration-config.json`), merges it over `DEFAULT_VISIBLE_AGENTS`, and returns every key in the merged map.

The user's config file contains `"orchestrator": true` in the `visibleAgents` map. This was likely written by a prior code path (possibly a kanban column toggle or a migration fold) and persists because `mergeVisibleAgentsToGlobalFile` only merges patches — it never removes keys that aren't in the patch. The kanban.html Agents tab has hardcoded checkboxes for specific roles and does NOT include orchestrator, so saving the Agents tab never sends `orchestrator` in the patch — but it also never removes it from the file.

The result: `getPtyVisibleRoles` returns `orchestrator: true` because it's in the file, and `onNewTerminalClicked` renders it as a button in the role picker. Since `BUILT_IN_AGENT_LABELS` in `sharedDefaults.js` does not include orchestrator, the button shows the raw key "orchestrator" (via the fallback at `terminals.js:3238`: `const label = meta ? meta.label : role`).

### Root Cause

`GlobalIntegrationConfigService.getPtyVisibleRoles()` does `Object.assign(visible, fileValue)` (line 445) without filtering out system-managed roles. The orchestrator is not a user agent — it is a system terminal created by `startOrchestratorFromKanban` in `TaskViewerProvider.ts` (line 9313: `role: 'orchestrator'`). It should never appear in the role picker.

The kanban.html Agents tab is correct — it has no orchestrator checkbox. The terminals.html role picker is wrong — it renders every key from the merged visibleAgents map without distinguishing user-selectable agent roles from system-managed terminal roles.

Both hosts share the same backend: the extension host verb handler (`TaskViewerProvider.ts:2001-2003`) and the standalone host verb handler (`bootstrap.ts:1101-1103`) both call `GlobalIntegrationConfigService.getPtyVisibleRoles()`. Fixing the backend fixes both hosts in one change.

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, bugfix, ui
**Project:** Browser Switchboard

## User Review Required

This plan changes the approach from a frontend filter to a backend filter. Review the **Superseded** callout in `## Proposed Changes` before approving. The system-role exclusion set (`orchestrator`, `mcp_monitor`, `jules_monitor`, `scheduler`) should be confirmed against any future system roles added to the codebase.

## Complexity Audit

### Routine
- Single-file change to `GlobalIntegrationConfigService.getPtyVisibleRoles()` — add a filter after the merge, before building `hasCommand`.
- The exclusion set is small, known, and defined once at the source.
- Both hosts share the backend, so one change fixes both — no duplicated constants across webview JS.
- Legit user roles (built-in + custom) are unaffected; the filter only strips system-managed terminal roles.

### Complex / Risky
- `getPtyVisibleRoles()` is a shared service consumed by both hosts (extension + standalone) on a shipped extension with ~4,000 installs. The change must be behaviour-preserving for every legit role.
- `resolveGridAgents` (`terminals.js:3329`) also consumes the returned `visibleAgents` map — must confirm the filter does not strip any role it depends on (it iterates the hardcoded `GRID_BUILTIN_ROLES` list + custom agents, neither of which includes system roles, so it is safe).

## Edge-Case & Dependency Audit

1. **Race Conditions:** None. `getPtyVisibleRoles` is a read-only merge; the filter is synchronous after the merge. No concurrent-write hazard.

2. **Security:** None. The filter only affects which roles appear in a UI picker. No auth, no secrets, no privilege boundary.

3. **Side Effects:**
   - **Existing orchestrator terminals:** If a user has already created an orchestrator terminal via the role picker (by mistake), this fix does not close it. The terminal continues running. The fix only prevents NEW orchestrator terminals from appearing in the picker.
   - **Orchestrator automation:** `startOrchestratorFromKanban` creates the orchestrator terminal directly via `vscode.window.createTerminal` with a hardcoded `role: 'orchestrator'` — it does NOT go through `getPtyVisibleRoles` or the visibleAgents map. The filter does not affect orchestrator automation.
   - **`resolveGridAgents` / OPEN AGENT TERMINALS:** Iterates `GRID_BUILTIN_ROLES` (hardcoded, no system roles) + custom agents, then sets `jules_monitor` via `wanted.set('jules_monitor', 1)` keyed off `visible.jules` (the user role, not the system role). Stripping `jules_monitor` from the returned map does not break this — it reads `visible.jules`, not `visible.jules_monitor`.

4. **Dependencies & Conflicts:**
   - **Other system roles:** `mcp_monitor` is a system-managed terminal role (codebase comments at `TaskViewerProvider.ts:10310, 10418, 24059` call it out as a file-only key). `scheduler` is a system-managed terminal role (`TaskViewerProvider.ts:23918` writes `role: 'scheduler'`; line 19116 groups it with `jules_monitor` as dispatch-blocked). `jules_monitor` is a system role set via `resolveGridAgents`, not normally stored in visibleAgents. All four should be excluded from the picker.
   - **Custom agents:** Custom agents (with `custom_agent_*` role prefixes) are added to `visible` by the `parseCustomAgents` loop (line 442-444) BEFORE the file merge. The system-role filter runs AFTER the merge, so custom agents are preserved — the filter only strips the named system roles, not custom-prefixed keys.
   - **The "No role" option:** The role picker appends a "No role" button at the end of `onNewTerminalClicked` (`terminals.js:3252`). This is added in the frontend after the roles loop and is not affected by the backend filter.
   - **Stale config cleanup:** The fix prevents system roles from appearing in the picker, but the stale `"orchestrator": true` entry remains in the user's config file. The backend filter handles it at the return layer. A one-time cleanup via `mergeVisibleAgentsToGlobalFile({}, ['orchestrator'])` (the `deleteKeys` parameter at line 24066) is a *nice-to-have* but NOT required — it risks the wipe guard in `setAgentConfig` and touches user data across 4,000 installs for a cosmetic gain. Document as optional.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the original plan fixed the frontend symptom while the named root cause (`getPtyVisibleRoles` merging without filtering) remained — superseded by a backend filter at the source; (2) the original system-role set missed `scheduler` and `jules_monitor`, two confirmed system-managed terminal roles — corrected to a four-role set; (3) the shared service is consumed by both hosts on a 4,000-install extension, so the filter must be behaviour-preserving for every legit role. Mitigations: filter runs after the merge and after custom-agent injection, so built-in and custom roles are untouched; `resolveGridAgents` is safe because it iterates hardcoded `GRID_BUILTIN_ROLES`, not map keys; orchestrator automation bypasses the map entirely.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts` — Filter system-managed roles at the source

The root cause is `getPtyVisibleRoles()` returning system-managed roles that leaked into the config file. Filter them out after the merge, before building the `hasCommand` map. This is the single chokepoint both hosts share (`TaskViewerProvider.ts:2002` and `bootstrap.ts:1102` both call it), so one change fixes both hosts and protects every consumer (`onNewTerminalClicked`, `fetchVisibleRoles`, `resolveGridAgents`).

Add a module-level exclusion set and apply it in `getPtyVisibleRoles()` (around line 435-453):

```typescript
// System-managed terminal roles that are launched by automation (Kanban
// AUTOMATION tab / scheduler / Jules monitor), NOT user-selectable agent
// roles. They must never appear in the terminals.html role picker. They can
// leak into the machine-global visibleAgents file via stale config and are
// preserved by mergeVisibleAgentsToGlobalFile (which never removes un-patched
// keys), so they must be stripped at the read layer.
private static SYSTEM_ONLY_ROLES = new Set(['orchestrator', 'mcp_monitor', 'jules_monitor', 'scheduler']);
```

Then in `getPtyVisibleRoles()`, after the `Object.assign(visible, fileValue)` merge (line 445) and before the `hasCommand` loop (line 447):

```typescript
Object.assign(visible, fileValue);

// Strip system-managed terminal roles that leaked into the file. They are
// launched by automation, not selectable by users, and must not appear in the
// role picker or the OPEN AGENT TERMINALS path.
for (const sysRole of this.SYSTEM_ONLY_ROLES) {
    delete visible[sysRole];
}

const hasCommand: Record<string, boolean> = {};
```

This is the minimal, targeted, root-cause fix. No frontend change is needed — `onNewTerminalClicked` (`terminals.js:3231`) already filters `visible[k] !== false`, and system roles will no longer be in the map at all.

> **Superseded:** Filter system-managed roles in the frontend (`src/webview/terminals.js`) in `onNewTerminalClicked` (line 3231) and `fetchVisibleRoles` (line 3218) using a module-scope `SYSTEM_ROLES = new Set(['orchestrator', 'mcp_monitor'])` constant.
> **Reason:** The plan's own Root Cause section names `GlobalIntegrationConfigService.getPtyVisibleRoles()` as the culprit (`Object.assign(visible, fileValue)` without filtering system roles), yet the fix patched the rendering layer instead of the source. The frontend approach (a) treats the symptom not the root cause — the backend still leaks system roles to every consumer; (b) duplicates the constant across two call sites and relies on the implementer to remember the filter in any future consumer; (c) only fixes the picker, leaving `resolveGridAgents` and any future consumer still receiving system roles in the map; and (d) used an incomplete system-role set that missed `scheduler` and `jules_monitor`, two confirmed system-managed terminal roles. The backend is the single chokepoint both hosts share, so filtering there is one change, fixes both hosts, and protects all consumers uniformly.
> **Replaced with:** Filter system-managed roles at the source in `GlobalIntegrationConfigService.getPtyVisibleRoles()` after the merge, before building `hasCommand`. Exclusion set: `{orchestrator, mcp_monitor, jules_monitor, scheduler}`. No frontend change needed.

### `src/webview/terminals.js` — No change needed (verification only)

With the backend filter in place, `onNewTerminalClicked` (`terminals.js:3231`) and `fetchVisibleRoles` (`terminals.js:3218`) already filter `visible[k] !== false`, and system roles will no longer be present in the returned `visibleAgents` map. No frontend edit is required.

Verify during implementation that `resolveGridAgents` (`terminals.js:3329-3357`) remains correct: it iterates the hardcoded `GRID_BUILTIN_ROLES` list (which does not include system roles) and custom agents, and sets `jules_monitor` via `wanted.set('jules_monitor', 1)` keyed off `visible.jules` (the user role), not `visible.jules_monitor`. Stripping `jules_monitor` from the map does not affect this path.

### Optional — Stale config cleanup (nice-to-have, NOT required)

The stale `"orchestrator": true` entry remains in the user's config file after the fix. The backend filter hides it from every consumer, so removal is cosmetic. If desired, a one-time cleanup can strip it via the existing `deleteKeys` parameter:

```typescript
await this.mergeVisibleAgentsToGlobalFile({}, ['orchestrator']);
```

This is **optional** — it risks the wipe guard in `setAgentConfig` (the empty-remainder skip at `TaskViewerProvider.ts:24074-24079`) and touches user data across 4,000 installs for no functional gain. Do NOT bundle this with the core fix; ship it separately only if the stale key becomes a debug nuisance.

## Verification Plan

### Automated Tests
None — per session directives, no automated tests are run as part of this plan. The change is a read-only filter with no new state; manual verification covers the surface.

### Manual Verification

1. **Role picker — system roles excluded:**
   - Open terminals.html.
   - Click "+ New" in the sidebar.
   - **Verify:** The role picker does NOT show "orchestrator", "mcp_monitor", "jules_monitor", or "scheduler" as options.
   - **Verify:** All legitimate agent roles (planner, lead, coder, intern, reviewer, analyst, project_manager, tester, ticket_updater, researcher, jules, claude_designer, phone_a_friend) still appear.
   - **Verify:** Custom agents still appear.
   - **Verify:** "No role" still appears at the bottom.

2. **OPEN AGENT TERMINALS — no system-role terminals:**
   - Click "OPEN AGENT TERMINALS" in the sidebar.
   - **Verify:** No orchestrator/scheduler/jules_monitor terminal is created.
   - **Verify:** Only visible, non-system roles get terminals.

3. **kanban.html Agents tab (regression):**
   - Open kanban.html, go to the Agents tab.
   - **Verify:** The agents list is unchanged (no orchestrator checkbox, same roles as before).

4. **Orchestrator automation (regression):**
   - Start the orchestrator from the Kanban AUTOMATION tab.
   - **Verify:** The orchestrator terminal is created and functions normally (the fix only affects the role picker / visible-roles read path, not the orchestrator automation which creates the terminal directly).

5. **Both hosts (regression):**
   - **Verify** in the VS Code extension host: role picker excludes system roles.
   - **Verify** in the standalone host (`npx switchboard`): role picker excludes system roles (same backend, same fix).

6. **Build check:** Skipped per session directives — no compilation step is run as part of this verification plan.

## Recommendation

Complexity 4 — routine single-file change, but the shared service is consumed by both hosts on a 4,000-install extension. **Send to Coder.**

## Completion Report

Added `SYSTEM_ONLY_ROLES` set and a post-merge deletion loop to `GlobalIntegrationConfigService.getPtyVisibleRoles()` in `src/services/GlobalIntegrationConfigService.ts`. System roles `orchestrator`, `mcp_monitor`, `jules_monitor`, and `scheduler` are now stripped from the visible-agents map before it is returned, so they no longer appear in the terminals.html role picker or in any other consumer. No frontend files changed. Compilation and tests were skipped per session directives. File edited and diff reviewed; change matches the plan exactly.

## Review Findings

Independent reviewer pass completed. The diff in `src/services/GlobalIntegrationConfigService.ts` (lines 430-460) matches the plan exactly — `SYSTEM_ONLY_ROLES` set with all four system roles, deletion loop after the `Object.assign` merge and before the `hasCommand` loop. Consumer tracing confirmed safe: `onNewTerminalClicked` (terminals.js:3328) iterates map keys and will no longer see system roles; `resolveGridAgents` (terminals.js:3457) iterates hardcoded `GRID_BUILTIN_ROLES` and reads `visible.jules` (not `visible.jules_monitor`) for the jules_monitor wanted entry; orchestrator automation (`startOrchestratorFromKanban`, TaskViewerProvider.ts:9291) creates terminals directly with `role: 'orchestrator'` and bypasses the map entirely. Webpack production build compiled with 0 errors (4 pre-existing warnings only); `tsc --noEmit` has 5 pre-existing errors in unrelated files, 0 in the changed file. No tests exist for this function and the plan names no automated checks, so the gate-wiring audit has nothing to verify. Two NITs deferred (no code fixes applied): (1) `TaskViewerProvider.getVisibleAgents()` (line 5775) is a parallel read path that also merges the config file without filtering system roles — its current consumers iterate hardcoded lists so no leak today, but defense-in-depth would apply the same filter; (2) the frontend `SYSTEM_ROLES` set at terminals.js:3327 (added by a separate plan) is now redundant and only covers 2 of 4 roles. No CRITICAL or MAJOR findings. Remaining risk: manual verification steps (role picker, OPEN AGENT TERMINALS, orchestrator automation regression) not executed in this review pass.
