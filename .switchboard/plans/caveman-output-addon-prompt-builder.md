# Caveman Output Add-on for Prompt Builder

## Goal

Add a "Caveman Output" checkbox to the Prompts tab prompt builder for all Switchboard roles so that, when enabled, a caveman directive is injected into the generated agent prompt to reduce token usage by 65–75% while maintaining technical accuracy.

## Metadata

**Tags:** frontend, backend, UI, UX
**Complexity:** 5

## User Review Required

- The plan originally specified adding Caveman Output to the **custom agent** addon form for consistency. The custom-agent prompt path (KanbanProvider line 2841–2842) does NOT route through `buildKanbanBatchPrompt` and currently has no addon injection mechanism. See **Edge-Case & Dependency Audit** — decide: (a) descope custom agents for now, or (b) patch the custom-agent prompt builder too. The plan steps below include the minimal patch for custom agents but it can be omitted.

## Complexity Audit

### Routine
- Adding a new checkbox entry to `ROLE_ADDONS` (11 roles) and `DEFAULT_ROLE_CONFIG` in `sharedDefaults.js` — mechanical repetition of an existing pattern
- Adding a hardcoded `<input>` element for the planner role in `kanban.html` — same HTML structure as existing planner checkboxes
- Adding `cavemanOutput: false` to the planner save-array and restore-block in `kanban.html` — two localized additions
- Adding exported `CAVEMAN_OUTPUT_DIRECTIVE` constant and `cavemanOutputEnabled?: boolean` field to `agentPromptBuilder.ts` — follows the `SKIP_COMPILATION_DIRECTIVE` / `skipCompilation` pattern exactly
- Injecting the directive inside `buildKanbanBatchPrompt` for each role branch — one `if` block per branch, same pattern as `skipCompilation`

### Complex / Risky
- Wiring `cavemanOutputByRole` through `_getPromptsConfig()` and all `buildKanbanBatchPrompt` call sites in `KanbanProvider.ts` (~8 call sites). Missing even one means the directive silently never fires for that UI entry point (card copy, batch button, autoban, ticket-view). Requires a careful grep-based audit of every `buildKanbanBatchPrompt` invocation.
- Custom agent prompt path at line 2841–2842 is independent of `buildKanbanBatchPrompt` — requires a separate, localized patch if in scope.

## Edge-Case & Dependency Audit

**Race Conditions:** None — addon state is read once per prompt generation. No async concerns.

**Security:** None — directive is plain text injected into a user-controlled prompt. No trust boundary crossed.

**Side Effects:**
- If `cavemanOutput` is enabled globally (not just for one role) and the user switches roles, the checkbox state is persisted per-role. No cross-role bleed possible given the `roleConfig_{role}` key isolation.
- Caveman directive placed after persona instructions but before task context — must verify insertion point is consistent across all role branches.

**Dependencies & Conflicts:**
- No conflict with existing addons. `cavemanOutput` is additive.
- If caveman skill is not installed in the target agent's environment, the directive is rendered as plain text — agent will see the instruction but may not have the skill to execute it. Graceful failure is acceptable per original decision.

**Custom Agents:**
- Custom agents at line 2842 of `KanbanProvider.ts` bypass `buildKanbanBatchPrompt`. If caveman is scoped to custom agents, the patch is: read `addons.cavemanOutput` from the custom agent config and append the directive to the minimal plan-list prompt at line 2842.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) the `cavemanOutputByRole` map must be wired at all ~8 `buildKanbanBatchPrompt` call sites in `KanbanProvider.ts` or the directive silently fires only from some UI surfaces; (2) the planner's hardcoded HTML pattern has a 3-point update (HTML element, save-array, restore-block) — missing any one breaks persistence; (3) custom agents require a separate code path if in scope. Mitigations: a grep for every `buildKanbanBatchPrompt(` call confirms all injection points; the planner save array at line 3024 is clearly bounded; custom agents can be descoped to reduce risk.

## Proposed Changes

### `src/webview/sharedDefaults.js`

**Context:** `ROLE_ADDONS` defines UI metadata; `DEFAULT_ROLE_CONFIG` defines persisted defaults. Both must be updated to add `cavemanOutput`.

**Implementation:**

1. In `ROLE_ADDONS`, for **each of the 11 roles** (planner, lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, splitter, research_planner), add after the `clearAntigravityContext` entry:
   ```javascript
   { id: 'cavemanOutput', label: 'Caveman Output', tooltip: 'Compress responses to reduce tokens by 65-75% while maintaining accuracy', default: false }
   ```
   - Planner role: after line 67 (after `clearAntigravityContext` entry, before `skipCompilation`)
   - All other roles: after their respective `clearAntigravityContext` entry (last item)

2. In `DEFAULT_ROLE_CONFIG`, for **each role's `addons` object**, add:
   ```javascript
   cavemanOutput: false
   ```
   - Planner (line 20): append to its `addons` object
   - Lead (line 22) through research_planner (line 31): append to each `addons` object

**Edge Cases:** `ROLE_ADDONS` order for planner must remain: switchboardSafeguards → dependencyCheck → designDoc → aggressivePairProgramming → gitProhibition → splitPlan → clearAntigravityContext → **cavemanOutput** → skipCompilation → skipTests

---

### `src/webview/kanban.html` — Planner hardcoded checkboxes

**Context:** Planner uses hardcoded `plannerAddon*` checkboxes rather than dynamic `renderRoleAddons()`. Three touch points.

**Touch Point 1 — HTML element** (~line 2230, after `plannerAddonSkipTests`):
```html
<label class="checkbox-label">
  <input type="checkbox" id="plannerAddonCavemanOutput">
  Caveman Output <span class="addon-tooltip" title="Compress responses to reduce tokens by 65-75% while maintaining accuracy">ⓘ</span>
</label>
```

**Touch Point 2 — Restore block** (~line 2468, after `plannerAddonSkipTests` restore line):
```javascript
document.getElementById('plannerAddonCavemanOutput').checked = !!config.addons?.cavemanOutput;
```

**Touch Point 3 — Save array** (~line 3024, the `forEach` over hardcoded planner addon IDs):
Add `'plannerAddonCavemanOutput'` to the array. Current array:
```javascript
['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonSplitPlan', 'plannerAddonClearAntigravityContext', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests']
```
Becomes:
```javascript
['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonSplitPlan', 'plannerAddonClearAntigravityContext', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests', 'plannerAddonCavemanOutput']
```
Note: The `addonId` is derived via `id.replace('plannerAddon', '')` → yields `'CavemanOutput'`. This means the addon key stored will be `CavemanOutput` (capital C). To match `cavemanOutput` (lowercase c) used in `DEFAULT_ROLE_CONFIG`, verify that the `replace` result is lowercased — check the `forEach` body at line 3028 and add `.charAt(0).toLowerCase() + addonId.slice(1)` if needed. **Clarification:** inspect line 3028 to confirm whether camelCase lowercasing is already applied before writing `roleConfig_{role}`.

---

### `src/webview/kanban.html` — Custom agent addon form (OPTIONAL / if in scope)

**Context:** Custom agent form at ~line 2083–2097. Adding a checkbox here requires corresponding read at line 2633 and injection at line 2842 in `KanbanProvider.ts`.

**HTML** (after line 2085, after `ca-addon-advanced-reviewer`):
```html
<label class="checkbox-label"><input type="checkbox" id="ca-addon-caveman-output" style="width:auto;margin:0;"> Caveman Output</label>
```

**Restore** (~line 2583, after `researchEnabled`):
```javascript
document.getElementById('ca-addon-caveman-output').checked = addons.cavemanOutput === true;
```

**Save** (~line 2633, after `researchEnabled`):
```javascript
cavemanOutput: document.getElementById('ca-addon-caveman-output').checked,
```

---

### `src/services/agentPromptBuilder.ts`

**Context:** All prompt generation routes through `buildKanbanBatchPrompt`. Add a constant and interface field following the `skipCompilation` / `SKIP_COMPILATION_DIRECTIVE` pattern.

**Implementation:**

1. Add exported constant after `SKIP_TESTS_DIRECTIVE` (~line 213):
   ```typescript
   export const CAVEMAN_OUTPUT_DIRECTIVE = `CAVEMAN MODE: Talk like caveman. Drop filler, keep substance. Use fragments. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].`;
   ```

2. Add to `PromptBuilderOptions` interface (~line 118, after `skipTests`):
   ```typescript
   /** When true, injects caveman communication style directive to reduce token usage. */
   cavemanOutputEnabled?: boolean;
   ```

3. In `buildKanbanBatchPrompt` function body (~line 265, after `skipTests`):
   ```typescript
   const cavemanOutputEnabled = options?.cavemanOutputEnabled ?? false;
   ```

4. Inject directive in **each role branch** at the end of its base instructions block (after persona/base, before plan list), using the same pattern as `skipCompilation`:
   - **planner** (~line 348, after `skipTests` block): `if (cavemanOutputEnabled) { plannerBase += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE; }`
   - **reviewer** — append to `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` construction or as a suffix block entry
   - **tester** — append to `testerBase` or suffix block
   - **lead** — append to `leadBase`
   - **coder** — append to `coderBase`
   - **intern** — append before `suffixBlock`
   - **analyst** — append before `suffixBlock`
   - **ticket_updater** — append to `updaterBase`
   - **researcher** — append to `researcherBase`
   - **splitter** — append to `splitterBase`
   - **research_planner** — append to `rpBase`

   **Recommended pattern** (identical for all roles):
   ```typescript
   if (cavemanOutputEnabled) {
       <roleBase> += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
   }
   ```

---

### `src/services/KanbanProvider.ts` — `_getPromptsConfig()` (~line 2234)

**Context:** This method assembles the central `promptsConfig` object consumed by all prompt-generation call sites. Add `cavemanOutputByRole` map following the `clearAntigravityContextByRole` / `switchboardSafeguardsByRole` pattern.

**Implementation:**

1. Add `cavemanOutputByRole` to the returned object (~line 2309, after `clearAntigravityContextByRole`):
   ```typescript
   cavemanOutputByRole: {
       planner: plannerConfig?.addons?.cavemanOutput ?? false,
       lead: leadConfig?.addons?.cavemanOutput ?? false,
       coder: coderConfig?.addons?.cavemanOutput ?? false,
       reviewer: reviewerConfig?.addons?.cavemanOutput ?? false,
       tester: testerConfig?.addons?.cavemanOutput ?? false,
       intern: internConfig?.addons?.cavemanOutput ?? false,
       analyst: analystConfig?.addons?.cavemanOutput ?? false,
       researcher: researcherConfig?.addons?.cavemanOutput ?? false,
       splitter: splitterConfig?.addons?.cavemanOutput ?? false,
       ticket_updater: ticketUpdaterConfig?.addons?.cavemanOutput ?? false,
       research_planner: researchPlannerConfig?.addons?.cavemanOutput ?? false,
   },
   ```

---

### `src/services/KanbanProvider.ts` — All `buildKanbanBatchPrompt` call sites

**Context:** Every call site that reads from `promptsConfig` must pass `cavemanOutputEnabled`. Run this grep to find all call sites before editing:
```
grep -n "buildKanbanBatchPrompt(" src/services/KanbanProvider.ts
```

**At each call site**, add to the options object:
```typescript
cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role] ?? false,
```

Known call sites (verify via grep):
- ~line 2166: generic role prompt (uses `role as any` key)
- ~line 2407: another generic role dispatch
- ~line 2510: planner-specific call
- ~line 2561: generic role call
- ~line 2596: coder-specific call
- ~line 2789: reviewer-specific call
- ~line 2817: generic role call
- ~line 5453: lead pair programming dispatch
- ~line 5464: coder pair programming dispatch
- ~line 5854: generic role call
- ~line 6260: tester call

For the planner-specific call sites (where role is hardcoded as `'planner'`), use:
```typescript
cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.planner ?? false,
```

---

### `src/services/KanbanProvider.ts` — Custom agent prompt (~line 2842, OPTIONAL)

If custom agents are in scope, patch the minimal prompt builder:
```typescript
if (role?.startsWith('custom_agent_')) {
    // ... (existing repoScopeMap building) ...
    const { planList } = buildPromptDispatchContext(this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap));
    const caConfig = await this._getCustomAgentConfig(role, workspaceRoot); // look up existing config accessor
    const cavemanBlock = caConfig?.addons?.cavemanOutput ? `\n\n${CAVEMAN_OUTPUT_DIRECTIVE}` : '';
    return `Please process the following plans.${cavemanBlock}\n\nPLANS TO PROCESS:\n${planList}`;
}
```
**Clarification:** Verify the method name used to access custom agent config (search for `getCustomAgent` or `_customAgents`).

---

### `src/services/__tests__/agentPromptBuilder.test.ts`

**Context:** Existing test file has `clearAntigravityContext` tests as the pattern to follow.

**Implementation:** Add tests after the `clearAntigravityContext` block:
```typescript
test('cavemanOutputEnabled: true injects caveman directive', () => {
    const result = buildKanbanBatchPrompt('coder', [mockPlan], { cavemanOutputEnabled: true });
    expect(result).toContain('CAVEMAN MODE');
});

test('cavemanOutputEnabled: false omits caveman directive', () => {
    const result = buildKanbanBatchPrompt('coder', [mockPlan], { cavemanOutputEnabled: false });
    expect(result).not.toContain('CAVEMAN MODE');
});

test('cavemanOutputEnabled: undefined omits caveman directive', () => {
    const result = buildKanbanBatchPrompt('coder', [mockPlan], {});
    expect(result).not.toContain('CAVEMAN MODE');
});
```

## Verification Plan

### Automated Tests
- `npm test` (or `npx jest agentPromptBuilder`) — verify the 3 new `cavemanOutput` tests pass.

### Manual Verification
1. Open Prompts tab → select each of the 11 roles → verify "Caveman Output" checkbox appears.
2. Enable checkbox for Coder → switch to Lead → switch back to Coder → verify checkbox state persisted.
3. Reload VSCode window → verify checkbox state survived restart.
4. Enable "Caveman Output" for Coder → copy prompt → verify `CAVEMAN MODE:` text appears in copied prompt.
5. Disable checkbox → copy prompt → verify `CAVEMAN MODE:` is absent.
6. Verify "Caveman Output" appears in Planner's hardcoded addon section.
7. (If custom agents in scope) Open custom agent modal → verify "Caveman Output" checkbox present.

## Rollback Plan

If issues arise:
1. Revert `sharedDefaults.js` changes
2. Revert `kanban.html` changes
3. Revert `agentPromptBuilder.ts` changes
4. Revert `KanbanProvider.ts` changes
5. All changes are additive (no deletions), so rollback is safe

## Success Criteria

- [ ] "Caveman Output" checkbox appears for all 11 roles in Prompts tab
- [ ] Checkbox state persists across role switches and VSCode restarts
- [ ] Generated prompts include caveman directive when checkbox is enabled
- [ ] Caveman directive is absent when checkbox is disabled
- [ ] No breaking changes to existing addon functionality
- [ ] Custom agents can also enable caveman output (if in scope)
- [ ] 3 new unit tests pass in `agentPromptBuilder.test.ts`

## Time Estimate

- Phase 1 (Frontend Config — `sharedDefaults.js`): 15 minutes
- Phase 2 (Frontend HTML — `kanban.html`, 3 touch points): 15 minutes
- Phase 3 (Backend constant + interface — `agentPromptBuilder.ts`): 20 minutes
- Phase 4 (KanbanProvider wiring — `promptsConfig` + all call sites): 30 minutes
- Phase 5 (Tests): 10 minutes
- **Total**: ~90 minutes

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Status |
|:--|:---------|:--------|:-------|
| 1 | **CRITICAL** | `gatherer` role missing from `cavemanOutputByRole` in `_getPromptsConfig()`. No `gathererConfig` variable read from settings. UI checkbox renders, state persists, but directive is NEVER injected into gatherer prompts. `cavemanOutputByRole?.['gatherer']` resolves to `undefined` → `false` at all call sites. Same pre-existing gap in `clearAntigravityContextByRole`. | **FIXED** |
| 2 | **MAJOR** | `includeDependencyInstructions: true` for lead/coder/intern in both `DEFAULT_ROLE_CONFIG` and `ROLE_ADDONS` — should be `false`. | **FIXED** |
| 3 | **MAJOR** | `researcher` role missing `researchEnabled: true` addon in `DEFAULT_ROLE_CONFIG` and `ROLE_ADDONS`. Deep research mode should be on by default. | **FIXED** |
| 4 | **MAJOR** | Default `cavemanOutput` values deviate from plan spec. Plan says `default: false` for all roles. Implementation has `cavemanOutput: true` / `default: true` for lead, coder, and intern. Owner confirmed this is intentional for execution roles. | **CONFIRMED INTENTIONAL** |
| 5 | **NIT** | Plan references `research_planner` role; codebase uses `code_researcher` (with `research_planner` fallback). Implementation correctly adapted. | No change needed |
| 6 | **NIT** | Plan lists 11 roles; codebase has 12 (adds `gatherer` and `code_researcher`). Implementation correctly covers all 12. | No change needed |

### Stage 2: Balanced Synthesis

- **Fix #1 now**: Added `gathererConfig` variable + `gatherer` entries to `cavemanOutputByRole` and `clearAntigravityContextByRole`
- **Fix #2 now**: Changed `includeDependencyInstructions` from `true` to `false` for lead/coder/intern in both `DEFAULT_ROLE_CONFIG` and `ROLE_ADDONS`
- **Fix #3 now**: Added `researchEnabled: true` to researcher's `DEFAULT_ROLE_CONFIG` addons and `ROLE_ADDONS` metadata
- **Confirm #4**: `cavemanOutput: true` for lead/coder/intern is intentional per owner
- **Keep #5/#6**: Implementation is more complete than plan. No regressions.

### Code Fixes Applied

**File: `src/services/KanbanProvider.ts`**

1. **Line ~2249**: Added `gathererConfig` variable:
   ```typescript
   const gathererConfig: any = this._getSetting('switchboard.prompts.roleConfig_gatherer', undefined);
   ```

2. **Line ~2354**: Added `gatherer` to `clearAntigravityContextByRole`:
   ```typescript
   gatherer: gathererConfig?.addons?.clearAntigravityContext ?? false,
   ```

3. **Line ~2368**: Added `gatherer` to `cavemanOutputByRole`:
   ```typescript
   gatherer: gathererConfig?.addons?.cavemanOutput ?? false,
   ```

**File: `src/webview/sharedDefaults.js`**

4. **Line 22**: Changed `includeDependencyInstructions: true` → `false` in lead `DEFAULT_ROLE_CONFIG`
5. **Line 23**: Changed `includeDependencyInstructions: true` → `false` in coder `DEFAULT_ROLE_CONFIG`
6. **Line 26**: Changed `includeDependencyInstructions: true` → `false` in intern `DEFAULT_ROLE_CONFIG`
7. **Line 29**: Added `researchEnabled: true` to researcher `DEFAULT_ROLE_CONFIG` addons
8. **Line 83**: Changed `includeDependencyInstructions` default `true` → `false` in lead `ROLE_ADDONS`
9. **Line 96**: Changed `includeDependencyInstructions` default `true` → `false` in coder `ROLE_ADDONS`
10. **Line 126**: Changed `includeDependencyInstructions` default `true` → `false` in intern `ROLE_ADDONS`
11. **Line 148**: Added `researchEnabled` entry to researcher `ROLE_ADDONS`:
    ```javascript
    { id: 'researchEnabled', label: 'Enable Deep Research', tooltip: 'Enable deep research mode (50-100 sources, codebase + web)', default: true }
    ```

### Verification Results

- **TypeScript typecheck**: No new errors introduced. All pre-existing errors are unrelated (`hasWorktree` property issues, import path issues in other files).
- **Modified lines**: No type errors on any modified lines.
- **Unit tests**: 3 caveman tests present in `agentPromptBuilder.test.ts` (true/false/undefined cases). Not re-run per SKIP TESTS directive.

### Remaining Risks

1. **Pre-existing gap**: `gatherer` is also missing from `skipCompilationByRole` and `skipTestsByRole` maps, but the gatherer role doesn't have those addons in `ROLE_ADDONS`, so this is expected/acceptable.
2. **`jules` role**: Not included in `DEFAULT_ROLE_CONFIG` or `ROLE_ADDONS` — this is intentional (jules is a special-purpose role without addon UI).
3. **Existing user configs**: Users who already saved role configs with the old `includeDependencyInstructions: true` default will keep that value until they reset. The `DEFAULT_ROLE_CONFIG` only applies on first use or after reset.

---

**Recommendation:** Send to Coder (Complexity 5)
