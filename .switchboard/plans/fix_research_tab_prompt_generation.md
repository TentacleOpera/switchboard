# Fix Research Tab Prompt Generation in planning.html

## Goal

Fix the Research Tab in `planning.html` so that both the **"Copy Prompt Template"** and **"Draft with Analyst Agent"** buttons generate and copy to clipboard a meta-prompt intended for the user's IDE agent. The IDE agent meta-prompt must instruct the agent to *draft* a detailed research prompt for Google AI Studio, not to *perform* the research itself.

## Problem Analysis

### Background
The Switchboard Research Tab is a 3-step workflow:
1. Draft a research prompt (via IDE agent)
2. Run the research in Google AI Studio
3. Import the results back into the workspace

### Root Cause
The Step 1 implementation is broken in two places:

1. **`generateResearchPrompt()` in `planning.js`** (line 3976) generates a direct research execution prompt (`ROLE: You are a research analyst... CENTRAL QUESTION: ... DEPTH: Deep...`). This prompt instructs the receiver to *perform* deep research. It is not a meta-prompt that asks an IDE agent to *draft* a research prompt. If the user pastes this into an IDE agent, the agent will attempt to execute the research instead of returning a Google AI Studio prompt.

2. **The "Draft with Analyst Agent" button** auto-dispatches to a terminal via `vscode.postMessage({ type: 'draftResearchPrompt' })` → `PlanningPanelProvider.ts:1624` → `handleSendToAnalystFromPlanningPanel`. The dispatched prompt (`Read .agent/skills/draft_research_prompt.md...`) assumes the IDE agent can read local skill files, which is unreliable. Worse, the user never sees the dispatched prompt, and there is no mechanism to capture the analyst agent's output and surface it back in the UI. The user is left blind.

The skill file `.agent/skills/draft_research_prompt.md` itself is correct — it explicitly says *"Do NOT perform the research yourself — you are only drafting the prompt"* — but the calling code bypasses the user's control and relies on fragile file-system dependencies.

## Metadata

**Tags:** frontend, bugfix, ui
**Complexity:** 3

## User Review Required

- Confirm both buttons should produce identical meta-prompt output (no "enhanced" variant for the Analyst button).
- Confirm the `.agent/skills/draft_research_prompt.md` skill file should be preserved for manual skill invocation (only the programmatic auto-dispatch path is removed).

## Complexity Audit

### Routine
- Rewrite `generateResearchPrompt()` to return a meta-prompt instead of a direct research prompt — single function, template swap
- Change "Draft with Analyst Agent" button handler from `postMessage` to clipboard write — 5-line handler swap
- Update UI description text in `planning.html` — single string change
- Remove dead message handlers in `planning.js` — delete `analystAvailabilityResult` and `draftResearchPromptResult` cases
- Remove `checkAnalystAvailability()` function and its call in `planning.js`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Both buttons are synchronous clipboard writes; no async dispatch.
- **Security:** Clipboard write is user-initiated; no injection risk. Removing auto-dispatch to terminal *reduces* attack surface (no more `_dispatchExecuteMessage` call with user-provided topic).
- **Side Effects:** Removing `checkAnalystAvailability` pipeline means the Draft button no longer checks for analyst terminal availability — correct, since the button no longer dispatches to a terminal.
- **Dependencies & Conflicts:** The `sendToAnalyst` case in `PlanningPanelProvider.ts:1594-1622` is also dead code (no webview dispatches it), but it is outside the scope of this fix. Noted for future cleanup.

## Dependencies

None.

## Adversarial Synthesis

Key risks: wrong file reference in original plan (function is in `TaskViewerProvider.ts`, not `PlanningPanelProvider.ts`), incomplete dead-code cleanup (missing `checkAnalystAvailability` pipeline), and empty-topic guard ambiguity. Mitigations: corrected file paths, added full cleanup scope, specified guard location in button handlers.

## Requirements

1. Both buttons must **copy to clipboard** (not auto-dispatch to a terminal).
2. The copied text must be a **meta-prompt** for the user's IDE agent.
3. The meta-prompt must explicitly instruct the IDE agent to **draft a Google AI Studio research prompt** and **not perform the research itself**.
4. The meta-prompt must include the user's topic from the `#research-prompt-input` textarea.
5. The output must be a clean, copy-pasteable prompt that the user can paste into any IDE agent (Cascade, Claude, Copilot, etc.).
6. Remove the dead auto-dispatch code for `draftResearchPrompt` since it will no longer be used.
7. Remove the dead `checkAnalystAvailability` pipeline since the Draft button no longer needs to check for analyst terminal availability.
8. Both buttons must produce **identical** output from `generateResearchPrompt()` — no variant or "enhanced" version.

## Edge Cases

- **Empty topic:** If the topic textarea is empty, the button handler should show a brief visual warning (e.g. flash "NO TOPIC" on the button) and NOT write to clipboard. The guard belongs in the button click handlers, not in `generateResearchPrompt()` which already returns `''` for empty input.
- **Clipboard permission denied:** The copy handler already catches this and shows "FAILED" — this behavior should be preserved.
- **Analyst terminal not registered:** With auto-dispatch removed, this becomes irrelevant.

## Risks

- **Low:** The change is localized to the Research Tab UI and does not affect Kanban, planning cards, or other tabs.
- **Low:** Removing the `draftResearchPrompt` message handler and `handleSendToAnalystFromPlanningPanel` path removes unused code; no other callers exist.
- **Low:** Removing `checkAnalystAvailability` pipeline removes code that only served the now-removed auto-dispatch feature.

## Implementation Plan

### Phase 1: Rewrite `generateResearchPrompt()` in `planning.js`

**File:** `src/webview/planning.js:3976-4022`

Rewrite the function to return an IDE-agent meta-prompt instead of a direct research execution prompt.

The meta-prompt structure should be:
```
You are helping me draft a research prompt for Google AI Studio with search grounding enabled.

TOPIC: <user's topic>

Please draft a comprehensive research prompt optimized for Google AI Studio. The drafted prompt should include:
- ROLE definition for the research analyst
- CONTEXT describing the domain and audience
- CENTRAL QUESTION
- 4-6 targeted SUB-QUESTIONS
- SOURCE GUIDANCE (authoritative sources, date-checking, separate required/recommended/opinion)
- SCOPE boundaries
- OUTPUT format (executive summary, tiered findings, trade-off evaluation, glossary, source list)
- DEPTH level with source count target

Do NOT perform the research yourself. Only draft the prompt text that I will paste into Google AI Studio.

Return ONLY the drafted prompt with no additional commentary.
```

Keep the structured-prompt detection (`STRUCTURED_PROMPT_RE`) — if the user has already pasted a structured prompt, return it as-is.

### Phase 2: Change "Draft with Analyst Agent" button to copy to clipboard

**File:** `src/webview/planning.js:401-418`

Replace the `vscode.postMessage({ type: 'draftResearchPrompt', ... })` call with a clipboard write using the same `generateResearchPrompt()` output. The button should show "COPIED" / "FAILED" / "NO TOPIC" feedback just like the Copy Prompt Template button.

Both buttons must produce identical output — call `generateResearchPrompt()` in both handlers.

Add empty-topic guard: if `generateResearchPrompt()` returns `''`, flash "NO TOPIC" on the button and return without writing to clipboard. Apply the same guard to the existing "Copy Prompt Template" button handler at line 380.

### Phase 3: Remove dead auto-dispatch code

**Files and locations:**

- `src/services/PlanningPanelProvider.ts:1624-1661` — Remove the `draftResearchPrompt` message case (lines 1624-1661, from `case 'draftResearchPrompt':` through `break;`).
- `src/services/PlanningPanelProvider.ts:1577-1592` — Remove the `checkAnalystAvailability` message case (lines 1577-1592, from `case 'checkAnalystAvailability':` through `break;`).
- `src/services/TaskViewerProvider.ts:6422-6452` — Remove `handleSendToAnalystFromPlanningPanel` method.
- `src/extension.ts:1123-1134` — Remove the `switchboard.sendToAnalystFromPlanningPanel` command registration.
- `src/extension.ts:1136-1147` — Remove the `switchboard.checkAnalystAvailability` command registration.
- `src/webview/planning.js:3512-3522` — Remove the `analystAvailabilityResult` message handler case.
- `src/webview/planning.js:3524-3534` — Remove the `draftResearchPromptResult` message handler case.
- `src/webview/planning.js:435-440` — Remove the `checkAnalystAvailability()` function definition and its call.
- `src/services/agentPromptBuilder.ts:795-811` — Remove the `if (options?.instruction === 'draft-research-prompt')` branch under the analyst role. Only caller was the removed `draftResearchPrompt` handler in PlanningPanelProvider.ts.
- `src/services/agentPromptBuilder.ts:147-150` — Remove `researchTopic` and `researchContext` properties from the `PromptBuilderOptions` interface (only used by the removed `draft-research-prompt` branch).

**Note:** The `sendToAnalyst` case in `PlanningPanelProvider.ts:1594-1622` is also dead code (no webview dispatches it), but is outside the scope of this fix. Flag for future cleanup.

### Phase 4: Clean up UI text

**File:** `src/webview/planning.html:3117`

Update the description from:
> "Send instructions to IDE-agent to draft a detailed research prompt for you."

To:
> "Copy a meta-prompt to your clipboard. Paste it into your IDE agent to draft a detailed research prompt for Google AI Studio."

### Phase 5: Verification

1. Open the Research Tab in Switchboard.
2. Leave the topic textarea empty. Click **"Copy Prompt Template"** — verify button flashes "NO TOPIC" and clipboard is NOT written.
3. Enter a topic like "Kubernetes security best practices 2025".
4. Click **"Copy Prompt Template"** — verify clipboard contains a meta-prompt (starts with "You are helping me draft..."), not a direct research execution prompt.
5. Click **"Draft with Analyst Agent"** — verify it also copies the SAME meta-prompt to clipboard, not auto-dispatches to a terminal.
6. Paste the meta-prompt into an IDE agent and confirm it replies with a structured Google AI Studio prompt, not by attempting to perform web searches.
7. Verify no console errors related to `draftResearchPrompt`, `analystAvailabilityResult`, or `checkAnalystAvailability`.

## Verification Plan

### Automated Tests

- Skip automated tests per session directive. Manual verification via the steps above.

## Files Changed

- `src/webview/planning.js` — rewrite `generateResearchPrompt()`, change Draft button handler, add empty-topic guard to both buttons, remove `checkAnalystAvailability()` function/call, remove `analystAvailabilityResult` and `draftResearchPromptResult` handlers
- `src/webview/planning.html` — update Research Tab description text
- `src/services/PlanningPanelProvider.ts` — remove `draftResearchPrompt` and `checkAnalystAvailability` message cases
- `src/services/TaskViewerProvider.ts` — remove `handleSendToAnalystFromPlanningPanel` method
- `src/extension.ts` — remove `sendToAnalystFromPlanningPanel` and `checkAnalystAvailability` command registrations
- `src/services/agentPromptBuilder.ts` — remove `draft-research-prompt` branch and `researchTopic`/`researchContext` interface properties

## Status

**Executed** — All phases implemented. Both buttons now copy the same IDE-agent meta-prompt to clipboard. Empty-topic guard flashes "NO TOPIC". Dead auto-dispatch code removed across `planning.js`, `planning.html`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`, `extension.ts`, and `agentPromptBuilder.ts`.

## Recommendation

Complexity 3 → **Send to Intern**
