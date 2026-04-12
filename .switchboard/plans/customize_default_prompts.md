# Customize Default Prompts

## Goal
Add a "Customize default prompts" section and button beneath the existing **CUSTOM AGENTS** section in the sidebar settings panel. Clicking the button opens a modal (styled like the existing `custom-agent-modal`) where users can configure per-role prompt overrides for all six built-in kanban agent roles: Planner, Lead Coder, Coder, Reviewer, Intern, and Analyst.

Each role supports three override modes:
- **Append** – user text is appended after the generated prompt
- **Prepend** – user text is inserted before the generated prompt
- **Replace** – user text replaces the generated prompt body; the plan list (`PLANS TO PROCESS:`) is always appended automatically so agents still know which plans to process

Overrides persist in `.switchboard/state.json` under `defaultPromptOverrides`.

The modal also shows the **full default prompt** for the selected role in a read-only scrollable panel above the edit fields. This lets users see exactly what they are modifying before touching anything. Previews are generated server-side by calling `buildKanbanBatchPrompt` with a placeholder plan and no overrides, then pushed to the webview when the modal opens.

---

## Metadata
**Tags:** backend, frontend, UI
**Complexity:** 7

---

## Cross-Plan Conflict Analysis

| Plan | Shared File | Risk |
|------|------------|------|
| Notion 2 (setup & fetch) | `TaskViewerProvider.ts` | Adds `notionSetup*` message handlers — **different case blocks, no conflict** |
| Notion 3 (planning tab UI) | `implementation.html` | Adds Planning Tab UI — **different HTML section, no conflict** |
| Linear 2 (setup flow) | `TaskViewerProvider.ts`, `KanbanProvider.ts` | Adds Linear message handlers / factory — **different switch cases/methods, no conflict** |
| Linear 3 (sync on move) | `KanbanProvider.ts` | Adds `_syncPlanToLinear()` in card-move handler — **different code path, no conflict** |
| ClickUp Import | `TaskViewerProvider.ts` | Adds ClickUp import message handlers — **different case blocks, no conflict** |
| ClickUp Push | `KanbanProvider.ts` | Adds ClickUp push on card move — **different code path, no conflict** |

**Verdict:** No conflicts. This plan touches `agentPromptBuilder.ts` and `agentConfig.ts` which no other plan modifies. Changes to `TaskViewerProvider.ts`, `KanbanProvider.ts`, and `implementation.html` are additive (new switch cases, new methods, new HTML sections) in distinct code regions.

---

## Complexity Audit

### Routine
- Adding `DefaultPromptOverride` interface and `parseDefaultPromptOverrides()` to `agentConfig.ts`
- Adding the section label + button in `implementation.html` (mirrors existing custom agents pattern exactly)
- Adding the modal HTML to `implementation.html` including the read-only preview panel
- Adding `getDefaultPromptOverrides` and `saveDefaultPromptOverrides` message handlers in `TaskViewerProvider.ts`
- Adding `getDefaultPromptPreviews` message handler — calls `buildKanbanBatchPrompt` for each role with a single placeholder plan and no overrides, returns all six previews at once
- Wiring JS open/close/save/preview in the webview

### Complex / Risky
- **Modifying `buildKanbanBatchPrompt` in `agentPromptBuilder.ts`** — this function is the canonical prompt source for ALL dispatch paths (autoban, manual advance, copy, ticket view). Changes here affect every prompt emitted by the extension. Must be additive only (opt-in override, zero impact when no override is set).
- **Threading `defaultPromptOverrides` through ALL 21 call sites across two large files.** The plan originally named only 3 wrapper methods, but verified codebase analysis reveals:

  **`TaskViewerProvider.ts`** (14 calls to `buildKanbanBatchPrompt`):
  | Line | Path | Via Wrapper? |
  |------|------|-------------|
  | 1434 | `_buildKanbanBatchPrompt(role, validPlans, instruction)` | ✅ wrapper itself |
  | 1471 | `buildKanbanBatchPrompt('coder', validPlans, {...})` | ❌ direct — pair programming fast-path |
  | 2727 | `buildKanbanBatchPrompt(role, plans, {...})` | ✅ this IS the wrapper body |
  | 6997 | `buildKanbanBatchPrompt(role, [plan], {...})` | ❌ direct — copy prompt |
  | 8570 | `buildKanbanBatchPrompt('lead', [teamPlan])` | ❌ direct — team dispatch (no options!) |
  | 8578 | `buildKanbanBatchPrompt('lead', [teamPlan])` | ❌ direct — team dispatch (no options!) |
  | 8587 | `buildKanbanBatchPrompt('coder', [teamPlan], {...})` | ❌ direct — team dispatch |
  | 8683 | `buildKanbanBatchPrompt('planner', [dispatchPlan], {...})` | ❌ direct — dispatch handler |
  | 8699 | `buildKanbanBatchPrompt('reviewer', [dispatchPlan], {...})` | ❌ direct — dispatch handler |
  | 8726 | `buildKanbanBatchPrompt('lead', [dispatchPlan], {...})` | ❌ direct — dispatch handler |
  | 8737 | `buildKanbanBatchPrompt('coder', [dispatchPlan], {...})` | ❌ direct — dispatch handler |
  | 8744 | `buildKanbanBatchPrompt(role, [dispatchPlan])` | ❌ direct — generic fallback (no options!) |

  **`KanbanProvider.ts`** (7 calls):
  | Line | Path | Via Wrapper? |
  |------|------|-------------|
  | 989 | `_generateBatchPlannerPrompt` → `buildKanbanBatchPrompt('planner', ..., {...})` | ✅ wrapper |
  | 1013 | `_buildCopyPrompt` → `buildKanbanBatchPrompt(role, ..., {...})` | ✅ wrapper |
  | 1029 | `buildKanbanBatchPrompt('coder', ..., {...})` | ❌ direct — pair programming |
  | 1098 | `buildKanbanBatchPrompt('reviewer', ...)` | ❌ direct — no options object |
  | 2879 | `buildKanbanBatchPrompt('lead', plans, {...})` | ❌ direct — autoban pair |
  | 2882 | `buildKanbanBatchPrompt('coder', plans, {...})` | ❌ direct — autoban pair |

  Strategy: update the 3 wrappers first (`_buildKanbanBatchPrompt` in TVP, `_generateBatchPlannerPrompt` and `_buildCopyPrompt` in KP), then update each ❌ direct call to include `defaultPromptOverrides` in its options object. For calls with no existing options (lines 8570, 8578, 8744 in TVP; line 1098 in KP), add `{ defaultPromptOverrides }` as the options argument.

- **Push overrides to webview on sidebar open** — must join the existing burst of `postMessage` calls in `TaskViewerProvider` (around line 3082, alongside `accurateCodingSetting`, `advancedReviewerSetting`, etc.) without causing a race where the webview auto-saves stale data before the override payload arrives. Mitigated by: overrides are only saved on explicit "SAVE ALL OVERRIDES" button click (not auto-saved), matching the custom agents modal pattern.
- **Preview accuracy** — the default prompts shown are generated without toggle options (`accurateCodingEnabled`, `advancedReviewerEnabled`, etc.) because those are additive behaviours layered on top. The preview panel must include a small notice: *"Preview shows the base prompt structure. Toggle options (accuracy mode, advanced reviewer, etc.) are applied at dispatch time on top of any override."* This manages expectation without requiring full option state sync into the preview.
- **Intern and Analyst roles produce generic prompts** — `buildKanbanBatchPrompt` has no explicit `if (role === 'intern')` or `if (role === 'analyst')` branch; they fall through to the generic handler ("Please process the following N plans."). The preview for these roles will show this barebones text. Overrides still apply correctly (the `applyPromptOverride` helper runs on whatever text the function returns). The preview disclaimer already covers this, but it may surprise users who expect a rich default prompt for all roles.

---

## Implementation Steps

### Step 1 — Data model: `src/services/agentConfig.ts`

Add a `DefaultPromptOverride` interface and `parseDefaultPromptOverrides` utility:

```ts
export type PromptOverrideMode = 'append' | 'prepend' | 'replace';

export interface DefaultPromptOverride {
    mode: PromptOverrideMode;
    text: string;
}

/**
 * Parses the `defaultPromptOverrides` field from state.json.
 * Returns a record keyed by BuiltInAgentRole.
 * Invalid or empty entries are omitted so callers can check truthiness.
 */
export function parseDefaultPromptOverrides(
    raw: unknown
): Partial<Record<BuiltInAgentRole, DefaultPromptOverride>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: Partial<Record<BuiltInAgentRole, DefaultPromptOverride>> = {};
    const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'intern', 'analyst'];
    const VALID_MODES: PromptOverrideMode[] = ['append', 'prepend', 'replace'];
    for (const role of VALID_ROLES) {
        const entry = (raw as Record<string, unknown>)[role];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const src = entry as Record<string, unknown>;
        const mode = String(src.mode || '');
        const text = String(src.text || '').trim();
        if (!VALID_MODES.includes(mode as PromptOverrideMode) || !text) continue;
        result[role] = { mode: mode as PromptOverrideMode, text };
    }
    return result;
}
```

Also export the existing `BUILT_IN_AGENT_LABELS` constant (line 25 of `agentConfig.ts`) which already contains identical role→label mappings. **Do NOT create a duplicate constant.** Change:

```ts
// BEFORE (line 25 — currently not exported):
const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    planner: 'Planner',
    analyst: 'Analyst'
};

// AFTER (add export keyword):
export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    planner: 'Planner',
    analyst: 'Analyst'
};
```

> **Clarification:** The webview JS uses its own `PROMPT_ROLES` local array for tab labels (see Step 4c). The server-side code can import `BUILT_IN_AGENT_LABELS` wherever needed. No new constant required.

---

### Step 2 — Prompt builder: `src/services/agentPromptBuilder.ts`

Add `defaultPromptOverrides` to `PromptBuilderOptions`:

```ts
/** Per-role prompt customisations loaded from state.json. */
defaultPromptOverrides?: Partial<Record<string, DefaultPromptOverride>>;
```

At the **very end** of `buildKanbanBatchPrompt`, before the `return` statement for each role branch, apply the override. Introduce a helper at the top of the file:

```ts
function applyPromptOverride(
    generated: string,
    planList: string,
    override: DefaultPromptOverride | undefined
): string {
    if (!override || !override.text) return generated;
    switch (override.mode) {
        case 'prepend':
            return `${override.text}\n\n${generated}`;
        case 'append':
            return `${generated}\n\n${override.text}`;
        case 'replace':
            // Always keep the plan list so agents know what to process.
            return `${override.text}\n\nPLANS TO PROCESS:\n${planList}`;
        default:
            return generated;
    }
}
```

Call `applyPromptOverride(prompt, planList, options?.defaultPromptOverrides?.[role])` on each role's return value.

The `planList` variable is already computed early in the function body and is in scope for all branches — no restructuring needed.

---

### Step 3 — Provider: read/write overrides in `TaskViewerProvider.ts`

**Read helper** (private method):
```ts
private async _getDefaultPromptOverrides(
    workspaceRoot?: string
): Promise<Partial<Record<string, DefaultPromptOverride>>> {
    const resolved = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolved) return {};
    try {
        const statePath = path.join(resolved, '.switchboard', 'state.json');
        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        return parseDefaultPromptOverrides(state.defaultPromptOverrides);
    } catch { return {}; }
}
```

**Message handlers** — add to the existing `switch` in `_handleMessage`:

```ts
case 'getDefaultPromptOverrides': {
    const overrides = await this._getDefaultPromptOverrides();
    this._view?.webview.postMessage({ type: 'defaultPromptOverrides', overrides });
    break;
}
case 'saveDefaultPromptOverrides': {
    if (data.overrides && typeof data.overrides === 'object') {
        await this.updateState((state: any) => {
            state.defaultPromptOverrides = data.overrides;
        });
    }
    this._view?.webview.postMessage({ type: 'saveDefaultPromptOverridesResult', success: true });
    break;
}
```

**Push overrides on sidebar load** — in the same block where `accurateCodingSetting` and similar settings are pushed to the webview (around line 3082), add:
```ts
const overrides = await this._getDefaultPromptOverrides();
this._view?.webview.postMessage({ type: 'defaultPromptOverrides', overrides });
```

**Preview handler** — add a `getDefaultPromptPreviews` case to `_handleMessage`. Use a single placeholder plan so the prompt structure is realistic but contains no real data:

```ts
case 'getDefaultPromptPreviews': {
    const ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'intern', 'analyst'];
    const placeholder: BatchPromptPlan = {
        topic: '[your selected plans]',
        absolutePath: '/path/to/plan.md',
    };
    const previews: Record<string, string> = {};
    for (const role of ROLES) {
        previews[role] = buildKanbanBatchPrompt(role, [placeholder]);
    }
    this._view?.webview.postMessage({ type: 'defaultPromptPreviews', previews });
    break;
}
```

Import `BuiltInAgentRole` and `BatchPromptPlan` at the top of the file — both are already available from existing imports.

**Thread overrides into prompt builder calls** — update `_buildKanbanBatchPrompt()` (line 2716) to load and pass overrides:
```ts
private _buildKanbanBatchPrompt(
    role: string,
    plans: Array<{ topic: string; absolutePath: string; dependencies?: string }>,
    instruction?: string
): string {
    const { includeInlineChallenge } = this._getPromptInstructionOptions(role, instruction);
    const accurateCodingEnabled = this._isAccurateCodingEnabled();
    const pairProgrammingEnabled = this._autobanState.pairProgrammingMode !== 'off';
    const aggressivePairProgramming = this._isAggressivePairProgrammingEnabled();
    const advancedReviewerEnabled = this._isAdvancedReviewerEnabled();
    const designDocLink = this._isDesignDocEnabled() ? this._getDesignDocLink() : undefined;
    return buildKanbanBatchPrompt(role, plans, {
        instruction,
        includeInlineChallenge,
        accurateCodingEnabled,
        pairProgrammingEnabled,
        aggressivePairProgramming,
        advancedReviewerEnabled,
        designDocLink,
        defaultPromptOverrides: this._cachedDefaultPromptOverrides  // ← NEW
    });
}
```

> **Clarification:** To avoid an async call on every dispatch, cache overrides in an instance field `_cachedDefaultPromptOverrides` that is populated once at sidebar-ready time (alongside the postMessage push) and refreshed when the user saves. Pattern:
> ```ts
> private _cachedDefaultPromptOverrides: Partial<Record<string, DefaultPromptOverride>> = {};
> ```
> Populate in the `'ready'` handler: `this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides();`
> Refresh in the `'saveDefaultPromptOverrides'` handler after writing state.json.

**Update ALL direct call sites in TaskViewerProvider.ts** — for each ❌ direct call site listed in the Complexity Audit, add `defaultPromptOverrides: this._cachedDefaultPromptOverrides` to the options:

| Line | Current | Change |
|------|---------|--------|
| 1471 | `buildKanbanBatchPrompt('coder', validPlans, {...})` | Add `defaultPromptOverrides: this._cachedDefaultPromptOverrides` to options |
| 6997 | `buildKanbanBatchPrompt(role, [plan], {...})` | Add `defaultPromptOverrides: this._cachedDefaultPromptOverrides` to options |
| 8570 | `buildKanbanBatchPrompt('lead', [teamPlan])` | Add 3rd arg: `{ defaultPromptOverrides: this._cachedDefaultPromptOverrides }` |
| 8578 | `buildKanbanBatchPrompt('lead', [teamPlan])` | Add 3rd arg: `{ defaultPromptOverrides: this._cachedDefaultPromptOverrides }` |
| 8587 | `buildKanbanBatchPrompt('coder', [teamPlan], {...})` | Add `defaultPromptOverrides: this._cachedDefaultPromptOverrides` to options |
| 8683 | `buildKanbanBatchPrompt('planner', [dispatchPlan], {...})` | Add to options |
| 8699 | `buildKanbanBatchPrompt('reviewer', [dispatchPlan], {...})` | Add to options |
| 8726 | `buildKanbanBatchPrompt('lead', [dispatchPlan], {...})` | Add to options |
| 8737 | `buildKanbanBatchPrompt('coder', [dispatchPlan], {...})` | Add to options |
| 8744 | `buildKanbanBatchPrompt(role, [dispatchPlan])` | Add 3rd arg: `{ defaultPromptOverrides: this._cachedDefaultPromptOverrides }` |

---

### Step 4 — WebView UI: `src/webview/implementation.html`

**4a. Section label + button** — add immediately after the `btn-add-custom-agent` button (line ~1680):

```html
<div
    style="font-size: 10px; color: var(--text-secondary); margin: 14px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
    DEFAULT PROMPT OVERRIDES</div>
<div id="default-prompt-override-summary" style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono); margin-bottom:4px; min-height:14px;"></div>
<button id="btn-customize-default-prompts" class="secondary-btn w-full">CUSTOMIZE DEFAULT PROMPTS</button>
```

The `#default-prompt-override-summary` div shows a count of active overrides (e.g. "3 roles customised") so users know at a glance that overrides are set.

**4b. Modal** — add a new `custom-prompts-modal` overlay below the existing `custom-agent-modal`:

```html
<div id="custom-prompts-modal" class="modal-overlay hidden">
    <div class="modal-card" style="max-width: 560px;">
        <div class="modal-title">CUSTOMIZE DEFAULT PROMPTS</div>
        <div style="font-size:10px; color:var(--text-secondary); margin-bottom:10px; line-height:1.5;">
            Override the prompt sent to each built-in agent role. Changes apply to all dispatch paths
            (manual advance, copy prompt, and autoban).
        </div>

        <!-- Role selector tabs -->
        <div id="prompt-role-tabs" style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom:10px;"></div>

        <!-- Default prompt preview -->
        <details id="prompt-preview-details" style="margin-bottom:10px;">
            <summary style="font-size:10px; font-family:var(--font-mono); letter-spacing:1px; cursor:pointer; color:var(--text-secondary); user-select:none;">
                DEFAULT PROMPT PREVIEW (read only)
            </summary>
            <div style="font-size:9px; color:var(--text-secondary); margin:4px 0 6px; line-height:1.4;">
                Base prompt structure only. Toggle options (accuracy mode, advanced reviewer, etc.) are applied at dispatch time on top of any override.
            </div>
            <textarea id="prompt-preview-text" class="modal-textarea" rows="10" readonly
                style="font-family:var(--font-mono); font-size:10px; opacity:0.7; cursor:default; resize:vertical;"
                placeholder="Loading preview..."></textarea>
        </details>

        <!-- Edit area (populated by JS when a tab is selected) -->
        <label class="modal-label" for="prompt-override-mode">Mode</label>
        <select id="prompt-override-mode" class="modal-input">
            <option value="append">Append — add after generated prompt</option>
            <option value="prepend">Prepend — insert before generated prompt</option>
            <option value="replace">Replace — replace prompt body (plan list always appended)</option>
        </select>
        <label class="modal-label" for="prompt-override-text">Custom instructions</label>
        <textarea id="prompt-override-text" class="modal-textarea" rows="8"
            placeholder="Enter custom instructions for this role..."></textarea>
        <div style="display:flex; align-items:center; gap:6px; margin-top:6px;">
            <button id="btn-clear-prompt-override" class="secondary-btn" style="width:auto;">CLEAR OVERRIDE</button>
            <span style="flex:1;"></span>
        </div>

        <div class="flex gap-2" style="margin-top:10px;">
            <button id="btn-save-prompt-overrides" class="action-btn w-full">SAVE ALL OVERRIDES</button>
            <button id="btn-cancel-prompt-overrides" class="secondary-btn w-full">CANCEL</button>
        </div>
    </div>
</div>
```

**4c. JavaScript** — add the following logic in the `<script>` block:

```js
// ---- Default Prompt Overrides ----
const PROMPT_ROLES = [
    { key: 'planner', label: 'Planner' },
    { key: 'lead',    label: 'Lead Coder' },
    { key: 'coder',   label: 'Coder' },
    { key: 'reviewer',label: 'Reviewer' },
    { key: 'intern',  label: 'Intern' },
    { key: 'analyst', label: 'Analyst' },
];

let lastPromptOverrides = {}; // { role: { mode, text } }
let editingPromptRole = PROMPT_ROLES[0].key;

const customPromptsModal = document.getElementById('custom-prompts-modal');
const promptRoleTabs     = document.getElementById('prompt-role-tabs');
const promptOverrideMode = document.getElementById('prompt-override-mode');
const promptOverrideText = document.getElementById('prompt-override-text');
const promptOverrideSummary = document.getElementById('default-prompt-override-summary');

function renderPromptRoleTabs() {
    promptRoleTabs.innerHTML = '';
    PROMPT_ROLES.forEach(({ key, label }) => {
        const btn = document.createElement('button');
        const isActive = key === editingPromptRole;
        const hasOverride = !!(lastPromptOverrides[key]?.text);
        btn.className = isActive ? 'action-btn' : 'secondary-btn';
        btn.style.cssText = 'width:auto; min-width:60px; font-size:10px; padding:3px 8px;';
        btn.textContent = hasOverride ? `${label} ●` : label;
        btn.onclick = () => { saveCurrentRoleDraft(); editingPromptRole = key; loadCurrentRoleIntoForm(); loadPreviewForCurrentRole(); renderPromptRoleTabs(); };
        promptRoleTabs.appendChild(btn);
    });
}

function saveCurrentRoleDraft() {
    const text = promptOverrideText.value.trim();
    const mode = promptOverrideMode.value;
    if (text) {
        lastPromptOverrides[editingPromptRole] = { mode, text };
    } else {
        delete lastPromptOverrides[editingPromptRole];
    }
}

function loadCurrentRoleIntoForm() {
    const override = lastPromptOverrides[editingPromptRole];
    promptOverrideMode.value = override?.mode || 'append';
    promptOverrideText.value = override?.text || '';
}

function updatePromptOverrideSummary() {
    const count = Object.values(lastPromptOverrides).filter(o => o?.text).length;
    promptOverrideSummary.textContent = count > 0 ? `${count} role${count > 1 ? 's' : ''} customised` : '';
}

let lastPromptPreviews = {}; // { role: defaultPromptText }
const promptPreviewText = document.getElementById('prompt-preview-text');

function loadPreviewForCurrentRole() {
    if (!promptPreviewText) return;
    promptPreviewText.value = lastPromptPreviews[editingPromptRole] || 'Loading preview...';
}

function openCustomPromptsModal() {
    editingPromptRole = PROMPT_ROLES[0].key;
    loadCurrentRoleIntoForm();
    renderPromptRoleTabs();
    loadPreviewForCurrentRole();
    customPromptsModal.classList.remove('hidden');
    // Request previews from provider (may already be cached from a prior open)
    if (Object.keys(lastPromptPreviews).length === 0) {
        vscode.postMessage({ type: 'getDefaultPromptPreviews' });
    }
}

function closeCustomPromptsModal() {
    customPromptsModal.classList.add('hidden');
}

document.getElementById('btn-customize-default-prompts')?.addEventListener('click', openCustomPromptsModal);
document.getElementById('btn-cancel-prompt-overrides')?.addEventListener('click', closeCustomPromptsModal);
customPromptsModal.addEventListener('click', (e) => { if (e.target === customPromptsModal) closeCustomPromptsModal(); });

document.getElementById('btn-clear-prompt-override')?.addEventListener('click', () => {
    promptOverrideText.value = '';
    delete lastPromptOverrides[editingPromptRole];
    renderPromptRoleTabs();
});

document.getElementById('btn-save-prompt-overrides')?.addEventListener('click', () => {
    saveCurrentRoleDraft();
    vscode.postMessage({ type: 'saveDefaultPromptOverrides', overrides: lastPromptOverrides });
    updatePromptOverrideSummary();
    closeCustomPromptsModal();
});

// Handle incoming messages
// In the existing window.addEventListener('message', ...) block, add:
//
// case 'defaultPromptOverrides':
//     lastPromptOverrides = msg.overrides || {};
//     updatePromptOverrideSummary();
//     break;
//
// case 'defaultPromptPreviews':
//     lastPromptPreviews = msg.previews || {};
//     loadPreviewForCurrentRole(); // update if modal is open
//     break;
```

Wire the `defaultPromptOverrides` message type into the existing `window.addEventListener('message', ...)` handler that processes all incoming `vscode.postMessage` calls.

Also add `Escape` key handling: extend the existing `document.addEventListener('keydown', ...)` to call `closeCustomPromptsModal()`.

---

### Step 5 — KanbanProvider integration

In `KanbanProvider.ts`, add a private helper analogous to `_getCustomAgents`:

```ts
private async _getDefaultPromptOverrides(
    workspaceRoot: string
): Promise<Partial<Record<string, import('./agentConfig').DefaultPromptOverride>>> {
    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
    try {
        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        return parseDefaultPromptOverrides(state.defaultPromptOverrides);
    } catch { return {}; }
}
```

> **Clarification:** Removed `fs.existsSync()` — it was a synchronous call on the extension host thread. The `try/catch` around `fs.promises.readFile` already handles missing files (throws `ENOENT`, caught and returns `{}`). This matches the `TaskViewerProvider` version.

**Update ALL call sites in KanbanProvider.ts:**

| Line | Method / Call | Change |
|------|-------------|--------|
| 989 | `_generateBatchPlannerPrompt` → `buildKanbanBatchPrompt('planner', ..., {...})` | Add `defaultPromptOverrides` to the options object. Since this method already takes `workspaceRoot`, call `await this._getDefaultPromptOverrides(workspaceRoot)` at the top and pass it through. |
| 1013 | `_buildCopyPrompt` → `buildKanbanBatchPrompt(role, ..., {...})` | Same pattern — load overrides and add to options |
| 1029 | `buildKanbanBatchPrompt('coder', ..., {...})` | Add `defaultPromptOverrides` to existing options |
| 1098 | `buildKanbanBatchPrompt('reviewer', ...)` | Currently passes no options — add 3rd arg: `{ defaultPromptOverrides }` |
| 2879 | `buildKanbanBatchPrompt('lead', plans, {...})` | Add `defaultPromptOverrides` to existing options |
| 2882 | `buildKanbanBatchPrompt('coder', plans, {...})` | Add `defaultPromptOverrides` to existing options |

> **Clarification:** For the autoban paths (lines 2879, 2882), the `_runAutobanCycle` method already has `resolvedWorkspaceRoot` in scope. Call `const defaultPromptOverrides = await this._getDefaultPromptOverrides(resolvedWorkspaceRoot);` once before the prompt-building block to avoid redundant reads.

Import `parseDefaultPromptOverrides` at the top of the file alongside the existing `agentConfig` imports:
```ts
import { parseDefaultPromptOverrides } from './agentConfig';
```

---

## Edge-Case & Dependency Audit

- **Empty override text**: `parseDefaultPromptOverrides()` skips entries with empty `.text` after trim. `applyPromptOverride()` also checks `!override.text` and returns unmodified prompt. Double-safe. ✅
- **Invalid mode value**: `parseDefaultPromptOverrides()` validates against `VALID_MODES` array. Unknown modes are rejected at parse time. `applyPromptOverride()` has a `default:` branch returning unmodified prompt. Double-safe. ✅
- **Concurrent `state.json` writes**: `updateState()` in TaskViewerProvider uses read-modify-write on `state.json`. If two features write simultaneously (e.g. user saves prompt overrides while autoban writes state), last-write-wins. Acceptable: this follows the same pattern used by all other state.json writers (custom agents, settings toggles). No new risk introduced.
- **Large override text**: No size limit on `textarea` input. A user could paste a massive block. `parseDefaultPromptOverrides()` does `String(src.text)` without truncation. The prompt sent to the agent could become very large. **Mitigation:** acceptable risk — the agent's context window is the natural bound. Could add a soft warning in a future iteration if needed.
- **Webview lifecycle**: If the sidebar is hidden and re-shown, the `'ready'` message fires again, re-pushing overrides. This is correct — it ensures the webview always has fresh state.
- **KanbanProvider has no webview interaction**: Overrides in KP are read directly from `state.json` on every prompt build. No push/pull race possible.
- **Intern/Analyst generic fallback**: These roles produce a minimal prompt from `buildKanbanBatchPrompt`'s generic branch. Overrides still apply (the helper runs on the return value), but the "replace" mode preview will show a very short base prompt. Users may be confused. The disclaimer notice is the mitigation.

## Regression Checklist
- [ ] With no overrides set, all prompts are byte-for-byte identical to pre-change output
- [ ] Append mode adds text after the last line; does not duplicate the plan list
- [ ] Replace mode still includes `PLANS TO PROCESS:` at the end
- [ ] Prepend mode inserts before the role-specific intro, not before the plan list
- [ ] Saving overrides persists to `state.json`; reopening the modal shows saved values
- [ ] Clearing an override removes it from state and removes the `●` indicator from the tab
- [ ] Existing `accurateCodingEnabled`, `advancedReviewerEnabled`, etc. options still work independently of overrides
- [ ] Autoban dispatch paths in `KanbanProvider` respect overrides
- [ ] Summary line on the button updates after saving
- [ ] ESC key closes the modal
- [ ] Preview panel shows correct default prompt for each role when switching tabs
- [ ] Preview loads on first modal open even when `lastPromptPreviews` is empty (shows "Loading preview..." then populates on `defaultPromptPreviews` message)
- [ ] Preview panel is read-only — user cannot type into it
- [ ] Preview notice text is visible and accurate

## Files to Touch
- `src/services/agentConfig.ts` — data model + export `BUILT_IN_AGENT_LABELS`
- `src/services/agentPromptBuilder.ts` — override application
- `src/services/TaskViewerProvider.ts` — message handlers, read/write, push on load, thread overrides through 12 direct call sites
- `src/services/KanbanProvider.ts` — helper + thread overrides through 6 call sites (2 wrappers + 4 direct)
- `src/webview/implementation.html` — UI section, modal, JS

---

## Adversarial Synthesis

### 🔥 Grumpy Principal Engineer Critique

> Oh, wonderful. Let me count the ways this plan would've sent a coder on a scavenger hunt.
>
> **1. "Thread through `_buildAgentBatchPrompt()`"** — a method that DOESN'T EXIST. The actual name is `_buildKanbanBatchPrompt` (line 2716). Were we writing this plan from memory? In a fever dream? The coder would grep for `_buildAgentBatchPrompt`, find zero results, and spend 30 minutes wondering if they're in the wrong branch.
>
> **2. "Thread through all call sites" — then names THREE out of TWENTY-ONE.** The dispatch handler alone (lines 8679-8744) has SIX separate `buildKanbanBatchPrompt` calls, NONE of which go through any wrapper. The autoban pair-programming paths (lines 2879-2882 in KP) are direct calls too. If the coder only touched the 3 named methods, overrides would be silently ignored for: pair-programming dispatch, team dispatch, copy-to-clipboard single-card, and the generic fallback. That's more than half the user-facing paths. Half. Of. The. Paths.
>
> **3. `BUILT_IN_ROLE_LABELS` — a brand new constant that duplicates `BUILT_IN_AGENT_LABELS`** (line 25 of `agentConfig.ts`). Same keys, same values, different name. Now we have two sources of truth for role display names. When someone renames "Lead Coder" to "Senior Engineer", they'll update one, ship it, and discover the other three sprints later when a user files a bug about mismatched labels.
>
> **4. `fs.existsSync()` on the extension host thread.** The KanbanProvider helper does a synchronous file existence check before an async read. Every. Single. Prompt. Build. On. The. Main. Thread. The `try/catch` around `readFile` already handles ENOENT. This is a blocking I/O call with zero purpose.
>
> **5. Intern and Analyst get a three-line generic prompt, and the plan says "all six roles supported."** Technically true — the override applies to whatever text the function returns. But the preview panel will show "Please process the following 1 plans." for these roles, and users will think the feature is broken. The disclaimer notice helps, but the plan should at least call this out explicitly.
>
> **6. No cross-plan conflict analysis.** Five other plans modify `TaskViewerProvider.ts` and `KanbanProvider.ts`. The changes are additive and non-conflicting, but the plan doesn't bother to verify that. "Trust me" is not an engineering strategy.

### ⚖️ Balanced Response

All six issues have been addressed in this revision:

1. **Method name corrected**: `_buildAgentBatchPrompt` → `_buildKanbanBatchPrompt` (line 2716). Exact line number included.
2. **All 21 call sites enumerated**: Full tables in both the Complexity Audit and Steps 3/5, with line numbers, wrapper status, and exact change instructions for each. Strategy: update 3 wrappers + 18 direct calls.
3. **`BUILT_IN_ROLE_LABELS` eliminated**: Plan now exports the existing `BUILT_IN_AGENT_LABELS` (add `export` keyword) instead of creating a duplicate. Webview JS uses its own `PROMPT_ROLES` array — no new server-side constant needed.
4. **`fs.existsSync` removed**: KP helper now relies on `try/catch` around `fs.promises.readFile` — the `ENOENT` error is caught and returns `{}`. No synchronous I/O.
5. **Intern/Analyst generic fallback documented**: Explicitly noted in Complex/Risky and Edge-Case sections. The preview disclaimer covers user expectations.
6. **Cross-plan conflict analysis added**: All 6 overlapping plans verified — changes are in distinct code regions (different switch cases, different methods, different HTML sections).

Additionally:
- **Caching strategy added** for TVP: `_cachedDefaultPromptOverrides` instance field avoids async reads on every dispatch. Populated at sidebar-ready, refreshed on save.
- **Edge-Case & Dependency Audit** section added covering concurrent writes, large text, webview lifecycle, and generic role fallback.

---

## Recommended Agent

**Send to Lead Coder** (Complexity 7 — multi-file changes across 5 files with 21 call sites to thread, new UI modal, new data model, cache invalidation pattern)

---

## Review (Adversarial + Balanced)

**Reviewer:** Copilot (Claude Opus 4.6)
**Mode:** Light (findings in chat, fixes applied directly)

### Stage 1 — Grumpy Principal Engineer

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | Plan's JS code uses `btn.onclick` (Step 4c) but implementation correctly uses `addEventListener` — code is better than spec (CSP compliant) |
| 2 | NIT | Preview cache (`lastPromptPreviews`) never invalidated after toggle changes (accuracy mode, etc.) — covered by disclaimer notice, cosmetic only |
| 3 | NIT | `_currentWorkspaceRoot` (`string \| null`) passed to KP `_getDefaultPromptOverrides(string)` at line 2896 — guarded by early break at line 2882, runtime safe |
| 4 | NIT | `saveDefaultPromptOverridesResult` message handler is a no-op — save feedback comes from modal close; no error path exists server-side anyway |

### Stage 2 — Balanced Synthesis

**Implemented Well:**
- Data model: `DefaultPromptOverride`, `PromptOverrideMode`, `parseDefaultPromptOverrides()` with validation. `BUILT_IN_AGENT_LABELS` exported, not duplicated.
- Prompt builder: `applyPromptOverride()` helper correctly handles prepend/append/replace. Override applied at every role branch return.
- TVP: `_cachedDefaultPromptOverrides` field, populated at ready, refreshed on save. All 3 message handlers present. Overrides pushed to webview on sidebar load. All 12 direct call sites threaded.
- Webview: Section label, button, modal with role tabs, collapsible preview panel, mode select, textarea, clear/save/cancel buttons. ESC key + backdrop click close. `addEventListener` throughout (CSP compliant). Message handlers for `defaultPromptOverrides` and `defaultPromptPreviews`.
- KanbanProvider: `_getDefaultPromptOverrides()` (no `fs.existsSync`), `parseDefaultPromptOverrides` imported. All 6 call sites threaded including autoban paths.

**Fixes Applied:** None — no CRITICAL or MAJOR findings

### Validation Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Pass (pre-existing ArchiveManager error only) |
| `npm run compile` | ✅ Pass (webpack compiled successfully) |
| `agentConfig.ts` — types + parser | ✅ Present: lines 147-176 |
| `agentPromptBuilder.ts` — override helper + options field | ✅ Present: lines 35, 38-53, 99, 177, 194, 236, 257, 260 |
| `TaskViewerProvider.ts` — cache + handlers + all 12 call sites | ✅ Present: 166, 1475, 2737, 3121-3122, 3517-3543, 7052, 8618-8795 |
| `KanbanProvider.ts` — helper + import + all 6 call sites | ✅ Present: 7, 977-986, 1000-1005, 1026-1031, 1044-1048, 1115-1116, 2896-2902 |
| `implementation.html` — section + modal + JS + message handlers | ✅ Present: 1681-1685, 1869-1913, 2200-2292, 2937-2946 |

### Remaining Risks
- Preview cache not invalidated after toggle changes — acceptable, covered by disclaimer
- Large override text has no size limit — natural bound is agent context window
- Concurrent `state.json` writes (last-write-wins) — same pattern as all other state writers

### Verdict: ✅ READY
