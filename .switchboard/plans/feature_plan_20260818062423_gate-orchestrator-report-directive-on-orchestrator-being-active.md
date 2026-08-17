# Gate orchestrator report directive on orchestrator being active

## Goal

The `ORCHESTRATOR_REPORT_DIRECTIVE` — a multi-line instruction telling agents to post report files to `.switchboard/orchestrator/reports/` — is appended to every dispatch prompt unconditionally, even when no orchestrator is running. Additionally, the Coding team's `headPrompt` contains a hardcoded orchestrator report instruction in its standing order text. When no orchestrator is active, these instructions are noise: the reports go to a directory nobody reads, confusing the agent and wasting tokens.

### Problem Analysis & Root Cause

There are **two sources** of orchestrator report instructions that reach a team lead:

**Source 1: `ORCHESTRATOR_REPORT_DIRECTIVE` (programmatic append)**

`ensureDispatchProtocolDirectives` in `agentPromptBuilder.ts` (line 1006) unconditionally appends both `CODING_COMPLETION_REPORT_DIRECTIVE` and `ORCHESTRATOR_REPORT_DIRECTIVE` to every dispatch prompt. It is called at:

- `TaskViewerProvider.ts:557` — when a `dispatch` payload is present in `ptySendPrompt` (the extension host delivery chokepoint)
- `bootstrap.ts:278` — same, in the standalone host delivery chokepoint
- `agentPromptBuilder.ts:1781` — reviewer base instructions during board dispatch composition
- `agentPromptBuilder.ts:1906` — lead base instructions during board dispatch composition
- Plus 3 more board composition sites (coder, intern, planner) — 7 total, pinned by the contract test

None of these call sites check whether an orchestrator is actually armed. The directive says "Post a report file to .switchboard/orchestrator/reports/ when you finish, when you are blocked, when you have a question, and when asked for status" — but when no orchestrator is running, nobody consumes those reports. The agent spends tokens writing report files that vanish.

**Source 2: Coding team `headPrompt` (hardcoded standing order text)**

`NEW_CODING_HEAD_PROMPT` in `teamWiring.ts` (line 279) and the mirrored `headPrompt` in `kanban.html` (line 4682) both contain: "Post a status report to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report when the feature is handed to review." This is a `team-head`-scoped standing order, delivered to the lead on every message — not just dispatches. It is static text that cannot be conditionally rendered.

**The orchestrator-active signal exists but is not used.**

`TaskViewerProvider.isOversightAgentRunning()` (line 1419) returns `true` only when `automationMode === 'agent-managed' && enabled === true`. The standalone host has the same check via `taskViewerProvider.isOversightAgentRunning()`. But neither `ensureDispatchProtocolDirectives` nor `PromptBuilderOptions` carries an `orchestratorActive` flag — the function signature has no parameter for it, and no caller passes it.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability, refactor
**Project:** Browser Switchboard

## Complexity Audit

**Routine (text + flag threading):**
- Adding an `orchestratorActive` boolean to `PromptBuilderOptions` is a one-field interface change.
- Gating `ensureOrchestratorReportDirective` on the flag is a one-line conditional.
- Threading the flag from the two delivery chokepoints (`TaskViewerProvider.ts:557`, `bootstrap.ts:278`) to the directive append is a small change — both hosts have `isOversightAgentRunning()` in scope.
- Threading the flag through the 7 board composition sites in `agentPromptBuilder.ts` is mechanical — `buildKanbanBatchPrompt` already receives `PromptBuilderOptions`, so the flag flows through naturally.

**Moderate risk (tests + migration):**
- The contract test at `orchestrator-tick-and-reports-contract.test.js:373` asserts `ensureCompletionDirective` and `ensureOrchestratorReportDirective` have no callers outside the bundle, and that `ensureDispatchProtocolDirectives` has ≥7 occurrences in the builder. The gating change must not break these — the functions still exist and are still called; the gating is inside `ensureDispatchProtocolDirectives`, not a new external caller.
- The test at `seat-safeguards-fleet-prompt-path.test.js:943` asserts `ensureDispatchProtocolDirectives(raw)` attaches both directives. This test calls the function with no options — the default must remain "append both" (backward-compatible: `orchestratorActive` defaults to `true` when absent, so existing tests and callers that don't pass the flag are unaffected). The gating only fires when `orchestratorActive` is explicitly `false`.
- The Coding team `headPrompt` text change requires a third migration recogniser (installs that already migrated to the current `NEW_CODING_HEAD_PROMPT` with the orchestrator report instruction need to be recognised and updated). This is the same pattern as the existing `OLD_CODING_HEAD_PROMPT` → `NEW_CODING_HEAD_PROMPT` migration.
- `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js` must be updated to match, plus the client-side migration path.

## Edge-Case & Dependency Audit

1. **Default behavior unchanged.** `orchestratorActive` defaults to `true` when absent/undefined. This means: existing callers that don't pass the flag get the current behavior (directive always appended). Only callers that explicitly pass `false` suppress the directive. This keeps backward compatibility and avoids breaking tests that call `ensureDispatchProtocolDirectives` directly.
2. **Standalone host access to orchestrator state.** `deliverPrompt` in `bootstrap.ts` is defined inside the same closure as `taskViewerProvider`, so `taskViewerProvider.isOversightAgentRunning()` is in scope. No new wiring needed.
3. **Extension host access to orchestrator state.** `TaskViewerProvider._ptyHostVerb` (the handler that calls `ensureDispatchProtocolDirectives` at line 557) is a method on `TaskViewerProvider` itself, so `this.isOversightAgentRunning()` is in scope.
4. **Board dispatch composition.** `buildKanbanBatchPrompt` in `agentPromptBuilder.ts` receives `PromptBuilderOptions`. The caller (`KanbanProvider.buildDispatchPrompt`) constructs the options object — it needs to pass `orchestratorActive`. `KanbanProvider` does not currently import or call `isOversightAgentRunning()`. The flag must be threaded from `KanbanProvider`'s caller (which is `TaskViewerProvider` in the extension host, or the standalone dispatch path). `KanbanProvider` already receives `overrides?: Partial<PromptBuilderOptions>` — the caller can pass `orchestratorActive` through this.
5. **HeadPrompt orchestrator instruction removal.** Removing "Post a status report to .switchboard/orchestrator/reports/..." from the Coding team `headPrompt` is safe because the `ORCHESTRATOR_REPORT_DIRECTIVE` already covers this when the orchestrator IS active — it is appended to dispatch prompts and tells agents to post reports. The headPrompt's version was redundant with the directive.
6. **Migration chain.** Three generations of headPrompt text now exist: `OLD_CODING_HEAD_PROMPT` (pre-rewrite), `NEW_CODING_HEAD_PROMPT` (current, with orchestrator instruction), and the corrected text (without orchestrator instruction). The migration must recognise both old versions and update to the new one. The existing `isUntouchedOldCodingTeam` recogniser matches `OLD_CODING_HEAD_PROMPT`; a new recogniser must match `NEW_CODING_HEAD_PROMPT` (the current text) and replace it with the corrected text.
7. **Contract test substring assertions.** The test at `standing-orders-marker-contract.test.js:369-376` asserts the headPrompt includes `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. The orchestrator report instruction removal does not affect any of these substrings. The test also asserts exactly 1 `headPrompt` exists (Coding only) — unchanged.
8. **Report files still useful when orchestrator is active.** The `ORCHESTRATOR_REPORT_DIRECTIVE` is the orchestrator's visibility channel — it tells agents to post status/blocked/finished reports to a directory the orchestrator reads. Suppressing it when the orchestrator is off is correct; suppressing it when on would break the orchestrator's feedback loop.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — `PromptBuilderOptions` (line 153)

Add the `orchestratorActive` field:

```typescript
/**
 * When false, the ORCHESTRATOR_REPORT_DIRECTIVE is suppressed (no orchestrator
 * is running to consume the reports). Defaults to true (backward-compatible:
 * callers that don't pass the flag get the current behavior). The
 * COMPLETION_REPORT_DIRECTIVE is always appended regardless of this flag.
 */
orchestratorActive?: boolean;
```

### `src/services/agentPromptBuilder.ts` — `ensureDispatchProtocolDirectives` (line 1006)

Gate the orchestrator report directive on the flag:

```typescript
// BEFORE:
export function ensureDispatchProtocolDirectives(text: string): string {
    return ensureOrchestratorReportDirective(ensureCompletionDirective(text));
}

// AFTER:
export function ensureDispatchProtocolDirectives(text: string, orchestratorActive = true): string {
    const withCompletion = ensureCompletionDirective(text);
    if (!orchestratorActive) {
        return withCompletion;
    }
    return ensureOrchestratorReportDirective(withCompletion);
}
```

### `src/services/agentPromptBuilder.ts` — board composition sites (7 sites)

Each of the 7 `ensureDispatchProtocolDirectives(baseInstructions)` call sites in `buildKanbanBatchPrompt` needs to pass the flag:

```typescript
// Before each site:
baseInstructions = ensureDispatchProtocolDirectives(baseInstructions);

// After:
baseInstructions = ensureDispatchProtocolDirectives(baseInstructions, options?.orchestratorActive !== false);
```

The `options?.orchestratorActive !== false` form means: `true` when absent (default) or explicitly `true`; `false` only when explicitly `false`. This preserves backward compatibility.

### `src/services/TaskViewerProvider.ts` — ptySendPrompt dispatch path (line 557)

Pass the orchestrator state:

```typescript
// BEFORE:
payload = { ...payload, data: ensureDispatchProtocolDirectives(payload.data) };
directivesAttached = ['COMPLETION REPORT', 'ORCHESTRATOR REPORT'];

// AFTER:
const orchestratorActive = this.isOversightAgentRunning();
payload = { ...payload, data: ensureDispatchProtocolDirectives(payload.data, orchestratorActive) };
directivesAttached = orchestratorActive
    ? ['COMPLETION REPORT', 'ORCHESTRATOR REPORT']
    : ['COMPLETION REPORT'];
```

### `src/standalone/bootstrap.ts` — deliverPrompt dispatch path (line 278)

Pass the orchestrator state:

```typescript
// BEFORE:
if (dispatch && typeof dispatch === 'object') {
    out = ensureDispatchProtocolDirectives(out);
}

// AFTER:
if (dispatch && typeof dispatch === 'object') {
    const orchestratorActive = taskViewerProvider?.isOversightAgentRunning() ?? true;
    out = ensureDispatchProtocolDirectives(out, orchestratorActive);
}
```

### `src/services/KanbanProvider.ts` — `buildDispatchPrompt` (line ~5095)

Thread the flag through `resolvedOptions`:

```typescript
const resolvedOptions: PromptBuilderOptions = {
    // ... existing fields ...
    orchestratorActive: overrides?.orchestratorActive,
};
```

The caller (`TaskViewerProvider` dispatch path) passes `orchestratorActive` via `overrides`:

```typescript
// In TaskViewerProvider's dispatch call:
const overrides: Partial<PromptBuilderOptions> = {
    // ... existing overrides ...
    orchestratorActive: this.isOversightAgentRunning(),
};
```

### `src/services/teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (line 275)

Remove the orchestrator report instruction from the headPrompt. The corrected text removes the sentence "Post a status report to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report when the feature is handed to review." The `ORCHESTRATOR_REPORT_DIRECTIVE` already covers this when the orchestrator is active.

```typescript
export const NEW_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. When a seat fails '
    + 'review on the same subtask twice, '
    + 'do not send that subtask to it a third time — escalate one rung along intern → coder → lead, '
    + 'name the specific defects in the dispatch, and say in your status report which seat you moved '
    + 'it to and why; if the seat that failed twice is a lead, or your team has no seat above it, '
    + 'stop and report to the human instead of dispatching again. When a coder reports a subtask '
    + 'finished, note it and give that coder the next subtask. Do not send anything to the '
    + 'reviewer, and do not write review instructions — that is not your job. When every subtask of '
    + 'the feature is finished, read the port from .switchboard/api-server-port.txt, confirm no '
    + 'subtask is still outstanding via GET /kanban/feature, then make one call: POST /kanban/dispatch with '
    + '{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}"} — '
    + 'that one call moves the card and dispatches the reviewer with the reviewer\'s own '
    + 'prompt. Do NOT use /kanban/move: it moves the card and dispatches nobody. Only '
    + 'advance the feature your team worked; leave other cards alone. Do not wait to be '
    + 'asked.';
```

**Note:** This plan addresses ONLY the orchestrator report instruction removal. The API endpoint errors (`GET /kanban/feature`, missing `workspaceRoot`) and the rotation rule ("give that coder the next subtask") in the same headPrompt are addressed by a separate plan (`feature_plan_20260818000513_fix-coding-team-head-standing-order-api-errors-and-rotation-rule.md`). If both plans are implemented, the final headPrompt text should incorporate both sets of corrections. If this plan is implemented first, the headPrompt keeps the API errors and rotation rule for the other plan to fix.

### `src/services/teamWiring.ts` — migration recogniser for current headPrompt

Add a recogniser for installs that already have the current `NEW_CODING_HEAD_PROMPT` (with the orchestrator report instruction) and replace it with the corrected text (without the instruction). Same pattern as the existing `isUntouchedOldCodingTeam`:

```typescript
/**
 * The current (pre-this-fix) Coding team headPrompt — contains the orchestrator
 * report instruction that this plan removes. The migration recogniser matches
 * against this exact value and replaces it with the corrected text.
 */
export const PRE_ORCHESTRATOR_FIX_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Post a status report '
    + 'to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report '
    + 'when the feature is handed to review. When a seat fails review on the same subtask twice, '
    + 'do not send that subtask to it a third time — escalate one rung along intern → coder → lead, '
    + 'name the specific defects in the dispatch, and say in your status report which seat you moved '
    + 'it to and why; if the seat that failed twice is a lead, or your team has no seat above it, '
    + 'stop and report to the human instead of dispatching again. When a coder reports a subtask '
    + 'finished, note it and give that coder the next subtask. Do not send anything to the '
    + 'reviewer, and do not write review instructions — that is not your job. When every subtask of '
    + 'the feature is finished, read the port from .switchboard/api-server-port.txt, confirm no '
    + 'subtask is still outstanding via GET /kanban/feature, then make one call: POST /kanban/dispatch with '
    + '{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}"} — '
    + 'that one call moves the card and dispatches the reviewer with the reviewer\'s own '
    + 'prompt. Do NOT use /kanban/move: it moves the card and dispatches nobody. Only '
    + 'advance the feature your team worked; leave other cards alone. Do not wait to be '
    + 'asked.';
```

Add the recogniser in `migrateAgentGroups`:

```javascript
function isUntouchedPreOrchestratorFixCodingTeam(g: any): boolean {
    return typeof g.headPrompt === 'string'
        && g.headPrompt === PRE_ORCHESTRATOR_FIX_CODING_HEAD_PROMPT;
}
```

And in the migration loop:

```javascript
if (isUntouchedPreOrchestratorFixCodingTeam(g)) {
    g = { ...g, headPrompt: NEW_CODING_HEAD_PROMPT };
    changed = true;
    console.log(
        `[teamWiring] Migration: removed orchestrator report instruction from Coding team headPrompt `
        + `'${g.id || g.name}'.`
    );
}
```

### `src/webview/kanban.html` — Coding team `headPrompt` (line 4679)

Remove the orchestrator report instruction sentence from the `headPrompt` string, matching the corrected `NEW_CODING_HEAD_PROMPT` above.

### `src/webview/terminals.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` (line 8877)

Update the client-side mirror to match the corrected text. Add a `PRE_ORCHESTRATOR_FIX_CODING_HEAD_PROMPT_CLIENT` mirror for the client-side migration path. Update `migrateTeamPairOrdersClient` to recognise the old text and replace it.

### `src/test/seat-safeguards-fleet-prompt-path.test.js` — update test (line 943)

The existing test calls `ensureDispatchProtocolDirectives(raw)` with no options — the default (`orchestratorActive = true`) means both directives are still appended. The test passes unchanged. Add a new test for the gated behavior:

```javascript
test('BEHAVIOUR: ensureDispatchProtocolDirectives suppresses orchestrator report when orchestratorActive=false', () => {
    const raw = 'Please write the code according to the plan.';
    const formatted = ensureDispatchProtocolDirectives(raw, false);
    assert.ok(formatted.includes('COMPLETION REPORT:'), 'must still attach completion directive');
    assert.ok(!formatted.includes('ORCHESTRATOR REPORT:'), 'must NOT attach orchestrator report directive when orchestratorActive=false');

    // Default (no flag) still attaches both
    const defaultFormatted = ensureDispatchProtocolDirectives(raw);
    assert.ok(defaultFormatted.includes('ORCHESTRATOR REPORT:'), 'must attach orchestrator report directive by default');
});
```

### `src/test/orchestrator-tick-and-reports-contract.test.js` — update assertions

The test at line 397-399 asserts `ensureDispatchProtocolDirectives` has ≥7 occurrences in the builder. The gating change does not add or remove occurrences — the function is still called at the same 7 sites. The test passes unchanged.

The test at line 373-395 asserts no callers outside the bundle call `ensureOrchestratorReportDirective` directly. The gating change is inside `ensureDispatchProtocolDirectives` (the bundle), not a new external caller. The test passes unchanged.

## Verification Plan

1. **No orchestrator, no directive.** With no orchestrator armed, dispatch a plan to a coder via the board. Confirm the prompt does NOT contain `ORCHESTRATOR REPORT:`. Confirm it still contains `COMPLETION REPORT:`.
2. **Orchestrator armed, directive present.** Start the orchestrator (AUTOMATION tab → Start orchestrator → confirm). Dispatch a plan to a coder. Confirm the prompt DOES contain `ORCHESTRATOR REPORT:`.
3. **Default behavior unchanged.** Call `ensureDispatchProtocolDirectives('test')` with no second argument. Confirm both directives are appended (backward compatibility).
4. **HeadPrompt no longer mentions orchestrator reports.** Start a Coding team. Inspect the lead's standing order (via the standing-orders editor). Confirm the headPrompt does NOT contain "orchestrator/reports" or "status report to .switchboard/orchestrator".
5. **Migration: old headPrompt → corrected.** Create an install with `OLD_CODING_HEAD_PROMPT` in the agent group. Run `migrateAgentGroups`. Confirm the headPrompt is replaced with the corrected text (no orchestrator report instruction).
6. **Migration: current headPrompt → corrected.** Create an install with the current `NEW_CODING_HEAD_PROMPT` (with orchestrator report instruction). Run `migrateAgentGroups`. Confirm the headPrompt is replaced with the corrected text.
7. **Migration: operator-edited team untouched.** Create an install with a headPrompt that differs from both old versions by one character. Run `migrateAgentGroups`. Confirm the headPrompt is NOT changed.
8. **Standalone host.** In the standalone host with no orchestrator armed, dispatch a plan via the board. Confirm the prompt does NOT contain `ORCHESTRATOR REPORT:`.
9. **Run tests.** `npx jest src/test/seat-safeguards-fleet-prompt-path.test.js src/test/orchestrator-tick-and-reports-contract.test.js src/test/standing-orders-marker-contract.test.js` — confirm all pass, including the new gated-behavior test.
