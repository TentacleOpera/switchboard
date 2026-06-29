# Bridge planning.html Docs → Project Context (Set as Requirements / Constitution)

## Goal

Add per-doc **"Set as Requirements (PRD)"** and **"Set as Constitution"** actions to the planning.html **Docs tab**, which snapshot the open doc's content into the Project Context system that project.html owns (`.switchboard/projects/<slug>/prd.md` and `CONSTITUTION.md`). This converges the legacy global Notion "design doc" into the modern PRD/constitution system by **reusing the doc browsing/fetching that already exists in the Docs tab** instead of building a new "import from Notion" feature in project.html.

### Core problem & background

There are two parallel requirements mechanisms (documented in the sibling tester-rework plan): the **legacy** global `planner.designDocLink` (optionally Notion-synced, fetched via `_resolveGlobalDesignDoc`, `KanbanProvider.ts:2808`) and the **modern** per-project PRD + workspace constitution authored in project.html. They have not been bridged: a user whose requirements live in Notion (or ClickUp/Linear/local) has no way to get that content into the modern PRD/constitution system except copy-paste.

The key realization: **the import capability already exists** — the planning.html Docs tab already browses every source (`local`, `clickup`, `linear`, `notion`, `antigravity` — `planning.js:36,1152`) and fetches doc content (`fetchDocsFile` → `_handleFetchDocsFile`, `PlanningPanelProvider.ts:2472,7227`). And the **write path already exists** — `saveProjectPrd` (`PlanningPanelProvider.ts:3616`, writes `getProjectPrdPath(wsRoot, projectName)`) and `saveConstitutionFile` (`:3533`). Both webviews are served by the **same provider** (`PlanningPanelProvider` loads `project.html` at `:377` and `planning.html` at `:1278`), so no cross-panel messaging is needed. There is even prior art for a per-doc action button in this exact spot: the removed "Set as Active Planning Context" button (`planning.js:6495`).

So the work is almost entirely **wiring existing pieces**: revive a per-doc action affordance → take the open doc's already-fetched content → call the existing save handler.

### Root cause

project.html's PRD/constitution editors and planning.html's multi-source doc browser were built as separate islands. Nothing connects "a doc I can see in the Docs tab" to "the requirements baseline the agents use."

## Metadata

- **Tags:** [frontend, backend, ui, feature]
- **Complexity:** 6

## User Review Required

- None. Two prior open questions are now decided by the user:
  1. **Legacy `planner.designDoc*` setting** → **hide the input** from the Setup UI; keep honoring the config for back-compat (`_resolveGlobalDesignDoc` + the tester/planner fallback stay). See "Legacy convergence" below.
  2. **Existing PRD/constitution collision on import** → **3-way decision modal** (Replace / Append / Keep existing), reusing the existing in-webview duplicate-doc modal pattern. See "Collision handling" below.

## Complexity Audit

### Routine
- Adding two action buttons to the Docs-tab doc preview/action bar (revive the removed affordance at `planning.js:6495`).
- Posting `saveConstitutionFile` / `saveProjectPrd` with the open doc's content — handlers already exist, unchanged.

### Complex / Risky
- **PRD target resolution:** PRD is keyed on project NAME; the Docs tab has no inherent "active project," so the action must resolve a target project (picker).
- **Collision on an existing single-slot doc** (one constitution per workspace, one PRD per project) — must be a 3-way decision modal, NOT a confirm gate (house rule) and NOT `confirm()`/`showWarningMessage` (silent no-op in webviews). See Collision handling.
- The save handlers currently **overwrite silently** (`saveProjectPrd:3616`, `saveConstitutionFile:3533` call `writeFile` with no existence check) — collision detection must be added.
- **Notion snapshot vs live sync** expectation-setting.

## Edge-Case & Dependency Audit

- **Race Conditions:** A doc being mid-import (`_pendingImportDocName`, `planning.js:4021,4101`) — gate the action until the doc's content is fetched/available; reuse the existing fetched preview content rather than firing a second fetch.
- **Security:** PRD path is slug-sanitized (`prdUtils.ts`); constitution path may be a user-configured custom path (`constitutionUtils.ts:6-9`) — write via the existing `saveConstitutionFile`/`saveProjectPrd` handlers only; do NOT construct paths in the webview.
- **Side Effects:** Writing a PRD makes it immediately live for dispatch (the tester/all roles read it via `_resolveProjectPrd` when Project Context is on). Surface a clear status so the user knows the agents' baseline just changed.
- **Dependencies & Conflicts:**
  - Overlaps with the sibling **acceptance-tester intent-conformance rework** (`feature_plan_20260628212519_*`): that plan makes the tester *consume* PRD/constitution; this plan makes it *easy to author* them. Independent, mutually reinforcing — no ordering dependency.
  - Constitution save in project.js (`:2472`) posts `{ type: 'saveConstitutionFile', workspaceRoot, content }`; mirror that exact shape from planning.js.
  - PRD save in project.js (`:1166`) posts `{ type: 'saveProjectPrd', projectName, content, workspaceRoot }`; mirror that exact shape.

## Dependencies

- None blocking. Sibling: `feature_plan_20260628212519_acceptance-tester-intent-conformance-rework` (complementary, not a prerequisite).

## Adversarial Synthesis

Key risks: (1) PRD requires a project target the Docs tab doesn't have — mitigated by a project picker using the already-in-hand `_kanbanAllWorkspaceProjects` data (planning.js:5326/6086), pre-selecting the active project; (2) destroying an authored requirements doc on import — mitigated by the 3-way Replace/Append/Keep modal plus a `.bak` archive on Replace (with chaining to `.bak.1`, `.bak.2` if `.bak` exists), never a silent overwrite and never a banned confirm gate; (3) the collision modal being implemented as `confirm()`/`showWarningMessage` and silently no-opping — mitigated by cloning the `showDuplicateModal` DOM/CSS pattern with NEW message types (`resolvePrdCollision`/`resolveConstitutionCollision`), not reusing the `resolveDuplicate` type; (4) users expecting a live Notion sync — mitigated by labelling the action "Import as…/Snapshot" and documenting re-import to refresh; (5) **Project Context toggle not enabled after import** — writing a PRD file does not enable `project_context_enabled`, so the agents' baseline doesn't actually change until the user turns on the toggle — mitigated by checking toggle state post-import and surfacing "PRD imported — enable Project Context in the Projects tab to activate it" when the toggle is off; (6) the Notion design-doc input in implementation.html is a JS-rendered element (line 3138 is inside a function that builds the agent identity card), not static HTML — the implementer must find and gate the rendering function, not just hide a static section.

## Proposed Changes

### `src/webview/planning.html` + `src/webview/planning.js` — Docs-tab actions

- **Context:** Revive a per-doc action affordance in the Docs-tab preview header (where "Set as Active Planning Context" lived, `planning.js:6495`).
- **Logic / Implementation:**
  - Add two buttons shown when a doc is open/previewed in the Docs tab: **"Set as Requirements (PRD)"** and **"Set as Constitution."** Source-agnostic — they operate on whatever doc is open (Notion, ClickUp, Linear, local), not Notion-only.
  - Reuse the already-fetched preview content for the active doc (do not refetch); gate the buttons until content is available.
  - **Set as Constitution:** resolve the target workspace from the Docs-tab workspace context and post `{ type: 'saveConstitutionFile', workspaceRoot, content }` (mirror `project.js:2472`).
  - **Set as Requirements:** open a lightweight project picker using the **already-in-hand** `_kanbanAllWorkspaceProjects` data in planning.js (populated at `:6086` from the `kanbanPlansReady` message's `allWorkspaceProjects` field — NO new provider round-trip needed). Pre-select the active project if known (from `kanbanFilters.project` or the kanban workspace filter), then post `{ type: 'saveProjectPrd', projectName, content, workspaceRoot }` (mirror `project.js:1166`).
  - On success, show status: "Imported as PRD for <project>" / "Imported as Constitution for <workspace>" (+ "overwrote previous" when applicable, derived from the handler's exists/ok response). **Critical (from adversarial review):** after a PRD import, check the Project Context toggle state (`project_context_enabled`). If the toggle is OFF, surface an additional status: "PRD imported — enable Project Context in the Projects tab to activate it for agent dispatch." The PRD file exists but is not injected into prompts until the toggle is on.
- **Edge cases:** disable buttons for the "All Workspaces" aggregate browse view (no single workspace target); for PRD, block when no project exists yet and prompt to create one in the Projects tab.

### `src/services/PlanningPanelProvider.ts` — handlers (mostly reuse)

- **Context:** `saveProjectPrd` (`:3616`) and `saveConstitutionFile` (`:3533`) already do the writes. No new write logic needed.
- **Logic:** If the open doc's content isn't already in hand webview-side, expose its content through the existing `_handleFetchDocsFile` path (`:7227`) so the action has the body to save. Return an `exists`-style flag so the webview can say "overwrote previous." Optionally add a thin convenience handler (e.g. `setDocAsPrd` / `setDocAsConstitution`) that fetches-then-saves server-side if doing it in two webview round-trips is awkward.

### Collision handling — existing PRD / constitution (DECIDED: 3-way modal)

- **Context:** A workspace has exactly one constitution and a project has exactly one PRD — importing onto an occupied slot is a real conflict, not a yes/no confirm. The save handlers today overwrite silently.
- **Pattern (REUSE, do not invent):** clone the existing in-webview collision modal `showDuplicateModal` (`planning.js:3495`) — a custom HTML modal that renders distinct action buttons. **Clone the DOM-creation pattern and CSS classes**, but use **NEW message types** (`resolvePrdCollision` / `resolveConstitutionCollision`) — do NOT reuse the `resolveDuplicate` message type, which is wired to the doc-import duplicate-resolution flow. **Do NOT use `confirm()` / `window.confirm()` / `showWarningMessage`** — they are silent no-ops in the VS Code webview sandbox (documented house bug) and would make the button do nothing. **Do NOT use a two-button "Are you sure?" gate** — that is the banned confirm pattern. The three-way decision is what makes this permissible.
- **Detection:** before showing the modal, the action must know whether a target doc already exists. Add an `exists` flag to the save round-trip, or query first (PRD: `getProjectPrd`; constitution: `readConstitutionFile`). Only show the modal when content already exists and is non-empty.
- **The three choices (single-slot variant — "Import as Copy" from the original modal does NOT apply, since you can't have two):**
  1. **Replace** — archive the existing file as `<name>.bak` (mirrors the migration rule's `*.migrated.bak` ethos), then write the imported content. **If `.bak` already exists** from a previous Replace, chain to `<name>.bak.1`, `.bak.2`, etc. (adversarial review finding — without chaining, a second import silently overwrites the first backup, losing the original).
  2. **Append** — append the imported content to the existing doc under a heading `## Imported from <source> (<date>)`, so nothing is lost and the user reconciles in the project.html editor.
  3. **Keep existing** — abort, write nothing (the "Skip" equivalent).
- **Implementation:** plumb the chosen action through to the save handlers (`saveProjectPrd:3616`, `saveConstitutionFile:3533`) via a `mode: 'replace' | 'append'` field; the handler archives `.bak` on replace and concatenates on append. Surface a clear post-action status ("Replaced PRD for X — previous backed up to prd.md.bak" / "Appended to constitution for X").

### Legacy convergence — hide the input (DECIDED)

- **Context:** Close the loop on the legacy Notion design doc.
- **Logic:** **Hide** the "NOTION DESIGN DOC" input section in `src/webview/implementation.html`. **Note (from adversarial review):** the label at line 3138 (`name.innerText = 'NOTION DESIGN DOC'`) is inside a JavaScript function that dynamically builds the agent identity card — it is NOT a static HTML section. The implementer must find the JS rendering function that creates this UI block and gate it (e.g. skip rendering when a deprecation flag is set, or replace the block with a one-line deprecation note). The backing config logic is in `TaskViewerProvider.ts:15426-15459` (`_isDesignDocEnabled`, `_getDesignDocLink`, `_getDesignDocContent`). Replace the input with a one-line deprecation note pointing to "Docs tab → Set as Requirements / Set as Constitution." **Keep the config honored** — do NOT delete `planner.designDoc*`, `_resolveGlobalDesignDoc`, or the tester/planner fallback (back-compat for ~4,000 installs; no-op migration posture). Existing Notion design-doc users migrate by re-importing through the new buttons. A stored `planner.designDocLink` that is still set continues to work even though its input is hidden.

## Verification Plan

### Automated Tests
- Webview-logic unit test: "Set as Requirements" posts `saveProjectPrd` with the selected project + open-doc content; "Set as Constitution" posts `saveConstitutionFile` with the workspace + content (mirror existing planning.js message-shape tests). Assert the project picker uses `_kanbanAllWorkspaceProjects` data already in planning.js (no new provider round-trip).
- **Collision tests:** importing onto an empty slot writes directly (no modal); importing onto an occupied slot shows the 3-way modal; **Replace** archives the prior file as `.bak` then writes (and chains to `.bak.1` if `.bak` exists); **Append** concatenates under the dated heading; **Keep existing** writes nothing. Assert the modal posts `resolvePrdCollision`/`resolveConstitutionCollision` (NOT `resolveDuplicate`). Assert no `confirm`/`window.confirm`/`showWarningMessage` is used (grep-style guard test, consistent with existing no-confirm regression coverage).
- Provider test: `saveProjectPrd` writes `getProjectPrdPath(wsRoot, projectName)` and `saveConstitutionFile` writes the resolved constitution path; `mode: 'replace'` produces a `.bak` (with chaining); `mode: 'append'` preserves prior content; round-trip read returns expected content.
- **Toggle-status test:** after a PRD import when `project_context_enabled` is OFF, the webview surfaces "enable Project Context in the Projects tab to activate it"; when ON, no such message appears.
- **Legacy-hide test:** the "NOTION DESIGN DOC" input is not rendered in implementation.html (the JS rendering function is gated), but a pre-existing `planner.designDocLink` config value is still honored by `_resolveGlobalDesignDoc` (back-compat assertion).
- Manual: browse a Notion doc in the Docs tab → "Set as Requirements" → pick project → confirm `.switchboard/projects/<slug>/prd.md` written and project.html PRD tab shows it; repeat onto the now-occupied slot and exercise Replace/Append/Keep; confirm a tester dispatch then uses the PRD as its acceptance baseline (with the sibling plan applied).
- **Compilation skipped per session directive** — `npm run compile` (type-check) will be run separately by the user. The test suite will also be run separately.

---
**Recommendation:** Complexity 5 → **Send to Coder.**
