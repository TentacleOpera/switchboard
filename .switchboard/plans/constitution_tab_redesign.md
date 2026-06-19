# Project Constitution Tab: UX Overhaul and Reliability Fixes

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, feature, bugfix, ui, ux

---

## Overview

The Constitution tab has eight distinct problems: a stale sidebar status, no enable/disable toggle, a single Build button that requires a live planner agent, a build prompt that produces the wrong document type, no Update or Delete buttons, no path customisation, and a broken onboarding empty state. This plan addresses all eight in a single coordinated change across four files.

---

## Issue 1 — Sidebar Status Does Not Refresh After Creation

**Root cause:** `saveConstitutionFile` writes the file and sends `fileSaved` back to the webview, but does not explicitly refresh the workspace list. The `FileSystemWatcher` picks it up with a 400 ms debounce, so the sidebar eventually updates — but the user has no signal that it will, and the lag is noticeable.

**Fix:** In `PlanningPanelProvider.ts`, after the successful `fs.writeFileSync` in `case 'saveConstitutionFile'`, immediately call the same `_handleMessage({ type: 'loadConstitutionFiles' })` path used by the watcher. This ensures the sidebar re-renders synchronously with the `fileSaved` confirmation instead of relying on the debounced watcher.

No change to `project.js` or the watcher is needed.

---

## Issue 2 — Enable/Disable Planning Reference Toggle

**Requirement:** Follow the epics pattern: a collapsible banner at the top of the tab showing current state, and a button in the controls strip to toggle. The current hint-text `<span>` is removed entirely.

### Backend — `PlanningPanelProvider.ts`

Add a new message handler `case 'toggleConstitutionAddon'`:
1. Read `store.get<any>('switchboard.prompts.roleConfig_planner', {})`.
2. Set `plannerConfig.addons.constitution = msg.enabled` (boolean from the webview).
3. Write back via `store.set(...)`.
4. Respond with `{ type: 'constitutionAddonState', enabled: msg.enabled }`.

Also extend the existing `case 'getConstitutionStatus'` response to include `enabled` alongside `status`, so the initial render on tab activation knows the current toggle state without an extra round-trip.

### Frontend — `project.html` and `project.js`

**HTML changes:**
- Remove the `<span>` hint text in the controls strip.
- Add an active-doc-banner (mirroring the epics banner):
  ```html
  <div class="active-doc-banner inactive" id="active-constitution-banner">
    <div class="active-doc-info">
      <span class="active-doc-label">Constitution Reference:</span>
      <span class="active-doc-name">Enabled</span>
    </div>
    <button class="btn-disable-doc" id="btn-disable-constitution">Turn off</button>
  </div>
  ```
- Add `<button id="btn-enable-constitution" class="strip-btn" disabled>Enable as Planning Reference</button>` in the controls strip, next to the existing Build button. Disabled by default; enabled when a workspace with a constitution is selected.

**JS changes:**
- On `constitutionStatus` and `constitutionAddonState` messages, set banner visibility and `btn-enable-constitution` state.
- `btn-enable-constitution` click → `postMessage({ type: 'toggleConstitutionAddon', enabled: true })`.
- `btn-disable-constitution` click → `postMessage({ type: 'toggleConstitutionAddon', enabled: false })`.
- On workspace select, re-evaluate whether `btn-enable-constitution` should be enabled (requires a constitution to exist AND addon currently off).

---

## Issue 3 — Build Button: Two Variants (Send to Planner / Copy Prompt)

**Requirement:** Replace the single "Build Constitution" button with two:
- **"Build via Planner"** — sends the skill invocation to the planner agent as today.
- **"Copy Build Prompt"** — copies a self-contained prompt to the clipboard, usable in any AI interface.

### Backend — `PlanningPanelProvider.ts`

Add `case 'copyConstitutionPrompt'`:
- Compose the full interview prompt string (see Issue 4 for its content).
- Use `vscode.env.clipboard.writeText(promptText)` to copy.
- Respond with `{ type: 'constitutionPromptCopied' }` so the frontend can briefly flash "Copied!" on the button.

The existing `case 'invokeConstitutionBuilder'` is kept as-is for the "Build via Planner" path.

### Frontend

Replace the single `btn-build-constitution` with two buttons:
```html
<button id="btn-build-via-planner" class="strip-btn">Build via Planner</button>
<button id="btn-copy-build-prompt" class="strip-btn">Copy Build Prompt</button>
```
Both disabled when no workspace is selected.

---

## Issue 4 — Build Prompt Produces the Wrong Document Type

**Requirement:** The current `constitution_builder.md` skill produces a technical standards document. Based on the research in `docs/project_constitution_research_for_ai_assisted_sdd_tooling.md`, a project constitution should be a lean, high-level intent document covering mission, users, guiding principles, technical constraints, and non-goals — not coding conventions or testing standards.

### Rewrite `.agent/skills/constitution_builder.md`

**New overview:** The constitution captures the soul of the project for AI alignment — why it exists, who it serves, what governs decisions — not how code is formatted.

**New interview sequence (from research):**
1. **Mission** — "What is the name of this project, and in one sentence, what is its primary reason for existing?"
2. **Target Users** — "Who are the primary users, and what is their main pain point?"
3. **Guiding Principles** — "What are the 3–5 non-negotiable values that should govern every technical and product decision? Give each a short name and one concrete sentence explaining what it means in practice."
4. **Technical Constraints** — "What are the hard technical boundaries? List required languages, core frameworks, data stores, and key third-party services."
5. **Non-Goals** — "What are specific things this project will NOT do in its current scope? (Prevents scope creep.)"

**New document sections (template to produce):**
```markdown
# [Project Name] Constitution

> **Mission:** [one sentence]

## Guiding Principles
- **[Name]:** [concrete explanation]

## Target Users
[Who they are and their main pain point]

## Technical Constraints & Stack
- Core Language & Frameworks: ...
- Data Layer: ...
- Key External Services: ...

## Non-Goals
- [Explicit exclusion 1]
- [Explicit exclusion 2]
```

**Keep it lean:** Instruct the agent to aim for under 150 lines. Coding conventions and linting standards belong in `CLAUDE.md` or `.cursor/rules/`, not the constitution.

**The standalone prompt** (used by "Copy Build Prompt" in Issue 3) is a self-contained version of this skill with the interview questions inlined, usable in any AI chat interface without access to the skills file.

---

## Issue 5 — No "Update Constitution" Button

**Requirement:** When a constitution already exists, show an "Update via Planner" button (and "Copy Update Prompt") alongside the build buttons.

**Logic:** The controls strip shows Build or Update depending on whether `_constitutionSelectedFile` is set (i.e., a constitution exists for the selected workspace).

### Implementation

- In the controls strip, add `btn-update-via-planner` and `btn-copy-update-prompt` buttons (hidden by default).
- In `renderConstitutionWorkspaceList()` and on `constitutionFileRead`, toggle visibility:
  - File exists: hide Build buttons, show Update buttons.
  - No file: show Build buttons, hide Update buttons.
- `case 'invokeConstitutionUpdater'` in `PlanningPanelProvider.ts`: sends `Follow instructions in .agent/skills/constitution_builder.md to improve and update the existing CONSTITUTION.md in this project.` to the terminal (same mechanism as Build).
- `case 'copyConstitutionUpdatePrompt'`: copies a standalone update prompt with the instruction to review the existing document and improve/extend it based on the same interview framework.

---

## Issue 6 — No Delete Button

**Requirement:** A "Delete Constitution" button visible only when a constitution exists for the selected workspace.

### Backend — `PlanningPanelProvider.ts`

Add `case 'deleteConstitutionFile'`:
1. Resolve the constitution path for `msg.workspaceRoot` (default or custom, see Issue 7).
2. Show a confirmation: `vscode.window.showWarningMessage('Delete CONSTITUTION.md for [workspace]?', { modal: true }, 'Delete')`.
3. On confirm: `fs.unlinkSync(filePath)`.
4. Respond with `{ type: 'constitutionFileDeleted', workspaceRoot: msg.workspaceRoot }`.
5. Also call the workspace list refresh so the sidebar status updates.

### Frontend

- Add `<button id="btn-delete-constitution" class="strip-btn" style="color: var(--accent-red);">Delete</button>` in the controls strip, hidden by default.
- Show/hide alongside the Update buttons (visible only when a constitution exists).
- On `constitutionFileDeleted`: reset the preview pane to the onboarding empty state, disable Edit/Update/Delete buttons, re-enable Build buttons.

---

## Issue 7 — No Custom Path Setting

**Requirement:** The user should be able to change the constitution file path per workspace. The default remains `CONSTITUTION.md` at the workspace root.

### Storage

Store custom paths in the Switchboard store under the key `switchboard.constitutionPaths` as an object mapping workspace root string to relative path string. Example:
```json
{ "/Users/foo/myproject": "docs/CONSTITUTION.md" }
```

### Path Resolution Helper

Extract a `_getConstitutionPath(workspaceRoot: string): string` private method in `PlanningPanelProvider.ts`. It reads from the store, falls back to `path.join(workspaceRoot, 'CONSTITUTION.md')`. Use this helper everywhere a constitution path is currently hard-coded (`loadConstitutionFiles`, `readConstitutionFile`, `saveConstitutionFile`, `deleteConstitutionFile`, `_setupConstitutionWatcher`).

### Backend Message Handler

Add `case 'setConstitutionPath'`:
1. Validate that `msg.relativePath` is a relative `.md` file path.
2. Store in `switchboard.constitutionPaths[msg.workspaceRoot] = msg.relativePath`.
3. Update the file watcher for that workspace root to the new path.
4. Re-read the file from the new path and send `constitutionFileRead`.
5. Refresh workspace list to update `hasConstitution` for the new path.

### UI

Add a small `<button id="btn-set-constitution-path" class="strip-btn" title="Change constitution file path">⚙</button>` button in the controls strip (visible when a workspace is selected).

On click: `postMessage({ type: 'openSetConstitutionPath', workspaceRoot: ... })`.

Backend handles `case 'openSetConstitutionPath'` by calling `vscode.window.showInputBox({ prompt: 'Enter relative path for constitution file', value: currentRelativePath, placeHolder: 'CONSTITUTION.md' })` and, on a non-empty result, dispatching `setConstitutionPath` internally.

---

## Issue 8 — Onboarding Empty State is Broken and Uninformative

**Root cause:** The "no constitution found" state in `project.js` (line 283–288) renders two `<p>` elements inside a `display: flex` container without `flex-direction: column`. Flex row layout places them side by side, splitting the text left/right down the middle.

**Fix:**

Do not use the `.empty-state` class for the "no constitution" state. Replace the innerHTML assignment with a distinct styled block:

```html
<div class="constitution-onboarding">
    <p class="constitution-onboarding-title">No constitution found for this workspace.</p>
    <p>A project constitution is a concise document that defines the soul of your project: its goals, the people it serves, its key features, guiding principles, and how the team communicates. It is not a technical spec — it is the context that tells an AI planning assistant <em>why</em> the project exists and <em>who</em> it is for.</p>
    <p>Once created, you can enable it as a Planning Reference so it is automatically included in every planning prompt alongside your task descriptions.</p>
    <p>Use <strong>Build via Planner</strong> above to generate one for this workspace.</p>
</div>
```

Add `.constitution-onboarding` CSS: left-aligned, top-padding (~24px), `max-width: 600px`, normal `opacity`, inheriting `font-size`. The `.constitution-onboarding-title` uses a slightly larger weight and a small bottom margin.

The initial state (no workspace selected yet) keeps the existing single-line `<div class="empty-state">Select a workspace to view its Constitution</div>` — no change needed there, that single-node centered state is fine.

---

## File Change Summary

| File | Changes |
|---|---|
| `src/webview/project.html` | Issue 2 banner, Issues 3/5/6/7 buttons, Issue 8 CSS for `.constitution-onboarding` |
| `src/webview/project.js` | Issue 1 implicit (no JS change needed), Issue 2 toggle handlers, Issues 3/5/6/7/8 button wiring and message handlers |
| `src/services/PlanningPanelProvider.ts` | Issue 1 sync refresh after save, Issue 2 `toggleConstitutionAddon`, Issue 3 `copyConstitutionPrompt`, Issue 5 `invokeConstitutionUpdater`+`copyConstitutionUpdatePrompt`, Issue 6 `deleteConstitutionFile`, Issue 7 `_getConstitutionPath` helper + `setConstitutionPath` + `openSetConstitutionPath` |
| `.agent/skills/constitution_builder.md` | Issue 4 full rewrite |

---

## Implementation Order

1. Issue 8 — onboarding CSS and copy (isolated, zero risk)
2. Issue 1 — sync refresh after save (one-line backend addition)
3. Issue 6 — delete button (self-contained, tests the backend pattern)
4. Issue 7 — `_getConstitutionPath` helper (refactor first, then add `setConstitutionPath` UI)
5. Issue 4 — rewrite `constitution_builder.md`
6. Issues 3 & 5 — Build/Update/Copy buttons (share the same prompt content from Issue 4)
7. Issue 2 — enable/disable toggle (last, because it depends on stable workspace selection logic from 3 & 5)
