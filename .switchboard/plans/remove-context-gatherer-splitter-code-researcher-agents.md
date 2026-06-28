# Remove Context Gatherer, Splitter, and Code Researcher Agents

## Goal

Delete three built-in agent roles — `gatherer` (Context Gatherer), `splitter` (Splitter Agent), and `code_researcher` (Code Researcher) — from the extension entirely. These roles exist as premature abstractions: gatherer duplicates "just move the card to Planner," splitter duplicates the pair programming feature, and code researcher duplicates what the Planner agent already does by default. Their presence in the Agents tab adds cognitive overhead without adding value, working against the principle that core features must be simple.

**Root cause:** These roles were added to handle preparation and decomposition steps that the existing workflow already covers. They survive as dead weight in the type system, UI, prompt builder, and providers.

**Code audit findings (verified against current source):** `code_researcher` is **not** in the `BuiltInAgentRole` union type (line 1 of `agentConfig.ts`) nor in `BUILT_IN_AGENT_LABELS` (lines 92–105) — only `gatherer` and `splitter` are. It is used as a role *string* throughout the codebase but was never added to the TypeScript type. Similarly, `VALID_KANBAN_COLUMNS` (line 631) and `CANONICAL_COLUMNS` (line 135) only contain `CONTEXT GATHERER` among the three column IDs — `SPLITTER` and `CODE_RESEARCHER` are not in either set. These facts simplify the removal: fewer type-level and validation-set edits than the original plan assumed.

## Migration

These three columns were hidden by default (`hideWhenNoAgent: true`, all `false` in default visibility). A small subset of users may have enabled them and left cards in these columns. On first activation after upgrade, migrate any stranded cards:

- Cards in `CONTEXT GATHERER` → move to `PLAN REVIEWED`
- Cards in `CODE_RESEARCHER` → move to `PLAN REVIEWED`
- Cards in `SPLITTER` → move to `PLAN REVIEWED`

Migration should run once during extension activation (version-gated or always-safe idempotent check). Archive the gatherer persona file as `.agents/personas/gatherer.md.migrated.bak` rather than deleting it (per migration policy for shipped content). No `splitter.md` or `code_researcher.md` persona files exist — only `gatherer.md`.

---

## Metadata

**Tags:** refactor, frontend, backend, ui
**Complexity:** 6

---

## User Review Required

Yes — before implementation, the user should confirm:

1. **Migration target**: All three columns migrate stranded cards to `PLAN REVIEWED`. Confirm this is the correct fallback column (it maps to the Planner agent, which subsumes all three roles' functionality).
2. **Persona archive**: Only `.agents/personas/gatherer.md` exists and will be archived. No `splitter.md` or `code_researcher.md` persona files exist to archive. Confirm.
3. **`code_researcher` type gap**: `code_researcher` is not in the `BuiltInAgentRole` union type — it's used as an untyped string throughout. The removal will clean up these string references but there's no type-level removal for it. Confirm this is understood.

---

## Complexity Audit

### Routine
- Removing `gatherer` and `splitter` from the `BuiltInAgentRole` union type (line 1 of `agentConfig.ts`)
- Removing `gatherer` and `splitter` from `BUILT_IN_AGENT_LABELS` (lines 93, 95 of `agentConfig.ts`)
- Removing three column definitions from `DEFAULT_KANBAN_COLUMNS` (lines 110, 112, 113 of `agentConfig.ts`)
- Removing `gatherer` and `splitter` from the `VALID_ROLES` array (line 402 of `agentConfig.ts`) — `code_researcher` is not in this array
- Removing three visibility defaults, three role config blocks, three addon config blocks, three label entries, and two `PROMPT_OVERRIDE_EXCLUDED_KEYS` entries from `sharedDefaults.js`
- Removing UI elements (checkboxes, dropdown options, descriptions, splitter button) from `kanban.html`
- Removing three prompt branches and three column-to-role mappings from `agentPromptBuilder.ts`
- Removing role config extractions, dispatch branches, and state initializations from `KanbanProvider.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`, and `implementation.html`
- Removing `CONTEXT GATHERER` from `VALID_KANBAN_COLUMNS` (line 631) and `CANONICAL_COLUMNS` (line 135)
- Archiving one persona file
- Updating 5 test files that reference these roles

### Complex / Risky
- **Multi-file coordination across 10+ source files**: Every file that references these three roles as strings, type values, or column mappings must be updated atomically. Missing any reference will cause either a TypeScript error (for typed references) or a silent dead-code path (for string-based references).
- **Migration of stranded cards**: Users with cards in `CONTEXT GATHERER`, `CODE_RESEARCHER`, or `SPLITTER` columns need a one-time migration. Since `CODE_RESEARCHER` and `SPLITTER` are not in `VALID_KANBAN_COLUMNS`, cards in those columns are already in a non-standard state (they'd be caught by the `SAFE_COLUMN_NAME_RE` fallback). The migration must handle all three.
- **`builtin-role-dispatch-coverage.test.js` self-adjusts**: This test dynamically extracts roles from `DEFAULT_KANBAN_COLUMNS` (line 76) and checks dispatch coverage. Once the three columns are removed from `DEFAULT_KANBAN_COLUMNS`, the test automatically stops expecting dispatch branches for those roles. No manual test changes needed for this file — but the implementer should verify the test still passes after the column definitions are removed.
- **`kanban-auto-export.test.ts` has no references**: The plan originally listed this file for updates, but a grep confirms zero matches for any of the three column names. No changes needed.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- The migration runs during extension activation, before any webview is ready. No concurrent access to `kanban.db` is expected at this point. The migration should use a transaction or the existing `_persistedUpdate` pattern.
- If the migration is idempotent (checks column existence before moving), re-running on a workspace where migration already ran is a safe no-op.

**Security**
- No security implications. The removal deletes dead code and UI elements. No new attack surface.

**Side Effects**
- Users who had enabled any of these three agents will see them disappear from the Agents tab on next activation. Their persisted role configurations (prompt overrides, addon settings) will remain in workspace state as orphaned keys — silently ignored once the roles are gone. Per the plan's Out of Scope, no cleanup of user-stored config data is needed.
- The `splitterSelected` action handler in `KanbanProvider.ts` (line 6778) and the corresponding UI button in `kanban.html` (lines 4620–4623) will be removed. Any keyboard shortcuts or external integrations that trigger `splitterSelected` will silently no-op.
- The `ICON_SPLITTER` constant (line 3869 of `kanban.html`) becomes dead — should be removed with the button code.
- The `preCodingColumns` array in `KanbanProvider.ts` (line 8140) includes `'CONTEXT GATHERER'`. Removing it changes the epic-grouping candidate set — cards in `CONTEXT GATHERER` will no longer be eligible for epic grouping. Since the column itself is being removed, this is correct.

**Dependencies & Conflicts**
- No external dependencies. All three roles are self-contained within the extension.
- The `builtin-role-dispatch-coverage.test.js` test dynamically derives its expected role set from `DEFAULT_KANBAN_COLUMNS` — it will self-adjust. No manual updates needed.
- The `kanban-auto-export.test.ts` test has no references to any of the three columns — no updates needed.
- **Sibling plan interaction**: The plan `keep-valid-kanban-columns-in-sync-with-defaults.md` proposes deriving `VALID_KANBAN_COLUMNS` from `DEFAULT_KANBAN_COLUMNS`. If that plan is implemented first, removing the three columns from `DEFAULT_KANBAN_COLUMNS` in this plan will automatically remove `CONTEXT GATHERER` from the derived `VALID_KANBAN_COLUMNS`. Coordinate ordering.

---

## Dependencies

No session dependencies. This plan is self-contained.

---

## Adversarial Synthesis

Key risks: (1) the original plan assumed `code_researcher` was in the `BuiltInAgentRole` type union and `BUILT_IN_AGENT_LABELS` — it is not, making those steps no-ops that could confuse the implementer; (2) `VALID_KANBAN_COLUMNS` and `CANONICAL_COLUMNS` only contain `CONTEXT GATHERER` among the three, not `SPLITTER` or `CODE_RESEARCHER` — the plan's "check and remove if present" steps are correct but the answer is already known; (3) the `builtin-role-dispatch-coverage.test.js` and `kanban-auto-export.test.ts` tests need no changes, contradicting the original plan's Step 13. Mitigations: corrected line numbers and presence/absence facts embedded in each step below; implementer should grep for all three role strings across `src/` before starting to catch any references the plan missed.

---

## Proposed Changes

### `src/services/agentConfig.ts` (Step 1)

**Context:** The canonical type definition and column definitions for all built-in roles.

**Implementation:**
- Line 1: Remove `'splitter' | 'gatherer'` from the `BuiltInAgentRole` union type. **`code_researcher` is NOT in this union** — it was never added. No change needed for `code_researcher` at the type level.
- Lines 93, 95: Remove `gatherer: 'Context Gatherer'` and `splitter: 'Splitter Agent'` from `BUILT_IN_AGENT_LABELS`. **`code_researcher` is NOT in this record** — no entry to remove.
- Line 110: Remove the `CODE_RESEARCHER` column definition (order 95, role `code_researcher`).
- Line 112: Remove the `SPLITTER` column definition (order 110, role `splitter`).
- Line 113: Remove the `CONTEXT GATHERER` column definition (order 50, role `gatherer`).
- Line 402: Remove `'splitter'` and `'gatherer'` from the `VALID_ROLES` array. **`code_researcher` is NOT in this array** — no entry to remove. (This array was not mentioned in the original plan.)

**Edge Cases:** After removing these from `BuiltInAgentRole`, any code that indexes `BUILT_IN_AGENT_LABELS` by `BuiltInAgentRole` will get a TypeScript error if it tries to access `gatherer` or `splitter` — this is the desired compile-time safety net.

### `src/webview/sharedDefaults.js` (Step 2)

**Context:** Shared default configuration for agent visibility, role configs, and addon metadata.

**Implementation:**
- Line 11: Remove `gatherer: false,` from the default visible-agents state.
- Lines 14–15: Remove `splitter: false,` and `code_researcher: false,` from the default visible-agents state.
- Line 35: Remove the `splitter` role config block from `DEFAULT_ROLE_CONFIG`.
- Line 36: Remove the `code_researcher` role config block from `DEFAULT_ROLE_CONFIG`.
- Line 37: Remove the `gatherer` role config block from `DEFAULT_ROLE_CONFIG`.
- Line 44: Remove `{ key: 'gatherer', label: 'Context Gatherer' }` from the `BUILT_IN_AGENT_LABELS` array.
- Line 46: Remove `{ key: 'code_researcher', label: 'Code Researcher' }` from the same array.
- Line 47: Remove `{ key: 'splitter', label: 'Splitter Agent' }` from the same array.
- Line 67: Remove `'splitter'` and `'code_researcher'` from `PROMPT_OVERRIDE_EXCLUDED_KEYS`. **`gatherer` is NOT in this set** — no entry to remove.
- Lines 215–228: Remove the `splitter` addon configuration block from `ROLE_ADDONS`.
- Lines 229–241: Remove the `code_researcher` addon configuration block from `ROLE_ADDONS`.
- Lines 242+: Remove the `gatherer` addon configuration block from `ROLE_ADDONS`.

**Edge Cases:** `ROLE_KEYS` (line 63) is derived from `Object.keys(DEFAULT_ROLE_CONFIG)` — it will automatically shrink when the three role configs are removed. No manual update needed.

### `src/webview/kanban.html` (Step 3)

**Context:** The Kanban board UI — Agents tab, role selector, column rendering, and splitter button.

**Implementation:**
- Lines 2714–2715: Remove the gatherer visibility checkbox block and its description.
- Lines 2732–2733: Remove the `code_researcher` visibility checkbox block and its description.
- Lines 2734–2735: Remove the `splitter` visibility checkbox block and its description.
- Lines 2800, 2802, 2803: Remove the three `<option>` entries from the role selector dropdown (`gatherer`, `code_researcher`, `splitter`).
- Lines 3219, 3220, 3221: Remove the three entries from the agent description map (`code_researcher`, `splitter`, `gatherer`).
- Lines 3313, 4013: Remove `code_researcher` from the read-only check conditions `(currentRole === 'planner' || currentRole === 'code_researcher')`. After removal, these become just `(currentRole === 'planner')`.
- Line 2948: Remove the comment referencing `code_researcher` in the Research Complexity section comment.
- Line 3869: Remove the `ICON_SPLITTER` constant.
- Lines 3750–3755: Remove the `CONTEXT GATHERER` column definition from the built-in columns array in the kanban HTML.
- Lines 4620–4623: Remove the `splitterBtn` definition (the `const splitterBtn = ...` block).
- Line 4655: Remove `${splitterBtn}` from the column header rendering template.
- Lines 4762, 4846–4855: Remove the `splitterSelected` case from the action handler switch. Also remove `action !== 'splitterSelected'` from the guard condition on line 4762.
- Lines 4988–4993: Remove the `updateSplitterButtonVisibility()` function.
- Lines 6493, 6694: Remove the two calls to `updateSplitterButtonVisibility()`.
- Lines 7879, 7881: Remove `'CONTEXT GATHERER': 'gatherer'` and `'SPLITTER': 'splitter'` from the column-to-role mapping object. **`CODE_RESEARCHER` is NOT in this mapping** — no entry to remove.

**Edge Cases:** The `ICON_SPLITTER` constant reuses `ICON_JULES` (line 3869 comment: "Reuses ICON_JULES token"). Removing it has no effect on `ICON_JULES`.

### `src/services/agentPromptBuilder.ts` (Step 4)

**Context:** The prompt builder generates agent-specific prompts for each role.

**Implementation:**
- Lines 1051–1086: Remove the `if (role === 'code_researcher')` prompt branch entirely.
- Lines 1088–1167: Remove the `if (role === 'splitter')` prompt branch entirely.
- Lines 1169–1185: Remove the `if (role === 'gatherer')` prompt branch entirely.
- Lines 1302, 1304, 1305: Remove the three column-to-role mapping entries from the switch: `case 'CONTEXT GATHERER': return 'gatherer'`, `case 'CODE_RESEARCHER': return 'code_researcher'`, `case 'SPLITTER': return 'splitter'`.
- Line 1284: Update the error message to remove `splitter` and `gatherer` from the listed built-in roles. **`code_researcher` is NOT listed in this error message** — only `splitter` and `gatherer` need removal. The message currently reads: `"...researcher, splitter, gatherer, orchestrator, chat."` → should become `"...researcher, orchestrator, chat."`.

**Edge Cases:** The `complexityScoringSkill` option (line 171 comment, line 1095 usage) is only used by the splitter branch. Once the splitter branch is removed, check if `complexityScoringSkill` is referenced elsewhere — if not, it can be removed from the options interface. However, it's defined in `CustomAgentAddons` (agentConfig.ts line 18) and may be used by custom agents — leave it in the interface, just remove the splitter-specific usage.

### `src/services/KanbanProvider.ts` (Step 5)

**Context:** The main Kanban board provider — handles dispatch, state, and column logic.

**Implementation:**
- Line 2579: Remove `'splitter'` from the `roles` array. **`code_researcher` and `gatherer` are NOT in this array** — only `'splitter'` needs removal.
- Line 2659: Remove `'code_researcher'` from the `roles` array (used for prompt previews). **`splitter` and `gatherer` are NOT in this array** — only `'code_researcher'` needs removal.
- Lines 3042, 3046: Remove the `else if (role === 'code_researcher')` and `else if (role === 'splitter')` conditional branches from the options resolution.
- Lines 3272–3276: Remove `splitterConfig`, `codeResearcherConfig`, and `gathererConfig` variable declarations and their `_getRoleConfig` calls.
- Lines 3289, 3291, 3292: Remove `splitter`, `code_researcher`, and `gatherer` entries from the `workflowFilePathEnabledByRole` object.
- Lines 3304, 3306, 3307: Remove same entries from `workflowFilePathByRole`.
- Lines 3341, 3343: Remove `splitter` and `code_researcher` entries from `skipCompilationByRole`. **`gatherer` is NOT in this object** — no entry to remove.
- Lines 3355, 3357: Remove `splitter` and `code_researcher` from `skipTestsByRole`. **`gatherer` is NOT in this object.**
- Lines 3376, 3378: Remove `splitter` and `code_researcher` from `gitProhibitionEnabledByRole`. **`gatherer` is NOT in this object.**
- Lines 3390, 3392: Remove `splitter` and `code_researcher` from `switchboardSafeguardsByRole`. **`gatherer` is NOT in this object.**
- Lines 3404, 3406, 3407: Remove `splitter`, `code_researcher`, and `gatherer` from `useSubagentsByRole`.
- Lines 3419, 3421, 3422: Remove same from `noSubagentsByRole`.
- Lines 3434, 3436, 3437: Remove same from `customSubagentNameByRole`.
- Lines 3455, 3457, 3458: Remove same from `clearAntigravityContextByRole`.
- Lines 3470, 3472, 3473: Remove same from `cavemanOutputByRole`.
- Line 3486: Remove `complexityScoringSkill: splitterConfig?.addons?.complexityScoringSkill ?? true` from the return object.
- Lines 4017–4018: Remove `splitter`, `code_researcher`, and `gatherer` from the non-execution roles condition.
- Lines 4372, 4375, 4376: Remove `gatherer: false`, `splitter: false`, `code_researcher: false` from the visible-agents state initialization.
- Lines 6778–6796: Remove the `case 'splitterSelected'` message handler block.
- Line 8140: Remove `'CONTEXT GATHERER'` from the `preCodingColumns` array. The array becomes `['CREATED', 'PLAN REVIEWED']`.
- Line 8321: Remove `case 'CONTEXT GATHERER': return 'gatherer'` from the column-to-role mapping.
- Lines 8855–8858: Update the epic-grouping prompt text that references `CONTEXT GATHERER` in the scope description. Change "Scope: CREATED, CONTEXT GATHERER, and PLAN REVIEWED columns only" to "Scope: CREATED and PLAN REVIEWED columns only."

**Edge Cases:** The `_getRoleConfig('code_researcher')` call at line 3274 has a fallback: `?? this._getRoleConfig('research_planner')`. This suggests `code_researcher` may have been renamed from `research_planner` at some point. Removing both the primary and fallback is correct since neither role will exist.

### `src/services/TaskViewerProvider.ts` (Step 6)

**Context:** The task viewer provider — handles single-card dispatch and column resolution.

**Implementation:**
- Lines 2020–2023: Remove three cases from the column-to-role switch: `case 'CONTEXT GATHERER': return 'gatherer'`, `case 'CODE_RESEARCHER': return 'code_researcher'`, `case 'SPLITTER': return 'splitter'`.
- Lines 2055–2057: Remove three cases from the role-to-column switch: `case 'code_researcher': return 'PLAN REVIEWED'`, `case 'splitter': return 'PLAN REVIEWED'`.
- Lines 2070–2071: Remove `case 'gatherer': return 'PLAN REVIEWED'` from the same switch.
- Lines 2081–2088: Remove three cases from the second column-to-role switch (in `_resolveDispatchRoleForColumn` or similar): `case 'CONTEXT GATHERER': return 'gatherer'`, `case 'CODE_RESEARCHER': return 'code_researcher'`, `case 'SPLITTER': return 'splitter'`.
- Line 2244: Remove `case 'CONTEXT GATHERER': return 'PLAN REVIEWED'` from the next-column mapping.
- Line 2915: Remove `'splitter': 'plan-split'` from the workflow map.
- Lines 3715, 3716, 3719: Remove `gatherer: false`, `code_researcher: false`, `splitter: false` from the visible agents defaults.
- Line 7539: Remove `'splitter'` from the `roles` array. **`code_researcher` and `gatherer` are NOT in this array.**

### `src/services/PlanningPanelProvider.ts` (Step 7)

**Context:** The planning panel provider — handles default visibility and dispatch.

**Implementation:**
- Lines 8276–8277: Remove `gatherer: false`, `splitter: false`, `code_researcher: false` from the `visibleAgentDefaults` object.
- Line 15897: Remove the `else if (role === 'gatherer')` dispatch branch.

### `src/webview/implementation.html` (Step 8)

**Context:** The implementation view onboarding screen.

**Implementation:**
- Line 3713: Remove `gatherer: false` from the `visibleAgents` object. **`splitter` and `code_researcher` are NOT in this object** — only `gatherer` is present. Leave the remaining keys untouched.

### `src/services/KanbanDatabase.ts` (Step 9)

**Context:** The database layer — `VALID_KANBAN_COLUMNS` drives export and validation.

**Implementation:**
- Line 631–633: Remove `'CONTEXT GATHERER'` from the `VALID_KANBAN_COLUMNS` set. **`SPLITTER` and `CODE_RESEARCHER` are NOT in this set** — verified by grep. The set currently is: `'CREATED', 'BACKLOG', 'CONTEXT GATHERER', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'`. After removal: 8 entries.
- This set drives `exportStateToFile()` (line 5466 iterates over it) and column validation in `updateColumnByPlanFile` (line 1434), `movePlanByPlanFile` (line 1491), `updateColumnWithEpicCascadeByPlanId` (line 3833), and `cascadeEpicByPlanId` (line 3884). All use `VALID_KANBAN_COLUMNS.has(newColumn) || SAFE_COLUMN_NAME_RE.test(newColumn)` — the fallback regex still allows custom column names, so cards in `SPLITTER` or `CODE_RESEARCHER` columns can still be moved (they pass the regex). This is correct for migration: the migration needs to move cards out of these columns, and the validation must not block the move.

**Edge Cases:** If the sibling plan `keep-valid-kanban-columns-in-sync-with-defaults.md` is implemented first, `VALID_KANBAN_COLUMNS` will be derived from `DEFAULT_KANBAN_COLUMNS` and this manual removal becomes unnecessary. Coordinate ordering.

### `src/services/ClickUpSyncService.ts` (Step 10)

**Context:** ClickUp sync — `CANONICAL_COLUMNS` mirrors `VALID_KANBAN_COLUMNS`.

**Implementation:**
- Lines 135–138: Remove `'CONTEXT GATHERER'` from the `CANONICAL_COLUMNS` array. **`SPLITTER` and `CODE_RESEARCHER` are NOT in this array** — verified by grep. The array currently is: `'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'CONTEXT GATHERER', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'`. After removal: 8 entries.

### Migration code (Step 11)

**Context:** One-time migration for stranded cards.

**Implementation:**
Add a one-time migration in the extension activation path (likely `extension.ts` or `KanbanProvider` init):
- For each workspace with a kanban state, query for cards where `kanban_column IN ('CONTEXT GATHERER', 'CODE_RESEARCHER', 'SPLITTER')`.
- Move any found cards to `PLAN REVIEWED` using the existing `movePlanByPlanFile` or `updateColumnByPlanFile` method.
- This check is idempotent — once those column IDs are removed from built-in definitions, re-running the migration finds zero cards.
- Gate with a version check or a persisted "migration_ran" flag to avoid running on every activation (though idempotency makes this optional).

**Edge Cases:** Cards in `CODE_RESEARCHER` and `SPLITTER` columns are already in a non-standard state (not in `VALID_KANBAN_COLUMNS`). The migration SQL should query by column name directly, not by `VALID_KANBAN_COLUMNS` membership.

### `.agents/personas/gatherer.md` (Step 12)

**Implementation:**
- Rename `.agents/personas/gatherer.md` → `.agents/personas/gatherer.md.migrated.bak`.
- **No `splitter.md` or `code_researcher.md` persona files exist** — verified by listing `.agents/personas/`. Only `gatherer.md` needs archiving.

### Tests (Step 13)

**Files that need updates:**

- `src/test/kanban-default-prompt-previews.test.js`:
  - Lines 45, 47: Remove `splitter: false` and `code_researcher: false` from the visible agents test fixture.
  - Lines 58, 60: Remove same from the second fixture.
  - Line 85: Remove `'code_researcher'` from the `roles` array. **`splitter` and `gatherer` are NOT in this array.**

- `src/services/__tests__/KanbanProvider.test.ts`:
  - Lines 143–144: Remove `SPLITTER` and `CONTEXT GATHERER` column definitions from the test's expected `DEFAULT_KANBAN_COLUMNS`.
  - Lines 163, 169, 175, 181, 187, 193, 199, 205, 211, 217: Remove `splitter: false, gatherer: false` from all `stubDeps` calls (10 occurrences). **`code_researcher` is NOT in these stubs.**
  - Lines 168–172: Remove or update the test "PLAN REVIEWED -> next skips SPLITTER and CONTEXT GATHERER when invisible" — after removal, these columns won't exist, so the skip behavior changes. The test should be updated to reflect that PLAN REVIEWED -> next goes to LEAD CODED directly (which is what it already asserts, just with different reasoning).
  - Lines 210–214: Remove the test "Recovery: CONTEXT GATHERER -> next advances to LEAD CODED" — the column will no longer exist.

- `src/services/__tests__/agentPromptBuilder.test.ts`:
  - Lines 178–183: Remove the `code_researcher` test suite.
  - Lines 220–221: Remove the `CODE_RESEARCHER → code_researcher` mapping test.
  - Lines 224–225: Remove the `SPLITTER → splitter` mapping test.
  - Lines 232–233: Remove the `CONTEXT GATHERER → gatherer` mapping test.

- `src/test/agent-prompt-builder-subagents.test.js`:
  - Lines 238–268: Remove the `testCodeResearcherAndResearcherPrompts` function (or remove only the `code_researcher` portion if the researcher portion should remain). The function tests both `code_researcher` and `researcher` — only the `code_researcher` parts (lines 242–254) should be removed; the researcher parts (lines 255–267) should stay.

- `src/test/minimal-prompt.test.js`:
  - Line 183: Remove `'code_researcher'` and `'splitter'` from the `roles` array. **`gatherer` is NOT in this array.**
  - Lines 220–222: Remove the `if (role === 'code_researcher')` option-setting block.

**Files that need NO updates:**

- `src/test/builtin-role-dispatch-coverage.test.js`: **No changes needed.** This test dynamically extracts roles from `DEFAULT_KANBAN_COLUMNS` (line 76) and checks dispatch coverage. Once the three columns are removed from `DEFAULT_KANBAN_COLUMNS`, the test automatically stops expecting dispatch branches for those roles. The original plan incorrectly listed this file for updates.

- `src/test/kanban-auto-export.test.ts`: **No changes needed.** A grep confirms zero matches for `CONTEXT GATHERER`, `SPLITTER`, `CODE_RESEARCHER`, `gatherer`, `splitter`, or `code_researcher` in this file. The original plan incorrectly listed this file for updates.

---

## Verification Plan

### Automated Tests

Per session directives, automated tests are **not run** in this planning pass — the suite will be run separately by the user. The following describes what to verify when implementation lands:

- **TypeScript compilation**: After removing `gatherer` and `splitter` from `BuiltInAgentRole`, run `tsc` (or the project's typecheck step) to catch any remaining typed references. `code_researcher` is untyped so it won't produce type errors — grep for the string `'code_researcher'` across `src/` to catch stragglers.
- **Grep verification**: After all edits, run `grep -rn "gatherer\|splitter\|code_researcher\|CONTEXT GATHERER\|SPLITTER\|CODE_RESEARCHER" src/` — the only remaining hits should be in test files (if any test references were missed) or in migration code (which intentionally references the old column names).
- **KanbanProvider.test.ts**: The column-skipping tests need careful updates. After removing SPLITTER and CONTEXT GATHERER from the test's expected column list, verify `_getNextColumnId` tests still pass — the column traversal order changes.
- **builtin-role-dispatch-coverage.test.js**: Should pass without modification — verify it does.
- **kanban-auto-export.test.ts**: Should pass without modification — verify it does.

### Manual Verification

1. Open the Kanban board — confirm the Agents tab no longer shows Context Gatherer, Code Researcher, or Splitter Agent checkboxes.
2. Confirm the role selector dropdown no longer offers these three roles.
3. Confirm the PLAN REVIEWED column header no longer shows the splitter button.
4. Place a test card in `CONTEXT GATHERER` column (via direct DB edit), restart the extension — confirm the migration moves it to `PLAN REVIEWED`.
5. Confirm `.agents/personas/gatherer.md.migrated.bak` exists and `.agents/personas/gatherer.md` does not.

---

## Out of Scope

- `.switchboard/plans/*.md` files that document past features for these agents — leave as historical record.
- User-stored role configuration data in VS Code workspace/global state — silently ignored once the keys are gone; no cleanup needed.
- The `complexityScoringSkill` option in `CustomAgentAddons` — leave the interface field; just remove the splitter-specific usage.
- The `research_planner` fallback at `KanbanProvider.ts:3274` — removing `codeResearcherConfig` removes both the primary and fallback; no separate cleanup needed.

---

## Recommendation

Complexity 6 → **Send to Coder**
