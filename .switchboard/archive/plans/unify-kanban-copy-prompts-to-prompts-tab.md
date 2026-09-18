# Unify Kanban Copy Prompt Buttons to Use Prompts Tab

## Goal
Route the `copyGatherPrompt`, `copyExecutePrompt`, and `chatCopyPrompt` kanban card buttons through the prompts tab configuration system so that every prompt built by Switchboard respects user-defined overrides — no exceptions.

## Metadata
- **Tags:** frontend, backend, UI, UX
- **Complexity:** 5

## User Review Required
> [!IMPORTANT]
> The plan introduces two new settings keys (`switchboard.prompts.relay` and `switchboard.prompts.chatPromptOverride`) stored via `_saveSetting`/`_getSetting`. Confirm this is the preferred persistence mechanism (workspaceState) rather than VS Code `settings.json`. The rest of the plan assumes workspaceState.

> [!NOTE]
> The relay prompt overrides are intentionally stored **separately** from existing role configs (`roleConfig_analyst`, etc.). The CONTEXT GATHERER column maps to role `'gatherer'` which is not a `buildKanbanBatchPrompt` role — conflating it with `analystConfig` (as the original plan proposed) would be incorrect.

## Complexity Audit

### Routine
- Adding optional fields to `RelayConfig` interface (additive, no breaking change)
- Reading a new setting key in `_getPromptsConfig` or directly in the handlers
- Updating `_generateRelayPrompt` to pass override fields through to the service
- `chatCopyPrompt` handler change is a 2-line substitution
- UI textarea elements follow the exact same pattern as existing role config textareas

### Complex / Risky
- UI save/load lifecycle for new relay and chat override textareas must hook into the existing `roleConfigs` persistence pattern without breaking existing save events — requires careful inspection of how `saveSettings` and `getSetting` responses flow in the frontend
- Plan-variable injection: the `chatCopyPrompt` handler appends `planSection` dynamically; the custom prompt must preserve this append convention (no template interpolation needed — just concatenation)

## Edge-Case & Dependency Audit

**Race Conditions**
- None — all prompt generation is synchronous or awaited serially within its `case` block.

**Security**
- Custom prompt text is stored in VS Code workspaceState (not transmitted externally). No sanitization required beyond what the textarea naturally provides.

**Side Effects**
- If a user sets a gather/execute prompt override, the relay prompt is fully replaced — the default `RelayPromptService` template is bypassed. This is intentional (the user opted in), but must be documented in the UI label.

**Dependencies & Conflicts**
- `RelayConfig` is defined in `RelayPromptService.ts` and imported in `KanbanProvider.ts`. Any field additions to the interface affect both files simultaneously.
- `copyExecutePrompt` (line 5921) shares `_generateRelayPrompt` with `copyGatherPrompt` (line 5906) — both must benefit from the override passthrough.
- The prompts tab JS `DEFAULT_CONFIG` object (around line 2422 of `kanban.html`) does **not** need a new role entry for relay or chat — these are stored as flat settings, not role configs.

## Dependencies
- None identified from active plan list.

## Adversarial Synthesis
The original plan incorrectly tied relay prompt overrides to `analystConfig` (a misidentified role — CONTEXT GATHERER maps to `'gatherer'`, not analyst), and proposed a `roleConfig_chat` role that would require deep integration throughout the role-config subsystem. The revised approach uses two lightweight flat settings keys (`relay` and `chatPromptOverride`) that avoid the role-config lifecycle entirely, reducing scope from ~7 touch points to ~4. Key risk: the UI save/load for two new textarea inputs must correctly hook into the existing `saveSettings` event without interfering with role config persistence. Mitigation: keep the relay and chat UI as a separate subsection with its own explicit `postKanbanMessage({ type: 'saveSetting' })` calls, isolated from the role-selector-driven save path.

## Proposed Changes

---

### RelayPromptService.ts
**File:** [`src/services/RelayPromptService.ts`](src/services/RelayPromptService.ts)

#### Context
`RelayConfig` (lines 5–10) has four fields. `generateGatherPrompt` (line 21) and `generateExecutePrompt` (line 75) are fully hardcoded templates. No override path exists.

#### Logic
Add two optional override fields to `RelayConfig`. When set, the method returns the override directly without executing the template. This is an opt-in bypass — the default behaviour is unchanged.

#### Implementation

**Lines 5–10 — Extend `RelayConfig` interface:**
```typescript
export interface RelayConfig {
    planPath: string;
    planContent: string;
    estimatedComplexity: number;
    dependencies: string[];
    // Optional: user-defined overrides from prompts tab
    customGatherPrompt?: string;
    customExecutePrompt?: string;
}
```

**Line 21 — `generateGatherPrompt` early-return:**
```typescript
generateGatherPrompt(config: RelayConfig): string {
    if (config.customGatherPrompt && config.customGatherPrompt.trim()) {
        return config.customGatherPrompt;
    }
    // ... rest of existing template unchanged
```

**Line 75 — `generateExecutePrompt` early-return:**
```typescript
generateExecutePrompt(config: RelayConfig): string {
    if (config.customExecutePrompt && config.customExecutePrompt.trim()) {
        return config.customExecutePrompt;
    }
    // ... rest of existing template unchanged
```

#### Edge Cases
- Empty string override must fall through to the default template (guard: `&& config.customGatherPrompt.trim()`).

---

### KanbanProvider.ts — `_generateRelayPrompt` (line 381)
**File:** [`src/services/KanbanProvider.ts`](src/services/KanbanProvider.ts)

#### Context
`_generateRelayPrompt` (lines 381–427) builds a `RelayConfig` at lines 411–416 and passes it to the service. It does not currently read any prompts tab settings.

#### Logic
Read the relay override settings directly via `this._getSetting` inside `_generateRelayPrompt`. Pass the values as optional fields on `RelayConfig`.

#### Implementation

**Lines 411–416 — Extend `relayConfig` construction:**
```typescript
// NEW: Read relay prompt overrides from prompts tab
const customGatherPrompt: string | undefined = this._getSetting('switchboard.prompts.relay_gatherPrompt', undefined) || undefined;
const customExecutePrompt: string | undefined = this._getSetting('switchboard.prompts.relay_executePrompt', undefined) || undefined;

const relayConfig: RelayConfig = {
    planPath: planFileAbsolute,
    planContent,
    estimatedComplexity,
    dependencies,
    customGatherPrompt,
    customExecutePrompt,
};
```

(Replace lines 411–416, keeping the rest of the method unchanged.)

#### Edge Cases
- If `_getSetting` returns `null` or `''`, the `|| undefined` coercion ensures the override field is `undefined`, falling through to the default template.

---

### KanbanProvider.ts — `chatCopyPrompt` handler (line 5000)
**File:** [`src/services/KanbanProvider.ts`](src/services/KanbanProvider.ts)

#### Context
The `chatCopyPrompt` case (lines 5000–5027) hardcodes the base prompt string at line 5020:
```typescript
const prompt = `/chat\n\nPlease enter the chat workflow defined at: ${chatWorkflowPath}\n\nWe will be discussing plans and requirements.${planSection}`;
```

#### Logic
Replace the hardcoded base with a user-defined override from settings. If no override exists, fall back to the current hardcoded string. Append `planSection` after the base in both cases (preserving existing convention).

#### Implementation

**Lines 5000–5027 — Replace handler body:**
```typescript
case 'chatCopyPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }

    // Read chat prompt override from prompts tab settings
    const chatPromptOverride: string = this._getSetting('switchboard.prompts.chatPromptOverride', '') || '';
    const chatWorkflowPath = '.agent/workflows/chat.md';
    const chatBase = chatPromptOverride.trim()
        ? chatPromptOverride.trim()
        : `/chat\n\nPlease enter the chat workflow defined at: ${chatWorkflowPath}\n\nWe will be discussing plans and requirements.`;

    let planSection = '';
    if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
        const selectedCards = this._lastCards.filter(card =>
            card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
        );
        if (selectedCards.length > 0) {
            const planLines = selectedCards.map(card => {
                const absPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
                return `- [${card.topic}] Plan File: ${absPath}`;
            }).join('\n');
            planSection = `\n\n## Plans to Discuss\n${planLines}\n\nPlease read each plan file above before starting the discussion.`;
        }
    }

    const prompt = `${chatBase}${planSection}`;
    await vscode.env.clipboard.writeText(prompt);
    const count = Array.isArray(msg.sessionIds) ? msg.sessionIds.length : 0;
    const planWord = count > 0 ? ` for ${count} plan(s)` : '';
    vscode.window.showInformationMessage(`Chat prompt copied to clipboard${planWord}.`);
    break;
}
```

#### Edge Cases
- If the override is set to whitespace-only, `trim()` check prevents an empty base.
- `planSection` is always appended after the base — no template interpolation required.

---

### kanban.html — Prompts Tab UI (new subsection)
**File:** [`src/webview/kanban.html`](src/webview/kanban.html)

#### Context
The prompts tab (`#prompts-tab-content`, lines 2127–2296) has role-specific config sections and a preview section. There is no section for relay or chat prompt overrides.

#### Logic
Add a new `db-subsection` **before** the Preview section (before line 2281). This section contains three textareas: Chat Prompt Override, Relay Gather Prompt Override, Relay Execute Prompt Override. Each has a dedicated Save button that fires `postKanbanMessage({ type: 'saveSetting', key, value })` directly — independent of the role-selector-driven save path.

On the read side, add handlers in the `getSetting` response block (around line 4618) to populate these textareas when their setting keys arrive.

#### Implementation

**Insert before line 2281 (before `<!-- Preview section -->`):**
```html
<!-- Relay & Chat Prompt Overrides -->
<div class="db-subsection">
  <div class="subsection-header"><span>Copy Prompt Overrides</span></div>
  <div class="config-section addons-section">
    <p class="section-desc">
      Override the prompts used by the <strong>Chat</strong>, <strong>Gather</strong>, and <strong>Execute</strong> copy buttons on kanban cards.
      Leave blank to use the built-in defaults.
    </p>

    <div class="input-group" style="flex-direction:column; margin-bottom:12px;">
      <label for="chatPromptOverride" style="margin-bottom:4px;">Chat Prompt Override:</label>
      <textarea id="chatPromptOverride" rows="4" style="font-family:var(--font-mono); font-size:12px; resize:vertical;"
        placeholder="/chat&#10;&#10;Please enter the chat workflow defined at: .agent/workflows/chat.md..."></textarea>
      <button id="saveChatPromptOverride" class="secondary-btn" style="margin-top:6px; align-self:flex-start;">Save Chat Prompt</button>
    </div>

    <div class="input-group" style="flex-direction:column; margin-bottom:12px;">
      <label for="relayGatherPromptOverride" style="margin-bottom:4px;">Relay Gather Prompt Override:</label>
      <textarea id="relayGatherPromptOverride" rows="4" style="font-family:var(--font-mono); font-size:12px; resize:vertical;"
        placeholder="Leave blank to use the built-in context-gathering template."></textarea>
      <button id="saveRelayGatherPromptOverride" class="secondary-btn" style="margin-top:6px; align-self:flex-start;">Save Gather Prompt</button>
    </div>

    <div class="input-group" style="flex-direction:column; margin-bottom:12px;">
      <label for="relayExecutePromptOverride" style="margin-bottom:4px;">Relay Execute Prompt Override:</label>
      <textarea id="relayExecutePromptOverride" rows="4" style="font-family:var(--font-mono); font-size:12px; resize:vertical;"
        placeholder="Leave blank to use the built-in execution template."></textarea>
      <button id="saveRelayExecutePromptOverride" class="secondary-btn" style="margin-top:6px; align-self:flex-start;">Save Execute Prompt</button>
    </div>
  </div>
</div>
```

**Add save button event listeners** (in the JS init block near the other button listeners, e.g., near line 2958):
```javascript
document.getElementById('saveChatPromptOverride')?.addEventListener('click', () => {
    const val = document.getElementById('chatPromptOverride').value;
    postKanbanMessage({ type: 'saveSetting', key: 'switchboard.prompts.chatPromptOverride', value: val });
});
document.getElementById('saveRelayGatherPromptOverride')?.addEventListener('click', () => {
    const val = document.getElementById('relayGatherPromptOverride').value;
    postKanbanMessage({ type: 'saveSetting', key: 'switchboard.prompts.relay_gatherPrompt', value: val });
});
document.getElementById('saveRelayExecutePromptOverride')?.addEventListener('click', () => {
    const val = document.getElementById('relayExecutePromptOverride').value;
    postKanbanMessage({ type: 'saveSetting', key: 'switchboard.prompts.relay_executePrompt', value: val });
});
```

**Request settings on panel open** — add to the existing block that requests role configs (near line 2427):
```javascript
postKanbanMessage({ type: 'getSetting', key: 'chatPromptOverride' });
postKanbanMessage({ type: 'getSetting', key: 'relay_gatherPrompt' });
postKanbanMessage({ type: 'getSetting', key: 'relay_executePrompt' });
```

**Handle `getSetting` responses** — in the `getSetting` response handler (around line 4618), add:
```javascript
} else if (key === 'chatPromptOverride') {
    const el = document.getElementById('chatPromptOverride');
    if (el) el.value = value || '';
} else if (key === 'relay_gatherPrompt') {
    const el = document.getElementById('relayGatherPromptOverride');
    if (el) el.value = value || '';
} else if (key === 'relay_executePrompt') {
    const el = document.getElementById('relayExecutePromptOverride');
    if (el) el.value = value || '';
}
```

#### Edge Cases
- Saving an empty string correctly clears the override (falls back to default in backend).
- The subsection is always visible regardless of selected role — it is not inside a role-specific `div`.

---

## Verification Plan

### Automated Tests
- None applicable (per session directives).

### Manual Verification
1. **Chat Prompt Override:**
   - Open Kanban → Prompts tab.
   - Enter a custom string in "Chat Prompt Override" textarea and click Save.
   - Click `chatCopyPrompt` button on any kanban card.
   - Paste clipboard — confirm custom string appears as the base, with plan section appended if cards were selected.
   - Clear the override, save, repeat — confirm the built-in default is restored.

2. **Relay Gather Prompt Override:**
   - Enter a custom string in "Relay Gather Prompt Override" and click Save.
   - On a CONTEXT GATHERER card, click the gather copy button.
   - Confirm clipboard contains the custom string (not the default relay template).

3. **Relay Execute Prompt Override:**
   - Enter a custom string in "Relay Execute Prompt Override" and click Save.
   - On a CONTEXT GATHERER card, click the execute copy button.
   - Confirm clipboard contains the custom override.

4. **Regression: `promptSelected` and `promptAll`:**
   - Confirm these buttons still produce the same output as before (they are unmodified).

---

> **Recommendation:** Send to Coder (complexity 5)

---

## Reviewer Pass — 2026-05-23

### Stage 1 — Adversarial Findings (Grumpy Principal Engineer)

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | `_getSetting` called with `undefined` as `defaultValue` (TypeScript infers `T = undefined`); functionally correct but stylistically loose. |
| 2 | **MAJOR** | Save button event listeners read DOM elements with `.value` without a null guard — `document.getElementById('chatPromptOverride').value` throws `TypeError` if element is missing. Same pattern repeated for the two relay textareas. |
| 3 | NIT | `chatPromptOverride.trim()` called twice in the `chatBase` ternary — redundant computation, should be stored in a variable. |
| 4 | NIT | Plan references `copyGatherPrompt` at "line 5906" and `copyExecutePrompt` at "line 5921" — actual positions are 5922/5937 (minor doc drift, implementation correct). |

### Stage 2 — Balanced Synthesis

- **Key path analysis**: Frontend short keys (`'chatPromptOverride'`, `'relay_gatherPrompt'`, `'relay_executePrompt'`) are correctly prefixed by the `saveSetting`/`getSetting` backend handler. Backend direct reads use the full prefixed key. No mismatch. ✅
- **Finding #2 (MAJOR) → Fixed**: All three save button callbacks now use `?.value ?? ''` null-safe reads.
- **Finding #3 (NIT) → Fixed**: Double `.trim()` eliminated via `chatOverrideTrimmed` intermediate variable.
- **Findings #1, #4**: No code changes required.

### Files Changed

| File | Change |
|------|--------|
| [`src/services/RelayPromptService.ts`](src/services/RelayPromptService.ts) | Added `customGatherPrompt?` and `customExecutePrompt?` to `RelayConfig`; early-return override guards in both generate methods. |
| [`src/services/KanbanProvider.ts`](src/services/KanbanProvider.ts) | `_generateRelayPrompt`: reads two override keys, passes into `relayConfig`. `chatCopyPrompt`: reads override key, uses trimmed result once via `chatOverrideTrimmed`. |
| [`src/webview/kanban.html`](src/webview/kanban.html) | New "Copy Prompt Overrides" subsection with three textareas + save buttons. `loadRoleConfigs()` extended with three new `getSetting` requests. Save button listeners added with null-safe DOM reads. `settingResult` handler extended with three new `else if` branches. |

### Validation Results

```
npx tsc --noEmit
```
- Pre-existing errors (2): `ClickUpSyncService.ts:2309` and `KanbanProvider.ts:4555` — relative import path extension warnings. **Pre-existing, unrelated to this plan.**
- New errors introduced: **0** ✅

### Remaining Risks

- **No save confirmation toast**: Clicking "Save Chat Prompt" / "Save Gather Prompt" / "Save Execute Prompt" gives no visual feedback. Consistent with existing role-config save behaviour (no toast there either). Acceptable for now; a follow-up could add a transient "Saved ✓" indicator.
- **Global vs workspace state**: Override prompts are stored in workspaceState (or globalState if the global setting flag is enabled). This is correct per existing architecture but means overrides are not portable across workspaces unless global settings mode is on.

### Status: ✅ DONE
