# Fix: Planner Prompt Still Hands Agents the Dead `.agents/workflows/improve-plan.md` (Half-Ported Migration)

## Goal

After the four-front-doors refactor moved `improve-plan.md` to `.agents/skills/improve-plan/SKILL.md`, the generated **planner prompt still tells agents to read `.agents/workflows/improve-plan.md`** — a path that no longer exists — so planning dispatch fails UAT. The Prompts tab's "Workflow File Path" field also still displays the old path. Make every read of the planner workflow path resolve to the new skills location, clean the stale persisted value out of all tiers, and prevent it from being re-saved.

### Problem & root-cause analysis

**Symptom.** In Antigravity/UAT the planner prompt references `.agents/workflows/improve-plan.md`. The kanban Prompts tab shows that same dead path in the **Workflow File** section, even though the "edit prompt template" preview looks correct.

**The value is a persisted override, not a bad default.** Both read sites in `KanbanProvider.ts` resolve the path as `plannerConfig?.workflowFilePath || config.get('planner.workflowPath', '.agents/skills/improve-plan/SKILL.md')`:
- `:4585` — `workflowFilePathByRole.planner` (what the Prompts-tab input displays).
- `:4620` — `plannerWorkflowPath` (what goes into the generated planner prompt).

The source-code default was correctly repointed to the skills path (`agentPromptBuilder.ts:743`, `kanban.html:2981/3421`), **but a persisted `workflowFilePath` takes precedence over that default at every read.** `plannerConfig` comes from `KanbanProvider._getRoleConfig('planner')` (`:4557`), which resolves the planner role config from its persisted tiers. That persisted value is still `.agents/workflows/improve-plan.md`, so it wins — the field shows it, the prompt embeds it, and hitting **Save** on the Prompts tab writes it straight back (now as an explicit value), entrenching it.

**Root cause — the workflows→skills migration is half-ported.** `workflowFilePath` is stored in **four tiers** (documented at `TaskViewerProvider.ts:1059`): globalState role config, the VS Code `planner.workflowPath` setting, the workspace DB `config` table, and the DB `project_config` table. The earlier `.agent/`→`.agents/` migration correctly covered all four via **two** methods:
- `_migratePlannerWorkflowPathProfileTiers` (`:1079`) — globalState + VS Code setting, gated by the globalState flag `switchboard.plannerWorkflowPathAgentToAgents.v1`.
- `_migratePlannerWorkflowPathDbTiers` (`:1137`) — DB `config` + `project_config`, per-DB marker.

The new four-front-doors migration `_migratePlannerWorkflowPathWorkflowsToSkills` (`:1206`, marker `…WorkflowsToSkills.v1`) **only ported the DB half.** It rewrites `config` + `project_config` but has **no profile-tier counterpart** — globalState and the VS Code setting are never touched. On a dev/UAT machine the planner path is persisted in globalState (that is the tier the Prompts tab reads and re-saves), so the rewrite never reaches it and the dead path survives.

### Grounded facts (verified in code, 2026-07-12)

- **Both overriding read sites** are `plannerConfig?.workflowFilePath || <new default>` (`KanbanProvider.ts:4585, :4620`). `plannerConfig = this._getRoleConfig('planner')` (`:4557`).
- **UI is not the culprit:** `kanban.html:2981` default value and `:3421` load fallback are both `.agents/skills/improve-plan/SKILL.md`; the field only shows the old path because the *persisted* `config.workflowFilePath` holds it.
- **The DB-only migration:** `_migratePlannerWorkflowPathWorkflowsToSkills` (`TaskViewerProvider.ts:1206-1264`) rewrites `OLD_DEFAULT='.agents/workflows/improve-plan.md'` → `NEW_DEFAULT='.agents/skills/improve-plan/SKILL.md'` for the `config` and `project_config` tiers only. It is chained at activation (`:527`) but has no profile-tier sibling.
- **The template to mirror:** `_migratePlannerWorkflowPathProfileTiers` (`:1079-1130`) already shows exactly how to migrate globalState (read `getRoleConfig('roleConfig_planner')`, write `saveRoleConfig`) and the VS Code setting (`inspect` the scope, `update` in place).
- **Scope is the single-plan planner only.** `DEFAULT_FEATURE_PLANNER_WORKFLOW` (`:744`) is used directly at `agentPromptBuilder.ts:911` (no persisted override); the accuracy path is hardcoded (`:344, :1623`). Only the single-plan planner reads a persisted `workflowFilePath`, so only it exhibits the stale-override bug. Other roles (`lead`/`coder`/…) can carry a persisted `addons.workflowFilePath` (`KanbanProvider.ts:4587+`) but default to empty — a read-time guard (§B) covers them defensively.

## Proposed Changes

### A. Port the missing profile-tier half of the workflows→skills migration (primary fix)
- Add `_migratePlannerWorkflowPathProfileTiersWorkflowsToSkills()` to `TaskViewerProvider`, mirroring `_migratePlannerWorkflowPathProfileTiers` (`:1079`) but with an **exact-match** rewrite `'.agents/workflows/improve-plan.md'` → `'.agents/skills/improve-plan/SKILL.md'` (preserve any other/custom value untouched):
  - **globalState tier:** `getRoleConfig('roleConfig_planner')`; if `workflowFilePath === OLD_DEFAULT`, set to `NEW_DEFAULT` and `saveRoleConfig`.
  - **VS Code setting tier:** `inspect('planner.workflowPath')`; if `globalValue`/`workspaceValue === OLD_DEFAULT`, `update` in the reporting scope (no blind Global promotion) — same pattern as `:1098-1115`.
  - Gate with a **new** globalState marker `switchboard.plannerWorkflowPathWorkflowsToSkills.profile.v1`, set only after both tiers are attempted (mirrors `:1122`).
- **Wire it into the activation chain** next to the DB-tier call (`:527`). It MUST run **after** the `.agent→.agents` profile migration so the two compose (`.agent/workflows/improve-plan.md` → `.agents/workflows/improve-plan.md` → skills path), matching the ordering note already stated for the DB tier (`:1204`).

### B. Read-time normalization guard (defense-in-depth — makes it bulletproof regardless of tier/marker/ordering)
- Add a small pure helper, e.g. `normalizeRetiredWorkflowPath(p: string): string`, mapping each **retired** relocated path to its new skills path:
  - `.agents/workflows/improve-plan.md` → `.agents/skills/improve-plan/SKILL.md`
  - `.agents/workflows/improve-feature.md` → `.agents/skills/improve-feature/SKILL.md`
  - `.agents/workflows/accuracy.md` → `.agents/skills/accuracy/SKILL.md`
  - `.agents/workflows/switchboard-orchestrator.md` → `.agents/skills/switchboard-orchestrator/SKILL.md`
  - anything else returned unchanged (custom paths preserved).
- Apply it at the two override read sites (`KanbanProvider.ts:4585, :4620`) and, defensively, to every role's resolved `workflowFilePath`/`addons.workflowFilePath`. This guarantees a correct prompt **even if** a stale value slips through any tier, and — because the Prompts tab displays the normalized value — a subsequent Save persists the corrected path, closing the "re-save re-entrenches it" loop.

### C. Tests
- Add a migration test for the new profile-tier method: seed globalState role config `{workflowFilePath:'.agents/workflows/improve-plan.md'}` and the VS Code setting to the same, run activation, assert both become `.agents/skills/improve-plan/SKILL.md`; seed a custom path and assert it is untouched; assert the marker gates re-runs.
- Add a unit test for `normalizeRetiredWorkflowPath` covering all four retired paths + a custom path passthrough.
- Reconcile `planner-workflow-path-migration.test.js` — its existing `.agents/workflows/improve-plan.md` assertions belong to the `.agent→.agents` test and must NOT be blanket find-replaced; add the workflows→skills profile assertions as new cases.

## Migration & Compatibility
- Released user state: the persisted planner `workflowFilePath` across all four tiers. §A completes the tier coverage; §B guards at read. Rewrite is **exact-match-gated** (only the old default is touched) so user-custom workflow paths are preserved. Idempotent, marker-gated per profile and per DB.
- No `MIGRATION_Vnn_SQL` body is edited; the profile migration uses globalState + VS Code settings API (same mechanism as the existing profile migration).
- Dev/UAT machine: the stale value is in globalState (new profile marker unset) → the added migration rewrites it on next activation; §B corrects the prompt even before the marker-gated migration runs.

## Non-Goals
- Re-litigating the four-front-doors file moves (done and correct — `workflows/` holds the four doors, internals are in `skills/`).
- Touching `improve-feature`/`accuracy`/orchestrator dispatch (their defaults are hardcoded and correct; §B still covers them defensively).

## User Review Required
- None. This is a scoped bugfix completing a half-ported migration plus a read-time guard; no product decisions.

## Metadata
**Tags:** bugfix, migration, reliability, infrastructure
**Complexity:** 5

## Complexity Audit
### Routine
- The profile-tier migration is a near-copy of the existing `_migratePlannerWorkflowPathProfileTiers` with an exact-match rewrite instead of a prefix rewrite.
- The read-time helper is a pure string map applied at two known sites.
### Complex / Risky
- **Shipped-state migration across four tiers** — must preserve user-custom values (exact-match gate) and not clobber the VS Code setting scope (use `inspect`-reported scope).
- **Ordering/compose** with the `.agent→.agents` profile migration — run after it, or an `.agent/`-persisted value skips the skills rewrite.
- **Marker correctness** — a new, distinct globalState marker; reusing the DB or `.agent→.agents` marker would silently skip the rewrite.

## Edge-Case & Dependency Audit
- **Race Conditions:** none new; migrations run at activation, marker-gated, each tier in its own try/catch (mirrors existing).
- **Security:** pure string rewrite, exact-match, no injection surface (same as `_normalizeAgentToAgents`).
- **Side Effects:** the Prompts-tab field flips from the old path to the skills path (intended). A user who deliberately set a custom planner workflow is untouched (exact-match gate).
- **Dependencies & Conflicts:** depends on the landed four-front-doors refactor (files already moved). The read-time guard (§B) and the migration (§A) are independent and complementary — §B alone fixes the prompt; §A alone cleans the store; ship both.

## Dependencies
- `sess_four_front_doors — refactor-switchboard-four-front-doors.md` (the landed refactor that moved the files and introduced the half-ported migration).

## Adversarial Synthesis
Key risks: (1) the migration again misses a tier — mitigated by the read-time guard (§B) which is tier-agnostic and by a test that seeds *each* tier; (2) clobbering a user-custom planner path — mitigated by exact-match-only rewrite; (3) compose/order bug with the `.agent→.agents` migration — mitigated by explicit ordering after it. The read-time guard is the belt to the migration's braces: even a future relocation that forgets a tier still yields a correct prompt.

## Verification Plan
### Automated Tests
- Session directive: tests are not *run* here; expectations are written per §C for the next suite run, plus manual repro.
- **Dev-machine repro (the reported failure):** with globalState `roleConfig_planner.workflowFilePath = '.agents/workflows/improve-plan.md'`, reload the window; assert (a) the Prompts-tab "Workflow File Path" field shows `.agents/skills/improve-plan/SKILL.md`, (b) a generated planner prompt references the skills path, (c) globalState now stores the skills path.
- **Custom-path preservation:** set a custom planner workflow path; assert it is unchanged after activation and in the prompt.
- **Save-loop closure:** open the Prompts tab (now showing the corrected path), Save, and confirm the persisted value is the skills path, not the old one.
- **Grep gate:** `grep -rnE '\.agents/workflows/(improve-plan|improve-feature|accuracy|switchboard-orchestrator)\.md' src/` returns only the intentional blocklist (`extension.ts:3716-3725`) and migration `OLD_DEFAULT`/test rows — no live dispatch or read-site hits.

---

**Recommendation:** Complexity 5 → **Send to Coder.** Ship §A (complete the migration) **and** §B (read-time guard) together; §B is the guarantee that this class of bug — a relocated path lingering in a persisted tier — cannot hand agents a dead path again, whether or not every migration tier was remembered.
