# Linear Remote Tab: Dynamic Agent Skill Copy Button

## Goal

Add a "Copy Linear Agent Skill" button to the Kanban REMOTE tab that generates a tailored instruction text for the Linear native agent, pre-filled with the user's actual board/status mappings. The user pastes this into Linear's agent configuration manually as a one-time setup step.

### Background & Problem

Switchboard's Linear Remote Control feature allows driving the Kanban board from any Linear client — moving an issue between Linear states dispatches the local column agent; comments are routed to that agent and responses written back. The Linear app has a native AI agent that users can instruct to manage issues on their behalf. However, for the native agent to operate correctly as a Switchboard controller, it needs to know:
- Which Linear status names map to which Switchboard actions
- How to format issue descriptions as plans
- How to interact via comments

There is currently no way for Switchboard to surface this information in a usable form. Users must manually piece together their own instructions from documentation. Because the sync function ensures Linear status names match Switchboard column names, the mapping data is already available and can be used to generate a fully tailored skill text with zero user effort.

---

## Metadata

**Tags:** frontend, backend, api, ui, infrastructure
**Complexity:** 3

---

## User Review Required

Minimal review required. The user should verify: (1) the generated skill text reads correctly with their actual column mappings, (2) the button's disabled state triggers correctly when Linear is not configured. No architectural decisions need user sign-off.

---

## Complexity Audit

### Routine
- Adding an HTML button to an existing tab section in `kanban.html`
- Adding a new `case` to an existing switch statement in `KanbanProvider._handleMessage`
- Generating a text template by interpolating config values into a string
- Using the existing `navigator.clipboard.writeText()` pattern (kanban.html:6281)
- Loading two config objects via existing service methods

### Complex / Risky
- None — all changes follow existing patterns. The only subtlety is loading `LinearConfig` from `GlobalIntegrationConfigService` (global file) while loading `RemoteConfig` from the Kanban DB (`remote.config` key) — two different storage layers.

---

## Edge-Case & Dependency Audit

**Race Conditions:** None — the button click is a user-initiated one-shot action. Config is read synchronously at click time, not polled.

**Security:** No security implications. The generated skill text contains column names and ping frequency — no tokens, credentials, or sensitive data. The text is written to the user's local clipboard only.

**Side Effects:** Writing to the system clipboard replaces whatever the user had there. The button shows "Copied!" feedback for 2 seconds (matching the existing pattern at kanban.html:6281).

**Dependencies & Conflicts:**
- `LinearConfig` is stored via `GlobalIntegrationConfigService` in `~/.switchboard/integration-config.json` (loaded by `LinearSyncService.loadConfig()` at line 243, which calls `GlobalIntegrationConfigService.loadConfig('linear')`). It is NOT in the Kanban DB.
- `RemoteConfig` is stored in the Kanban DB under key `remote.config` (loaded by `RemoteControlService.getConfig()` at line 92, which calls `db.getConfig('remote.config')`).
- The `columnToStateId` map keys are Switchboard column names, which match Linear status names by convention (enforced by the sync function).
- `RemoteConfig.pingFrequencySeconds` is a number in seconds (30–120).
- **No conflict with Plan 3 (mutual exclusivity):** The copy button reads config but does not modify mode state.

---

## Dependencies

No session dependencies. This plan is self-contained.

---

## Adversarial Synthesis

Key risks: (1) the plan originally claimed `LinearConfig` is loaded from the Kanban DB `linear-config` key — it is actually loaded from `GlobalIntegrationConfigService` (`~/.switchboard/integration-config.json`), a completely different storage layer; (2) the message handler is in `KanbanProvider._handleMessage` (line 5120), not `TaskViewerProvider`; (3) line numbers for the REMOTE tab and JS handler were significantly off. Mitigations: all references have been verified against the actual codebase and corrected; the implementer should use `this._getLinearService(workspaceRoot).loadConfig()` for `LinearConfig` and `this._getRemoteControl(workspaceRoot).getConfig()` for `RemoteConfig`.

---

## Proposed Changes

### `src/services/LinearSyncService.ts` (READ ONLY — verify interface)

**Context:** The `LinearConfig` interface (lines 17–34) contains `columnToStateId: Record<string, string>` (line 22) — a map of Switchboard column names to Linear state IDs. The column names (keys) ARE the Linear status names by convention.

**No changes to this file.** The implementer should read it to understand the config shape:
- `loadConfig()` (line 243) → calls `GlobalIntegrationConfigService.loadConfig('linear')` → reads from `~/.switchboard/integration-config.json`
- `saveConfig()` (line 280) → `async saveConfig(config: LinearConfig): Promise<void>`
- Returns `LinearConfig | null` — handle null case (Linear not set up)

### `src/services/RemoteControlService.ts` (READ ONLY — verify interface)

**Context:** The `RemoteConfig` interface (lines 34–45) contains `pingFrequencySeconds: number` (line 44) — the poll cadence in seconds (30–120).

**No changes to this file.** The implementer should read it to understand:
- `getConfig()` (line 92) → `public async getConfig(): Promise<RemoteConfig>` → reads from `db.getConfig('remote.config')`
- `RemoteConfig.pingFrequencySeconds` is the field for the polling interval

### `src/services/KanbanProvider.ts` (EDIT — new message handler case)

**Context:** The kanban webview's message handler is `KanbanProvider._handleMessage` (line 5120), a switch statement on `msg.type`. Existing remote-control cases:
- `getRemoteConfig` (line 5533) — loads `RemoteConfig` and posts back
- `setRemoteConfig` (line 5543) — saves `RemoteConfig` and posts back
- `startRemoteControl` (line 5584) — starts polling

**Logic:** Add a new case `copyLinearAgentSkill` adjacent to the existing remote-control cases:

```ts
case 'copyLinearAgentSkill': {
    const rc = this._getRemoteControl(workspaceRoot);
    const remoteConfig = await rc.getConfig();
    const linear = this._getLinearService(workspaceRoot);
    const linearConfig = await linear.loadConfig();
    if (!linearConfig || !linearConfig.setupComplete ||
        !linearConfig.columnToStateId ||
        Object.keys(linearConfig.columnToStateId).length === 0) {
        this._panel?.webview.postMessage({
            type: 'linearAgentSkillText', text: null,
            error: 'Configure Linear sync first (map columns to Linear statuses in Setup).'
        });
        break;
    }
    const pingSeconds = remoteConfig.pingFrequencySeconds || 60;
    const columns = Object.keys(linearConfig.columnToStateId).filter(
        col => linearConfig.columnToStateId[col] // skip unmapped columns
    );
    const mappingLines = columns
        .map(col => `- Move to "${col}" → dispatches the ${col} agent`)
        .join('\n');
    const skillText = `You are a controller for the Switchboard AI development board.

## How it works
Switchboard polls Linear every ${pingSeconds}s. When you move an issue to a new state, it dispatches the corresponding local AI agent. Comments you post on an issue are routed to that column's agent; responses appear as new comments.

## Column → Agent mapping
${mappingLines}

## How to write plans
Place the implementation plan in the issue description. No special format is required, but use clear sections (Goal, Tasks, Notes). The local agent reads whatever is in the description.

## Responding to questions
If the user asks a question in a comment, post it as a comment on the issue. The local agent will respond in a follow-up comment within one polling cycle.

## Setup notes
- Remote control must be enabled (toolbar button in VS Code).
- Only move issues between states that appear in the mapping above.
- Do not create new Linear states — only use the ones listed.`;
    this._panel?.webview.postMessage({ type: 'linearAgentSkillText', text: skillText });
    break;
}
```

**Edge Cases:**
- If `linearConfig` is null or `setupComplete` is false, post back an error message instead of skill text. The webview shows this as a tooltip or status line.
- If `columnToStateId` is empty (no columns mapped), same error path.
- Partial mappings: only include columns where `columnToStateId[col]` is a non-empty string (skip unmapped columns).
- `pingFrequencySeconds` may be 0 or undefined in edge cases — default to 60.

### `src/webview/kanban.html` (EDIT — REMOTE tab + JS handler)

**Context:** The REMOTE tab section is `#remote-tab-content` at lines 2537–2610. The JS message handler starts at line 6022. Remote-control messages are handled at lines 6537–6545 (`remoteConfig`, `remoteControlState`, `notionRemoteSetupResult`).

**Change 1 — Add button to REMOTE tab** (after the existing description text, near line 2553):

```html
<button id="btn-copy-linear-agent-skill" class="action-btn"
        style="margin-top:8px; display:none;"
        title="Copy tailored instructions for Linear's native AI agent">
    Copy Linear Agent Skill
</button>
<span id="copy-linear-agent-skill-status" style="font-size:11px; color:var(--text-secondary); margin-left:8px;"></span>
```

- The button starts hidden (`display:none`). It is shown when the `remoteConfig` message handler (line 6537) detects that the provider is `linear` and `columnToStateId` is non-empty.
- If `columnToStateId` is empty or the provider is Notion, the button stays hidden (not just disabled — it's irrelevant for Notion).

**Change 2 — Add click handler** (in the JS section, near the existing remote-control event listeners):

```javascript
document.getElementById('btn-copy-linear-agent-skill')?.addEventListener('click', () => {
    postKanbanMessage({ type: 'copyLinearAgentSkill' });
});
```

**Change 3 — Handle the response message** (in the message switch statement, near line 6545):

```javascript
case 'linearAgentSkillText':
    if (msg.text) {
        navigator.clipboard.writeText(msg.text).then(() => {
            const btn = document.getElementById('btn-copy-linear-agent-skill');
            const status = document.getElementById('copy-linear-agent-skill-status');
            if (btn) { btn.textContent = 'Copied!'; }
            if (status) { status.textContent = ''; }
            setTimeout(() => { if (btn) { btn.textContent = 'Copy Linear Agent Skill'; } }, 2000);
        }).catch(err => {
            console.error('Failed to copy Linear agent skill:', err);
            const status = document.getElementById('copy-linear-agent-skill-status');
            if (status) { status.textContent = 'Copy failed — check console'; }
        });
    } else if (msg.error) {
        const status = document.getElementById('copy-linear-agent-skill-status');
        if (status) { status.textContent = msg.error; }
    }
    break;
```

**Edge Cases:**
- The clipboard pattern matches the existing one at kanban.html:6281 (`navigator.clipboard.writeText().then().catch()`). No `document.execCommand('copy')` fallback — none exists in the codebase and VS Code webviews support `navigator.clipboard` reliably.
- Button visibility is controlled by the `remoteConfig` handler, not by a separate message. When `remoteConfig` arrives with `provider === 'linear'`, check if `columnToStateId` data is available (the webview may need to request it, or it can be included in the `remoteConfig` payload — the implementer should check what data `remoteConfig` already includes and whether `columnToStateId` is present).
- **Clarification:** If `columnToStateId` is not included in the `remoteConfig` message payload, the button should always be visible when `provider === 'linear'` and let the backend return an error if mapping is empty. This avoids a separate config-fetch round-trip just for visibility toggling.

---

## Verification Plan

### Automated Tests

No automated tests required per session instructions. The test suite will be run separately by the user.

### Manual Verification

1. Configure Linear sync in Setup (map columns to Linear statuses), enable Remote Control with provider = Linear.
2. Open the Kanban REMOTE tab — confirm the "Copy Linear Agent Skill" button is visible.
3. Click the button — confirm the clipboard contains the generated skill text with the actual column names from the user's `columnToStateId` mapping and the actual `pingFrequencySeconds` value.
4. Confirm the button text changes to "Copied!" for 2 seconds, then reverts.
5. Test with no Linear sync configured — confirm the button is hidden (or shows the error tooltip if clicked).
6. Test with partial column mappings — confirm only mapped columns appear in the generated text.
7. Paste the copied text into a text editor — verify the template renders correctly with no undefined values.

---

## Out of Scope

- No changes to the Linear sync protocol
- No changes to how remote control works
- No automated posting of the skill text to Linear

---

## Recommendation

Complexity 3 → **Send to Coder**
