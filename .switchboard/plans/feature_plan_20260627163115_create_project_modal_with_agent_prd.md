# Replace Create Project VS Code Popup with In-Webview Modal + Agent PRD Generation

## Goal

### Problem Statement
The "Create Project" button (`#btn-add-project`) in `kanban.html` currently posts an `addProject` message to `KanbanProvider.ts`, which handles it by calling `vscode.window.showInputBox()` — a native VS Code popup that only accepts a plain project name. This is inconsistent with the premium in-webview modal UX used elsewhere in the kanban board (e.g. Testing Fail Modal, Routing Map Modal, Integration Settings Modal, Custom Agent Modal). More critically, there is no option during project creation to have an agent auto-generate a PRD that would appear in the `project.html` Projects tab's PRD editor.

### Root Cause
1. **`KanbanProvider.ts` line 5316–5335**: The `addProject` case uses `vscode.window.showInputBox()` (line 5319) — a minimal VS Code native input — instead of rendering an in-webview modal with richer fields.
2. **No PRD generation flow exists**: The per-project PRD system (stored at `.switchboard/projects/<slug>/prd.md`, managed via `prdUtils.ts`) only supports manual editing in `project.html`'s textarea. There is no "Generate PRD" trigger that produces a prompt the user can paste into an agent.

### What Success Looks Like
- Clicking the `+` button next to the project dropdown opens a styled in-webview modal (matching existing modal patterns in `kanban.html`).
- The modal contains: project name input, optional project description textarea, and a "Copy PRD Prompt" button.
- On submit, the project is created in the database.
- The "Copy PRD Prompt" button copies a ready-to-paste PRD-generation prompt to the clipboard (matching the established kanban copy-prompt pattern used 20+ times in `KanbanProvider.ts`). The user pastes it into their agent of choice (Claude, Cursor, etc.); the agent writes the PRD to `.switchboard/projects/<slug>/prd.md`, which the Projects tab picks up on demand via the existing `getProjectPrd` handler.
- Duplicate project names are detected and reported to the user via a status message (the DB silently returns `false` on duplicates today — this plan fixes that gap).

## Metadata
- **Tags:** `frontend`, `ui`, `ux`, `feature`
- **Complexity:** 4/10

## User Review Required
- [ ] Confirm the "Copy PRD Prompt" button approach (copy-to-clipboard) is preferred over auto-dispatching to a terminal. This plan adopts copy-to-clipboard per user directive; the original auto-dispatch design was rejected as over-engineered and dependent on a terminal-dispatch API that does not match the codebase.
- [ ] Confirm the PRD prompt content/sections (see Component 3) match expectations.

## Complexity Audit

### Routine
- Modal HTML structure — `kanban.html` has 5+ modal patterns to copy (Testing Fail at line 3018, Routing Map at 3038, Integration Settings at 3074, Kanban Column at 3107, Epic Create at 3130). All use `.modal-overlay` / `.modal-content` / `.modal-header` / `.modal-body` / `.modal-footer` structure.
- All required CSS classes already exist and are Claudify-aware: `.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-body`, `.modal-footer`, `.modal-input` (line 1577), `.modal-textarea` (line 1487), `.modal-label` (line 1553), `.checkbox-label` (line 1563), `.modal-btn-primary`, `.modal-btn-secondary`. **No new CSS needed.**
- Frontend JS — button click → show modal → gather inputs → `postKanbanMessage()`. Pattern is identical to every other modal in `kanban.html`. `postKanbanMessage` helper exists at line 3920; `currentWorkspaceRoot` variable exists at line 3770.
- Backend handler refactor — replace `showInputBox()` with reading `msg.projectName` from the webview payload. Same pattern as every other modal handler in `KanbanProvider.ts`.
- Copy-prompt to clipboard — `vscode.env.clipboard.writeText(prompt)` + `showStatusMessage` is the established pattern, used 20+ times in `KanbanProvider.ts` (e.g. line 730, 6018, 6078, 7961). The webview already handles `showStatusMessage` with `{message, isError}` payload at line 6006–6028.
- PRD path resolution — `getProjectPrdPath(workspaceRoot, projectName)` exists in `prdUtils.ts` (line 33) and returns `path.join(workspaceRoot, '.switchboard', 'projects', slug, 'prd.md')`. Already imported/required in `KanbanProvider.ts` (line 2884) and `PlanningPanelProvider.ts` (line 32).

### Complex / Risky
- None. The original "Complex/Risky" item (agent terminal dispatch) is removed by the copy-to-clipboard approach. The remaining work is localized, pattern-reusing, and single-session.

## Edge-Case & Dependency Audit

1. **Empty project name**: Validate client-side before enabling the submit button (mirrors the current `showInputBox` `validateInput` logic). Submit button is `disabled` until `nameInput.value.trim()` is non-empty.
2. **Duplicate project name**: `KanbanDatabase.addProject()` (line 2259–2271) catches the UNIQUE-constraint error and returns `false` — it does **not** throw. The current handler ignores this return value (silent no-op bug). **Fix:** the rewritten handler must check the boolean return and post a `showStatusMessage` error ("Project '{name}' may already exist") when `addProject` returns `false`.
3. **Clipboard API availability**: `vscode.env.clipboard.writeText` runs in the extension host (not the webview sandbox) and is a stable VS Code API used 20+ times in this file. No availability risk.
4. **Workspace context**: The modal must respect the currently selected workspace from the dropdown (`workspace-project-select`), same as the current `addProject` handler does (line 3793–3795 reads `selectedOption?.dataset?.workspaceRoot`). The modal stores this in `modal.dataset.workspaceRoot`.
5. **Claudify theme**: All new modal elements use existing `.modal-*` CSS classes which already have Claudify (terracotta) overrides (see lines 50, 1578, 1591). No theme-specific work.
6. **PRD prompt built with correct absolute path**: The prompt must tell the agent the exact `prd.md` path so the file lands where the Projects tab expects it. Use `getProjectPrdPath(workspaceRoot, projectName)` server-side — do **not** duplicate the slug logic in the webview.
7. **Cross-panel PRD visibility**: No file watcher is needed. `PlanningPanelProvider` handles `getProjectPrd` (line 3586–3608) by reading `prd.md` on demand when the user selects the project in the Projects tab and posts `projectPrdContent` to `project.js` (handled at line 347). After the agent writes the file, the user simply opens/selects the project in the Projects tab and the PRD content appears.
8. **Copy PRD Prompt without creating the project first**: The "Copy PRD Prompt" button is independent of "Create Project" — it builds the prompt from the current name/description inputs without requiring the project to exist in the DB. This is fine because the PRD path is name-derived (not DB-keyed); the agent writes to the path regardless. The user may copy the prompt before or after creating the project.

## Dependencies
- None — this plan is self-contained and reuses only existing, verified APIs.

## Adversarial Synthesis
Key risks: (1) the original plan invented a terminal-dispatch API (`getRegisteredTerminals`/`sendTextToTerminal`) that does not exist on `TaskViewerProvider` — resolved by switching to the established `vscode.env.clipboard.writeText` copy-prompt pattern; (2) `KanbanDatabase.addProject()` silently returns `false` on duplicate names and the current handler ignores it — the rewritten handler must check the return value and report duplicates via `showStatusMessage`; (3) the original status-message helper used the wrong message type (`statusMessage`/`text` vs the verified `showStatusMessage`/`{message, isError}`) and is redundant given 28 existing inline uses — deleted. Mitigations: all three are fixed in the Proposed Changes below by reusing verified patterns and adding the missing return-value check.

## Proposed Changes

---

### Component 1: Modal HTML (kanban.html)

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**Add a new "Create Project" modal after the `integration-settings-modal` closes (line 3104) and before the `<!-- Kanban Column Modal -->` comment (line 3106).** Use the established `.modal-overlay` / `.modal-content` pattern.

> **Insertion point:** Insert immediately after line 3104 (the closing `</div>` of `integration-settings-modal`) and before the blank line + `<!-- Kanban Column Modal -->` at line 3106. Do **not** insert at line 3074 — that is the *opening* tag of the integration-settings modal and would nest the new modal inside it.

```html
<!-- Create Project Modal -->
<div id="create-project-modal" class="modal-overlay hidden">
    <div class="modal-content">
        <div class="modal-header">
            <h3 class="modal-title">Create Project</h3>
            <button class="modal-close-btn" id="create-project-close">&times;</button>
        </div>
        <div class="modal-body">
            <label class="modal-label" for="create-project-name">Project name</label>
            <input id="create-project-name" class="modal-input" type="text"
                   placeholder="e.g. frontend, backend, infrastructure"
                   autocomplete="off">
            <label class="modal-label" for="create-project-description">Description (optional — used as context for PRD generation)</label>
            <textarea id="create-project-description" class="modal-textarea" rows="4"
                      placeholder="Brief description of the project's purpose, target users, key features..."></textarea>
        </div>
        <div class="modal-footer">
            <button class="modal-btn modal-btn-secondary" id="create-project-cancel">Cancel</button>
            <button class="modal-btn modal-btn-secondary" id="create-project-copy-prd" disabled>Copy PRD Prompt</button>
            <button class="modal-btn modal-btn-primary" id="create-project-submit" disabled>Create Project</button>
        </div>
    </div>
</div>
```

**No new CSS needed** — all classes (`.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-body`, `.modal-footer`, `.modal-input`, `.modal-textarea`, `.modal-label`, `.modal-btn-primary`, `.modal-btn-secondary`) already exist and are Claudify-aware.

> **Design note (per user directive):** The original plan used a "Generate PRD with Agent" checkbox that auto-dispatched a prompt to a terminal. That approach was rejected as over-engineered and dependent on a non-existent terminal-dispatch API. Replaced with a "Copy PRD Prompt" button that copies a ready-to-paste prompt to the clipboard — matching the established kanban copy-prompt pattern (see `KanbanProvider.ts` lines 730, 6018, 6078, 7961).

---

### Component 2: Modal JS Logic (kanban.html `<script>`)

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**Replace the existing `btnAddProject` click handler** (lines 3792–3797) to open the modal instead of posting a message directly:

```javascript
// REPLACE the existing handler (lines 3792-3797):
btnAddProject?.addEventListener('click', () => {
    const select = document.getElementById('workspace-project-select');
    const selectedOption = select?.selectedOptions?.[0];
    const workspaceRoot = selectedOption?.dataset?.workspaceRoot || currentWorkspaceRoot;

    // Store workspace root for the modal handlers
    const modal = document.getElementById('create-project-modal');
    if (modal) {
        modal.dataset.workspaceRoot = workspaceRoot;
        document.getElementById('create-project-name').value = '';
        document.getElementById('create-project-description').value = '';
        document.getElementById('create-project-submit').disabled = true;
        document.getElementById('create-project-copy-prd').disabled = true;
        modal.classList.remove('hidden');
        document.getElementById('create-project-name').focus();
    }
});
```

**Add modal interaction handlers** (after the existing modal handler blocks):

```javascript
// Create Project Modal handlers
(function initCreateProjectModal() {
    const modal = document.getElementById('create-project-modal');
    const nameInput = document.getElementById('create-project-name');
    const descInput = document.getElementById('create-project-description');
    const submitBtn = document.getElementById('create-project-submit');
    const copyPrdBtn = document.getElementById('create-project-copy-prd');
    const cancelBtn = document.getElementById('create-project-cancel');
    const closeBtn = document.getElementById('create-project-close');

    if (!modal || !nameInput || !submitBtn) return;

    function closeModal() {
        modal.classList.add('hidden');
    }

    // Enable submit + copy-prd only when name is non-empty
    nameInput.addEventListener('input', () => {
        const valid = !!nameInput.value.trim();
        submitBtn.disabled = !valid;
        copyPrdBtn.disabled = !valid;
    });

    // Enter key submits if name is valid
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && nameInput.value.trim()) {
            submitBtn.click();
        }
    });

    // Escape closes
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    // Close buttons
    cancelBtn?.addEventListener('click', closeModal);
    closeBtn?.addEventListener('click', closeModal);

    // Backdrop click closes
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Submit — create the project
    submitBtn.addEventListener('click', () => {
        const projectName = nameInput.value.trim();
        if (!projectName) return;

        const workspaceRoot = modal.dataset.workspaceRoot || currentWorkspaceRoot;
        const description = descInput?.value?.trim() || '';

        postKanbanMessage({
            type: 'addProject',
            workspaceRoot,
            projectName,
            description
        });

        closeModal();
    });

    // Copy PRD Prompt — copy a ready-to-paste prompt to the clipboard (does NOT close modal)
    copyPrdBtn?.addEventListener('click', () => {
        const projectName = nameInput.value.trim();
        if (!projectName) return;

        const workspaceRoot = modal.dataset.workspaceRoot || currentWorkspaceRoot;
        const description = descInput?.value?.trim() || '';

        postKanbanMessage({
            type: 'copyPrdPrompt',
            workspaceRoot,
            projectName,
            description
        });

        // Visual feedback
        copyPrdBtn.textContent = 'COPIED!';
        setTimeout(() => { copyPrdBtn.textContent = 'Copy PRD Prompt'; }, 1500);
    });
})();
```

---

### Component 3: Backend Handlers (KanbanProvider.ts)

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**Replace the `addProject` case** (lines 5316–5335) to accept the project name from the message payload (no more `showInputBox`) and **check the `addProject` return value** to report duplicates:

```typescript
case 'addProject': {
    const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
    if (!workspaceRoot) break;

    // Accept projectName from the webview modal payload (no more showInputBox)
    const projectName = typeof msg.projectName === 'string' ? msg.projectName.trim() : '';
    if (!projectName) {
        // Fallback for legacy callers that don't send projectName (shouldn't happen)
        break;
    }

    const workspaceId = await this._readWorkspaceId(workspaceRoot);
    if (!workspaceId) break;

    const db = this._getKanbanDb(workspaceRoot);
    const created = await db.addProject(workspaceId, projectName);
    this._allWorkspaceProjectsCache = null; // Invalidate cache
    await this._refreshBoard(workspaceRoot);

    // addProject returns false on duplicate (UNIQUE constraint) — report it
    if (!created) {
        this._panel?.webview.postMessage({
            type: 'showStatusMessage',
            message: `Project "${projectName}" may already exist.`,
            isError: true
        });
    }
    break;
}
```

> **Bug fix:** the original handler (line 5328) ignored the boolean return of `db.addProject()`. `KanbanDatabase.addProject()` (line 2259–2271) catches the UNIQUE-constraint error and returns `false` without throwing. The new handler checks the return value and posts an error status so the user gets feedback instead of a silent no-op.

**Add a new `copyPrdPrompt` case** (immediately after the `addProject` case, before `deleteProject` at line 5336). This builds a PRD-generation prompt using the verified `getProjectPrdPath` and copies it to the clipboard — matching the established copy-prompt pattern:

```typescript
case 'copyPrdPrompt': {
    const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
    const projectName = typeof msg.projectName === 'string' ? msg.projectName.trim() : '';
    if (!workspaceRoot || !projectName) break;

    const description = typeof msg.description === 'string' ? msg.description.trim() : '';
    const { getProjectPrdPath } = require('./prdUtils');
    const prdPath = getProjectPrdPath(workspaceRoot, projectName);

    const prompt = [
        `You are a product requirements document (PRD) writer.`,
        `Create a concise but comprehensive PRD for the project "${projectName}".`,
        description ? `\nProject description: ${description}` : '',
        `\nSave the PRD as markdown to this exact file path: ${prdPath}`,
        `\nThe PRD should include:`,
        `- Project overview and purpose`,
        `- Target users / audience`,
        `- Core features and requirements`,
        `- Non-functional requirements (performance, security, etc.)`,
        `- Success criteria`,
        `- Out of scope items`,
        `\nKeep it practical and actionable. This PRD will be injected into agent prompts as project context.`,
    ].filter(Boolean).join('\n');

    try {
        await vscode.env.clipboard.writeText(prompt);
        this._panel?.webview.postMessage({
            type: 'showStatusMessage',
            message: `PRD prompt copied to clipboard — paste into your agent. It will save to ${prdPath}`,
            isError: false
        });
    } catch (err) {
        console.error('[KanbanProvider] copyPrdPrompt failed:', err);
        this._panel?.webview.postMessage({
            type: 'showStatusMessage',
            message: `Failed to copy PRD prompt to clipboard.`,
            isError: true
        });
    }
    break;
}
```

> **Pattern conformance:** this mirrors the existing clipboard copy at `KanbanProvider.ts` line 7961 (Suggest Epics) and line 6018 (batch planner prompt). `vscode.env.clipboard.writeText` is the extension-host clipboard API (not the webview `navigator.clipboard`), and the `showStatusMessage` payload shape `{message, isError}` matches the webview handler at `kanban.html` line 6006–6028.
>
> **No status-message helper needed:** `KanbanProvider` already inlines `this._panel?.webview.postMessage({ type: 'showStatusMessage', message: ..., isError: ... })` 28 times. Adding a `_showStatusMessage` wrapper (as the original plan proposed) is unnecessary and used the wrong message type (`statusMessage`/`text` instead of `showStatusMessage`/`{message, isError}`).

---

### Component 4 (DELETED — No Longer Needed)

The original plan's Component 4 proposed a `_showStatusMessage` helper. This is **deleted** because:
1. It used the wrong message type (`statusMessage`/`text`) — the webview handler listens for `showStatusMessage` with `{message, isError}` (verified at `kanban.html` line 6006).
2. The inline pattern is already established (28 uses in `KanbanProvider.ts`) — no wrapper is warranted.

The original plan's `_dispatchPrdGeneration` method (terminal dispatch + fallback template writer) is also **deleted** because:
1. It called non-existent APIs (`getRegisteredTerminals()`, `sendTextToTerminal()`) on `TaskViewerProvider`.
2. The copy-to-clipboard approach (Component 3 `copyPrdPrompt` case) replaces it entirely with a simpler, host-agnostic, terminal-independent flow.

---

## Verification Plan

> **Per session directives:** No compilation step (`tsc`/webpack) and no automated test execution is run as part of this plan. The test authoring below is for the user to run separately. Manual verification is the primary path.

### Automated Tests

1. **New HTML structure test** — create a **new** test file (e.g. `src/test/kanban-create-project-modal.test.js`) that asserts `kanban.html` contains `id="create-project-modal"`, the input/textarea/button IDs, and that the modal uses `modal-overlay`/`modal-content` classes.
   > **Note:** the original plan referenced `src/test/project-panel-kanban-create-button.test.js` — that file tests a *different* feature (the "Create Kanban Plan" button in `project.html`, not the "Add Project" button in `kanban.html`). Do not modify it; create a new dedicated test.

2. **Backend handler test** — assert `KanbanProvider.ts` `addProject` case no longer calls `showInputBox` and instead reads `msg.projectName`; assert the `addProject` return value is checked; assert a `copyPrdPrompt` case exists.
   ```bash
   grep -c "showInputBox" src/services/KanbanProvider.ts   # should be 0 in the addProject case
   grep "case 'copyPrdPrompt'" src/services/KanbanProvider.ts   # should match
   grep "if (!created)" src/services/KanbanProvider.ts   # should match (duplicate check)
   ```

3. **PRD path test** — verify `getProjectPrdPath` is called in the `copyPrdPrompt` case:
   ```bash
   grep "getProjectPrdPath" src/services/KanbanProvider.ts
   ```

4. **Clipboard pattern test** — verify `copyPrdPrompt` uses `vscode.env.clipboard.writeText` and `showStatusMessage` (not the rejected `statusMessage`/`_showStatusMessage`):
   ```bash
   grep -c "vscode.env.clipboard.writeText" src/services/KanbanProvider.ts   # should increase by 1
   grep "_showStatusMessage\|type: 'statusMessage'" src/services/KanbanProvider.ts   # should return 0 matches
   ```

### Manual Verification
1. Open the Switchboard kanban board in VS Code.
2. Click the `+` button next to the workspace/project dropdown.
3. **Expect**: A styled modal opens (not a VS Code popup).
4. Type a project name → both "Create Project" and "Copy PRD Prompt" buttons enable.
5. Click "Create Project" → project appears in the dropdown, modal closes.
6. Open the modal again, type a name + description, click "Copy PRD Prompt" → button shows "COPIED!", a status message appears with the PRD path.
7. Paste the clipboard into an agent (Claude/Cursor) → the agent generates the PRD and saves it to the path shown.
8. Switch to the Projects tab → select the new project → PRD content appears (via the existing `getProjectPrd` → `projectPrdContent` flow in `PlanningPanelProvider.ts` line 3586 + `project.js` line 347).
9. Test duplicate: create a project that already exists → expect an error status message "Project '...' may already exist."
10. Test with both Afterburner (teal) and Claudify (terracotta) themes — modal should be styled correctly.
11. Test edge cases: empty name (both buttons disabled), Escape key closes, backdrop click closes, Enter key submits.

---

## Recommendation

**Complexity: 4/10 → Send to Coder.**

The work is multi-file (`kanban.html` + `KanbanProvider.ts`) but entirely routine — every piece reuses verified existing patterns (modal structure, `postKanbanMessage`, `vscode.env.clipboard.writeText`, `showStatusMessage`, `getProjectPrdPath`). The only non-trivial addition is the duplicate-name return-value check, which is a one-line `if (!created)` guard. No new architectural patterns, no data-consistency risks, no breaking changes.

---

## Reviewer Pass (2026-06-28)

### Stage 1 — Grumpy Principal Engineer

*Theatrical, incisive, severity-tagged. The implementation was inspected against every plan requirement.*

**NIT-1 — Wasteful refresh on duplicate name.** `KanbanProvider.ts:5392-5394`. The `addProject` case nulls `_allWorkspaceProjectsCache` and calls `await this._refreshBoard(workspaceRoot)` *before* the `if (!created)` duplicate check at line 5397. So when a user fat-fingers a duplicate project name, we tear down the cache and run a full board refresh for absolutely nothing — the DB row was never inserted, the board state is unchanged. The refresh is a no-op visually but it's still a round-trip through `_refreshBoard` (cache rebuild + webview re-post). Move the cache invalidation + refresh inside the success path. Not a correctness bug, but it's the kind of sloppy "refresh first, ask questions later" pattern that accumulates into jank on a 4,000-install base. **Severity: NIT.**

**NIT-2 — Double newlines in the PRD prompt around the description block.** `KanbanProvider.ts:5418`. The description line is emitted as `\nProject description: ${description}` (a leading newline escape *inside* a template literal), and then the whole array is `.join('\n')`'d. Net effect: the description block is surrounded by blank lines while the other bullets aren't. Cosmetic only — the agent reading the prompt doesn't care. **Severity: NIT.**

**Passed checks (no findings):**
- Modal HTML at `kanban.html:3099-3121` — placed correctly between `integration-settings-modal` and `<!-- Kanban Column Modal -->`, all element IDs present, all classes are existing Claudify-aware `.modal-*` classes. No new CSS. ✔
- `btnAddProject` handler at `kanban.html:3809-3825` — opens modal, stores `workspaceRoot` in `modal.dataset`, resets inputs, focuses name. ✔
- `initCreateProjectModal` IIFE at `kanban.html:7180-7261` — input-gating, Enter-to-submit, Escape-to-close, backdrop-click, cancel/close buttons, submit posts `addProject`, copy button posts `copyPrdPrompt` with "COPIED!" feedback. All edge cases from plan §Edge-Case Audit item 1-5,11 covered. ✔
- `addProject` case at `KanbanProvider.ts:5379-5405` — reads `msg.projectName` from payload (no `showInputBox`), checks `created` return value, posts `showStatusMessage` error on duplicate. `showInputBox` is fully purged from the file (grep returns 0 matches). ✔
- `copyPrdPrompt` case at `KanbanProvider.ts:5406-5446` — uses `getProjectPrdPath(workspaceRoot, projectName)` (server-side slug resolution, no webview slug duplication), `vscode.env.clipboard.writeText`, `showStatusMessage` with `{message, isError}` shape matching the webview handler at `kanban.html:6058`. ✔
- No `_showStatusMessage` helper, no `type: 'statusMessage'`, no `_dispatchPrdGeneration`, no `getRegisteredTerminals`/`sendTextToTerminal` — all deleted Components 4 fully removed (grep returns 0 matches). ✔
- `getProjectPrdPath` exists at `prdUtils.ts:33`, slug sanitiser at line 16 prevents path traversal. ✔
- `KanbanDatabase.addProject(workspaceId, projectName)` signature confirmed at `KanbanDatabase.ts:2259` — takes no description, returns `false` on UNIQUE-constraint catch. The `description` field is correctly used only for PRD prompt context, not DB storage. ✔
- Test file `src/test/kanban-create-project-modal.test.js` exists (66 lines) and asserts modal IDs, `initCreateProjectModal`, `copyPrdPrompt` case, `vscode.env.clipboard.writeText`, and `!created` duplicate check. ✔

### Stage 2 — Balanced Synthesis

**Keep as-is:** Modal HTML, JS handlers, `copyPrdPrompt` backend, duplicate-name error reporting, test file. All match the plan exactly and reuse verified patterns. No CRITICAL or MAJOR findings.

**Fix now:** None required. Both NITs are cosmetic/efficiency-only and the plan's source-of-truth code specifies the current ordering. NIT-1 (refresh-on-duplicate) is a one-line reorder but the plan explicitly shows `_refreshBoard` before the `if (!created)` check — changing it would deviate from the plan-as-source-of-truth without a material benefit. NIT-2 (double newlines) is purely cosmetic in a prompt string consumed by an LLM.

**Defer:** NIT-1 and NIT-2 — neither affects correctness, UX, or data integrity. Track as optional polish.

### Code Fixes Applied

None. The implementation is faithful to the plan and has no CRITICAL or MAJOR defects.

### Verification Results

- **showInputBox purge:** `grep -c "showInputBox" src/services/KanbanProvider.ts` → 0 matches (exit 1). ✔
- **copyPrdPrompt case:** `grep "case 'copyPrdPrompt'" src/services/KanbanProvider.ts` → match at line 5406. ✔
- **Duplicate check:** `grep "if (!created)" src/services/KanbanProvider.ts` → match at line 5397. ✔
- **getProjectPrdPath usage:** `grep "getProjectPrdPath" src/services/KanbanProvider.ts` → matches at lines 2886, 2887 (existing) and 5412, 5413 (new). ✔
- **Clipboard pattern:** `grep -c "vscode.env.clipboard.writeText" src/services/KanbanProvider.ts` → 18 occurrences (increased by 1 for the new `copyPrdPrompt` case). ✔
- **Rejected patterns absent:** `grep "_showStatusMessage\|type: 'statusMessage'" src/services/KanbanProvider.ts` → 0 matches. ✔
- **showStatusMessage webview handler:** confirmed at `kanban.html:6058`, payload shape `{message, isError}` matches backend posts. ✔
- **Test file present:** `src/test/kanban-create-project-modal.test.js` (66 lines) covers all plan assertions. ✔
- *Per session directives: no compilation (`tsc`/webpack) and no automated test execution was run.*

### Files Changed (Implementation)

- `src/webview/kanban.html` — Create Project Modal markup (lines 3099-3121), `btnAddProject` handler (lines 3809-3825), `initCreateProjectModal` IIFE (lines 7180-7261).
- `src/services/KanbanProvider.ts` — rewritten `addProject` case (lines 5379-5405), new `copyPrdPrompt` case (lines 5406-5446).
- `src/test/kanban-create-project-modal.test.js` — new test file (66 lines).

### Remaining Risks

1. **NIT-1 (deferred):** `_refreshBoard` runs on duplicate-name attempts — wasteful but harmless. Optional one-line fix: move cache invalidation + refresh inside `if (created)` / invert to early-return on `!created`.
2. **NIT-2 (deferred):** PRD prompt has cosmetic double-newlines around the optional description block. No functional impact.
3. **Manual verification not yet run:** The plan's 11-step manual verification checklist (open board, click `+`, type name, create, copy prompt, paste into agent, verify PRD appears in Projects tab, test duplicate, test both themes, test edge cases) is pending user execution.
