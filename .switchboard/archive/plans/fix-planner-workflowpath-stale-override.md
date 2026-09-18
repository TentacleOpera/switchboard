# Fix: Planner Prompt Still Hands Agents the Dead `.agents/workflows/improve-plan.md` (Half-Ported Migration)

## Goal

After the four-front-doors refactor moved `improve-plan.md` to `.agents/skills/improve-plan/SKILL.md`, the generated **planner prompt still tells agents to read `.agents/workflows/improve-plan.md`** — a path that no longer exists — so planning dispatch fails UAT. The Prompts tab's "Workflow File Path" field also still displays the old path. Make every read of the planner workflow path resolve to the new skills location, clean the stale persisted value out of all tiers, and prevent it from being re-saved.

### Problem & root-cause analysis

**Symptom.** In Antigravity/UAT the planner prompt references `.agents/workflows/improve-plan.md`. The kanban Prompts tab shows that same dead path in the **Workflow File** section, even though the "edit prompt template" preview looks correct.

**The value is a persisted override, not a bad default.** The single-plan planner path resolves as `plannerConfig?.workflowFilePath || config.get('planner.workflowPath', '.agents/skills/improve-plan/SKILL.md')` at both prompt-generation read sites in `KanbanProvider.ts` (`:4585`, `:4620`). `plannerConfig` comes from `KanbanProvider._getRoleConfig('planner')` (`:4557`) → `getScopedRoleConfig('planner')` (`:524`), which resolves the planner role config from its persisted tiers (project_config → db config → globalState).

The source-code default was correctly repointed to the skills path (`agentPromptBuilder.ts:743`, `kanban.html:2981/3421`), **but a persisted `workflowFilePath` takes precedence over that default at every read.** That persisted value is still `.agents/workflows/improve-plan.md`, so it wins — the prompt embeds it (`:4620` → `agentPromptBuilder.ts:912` → `:934`), the Prompts-tab field shows it, and hitting **Save** on the Prompts tab writes it straight back (now as an explicit value), entrenching it.

**Root cause — the workflows→skills migration is half-ported.** `workflowFilePath` is stored in **four tiers** (documented at `TaskViewerProvider.ts:1059`): globalState role config, the VS Code `planner.workflowPath` setting, the workspace DB `config` table, and the DB `project_config` table. The earlier `.agent/`→`.agents/` migration correctly covered all four via **two** methods:
- `_migratePlannerWorkflowPathProfileTiers` (`:1079`) — globalState + VS Code setting, gated by the globalState flag `switchboard.plannerWorkflowPathAgentToAgents.v1`.
- `_migratePlannerWorkflowPathDbTiers` (`:1137`) — DB `config` + `project_config`, per-DB marker.

The new four-front-doors migration `_migratePlannerWorkflowPathWorkflowsToSkills` (`:1206`, marker `…WorkflowsToSkills.v1`) **only ported the DB half.** It rewrites `config` + `project_config` but has **no profile-tier counterpart** — globalState and the VS Code setting are never touched. On a dev/UAT machine the planner path is persisted in globalState (that is the tier the Prompts tab reads and re-saves), so the rewrite never reaches it and the dead path survives.

### Grounded facts (verified in code, 2026-07-12)

- **Both single-plan-planner read sites** are `plannerConfig?.workflowFilePath || config.get('planner.workflowPath', <new default>)` (`KanbanProvider.ts:4585, :4620`), inside `_getPromptsConfig`. `plannerConfig = this._getRoleConfig('planner')` (`:4557`) → `getScopedRoleConfig('planner')` (`:524`).

  > **Superseded:** ":4585 — `workflowFilePathByRole.planner` (what the Prompts-tab input displays)."
  > **Reason:** Verified wrong. `_getPromptsConfig`'s `workflowFilePathByRole.planner` (`:4585`) and `plannerWorkflowPath` (`:4620`) both feed **prompt generation only** — `:4585` flows to `resolvedOptions.workflowFilePath` (`KanbanProvider.ts:4413`), `:4620` flows to `options.plannerWorkflowPath` (`agentPromptBuilder.ts:912`). Neither reaches the Prompts-tab input. The tab input (`kanban.html:3420` `roleConfigs.planner.workflowFilePath`) is populated by a separate `getSetting`/`roleConfig_planner` round-trip that resolves through `KanbanService.getSetting` (`kanbanService.ts:205`) — or the fallback branch `KanbanProvider.ts:9106` — **both of which call `getScopedRoleConfig(role)` directly**, never `_getPromptsConfig`.
  > **Replaced with:** `getScopedRoleConfig` (`KanbanProvider.ts:524`) is the **single common ancestor** of both the Prompts-tab display *and* the prompt-generation reads. Guarding there fixes the display, the save-loop, and the prompt in one place (see §B). The `:4585/:4620` sites additionally layer a VS Code-setting fallback that `getScopedRoleConfig` does not cover, so wrap those expressions too.

- **UI is not the culprit:** `kanban.html:2981` default value and `:3421` load fallback are both `.agents/skills/improve-plan/SKILL.md`; the field only shows the old path because the *persisted* role config holds it.
- **The DB-only migration:** `_migratePlannerWorkflowPathWorkflowsToSkills` (`TaskViewerProvider.ts:1206-1264`) rewrites `OLD_DEFAULT='.agents/workflows/improve-plan.md'` → `NEW_DEFAULT='.agents/skills/improve-plan/SKILL.md'` for the `config` and `project_config` tiers only. It is chained at activation (`:526-527`, after `_migratePlannerWorkflowPathDbTiers`) but has no profile-tier sibling.
- **The template to mirror:** `_migratePlannerWorkflowPathProfileTiers` (`:1079-1130`) already shows exactly how to migrate globalState (read `getRoleConfig('roleConfig_planner')`, write `saveRoleConfig`) and the VS Code setting (`inspect` the scope, `update` in place).
- **Scope is the single-plan planner only.** `DEFAULT_FEATURE_PLANNER_WORKFLOW` (`:744`) is used directly at `agentPromptBuilder.ts:911` (no persisted override); the accuracy path is hardcoded (`agentPromptBuilder.ts:344, :1623`). Only the single-plan planner reads a persisted `workflowFilePath`, so only it exhibits the stale-override bug. Other roles (`lead`/`coder`/…) can carry a persisted `addons.workflowFilePath` (`KanbanProvider.ts:4586+`) but default to empty — the read-time guard (§B), placed in `getScopedRoleConfig`, covers them defensively.

## User Review Required

- None. This is a scoped bugfix completing a half-ported migration plus a read-time guard; no product decisions.

## Metadata
**Tags:** bugfix, migration, reliability, infrastructure
**Complexity:** 5

## Complexity Audit
### Routine
- The profile-tier migration is a near-copy of the existing `_migratePlannerWorkflowPathProfileTiers` with an exact-match rewrite instead of a prefix rewrite.
- The read-time helper is a pure string map.
### Complex / Risky
- **Shipped-state migration across four tiers** — must preserve user-custom values (exact-match gate) and not clobber the VS Code setting scope (use `inspect`-reported scope).
- **Read-guard placement** — the guard must sit at `getScopedRoleConfig` (the common ancestor of display + prompt reads), not at `:4585/:4620` (prompt-only). Getting this wrong fixes the prompt but leaves the Prompts-tab field showing the dead path and re-persisting it on Save — the exact symptom reported.
- **Clone-not-mutate in the guard** — `getScopedRoleConfig`'s globalState branch may return a cached object reference; mutating its `workflowFilePath` in place could corrupt the in-memory config store. Return a normalized shallow copy.
- **Ordering/compose** with the `.agent→.agents` profile migration — the new profile migration must run *after* it (same-session fresh-install case), yet also run when the `.agent→.agents` flag is already set.
- **Marker correctness** — a new, distinct globalState marker; reusing the DB or `.agent→.agents` marker would silently skip the rewrite.

## Edge-Case & Dependency Audit
- **Race Conditions:** the new profile migration must be sequenced after `_migratePlannerWorkflowPathProfileTiers` when both run in one session (see §A implementation), mirroring the existing `_migratePlannerWorkflowPathDbTiers().then(…WorkflowsToSkills())` chain; otherwise a value still holding the `.agent/` variant could be read pre-normalization and skipped. Migrations run at activation, marker-gated, each tier in its own try/catch.
- **Security:** pure string rewrite, exact-match (migration) / fixed map (guard), no injection surface (same as `_normalizeAgentToAgents`).
- **Side Effects:** the Prompts-tab field flips from the old path to the skills path (intended). A user who deliberately set a custom planner workflow is untouched (exact-match migration + a guard that only rewrites the four *retired* paths). The guard runs on every `getScopedRoleConfig` call (every prompt build and every Prompts-tab open) — it must be a cheap pure map and must not mutate the returned object.
- **Dependencies & Conflicts:** depends on the landed four-front-doors refactor (files already moved). §A (store cleanup) and §B (read guard) are independent and complementary — §B alone fixes the prompt, display, and save-loop even before the marker-gated migration runs; §A alone cleans the store; ship both.

## Dependencies
- `sess_four_front_doors — refactor-switchboard-four-front-doors.md` (the landed refactor that moved the files and introduced the half-ported migration).

## Adversarial Synthesis
Key risks: (1) the migration again misses a tier — mitigated by the read-time guard (§B), which is tier-agnostic; (2) clobbering a user-custom planner path — mitigated by exact-match migration + a guard scoped to only the four retired paths; (3) compose/order bug with the `.agent→.agents` migration — mitigated by explicit sequencing after it; (4) **the original §B mis-targeted the read site** — guarding `:4585/:4620` alone would fix the prompt but leave the Prompts-tab display (and the Save-re-persist loop) broken, i.e. it would *appear* to fix the reported symptom while leaving half of it live. Corrected: the guard goes in `getScopedRoleConfig` (the common ancestor), with the VS Code-setting fallback at `:4585/:4620` wrapped too. The read guard is the belt to the migration's braces.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — §A: port the missing profile-tier half of the workflows→skills migration (primary store fix)

**Context.** `_migratePlannerWorkflowPathWorkflowsToSkills` (`:1206`) rewrites only the two DB tiers. The two profile tiers (globalState role config + VS Code `planner.workflowPath` setting) have no workflows→skills migration — on a dev/UAT machine the stale value lives in globalState, so it survives.

**Logic.** Add `_migratePlannerWorkflowPathProfileTiersWorkflowsToSkills()`, mirroring `_migratePlannerWorkflowPathProfileTiers` (`:1079`) but with an **exact-match** rewrite `'.agents/workflows/improve-plan.md'` → `'.agents/skills/improve-plan/SKILL.md'` (preserve any other/custom value untouched):
- **globalState tier:** `getRoleConfig('roleConfig_planner')`; if `workflowFilePath === OLD_DEFAULT`, set to `NEW_DEFAULT` and `saveRoleConfig('roleConfig_planner', cfg)`.
- **VS Code setting tier:** `inspect('planner.workflowPath')`; if `globalValue === OLD_DEFAULT`, `update(..., ConfigurationTarget.Global)`; else if `workspaceValue === OLD_DEFAULT`, `update(..., ConfigurationTarget.Workspace)` — the exact `inspect`-reported-scope pattern of `:1098-1115`, no blind Global promotion.
- Gate with a **new** globalState marker `switchboard.plannerWorkflowPathWorkflowsToSkills.profile.v1`, set only after **both** tiers are attempted (each in its own try/catch), mirroring `:1122-1129`.

**Implementation — exact activation wiring.** The compose ordering interacts with the existing `wfProfileMigrated` gate at `:512-516`. Wire so the new profile migration always runs (its own marker gates re-entry) **and** is sequenced after `_migratePlannerWorkflowPathProfileTiers` whenever that method runs this session:

```ts
const wfProfileMigrated = this._context.globalState.get<boolean>(
    'switchboard.plannerWorkflowPathAgentToAgents.v1', false);
if (!wfProfileMigrated) {
    // .agent→.agents first, THEN workflows→skills, so the two compose:
    // .agent/workflows/improve-plan.md → .agents/workflows/improve-plan.md → skills path.
    void this._migratePlannerWorkflowPathProfileTiers()
        .then(() => this._migratePlannerWorkflowPathProfileTiersWorkflowsToSkills());
} else {
    // .agent→.agents already ran in a prior session (value is already .agents/workflows/…);
    // still need the skills rewrite, gated by its own profile marker.
    void this._migratePlannerWorkflowPathProfileTiersWorkflowsToSkills();
}
```

> **Superseded:** "Wire it into the activation chain next to the DB-tier call (`:527`). It MUST run after the `.agent→.agents` profile migration so the two compose."
> **Reason:** Ambiguous and mis-locating. The DB-tier chain at `:526-527` runs unconditionally, but the profile `.agent→.agents` migration at `:514-516` is gated by `if (!wfProfileMigrated)` and does **not** run every activation. Wiring the new profile migration "next to the DB-tier call" would put it in a different async chain from the profile `.agent→.agents` migration, so in the fresh-install same-session case (a `.agent/workflows/improve-plan.md` value in globalState, neither flag set) the two could race — the new migration could read the pre-normalization value, skip it, and seal its marker, stranding the row. The new method must chain off `_migratePlannerWorkflowPathProfileTiers()` when that runs, and run standalone (own marker) when the `.agent→.agents` flag is already set.
> **Replaced with:** the explicit `if (!wfProfileMigrated) { … .then(…) } else { … }` wiring above.

**Edge cases.** Exact-match gate preserves custom paths. Own distinct marker (`…WorkflowsToSkills.profile.v1`) — never reuse the `.agent→.agents` (`…AgentToAgents.v1`) or the DB (`…WorkflowsToSkills.v1`) markers. Each tier in its own try/catch; marker set only after both attempts, so a partial failure retries next activation.

### `src/services/KanbanProvider.ts` — §B: read-time normalization guard at the common ancestor (defense-in-depth, and the actual display/save-loop fix)

**Context.** `getScopedRoleConfig` (`:524-548`) is the one method every read of a role's persisted config funnels through: the Prompts-tab display (`KanbanService.getSetting` `kanbanService.ts:205`, and fallback `KanbanProvider.ts:9106`) **and** prompt generation (`_getPromptsConfig` `:4557` → `_getRoleConfig` → `getScopedRoleConfig`, producing `:4585/:4620`). It also backs `TaskViewerProvider._readRoleConfigScoped` (`:766`). Normalizing here fixes the display, the Save-re-persist loop, and the prompt in a single place. The only read path it does not cover is the `|| config.get('planner.workflowPath', …)` VS Code-setting fallback layered at `:4585/:4620` (reached only when the role config's `workflowFilePath` is empty), so those expressions are wrapped separately.

**Logic.**
1. Add a pure helper `normalizeRetiredWorkflowPath(p: string): string` mapping each **retired** relocated path to its new skills path, anything else returned unchanged:
   - `.agents/workflows/improve-plan.md` → `.agents/skills/improve-plan/SKILL.md`
   - `.agents/workflows/improve-feature.md` → `.agents/skills/improve-feature/SKILL.md`
   - `.agents/workflows/accuracy.md` → `.agents/skills/accuracy/SKILL.md`
   - `.agents/workflows/switchboard-orchestrator.md` → `.agents/skills/switchboard-orchestrator/SKILL.md`

   **Recommended home:** define the map + helper in `agentPromptBuilder.ts` next to `DEFAULT_PLANNER_WORKFLOW` / `DEFAULT_FEATURE_PLANNER_WORKFLOW` (`:743-744`) — the canonical source of the "new" skills paths — and `export` it, so the map's targets can never drift from the constants and the test can import it. Import into `KanbanProvider`. (A private static on `KanbanProvider` is acceptable if imports are undesirable, but then keep the target strings in sync with the constants.)
2. In `getScopedRoleConfig`, before returning any resolved config object, return a **shallow copy** with `workflowFilePath` (planner tier) and, if present, `addons.workflowFilePath` (other roles) passed through `normalizeRetiredWorkflowPath`. Do **not** mutate the resolved object in place. Non-object / `undefined` results are returned as-is.
3. At `:4585` and `:4620`, wrap the whole resolved expression so the VS Code-setting fallback is normalized too:
   `normalizeRetiredWorkflowPath(plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agents/skills/improve-plan/SKILL.md'))`. Idempotent given step 2.

**Implementation sketch (guard in `getScopedRoleConfig`):**
```ts
// helper applied to whatever tier resolved
const norm = (cfg: any) => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const out: any = { ...cfg };
    if (typeof out.workflowFilePath === 'string') {
        out.workflowFilePath = normalizeRetiredWorkflowPath(out.workflowFilePath);
    }
    if (out.addons && typeof out.addons.workflowFilePath === 'string') {
        out.addons = { ...out.addons, workflowFilePath: normalizeRetiredWorkflowPath(out.addons.workflowFilePath) };
    }
    return out;
};
// apply `norm(...)` to each `return` value of getScopedRoleConfig
```

**Edge cases.** Clone-not-mutate (globalState may hand back a cached reference). Cheap pure map on a hot path. Only the four retired paths are rewritten — custom paths and already-correct skills paths pass through untouched, so no user-custom value is disturbed. Because the Prompts tab now receives the normalized value, a subsequent **Save** persists the corrected skills path, closing the "re-save re-entrenches it" loop.

### `src/services/agentPromptBuilder.ts` — helper home (if the recommended placement is taken)

**Context.** `DEFAULT_PLANNER_WORKFLOW` (`:743`) and `DEFAULT_FEATURE_PLANNER_WORKFLOW` (`:744`) already live here; accuracy/orchestrator skills paths are the fixed strings used at `:344/:1623`.

**Logic.** Export `RETIRED_WORKFLOW_PATH_MAP` (the four old→new entries) and `normalizeRetiredWorkflowPath(p)`. Keep entries' targets equal to the canonical constants where they exist. No behavior change to existing prompt assembly.

### `src/test/planner-workflow-path-migration.test.js` — §C: tests

**Context.** This file already covers the `.agent→.agents` migration (tests 1–6) and the DB-tier workflows→skills rewrite (test 7 + source assertions at `:313-337`). Its existing `.agents/workflows/improve-plan.md` assertions are the **correct output** of the `.agent→.agents` migration and MUST NOT be blanket find-replaced.

**Logic — add (do not rewrite existing cases):**
- **Source assertions** that `_migratePlannerWorkflowPathProfileTiersWorkflowsToSkills` exists, uses the new marker `switchboard.plannerWorkflowPathWorkflowsToSkills.profile.v1`, matches `OLD_DEFAULT='.agents/workflows/improve-plan.md'` → `NEW_DEFAULT='.agents/skills/improve-plan/SKILL.md'`, `inspect`s `planner.workflowPath`, and updates the reporting scope (`ConfigurationTarget.Global`/`.Workspace`).
- **Source/wiring assertion** that the constructor sequences the new profile migration after `_migratePlannerWorkflowPathProfileTiers` in the `!wfProfileMigrated` branch and invokes it standalone in the `else` branch.
- **Unit test for `normalizeRetiredWorkflowPath`** covering all four retired paths mapping to their skills paths + a custom path and an absolute path passing through unchanged (import it if exported per the recommended home, else mirror the transform inline like the existing `normalizeAgentToAgents` mirror at `:34-37`).
- Optionally, a data-transform test (parallel to test 7) seeding a globalState-shaped `{workflowFilePath: OLD_DEFAULT}` and a custom value, asserting only the old default is rewritten.

## Non-Goals
- Re-litigating the four-front-doors file moves (done and correct — `workflows/` holds the four doors, internals are in `skills/`).
- Touching `improve-feature`/`accuracy`/orchestrator dispatch (their defaults are hardcoded and correct; §B still covers them defensively via `addons.workflowFilePath`).
- Broadening the §A migration to the other three retired paths — they are never persisted for the planner, so the migration stays an exact-match on `improve-plan`. The four-path breadth lives only in the §B read guard.

## Verification Plan
### Automated Tests
- Session directive: tests are not *run* here; expectations are written per §C for the next suite run, plus manual repro.
- **Dev-machine repro (the reported failure):** with globalState `roleConfig_planner.workflowFilePath = '.agents/workflows/improve-plan.md'`, reload the window; assert (a) the Prompts-tab "Workflow File Path" field shows `.agents/skills/improve-plan/SKILL.md` — this exercises `getScopedRoleConfig` via the `getSetting` round-trip, so it passes on the §B guard alone even before the §A migration marker is set; (b) a generated planner prompt references the skills path (`:4620` → `agentPromptBuilder.ts:934`); (c) after activation, globalState now stores the skills path (§A).
- **Save-loop closure:** open the Prompts tab (now showing the corrected path via the guard), Save, and confirm the persisted value is the skills path, not the old one.
- **Custom-path preservation:** set a custom planner workflow path; assert it is unchanged after activation, in the field, and in the prompt.
- **VS Code-setting fallback:** clear the role-config `workflowFilePath` and set the VS Code `planner.workflowPath` setting to the old default; assert the generated prompt still resolves to the skills path (the wrapped `:4620` fallback), and §A rewrites the setting on next activation.
- **Grep gate:** `grep -rnE '\.agents/workflows/(improve-plan|improve-feature|accuracy|switchboard-orchestrator)\.md' src/` returns only the intentional blocklist (`extension.ts:3722-3725`), migration/`OLD_DEFAULT` rows, the §B map's left-hand keys, and test rows — no live dispatch or read-site hits.

---

**Recommendation:** Complexity 5 → **Send to Coder.** Ship §A (complete the migration) **and** §B (read-time guard, placed in `getScopedRoleConfig`) together. §B — at the common-ancestor read site, not the prompt-only `:4585/:4620` sites — is what actually clears the reported Prompts-tab symptom and closes the save-loop, and is the guarantee that a relocated path lingering in a persisted tier can never hand agents a dead path again, whether or not every migration tier was remembered.

---

## Implementation Summary

Implemented all three sections (§A profile-tier migration, §B read-time guard, §C tests). **Files changed:** `src/services/TaskViewerProvider.ts` (added `_migratePlannerWorkflowPathProfileTiersWorkflowsToSkills` mirroring the existing profile-tier migration with an exact-match rewrite of `.agents/workflows/improve-plan.md` → `.agents/skills/improve-plan/SKILL.md`, gated by new distinct marker `switchboard.plannerWorkflowPathWorkflowsToSkills.profile.v1`; rewired the constructor so the new migration chains after `_migratePlannerWorkflowPathProfileTiers` in the `!wfProfileMigrated` branch and runs standalone in the `else` branch); `src/services/agentPromptBuilder.ts` (exported `RETIRED_WORKFLOW_PATH_MAP` covering all four retired paths + `normalizeRetiredWorkflowPath` pure helper, targets kept in sync with the canonical `DEFAULT_PLANNER_WORKFLOW`/`DEFAULT_FEATURE_PLANNER_WORKFLOW` constants); `src/services/KanbanProvider.ts` (imported the helper, added `_normalizeRoleConfig` shallow-clone guard applied to every return of `getScopedRoleConfig` — the common ancestor of Prompts-tab display and prompt generation — and wrapped the `:4585`/`:4620` VS Code-setting fallbacks); `src/test/planner-workflow-path-migration.test.js` (added source assertions for the new method/marker/wiring, the exported map + helper, plus test 8 exercising `normalizeRetiredWorkflowPath` across all four retired paths + custom/absolute/idempotent cases and test 9 for the profile-tier data transform). Grep gate confirms no live dispatch/read-site hits — only the intentional blocklist, migration `OLD_DEFAULT` rows, §B map keys, and test rows. No issues encountered.

## Review Findings

**Reviewer pass (in-place, 2026-07-13).** Verified all three sections against the plan requirements and traced every consumer of the modified functions. §A profile-tier migration (`TaskViewerProvider.ts:1283-1353`) correctly mirrors the existing `_migratePlannerWorkflowPathProfileTiers` template: exact-match gate, distinct marker `…WorkflowsToSkills.profile.v1`, `inspect`-scoped VS Code setting update, per-tier try/catch, marker set only after both tiers attempted. Constructor wiring (`:514-523`) chains the new migration after `.agent→.agents` in the `!wfProfileMigrated` branch and standalone in the `else` branch — no race with the DB-tier chain (different tiers, no shared state). §B read guard (`KanbanProvider.ts:535-548`) is correctly placed at `getScopedRoleConfig` (the common ancestor of Prompts-tab display via `kanbanService.ts:205` and prompt generation via `_getPromptsConfig`), shallow-clones (no mutation of cached globalState references), and covers both `workflowFilePath` and `addons.workflowFilePath` (a later commit `b905f1c` extended it to `addons.featureWorkflowFilePath` — complementary, not breaking). The `:4618`/`:4653` wraps are idempotent double-normalization (harmless). Grep gate passes — remaining hits are only the §B map keys, migration `OLD_DEFAULT` rows, blocklist, and test rows. **No CRITICAL or MAJOR findings.** Three NITs (all deferred — pre-existing or harmless): (1) `DesignPanelProvider.ts:1320` read-modify-write bypasses `getScopedRoleConfig` — could re-persist a stale `workflowFilePath` if the user toggles the design-system addon during the activation race window, but §A cleans globalState at activation before any user interaction; (2) `normalizeRetiredWorkflowPath` uses an `as any` cast for non-string input — defensive, matches existing patterns; (3) `_normalizeRoleConfig` doesn't deep-clone `addons` when its `workflowFilePath` is absent — `out.addons` shares the source reference, but no mutation occurs so no corruption. No code fixes applied. Validation: grep gate clean; typecheck/tests skipped per directive.
