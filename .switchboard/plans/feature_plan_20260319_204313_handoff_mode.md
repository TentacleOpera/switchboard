# Pair Programming Mode

## Goal
This plan delivers two related pair programming capabilities:

**1. Pair Programming Toggle (header)** — A kanban header toggle. When enabled and a plan is dispatched to the Lead Coder (Band B), the system automatically dispatches the same plan to the Coder agent (Band A) without user action. The Lead Coder prompt notes that a Coder agent is handling Band A concurrently and to check/integrate that work once done (Band A finishes first).

**2. "Pair Program" Per-Card Button** — A button on every kanban card (appears alongside existing Copy Prompt / Advance buttons). Designed for **IDE agents** (Antigravity, Windsurf, Cursor, etc.) acting as Lead Coder. When clicked:
- Copies the **Band B lead prompt** to the clipboard (user pastes into their IDE chat agent)
- Simultaneously **auto-dispatches the Band A prompt** to the Coder CLI terminal (e.g. Gemini CLI) — no toggle required

This enables a powerful split: the IDE agent handles complex/risky Band B work (preserving its limited token quota) while the CLI agent handles routine Band A work in parallel. This workflow is independent of the header toggle — users can pair-program on individual cards without enabling global mode.

Both features integrate with all kanban dispatch paths: advance buttons, prompt buttons, autoban, and manual drag-and-drop.

## User Review Required
> [!NOTE]
> - **Header Toggle**: A new "Pair Programming" toggle in the kanban header; when enabled, all lead dispatches automatically also dispatch Band A to the Coder terminal
> - **Per-Card Button**: A new "Pair Program" button on every kanban card — copies Band B lead prompt to clipboard (for IDE agents) and auto-dispatches Band A to the Coder terminal. Works independently of the header toggle.
> - **IDE + CLI collaboration**: The per-card button is designed for Windsurf / Antigravity / Cursor acting as lead (paste clipboard into IDE chat) + Gemini CLI acting as coder (auto-dispatched terminal). Saves IDE agent token quota by offloading routine work.
> - **Lead Prompt Change**: Lead prompt (both paths) notes that a Coder agent is handling Band A concurrently and to check/integrate their work after they finish
> - **State Persistence**: Header toggle state stored in `.switchboard/state.json` per workspace
> - **No Breaking Changes**: All existing workflows unaffected when both features are disabled (default)

## Complexity Audit
### Band A — Routine
- Add boolean flag `pairProgrammingEnabled` to `AutobanConfigState` type in `autobanState.ts`
- Update `normalizeAutobanConfigState()` to default `pairProgrammingEnabled` to `false`
- Add UI toggle element to `kanban.html` header controls strip (label: "Pair Programming")
- Add message handler case `togglePairProgramming` in KanbanProvider message switch
- Persist state to `.switchboard/state.json` via existing state management (follow `setAutobanEnabled()` pattern)
- Read and broadcast state to webview on board refresh and config update
- Add "Pair Program" button element to each kanban card template in `kanban.html` (alongside existing Copy Prompt / Advance buttons)
- Add `pairProgramCard` message handler in KanbanProvider message switch

### Band B — Complex / Risky
- Modify `buildKanbanBatchPrompt()` in `agentPromptBuilder.ts`:
  - Add `pairProgrammingEnabled?: boolean` to `PromptBuilderOptions`
  - When role is `lead` and mode is enabled: append a note that a Coder agent is handling Band A concurrently, and to check and integrate Band A work after it completes (since Band A finishes first)
  - When role is `coder` and mode is enabled: append "Additional Instructions: only do band a."
- Modify all lead-dispatch call sites in `KanbanProvider` and `TaskViewerProvider`:
  - After dispatching the lead prompt, detect if pair programming is enabled
  - If so, immediately open a dedicated Coder terminal and dispatch the same plan list with the coder role prompt (Band A instructions)
  - This auto-dispatch must happen atomically with the lead dispatch (same tick, same batch event)
- Snapshot `pairProgrammingEnabled` at the start of each batch to prevent mid-batch toggle inconsistencies (follow existing autoban snapshot pattern)
- **Per-card Pair Program button** (complex because it combines two dispatch mechanisms):
  - On click: build the lead Band B prompt for that single plan and copy to clipboard
  - Simultaneously build the coder Band A prompt for the same plan and dispatch to Coder terminal
  - Must resolve the plan's absolute path and complexity bucket for a single card (same logic as existing single-card Copy Prompt)
  - Must handle the case where no Coder terminal is registered (surface a warning, not a silent failure)

## Edge-Case & Dependency Audit
- **Race Condition**: Both terminals start simultaneously; Band A is expected to finish first. The lead prompt instructs the Lead Coder to wait and integrate Band A work before finalising — no system-level synchronisation required beyond the prompt instruction.
- **Coder Terminal**: The auto-triggered Coder terminal follows the existing dedicated terminal model. If no Coder terminal exists, one is created. If one exists, the plan is sent to it (same as manual dispatch).
- **Autoban**: When autoban dispatches to Lead, pair programming auto-dispatch for Coder must also fire within the same tick. Snapshot the mode state before the tick.
- **Prompt-only mode**: If the user uses "Copy Prompt" / "Prompt Selected" instead of advance, only the lead prompt is returned (with the Band A concurrency note). The Coder prompt should be copied/displayed separately or appended as a secondary block — this is the simpler case; no terminal is opened automatically.
- **Plans with no Band B**: If the plan complexity routes to Coder only (low-complexity), pair programming mode has no effect — only one agent is dispatched as normal.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** All code blocks below are complete and ready to implement. No placeholders, no truncation.

### 1. State Type Definition
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\autobanState.ts`
- Add `pairProgrammingEnabled: boolean` field to `AutobanConfigState` type
- Update `normalizeAutobanConfigState()` to default `pairProgrammingEnabled` to `false`

```typescript
export type AutobanConfigState = {
    enabled: boolean;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;
    routingMode: AutobanRoutingMode;
    maxSendsPerTerminal: number;
    globalSessionCap: number;
    sessionSendCount: number;
    sendCounts: Record<string, number>;
    terminalPools: Record<string, string[]>;
    managedTerminalPools: Record<string, string[]>;
    poolCursor: Record<string, number>;
    rules: Record<string, AutobanRuleState>;
    lastTickAt?: Record<string, number>;
    pairProgrammingEnabled: boolean;
};
```

In `normalizeAutobanConfigState()`, add at the end of the return object:
```typescript
pairProgrammingEnabled: state?.pairProgrammingEnabled === true
```

### 2. Prompt Builder Enhancement
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\agentPromptBuilder.ts`
- Add `pairProgrammingEnabled?: boolean` to `PromptBuilderOptions`
- Lead role with mode enabled: append collaborator note
- Coder role with mode enabled: append "only do band a" instruction

```typescript
export interface PromptBuilderOptions {
    instruction?: string;
    includeInlineChallenge?: boolean;
    accurateCodingEnabled?: boolean;
    /** When true, lead is told a coder agent is handling Band A concurrently. Coder is told to do Band A only. */
    pairProgrammingEnabled?: boolean;
}
```

Lead role block:
```typescript
if (role === 'lead') {
    const basePrompt = `Please execute the following ${plans.length} plans.

${batchExecutionRules}${challengeBlock}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
    const pairNote = pairProgrammingEnabled
        ? `\n\nNote: A Coder agent is concurrently handling the Band A (routine) tasks for these plans. ` +
          `You only need to do Band B (complex/risky) work. ` +
          `Once the Coder finishes Band A (they will complete before you), check and integrate their work into your implementation before finalising.`
        : '';
    return `${basePrompt}${pairNote}`;
}
```

Coder role block:
```typescript
if (role === 'coder') {
    const intro = baseInstruction === 'low-complexity'
        ? `Please execute the following ${plans.length} low-complexity plans from PLAN REVIEWED.`
        : `Please execute the following ${plans.length} plans.`;
    const basePrompt = `${intro}

${batchExecutionRules}${challengeBlock}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
    const withAccuracy = withCoderAccuracyInstruction(basePrompt, accurateCodingEnabled);
    return pairProgrammingEnabled ? `${withAccuracy}\n\nAdditional Instructions: only do band a.` : withAccuracy;
}
```

### 3. KanbanProvider — Lead Dispatch Auto-triggers Coder
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts`
- After dispatching a lead prompt (via advance/autoban/drag-drop), if `pairProgrammingEnabled`, immediately dispatch a coder prompt for the same plan list
- Add `togglePairProgramming` message handler
- Pass `pairProgrammingEnabled` to `buildKanbanBatchPrompt()` call sites

Add message handler in `_handleMessage()` switch:
```typescript
case 'togglePairProgramming': {
    const enabled = !!msg.enabled;
    if (this._autobanState) {
        this._autobanState = { ...this._autobanState, pairProgrammingEnabled: enabled };
    }
    await vscode.commands.executeCommand('switchboard.setPairProgrammingFromKanban', enabled);
    break;
}
```

In `_generateBatchExecutionPrompt()`, detect lead role and auto-dispatch coder if pair programming enabled:
```typescript
private async _dispatchWithPairProgrammingIfNeeded(
    cards: KanbanCard[],
    workspaceRoot: string,
    leadPrompt: string
): Promise<void> {
    const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
    if (!pairProgrammingEnabled) { return; }
    const coderPrompt = buildKanbanBatchPrompt('coder', this._cardsToPromptPlans(cards, workspaceRoot), {
        pairProgrammingEnabled: true
    });
    // Dispatch to Coder terminal using the same mechanism as manual coder dispatch
    await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
}
```

Call `_dispatchWithPairProgrammingIfNeeded()` after every lead terminal dispatch in advance/autoban/drag-drop paths.

Update `_generateBatchExecutionPrompt()` to pass `pairProgrammingEnabled`:
```typescript
private _generateBatchExecutionPrompt(cards: KanbanCard[], workspaceRoot: string): string {
    const hasHighComplexity = cards.some(card => !this._isLowComplexity(card));
    const role = hasHighComplexity ? 'lead' : 'coder';
    const instruction = hasHighComplexity ? undefined : 'low-complexity';
    const accurateCodingEnabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);
    const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
    return buildKanbanBatchPrompt(role, this._cardsToPromptPlans(cards, workspaceRoot), {
        instruction,
        accurateCodingEnabled,
        pairProgrammingEnabled
    });
}
```

### 4. Extension Command Registration
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\extension.ts`
- Register `switchboard.setPairProgrammingFromKanban` (delegates to TaskViewerProvider)
- Register `switchboard.dispatchToCoderTerminal` (opens/reuses Coder terminal and sends prompt)

```typescript
const setPairProgrammingDisposable = vscode.commands.registerCommand('switchboard.setPairProgrammingFromKanban', async (enabled: boolean) => {
    await taskViewerProvider.setPairProgrammingEnabled(enabled);
});
context.subscriptions.push(setPairProgrammingDisposable);

const dispatchToCoderTerminalDisposable = vscode.commands.registerCommand('switchboard.dispatchToCoderTerminal', async (prompt: string) => {
    await taskViewerProvider.dispatchToCoderTerminal(prompt);
});
context.subscriptions.push(dispatchToCoderTerminalDisposable);
```

### 5. TaskViewerProvider — State Persistence & Coder Auto-Dispatch
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\TaskViewerProvider.ts`
- Add `setPairProgrammingEnabled()` to persist state.json (follow `setAutobanEnabled()` pattern)
- Add `dispatchToCoderTerminal()` to open/reuse a Coder terminal and send the prompt (follow existing terminal dispatch logic)
- Update `handleKanbanBatchTrigger()` and autoban dispatch to pass `pairProgrammingEnabled` and auto-dispatch coder prompt when mode is enabled

```typescript
public async setPairProgrammingEnabled(enabled: boolean): Promise<void> {
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) { return; }
    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
    try {
        let state: any = {};
        if (fs.existsSync(statePath)) {
            state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
        }
        if (!state.autobanConfig) { state.autobanConfig = {}; }
        state.autobanConfig.pairProgrammingEnabled = enabled;
        await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
        const normalizedConfig = normalizeAutobanConfigState(state.autobanConfig);
        this._kanbanProvider?.updateAutobanConfig(normalizedConfig);
        vscode.window.showInformationMessage(`Pair Programming mode ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (e) {
        console.error('[TaskViewerProvider] Failed to update pair programming mode:', e);
        vscode.window.showErrorMessage('Failed to update pair programming mode.');
    }
}

public async dispatchToCoderTerminal(prompt: string): Promise<void> {
    // Open or reuse an existing Coder terminal and send the prompt
    // Follow the same pattern as the existing lead/coder terminal dispatch in handleKanbanBatchTrigger()
    const coderTerminal = this._getOrCreateTerminal('coder');
    coderTerminal.sendText(prompt);
}
```

In `handleKanbanBatchTrigger()` — after dispatching to the lead terminal, check pair programming and auto-dispatch to coder:
```typescript
const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
if (role === 'lead' && pairProgrammingEnabled) {
    const coderPrompt = buildKanbanBatchPrompt('coder', plans, {
        pairProgrammingEnabled: true,
        accurateCodingEnabled: this._isAccurateCodingEnabled()
    });
    await this.dispatchToCoderTerminal(coderPrompt);
}
```

### 6. Kanban UI Toggle
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\webview\kanban.html`
- Add "Pair Programming" toggle in `.settings-strip`
- Wire up message passing and state sync (follow existing CLI triggers toggle pattern)

```html
<label class="cli-toggle pair-programming-toggle" title="Pair Programming: Lead does Band B, Coder auto-starts Band A simultaneously">
    <input type="checkbox" id="pairProgrammingCheckbox">
    <span class="toggle-label">Pair Programming</span>
</label>
```

JS message handler:
```javascript
case 'updatePairProgramming':
    const ppCheckbox = document.getElementById('pairProgrammingCheckbox');
    if (ppCheckbox) {
        ppCheckbox.checked = event.data.enabled;
        ppCheckbox.closest('.pair-programming-toggle')?.classList.toggle('is-off', !event.data.enabled);
    }
    break;
```

JS click handler:
```javascript
document.getElementById('pairProgrammingCheckbox')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'togglePairProgramming', enabled: e.target.checked });
});
```

### 7. Broadcast State to Webview
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts`
In `updateAutobanConfig()` and `_refreshBoardImpl()`, broadcast pair programming state:
```typescript
this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: state.pairProgrammingEnabled });
```

### 8. Per-Card "Pair Program" Button
#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\webview\kanban.html`
- Add a "Pair Program" button to each card's action button row, alongside Copy Prompt and Advance
- **Only rendered for cards in the `PLAN REVIEWED` column** — hidden in all other columns
- The button is always visible when in PLAN REVIEWED (not gated by the header toggle)
- On click: posts `pairProgramCard` message to extension with the card's `sessionId`

```html
<!-- Inside the per-card button group, after the copy-prompt button -->
<!-- Only rendered when the card's column is PLAN REVIEWED -->
{{#if isPlanReviewed}}
<button class="card-action-btn pair-program-btn"
        data-session-id="{{sessionId}}"
        title="Pair Program: copy Band B prompt to clipboard, auto-send Band A to Coder terminal">
    ⚡ Pair Program
</button>
{{/if}}
```

If the card template is built dynamically in JS rather than a templating engine, apply the column guard in the card render function:
```javascript
if (card.column === 'PLAN REVIEWED') {
    actionsHtml += `<button class="card-action-btn pair-program-btn" data-session-id="${card.sessionId}" title="Pair Program: copy Band B prompt to clipboard, auto-send Band A to Coder terminal">⚡ Pair Program</button>`;
}
```

JS click handler (in the card event delegation block):
```javascript
if (e.target.closest('.pair-program-btn')) {
    const sessionId = e.target.closest('.pair-program-btn').dataset.sessionId;
    vscode.postMessage({ type: 'pairProgramCard', sessionId });
}
```

#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts`
- Add `pairProgramCard` case to `_handleMessage()` switch
- Resolve the card by `sessionId`, guard that it is in `PLAN REVIEWED`, build both prompts, copy lead prompt to clipboard, dispatch coder prompt to terminal

```typescript
case 'pairProgramCard': {
    const card = this._findCardBySessionId(msg.sessionId);
    if (!card || !this._workspaceRoot) { break; }
    if (card.column !== 'PLAN REVIEWED') {
        vscode.window.showWarningMessage('Pair Program is only available for PLAN REVIEWED cards.');
        break;
    }

    const plans = this._cardsToPromptPlans([card], this._workspaceRoot);

    // Build lead (Band B) prompt — with pair programming note
    const leadPrompt = buildKanbanBatchPrompt('lead', plans, { pairProgrammingEnabled: true });

    // Build coder (Band A) prompt
    const coderPrompt = buildKanbanBatchPrompt('coder', plans, { pairProgrammingEnabled: true });

    // Copy lead prompt to clipboard for the IDE agent
    await vscode.env.clipboard.writeText(leadPrompt);
    vscode.window.showInformationMessage('Band B prompt copied to clipboard. Dispatching Band A to Coder terminal...');

    // Auto-dispatch Band A to Coder terminal
    await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
    break;
}
```

- **No Coder terminal**: If `dispatchToCoderTerminal` finds no registered Coder terminal, it must surface a clear warning: `"Pair Program: no Coder terminal found. Please register a Coder terminal first."` — do not silently discard the prompt.
- **Column guard**: The button is only rendered for PLAN REVIEWED cards. The `pairProgramCard` handler also redundantly checks `card.column === 'PLAN REVIEWED'` as a safety net against stale UI state.
- **Edge case — low complexity card**: For a low-complexity card, the natural route would be Coder only. The Pair Program button always treats the card as a lead-initiated split regardless, and always applies Band B to clipboard and Band A to terminal. The prompt text makes the split explicit.

## Verification Plan
### Automated Tests
- `agentPromptBuilder.test.ts` — verify lead prompt includes Band A concurrency note and coder prompt includes "only do band a" when `pairProgrammingEnabled: true`
- `autobanState.test.ts` — verify `normalizeAutobanConfigState()` defaults `pairProgrammingEnabled` to `false`

### Manual Tests
1. **Header toggle — auto-dispatch**: Enable toggle, advance a high-complexity plan → Lead terminal opens with Band B note AND Coder terminal auto-opens with "only do band a" — no user action for Coder
2. **Header toggle — low-complexity plan**: Enable toggle, advance a low-complexity plan → only Coder dispatched (no auto-pair, not a lead dispatch)
3. **Header toggle — persistence**: Enable toggle, reload VS Code → toggle remains checked
4. **Header toggle — disabled**: Disable toggle, advance a plan → only Lead terminal, no pair note in prompt
5. **Per-card button — happy path**: Click "⚡ Pair Program" on a card → clipboard contains Band B lead prompt with concurrency note; Coder terminal receives Band A prompt automatically
6. **Per-card button — no Coder terminal**: Click button with no Coder terminal registered → warning notification shown, clipboard still populated with lead prompt
7. **Per-card button — IDE workflow**: Paste clipboard prompt into Windsurf/Antigravity IDE chat → confirm Band B note is present and actionable; confirm Coder terminal (e.g. Gemini CLI) ran Band A tasks
8. **Per-card button — independent of toggle**: Verify button works even when header Pair Programming toggle is OFF

### Verification Commands
```bash
npm run compile
npm test
```

## Recommendation
**Send to Lead Coder**

Band B complexity: the per-card button combines two dispatch mechanisms (clipboard write + terminal dispatch) in a single atomic handler; the header toggle threads mode state through multiple dispatch paths; both features require coordinating with the existing terminal management and prompt builder systems.
