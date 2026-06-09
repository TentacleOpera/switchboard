## Goal

Split the conflated "Multi-Repo" tab in the Switchboard setup panel into two distinct tabs: **Control Plane** and **Mappings**, and update the initial onboarding wizard to ask users if they need a control plane setup before scaffolding.

## Problem Analysis

The setup panel had a single "Multi-Repo" tab that bundled two completely unrelated features:

1. **Control Plane** — a workspace restructuring tool that externalizes Switchboard configuration (`.switchboard/`, `.agent/`, `AGENTS.md`) to a parent folder outside individual repositories. This solves the problem where corporate/team environments lock down edits to agent files, preventing Switchboard from scaffolding inside the repo itself.

2. **Workspace Mappings** — a runtime database routing feature that redirects workspace folders to use a shared `kanban.db` instead of their local one. This is purely about database location, not workspace structure or agent configuration.

Both features were in the same tab with a misleading label ("Multi-Repo") and a "CENTRALIZE CONFIGURATION" button that actually opened a migration wizard — further confusing users about which feature did what.

## Onboarding Wizard Gap

The initial onboarding wizard currently does not ask users whether they need a control plane setup. This means users in locked-down environments (where `AGENTS.md` edits are blocked) may attempt to scaffold Switchboard inside their repo, fail silently, and never realize there is an alternative external configuration path.

The onboarding wizard should explicitly ask: "Will you need to run Switchboard in an environment where edits to agent files are restricted?" If yes, guide them to set up a control plane first.

## Metadata

**Tags:** frontend, ui, ux, refactor
**Complexity:** 5

## User Review Required

- Confirm whether `multi-repo-*` internal IDs in the Control Plane modal should be renamed as part of this plan or in a separate follow-up.

## Complexity Audit

### Routine
- Tab navigation split (adding two buttons, removing one)
- Tab content div split (moving existing HTML into two containers)
- `tabIdMap` and `tabLoadCallbacks` updates (mechanical mapping changes)
- Persisted state migration for old `multi-repo` tab ID

### Complex / Risky
- Phase 2 onboarding wizard: inserting a new step in `implementation.html` between Welcome and CLI Config, modifying `handleOnboardingProgress` flow, adding `openSetupPanel` message handler in `TaskViewerProvider.ts`
- Stale `multi-repo-*` IDs in the Control Plane modal (6+ element IDs) — low functional risk but creates maintenance confusion

## Edge-Case & Dependency Audit

- **Race Conditions:** None — tab switching is synchronous DOM manipulation.
- **Security:** No security implications. The Control Plane modal IDs are not exposed to any external interface.
- **Side Effects:** The persisted state migration (`multi-repo` → `control-plane`) is a one-time transform on panel load. If a user has an old `activeTabId` of `'multi-repo'` in their webview state, it will be silently corrected. No other state keys reference the old tab ID.
- **Dependencies & Conflicts:** Line 4369 in `setup.html` routes `message.section === 'multi-repo-control-plane'` to `openControlPlaneSetup('fresh-setup')`. This is a **backend message contract** — the backend (`SetupPanelProvider.ts`) sends this section name. Renaming it requires a coordinated change in both files. The plan correctly leaves it as-is for Phase 1.

## Dependencies

- `sess_setup_panel_split` — Control Plane / Mappings tab split (Phase 1, completed)

## Adversarial Synthesis

Key risks: Phase 2 inserts a new step in the onboarding wizard flow in `implementation.html`, which requires coordinated changes across HTML (new step div), JS (modified `handleOnboardingProgress` + new button listeners), and backend (`TaskViewerProvider.ts` `openSetupPanel` handler). The `initializeProtocols` step may silently fail in locked-down environments (writes to `.switchboard/` blocked) but still report success. Mitigations: all changes are scoped to specific line ranges; the `openSetupPanel` handler reuses the existing `switchboard.openSetupPanel` command; the YES path finishes onboarding after opening the setup panel so the user isn't stuck in a broken state.

## Implementation

### Phase 1: Split the tabs (COMPLETED — verified in code)

**File changed:** `src/webview/setup.html`

All six edits have been applied and verified against the current source:

**Edit 1 — Tab navigation (lines 565-566):** ✅ Verified
- `<button class="tab-btn" data-tab="control-plane">Control Plane</button>`
- `<button class="tab-btn" data-tab="mappings">Mappings</button>`

**Edit 2 — Tab content split (lines 680, 693):** ✅ Verified
- `id="control-plane-fields"` with heading "EXTERNAL SWITCHBOARD CONFIGURATION", explanation, and "OPEN CONTROL PLANE SETUP" button
- `id="mappings-fields"` with heading "WORKSPACE-TO-DATABASE ROUTING", enable checkbox, mapping list, add/save buttons, status, and Global Settings toggle

**Edit 3 — `tabIdMap` backward compat (lines 1537-1538):** ✅ Verified
- `'control-plane-fields': 'control-plane'`
- `'mappings-fields': 'mappings'`

**Edit 4 — `tabLoadCallbacks` (lines 1637-1643):** ✅ Verified
- `'control-plane'` → posts `getControlPlaneStatus`
- `'mappings'` → posts `getWorkspaceMappings` + `getGlobalSettingsEnabled`

**Edit 5 — Persisted state migration (lines 1579-1581):** ✅ Verified
- `if (persistedState.activeTabId === 'multi-repo') { persistedState.activeTabId = 'control-plane'; }`

**Edit 6 — `openControlPlaneSetup()` redirect (line 2023):** ✅ Verified
- `activateTab('control-plane')`

**What was NOT changed (correctly left as-is):**
- All `multi-repo-*` IDs inside the Control Plane modal (inputs, status divs, event listeners at lines 1323-1338, 3098) — these are internal feature IDs, not tab references
- Backend `SetupPanelProvider.ts` — no changes needed for Phase 1 (message handlers use feature-specific types like `scaffoldMultiRepo`, not tab names)

**Stale `multi-repo-*` ID inventory (for future cleanup):**
| Current ID | Location | Safe to rename? |
|---|---|---|
| `multi-repo-parent-dir` | Line 1323 | Yes — only referenced in JS event listeners |
| `multi-repo-workspace-name` | Line 1327 | Yes — only referenced in JS event listeners |
| `multi-repo-repo-urls` | Line 1331 | Yes — only referenced in JS event listeners |
| `multi-repo-pat` | Line 1335 | Yes — only referenced in JS event listeners |
| `btn-scaffold-multi-repo` | Line 1337 | Yes — only referenced in JS event listeners (line 3098) |
| `multi-repo-scaffold-status` | Line 1338 | Yes — only referenced in JS status updates |
| `message.section === 'multi-repo-control-plane'` | Line 4369 | **No** — backend contract, requires coordinated change in `SetupPanelProvider.ts` |

### Phase 2: Onboarding wizard — add Control Plane question step (COMPLETED — verified in code)

The onboarding wizard lives in **`src/webview/implementation.html`** (the sidebar webview), NOT in `setup.html`. It is currently a 2-step flow:

| Step | Element ID | What happens |
|---|---|---|
| 1: Welcome | `onboard-step-welcome` (line 1728) | User clicks "INITIALIZE SWITCHBOARD" → sends `initializeProtocols` → backend runs `switchboard.setup` command → calls `performSetup` which writes `.switchboard/`, `.agent/`, `AGENTS.md` **inside the repo** → responds `onboardingProgress { step: 'initialized' }` → auto-advances to Step 2 |
| 2: CLI Config | `onboard-step-cli` (line 1750) | User configures agent CLI commands → clicks "SAVE & FINISH" or "SKIP" → exits onboarding |

**The problem:** `initializeProtocols` calls `performSetup` which writes inside the repo. In locked-down environments, these writes fail silently — the user sees "✅ Protocols initialized" but the files weren't created. The Control Plane exists precisely to avoid writing inside the repo, but the onboarding wizard writes there *before* asking if the user needs a Control Plane.

**The fix:** The Control Plane question must appear **BEFORE** `initializeProtocols` runs, not after. The Welcome step should advance directly to the Control Plane question. Only if the user answers "NO" (in-repo setup) should `initializeProtocols` be called.

**New onboarding flow:**
1. Welcome → "INITIALIZE SWITCHBOARD" → advance to Control Plane question (no backend call yet)
2. **NEW:** Control Plane question → "SET UP CONTROL PLANE" reveals inline form in sidebar → user scaffolds externally → onboarding finishes; "CONTINUE WITH IN-REPO SETUP" runs `initializeProtocols` then advances to CLI config
3. CLI Config → "SAVE & FINISH" or "SKIP" → exits onboarding

#### Step 2a HTML — New onboarding step (insert between lines 1747 and 1749)

Insert a new `onboard-step` div after `onboard-step-welcome` closes (line 1747) and before `onboard-step-cli` opens (line 1749). This step contains the Control Plane form fields inline so the user stays in the sidebar throughout onboarding:

```html
<!-- Step 2a: Control Plane Question -->
<div id="onboard-step-control-plane" class="onboard-step hidden">
    <div style="padding: 16px;">
        <div class="section-label" style="margin-bottom: 12px;">WORKSPACE CONFIGURATION</div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 14px; line-height: 1.5;">
            Switchboard scaffolds configuration files inside your repository
            (<code style="font-size:10px;">AGENTS.md</code>,
            <code style="font-size:10px;">.agent/</code>,
            <code style="font-size:10px;">.switchboard/</code>).
            If you do not want this extension to write to
            <code style="font-size:10px;">AGENTS.md</code> or perform other scaffolding
            steps inside your repo, you can create a <strong>Control Plane folder</strong>
            that contains all Switchboard scaffolding externally.
        </div>

        <!-- Control Plane setup form (initially hidden, shown when user clicks "SET UP CONTROL PLANE") -->
        <div id="onboard-cp-form" class="hidden" style="margin-top: 10px;">
            <label class="startup-row" style="display:block; margin-bottom:6px;">
                <span style="display:block; margin-bottom:4px; font-size: 10px;">Control Plane parent directory</span>
                <input id="onboard-cp-parent-dir" type="text" placeholder="e.g. /Users/you/Documents/GitHub" style="width:100%;">
            </label>
            <label class="startup-row" style="display:block; margin-bottom:6px;">
                <span style="display:block; margin-bottom:4px; font-size: 10px;">Workspace file name</span>
                <input id="onboard-cp-workspace-name" type="text" placeholder="e.g. switchboard-control-plane" style="width:100%;">
            </label>
            <label class="startup-row" style="display:block; margin-bottom:6px;">
                <span style="display:block; margin-bottom:4px; font-size: 10px;">Repository clone URLs (one HTTPS URL per line)</span>
                <textarea id="onboard-cp-repo-urls" rows="4" placeholder="https://github.com/org/service-a.git&#10;https://github.com/org/service-b.git" style="width:100%; resize:vertical;"></textarea>
            </label>
            <label class="startup-row" style="display:block; margin-bottom:6px;">
                <span style="display:block; margin-bottom:4px; font-size: 10px;">Personal Access Token</span>
                <input id="onboard-cp-pat" type="password" placeholder="Transient PAT used only while cloning" style="width:100%;">
            </label>
            <button id="btn-onboard-cp-scaffold" class="secondary-btn w-full"
                style="margin-top: 8px; padding: 10px; font-size: 11px; color: var(--accent-teal); border-color: color-mix(in srgb, var(--accent-teal) 40%, transparent);">
                SCAFFOLD CONTROL PLANE</button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
            <button id="btn-onboard-cp-toggle" class="secondary-btn w-full"
                style="padding: 10px; font-size: 11px; color: var(--accent-teal); border-color: color-mix(in srgb, var(--accent-teal) 40%, transparent);">
                SET UP CONTROL PLANE</button>
            <button id="btn-onboard-cp-inrepo" class="secondary-btn w-full"
                style="padding: 10px; font-size: 11px;">
                CONTINUE WITH IN-REPO SETUP</button>
        </div>
        <div id="onboard-cp-status"
            style="text-align: center; margin-top: 10px; font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary);">
        </div>
    </div>
</div>
```

**UX flow:**
1. The step initially shows the explanatory text + two buttons: "SET UP CONTROL PLANE" and "CONTINUE WITH IN-REPO SETUP"
2. Clicking "SET UP CONTROL PLANE" reveals the form fields inline (parent dir, workspace name, repo URLs, PAT, scaffold button) and hides the two choice buttons
3. The user fills in the fields and clicks "SCAFFOLD CONTROL PLANE" — this sends `scaffoldMultiRepo` to the backend, same message format as `setup.html`
4. The backend scaffolds the Control Plane and responds with `multiRepoScaffoldResult`
5. On success, onboarding finishes. On error, the status div shows the error message.

This keeps the user in the sidebar throughout. No separate panel opens.

#### Step 2a JS — Wire up the new step (in the onboarding logic section, lines 5636+)

**1. Add DOM reference** (after line 5640):
```js
const onboardStepControlPlane = document.getElementById('onboard-step-control-plane');
```

**2. Change the Welcome button behavior** (line 5685-5687): Instead of sending `initializeProtocols` immediately, advance to the Control Plane question step:

```js
document.getElementById('btn-onboard-init').addEventListener('click', () => {
    // Advance to Control Plane question BEFORE running initializeProtocols
    // (initializeProtocols writes inside the repo, which may fail in locked-down environments)
    onboardStepWelcome.classList.add('hidden');
    onboardStepControlPlane.classList.remove('hidden');
});
```

**3. Add button event listeners** (after the modified `btn-onboard-init` listener):

```js
// "SET UP CONTROL PLANE" — reveal inline form, hide choice buttons
document.getElementById('btn-onboard-cp-toggle').addEventListener('click', () => {
    document.getElementById('onboard-cp-form').classList.remove('hidden');
    document.getElementById('btn-onboard-cp-toggle').classList.add('hidden');
    document.getElementById('btn-onboard-cp-inrepo').classList.add('hidden');
});

// "CONTINUE WITH IN-REPO SETUP" — run initializeProtocols (writes inside repo)
document.getElementById('btn-onboard-cp-inrepo').addEventListener('click', () => {
    onboardStepControlPlane.classList.add('hidden');
    const initStatus = document.getElementById('onboard-init-status');
    if (initStatus) initStatus.textContent = 'Initializing protocols...';
    vscode.postMessage({ type: 'initializeProtocols' });
});

// "SCAFFOLD CONTROL PLANE" — send scaffoldMultiRepo to backend
document.getElementById('btn-onboard-cp-scaffold').addEventListener('click', () => {
    const cpStatus = document.getElementById('onboard-cp-status');
    if (cpStatus) cpStatus.textContent = 'Scaffolding Control Plane...';
    document.getElementById('btn-onboard-cp-scaffold').disabled = true;
    vscode.postMessage({
        type: 'scaffoldMultiRepo',
        parentDir: document.getElementById('onboard-cp-parent-dir')?.value.trim() || '',
        workspaceName: document.getElementById('onboard-cp-workspace-name')?.value.trim() || '',
        repoUrls: (document.getElementById('onboard-cp-repo-urls')?.value || '')
            .split('\n')
            .map(v => v.trim())
            .filter(Boolean),
        pat: document.getElementById('onboard-cp-pat')?.value || ''
    });
});
```

**4. Handle `multiRepoScaffoldResult` in the message handler** (near line 2577, alongside `setupStatus` and `onboardingProgress`):

```js
case 'multiRepoScaffoldResult':
    const cpStatus = document.getElementById('onboard-cp-status');
    const cpScaffoldBtn = document.getElementById('btn-onboard-cp-scaffold');
    if (cpScaffoldBtn) cpScaffoldBtn.disabled = false;
    if (message.result?.success) {
        if (cpStatus) { cpStatus.textContent = '✅ Control Plane scaffolded'; cpStatus.style.color = 'var(--accent-green)'; }
        // Finish onboarding — sidebar switches to main UI
        setTimeout(() => {
            vscode.postMessage({ type: 'finishOnboarding' });
        }, 600);
    } else {
        if (cpStatus) { cpStatus.textContent = '❌ ' + (message.result?.error || 'Scaffolding failed'); cpStatus.style.color = 'var(--accent-red)'; }
    }
    break;
```

**5. Modify `handleOnboardingProgress`** (line 5657): The `initialized` case now advances from the (hidden) Control Plane step directly to CLI config, since the Control Plane question was already answered:

```js
case 'initialized':
    if (initStatus) initStatus.textContent = '✅ Protocols initialized';
    // Advance to CLI config step (Control Plane question was already answered)
    setTimeout(() => {
        onboardStepControlPlane.classList.add('hidden');
        onboardStepCli.classList.remove('hidden');
    }, 600);
    break;
```

Note: `onboardStepWelcome` is already hidden at this point (hidden when the Control Plane question was shown), so we only need to hide the Control Plane step and show CLI.

#### Backend changes — `src/services/TaskViewerProvider.ts`

Add a `scaffoldMultiRepo` handler in `TaskViewerProvider._handleMessage()` that calls the same `MultiRepoScaffoldingService.scaffold` used by `SetupPanelProvider`.

**File:** `src/services/TaskViewerProvider.ts`

Add a case in the message handler (near line 8312, alongside `initializeProtocols` and `finishOnboarding`):

```ts
case 'scaffoldMultiRepo': {
    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                cancellable: false,
                title: 'Scaffolding Multi-Repo Control Plane...'
            },
            () => MultiRepoScaffoldingService.scaffold(
                {
                    parentDir: typeof data.parentDir === 'string' ? data.parentDir : '',
                    workspaceName: typeof data.workspaceName === 'string' ? data.workspaceName : '',
                    repoUrls: Array.isArray(data.repoUrls) ? data.repoUrls.map((value: unknown) => String(value)) : [],
                    pat: typeof data.pat === 'string' ? data.pat : ''
                },
                this._extensionUri.fsPath
            )
        );
        this._view?.webview.postMessage({ type: 'multiRepoScaffoldResult', result });
    } catch (error) {
        this._view?.webview.postMessage({
            type: 'multiRepoScaffoldResult',
            result: {
                success: false,
                repos: [],
                error: error instanceof Error ? error.message : String(error)
            }
        });
    }
    break;
}
```

This is the same logic as `SetupPanelProvider.ts` lines 300-329, but posting back to the sidebar webview (`this._view`) instead of the setup panel webview (`this._panel`).

**Import required:** Add `MultiRepoScaffoldingService` to the imports at the top of `TaskViewerProvider.ts` (it's already imported in `SetupPanelProvider.ts` from `./MultiRepoScaffoldingService`).

#### Summary of Phase 2 changes

| File | Lines | Change |
|---|---|---|
| `src/webview/implementation.html` | After 1747 | Insert new `onboard-step-control-plane` HTML div |
| `src/webview/implementation.html` | After 5640 | Add `onboardStepControlPlane` DOM reference |
| `src/webview/implementation.html` | 5685-5687 | Change `btn-onboard-init` to advance to Control Plane step instead of sending `initializeProtocols` |
| `src/webview/implementation.html` | After 5687 | Add `btn-onboard-cp-toggle`, `btn-onboard-cp-inrepo`, `btn-onboard-cp-scaffold` click listeners + `multiRepoScaffoldResult` handler |
| `src/webview/implementation.html` | 5664-5670 | Change `initialized` handler to advance to CLI config (Control Plane step already answered) |
| `src/services/TaskViewerProvider.ts` | ~8312 | Add `scaffoldMultiRepo` message handler case + `MultiRepoScaffoldingService` import |

**Onboarding flow after Phase 2:**
1. Welcome → "INITIALIZE SWITCHBOARD" → advance to Control Plane question (no backend call)
2. **NEW:** Control Plane question → "SET UP CONTROL PLANE" reveals inline form fields in sidebar → user fills in and clicks "SCAFFOLD CONTROL PLANE" → backend scaffolds externally → onboarding finishes; "CONTINUE WITH IN-REPO SETUP" runs `initializeProtocols` (in-repo writes) then advances to CLI config
3. CLI Config → "SAVE & FINISH" or "SKIP" → exits onboarding

## Proposed Changes

### `src/webview/setup.html` (Phase 1 only)
- **Context:** Phase 1 edits are already applied and verified. No further changes needed.
- **Logic:** N/A — Phase 1 complete.
- **Implementation:** N/A.
- **Edge Cases:** N/A.

### `src/webview/implementation.html` (Phase 2)
- **Context:** Contains the onboarding wizard (2-step flow: Welcome → CLI Config). The wizard is shown when `needsSetup === true` (controlled by `toggleOnboarding()` at line 5642).
- **Logic:** Insert a new step 2a (Control Plane question + inline form) between the Welcome step and the CLI Config step. The form fields replicate the Control Plane modal from `setup.html` but stay in the sidebar. On scaffold success, onboarding finishes. On "CONTINUE WITH IN-REPO SETUP", `initializeProtocols` runs.
- **Implementation:** See Phase 2 detailed steps above (HTML at line 1747, JS at lines 5640/5664/5687).
- **Edge Cases:** User dismisses the onboarding wizard without answering — the Control Plane step is never shown, defaults to in-repo setup (current behavior). Scaffold failure — status div shows error, user can retry. User clicks "SET UP CONTROL PLANE" but then decides not to scaffold — no back button currently, but they can close the sidebar and reopen to restart onboarding.

### `src/services/TaskViewerProvider.ts` (Phase 2)
- **Context:** Handles sidebar webview messages including `initializeProtocols` and `finishOnboarding`. Does NOT currently handle `scaffoldMultiRepo`.
- **Logic:** Add `scaffoldMultiRepo` message handler that calls `MultiRepoScaffoldingService.scaffold` (same logic as `SetupPanelProvider.ts` lines 300-329) and posts `multiRepoScaffoldResult` back to the sidebar webview.
- **Implementation:** Add case at ~line 8312 in `_handleMessage()`. Add `MultiRepoScaffoldingService` import.
- **Edge Cases:** If scaffolding fails, the error is posted back and displayed in the sidebar status div. The scaffold button is re-enabled so the user can retry.

## Verification Plan

### Automated Tests
- No automated tests exist for the setup panel UI. Verification is manual.

### Manual Verification (Phase 1)
- [ ] Build the extension and open the setup panel
- [ ] Verify "Control Plane" and "Mappings" tabs appear separately
- [ ] Verify Control Plane tab opens the modal correctly
- [ ] Verify Mappings tab loads/saves mappings correctly
- [ ] Verify Global Settings toggle still functions
- [ ] Verify persisted tab state migration: closing panel on old "multi-repo" tab and reopening redirects to "Control Plane"
- [ ] Verify `message.section === 'multi-repo-control-plane'` still routes to Control Plane modal

### Manual Verification (Phase 2)
- [ ] Open Switchboard sidebar in a fresh workspace (no `.switchboard/` folder)
- [ ] Verify onboarding wizard appears with Welcome step
- [ ] Click "INITIALIZE SWITCHBOARD" → verify it advances to Control Plane question step (no backend call yet, no in-repo writes)
- [ ] Click "SET UP CONTROL PLANE" → verify inline form fields appear in the sidebar (parent dir, workspace name, repo URLs, PAT, scaffold button)
- [ ] Fill in Control Plane fields and click "SCAFFOLD CONTROL PLANE" → verify scaffolding runs and onboarding finishes on success (no in-repo writes, no separate panel opened)
- [ ] Verify scaffold failure shows error in status div and re-enables the scaffold button
- [ ] Click "CONTINUE WITH IN-REPO SETUP" → verify `initializeProtocols` runs (in-repo writes), then advances to CLI Config step
- [ ] Complete CLI Config step → verify onboarding exits normally
- [ ] Verify that skipping the wizard entirely (closing sidebar) defaults to in-repo setup

## Remaining Risks

- The "CONTINUE WITH IN-REPO SETUP" path still calls `initializeProtocols` which writes inside the repo. If the user mistakenly clicks it in a locked-down environment, `performSetup` will attempt in-repo writes that may fail silently. The `initialized` response doesn't distinguish between full success and partial failure. A future improvement could detect write failures in `performSetup` and report them back to the frontend.
- The modal still contains `multi-repo-*` internal IDs which is fine for functionality but may be confusing for future maintenance. A follow-up plan should rename these to `control-plane-*` (except `message.section === 'multi-repo-control-plane'` which requires a coordinated backend change).
- The inline Control Plane form in `implementation.html` duplicates the form fields from `setup.html`'s Control Plane modal. If the modal's fields change (e.g., new options added), the onboarding form must be updated to match. Consider extracting the form into a shared template in a future refactor.

## Review Results (2026-06-07)

### Stage 1: Adversarial Findings

| ID | Severity | Description |
|---|---|---|
| MAJOR-1 | MAJOR | **Invisible error on `initializeProtocols` failure.** When user clicks "CONTINUE WITH IN-REPO SETUP", the Control Plane step was hidden before `initializeProtocols` completed. On failure, the `error` case in `handleOnboardingProgress` targeted `initStatus` (inside the hidden Welcome step) — user sees nothing, is stuck. |
| NIT-1 | NIT | Stale `multi-repo-*` IDs in Control Plane modal — deferred, no functional impact. |
| NIT-2 | NIT | "Initializing protocols..." status written to hidden `initStatus` element — bundled with MAJOR-1 fix. |

### Stage 2: Fixes Applied

**MAJOR-1 fix** — `src/webview/implementation.html`:

1. **`btn-onboard-cp-inrepo` handler**: Removed `onboardStepControlPlane.classList.add('hidden')` — the Control Plane step now stays visible until `initializeProtocols` succeeds. Status text now targets `onboard-cp-status` instead of the hidden `initStatus`.

2. **`handleOnboardingProgress` `error` case**: Added three-tier visibility check:
   - If CLI step is visible → target `cliStatus`
   - If Control Plane step is visible → target `onboard-cp-status`
   - Otherwise → target `initStatus` (fallback)

### Files Changed

| File | Change |
|---|---|
| `src/webview/implementation.html` (lines 5774-5780) | `btn-onboard-cp-inrepo` handler: keep Control Plane step visible, show status in `onboard-cp-status` |
| `src/webview/implementation.html` (lines 5745-5756) | `error` case: three-tier visibility check for error target |

### Validation

- Phase 1: All 6 edits verified in `setup.html` — tab navigation, content split, `tabIdMap`, `tabLoadCallbacks`, persisted state migration, `openControlPlaneSetup` redirect.
- Phase 2 HTML: `onboard-step-control-plane` div at line 1750, form fields, buttons, status div — all match plan spec.
- Phase 2 JS: DOM reference (`onboardStepControlPlane`), Welcome button redirect, three button listeners, `multiRepoScaffoldResult` handler — all present.
- Phase 2 Backend: `scaffoldMultiRepo` case in `TaskViewerProvider.ts` (line 8319), `MultiRepoScaffoldingService` import (line 52) — present and matching `SetupPanelProvider.ts` pattern.
- MAJOR-1 fix applied and verified: `initializeProtocols` errors now visible to user.

### Remaining Risks (post-review)

- Same as pre-review (no new risks introduced by the fix).
- The `initialized` case still sets `initStatus.textContent` on line 5732 (inside the hidden Welcome step). This is harmless — the text is never visible and the real status is shown in `onboard-cp-status`. A future cleanup could remove this dead write.

## Recommendation

**Complexity: 5** → Send to Coder

