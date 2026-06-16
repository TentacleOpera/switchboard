# Project Webview

## Goal

Create a new `project.html` webview that consolidates internal project management surfaces into one place: the Kanban board (moved from `planning.html`), an explicit Epics tab (replacing the hidden Plans/Epics toggle and the "use document as planning context" feature), and a Constitution tab for project governance.

`planning.html` is left as a purely external-artifacts surface: Local Docs, Online Docs, Tickets, Research, Notebook.

**Core problem / root cause (from code audit):** The project-management surfaces are currently entangled inside `planning.html` and, more importantly, inside the **`PlanningPanelProvider` message-handler layer** (`src/services/PlanningPanelProvider.ts`, ~5,286 lines). The Kanban tab is visually self-contained in the HTML/JS, but its behavior is driven by ~14 `case` handlers inside `PlanningPanelProvider.onDidReceiveMessage` (lines ~1470–1922) plus `setActivePlanningContext` (line 1509). Any migration therefore is not a "move some HTML" task — it is a **provider-ownership decision**: a new panel must either re-host or share those handlers. This is the central architectural risk the original draft under-stated.

## Metadata

**Tags:** ui, feature, refactor, frontend, backend

**Complexity:** 7

> _Re-graded from 5 → 7 after code audit. Rationale: a new webview panel that must replicate/share ~14 message handlers from a 5,286-line provider class, a net-new Constitution feature whose skill-invocation mechanism does not yet exist in the codebase, and prompt-injection plumbing spanning two services (`KanbanProvider.ts` + `agentPromptBuilder.ts`). Multi-file coordination + new pattern + cross-service state = High._

## User Review Required

The following must be decided by the user before implementation, because each materially changes the work:

1. **Provider strategy for the Kanban tab (BLOCKING).** The Kanban message handlers live inside `PlanningPanelProvider`, not `extension.ts`. Choose one:
   - **(A) Shared provider (recommended):** Have `PlanningPanelProvider` (or a small extracted `KanbanMessageHandlers` mixin) also serve the new project panel, so the handlers are not duplicated. Less code, single source of truth, but requires `this._panel` references to be panel-aware (the provider currently assumes one `_panel`).
   - **(B) New `ProjectPanelProvider`:** A new class duplicating the Kanban/epic handlers. Clean separation, but ~14 handlers + helper methods copied out of a 5,286-line file; risk of drift.
2. **Constitution "Build" mechanism.** There is **no programmatic skill runner** in this codebase today (skills are `.md` files in `.agent/skills/` that agents read). Confirm the intended mechanism for "Build Constitution": dispatch a prompt to an agent terminal that references `constitution_builder.md` (mirroring how planner prompts are dispatched), vs. a new dedicated command. This plan assumes terminal-dispatch.
3. **Status bar item.** Repurpose `artifactsStatusBarItem` (extension.ts line 1778) to point at `switchboard.openProjectPanel`, or add a distinct `projectStatusBarItem`? (Status bar already hosts Kanban/Artifacts/Design — adding a 4th may crowd it.)

## Complexity Audit

### Routine
- Creating `project.html` shell from the existing webview pattern (CSP, fonts, CSS vars, `shared-tabs.css`, three-tab controls strip).
- Registering `switchboard.openProjectPanel` command in `extension.ts` and `package.json` (mirrors `switchboard.openPlanningPanel`, line 807).
- Copying Kanban tab HTML (`planning.html` lines 3147–3186) and its CSS (`#kanban-content` line 123/133, `#kanban-preview-pane` line 956+) into the new shell.
- Adding `constitutionContent?`/`constitutionLink?` to `PromptBuilderOptions` and injecting them in the planner branch (mirrors `designDocContent`, `agentPromptBuilder.ts` lines 519–521).
- Constitution file discovery / read / save handlers (standard fs + workspace scan, mirrors Local Docs).

### Complex / Risky
- **Provider-ownership of Kanban handlers** — the ~14 handlers in `PlanningPanelProvider.onDidReceiveMessage` (lines 1470–1922) + `setActivePlanningContext` (1509) must be shared or duplicated; this is the dominant risk (see User Review #1).
- **`activeDoc*` planning-context state** moving ownership from the planning.html Kanban toggle to the new Epics tab without breaking the existing `setActivePlanningContext` contract.
- **Constitution → planner prompt injection** spans two services (`KanbanProvider._resolveGlobalDesignDoc` pattern + `agentPromptBuilder.buildKanbanBatchPrompt`) — the original draft pointed at `extension.ts`, which is incorrect.
- **Skill-invocation mechanism is net-new** — no existing pattern to copy; must be defined (see User Review #2).
- Editing the correct provider file — a stale `src/services/PlanningPanelProvider.ts.bak3` exists alongside the live file; do not edit the `.bak3`.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two panels (planning + project) open simultaneously both reacting to the same kanban-state messages. If a shared provider is used, `postMessage` must target the correct `_panel`; the provider currently models a single `_panel` (PlanningPanelProvider line 53). Resolve before shipping shared-provider.
- `activeDoc*` set from the new Epics tab while the old planning context UI is mid-teardown — ensure only one writer remains after migration.

**Security**
- Constitution content is injected verbatim into planner prompts. Treat it as untrusted-ish project input; it is governance text, not code, but enforce the same prompt-size guard as `designDocContent` to avoid unbounded prompt growth (Edge Case 5).
- Constitution file read/write must stay scoped to workspace root + control plane; do not allow arbitrary path traversal from the webview message payload.

**Side Effects**
- Removing the Kanban tab from `planning.html` (button line 2943, div lines 3147–3186, CSS, planning.js logic) changes the Artifacts panel's surface; the `artifactsStatusBarItem` label/tooltip (line 1776–1778) becomes misleading if repurposed.
- `kanban.html` line 6038 contains only a *comment* referencing `switchboard.openPlanningPanel` — no live link breaks, but update the comment for accuracy.
- Removing the `kanban-view-epics-toggle` (planning.js lines 4002–4005) and `_kanbanViewMode` (line 3749) deletes a user-facing toggle; the Epics tab must fully replace its discoverability.

**Dependencies & Conflicts**
- Kanban message handlers in `PlanningPanelProvider.ts` (lines 1470–1922, `setActivePlanningContext` 1509) — shared or duplicated.
- `activeDocId/activeDocName/activeDocContent/activeDocFilePath` state (planning.js lines 11–14) — note: original draft called this `activeDocPath`; the real fields are these four.
- `_resolveGlobalDesignDoc` in `KanbanProvider.ts` (line 2412) — template for a new `_resolveConstitution`.
- `designDocContent` injection in `agentPromptBuilder.ts` (lines 519–521) — template for constitution injection.
- `isEpic` flag on plan objects (planning.js lines 4049, 4086+) — drives Epics filtering.
- Existing epic handlers: `getEpicDetails` (1857), `addSubtaskToEpic` (1874), `removeSubtaskFromEpic` (1908), `deleteEpic` (1922).

## Dependencies

- None blocking with a known session ID. Related future work — the Tuning tab (adversarial-review extraction + CONSTITUTION.md improvement from plan history) — is tracked separately in `constitution-and-tuning-tabs.md` and is **Out of Scope** here.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the Kanban message handlers live in the 5,286-line `PlanningPanelProvider`, not `extension.ts`, so migration is a provider-ownership decision, not a reference hand-off; (2) constitution prompt-injection belongs in `KanbanProvider.ts` + `agentPromptBuilder.ts`, not `extension.ts`; (3) no programmatic skill-invocation mechanism exists, so "Build Constitution" must be defined explicitly. Mitigations: choose the shared-provider approach (User Review #1) to avoid handler duplication, mirror the proven `_resolveGlobalDesignDoc`/`designDocContent` pattern for injection, and dispatch the builder via an agent terminal prompt referencing `constitution_builder.md`.

## Proposed Changes

> The original 5-phase implementation plan is preserved below in full, with code-audit corrections applied inline (marked **[Correction]** / **[Clarification]**). All original code blocks and step detail are retained.

### Phase 1: Shell — Create project.html and Register It

**File**: `src/webview/project.html` (new)

- Follow the existing webview pattern: CSP headers, font loading, CSS variables, shared-tabs.css import
- Three-tab layout in controls strip: KANBAN, EPICS, CONSTITUTION
- Tab content divs: `#kanban-content`, `#epics-content`, `#constitution-content` — hidden/shown via `.active` class
- Start with placeholder content in Epics and Constitution tabs; Kanban gets real content in Phase 2

**File**: `src/extension.ts`

- Add `projectPanelProvider` following the same provider pattern as `planningPanelProvider` (extension.ts line 807 registers `switchboard.openPlanningPanel`; the provider is constructed just above, ~line 786).
- **[Correction]** If User Review #1 selects the **shared-provider** approach, do not construct a second provider — instead teach `PlanningPanelProvider` to open a second panel (`openProject()`), and register `switchboard.openProjectPanel` to call it. Only construct a separate `ProjectPanelProvider` if option (B) is chosen.
- Register command `switchboard.openProjectPanel`
- Add `projectStatusBarItem` in the status bar block (extension.ts lines 1769–1785) — or repurpose `artifactsStatusBarItem` (line 1775–1779) to point to `switchboard.openProjectPanel` and update its `.text`/`.tooltip` (currently `$(notebook) Artifacts` / `Open Artifacts Panel`). See User Review #3.

**File**: `package.json`

- Register `switchboard.openProjectPanel` command

---

### Phase 2: Migrate Kanban Tab

The Kanban tab in planning.html is self-contained in its HTML/CSS/JS: its HTML is at lines 3147–3186, its CSS at `#kanban-content` (line 123/133) and `#kanban-preview-pane` (line 956+), and its JS is in `planning.js`.

> **[Correction — critical]** The original draft stated the Kanban message handlers "are in extension.ts, not planning.html — they just need the new panel's webview reference passed correctly." This is **wrong**. The handlers are `case` blocks inside `PlanningPanelProvider.onDidReceiveMessage` (`src/services/PlanningPanelProvider.ts`): `importPlans` (1610), `fetchKanbanPlans` (1615), `openKanbanPlan` (1685), `fetchKanbanPlanPreview` (1702), `setKanbanPlanContext` (1708), `copyKanbanPlanPrompt` (1730), `moveKanbanPlanColumn` (1748), `planShown` (1766), `setKanbanPlanComplexity` (1773), `deleteKanbanPlan` (1797), `fetchKanbanPlanLog` (1838), `getEpicDetails` (1857), `addSubtaskToEpic` (1874), `removeSubtaskFromEpic` (1908), `deleteEpic` (1922), plus `setActivePlanningContext` (1509). The new panel must **share or re-host** these (User Review #1), not merely "pass a reference."

**File**: `src/webview/project.html`

- Copy the Kanban tab HTML from `planning.html` lines 3147–3186 into `#kanban-content`
- Copy the Kanban-specific CSS (the `#kanban-content` rules near line 123/133 and the `#kanban-preview-pane` block at line 956+) into project.html's `<style>` section
- Copy or inline the Kanban JS from `planning.js` into project.html's `<script>` section. This includes:
  - `_kanbanViewMode` state (planning.js line 3749) and the `kanban-view-epics-toggle` handler (lines 4002–4005)
  - `activeDoc*` state (will be repurposed by the Epics tab in Phase 3 — keep it intact for now) — **[Correction]** the real fields are `activeDocId`, `activeDocName`, `activeDocContent`, `activeDocFilePath` (planning.js lines 11–14), not `activeDocPath`.
  - All plan list rendering and preview logic (filter at line 4048–4049 uses `plan.isEpic`)

**File**: `src/webview/planning.html`

- Remove the `KANBAN PLANS` tab button (line 2943: `<button class="shared-tab-btn" data-tab="kanban">KANBAN PLANS</button>`)
- Remove `#kanban-content` div (lines 3147–3186)
- Remove Kanban-specific CSS blocks
- Remove Kanban-related JS in planning.js

**Verify outgoings from the old Kanban tab still work** (now correctly located in `PlanningPanelProvider.ts`):
- `btn-import-kanban-plans` → `importPlans` handler (1610)
- `btn-edit-kanban` / `btn-save-kanban` → kanban edit/save handlers
- `kanban-workspace-filter` / `kanban-project-filter` → filter handlers
- Plan preview read → `fetchKanbanPlanPreview` (1702)
- **[Correction]** These must reach the new panel's webview. Under the shared-provider approach, ensure the handler `postMessage` calls target the panel that originated the message, since `PlanningPanelProvider` currently models a single `_panel` (line 53).

---

### Phase 3: Epics Tab

The epics feature already exists in the Kanban tab as a toggle mode (`_kanbanViewMode === 'epics'`, planning.js lines 4048–4049). The Epics tab makes this a first-class surface and takes over the `activeDoc` planning context role.

**File**: `src/webview/project.html`

- In `#epics-content`, add a split pane layout matching the Kanban tab: list pane on left, preview pane on right
- List pane: render only plans where `isEpic === true` (reuse the same plan item rendering, filtered — same filter used at planning.js line 4049)
- Preview pane: show selected epic's markdown content
- Add "Set as Planning Context" button — on click, sets the selected epic as the active doc and sends `setActivePlanningContext` to the extension (the existing handler at PlanningPanelProvider.ts line 1509)
- Show active epic banner (same `active-doc-banner` pattern; banner toggling logic at planning.js lines 3636–3644)
- Remove the `kanban-view-epics-toggle` button from the Kanban tab now that Epics has its own tab

**File**: `src/webview/planning.js` (or equivalent in project.html script)

- Remove `_kanbanViewMode` toggle logic (lines 3749, 4002–4005, 4048–4049, 4086, 4225) once the Epics tab is in place
- The `activeDoc*` state remains; it is now exclusively set from the Epics tab via `setActivePlanningContext`

---

### Phase 4: Constitution Tab

> **[Clarification]** A repo-wide audit found **zero** existing references to "constitution" in `src/`. Both the tab and the skill are genuinely net-new. There is also no existing programmatic skill-invocation mechanism — skills under `.agent/skills/` are markdown read by agents. See User Review #2 for the "Build" mechanism.

**File**: `src/webview/project.html`

- In `#constitution-content`, add a split pane: tree pane on left, preview pane on right (same pattern as Local Docs tab in planning.html)
- Tree pane: scan workspace root and control plane for `CONSTITUTION.md`; one entry per workspace maximum
- Preview pane: render selected file's markdown content (use `markdown.api.render` command — already used in PlanningPanelProvider at lines 2192/2413)
- Add "Build Constitution" button — **[Clarification]** sends a message to the extension that dispatches an agent-terminal prompt instructing the agent to follow `.agent/skills/constitution_builder.md` (mirroring how planner prompts are dispatched, not a direct programmatic skill call)
- Add "Edit" / "Save" buttons using the existing markdown editor pattern (`<textarea class="markdown-editor">`)
- Empty state: if no `CONSTITUTION.md` found, show prompt to build one

**File**: `src/services/PlanningPanelProvider.ts` (or `ProjectPanelProvider.ts`, per User Review #1)

> **[Correction]** Original draft said "src/extension.ts". The message-handler layer is in the panel provider, not extension.ts.

- Add message handlers for constitution operations on the project panel:
  - `loadConstitutionFiles` — scans workspace/control plane, returns file list
  - `readConstitutionFile` — returns file content (path-scoped to workspace/control plane)
  - `saveConstitutionFile` — writes file content (path-scoped)
  - `invokeConstitutionBuilder` — dispatches the agent-terminal prompt referencing `constitution_builder.md`

**File**: `.agent/skills/constitution_builder.md` (new)

- Interview-style skill that builds or improves a CONSTITUTION.md
- Covers: project domain, coding standards, architecture invariants, security/performance/testing requirements
- Handles both new file creation and improvement of an existing constitution

---

### Phase 5: Constitution Prompt Injection

**File**: `src/services/agentPromptBuilder.ts`

- Add `constitutionContent?: string` and `constitutionLink?: string` to `PromptBuilderOptions` (interface at line 77; place near `designDocContent`/`designDocLink` at lines 98–100)
- In `buildKanbanBatchPrompt()` for the planner role, inject constitution after existing context. **[Correction]** The precise location is the planner branch, immediately after the `designDocContent` block at lines 519–521 (and before the design-system-doc block):

```typescript
const constitutionContent = options?.constitutionContent?.trim();
if (constitutionContent) {
    plannerPrompt += `\n\nPROJECT CONSTITUTION:\nThe following are inviolate rules and invariants for this project:\n\n${constitutionContent}`;
}
```

- Prefer inline content; fall back to link if content is too large or not pre-fetched (apply the same size guard used for `designDocContent`)

**File**: `src/services/KanbanProvider.ts`

> **[Correction]** Original draft said "src/extension.ts". `buildKanbanBatchPrompt` is called from `KanbanProvider.ts` (import at line 20; callers around lines 2452/2498/2516), and design-doc resolution lives in `_resolveGlobalDesignDoc` (line 2412). extension.ts does not dispatch these prompts.

- Add a `_resolveConstitution(workspaceRoot)` helper mirroring `_resolveGlobalDesignDoc` (line 2412) that reads `CONSTITUTION.md` from workspace/control plane and returns `{ constitutionContent?, constitutionLink? }`
- When dispatching planner prompts, call it and pass the result into the `PromptBuilderOptions` (alongside the existing `designDocContent` assignment at lines 2500/2516) so it reaches `buildKanbanBatchPrompt()`

---

## Edge Cases

1. **Kanban message handlers post-migration**: **[Correction]** The handlers are in `PlanningPanelProvider.ts` (lines 1470–1922, 1509), not extension.ts. Under shared-provider, `postMessage` must target the originating panel; under a new provider, every handler + helper must be ported. Audit every handler listed in Phase 2.
2. **No epics exist**: Epics tab shows empty state with explanation and link to promote a plan to epic from the Kanban tab.
3. **No constitution exists**: Constitution tab shows empty state with "Build Constitution" button.
4. **Multiple workspaces**: Tree pane groups constitution files by workspace (same pattern as Local Docs).
5. **Constitution too large for prompt**: Truncate to a reasonable token budget or fall back to link-only injection.
6. **artifactsStatusBarItem**: If repurposed to point to Project instead of Planning, update label (line 1776) and tooltip (line 1777); if a new item is added instead, confirm the status bar doesn't become crowded (Kanban/Artifacts/Design already present, lines 1769–1785).
7. **[New] Wrong file edit**: `src/services/PlanningPanelProvider.ts.bak3` exists; all edits must target the live `PlanningPanelProvider.ts`.

## Dependencies (reference)

- Existing planning.html CSS and JS patterns (reference, not shared)
- Existing `activeDoc*` planning context state in planning.js (lines 11–14) + `setActivePlanningContext` handler (PlanningPanelProvider.ts line 1509)
- Existing epic DB flag and `isEpic` field on plan objects
- Existing epic handlers in PlanningPanelProvider.ts (1857/1874/1908/1922)
- Existing agent-terminal prompt dispatch (for constitution builder invocation)
- `agentPromptBuilder.ts` `PromptBuilderOptions` interface + planner branch; `KanbanProvider._resolveGlobalDesignDoc`

## Out of Scope (Phase 2)

Tuning tab (adversarial review extraction and CONSTITUTION.md improvement from plan history) is planned separately. See `constitution-and-tuning-tabs.md`.

## Verification Plan

> Per session directives: **skip project compilation** (no `tsc`/build step) and **skip running automated tests** in this session — the test suite will be run separately by the user. The cases below define WHAT must be verified; the user executes them.

### Automated Tests

- Add/extend a `buildKanbanBatchPrompt` test asserting that `constitutionContent` is injected into the planner prompt under a `PROJECT CONSTITUTION:` header, and omitted when absent (mirror existing `designDocContent` coverage in `src/services/__tests__/agentPromptBuilder.test.ts`).
- Add a test asserting `KanbanProvider` calls `_resolveConstitution` and forwards `constitutionContent` into `PromptBuilderOptions` when dispatching planner prompts.
- Add a regression test asserting the migrated Kanban message handlers remain reachable from the project panel (handler-presence/wiring check, in the style of the existing transport/batching regression tests under `src/test/`).
- Add a test for constitution file handlers (`loadConstitutionFiles`/`readConstitutionFile`/`saveConstitutionFile`) including path-scoping (reject paths outside workspace/control plane).

### Manual / Behavioral Checklist (preserved from original)

- [ ] `project.html` opens via `switchboard.openProjectPanel` command
- [ ] Kanban tab renders and functions identically to the old planning.html Kanban tab
- [ ] Kanban plan import, edit, save all work
- [ ] Epics tab shows only plans flagged as epics
- [ ] Setting an epic as planning context passes it to planner prompts
- [ ] Active epic banner displays correctly
- [ ] Constitution tab discovers `CONSTITUTION.md` in single-workspace setup
- [ ] Constitution tab discovers `CONSTITUTION.md` in multi-workspace setup
- [ ] Constitution can be previewed, edited, and saved
- [ ] Constitution builder skill can be invoked from the tab
- [ ] Constitution content is injected into planner prompts
- [ ] `planning.html` no longer has a Kanban tab; all remaining tabs work correctly
- [ ] No broken message handlers after Kanban migration (verify against the Phase 2 handler list)
- [ ] Both panels can be open simultaneously without cross-panel `postMessage` leakage (shared-provider path)

---

## Recommendation

**Send to Lead Coder.** (Complexity 7 — multi-file coordination across two services, a provider-ownership decision affecting a 5,286-line class, and a net-new feature with an undefined invocation mechanism. Resolve the three User Review items before starting.)
