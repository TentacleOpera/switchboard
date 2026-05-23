# Remove Copy Prompt Overrides Section from Prompts Tab

## Goal
Remove the "Copy Prompt Overrides" subsection from the prompts tab and revert all related backend changes. This section was added without user request and is redundant given the existing role-based prompt configuration system.

## Metadata
- **Tags:** frontend, backend
- **Complexity:** 3

## User Review Required
None. This is a pure revert of an unrequested feature with no breaking changes to existing user-visible functionality.

## Complexity Audit

### Routine
- Removing a self-contained HTML subsection (one `<div class="db-subsection">` block) from the prompts tab
- Removing 3 event listeners in `initPromptsTabListeners()`
- Removing 3 `postKanbanMessage` calls from `loadRoleConfigs()`
- Removing 3 `} else if (key === ...)` handler branches from the `getSetting` response block
- Reverting `chatCopyPrompt` case in KanbanProvider.ts to a hardcoded default (removing override-aware settings read)
- Removing 2 `_getSetting` calls and the `customGatherPrompt`/`customExecutePrompt` fields from `_generateRelayPrompt()` in KanbanProvider.ts
- Removing 2 optional fields from the `RelayConfig` interface and 2 early-return guards in RelayPromptService.ts

### Complex / Risky
- None. `TaskViewerProvider.ts` imports `RelayConfig` but confirmed via grep it does NOT set `customGatherPrompt` or `customExecutePrompt` — removing those fields will not break any caller.

## Edge-Case & Dependency Audit

### Race Conditions
- None. All changes are synchronous UI-to-backend removals with no async coordination.

### Security
- None. Removing override fields reduces the attack surface slightly (user can no longer inject arbitrary prompt text into relay paths).

### Side Effects
- Orphaned settings: `switchboard.prompts.chatPromptOverride`, `switchboard.prompts.relay_gatherPrompt`, and `switchboard.prompts.relay_executePrompt` may already exist in user workspaceState/globalState. After this change they will be ignored silently — benign, no cleanup needed.
- `chatCopyPrompt` will always use the hardcoded `/chat` default. Users who had previously saved a chat prompt override will lose it; acceptable since the feature is being removed entirely.

### Dependencies & Conflicts
- `TaskViewerProvider.ts` imports `RelayConfig` and instantiates `RelayPromptService` — confirmed it never sets the optional override fields. Safe to remove.
- `KanbanProvider.ts` imports both `RelayPromptService` and `RelayConfig` — removals to interface and call sites are co-located and straightforward.

## Dependencies
- None (no inter-plan dependencies)

## Adversarial Synthesis
Key risks are implementation-precision failures (stale line number estimates) and the incorrect framing of the `chatCopyPrompt` change as a "git revert" when it is actually a targeted code replacement. Mitigation: use exact anchor strings from live code rather than line numbers. The `TaskViewerProvider.ts` safety check has been confirmed via grep — removing `RelayConfig` optional fields is safe.

## Proposed Changes

### kanban.html
**File:** [`src/webview/kanban.html`](src/webview/kanban.html)

#### 1. Remove the entire "Copy Prompt Overrides" subsection (lines ~2289–2319)
**Anchor string:** `<!-- Relay & Chat Prompt Overrides -->`

Remove from:
```html
        <!-- Relay & Chat Prompt Overrides -->
        <div class="db-subsection">
          <div class="subsection-header"><span>Copy Prompt Overrides</span></div>
          <div class="config-section addons-section">
```
...through the closing `</div>` that ends that `db-subsection` (line ~2319), stopping before the `<!-- Preview section -->` comment.

**Edge case:** The subsection ends at line 2319 — the next sibling is `<!-- Preview section (shown for all roles) -->`. Do not remove the preview section.

#### 2. Remove save button event listeners in `initPromptsTabListeners()` (lines ~3071–3082)
**Anchor:** `document.getElementById('saveChatPromptOverride')`

Remove the three listener blocks:
```javascript
document.getElementById('saveChatPromptOverride')?.addEventListener('click', () => {
    const val = document.getElementById('chatPromptOverride')?.value ?? '';
    postKanbanMessage({ type: 'saveSetting', key: 'chatPromptOverride', value: val });
});
document.getElementById('saveRelayGatherPromptOverride')?.addEventListener('click', () => {
    const val = document.getElementById('relayGatherPromptOverride')?.value ?? '';
    postKanbanMessage({ type: 'saveSetting', key: 'relay_gatherPrompt', value: val });
});
document.getElementById('saveRelayExecutePromptOverride')?.addEventListener('click', () => {
    const val = document.getElementById('relayExecutePromptOverride')?.value ?? '';
    postKanbanMessage({ type: 'saveSetting', key: 'relay_executePrompt', value: val });
});
```

#### 3. Remove getSetting requests from `loadRoleConfigs()` (lines ~2470–2472)
**Anchor:** `postKanbanMessage({ type: 'getSetting', key: 'chatPromptOverride' });`

Remove these three lines:
```javascript
postKanbanMessage({ type: 'getSetting', key: 'chatPromptOverride' });
postKanbanMessage({ type: 'getSetting', key: 'relay_gatherPrompt' });
postKanbanMessage({ type: 'getSetting', key: 'relay_executePrompt' });
```

#### 4. Remove getSetting response handlers (lines ~4685–4694)
**Anchor:** `} else if (key === 'chatPromptOverride') {`

Remove the three `else if` branches:
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

---

### KanbanProvider.ts — Replace override-aware chatCopyPrompt with hardcoded default
**File:** [`src/services/KanbanProvider.ts`](src/services/KanbanProvider.ts)

**Anchor:** `case 'chatCopyPrompt': {` (line ~5053)

**Context:** The current code reads `chatPromptOverride` from settings and falls back to the default. Replace the entire case body with a hardcoded-only version that removes the settings read and override logic entirely.

Replace the entire `case 'chatCopyPrompt'` block (current lines ~5053–5084) with:
```typescript
case 'chatCopyPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }

    const chatWorkflowPath = '.agent/workflows/chat.md';
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

    const prompt = `/chat\n\nPlease enter the chat workflow defined at: ${chatWorkflowPath}\n\nWe will be discussing plans and requirements.${planSection}`;
    await vscode.env.clipboard.writeText(prompt);
    const count = Array.isArray(msg.sessionIds) ? msg.sessionIds.length : 0;
    const planWord = count > 0 ? ` for ${count} plan(s)` : '';
    vscode.window.showInformationMessage(`Chat prompt copied to clipboard${planWord}.`);
    break;
}
```

### KanbanProvider.ts — Remove relay prompt override reads from `_generateRelayPrompt`
**File:** [`src/services/KanbanProvider.ts`](src/services/KanbanProvider.ts)

**Anchor:** `// NEW: Read relay prompt overrides from prompts tab` (line ~411)

Remove these lines from the `_generateRelayPrompt` method:
```typescript
// NEW: Read relay prompt overrides from prompts tab
const customGatherPrompt: string | undefined = this._getSetting('switchboard.prompts.relay_gatherPrompt', undefined) || undefined;
const customExecutePrompt: string | undefined = this._getSetting('switchboard.prompts.relay_executePrompt', undefined) || undefined;
```

And update the `relayConfig` object to remove the two override fields:
```typescript
// BEFORE:
const relayConfig: RelayConfig = {
    planPath: planFileAbsolute,
    planContent,
    estimatedComplexity,
    dependencies,
    customGatherPrompt,
    customExecutePrompt,
};

// AFTER:
const relayConfig: RelayConfig = {
    planPath: planFileAbsolute,
    planContent,
    estimatedComplexity,
    dependencies,
};
```

---

### RelayPromptService.ts — Revert Interface and Remove Early-Return Guards
**File:** [`src/services/RelayPromptService.ts`](src/services/RelayPromptService.ts)

#### 1. Remove optional override fields from `RelayConfig` interface (lines ~10–11)
**Anchor:** `customGatherPrompt?: string;`

Remove from the interface:
```typescript
customGatherPrompt?: string;
customExecutePrompt?: string;
```

Resulting interface:
```typescript
export interface RelayConfig {
    planPath: string;
    planContent: string;
    estimatedComplexity: number;
    dependencies: string[];
}
```

#### 2. Remove early-return guard in `generateGatherPrompt` (lines ~24–26)
**Anchor:** `if (config.customGatherPrompt && config.customGatherPrompt.trim()) {`

Remove:
```typescript
if (config.customGatherPrompt && config.customGatherPrompt.trim()) {
    return config.customGatherPrompt;
}
```

#### 3. Remove early-return guard in `generateExecutePrompt` (lines ~81–83)
**Anchor:** `if (config.customExecutePrompt && config.customExecutePrompt.trim()) {`

Remove:
```typescript
if (config.customExecutePrompt && config.customExecutePrompt.trim()) {
    return config.customExecutePrompt;
}
```

---

## Verification Plan

### Automated Tests
```bash
npx tsc --noEmit
```
- Should produce zero new errors. The removed interface fields are only referenced at the two removed call sites in KanbanProvider.ts; no other files set these fields.

### Manual Verification
1. Open Kanban → Prompts tab
2. Confirm the **"Copy Prompt Overrides"** subsection is gone (no Chat / Gather / Execute override textareas)
3. Click the **Chat copy button** on any kanban column header
4. Confirm clipboard contains the built-in hardcoded default chat prompt (starts with `/chat`)
5. Click **"Copy Gather"** button on a CONTEXT GATHERER card
6. Confirm clipboard contains the built-in relay context-gathering template (not a blank or override string)
7. Click **"Copy Execute"** button on a CONTEXT GATHERER card
8. Confirm clipboard contains the built-in relay execution template

---

> **Recommendation:** Send to Coder (complexity 3)
