# Part 0 — Directive Scope Bug Fix (ultracode/goal leak)

**Plan ID:** 29dc8ef1-b44d-4805-b7c0-6e7baf716abf
**Epic ID:** 8b50c095-b7c6-40b5-a9d6-2155b26fe4b6

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, ui

---

## Goal

Scope the ultracode/goal epic directives to `lead`/`coder`/`intern` only, and add a per-custom-role
opt-in (`applyEpicDirectives`), so execution-mode directives stop hijacking reviewer/tester prompts
and custom roles can opt in. Ships first — isolated, no schema changes, immediately shippable, and
de-risks the prompt path the later parts build on.

### Core problem & root cause

`generateUnifiedPrompt()` gates the epic directive prepend on `role !== 'planner'`
(`KanbanProvider.ts:~3315`), so the `/goal` + ultracode prefix is injected into **reviewer and
tester** prompts — execution-mode directives hijacking review-mode terminals. Root cause: the gate
is a denylist of one role instead of an allowlist of the execution roles. Separately, custom-agent
prompts **return early** (`KanbanProvider.ts:~3184`, via `buildCustomAgentPrompt`) *before* the
directive block (~3315), so custom roles never receive the directive at all even when appropriate.

---

## User Review Required

Yes — confirm the custom-agent checkbox wiring option (a vs b) in step 6 below.

## Complexity Audit

### Routine
- Allowlist gate swap (one line) + helper extraction (factor existing inline logic).
- `CustomAgentAddons` interface field addition + `sharedDefaults.js` entry — mirrors existing addon
  patterns.

### Complex / Risky
- Custom-agent checkbox wiring: bespoke UI work required (see step 6) — the AGENTS-tab form does
  not auto-render addon toggles.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — prompt building is synchronous per dispatch.
- **Security:** directive prefix is a fixed string (`GOAL_EPIC_PREFIX`/`ULTRACODE_EPIC_PREFIX`), no
  user input injection.
- **Side Effects:** reviewer/tester prompts that previously received the prefix will change — this
  is the intended fix, but any test asserting the old behavior must be updated.
- **Dependencies & Conflicts:** independent of all other parts. No schema change. Safe to ship as a
  standalone PR before Parts 1–4.

## Dependencies

- None. Part 0 is fully independent and de-risks the prompt path Parts 2–4 build on.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** `generateUnifiedPrompt()` (~3147) builds prompts for all roles; the epic-directive
  prepend block lives at ~3315.
- **Logic:**
  1. Extract the prefix logic (currently inline at ~3301–3315) into:
     ```
     private async _buildEpicDirectivePrefix(workspaceRoot): Promise<string>
     ```
     returns `''` when neither flag is set, else `"/goal\n"` and/or `"<ultracode>\n\n"` in the
     existing position-zero order. Single source of truth for both call sites.
  2. Built-in role gate (~3315). Replace:
     ```
     if (primaryPlan && primaryPlan.isEpic && role !== 'planner') {
     ```
     with an allowlist:
     ```
     if (primaryPlan && primaryPlan.isEpic && ['lead','coder','intern'].includes(role)) {
     ```
     Excludes reviewer, tester, planner, analyst, researcher, ticket_updater, chat.
  3. Custom-role injection (inside the `role.startsWith('custom_agent_')` branch, before the early
     `return buildCustomAgentPrompt(...)` at ~3184). If `primaryPlan?.isEpic` and
     `mergedAddons.applyEpicDirectives === true`, prepend `await _buildEpicDirectivePrefix(...)`
     to the built custom prompt. **VERIFIED during review:** this branch returns at ~3184–3189,
     BEFORE the epic-directive block at ~3315 — so custom agents never receive the directive today,
     confirming the premise. Confirm the exact line hasn't drifted at build time.
- **Edge Cases:** `primaryPlan` may be undefined for empty plan arrays — the existing
  `primaryPlan &&` guard covers this.

### `src/services/agentConfig.ts`
- **Context:** `CustomAgentAddons` interface (~3).
- **Logic:** add to `CustomAgentAddons`:
  ```
  applyEpicDirectives?: boolean;   // opt this custom role into epic ultracode/goal prefix
  ```

### `src/webview/sharedDefaults.js`
- **Context:** addon default lists per role (~60+).
- **Logic:** add to the custom-agent default addon list:
  ```
  { id: 'applyEpicDirectives', label: 'Apply epic ultracode/goal directives',
    tooltip: 'When dispatched on an epic, prepend the board\'s ultracode//goal directives (as for Lead/Coder/Intern).',
    default: false }
  ```

### `src/webview/kanban.html`
- **Context:** AGENTS-tab custom-agent form (`agentsTabSaveCustomAgent`, ~3570) + PROMPTS-tab addon
  renderer (~3371/3443/3496).
- **Logic:** **VERIFIED during review:** the AGENTS-tab custom-agent form collects ONLY name +
  startupCommand and never renders addon toggles; the PROMPTS-tab addon renderer iterates per
  built-in role from `sharedDefaults.js`, and there is NO custom-agent-specific addon default list
  in `sharedDefaults.js`. Therefore adding the entry to `sharedDefaults.js` alone will NOT
  auto-surface the checkbox. **Bespoke wiring IS required:** either (a) add a `customAgent` addon
  default list to `sharedDefaults.js` AND extend the PROMPTS-tab renderer to emit it for
  `custom_agent_*` roles, or (b) add a dedicated checkbox in the AGENTS-tab inline form that
  reads/writes `nextAgent.addons.applyEpicDirectives` (mirroring how `agentsTabSaveCustomAgent`
  already preserves `existing.addons`). Option (b) is the smaller change and matches the existing
  AGENTS-tab form pattern; prefer it.
- **Edge Cases:** preserve `existing.addons` on edit (already done at ~3594) so toggling the
  checkbox doesn't wipe other addon flags.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives — test suite run separately by the user.
  Tests to author for the separate run:
  - Assert `generateUnifiedPrompt('reviewer', …)` for an epic does NOT contain
    `GOAL_EPIC_PREFIX`/`ULTRACODE_EPIC_PREFIX`; assert `lead`/`coder`/`intern` DO; assert a
    `custom_agent_*` with `applyEpicDirectives:true` DOES and with `:false` does NOT.

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed line locations, the custom-agent early-return
  point (~3184), and the directive block (~3315) against current `src/`.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` introduced — forbidden per
  CLAUDE.md.

## Acceptance
- Dispatching an epic card with ultracode/goal ON injects the prefix into Lead/Coder/Intern
  terminals only; reviewer & tester terminals get the clean prompt.
- A custom agent with `applyEpicDirectives` ON receives the prefix; with it OFF, does not.
- Planner unaffected.

## Recommendation

Complexity 4 → **Send to Coder.** Single-file-ish, reuses existing prompt path, no schema. Ships
as an independent PR before Parts 1–4.
