# Default Three Orchestrator Options OFF (Recompile / Tests / Switchboard Safeguards)

## Goal

For the **Orchestrator** role in the Kanban panel's Prompts tab, three options currently default to **ON** but should default to **OFF**, so the epic orchestrator has more freedom in how it approaches a task:

1. **Switchboard Safeguards** (`switchboardSafeguards`)
2. **Do not recompile the project** (`skipCompilation`)
3. **Do not run automated tests** (`skipTests`)

### Problem analysis & root cause

The orchestrator's option defaults are duplicated across **three locations**, and all three must change in lockstep — otherwise the UI and the actual generated prompt disagree.

**Location A — UI render fallback (`src/webview/sharedDefaults.js`, `ROLE_ADDONS.orchestrator`):**
```js
{ id: 'switchboardSafeguards', ..., default: true },  // 271
{ id: 'skipCompilation', ..., default: true },        // 275
{ id: 'skipTests', ..., default: true },              // 276
```
This `default` is what the checkbox uses when no stored value exists (`renderRoleAddons` → `roleConfigs[role]?.addons?.[id] ?? addon.default`).

**Location B — seed config (`src/webview/sharedDefaults.js`, `DEFAULT_ROLE_CONFIG.orchestrator`, line 38):**
```js
orchestrator: { prompt: '', addons: { switchboardSafeguards: true, ..., skipCompilation: true, skipTests: true, ... } }
```
This object seeds the webview's `roleConfigs` and is the fallback when no `roleConfig_orchestrator` setting is stored.

**Location C — backend prompt-builder fallbacks (`src/services/KanbanProvider.ts`):** the prompt is actually assembled here with its own `?? <default>` fallbacks, independent of the webview:
```ts
// :3314 (skipCompilationByRole)
orchestrator: orchestratorConfig?.addons?.skipCompilation ?? true,
// :3328 (skipTestsByRole)
orchestrator: orchestratorConfig?.addons?.skipTests ?? true,
// :3363 (switchboardSafeguardsByRole)
orchestrator: orchestratorConfig?.addons?.switchboardSafeguards ?? true,
```
*(Line numbers updated post-implementation review; the plan's original :3289/:3303/:3338 references had drifted due to intervening commits.)*

If only A/B change but C is left at `?? true`, a user who never touched the orchestrator config sees the boxes unchecked in the UI but the prompt still injects the safeguards/skip directives. **All three locations must flip to `false` together.**

The change is strictly scoped to the orchestrator: every location keys defaults by explicit role name (`orchestrator:`), and the `KanbanProvider.ts` maps have one line per role — only the `orchestrator:` line in each of the three maps changes; `coder`/`lead`/`reviewer`/`planner`/etc. keep their current `?? true`/`?? false` values.

### Verification findings (code confirmed during planning)

All claims above were checked directly against `src/` (single source of truth) during this planning pass:

- **Location A** — `ROLE_ADDONS.orchestrator` (`sharedDefaults.js:270-286`): `switchboardSafeguards` (`:271`), `skipCompilation` (`:275`), `skipTests` (`:276`) are each `default: true`. Confirmed exact.
- **Location B** — `DEFAULT_ROLE_CONFIG.orchestrator` (`sharedDefaults.js:38`): contains `switchboardSafeguards: true, … skipCompilation: true, skipTests: true`, alongside `subagentPolicy: 'useSubagents'`, `cavemanOutput: true`, `gitProhibition: true`, `ultracode: false`, etc. Confirmed exact.
- **Location C** — `KanbanProvider.ts`: `:3314` (`skipCompilationByRole.orchestrator ?? true`), `:3328` (`skipTestsByRole.orchestrator ?? true`), `:3363` (`switchboardSafeguardsByRole.orchestrator ?? true`). Confirmed exact. Each `…ByRole` map has exactly one line per role keyed by explicit name, so the orchestrator line can be edited without touching any other role. *(Line numbers reflect post-implementation review state; original plan cited :3289/:3303/:3338.)*
- **No fourth location** — a repo-wide grep for `skipCompilation`/`skipTests`/`switchboardSafeguards` co-occurring with `orchestrator` returns only Locations A/B/C plus the test file (below). No other code path seeds or reads these orchestrator defaults.
- **Existing test is independent of the defaults** — `src/test/orchestrator-prompt.test.js` exercises the prompt assembler `buildKanbanBatchPrompt('orchestrator', …)` by passing `switchboardSafeguardsEnabled`/`skipCompilation`/`skipTests` **explicitly** as inputs. It never relies on the webview defaults or the `KanbanProvider` `?? true` fallback, so flipping the defaults does **not** change any assertion. No test changes are required.

### Decision on existing stored configs (no migration)

The Orchestrator role is **unreleased dev work** — it was added 2026-06-25 (commit "Add Orchestrator Agent to the Kanban Agents Tab and Prompt Builder") and is hidden by default (`default: false` in `DEFAULT_VISIBLE_AGENTS`, confirmed at `sharedDefaults.js:18`). It has not shipped in a released version, so per the project migration rule, unreleased features can take a **clean break — no migration**. Therefore: change the three default locations only. New installs and any user who never opened the orchestrator config will pick up the new OFF defaults.

Caveat for the developer's own machine: if you previously opened the Orchestrator role config during dev testing, a `roleConfig_orchestrator` object with explicit `true` values may be persisted in the DB `config` table; because `??` only falls back on `null`/`undefined`, those stored `true`s would still win. To pick up the new defaults locally, clear the stored `switchboard.prompts.roleConfig_orchestrator` once (or simply re-toggle the three boxes off in the UI, which re-persists them). No production migration is warranted because the role never shipped.

## Metadata

- **Tags:** ux
- **Complexity:** 2 / 10
- **Primary files:** `src/webview/sharedDefaults.js`, `src/services/KanbanProvider.ts`
- **Affected feature area:** Kanban panel → Prompts tab → Orchestrator role; orchestrator prompt generation

## User Review Required

- **None.** The desired behaviour is fully specified by the user request (default the three named orchestrator options OFF). The no-migration decision follows directly from the project's documented rule for unreleased state, and the change is a default flip rather than data destruction. There are no open product questions.

## Complexity Audit

### Routine
- Six literal `true` → `false` edits across two files, all on `orchestrator`-keyed lines, reusing the existing default/fallback patterns already present for every other role.
- No new control flow, no schema/state changes, no migrations, no UI markup changes.
- Each `…ByRole` map in `KanbanProvider.ts` is keyed by explicit role name with one line per role, so the orchestrator edits are mechanically isolated.

### Complex / Risky
- The only real risk is **missing one of the three locations**, which would desync the UI checkboxes from the generated prompt. The plan enumerates all three explicitly (and grep-confirmed there is no fourth) to prevent that. This is a known-and-mitigated risk, not an open one.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. These are static default literals / nullish-coalescing fallbacks read synchronously when rendering the UI or building a prompt. No async ordering, no shared mutable state introduced.
- **Security:** None. No auth, input handling, file, or network surface is touched. Disabling "Switchboard Safeguards" by default reduces injected prompt directives; it does not weaken any access control.
- **Side Effects:**
  - **UI ↔ backend consistency:** A and B (webview) plus C (backend) must all change; verification includes inspecting a generated orchestrator prompt to confirm the directives are absent by default.
  - **Role isolation:** only `orchestrator:` lines change. Confirm `coder`/`lead`/`reviewer`/`intern` keep `skipCompilation`/`skipTests`/`switchboardSafeguards = true` and `planner`/`tester`/`analyst` keep their existing values.
  - **Other orchestrator defaults out of scope:** `gitProhibition` (`KanbanProvider.ts:3349`, `sharedDefaults.js:272/38`), `cavemanOutput`, and `subagentPolicy: 'useSubagents'` remain unchanged; only the three named options flip.
  - **Existing test:** `src/test/orchestrator-prompt.test.js` is unaffected (passes flags explicitly — see Verification findings).
- **Dependencies & Conflicts:**
  - **No migration / no shipped state:** orchestrator is unreleased (decided in Goal) — no DB migration. The change is a default flip, not data destruction, so it does not violate the migration rule even if treated conservatively.
  - **`??` semantics:** the backend fallbacks use nullish coalescing, so an explicitly stored value (true or false) always wins over the default — intended behaviour; users who deliberately enable a safeguard keep it. This is also why a stale dev-machine `roleConfig_orchestrator` may mask the new defaults locally (see Goal caveat).
  - **No confirmation dialogs** involved (consistent with the project's hard no-confirm rule).

## Dependencies

- None. This change has no upstream session/plan dependencies and shares no code with other in-flight plans (it touches only `orchestrator:` lines).

## Adversarial Synthesis

**Risk Summary:** The dominant risk is partial application — flipping the webview defaults (A/B) without the backend fallback (C), leaving the UI and the generated prompt silently disagreeing; the plan mitigates this by enumerating all three locations and grep-confirming no fourth exists. A secondary risk is collateral key loss when editing Location B's single-line object literal, mitigated by making three surgical in-line replacements rather than rewriting the whole line. The unreleased status of the role makes a stale dev-machine `roleConfig_orchestrator` (explicit `true`s that `??` will not override) the only thing that can make the change appear ineffective locally — documented and harmless in production.

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` — Location A (`ROLE_ADDONS.orchestrator`)

- **Context:** This array drives the checkbox render fallback (`roleConfigs[role]?.addons?.[id] ?? addon.default`) when no stored value exists.
- **Logic:** Flip the `default` field on the three options from `true` to `false`.
- **Implementation:** (lines 271/275/276)
```js
{ id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: '...', default: false },  // was true
{ id: 'skipCompilation',       label: 'Do not recompile the project', tooltip: '...', default: false },  // was true
{ id: 'skipTests',             label: 'Do not run automated tests', tooltip: '...', default: false },  // was true
```
- **Edge Cases:** Leave every other option in `ROLE_ADDONS.orchestrator` (`gitProhibition`, `cavemanOutput`, `subagentPolicy` default `'useSubagents'`, `useWorktreesPerPlan`, `workflowFilePath`, `ultracode`) untouched.

### 2. `src/webview/sharedDefaults.js` — Location B (`DEFAULT_ROLE_CONFIG.orchestrator`, line 38)

- **Context:** Seeds the webview's `roleConfigs` and is the fallback when no `roleConfig_orchestrator` setting is stored.
- **Logic:** Flip `switchboardSafeguards`, `skipCompilation`, `skipTests` to `false` within the addons object.
- **Implementation (resulting line):**
```js
orchestrator: { prompt: '', addons: { switchboardSafeguards: false, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: false, skipTests: false, subagentPolicy: 'useSubagents', customSubagentName: '', useWorktreesPerPlan: false, workflowFilePathEnabled: false, workflowFilePath: '', ultracode: false } },
```
(Changed: `switchboardSafeguards`, `skipCompilation`, `skipTests` → `false`.)
- **Edge Cases / Clarification:** Prefer **three surgical in-line replacements** (`switchboardSafeguards: true` → `false`, `skipCompilation: true` → `false`, `skipTests: true` → `false`) over rewriting the entire single-line object, to avoid accidentally dropping a sibling key. Critically, `subagentPolicy: 'useSubagents'` and `ultracode: false` must be preserved verbatim.

### 3. `src/services/KanbanProvider.ts` — Location C (backend prompt-builder fallbacks)

- **Context:** The orchestrator prompt's effective default is decided here; these resolved booleans are passed to `buildKanbanBatchPrompt`. With `??`, an explicitly stored config value still wins.
- **Logic:** Flip the orchestrator fallback in each of the three `…ByRole` maps from `?? true` to `?? false`.
- **Implementation:**
```ts
// :3314 — skipCompilationByRole
orchestrator: orchestratorConfig?.addons?.skipCompilation ?? false,   // was ?? true
// :3328 — skipTestsByRole
orchestrator: orchestratorConfig?.addons?.skipTests ?? false,         // was ?? true
// :3363 — switchboardSafeguardsByRole
orchestrator: orchestratorConfig?.addons?.switchboardSafeguards ?? false, // was ?? true
```
- **Edge Cases:** Leave every other role's line in these three maps unchanged (e.g. `lead`/`coder`/`reviewer`/`intern` stay `?? true`; `planner`/`tester`/`analyst`/etc. keep their existing values). Do not touch `gitProhibitionByRole.orchestrator` (`:3349`, stays `?? true`) or `useSubagentsByRole.orchestrator` (`:3378`).

## Verification Plan

> Session note: compilation and automated tests are run separately by the user. The build/test steps below remain as instructions for the implementer/user; they are not executed during this planning pass.

### Automated Tests
- **Existing orchestrator test (`src/test/orchestrator-prompt.test.js`):** expected to continue passing unchanged. It passes `switchboardSafeguardsEnabled`/`skipCompilation`/`skipTests` explicitly to `buildKanbanBatchPrompt`, so it does not depend on the defaults being flipped. No new or modified tests are required for this change.

### Manual Verification
1. **Build:** `npm run compile` succeeds (run by the user/implementer).
2. **Fresh-default UI:** with no stored `roleConfig_orchestrator` (clear it if present), open Kanban → Prompts → Orchestrator. Confirm "Switchboard Safeguards", "Do not recompile the project", and "Do not run automated tests" are **unchecked** by default.
3. **Generated prompt reflects defaults:** preview/generate an orchestrator prompt with the defaults untouched. Confirm it does **not** include the switchboard safeguards block, and does **not** include the "do not recompile" / "do not run tests" directives.
4. **Explicit ON still works:** check all three boxes, regenerate the prompt, and confirm the directives now appear (the `??` fallback is overridden by the stored `true`).
5. **Other roles unaffected:** open the Coder and Lead roles — their "Do not recompile" / "Do not run automated tests" / "Switchboard Safeguards" remain checked by default; generated coder/lead prompts are unchanged.

---

**Recommendation:** Complexity 2/10 → **Send to Intern.** Six role-isolated literal edits across two files, fully enumerated and code-verified, with no migration and no test changes.

---

## Reviewer Pass — Completed 2026-06-26

### Stage 1: Grumpy Principal Engineer (adversarial)

- **CRITICAL:** None. All three locations flipped in lockstep; UI and backend agree. No desync.
- **MAJOR:** None. Role isolation verified across all three `…ByRole` maps — every non-orchestrator line unchanged. `gitProhibition.orchestrator` (`:3349`) stayed `?? true`. Seed-config siblings (`subagentPolicy: 'useSubagents'`, `ultracode: false`, `cavemanOutput: true`) preserved. Test file independent of defaults. No fourth location found via grep.
- **NIT-1:** Plan's Location C line numbers (`:3289`/`:3303`/`:3338`) and `gitProhibitionByRole` (`:3324`) had drifted from the actual file (`:3314`/`:3328`/`:3363` and `:3349`) due to intervening commits. Edits landed in the correct place; references were stale. **Fixed in plan file.**

### Stage 2: Balanced Synthesis

- **Keep:** All six code edits — verified correct and role-isolated.
- **Fix now:** NIT-1 — corrected stale line references in the plan file (Goal, Verification findings, Proposed Changes #3, Edge-Case Audit). No code changes required.
- **Defer:** Nothing. Closed change.

### Code Fixes Applied

None. The implementation matched the plan's intent exactly. Only the plan file's documentation was corrected (stale line numbers).

### Files Changed by Implementation (verified, not edited by reviewer)

- `src/webview/sharedDefaults.js` — Location A (`:271`, `:275`, `:276`: `default: false`), Location B (`:38`: three `false` values in seed config)
- `src/services/KanbanProvider.ts` — Location C (`:3314`, `:3328`, `:3363`: `?? false`)

### Files Changed by Reviewer

- `.switchboard/plans/feature_plan_20260626130004_orchestrator_default_checkboxes_off.md` — corrected stale line-number references only.

### Validation Results

- **Compilation:** Skipped per session instructions (run separately by user).
- **Automated tests:** Skipped per session instructions (run separately by user). `src/test/orchestrator-prompt.test.js` confirmed independent of defaults via static review.
- **Static verification (performed):**
  - Location A: 3/3 defaults confirmed `false`. ✓
  - Location B: 3/3 seed values confirmed `false`, siblings preserved. ✓
  - Location C: 3/3 fallbacks confirmed `?? false`. ✓
  - Role isolation: all non-orchestrator lines in the three maps unchanged. ✓
  - `gitProhibition.orchestrator` (`:3349`) confirmed `?? true` (out of scope, preserved). ✓
  - No fourth seeding location (grep-confirmed). ✓

### Remaining Risks

- **Dev-machine stale config:** A previously-persisted `roleConfig_orchestrator` with explicit `true` values will mask the new defaults locally (`??` only falls back on null/undefined). Documented in the plan's Goal caveat; not a production issue (role never shipped). Clear `switchboard.prompts.roleConfig_orchestrator` once or re-toggle the three boxes off to pick up new defaults locally.
- **No other risks identified.** The change is a closed, six-edit default flip with no migration, no schema change, and no test impact.
