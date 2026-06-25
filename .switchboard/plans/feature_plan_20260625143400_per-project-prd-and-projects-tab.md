# Per-Project PRDs and a Projects Tab (Decouple PRD from Epics)

## Goal

Switchboard currently overloads the word "epic" across two unrelated concepts, and the Epics tab conflates them:
1. **Orchestration epic** — a board container of subtask plans, run by the orchestrator. Self-sufficient: the orchestrator builds its overview from the subtasks; it needs no separate spec.
2. **"Planning epic" / PRD** — a requirements document whose *content* is imported into the planner prompt via the "Planning Epic Reference" add-on, set through the design panel's "active planning context" button.

These are orthogonal. Per the product owner's mental model: **a PRD/spec is optional**; an epic never needs one; and conversely a *normal* (non-epic) plan can benefit from a PRD, because a PRD is "simply a loose set of requirements to be respected across several plans." The natural scope for "several plans" is a **project**. This plan decouples the PRD from epics entirely and rehouses it as a **per-project** document, managed in a new **Projects tab**, injected via a **"project context" button** on the kanban.

### Core problem & root cause

- The "planning epic" is not an epic at all — it is a global requirements doc. Today it is a single workspace-global value: `_resolveGlobalDesignDoc` (`KanbanProvider.ts:2778`) reads `planner.designDocEnabled`/`planner.designDocLink` and injects link+content into the planner prompt; it is set via `setActivePlanningContext` (`DesignPanelProvider.ts:1457`) and surfaced as the planner add-on labeled "Planning Epic Reference" (`designDoc`, `kanban.html:2876`, mapped at `:4007`). Calling this an "epic" and surfacing it near orchestration epics is the conflation.
- The orchestration epic is a `plans` row with `is_epic=1` + `epic_id`-linked subtasks, run via `buildEpicOrchestrationPrompt`. It is already independent of the PRD at the prompt layer — only the UI/terminology conflate them.
- **Root cause:** the PRD was modeled as a global, epic-flavored concept instead of as a first-class **project**-scoped requirements doc. Projects are already first-class (`projects` table, `plans.project_id`, `addProject` at `KanbanDatabase.ts:2211`, and the toolbar project selector/add/delete/assign at `kanban.html:2513-2517`), and the per-project-context *pattern* already exists as the **Constitution** (`_resolveConstitution`, `KanbanProvider.ts:2793`, gated by the `constitution` add-on). The PRD should mirror the constitution — same injection shape, different axis (*what to build* vs *how to build*) — but scoped to the **project** rather than the workspace.

## Metadata

- **Tags:** ui, ux, refactor, feature, database
- **Complexity:** 7/10 (raised from 6 after code-grounding — see Code-Grounding Corrections; multi-file coordination across two prompt paths, a behavioral landmine in the tester role, and a misattributed file)

## User Review Required

None — both prior product calls are decided by the owner:
1. **Scope of injection: ALL prompts.** When the project-context toggle is on and the active project has a PRD, the PRD is injected into **every dispatched prompt regardless of role** (planner, lead, coder, reviewer, tester, orchestrator, etc.). A PRD is a project-wide set of requirements every agent must respect — so it is a **single project-level toggle**, NOT a per-role add-on. (The legacy per-role `designDoc` add-on/setting is retained only as a back-compat fallback.)
2. **PRD storage: per-project file** at `.switchboard/projects/<project-slug>/prd.md`, mirroring the constitution (a file resolved by path — git-trackable and editable), with the path/enabled state recorded against the project.

## Complexity Audit

### Routine
- A "Projects" tab in `kanban.html` listing projects (reusing the existing project list already loaded for the toolbar selector) with create/rename/delete and a PRD editor per project. Project create/delete already exist (`btn-add-project`/`btn-delete-project` → `addProject`/delete).
- A single "Project Context" toggle button near the project selector that enables/disables injection of the active project's PRD into **all** dispatched prompts (this toggle, not a per-role add-on, is the PRD control).
- Retire the planner-only "Planning Epic Reference" add-on as the PRD control (its `designDoc` key is kept only as a back-compat fallback — see migration).

### Complex / Risky
- **Per-project PRD resolution (new scoping).** Add a `_resolveProjectPrd(workspaceRoot, projectId)` mirroring `_resolveConstitution` (`KanbanProvider.ts:2793`) but keyed on the **active project** (the board's `project_id` filter), not the workspace. Wire it into the option-resolution path alongside `constitutionEnabled`/`constitutionLink` (`KanbanProvider.ts:2891-2896`) and into `PromptBuilderOptions` so the prompt builder injects PRD link+content like it does the constitution.
- **Active-project plumbing.** The "project context" button and PRD resolution depend on knowing the active project. The board already tracks a project filter (`_projectFilter`); confirm it exposes the active `project_id` to the dispatch/option path so the right PRD is injected (and that "No Project" / unfiltered yields no PRD).
- **Decoupling from the global design-doc mechanism.** The new per-project PRD supersedes the global `planner.designDocLink` "active planning context." Keep `_resolveGlobalDesignDoc` as a **fallback** when a project has no PRD (don't break existing setups), with the per-project PRD taking precedence.
- **Decouple from Epics tab + retire "planning epic" terminology.** Remove any PRD/planning-context affordance from the Epics tab so it is orchestration-only; reconcile with `separate-planning-epic-from-design-system-doc.md` and `unify-epic-architecture-and-fix-kanban-epic-display.md`.

## Code-Grounding Corrections (improve-plan pass)

These supersede or sharpen claims above; they were verified by reading the current source. Original prose is preserved; treat these as the authoritative implementation facts.

1. **Projects are name-based, not id-based.** `plans.project` is a `TEXT` column (`KanbanDatabase.ts:434` migration), there is **no** `plans.project_id` FK. `_projectFilter` holds the project **name** (or the sentinel `KanbanDatabase.UNASSIGNED_PROJECT_FILTER = '__unassigned__'`, `:631`); `getProjects()` returns `string[]` of names (`:2197`); `addProject(workspaceId, name)` (`:2211`). The `projects` table does have an `id` column but it is not what plans link on. **Implication:** the PRD slug/path and `getProjectPrdPath(workspaceRoot, projectName)` must derive from the project **name** (sanitised), and `_resolveProjectPrd` must key on the active project **name** from `getProjectFilter()` (`KanbanProvider.ts:4470`). Replace every "`project_id`" reference in this plan with "project name".

2. **"All roles" injection anchor is `dispatchPrefixCore`, NOT the constitution.** The constitution is **planner-only** at the prompt layer — injected inside the `role === 'planner'` branch (`agentPromptBuilder.ts:571-573`) and separately in `buildCustomAgentPrompt` (`:1362-1365`); it does **not** reach lead/coder/reviewer/tester. The genuine shared-scaffold that already reaches every role is `dispatchPrefixCore`/`dispatchContextPrefix` (`agentPromptBuilder.ts:483-484`), consumed by every role's `suffixBlock` (`:555, 656, 705, 762, 811, 857, 884, 940, 987, 1034, 1121, 1148, 1194`). The precedent to mirror is the **§11 `remoteModeBlock`** (`:482`), which folds a single global directive into that prefix for all roles. **Implication:** add the PRD block to `dispatchPrefixCore` (e.g. `[dispatchContextBlock, remoteModeBlock, prdBlock].filter(Boolean).join('\n\n')`), gated on `options.prdEnabled`. Step 5's "mirror the constitution injection" is misleading and should read "mirror the §11 remote-mode prefix injection."

3. **Custom agents are a second, separate prompt path.** `buildCustomAgentPrompt` (`agentPromptBuilder.ts:1270+`) computes its **own** `dispatchContextPrefix` (`:1277`) and does not share the batch builder's prefix. Custom-agent option resolution is a separate branch in `generateUnifiedPrompt` (`KanbanProvider.ts:2821-2851`). **Implication:** to truly cover "all prompts," wire `prdEnabled`/`prdLink`/`prdContent` into both the custom-agent resolution branch and `buildCustomAgentPrompt` — otherwise custom agents silently miss the PRD.

4. **The tester role THROWS without a design doc — a behavioral landmine.** `role === 'tester'` (`KanbanProvider.ts:2910-2913`) hard-throws `"Acceptance Tester requires a Planning Epic to be enabled and attached in Setup."` when `_resolveGlobalDesignDoc` returns no link. If the PRD supersedes the planning-epic doc and a user attaches a per-project PRD instead of the global `designDocLink`, **tester dispatch will throw** unless this branch is updated to accept the active project's PRD as satisfying the requirement (resolve PRD first; fall back to the global design doc; only throw if neither exists). This is not mentioned in the plan and must be a first-class step.

5. **The design-panel button is MISATTRIBUTED.** `setActivePlanningContext` (`DesignPanelProvider.ts:1457`) writes `planner.designSystemDocLink` / `planner.designSystemDocEnabled` — the **Design System Doc** (the `designSystemDoc` add-on), **not** the PRD/`designDocLink`. The actual PRD/"Planning Epic Reference" (`planner.designDocLink` / `planner.designDocEnabled`) is written by **`PlanningPanelProvider.ts`** (`~:2605`, `~:5710`; cleared at `~:5630-5636`) and read back at `~:6009-6017`. **Implication:** Step 10 (DesignPanelProvider) is targeting the wrong concern — the design-system doc is out of scope. Re-point the "legacy/fallback PRD writer" work at `PlanningPanelProvider.ts`, and leave `DesignPanelProvider.setActivePlanningContext` untouched.

6. **Terminology lives in literal prompt strings.** Retiring "Planning Epic" touches the literal strings `"PLANNING EPIC REFERENCE"` in `agentPromptBuilder.ts:525, 568, 711, 1351` and the UI label at `kanban.html:2878` (add-on `plannerAddonPlanningEpic` → key `designDoc`, mapped at `kanban.html:~4007` and read at `:3257`). The `designDoc` add-on key MUST be preserved for back-compat (per migration rule); only the surfaced label/role-as-PRD-control changes.

7. **There is no top-level "Epics tab" in `kanban.html`.** The shared top-level tabs are KANBAN / AGENTS / PROMPTS / AUTOMATION / REMOTE / WORKTREES / UAT / SETUP (`kanban.html:2498-2506`). The "Epics tab" referenced in this plan is the **project-view** Epics surface (see comments at `kanban.html:6704, 7237`), a different render path. **Implication:** the new **Projects tab** is added as a peer `shared-tab-btn data-tab="projects"` + `<div id="projects-tab-content" class="shared-tab-content">` in `kanban.html`; the "remove PRD affordance from the Epics tab" work (step 9) targets the project-view Epics surface, and in practice there is little/no PRD affordance there today — verify before scoping.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_projectFilter` is debounce-persisted (`setProjectFilter` → 100ms timeout, `KanbanProvider.ts:4499-4504`) and validated lazily (`:2061-2076`). A dispatch fired immediately after a project switch could read a stale filter; resolve the PRD from the *plan's* stored `project` where available, falling back to the live `getProjectFilter()`, so a mid-switch dispatch can't inject the wrong project's PRD.
- PRD file read in `_resolveProjectPrd` is async; a concurrent Projects-tab save could interleave. Acceptable (last-write-wins on a git-trackable file), but reads must tolerate a partially-written file (wrap in try/catch like `_resolveConstitution`, `:2798-2801`).

**Security:**
- PRD content is injected verbatim into every dispatched prompt — same trust boundary as the constitution. Slug derivation from the project **name** must sanitise path separators / `..` to prevent the PRD path escaping `.switchboard/projects/` (path-traversal). Mirror any sanitisation `constitutionUtils` relies on.

**Side Effects:**
- Folding the PRD into `dispatchPrefixCore` changes the prompt for **every** role the moment the toggle is on — including roles the author may not have considered (analyst, ticket_updater, gatherer, splitter, chat). Confirm that is intended (the owner decision says "all prompts," so yes) and that none of those roles break on extra leading context.
- Tester throw change (correction #4) alters a user-facing error path — ensure the new message still guides users who have neither a PRD nor a design doc.

**Dependencies & Conflicts:**
- Co-located option-key edits with `…120812` (slim orchestrator) at `KanbanProvider.ts:~2860-2896` and in `PromptBuilderOptions`. Additive; coordinate ordering to avoid merge conflicts.
- `_resolveGlobalDesignDoc` remains the back-compat fallback and is consumed by planner (`:2888`), tester (`:2910`), and custom agents (`:2831`). Do not delete it.

**Migration (~4,000 installs):**
- Existing global `planner.designDocLink` ("active planning context"): preserve it as a fallback; do not delete the setting. Optionally, on first load, offer to attach it to the current/default project's PRD — but never silently drop it.
- New per-project PRD files for projects created before this change simply don't exist yet (PRD optional). No backfill needed.
- Preserve unknown/legacy keys in role/prompt config; the renamed add-on must keep reading the old `designDoc` key so saved planner configs keep working.

**Orthogonality guarantees (the whole point):**
- An epic with no PRD must dispatch exactly as today (orchestrator builds overview from subtasks) — verify no PRD injection is forced for epics.
- A normal plan in a project *with* a PRD must get the PRD injected (when the project-context toggle is on) — verify non-epic dispatch resolves the active project's PRD.
- "No Project" board / unfiltered view → no PRD injected.
- **Orchestrated epics — scope boundary.** "All prompts" means all prompts **Switchboard dispatches** (it injects in `buildKanbanBatchPrompt`). For an orchestrated epic, the PRD reaches the *orchestrator's* prompt, but the orchestrator's own subagents (ultracode/native) are not Switchboard dispatches and are **not** injected — propagating the PRD to them is the orchestrator's decision, by design (Switchboard makes it available, it does not reach inside the agent). Optional, non-guaranteeing nudges: reference the PRD *link* in the epic doc (which the orchestrator already reads, per `…120812`), and/or a "pass requirements to your subagents" line in the orchestrator base instruction.

**Constitution relationship:** PRD and constitution are distinct per-project context docs (*what* vs *how*) and both can be injected; keep them as separate add-ons/toggles. Note the constitution is currently workspace-scoped — aligning it to per-project is **out of scope** here (possible follow-on); this plan only makes the **PRD** project-scoped.

**No confirmation dialogs** (project rule): project/PRD delete executes immediately.

## Dependencies

- **Reconcile with** `separate-planning-epic-from-design-system-doc.md` (terminology decoupling) and `unify-epic-architecture-and-fix-kanban-epic-display.md` (epic display) — this plan subsumes the "planning epic" rename; coordinate rather than duplicate.
- **Related:** `constitution-and-tuning-tabs.md` / `constitution-visibility-and-control.md` (the constitution tab/UI is the structural model for the Projects-tab PRD editor).
- **Context:** `feature_plan_20260625120812_slim-orchestrator-prompt-addons-epic-link.md` and `feature_plan_20260625141208_epic-only-orchestrator-board-column.md` — both assume the epic is self-sufficient (no PRD required), which this plan formalizes.

## Cross-Plan Coordination (this session)

- **Shared prompt-builder injection (↔ `…120812` slim orchestrator prompt).** The PRD block is added to the *shared* prompt scaffold for every role. The slim-prompt plan rewrites the orchestrator role branch — it must still emit this shared PRD block (don't return a self-contained string that bypasses it). For the orchestrator specifically, prefer injecting the PRD as a *link* over full content, to preserve that plan's terseness goal.
- **Co-located `PromptBuilderOptions` / option-resolution edits (↔ `…120812`).** Both plans add option keys in `KanbanProvider.ts` ~L2860–2896 and to `PromptBuilderOptions` (`prdEnabled`/`prdLink`/`prdContent` here; `ultracodeEnabled` there). Additive — coordinate to avoid merge friction.
- **Subagent propagation is out of scope (by design).** See the "Orchestrated epics — scope boundary" bullet above: Switchboard guarantees the PRD reaches dispatched prompts only; downstream orchestrator-subagent propagation is agent discretion, optionally nudged, never guaranteed.

## Adversarial Synthesis

**Risk Summary:** Key risks — (1) the tester role hard-throws without a global design doc (`KanbanProvider.ts:2910-2913`), so a project-PRD-only setup breaks tester dispatch unless reconciled; (2) "all roles" requires touching *two* prompt paths (`dispatchPrefixCore` and the separate `buildCustomAgentPrompt`), and the constitution is the wrong template since it is planner-only; (3) the legacy PRD writer is `PlanningPanelProvider.ts`, not the misattributed `DesignPanelProvider.setActivePlanningContext` (which governs the unrelated design-system doc). Mitigations — resolve PRD before the design-doc fallback in the tester branch; inject via the proven §11 `remoteModeBlock` prefix pattern plus the custom-agent path; key all scoping on the project **name** (no `project_id` exists); preserve the `designDoc` key and `_resolveGlobalDesignDoc` as untouched back-compat fallbacks; sanitise name-derived PRD paths against traversal.

## Proposed Changes

### Data / storage
1. Per-project PRD: a file at `.switchboard/projects/<slug>/prd.md` (slug derived from project name/id), with the path + enabled flag recorded against the project (config keyed by `project_id`, or a `prd_path`/`prd_enabled` column on `projects`). Add a `getProjectPrdPath(workspaceRoot, projectId)` helper mirroring `constitutionUtils.getConstitutionPath`.

### `src/services/KanbanProvider.ts`
2. Add `_resolveProjectPrd(workspaceRoot, projectId, enabled)` mirroring `_resolveConstitution` (:2793) — read the project's PRD file → `{ prdLink, prdContent }`.
3. In option resolution (alongside :2891-2896), resolve the **active project's** PRD and set `prdEnabled`/`prdLink`/`prdContent`; fall back to `_resolveGlobalDesignDoc` only when the project has no PRD.
4. Ensure the active `project_id` (from `_projectFilter`) is available to this path.

### `src/services/agentPromptBuilder.ts`
5. Add `prdEnabled`/`prdLink`/`prdContent` to `PromptBuilderOptions` and inject a PRD reference block into the **`dispatchPrefixCore` shared prefix** (`:483`) — mirroring the §11 `remoteModeBlock` pattern (`:482`), **not** the planner-only constitution injection — so all dispatched prompts (planner, lead, coder, reviewer, tester, orchestrator, …) carry the PRD when `prdEnabled`. Gated solely by the project-context toggle + an active-project PRD, independent of any per-role add-on. **Also** wire the PRD into the separate custom-agent path: `buildCustomAgentPrompt` (`:1270+`, its own `dispatchContextPrefix` at `:1277`) and the custom-agent resolution branch in `generateUnifiedPrompt` (`KanbanProvider.ts:2821-2851`). For the orchestrator, prefer the PRD *link* over full content (terseness, ↔ `…120812`). See Code-Grounding Correction #2/#3.

5b. **Tester reconciliation (new, required).** Update the `role === 'tester'` branch in `generateUnifiedPrompt` (`KanbanProvider.ts:2910-2913`) so it resolves the active project's PRD first and only falls back to the global design doc; throw only when **neither** exists, with a message that mentions the PRD. Without this, attaching a per-project PRD (instead of the legacy global `designDocLink`) breaks tester dispatch. See Code-Grounding Correction #4.

### `src/webview/kanban.html`
6. New **Projects tab**: list projects (reuse `allWorkspaceProjects`), create/rename/delete, and a per-project PRD editor (model on the constitution tab UI).
7. A **"Project Context"** toggle button beside `workspace-project-select` (:2513) that enables/disables injection of the active project's PRD.
8. Demote the planner-only "Planning Epic Reference" add-on (:2876-2879): the project-context toggle replaces it as the PRD control. Keep the `designDoc` key wired only as a back-compat fallback (existing saved planner configs keep resolving), but it is no longer the surfaced way to attach a PRD.
9. Remove any PRD/planning-context affordance from the Epics tab (orchestration-only).

### `src/services/PlanningPanelProvider.ts` (corrected target — was DesignPanelProvider)
10. **Corrected (see Code-Grounding Correction #5):** the actual PRD/"Planning Epic Reference" writer is `PlanningPanelProvider.ts` (`planner.designDocLink`/`designDocEnabled` written at `~:2605`, `~:5710`; cleared at `~:5630-5636`; read at `~:6009-6017`), **not** `DesignPanelProvider.setActivePlanningContext` (which writes the unrelated `designSystemDocLink`). Treat the `PlanningPanelProvider` design-doc setter as the legacy/fallback path: keep it writing `designDocLink` so existing installs keep resolving via `_resolveGlobalDesignDoc`, but it is no longer the surfaced way to attach a PRD. **Leave `DesignPanelProvider.setActivePlanningContext` (`:1457`) untouched** — the design-system doc is out of scope for this plan.

## Verification Plan

### Automated Tests
- Unit-cover `_resolveProjectPrd` (correct project by name, fallback to global design doc, none when "No Project"/`__unassigned__`) and PRD injection in the prompt builder for the configured roles. (Run separately per session norm.)
- Unit-cover the PRD block appearing in `dispatchPrefixCore` for a non-planner role (e.g. coder) AND in `buildCustomAgentPrompt`, proving both prompt paths are covered.
- Unit-cover the tester branch (Correction #4): PRD present + no global doc → no throw, PRD injected; neither present → throws with the updated message.
- Unit-cover name-derived PRD path sanitisation (a project name with `/` or `..` cannot escape `.switchboard/projects/`).

### Manual Verification
1. Projects tab: create a project, author a PRD, see it persist; delete executes immediately (no confirm).
2. Assign plans to the project (existing ASSIGN flow); with "Project Context" on, dispatch across **multiple roles** (planner, lead/coder, reviewer, tester) → every one of their prompts includes the project's PRD block.
3. Turn "Project Context" off → PRD not injected.
4. An epic in the project with no orchestration dependency on the PRD → dispatches with subtask-derived overview, no forced PRD (epic self-sufficiency preserved).
5. Switch to a project with no PRD → no PRD injected (and global `designDocLink` fallback applies only if set).
6. "No Project" / unfiltered board → no PRD injected.
7. Epics tab shows orchestration epics only — no PRD/planning-context controls.
8. Existing install with a global `planner.designDocLink` set → still honored as fallback; nothing dropped.

## Recommendation

Complexity 7/10 → **Send to Lead Coder.** The original 6/10 "Send to Coder" framing assumed the work was mostly mirroring the constitution pattern; code-grounding revealed three things that raise the risk to High: (1) the tester role hard-throws without a design doc and must be reconciled (Correction #4), (2) "all roles" spans two distinct prompt paths and the constitution is the wrong template (Corrections #2/#3), and (3) a misattributed file (Correction #5). Strongly prefer the **split**: a foundation slice — name-based per-project PRD storage + `getProjectPrdPath` + `_resolveProjectPrd` + the `dispatchPrefixCore`/custom-agent injection + tester reconciliation + the project-context toggle — landed and verified first; then a UI slice — the full Projects tab + PRD editor (modelled on the constitution tab). The careful parts are the active-project (name) plumbing and the tester landmine; the rest reuses existing project + prefix infrastructure.
