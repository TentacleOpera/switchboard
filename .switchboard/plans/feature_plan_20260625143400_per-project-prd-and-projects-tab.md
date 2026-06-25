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

---

## Reviewer Pass (2026-06-25, in-place reviewer-executor)

Reviewed the implemented code against this plan as the source of truth. The "danger trio" the plan flagged (tester throw, two prompt paths, misattributed file) was the focus. Verdict: **implementation is faithful and complete; no CRITICAL/MAJOR code defects found; no code fixes applied** (none warranted — see below). Verification was static/manual only (compilation + tests skipped per session directive).

### Stage 1 — Grumpy Principal Engineer

> *Cracks knuckles. Adjusts monocle. Pulls the diff up on the big monitor.*
>
> "Right. You told me you decoupled the PRD from epics. Half this team can't decouple a USB cable. Let's see what you actually shipped before I believe a word of it.
>
> **The tester landmine (Correction #4) — the one that would've paged me at 3am.** `KanbanProvider.ts:2980` — *fine*. You resolve the project PRD into `resolvedOptions.prdEnabled` BEFORE the role branches (`:2938`), then the tester branch throws **only** when `!designDocLink && !resolvedOptions.prdEnabled`. The error message even names the Projects tab and the toggle instead of the old 'enable a Planning Epic in Setup' lie. I came here to scream and you took my screaming away. Disappointing. NIT at most: you re-`await _resolveGlobalDesignDoc` inside the tester branch (`:2979`) when the planner branch already resolves it — two reads of the same config on a planner→tester pipeline. It's a `getConfiguration` read, not a disk hit. I'll allow it.
>
> **'All roles' — the claim that's a lie in 90% of codebases.** You SAID every dispatched prompt. I counted. Fourteen role branches in `buildKanbanBatchPrompt`, fourteen `suffixBlock`s, fourteen `dispatchContextPrefix` references (`:603–1263`). The PRD rides in `dispatchPrefixCore` (`:531`) right next to the §11 remote-mode block exactly as Correction #2 demanded — NOT bolted onto the planner-only constitution like a coward would've done. And the *second* prompt path, `buildCustomAgentPrompt`, gets its own explicit injection (`:1411`) wired from the custom-agent resolution branch (`:2885`). You found BOTH paths. Who are you and what did you do with the usual author.
>
> **The misattribution trap (Correction #5).** I went hunting for the crime scene — did some intern 'fix' `DesignPanelProvider.setActivePlanningContext` and nuke the design-SYSTEM doc by accident? No. It's untouched. The PRD writer work stayed clear of it. Grudging nod.
>
> **Path traversal.** `sanitizeProjectSlug` (`prdUtils.ts:16`) clamps to `[a-z0-9_-]`, collapses runs, trims, length-caps, re-trims, and falls back to `'project'` on empty. A project named `../../etc/passwd` becomes `etc-passwd`. Try-hard malicious name? Neutered. The verbatim-injection trust boundary is identical to the constitution's — consistent, defensible.
>
> **Now the thing that actually annoys me. The race.** Your OWN edge-case audit (line 62) said: resolve the PRD from *the plan's stored project*, fall back to the live filter. You did NOT. You key entirely on `getDisplayedProjectForRoot` (`:4607`) → the live in-memory `_projectFilter`. Yes, I checked — `_projectFilter` is set *synchronously* in `setProjectFilter` (`:4618`); only the workspaceState *persist* is debounced, so the in-memory read is never stale. Fine. AND it returns `null` for cross-workspace dispatch and `__unassigned__`, so a background automation dispatch can never inject the WRONG project's PRD — worst case it injects *none*. So the security failure mode is closed. But the *correctness* gap is real and you waved it away: `BatchPromptPlan` has no `project` field (`:28`), so if autoban dispatches a plan belonging to project A while the board is filtered to project B *in the same workspace*, plan A gets B's PRD. You didn't fix it because fixing it means threading `project` through every dispatch builder. Pragmatic. But don't pretend the audit item is satisfied — it's *deferred*, not *done*. Say so in the plan or I'll know you're hiding it.
>
> **Projects tab scope creep — in reverse.** Step 6 promised 'create/rename/delete' IN the Projects tab. What I got: a PRD editor and a project dropdown. Create/delete live on the Kanban toolbar (pre-existing). Rename doesn't exist anywhere — never did. The empty-state literally tells the user 'add one on the Kanban tab (+)'. It's honest, it works, but it is NOT what step 6 said. NIT — the Complexity Audit already conceded create/delete exist on the toolbar, so this is a wording mismatch, not a missing feature.
>
> **Custom-agent orchestrator.** If someone wires a *custom* agent as their orchestrator, `buildCustomAgentPrompt` injects the full PRD *content* (`:1411`), not the link — blowing the terseness goal you coordinated with the slim-orchestrator plan. But that goal was scoped to the *built-in* orchestrator role, which DOES get the link (`:326`). Custom path is separate by design. NIT.
>
> **Dead-ish defensive branch.** `_resolveProjectPrd` only ever returns `prdLink` *with* `prdContent` (`:2838`), so the link-only `else` in `buildPrdReferenceBlock` (`:335`) and the orchestrator content-only branch are unreachable via the real resolution path. Harmless — it mirrors the link/content shape used everywhere else and guards against future callers. Leave it.
>
> *Sits back.* "I wanted blood. I got a clean implementation that did the three hard things the plan said were hard. Two NITs worth writing down, one deferred audit item worth being honest about. Get out of my office."

### Stage 2 — Balanced synthesis

**Keep (verified correct):**
- Tester reconciliation (`KanbanProvider.ts:2974–2984`): PRD-first, global-design-doc fallback, throws only when neither exists, with an updated user-facing message. Correction #4 fully addressed.
- Two-path "all roles" injection: `dispatchPrefixCore` (`agentPromptBuilder.ts:531`) reaches all 14 built-in roles; `buildCustomAgentPrompt` (`:1411`) + custom-agent resolution branch (`KanbanProvider.ts:2885`) cover the separate path. Correction #2/#3 fully addressed.
- `DesignPanelProvider.setActivePlanningContext` left untouched; back-compat (`designDoc` add-on key, `_resolveGlobalDesignDoc`, planner/tester fallbacks) preserved. Correction #5 honored + migration rule satisfied (purely additive: new `project_context_enabled` config key, new PRD files; nothing dropped).
- Name-based slug + path-traversal sanitisation (`prdUtils.ts`); `_resolveProjectPrd` faithfully mirrors `_resolveConstitution`'s try/catch read shape.
- Toggle gating is airtight: OFF ⇒ no `prdEnabled` ⇒ no injection on either path; `prdEnabled` only set when a non-empty PRD actually exists for the active (non-unassigned, same-workspace) project.
- No `confirm()`/confirmation-dialog regressions introduced (project rule); new buttons reuse real `strip-btn`/`is-teal`/`is-off` styles.

**Fix now:** Nothing. No CRITICAL/MAJOR defect. The two NITs and the deferred race item do not justify code churn against committed, working behavior — and the only "complete" fix for the race (adding `project` to `BatchPromptPlan` and threading it through every dispatch builder) is a cross-cutting change with its own regression surface that the plan itself listed as an *advisory* edge-case mitigation, not a Proposed Change. The actual Proposed Change (step 4, "ensure the active project is available to this path") IS satisfied by `getDisplayedProjectForRoot`.

**Defer / document (no action this pass):**
1. **Race mitigation is partial, not complete.** PRD is keyed on the displayed filter, not the dispatched plan's own project. Security failure mode (wrong PRD across workspaces / on unassigned boards) is closed; the residual is a same-workspace automation dispatch of an off-filter plan getting the displayed project's PRD. Revisit if/when `BatchPromptPlan` gains a `project` field.
2. **Projects-tab CRUD wording.** Step 6 said create/rename/delete in-tab; shipped as PRD-editor-only with CRUD on the toolbar (rename never existed). Functional, but the plan text overstates the tab's scope.
3. **Custom-agent orchestrator gets full PRD content, not the link** — terseness goal applies only to the built-in orchestrator (which is correct). Acceptable.

### Files reviewed (no edits applied this pass)
- `src/services/prdUtils.ts` — new: `sanitizeProjectSlug`, `getProjectPrdPath`.
- `src/services/agentPromptBuilder.ts` — `PromptBuilderOptions.prd{Enabled,Link,Content}` (`:201–205`); `buildPrdReferenceBlock` (`:321`); `dispatchPrefixCore` fold (`:531`); custom-agent injection (`:1411`).
- `src/services/agentConfig.ts` — `CustomAgentAddons.prd{Link,Content}` (`:42–43`).
- `src/services/KanbanProvider.ts` — `_resolveProjectContextEnabled` (`:2815`); `_resolveProjectPrd` (`:2831`); batch + custom-agent option resolution (`:2885`, `:2938`); tester reconciliation (`:2974`); `getDisplayedProjectForRoot` (`:4607`); board-state `projectContextEnabled` (`:1295`, `:2194`, `:2352`); message handlers `setProjectContextEnabled`/`getProjectPrd`/`saveProjectPrd` (`:5224–5285`).
- `src/webview/kanban.html` — PROJECTS tab button (`:2460`) + content (`:2541`); PROJECT CONTEXT toggle (`:2482`); planner add-on demoted to "Planning Epic Reference (legacy)" with `designDoc` key preserved (`:2867–2871`, `:4092`); editor/toggle JS (`:3810–3891`); hydration (`:3986`) + message handlers (`:6105–6164`).

### Validation results
- **Compilation:** SKIPPED per session directive.
- **Automated tests:** SKIPPED per session directive.
- **Static/manual review:** PASS. All 14 role suffixBlocks confirmed to consume `dispatchContextPrefix`; both prompt paths inject the PRD; toggle gating verified ON/OFF; tester throw verified PRD-first; sanitisation verified against `..`/`/`; back-compat keys & fallbacks verified intact; no confirmation dialogs; referenced webview helpers (`getActiveWorkspaceRoot`, `activeProjectFilter`) and CSS classes (`strip-btn`, `is-teal`, `is-off`) confirmed to exist.

### Findings summary (by severity)
- **CRITICAL:** none.
- **MAJOR:** none.
- **NIT/Deferred:**
  - Race: PRD keyed on displayed filter, not the plan's project — partial mitigation of the line-62 audit item (`KanbanProvider.ts:4607`, `agentPromptBuilder.ts:28`). Wrong-PRD-across-workspace is closed; same-workspace off-filter automation dispatch is the residual. Deferred (needs `BatchPromptPlan.project`).
  - Tester branch re-reads `_resolveGlobalDesignDoc` already resolved for planner (`KanbanProvider.ts:2979`) — negligible (config read). No fix.
  - Projects tab is PRD-editor-only; create/delete on toolbar, no rename — step-6 wording overstates scope (`kanban.html:2541`). No fix.
  - Custom-agent orchestrator injects full PRD content vs. link (`agentPromptBuilder.ts:1411`) — out of the built-in-orchestrator terseness scope. No fix.

### Remaining risks
- The deferred race item is the only behavioral risk, and it is bounded (no cross-project *security* leak; worst real-world case is an off-filter automation dispatch picking up the displayed project's PRD within one workspace). Acceptable for ship; track against a future `BatchPromptPlan.project` thread-through.
- Compilation/tests were not run this pass (per directive) — the user's separate test run is the gate for type-level regressions.

---

## UAT Failure & Correction (2026-06-26) — PRD UI moved from kanban.html → project.html

**UAT verdict: FAILED on placement.** The implementation added the PROJECTS tab + per-project PRD editor + PROJECT CONTEXT toggle as a **top-level tab on the kanban board panel (`kanban.html` / `KanbanProvider`)**. That is the wrong surface. The owner's intent — and the obvious home given the rest of this plan — was the **Project panel (`project.html` / `PlanningPanelProvider`)**, as a tab **between KANBAN PLANS and EPICS**, sitting next to the **CONSTITUTION** editor (the very tab this plan named as the structural model). `kanban.html` is not a legacy/superseded panel; it simply **was never intended to host doc creation**. PRD authoring is doc creation, so it belongs in the Project panel alongside the constitution editor.

This means Proposed Changes steps **6–9** and the Reviewer-Pass file list (which target `kanban.html`) are **superseded** by the relocation below. The backend *dispatch/injection* layer (the genuinely careful part — `_resolveProjectPrd`, `_resolveProjectContextEnabled`, the `dispatchPrefixCore` + `buildCustomAgentPrompt` injection, tester reconciliation) was correct and is **unchanged**; only the authoring UI and its message handlers moved.

### What changed in the correction
- **`src/webview/kanban.html`** — removed the PROJECTS top-level tab button, the `projects-tab-content` div, the PROJECT CONTEXT toolbar toggle, and all associated inline JS (`projectContextEnabled` state, `updateProjectContextButton`, `populateProjectsPrdSelect`, `requestProjectPrd`, `setProjectsPrdEditorEnabled`, the toggle/select/save listeners, the tab-hydration hook, and the `projectContextEnabled`/`projectPrdContent`/`projectPrdSaved` message cases). The legacy planner add-on "Planning Epic Reference (legacy)" (`designDoc` key) is **left intact** — it is role config, not doc creation, and remains the back-compat fallback.
- **`src/webview/project.html`** — added a **PROJECTS** `shared-tab-btn` between KANBAN PLANS and EPICS, plus a `projects-content` tab with its own workspace filter, project selector, **PROJECT CONTEXT** toggle, **SAVE PRD** button, status text, path hint, and PRD textarea. Self-contained (no `is-teal`/`is-off`/`db-subsection` classes — the toggle's on/off look is applied inline).
- **`src/webview/project.js`** — new Projects-tab wiring: element refs + `projectsFilters`/`projectContextEnabled` state, `populateWorkspaceDropdowns` now fills the projects workspace filter, `getProjectsTabWorkspaceRoot`/`updateProjectsPrdSelect`/`requestProjectPrd`/`requestProjectContextEnabled`/`hydrateProjectsTab`/`updateProjectContextButton`/`setProjectsPrdEditorEnabled`, the four listeners, the `projects` tab-activation hook, the kanbanPlansReady re-hydrate, and the `projectContextEnabled`/`projectPrdContent`/`projectPrdSaved` message cases.
- **`src/services/PlanningPanelProvider.ts`** — added `getProjectContextEnabled`/`setProjectContextEnabled`/`getProjectPrd`/`saveProjectPrd` message cases in `_handleMessage` (posting back to `_projectPanel.webview`), reusing `prdUtils.getProjectPrdPath` and validating `workspaceRoot` against `_getWorkspaceRoots()`. The toggle is read/written through new public KanbanProvider accessors so the dispatch path keeps reading the same `project_context_enabled` config.
- **`src/services/KanbanProvider.ts`** — added public `getProjectContextEnabled(root)` / `setProjectContextEnabled(root, enabled)` accessors; removed the three now-dead `kanban.html`-only webview message cases. Dispatch-path resolvers and the board-state payload are unchanged.

### Decision recorded
- The **PROJECT CONTEXT** toggle was consolidated **into the Projects tab** (alongside the PRD it gates) rather than left on the kanban toolbar — the whole PRD feature is now self-contained in one place. It remains a per-workspace master switch writing the same `project_context_enabled` config the dispatch path reads.

### Validation (this correction)
- `npx tsc --noEmit`: no new errors (only two pre-existing `await import(...)` node16 warnings in `ClickUpSyncService.ts`/`KanbanProvider.ts`, untouched by this work).
- `npm run compile` (webpack): succeeds (only the pre-existing jsdom `canvas` warning).
- `node --check src/webview/project.js`: passes; all new identifiers declared and referenced.
- `kanban.html` confirmed free of every PRD identifier after removal.
