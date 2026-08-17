# Fix coding team head standing order: API errors and rotation rule

## Goal

Fix four defects in the Coding team's head prompt (`headPrompt`) reported by a coding team lead that caused failed API calls and a lost near-complete subtask. The head prompt is the `team-head`-scoped standing order installed on the lead terminal; it tells the lead how to dispatch subtasks, when to escalate, and how to hand the finished feature to review.

### Problem Analysis & Root Cause

The head prompt text is defined in three places that must stay in sync:
1. `teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (server-side, used for migration of old installs)
2. `kanban.html` — `SHIPPED_TEAM_TYPES` Coding team's `headPrompt` (client-side gallery definition)
3. `terminals.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` (client-side mirror, used for migration matching)

The current text contains four errors:

**Error 1: `GET /kanban/feature` is wrong — it is POST.**
The prompt says "confirm no subtask is still outstanding via GET /kanban/feature." But `/kanban/feature` is a POST endpoint that *creates* a feature (`LocalApiServer.ts:3854`: `pathname === '/kanban/feature' && req.method === 'POST'`). A GET to that path returns 404 (no GET handler registered). The correct endpoint for checking a feature's subtasks is `GET /kanban/plan?planId=<featurePlanId>` (`LocalApiServer.ts:2869`), which returns the plan record including its subtask list. Alternatively, `GET /kanban/features` (plural, line 3977) returns all features, but that is heavier and less precise.

**Error 2: `/kanban/feature` requires `name`, not `planId`.**
Even if the head tried POST instead of GET, the body schema is `{ name: string, planIds: string[], ... }` (line 1545), not `{ plan: planId }`. The head would get a validation error. This confirms the endpoint reference is fundamentally wrong — the head needs a read endpoint, not a create endpoint.

**Error 3: `/kanban/dispatch` needs `workspaceRoot` in the body.**
The dispatch handler resolves `workspaceRoot` from `body?.workspaceRoot || this._options.workspaceRoot` (line 1223). In a fleet/standalone setup where the head's terminal runs inside a worktree, `this._options.workspaceRoot` may point to the main workspace, not the worktree the head is working in. The DB lookup `getKanbanDatabase(workspaceRoot)` then resolves the wrong DB (or none), and `getPlanByPlanId(ref)` returns null — "Plan not found for a planId that plainly exists." The head prompt must tell the head to include `workspaceRoot` in the dispatch body, which the head can obtain from `pwd` (its current working directory in the worktree).

**Error 4: "give that coder the next subtask" causes context-wall losses.**
The prompt says "When a coder reports a subtask finished, note it and give that coder the next subtask." This instructs the head to stack subtasks on the same coder until that coder hits its context window limit. The reporting team lead ran subtasks 2 and 3 through the same coder until it hit its context wall, then misread the in-progress work as a stall and cleared it four minutes from done. The fix: replace "give that coder the next subtask" with "dispatch the next subtask to an idle seat that has not already worked on it" — spreading subtasks across available seats and avoiding context-wall buildup. The durable rule is: one subtask per cleared seat before rotation.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, frontend, reliability
**Project:** Browser Switchboard

## Complexity Audit

**Routine (text changes):**
- The four fixes are text edits to the head prompt string in three files.
- No logic changes, no new endpoints, no schema changes.

**Moderate risk (migration + tests):**
- `NEW_CODING_HEAD_PROMPT` in `teamWiring.ts` is the migration target — the migration recogniser (`isUntouchedOldCodingTeam`) matches against `OLD_CODING_HEAD_PROMPT`, not the new one. Changing `NEW_CODING_HEAD_PROMPT` does NOT affect migration matching (old installs still match against `OLD_CODING_HEAD_PROMPT`). But installs that already migrated to the current `NEW_CODING_HEAD_PROMPT` will NOT re-migrate to the corrected text — their standing orders carry the old (buggy) new prompt. A second migration recogniser is needed for this.
- `NEW_CODING_HEAD_PROMPT_CLIENT` in `terminals.js` is the client-side mirror used for migration matching. It must match the server-side `NEW_CODING_HEAD_PROMPT` exactly (the contract test pins substring assertions).
- The `standing-orders-marker-contract.test.js` pins substring assertions on the head prompt: it must include `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. The corrected text must still include all four.

**The second-migration problem:**
Installs that already migrated from `OLD_CODING_HEAD_PROMPT` to `NEW_CODING_HEAD_PROMPT` have the buggy text persisted in their standing orders. A new migration recogniser must match the current (buggy) `NEW_CODING_HEAD_PROMPT` and replace it with the corrected text. This is the same pattern as the old→new migration: exact-value match on the old text, replace with the new.

## Edge-Case & Dependency Audit

1. **Already-migrated installs.** Installs that migrated from `OLD_CODING_HEAD_PROMPT` to the current `NEW_CODING_HEAD_PROMPT` have the buggy text in their standing orders. A second migration recogniser (`isUntouchedCurrentCodingTeam`) must match the current `NEW_CODING_HEAD_PROMPT` exactly and replace it with the corrected text. The `OLD_CODING_HEAD_PROMPT` recogniser remains unchanged — it still catches installs that never migrated.
2. **Operator-edited teams.** An operator who edited the head prompt (any change from the exact shipped text) must NOT be migrated. The recogniser uses exact-value comparison, same as the existing pattern.
3. **Client-side migration.** `migrateTeamPairOrdersClient` in `terminals.js` runs at render time. The client-side `NEW_CODING_HEAD_PROMPT_CLIENT` must be updated to the corrected text, and the client-side migration must recognise the old (buggy) new prompt and replace it. This is the same client-side mirror pattern.
4. **Contract test assertions.** The test at `standing-orders-marker-contract.test.js:369-376` asserts the head prompt includes `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. The corrected text must still include all four. The `GET /kanban/feature` reference is NOT asserted by the test, so removing it is safe.
5. **workspaceRoot availability.** The head runs in a terminal whose CWD is the workspace or worktree root. `pwd` returns the absolute path. The head prompt must instruct the head to include `"workspaceRoot":"<output of pwd>"` in the dispatch body.
6. **GET /kanban/plan response shape.** The head needs to check whether subtasks are outstanding. `GET /kanban/plan?planId=<featurePlanId>` returns the plan record. The head must parse the response to check subtask statuses. The prompt should be concise about this — the head is an agent, not a human, and can parse JSON.

## Proposed Changes

### Corrected head prompt text (all three files)

The corrected `NEW_CODING_HEAD_PROMPT` / `headPrompt` / `NEW_CODING_HEAD_PROMPT_CLIENT`:

```
You lead this team. Your coders work the subtasks of one feature. Each subtask carries
a recommendedRole; dispatch it to a seat of that role on your team. If your team has
no such seat, dispatch to a coder and say why in your status report. Post a status report
to .switchboard/orchestrator/reports/ when a subtask is dispatched, and a finished report
when the feature is handed to review. When a seat fails review on the same subtask twice,
do not send that subtask to it a third time — escalate one rung along intern → coder → lead,
name the specific defects in the dispatch, and say in your status report which seat you moved
it to and why; if the seat that failed twice is a lead, or your team has no seat above it,
stop and report to the human instead of dispatching again. When a coder reports a subtask
finished, note it and dispatch the next subtask to an idle seat that has not already worked
on it — do not stack subtasks on the same coder, or it will hit its context limit mid-task.
One subtask per cleared seat before rotation. Do not send anything to the reviewer, and do
not write review instructions — that is not your job. When every subtask of the feature is
finished, read the port from .switchboard/api-server-port.txt, confirm no subtask is still
outstanding via GET /kanban/plan?planId=<the FEATURE planId>, then make one call: POST
/kanban/dispatch with {"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED",
"from":"{head}","workspaceRoot":"<your current working directory — run pwd>"} — that one
call moves the card and dispatches the reviewer with the reviewer's own prompt. Do NOT use
/kanban/move: it moves the card and dispatches nobody. Only advance the feature your team
worked; leave other cards alone. Do not wait to be asked.
```

**Summary of changes from the current text:**
1. `GET /kanban/feature` → `GET /kanban/plan?planId=<the FEATURE planId>` (correct endpoint + method)
2. Removed the implicit `planId` field reference for `/kanban/feature` (no longer relevant — using the correct read endpoint)
3. Added `"workspaceRoot":"<your current working directory — run pwd>"` to the `/kanban/dispatch` body
4. "give that coder the next subtask" → "dispatch the next subtask to an idle seat that has not already worked on it — do not stack subtasks on the same coder, or it will hit its context limit mid-task. One subtask per cleared seat before rotation."

### `src/services/teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (line 275)

Replace the constant value with the corrected text above. Keep `OLD_CODING_HEAD_PROMPT` unchanged (migration matching).

### `src/services/teamWiring.ts` — second migration recogniser

Add a new constant for the current (buggy) prompt and a recogniser that matches it:

```javascript
/**
 * The CURRENT (buggy) Coding team headPrompt — the text that the first migration
 * (OLD_CODING_HEAD_PROMPT → NEW_CODING_HEAD_PROMPT) wrote to disk. This is what
 * is on every install that already migrated. The second migration recogniser
 * matches against this exact value and replaces it with the corrected text.
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

### `src/webview/kanban.html` — Coding team `headPrompt` (line 4679)

Replace the `headPrompt` value with the corrected text above.

### `src/webview/terminals.js` — `NEW_CODING_HEAD_PROMPT_CLIENT` (line 8877)

Replace the constant value with the corrected text (must match `teamWiring.ts` exactly).

### `src/webview/terminals.js` — `CURRENT_BUGGY_CODING_HEAD_PROMPT_CLIENT`

Add a client-side mirror of `CURRENT_BUGGY_CODING_HEAD_PROMPT` for the client-side migration path. Update `migrateTeamPairOrdersClient` to recognise the buggy text and replace it with the corrected text in rendered standing orders.

### `src/test/standing-orders-marker-contract.test.js` — update assertions

The existing assertions (line 369-376) check for `/kanban/dispatch`, `CODE REVIEWED`, `"from":"{head}"`, and `Do NOT use /kanban/move`. These still pass with the corrected text. No assertion change needed for those.

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
```

## Verification Plan

1. **Correct endpoint.** Confirm the corrected head prompt references `GET /kanban/plan?planId=` and NOT `GET /kanban/feature`. Verify `GET /kanban/plan?planId=<id>` returns a plan record with subtask information.
2. **workspaceRoot in dispatch body.** Start a Coding team in a worktree. Have the lead call `POST /kanban/dispatch` with `"workspaceRoot":"$(pwd)"` in the body. Confirm the dispatch succeeds (no "Plan not found" error). Repeat without `workspaceRoot` and confirm it fails (reproducing the original bug).
3. **Rotation rule.** Confirm the corrected text says "dispatch the next subtask to an idle seat that has not already worked on it" and does NOT contain "give that coder the next subtask."
4. **Migration: old → corrected.** Create an install with `OLD_CODING_HEAD_PROMPT` in the agent group. Run `migrateAgentGroups`. Confirm the headPrompt is replaced with the corrected text (the old recogniser still fires, and the corrected text is the new target).
5. **Migration: buggy-new → corrected.** Create an install with the current `NEW_CODING_HEAD_PROMPT` (buggy text) in the agent group. Run `migrateAgentGroups`. Confirm the headPrompt is replaced with the corrected text (the new recogniser fires).
6. **Migration: operator-edited team untouched.** Create an install with a headPrompt that differs from both `OLD_CODING_HEAD_PROMPT` and `CURRENT_BUGGY_CODING_HEAD_PROMPT` by one character. Run `migrateAgentGroups`. Confirm the headPrompt is NOT changed.
7. **Contract test.** `npx jest src/test/standing-orders-marker-contract.test.js` — confirm all assertions pass, including the new negative assertions.
8. **Three-way sync.** Grep for `GET /kanban/feature` across `src/` and confirm zero matches in head prompt constants. Grep for `give that coder the next subtask` and confirm zero matches. Grep for `workspaceRoot` in the head prompt constants and confirm it is present in all three.
