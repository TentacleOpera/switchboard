# Fix coding team head standing order: API errors and rotation rule

## Goal

Fix five defects in the Coding team's head prompt (`headPrompt`) and gate the `ORCHESTRATOR_REPORT_DIRECTIVE` on the orchestrator being active. Four defects were reported by a coding team lead (failed API calls, lost near-complete subtask); the fifth is a redundant hardcoded orchestrator report instruction that wastes tokens when no orchestrator is running. The head prompt is the `team-head`-scoped standing order installed on the lead terminal; it tells the lead how to dispatch subtasks, when to escalate, and how to hand the finished feature to review.

### Problem Analysis & Root Cause

The head prompt text is defined in three places that must stay in sync:
1. `teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (server-side, used for migration of old installs)
2. `kanban.html` — `SHIPPED_TEAM_TYPES` Coding team's `headPrompt` (client-side gallery definition)
3. `terminals.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` (client-side mirror, used for migration matching)

The current text contains five errors:

**Error 1: `GET /kanban/feature` is wrong — it is POST.**
The prompt says "confirm no subtask is still outstanding via GET /kanban/feature." But `/kanban/feature` is a POST endpoint that *creates* a feature (`LocalApiServer.ts:3854`: `pathname === '/kanban/feature' && req.method === 'POST'`). A GET to that path returns 404 (no GET handler registered). The correct endpoint for checking a feature's subtasks is `GET /kanban/plan?planId=<featurePlanId>` (`LocalApiServer.ts:2869`), which returns the plan record including its subtask list. Alternatively, `GET /kanban/features` (plural, line 3977) returns all features, but that is heavier and less precise.

**Error 2: `/kanban/feature` requires `name`, not `planId`.**
Even if the head tried POST instead of GET, the body schema is `{ name: string, planIds: string[], ... }` (line 1545), not `{ plan: planId }`. The head would get a validation error. This confirms the endpoint reference is fundamentally wrong — the head needs a read endpoint, not a create endpoint.

**Error 3: `/kanban/dispatch` needs `workspaceRoot` in the body.**
The dispatch handler resolves `workspaceRoot` from `body?.workspaceRoot || this._options.workspaceRoot` (line 1223). In a fleet/standalone setup where the head's terminal runs inside a worktree, `this._options.workspaceRoot` may point to the main workspace, not the worktree the head is working in. The DB lookup `getKanbanDatabase(workspaceRoot)` then resolves the wrong DB (or none), and `getPlanByPlanId(ref)` returns null — "Plan not found for a planId that plainly exists." The head prompt must tell the head to include `workspaceRoot` in the dispatch body, which the head can obtain from `pwd` (its current working directory in the worktree).

**Error 4: "give that coder the next subtask" causes context-wall losses.**
The prompt says "When a coder reports a subtask finished, note it and give that coder the next subtask." This instructs the head to stack subtasks on the same coder until that coder hits its context window limit. The reporting team lead ran subtasks 2 and 3 through the same coder until it hit its context wall, then misread the in-progress work as a stall and cleared it four minutes from done. The fix: replace "give that coder the next subtask" with "dispatch the next subtask to an idle seat that has not already worked on it" — spreading subtasks across available seats and avoiding context-wall buildup. The durable rule is: one subtask per cleared seat before rotation.

**Error 5: Hardcoded orchestrator report instruction wastes tokens when no orchestrator is running.**
The headPrompt contains "Post a status report to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report when the feature is handed to review." This is a static standing-order text that cannot be conditionally rendered. When no orchestrator is active, the reports go to a directory nobody reads — confusing the agent and wasting tokens. Separately, the `ORCHESTRATOR_REPORT_DIRECTIVE` is appended to every dispatch prompt unconditionally by `ensureDispatchProtocolDirectives` (`agentPromptBuilder.ts:1006`), even when no orchestrator is running. The fix has two parts: (a) remove the hardcoded instruction from the headPrompt (the `ORCHESTRATOR_REPORT_DIRECTIVE` already covers this when the orchestrator IS active), and (b) gate `ensureDispatchProtocolDirectives` on an `orchestratorActive` flag threaded from `isOversightAgentRunning()`.

## Metadata

**Complexity:** 6
**Tags:** bugfix, backend, frontend, reliability, refactor
**Project:** Browser Switchboard

## User Review Required

Not required — the plan fixes four identified bugs in the head prompt text with a clear migration strategy. Proceed with implementation.

## Complexity Audit

### Routine
- The four fixes are text edits to the head prompt string in three files.
- No logic changes, no new endpoints, no schema changes.

### Complex / Risky
- `NEW_CODING_HEAD_PROMPT` in `teamWiring.ts` is the migration target — the migration recogniser (`isUntouchedOldCodingTeam`) matches against `OLD_CODING_HEAD_PROMPT`, not the new one. Changing `NEW_CODING_HEAD_PROMPT` does NOT affect migration matching (old installs still match against `OLD_CODING_HEAD_PROMPT`). But installs that already migrated to the current `NEW_CODING_HEAD_PROMPT` will NOT re-migrate to the corrected text — their standing orders carry the old (buggy) new prompt. A second migration recogniser is needed for this.
- `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js` is the client-side mirror used for migration matching. It must match the server-side `NEW_CODING_HEAD_PROMPT` exactly (the contract test pins substring assertions).
- The `standing-orders-marker-contract.test.js` pins substring assertions on the head prompt: it must include `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. The corrected text must still include all four.
- **CRITICAL**: The contract test also asserts byte-identity between `kanban.html` and `teamWiring.ts` (line 408) and that both carry the `queueNextSentence` (lines 416-428). The current `NEW_CODING_HEAD_PROMPT` ends with a queue/next paragraph ("When the reviewer reports the feature passed, POST /kanban/queue/next..."). The corrected text MUST preserve this paragraph — dropping it would fail the contract test and remove the lead's pipeline-pacing instruction.
- The current `NEW_CODING_HEAD_PROMPT` also contains an "(or unattended: record the blocked card to .switchboard/orchestrator/reports/ and proceed to the next queue item)" clause (line 296-297) that the `CURRENT_BUGGY_CODING_HEAD_PROMPT` migration recogniser constant must include to match the actual text on disk.

**The second-migration problem:**
Installs that already migrated from `OLD_CODING_HEAD_PROMPT` to `NEW_CODING_HEAD_PROMPT` have the buggy text persisted in their standing orders. A new migration recogniser must match the current (buggy) `NEW_CODING_HEAD_PROMPT` and replace it with the corrected text. This is the same pattern as the old→new migration: exact-value match on the old text, replace with the new.

## Edge-Case & Dependency Audit

1. **Already-migrated installs.** Installs that migrated from `OLD_CODING_HEAD_PROMPT` to the current `NEW_CODING_HEAD_PROMPT` have the buggy text in their standing orders. A second migration recogniser (`isUntouchedCurrentCodingTeam`) must match the current `NEW_CODING_HEAD_PROMPT` exactly and replace it with the corrected text. The `OLD_CODING_HEAD_PROMPT` recogniser remains unchanged — it still catches installs that never migrated.
2. **Operator-edited teams.** An operator who edited the head prompt (any change from the exact shipped text) must NOT be migrated. The recogniser uses exact-value comparison, same as the existing pattern.
3. **Client-side migration.** `migrateTeamPairOrdersClient` in `terminals.js` runs at render time. The client-side `NEW_CODING_HEAD_PROMPT_CLIENT` must be updated to the corrected text, and the client-side migration must recognise the old (buggy) new prompt and replace it. This is the same client-side mirror pattern.
4. **Contract test assertions.** The test at `standing-orders-marker-contract.test.js:369-376` asserts the head prompt includes `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. The corrected text must still include all four. The `GET /kanban/feature` reference is NOT asserted by the test, so removing it is safe.
5. **workspaceRoot availability.** The head runs in a terminal whose CWD is the workspace or worktree root. `pwd` returns the absolute path. The head prompt must instruct the head to include `"workspaceRoot":"<output of pwd>"` in the dispatch body.
6. **GET /kanban/plan response shape.** The head needs to check whether subtasks are outstanding. `GET /kanban/plan?planId=<featurePlanId>` returns the plan record. The head must parse the response to check subtask statuses. The prompt should be concise about this — the head is an agent, not a human, and can parse JSON.

## Dependencies

- This plan absorbs the former sibling subtask `feature_plan_20260818062423` (gate orchestrator report directive). Both plans rewrote the same `NEW_CODING_HEAD_PROMPT` text in the same three files — they are now merged into this single plan with one unified corrected text and one migration recogniser. The `ensureDispatchProtocolDirectives` gating changes from the former sibling are included in the Proposed Changes above.
- The contract test at `standing-orders-marker-contract.test.js:408` asserts byte-identity between `kanban.html` and `teamWiring.ts` — all three copies must be updated in the same change.

## Adversarial Synthesis

Key risks: (1) The original corrected text DROPPED the queue/next paragraph that exists in the actual source and is pinned by the contract test (lines 416-428) — this would fail the test and remove the lead's pipeline-pacing instruction. **Fixed**: the merged corrected text preserves the queue/next paragraph. (2) The original `CURRENT_BUGGY_CODING_HEAD_PROMPT` migration recogniser constant did not match the actual current text on disk — it omitted both the queue/next paragraph and the "(or unattended:...)" clause, so the recogniser would never fire. **Fixed**: the constant now includes the full current text. (3) The former sibling subtask (gate orchestrator report directive) rewrote the same headPrompt with its own incompatible corrected text. **Fixed**: both plans are merged into this one, with a single unified corrected text and one migration recogniser. (4) The `ensureDispatchProtocolDirectives` gating defaults to `true` (backward-compatible) — existing callers and tests that don't pass the flag are unaffected. Mitigations: all risks are addressed in the merged plan.

## Proposed Changes

### Corrected head prompt text (all three files)

> **Superseded:** The original corrected text dropped the queue/next paragraph ("When the reviewer reports the feature passed, POST /kanban/queue/next...") that exists in the current `NEW_CODING_HEAD_PROMPT` and is pinned by the contract test at `standing-orders-marker-contract.test.js:416-428`.
> **Reason:** Dropping the queue/next paragraph would fail the contract test's byte-identity and queue/next-sentence assertions, and would remove the lead's pipeline-pacing instruction — the lead would never ask for the next card after a review pass.
> **Replaced with:** The corrected text below, which preserves the queue/next paragraph and also incorporates the orchestrator-report-instruction removal from the sibling subtask (merge).

The corrected `NEW_CODING_HEAD_PROMPT` / `headPrompt` / `NEW_CODING_HEAD_PROMPT_CLIENT` (incorporating both this plan's four fixes AND the sibling plan's orchestrator-report-instruction removal):

```
You lead this team. Your coders work the subtasks of one feature. Each subtask carries
a recommendedRole; dispatch it to a seat of that role on your team. If your team has
no such seat, dispatch to a coder and say why in your status report. When a seat fails
review on the same subtask twice, do not send that subtask to it a third time — escalate
one rung along intern → coder → lead, name the specific defects in the dispatch, and say
in your status report which seat you moved it to and why; if the seat that failed twice is
a lead, or your team has no seat above it, stop and report to the human instead of
dispatching again (or unattended: record the blocked card to .switchboard/orchestrator/reports/
and proceed to the next queue item). When a coder reports a subtask finished, note it and
dispatch the next subtask to an idle seat that has not already worked on it — do not stack
subtasks on the same coder, or it will hit its context limit mid-task. One subtask per
cleared seat before rotation. Do not send anything to the reviewer, and do not write review
instructions — that is not your job. When every subtask of the feature is finished, read the
port from .switchboard/api-server-port.txt, confirm no subtask is still outstanding via GET
/kanban/plan?planId=<the FEATURE planId>, then make one call: POST /kanban/dispatch with
{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}","workspaceRoot":
"<your current working directory — run pwd>"} — that one call moves the card and dispatches
the reviewer with the reviewer's own prompt. Do NOT use /kanban/move: it moves the card and
dispatches nobody. Only advance the feature your team worked; leave other cards alone. Do
not wait to be asked. When the reviewer reports the feature passed, POST /kanban/queue/next
with {"from":"{head}"} against the port in .switchboard/api-server-port.txt; if it returns
a dispatched card, work it; if it returns dispatched: null, report that the queue is empty
and stop.
```

**Summary of changes from the current text:**
1. `GET /kanban/feature` → `GET /kanban/plan?planId=<the FEATURE planId>` (correct endpoint + method)
2. Removed the implicit `planId` field reference for `/kanban/feature` (no longer relevant — using the correct read endpoint)
3. Added `"workspaceRoot":"<your current working directory — run pwd>"` to the `/kanban/dispatch` body
4. "give that coder the next subtask" → "dispatch the next subtask to an idle seat that has not already worked on it — do not stack subtasks on the same coder, or it will hit its context limit mid-task. One subtask per cleared seat before rotation."
5. Removed "Post a status report to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report when the feature is handed to review." (orchestrator report instruction — now gated by `orchestratorActive` flag in `ensureDispatchProtocolDirectives`, so the hardcoded standing-order copy is redundant noise when no orchestrator is running)
6. **Preserved** the queue/next paragraph (lines 306-309 in current source) — the original plan dropped this, which would fail the contract test and remove the lead's pipeline-pacing instruction.
7. **Preserved** the "(or unattended: record the blocked card to .switchboard/orchestrator/reports/ and proceed to the next queue item)" clause — this is the unattended-mode escalation path and must not be dropped.

### `src/services/teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (line 287)

Replace the constant value with the corrected text above. Keep `OLD_CODING_HEAD_PROMPT` unchanged (migration matching).

### `src/services/teamWiring.ts` — second migration recogniser

Add a new constant for the current (buggy) prompt and a recogniser that matches it. **The constant MUST be byte-identical to the current `NEW_CODING_HEAD_PROMPT` value** (teamWiring.ts:287-309), including the "(or unattended:...)" clause and the queue/next paragraph — an exact-value match that omits any clause will never fire.

```javascript
/**
 * The CURRENT (buggy) Coding team headPrompt — the text that the first migration
 * (OLD_CODING_HEAD_PROMPT → NEW_CODING_HEAD_PROMPT) wrote to disk. This is what
 * is on every install that already migrated. The second migration recogniser
 * matches against this exact value and replaces it with the corrected text.
 * MUST be byte-identical to the current NEW_CODING_HEAD_PROMPT (teamWiring.ts:287-309).
 */
export const CURRENT_BUGGY_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Post a status report '
    + 'to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report '
    + 'when the feature is handed to review. When a seat fails review on the same subtask twice, '
    + 'do not send that subtask to it a third time — escalate one rung along intern → coder → lead, '
    + 'name the specific defects in the dispatch, and say in your status report which seat you moved '
    + 'it to and why; if the seat that failed twice is a lead, or your team has no seat above it, '
    + 'stop and report to the human instead of dispatching again (or unattended: record the blocked '
    + 'card to .switchboard/orchestrator/reports/ and proceed to the next queue item). When a coder reports a subtask '
    + 'finished, note it and give that coder the next subtask. Do not send anything to the '
    + 'reviewer, and do not write review instructions — that is not your job. When every subtask of '
    + 'the feature is finished, read the port from .switchboard/api-server-port.txt, confirm no '
    + 'subtask is still outstanding via GET /kanban/feature, then make one call: POST /kanban/dispatch with '
    + '{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}"} — '
    + 'that one call moves the card and dispatches the reviewer with the reviewer\'s own '
    + 'prompt. Do NOT use /kanban/move: it moves the card and dispatches nobody. Only '
    + 'advance the feature your team worked; leave other cards alone. Do not wait to be '
    + 'asked. When the reviewer reports the feature passed, POST /kanban/queue/next with '
    + '{"from":"{head}"} against the port in .switchboard/api-server-port.txt; if it returns '
    + 'a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop.';
```

Add a recogniser in `migrateAgentGroups` (after the existing `isUntouchedOldCodingTeam` block):

```javascript
// Step 1c: convert an install that already migrated to the current (buggy)
// headPrompt. Exact-value match on CURRENT_BUGGY_CODING_HEAD_PROMPT; an
// operator-edited group does not match and is left alone.
if (isUntouchedCurrentCodingTeam(g)) {
    const convertedReviewerMembers = (Array.isArray(g.members) ? g.members : [])
        .map((m: any) => m); // no member changes — only the headPrompt is wrong
    g = {
        ...g,
        headPrompt: NEW_CODING_HEAD_PROMPT, // now the corrected text
        members: convertedReviewerMembers,
    };
    changed = true;
    console.log(
        `[teamWiring] Migration: corrected buggy Coding team headPrompt `
        + `'${g.id || g.name}' — API endpoint + workspaceRoot + rotation rule.`
    );
}
```

Add the recogniser function:

```javascript
function isUntouchedCurrentCodingTeam(g: any): boolean {
    return typeof g.headPrompt === 'string'
        && g.headPrompt === CURRENT_BUGGY_CODING_HEAD_PROMPT;
}
```

### `src/webview/kanban.html` — Coding team `headPrompt` (line 4680)

Replace the `headPrompt` value with the corrected text above.

### `src/webview/terminals.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` (line 8877)

Replace the constant value with the corrected text (must match `teamWiring.ts` exactly).

### `src/webview/terminals.js` — `CURRENT_BUGGY_CODING_HEAD_PROMPT_CLIENT`

Add a client-side mirror of `CURRENT_BUGGY_CODING_HEAD_PROMPT` for the client-side migration path. Update `migrateTeamPairOrdersClient` to recognise the buggy text and replace it with the corrected text in rendered standing orders.

### `src/test/standing-orders-marker-contract.test.js` — update assertions

The existing assertions (line 369-376) check for `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. These still pass with the corrected text. No assertion change needed for those.

The existing queue/next assertions (lines 416-428) check that both `teamWiring.ts` and `kanban.html` carry the `queueNextSentence`. The corrected text preserves this paragraph, so these assertions still pass. No change needed.

Add a new assertion that the corrected text no longer contains `GET /kanban/feature`:

```javascript
assert.ok(!headPrompt.includes('GET /kanban/feature'),
    'Coding headPrompt must NOT reference GET /kanban/feature — that is a POST create endpoint. '
    + 'Use GET /kanban/plan?planId= to check subtask status.');
assert.ok(headPrompt.includes('workspaceRoot'),
    'Coding headPrompt must include workspaceRoot in the /kanban/dispatch body — '
    + 'without it, fleet/worktree heads get "Plan not found".');
assert.ok(!headPrompt.includes('give that coder the next subtask'),
    'Coding headPrompt must NOT say "give that coder the next subtask" — '
    + 'stacking subtasks on the same coder causes context-wall losses.');
assert.ok(!headPrompt.includes('Post a status report to .switchboard/orchestrator/reports/'),
    'Coding headPrompt must NOT hardcode the orchestrator report instruction — '
    + 'it is now gated by the orchestratorActive flag in ensureDispatchProtocolDirectives.');
```

### `src/services/agentPromptBuilder.ts` — `PromptBuilderOptions` (line 153) — *merged from subtask 3*

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

### `src/services/agentPromptBuilder.ts` — `ensureDispatchProtocolDirectives` (line 1006) — *merged from subtask 3*

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

### `src/services/agentPromptBuilder.ts` — board composition call sites (6 sites) — *merged from subtask 3*

Each of the 6 `ensureDispatchProtocolDirectives(baseInstructions)` call sites in `buildKanbanBatchPrompt` needs to pass the flag:

```typescript
// Before each site:
baseInstructions = ensureDispatchProtocolDirectives(baseInstructions);

// After:
baseInstructions = ensureDispatchProtocolDirectives(baseInstructions, options?.orchestratorActive !== false);
```

The `options?.orchestratorActive !== false` form means: `true` when absent (default) or explicitly `true`; `false` only when explicitly `false`. This preserves backward compatibility.

### `src/services/TaskViewerProvider.ts` — ptySendPrompt dispatch path (line 554) — *merged from subtask 3*

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

### `src/standalone/bootstrap.ts` — deliverPrompt dispatch path (line 278) — *merged from subtask 3*

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

### `src/services/KanbanProvider.ts` — `buildDispatchPrompt` — *merged from subtask 3*

Thread the flag through `resolvedOptions`:

```typescript
const resolvedOptions: PromptBuilderOptions = {
    // ... existing fields ...
    orchestratorActive: overrides?.orchestratorActive,
};
```

The caller (`TaskViewerProvider` dispatch path) passes `orchestratorActive` via `overrides`:

```typescript
const overrides: Partial<PromptBuilderOptions> = {
    // ... existing overrides ...
    orchestratorActive: this.isOversightAgentRunning(),
};
```

### `src/test/seat-safeguards-fleet-prompt-path.test.js` — new gated-behavior test — *merged from subtask 3*

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

### `src/test/orchestrator-tick-and-reports-contract.test.js` — no change needed — *merged from subtask 3*

The test at line 397-399 asserts `ensureDispatchProtocolDirectives` has ≥7 occurrences in the builder. The gating change does not add or remove occurrences — the function is still called at the same sites. The test passes unchanged. The test at line 373-395 asserts no callers outside the bundle call `ensureOrchestratorReportDirective` directly. The gating change is inside `ensureDispatchProtocolDirectives` (the bundle), not a new external caller. The test passes unchanged.

## Verification Plan

1. **Correct endpoint.** Confirm the corrected head prompt references `GET /kanban/plan?planId=` and NOT `GET /kanban/feature`. Verify `GET /kanban/plan?planId=<id>` returns a plan record with subtask information.
2. **workspaceRoot in dispatch body.** Start a Coding team in a worktree. Have the lead call `POST /kanban/dispatch` with `"workspaceRoot":"$(pwd)"` in the body. Confirm the dispatch succeeds (no "Plan not found" error). Repeat without `workspaceRoot` and confirm it fails (reproducing the original bug).
3. **Rotation rule.** Confirm the corrected text says "dispatch the next subtask to an idle seat that has not already worked on it" and does NOT contain "give that coder the next subtask."
4. **Migration: old → corrected.** Create an install with `OLD_CODING_HEAD_PROMPT` in the agent group. Run `migrateAgentGroups`. Confirm the headPrompt is replaced with the corrected text (the old recogniser still fires, and the corrected text is the new target).
5. **Migration: buggy-new → corrected.** Create an install with the current `NEW_CODING_HEAD_PROMPT` (buggy text) in the agent group. Run `migrateAgentGroups`. Confirm the headPrompt is replaced with the corrected text (the new recogniser fires).
6. **Migration: operator-edited team untouched.** Create an install with a headPrompt that differs from both `OLD_CODING_HEAD_PROMPT` and `CURRENT_BUGGY_CODING_HEAD_PROMPT` by one character. Run `migrateAgentGroups`. Confirm the headPrompt is NOT changed.
7. **Contract test.** `npx jest src/test/standing-orders-marker-contract.test.js` — confirm all assertions pass, including the new negative assertions.
8. **Three-way sync.** Grep for `GET /kanban/feature` across `src/` and confirm zero matches in head prompt constants. Grep for `give that coder the next subtask` and confirm zero matches. Grep for `workspaceRoot` in the head prompt constants and confirm it is present in all three.
9. **No orchestrator, no directive.** *(merged from subtask 3)* With no orchestrator armed, dispatch a plan to a coder via the board. Confirm the prompt does NOT contain `ORCHESTRATOR REPORT:`. Confirm it still contains `COMPLETION REPORT:`.
10. **Orchestrator armed, directive present.** *(merged from subtask 3)* Start the orchestrator (AUTOMATION tab → Start orchestrator → confirm). Dispatch a plan to a coder. Confirm the prompt DOES contain `ORCHESTRATOR REPORT:`.
11. **Default behavior unchanged.** *(merged from subtask 3)* Call `ensureDispatchProtocolDirectives('test')` with no second argument. Confirm both directives are appended (backward compatibility).
12. **HeadPrompt no longer mentions orchestrator reports.** *(merged from subtask 3)* Start a Coding team. Inspect the lead's standing order (via the standing-orders editor). Confirm the headPrompt does NOT contain "orchestrator/reports" or "status report to .switchboard/orchestrator".
13. **Gated-behavior test.** *(merged from subtask 3)* `npx jest src/test/seat-safeguards-fleet-prompt-path.test.js` — confirm the new gated-behavior test passes.

## Completion Report

Fixed five defects in the Coding team head prompt across `src/services/teamWiring.ts`, `src/webview/kanban.html`, and `src/webview/terminals.js`: corrected `GET /kanban/feature` to `GET /kanban/plan?planId=`, added `workspaceRoot` to `/kanban/dispatch` payload, updated the rotation rule to spread subtasks across idle seats, removed hardcoded orchestrator report instructions, and preserved the queue/next standing order. Added `isUntouchedCurrentCodingTeam` migration recogniser and `CURRENT_BUGGY_CODING_HEAD_PROMPT` constant. Gated `ensureDispatchProtocolDirectives` on `orchestratorActive` in `src/services/agentPromptBuilder.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, and `src/services/KanbanProvider.ts`. Updated contract test assertions in `src/test/standing-orders-marker-contract.test.js`, `src/test/stage-marker-commit-contract.test.js`, and `src/test/seat-safeguards-fleet-prompt-path.test.js`. No issues encountered.

## Review Findings

Three material findings, all fixed in place. **CRITICAL** — the second migration reached only the *group template*: `migrateAgentGroups` §1c corrected `headPrompt`, but `wireSpawnedTeam` skips the head order when one exists for the teamId (`teamWiring.ts:1169` `if (!headExists)`) and `migrateCodingTeamOrders` recognised only `OLD_HEADPROMPT_FRAGMENT`, so every install that already ran a Coding team on `226b7f09`'s shipped text kept delivering `GET /kanban/feature` and "give that coder the next subtask" forever (reproduced against `out/`); fixed by adding `BUGGY_HEADPROMPT_FRAGMENT` plus its `terminals.js` mirror and widening the team-head recogniser in both. **MAJOR** — `GET /kanban/plan?planId=` returns the feature record plus file content, not subtask statuses, and carried no `workspaceRoot` (the same scoping defect as Error 3); replaced with `GET /kanban/plans?featureId=<planId>&workspaceRoot=<pwd>`, which is `getSubtasksByFeatureId` and returns one record per subtask. **MAJOR** — the two-arg signature broke four static source-text assertions (`seat-safeguards-fleet-prompt-path.test.js:965/974/984`, `orchestrator-tick-and-reports-contract.test.js` bundle-callers + chokepoints); needles updated to the gated call shape. Files changed: `src/services/teamWiring.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, `src/test/{stage-marker-commit,seat-safeguards-fleet-prompt-path,orchestrator-tick-and-reports}*.test.js`. Validation: `tsc -p tsconfig.test.json` clean, eslint 0 errors, `standing-orders-marker` 55/55, `stage-marker-commit` 47/47 (3 new migration tests), `seat-safeguards` 95/95, `orchestrator-tick` pass, `team-scoped-role-routing` 41/41, `mirror:check` green; remaining risk: `buildCustomAgentPrompt` (`agentPromptBuilder.ts:2467`) is still ungated — it has no `PromptBuilderOptions` parameter, so custom agents keep receiving `ORCHESTRATOR REPORT:` with no orchestrator running.
