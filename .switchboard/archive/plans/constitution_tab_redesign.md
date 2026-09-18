# Project Constitution Tab: UX Overhaul and Reliability Fixes

## Goal

Overhaul the Project panel's Constitution tab so it is reliable and complete: refresh the sidebar status synchronously after creation, add an enable/disable Planning-Reference toggle, split the single Build button into "Build via Planner" and "Copy Build Prompt", rewrite the builder skill to produce an intent-level constitution (not a coding-standards doc), add Update/Delete buttons, support a per-workspace custom file path, and fix the broken onboarding empty state — across four files (`src/webview/project.html`, `src/webview/project.js`, `src/services/PlanningPanelProvider.ts`, `.agent/skills/constitution_builder.md`) plus the one consumption site in `src/services/KanbanProvider.ts`.

**Core problem:** The Constitution tab shipped as a minimal viewer with a single planner-only Build action, a hard-coded path, a stale-on-create sidebar, and an empty state that renders garbled. It also produces the wrong *kind* of document. This plan addresses all eight problems in one coordinated change while preserving the existing multi-root (`allRoots` / `buildWorkspaceItems`) architecture.

---

## Metadata
**Tags:** frontend, backend, ui, ux, feature, bugfix, reliability
**Complexity:** 7

---

## User Review Required

- **None.** All eight issues have a decided implementation below. The one design ambiguity (global vs. per-workspace toggle, Issue 2) is resolved in this plan: the addon flag stays global and the UI copy is corrected to reflect that — no product decision is outstanding.

---

## Complexity Audit

### Routine
- Issue 8 — onboarding empty-state CSS/copy (isolated, new `.constitution-onboarding` class).
- Issue 1 — synchronous workspace-list refresh after save (one added internal `_handleMessage` call).
- Issue 3 / Issue 5 button HTML and click wiring (mirrors existing strip-btn patterns).
- Skill rewrite (Issue 4) — documentation-only file, no code paths.

### Complex / Risky
- **Issue 7 path propagation across providers.** A custom path must reach *every* read site, including `getConstitutionStatus` (PlanningPanelProvider line ~2589) and `KanbanProvider._resolveConstitution` (line ~2550). A `_getConstitutionPath` helper private to `PlanningPanelProvider` does not cover the KanbanProvider consumption path; without that, a custom-path constitution displays but is never injected into planning prompts.
- **Issue 7 watcher reconfiguration.** `_setupConstitutionWatcher` hard-codes `RelativePattern(root, 'CONSTITUTION.md')` and dedupes by root; supporting per-root custom paths requires rebuilding watchers from the resolved path on `setConstitutionPath`.
- **Issue 2 global state write.** Writes to the shared global `switchboard.prompts.roleConfig_planner` key via async `globalState.update` (not `.set`), with `addons` initialization — same key consumed by KanbanProvider planning prompts.
- **Issue 6 delete semantics.** Must delete immediately with no confirmation dialog (hard project rule); resolve the path via the same helper so custom-path files are deletable.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- `globalState.update` and `vscode.env.clipboard.writeText` are async — `await` them before posting `constitutionAddonState` / `constitutionPromptCopied`, or the UI flips state before the write succeeds.
- Issue 1's synchronous refresh and the 400 ms debounced watcher refresh can both fire for one save; both call `loadConstitutionFiles` and are idempotent, so the redundant post is harmless (note it, don't add suppression).
- `setConstitutionPath` rebuilds watchers while the old watcher's debounce timer may be pending; the existing `_constitutionWatchDebounce` clear handles this, but verify disposal order.

**Security**
- `setConstitutionPath` must validate `msg.relativePath` is a *relative* `.md` path with no `..` traversal escaping the workspace root before storing or resolving — otherwise the helper can read/write/delete arbitrary files.
- All handlers already gate on `allRoots.includes(wsRoot)`; preserve that guard in every new handler (`deleteConstitutionFile`, `setConstitutionPath`, updater handlers).

**Side Effects**
- Changing the custom path **orphans** the old `CONSTITUTION.md` at the root. Leave it on disk — do not auto-delete (data loss + a silent delete the user never asked for).
- `invokeConstitutionUpdater` inherits the existing `invokeConstitutionBuilder` behavior of reusing any terminal whose name contains `planner`/`lead`; this can target an unrelated busy terminal. Pre-existing behavior — keep parity, do not expand scope here.
- Enabling the global addon affects planning for **all** workspaces, not just the selected one (see Issue 2 correction).

**Dependencies & Conflicts**
- The addon flag key `switchboard.prompts.roleConfig_planner` is shared with `KanbanProvider` (line ~2763) and `getConstitutionStatus`. The toggle, status, and prompt injection must agree on resolution: `plannerConfig?.addons?.constitution ?? config('planner.constitutionEnabled', false)`.
- New store key `switchboard.constitutionPaths` is net-new (never shipped) → no migration required. Preserve unknown keys in `roleConfig_planner` when writing `addons.constitution` (read-modify-write the whole object).

---

## Dependencies

- None (self-contained within this plan; no upstream session work required).

---

## Adversarial Synthesis

**Risk Summary:** Three findings would crash or silently no-op in production: (1) Issue 6's `showWarningMessage({modal:true})` confirm violates the repo's hard no-confirm-dialog rule and is a webview no-op — delete must be immediate; (2) Issue 7's custom path never reaches `getConstitutionStatus` and `KanbanProvider._resolveConstitution`, so a custom-path constitution shows "File not found" and is never injected into prompts; (3) Issue 2 calls a non-existent `store.set()` (the API is async `globalState.update`) and writes to `addons` without initializing it. Mitigations: remove the confirm and unlink immediately; route every read site through one shared path resolver (reachable from KanbanProvider); use `await store.update(...)` with `plannerConfig.addons = plannerConfig.addons || {}`. Secondary risks (global-vs-per-workspace toggle copy, watcher rebuild, async clipboard) are resolved in the issue corrections below.

---

## Proposed Changes

> The eight issue sections below are the proposed changes, organized by problem (each crosses files); the File Change Summary table and Implementation Order map them to targets. **Corrections & Clarifications** subsections (labeled) refine the original issues per the adversarial review without removing original intent.

## Overview

The Constitution tab has eight distinct problems: a stale sidebar status, no enable/disable toggle, a single Build button that requires a live planner agent, a build prompt that produces the wrong document type, no Update or Delete buttons, no path customisation, and a broken onboarding empty state. This plan addresses all eight in a single coordinated change across four files.

---

## Issue 1 — Sidebar Status Does Not Refresh After Creation

**Root cause:** `saveConstitutionFile` writes the file and sends `fileSaved` back to the webview, but does not explicitly refresh the workspace list. The `FileSystemWatcher` picks it up with a 400 ms debounce, so the sidebar eventually updates — but the user has no signal that it will, and the lag is noticeable.

**Fix:** In `PlanningPanelProvider.ts`, after the successful `fs.writeFileSync` in `case 'saveConstitutionFile'`, immediately call the same `_handleMessage({ type: 'loadConstitutionFiles' })` path used by the watcher. This ensures the sidebar re-renders synchronously with the `fileSaved` confirmation instead of relying on the debounced watcher.

No change to `project.js` or the watcher is needed.

**Clarification (signature):** The watcher invokes `this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true)` — the second positional `true` flag marks the call internal. Mirror that exact call (including the `true`) from the save handler so the message is treated as internal, and `await` it. The redundant debounced watcher refresh that may also fire is idempotent and harmless.

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

### Correction (CRITICAL — API + scope)

1. **`store` is `this._context.globalState`; its write API is async `.update()`, not `.set()`.** The handler body must be:
   ```ts
   const store = this._context.globalState;
   const plannerConfig = store.get<any>('switchboard.prompts.roleConfig_planner', {}) || {};
   plannerConfig.addons = plannerConfig.addons || {};   // addons may be undefined → guard
   plannerConfig.addons.constitution = !!msg.enabled;
   await store.update('switchboard.prompts.roleConfig_planner', plannerConfig);
   this._projectPanel?.webview.postMessage({ type: 'constitutionAddonState', enabled: !!msg.enabled });
   ```
   Read-modify-write the whole `plannerConfig` object so unknown/legacy keys are preserved. Calling `store.set(...)` as originally written throws `TypeError: store.set is not a function`.

2. **The addon flag is GLOBAL, not per-workspace.** `roleConfig_planner.addons.constitution` is consumed for every workspace by `KanbanProvider` (line ~2763) and `getConstitutionStatus`. Enabling it while viewing workspace A turns the reference on for **all** workspaces; a workspace lacking a constitution then yields `status: 'File not found'`. Therefore:
   - Banner/button copy must read as a global switch (the banner label "Constitution Reference: Enabled" is acceptable; do **not** add per-workspace wording implying it only affects the selected repo).
   - Derive enable/disable button state from the **global** addon flag (`constitutionAddonState` / the `enabled` field now added to `constitutionStatus`); derive file-existence from the **per-workspace** `getConstitutionStatus` `status` value. Reuse the existing three-state result (`<filename>` / `File not found` / `Disabled`) — do not invent a parallel per-workspace addon state.

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

### Clarification (async)

`vscode.env.clipboard.writeText(...)` is async — `await` it before posting `constitutionPromptCopied`, so the "Copied!" flash only appears after the clipboard write actually succeeds. The existing `btn-build-constitution` references in `project.js` (the `btnBuildConstitution` const and its click handler, ~lines 142, 996–1004) must be retargeted to the two new ids.

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

### Clarification (existing invocation text)

`invokeConstitutionBuilder` currently sends `Follow instructions in .agent/skills/constitution_builder.md to build or improve CONSTITUTION.md in this project.` (line ~2681). Keep this terminal-invocation text; the rewrite changes only the skill file's *content*, which the planner reads when it follows that instruction. The "Copy Build Prompt" standalone string is a separate, self-contained inlining of the new interview — it does not reference the skill file.

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

### Clarification (visibility source of truth)

Drive Build-vs-Update visibility off the `constitutionFileRead` `exists` flag (and `_constitutionSelectedFile`), which is already maintained at project.js lines ~277–291. When `exists === false`, also reset Update/Delete to hidden and Build to shown — keep this in one place so Issues 5/6 stay consistent. The updater invocation reuses the same terminal-selection behavior as `invokeConstitutionBuilder` (inherited; see Side Effects).

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

### Correction (CRITICAL — NO confirmation dialog)

**Step 2 above is forbidden and must be removed.** The repo has a hard, repeatedly-stated rule (CLAUDE.md, memory): delete buttons delete immediately — no `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click pattern. Additionally, modal dialogs in this flow are unreliable (the webview-confirm class of silent no-op the user has been burned by). The delete button is deliberately styled distinctly (red) and is hard to misclick.

Corrected handler:
```ts
case 'deleteConstitutionFile': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const filePath = this._getConstitutionPath(wsRoot);   // custom-path aware (Issue 7)
    try {
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
        this._projectPanel?.webview.postMessage({ type: 'constitutionFileDeleted', workspaceRoot: wsRoot });
        await this._handleMessage({ type: 'loadConstitutionFiles', requestId: Date.now() }, true);
    } catch (err) {
        this._projectPanel?.webview.postMessage({ type: 'constitutionFileDeleted', workspaceRoot: wsRoot, success: false, error: String(err) });
    }
    break;
}
```
No multi-choice prompt is involved here, so no dialog of any kind is permitted. (Multi-choice resolution dialogs are allowed elsewhere; a plain delete confirm is not.)

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

### Correction (CRITICAL — propagate the path to ALL read sites)

The helper list above omits two read sites that will silently break the feature:

1. **`getConstitutionStatus` (PlanningPanelProvider line ~2589)** hard-codes `path.join(wr, 'CONSTITUTION.md')`. After a custom path is set, the sidebar/meta-bar status reports `File not found`. Route it through `_getConstitutionPath(wr)`.

2. **`KanbanProvider._resolveConstitution` (KanbanProvider line ~2550)** hard-codes `path.join(workspaceRoot, 'CONSTITUTION.md')`. This is the function that injects the constitution into the planning prompt. Without the custom path here, enabling a custom-path constitution as a Planning Reference injects **nothing** — defeating the entire feature.

Because `_getConstitutionPath` is private to `PlanningPanelProvider`, the resolution logic (read `switchboard.constitutionPaths[workspaceRoot]` from `globalState`, fall back to `<root>/CONSTITUTION.md`) must be reachable from `KanbanProvider`. Implement once and share — e.g. a small exported util `getConstitutionPath(context, workspaceRoot)` in a shared module that both providers call, with the private method delegating to it. **(`src/services/KanbanProvider.ts` is therefore a fifth touched file — add it to the change summary.)**

**Watcher reconfiguration detail:** `_setupConstitutionWatcher` currently builds `new vscode.RelativePattern(vscode.Uri.file(root), 'CONSTITUTION.md')` and dedupes purely by root via the `watchedPaths` Set. To watch custom paths, derive the relative pattern from `_getConstitutionPath(root)` (relative-ize against root) per workspace, and have `setConstitutionPath` call `_setupConstitutionWatcher()` to rebuild after storing. Keep the existing dispose-then-recreate flow and the `_constitutionWatchDebounce` clear.

**Validation:** reject `relativePath` containing `..` segments or resolving outside the workspace root, and require a `.md` extension, before storing.

**No migration:** `switchboard.constitutionPaths` is net-new and has never shipped — no migration needed. Setting a custom path leaves any pre-existing root `CONSTITUTION.md` on disk; do not delete it.

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

### Clarification (exact offending selector)

The base `.empty-state` rule (project.html line ~229) is `text-align: center` block — not the culprit. The garbling comes from the **scoped** rule `#kanban-preview-content .empty-state, #epics-preview-content .empty-state, #constitution-preview-content .empty-state { display: flex; align-items: center; justify-content: center; ... }` at **project.html lines ~973–983**, which has no `flex-direction: column`, so the two `<p>` children lay out as flex items in a row. The proposed fix (a separate `.constitution-onboarding` class outside that selector) correctly sidesteps it; do not add `flex-direction: column` to the shared scoped rule (it would alter kanban/epics empty states too). Also update the build-button reference in the onboarding copy to "Build via Planner" per Issue 3.

---

## File Change Summary

| File | Changes |
|---|---|
| `src/webview/project.html` | Issue 2 banner, Issues 3/5/6/7 buttons, Issue 8 CSS for `.constitution-onboarding` |
| `src/webview/project.js` | Issue 1 implicit (no JS change needed), Issue 2 toggle handlers, Issues 3/5/6/7/8 button wiring and message handlers |
| `src/services/PlanningPanelProvider.ts` | Issue 1 sync refresh after save, Issue 2 `toggleConstitutionAddon` (async `globalState.update`), Issue 3 `copyConstitutionPrompt`, Issue 5 `invokeConstitutionUpdater`+`copyConstitutionUpdatePrompt`, Issue 6 `deleteConstitutionFile` (NO confirm), Issue 7 `_getConstitutionPath` helper + `setConstitutionPath` + `openSetConstitutionPath` + route `getConstitutionStatus` through helper |
| `src/services/KanbanProvider.ts` | **(added)** Issue 7 — route `_resolveConstitution` (line ~2550) through the shared custom-path resolver so custom-path constitutions are injected into planning prompts |
| `.agent/skills/constitution_builder.md` | Issue 4 full rewrite |

---

## Implementation Order

1. Issue 8 — onboarding CSS and copy (isolated, zero risk)
2. Issue 1 — sync refresh after save (one-line backend addition)
3. Issue 7 — shared `getConstitutionPath` resolver FIRST (refactor all read sites incl. `getConstitutionStatus` and `KanbanProvider._resolveConstitution`, plus watcher), then add `setConstitutionPath`/`openSetConstitutionPath` UI. *(Moved earlier than the original order because Issues 6 and the status logic depend on the shared resolver.)*
4. Issue 6 — delete button (immediate unlink, no confirm; uses the resolver from step 3)
5. Issue 4 — rewrite `constitution_builder.md`
6. Issues 3 & 5 — Build/Update/Copy buttons (share the same prompt content from Issue 4)
7. Issue 2 — enable/disable toggle (last, because it depends on stable workspace selection logic from 3 & 5)

---

## Verification Plan

> Per session directives, automated tests and compilation are run **separately by the user** and are not executed as part of this plan. The items below define what to verify.

### Automated Tests
- Unit-test the shared `getConstitutionPath(context, workspaceRoot)` resolver: returns custom path when `switchboard.constitutionPaths[root]` is set, falls back to `<root>/CONSTITUTION.md` otherwise, and rejects `..`/non-`.md` inputs in `setConstitutionPath` validation.
- Verify `toggleConstitutionAddon` read-modify-writes `roleConfig_planner` without dropping unknown keys and initializes `addons`.
- Verify `getConstitutionStatus` returns `<filename>` / `File not found` / `Disabled` correctly for default and custom paths.

### Manual QA Checklist
1. **Issue 1:** Save a constitution in-panel → sidebar status flips to "✓ Has Constitution" immediately (no ~400 ms lag).
2. **Issue 2:** Toggle enable/disable → banner appears/disappears; reopen panel → state persists; confirm planning prompt reflects the global flag across two workspaces.
3. **Issue 3:** "Copy Build Prompt" → clipboard contains the self-contained prompt; "Copied!" flashes only after copy. "Build via Planner" sends to terminal.
4. **Issue 4:** Run the builder → output is an intent-level constitution (mission/users/principles/constraints/non-goals), under ~150 lines, no coding-standards sections.
5. **Issue 5:** With a constitution present, Build buttons hide and Update buttons show; Update via Planner sends the update instruction.
6. **Issue 6:** Click Delete → file is removed **immediately with no dialog**; preview resets to onboarding state; sidebar updates.
7. **Issue 7:** Set a custom path (e.g. `docs/CONSTITUTION.md`) → status shows the file (not "File not found"), watcher tracks the new path, AND enabling the reference injects the custom-path content into the planning prompt (verify via KanbanProvider path). Old root `CONSTITUTION.md` remains on disk.
8. **Issue 8:** Select a workspace with no constitution → onboarding text renders as a single left-aligned block (not split left/right).

---

## Recommendation

**Complexity: 7 → Send to Lead Coder.** Multi-file coordination across two providers, a path-resolution refactor touching 6+ call sites, a shared global-state write, file-watcher reconfiguration, and a cross-provider consistency requirement (custom path must reach the prompt-injection layer) put this above routine. The three blocking corrections (no-confirm delete, custom-path propagation, `globalState.update` API) must land or the feature ships broken.

---

## Reviewer Pass — 2026-06-19

Implementation reviewed against this plan as source of truth. The three plan-flagged blocking corrections (no-confirm delete, custom-path propagation to all read sites incl. `KanbanProvider._resolveConstitution`, `globalState.update` API) all landed correctly. The skill rewrite (Issue 4) is present on disk at `.agent/skills/constitution_builder.md` and matches the intent-level template exactly — note `.agent/` is gitignored, so it correctly does **not** appear in the implementation commit's file list.

Two NEW bugs were found that would have shipped Issue 2 (the enable/disable Planning-Reference toggle) completely inert. Both fixed in this pass.

### Stage 1 — Grumpy Principal Engineer

> *Pulls the chair out, sits down backwards, sighs theatrically.*
>
> **[CRITICAL] The headline feature is a brick. `project.js:283` — the dead `hasFile` oracle.** You built an entire enable/disable toggle, a banner, a global-state write, a read-modify-write to preserve legacy keys — *beautiful* — and then you wired the Enable button's `disabled` state to a status string that can NEVER say "yes" at the one moment that matters. When the addon is globally OFF, the backend dutifully reports `status: 'Disabled'`. Your frontend reads `'Disabled'` and concludes `hasFile = false`. So the button is disabled *precisely* when a constitution exists and the user wants to turn it on. It is a light switch that only works when the light is already on. The three-state status (`<filename>` / `File not found` / `Disabled`) conflates "no file" with "off" — the plan even warned you to "derive file-existence from the per-workspace status," but that status is structurally incapable of carrying file-existence once disabled. Catch-22, shipped.
>
> **[MAJOR] And even if `hasFile` were right, the message never arrives. `PlanningPanelProvider.ts:2608` vs `project.js:281` — the phantom `workspaceRoot`.** The status handler guards on `_constitutionSelectedWorkspace.workspaceRoot === msg.workspaceRoot`. Noble. Except `getConstitutionStatus` posts back `{ status, planFile, enabled }` — and **no `workspaceRoot`**. So `msg.workspaceRoot` is `undefined`, the guard is `something === undefined`, eternally false, and the *entire* `constitutionStatus` handler body is dead code. The banner never updates on selection. The button never re-enables. You wrote thirty lines of toggle logic that the runtime steps over like a crack in the pavement. Two independent bugs, either one fatal, stacked on the same feature. *Belt and suspenders, except both are made of tissue.*
>
> **[NIT] `openSetConstitutionPath` fires on empty input.** `result !== undefined` lets an empty/whitespace string through to `setConstitutionPath`, which then pops an error toast for `''`. The plan said "on a non-empty result." Graceful-ish, but a user who hits Enter on a blank box gets scolded instead of a no-op.
>
> **[NIT] `_setupConstitutionWatcher()` rebuild leaves a pending debounce timer un-cleared.** Harmless — the stale timer just fires one idempotent `loadConstitutionFiles`. The plan called this out and accepted it. Fine. I'm only mentioning it so you know I saw it.
>
> **[NIT — out of scope] This commit smuggled in `planning.html`, `planning.js`, `KanbanDatabase.ts`, and an `importedAt` epics tweak** that have nothing to do with the Constitution tab. Auto-commit bundling. Not this plan's defect, but somebody should know those rode along.

### Stage 2 — Balanced Synthesis

**Keep (correctly implemented):**
- Issue 1 sync refresh after save (`PlanningPanelProvider.ts:2672`), mirrors the watcher's internal `_handleMessage(..., true)` call exactly.
- Issue 6 delete — immediate `fs.unlinkSync`, **no confirmation dialog** of any kind. Compliant with the hard project rule.
- Issue 7 — shared `constitutionUtils.getConstitutionPath`, routed through `_getConstitutionPath`, `KanbanProvider._resolveConstitution`, `getConstitutionStatus`, watcher, and all CRUD read sites. Validation rejects `..`, absolute, and non-`.md`. KanbanProvider injection path covered.
- Issue 2 backend — `await store.update(...)` with `addons` guard and whole-object read-modify-write (preserves legacy keys).
- Issue 3/5 async clipboard `await`ed before `constitutionPromptCopied`. Issue 4 skill rewrite. Issue 8 onboarding block + CSS (sidesteps the shared flex selector, as specified).

**Fix now (done in this pass):**
1. **CRITICAL** — `project.js:283`: derive `hasFile` from `_constitutionSelectedFile !== null` (the per-workspace read result), not from the conflated `status` string.
2. **MAJOR** — `PlanningPanelProvider.ts:2608`: add `workspaceRoot: wr` to the `constitutionStatus` response so the frontend guard passes.

**Defer / no action:**
- The two NITs (empty-path toast, un-cleared debounce on watcher rebuild) — cosmetic, plan-acknowledged or graceful. Not worth a change.
- Out-of-scope bundled files — flag to the committer; outside this plan.

### Fixes Applied
| Severity | File:line | Fix |
|---|---|---|
| CRITICAL | `src/webview/project.js:283` | `hasFile` now derives from `_constitutionSelectedFile !== null` instead of the `status` string, so the Enable button is clickable when a file exists and the addon is off. |
| MAJOR | `src/services/PlanningPanelProvider.ts:2608` | Added `workspaceRoot: wr` to the `constitutionStatus` postMessage so the frontend per-workspace guard matches and the handler body executes. |

### Validation
- Per session directives, **compilation and tests were NOT run** (user runs them separately).
- **ACTION REQUIRED for the user:** `project.js` was edited, so `npm run compile` must be run to rebuild `dist/webview/` before the change is live in the extension.
- Static verification: confirmed `constitutionStatus` has exactly one sender (`PlanningPanelProvider.ts:2608`) and one consumer (`project.js:280`) — adding `workspaceRoot` is purely additive and breaks nothing. Confirmed `constitutionFileRead` (which sets `_constitutionSelectedFile`) runs synchronously before the async `getConstitutionStatus` response returns, so `_constitutionSelectedFile` is current when `hasFile` is computed.

### Remaining Risks
- **Toggle behavior deviation (accepted):** the implementation makes `btn-enable-constitution` a two-way toggle (text swaps to "Disable Reference") rather than the plan's enable-only-when-off button. With both fixes this is functionally correct and arguably better; redundant with the banner's "Turn off" but harmless.
- **Manual QA still required** for Issue 2 end-to-end (select a workspace with a constitution, addon off → Enable button is clickable → click → banner appears, persists across reopen) and Issue 7 prompt-injection via KanbanProvider — neither can be confirmed by static review.
