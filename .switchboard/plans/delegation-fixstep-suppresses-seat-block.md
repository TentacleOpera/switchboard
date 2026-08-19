# Delegation fixStep suppresses seat block — coder stops receiving SKIP TESTS / dontCommit from the delivery layer

## Goal

Add `"seatBlock":false` to the ptySendPrompt JSON payload in the reviewer's delegation `fixStep` template and its two mirror copies, so the pty delivery layer stops appending the coder's seat directive block (SKIP TESTS, dontCommit) to the reviewer's fix instructions. The coder's standing orders and the reviewer's fixStep message body together cover verification, commit, and git safety without the seat block's contradiction.

> **Superseded:** The coder's standing orders — which already include "run verification checks," "commit them," and the git safety directive — remain applied and are sufficient.
> **Reason:** The standing orders (default team prompt = `AGENT_GROUP_CALLBACK_INSTRUCTION` + `GIT_SAFETY_DIRECTIVE`, `teamWiring.ts:1144`) include the callback instruction ("report to your head when you finish a task") and the git safety directive, but NOT "run verification checks" or "commit them" as explicit text. Those come from the reviewer's fixStep message body (`agentPromptBuilder.ts:1824`) and the verifyStep's expectation of coder commits (`agentPromptBuilder.ts:1827`).
> **Replaced with:** The coder's standing orders (callback + `GIT_SAFETY_DIRECTIVE`) cover git safety and report-back. The reviewer's fixStep message body — not suppressed by `seatBlock: false` — instructs "run verification checks (typecheck/tests as applicable) and include results in their report." The verifyStep expects coder commits ("re-review ONLY the coder's git diff (git diff HEAD~<coder's commit count>)"). Together these cover verification, commit, and git safety without the seat block's SKIP TESTS / dontCommit contradiction.

### Problem

When a reviewer in delegation mode sends fix instructions to its coder via `ptySendPrompt`, the pty delivery layer (`TaskViewerProvider.ts:669-730`) resolves the coder's role, calls `resolveSeatPromptOptions('coder')` (`KanbanProvider.ts:5561`), and builds a seat directive block via `buildSeatDirectiveBlock` (`agentPromptBuilder.ts:1223`). If the coder role has `skipTests` or `skipCompilation` configured (`KanbanProvider.ts:5582-5583`), the block contains `SKIP_TESTS_DIRECTIVE` or `SKIP_COMPILATION_DIRECTIVE` (`agentPromptBuilder.ts:1249-1250`). The block is appended to the reviewer's fix instructions at `TaskViewerProvider.ts:730`: `data = data + '\n\n' + seatBlock`.

The coder receives one message containing:
1. Reviewer's fix instructions: "run verification checks..."
2. Seat block: "SKIP TESTS: Do not run automated tests..."
3. Standing orders: "report to your head when you finish a task — naming what you changed and what to review" + `GIT_SAFETY_DIRECTIVE`

The system defines a `SKIP TESTS:` line in the dispatch instructions as authoritative (`agentPromptBuilder.ts:1828`). The coder correctly obeys it and skips tests — defeating the entire purpose of delegation mode, where the coder is supposed to run verification and report results.

A second conflict exists in the same block: the team-commit gate (`TaskViewerProvider.ts:687-689`) forces `dontCommit` for non-head team members. This appends "Do NOT commit. Leave all changes in the working tree" — directly contradicting the reviewer's instruction to "commit them and report back."

### Background

The `seatBlock: false` opt-out already exists and is already tested. The pty delivery layer checks `payload?.seatBlock !== false` at `TaskViewerProvider.ts:586` — if the ptySendPrompt payload includes `"seatBlock":false`, the entire seat block is skipped. `notifyTurnEnd` already uses this opt-out (`TaskViewerProvider.ts`, asserted by `seat-safeguards-fleet-prompt-path.test.js:524-531`). Both hosts strip `seatBlock` from the payload before forwarding to the pty host (`delete payload.seatBlock` in `TaskViewerProvider.ts` and `bootstrap.ts`, asserted by tests at `:514-519` and `:767-771`), so it does not leak into the terminal input.

### Root Cause

The delegation `fixStep` template (`agentPromptBuilder.ts:1824`) constructs a ptySendPrompt JSON payload with `"clearBeforePrompt":false` but does not include `"seatBlock":false`. The same payload text is mirrored in two other locations — `NEW_REVIEW_TEAM_HEAD_PROMPT` in `teamWiring.ts:419` and the Review team preset's `headPrompt` in `kanban.html:4761-4770` — neither of which includes the opt-out. The delivery layer has no way to distinguish a reviewer-delegated message from a board-dispatched message, so it applies the coder's seat-scoped config unconditionally.

## Metadata

**Complexity:** 2
**Tags:** backend, bugfix
**Project:** Browser Switchboard

## User Review Required

None. The `seatBlock: false` opt-out is an existing, tested mechanism. The standing orders (callback + git safety) and the reviewer's fixStep message body (verification + commit expectation) together cover the workflow. No behavioral change for non-delegation paths.

## Complexity Audit

### Routine
- Adding `"seatBlock":false` to a JSON payload inside three string literals — two-word addition per location
- The opt-out mechanism (`payload?.seatBlock !== false` at `TaskViewerProvider.ts:586`) already exists and is tested
- Both hosts already strip `seatBlock` from the payload before terminal forwarding (`TaskViewerProvider.ts:2956`, `bootstrap.ts:1613`)
- No new logic, no new control flow, no new state

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. The `seatBlock` check is a synchronous boolean read on the payload object before the seat block is built. No timing window.

### Security
- `seatBlock` is stripped at the HTTP boundary by both hosts before forwarding to the pty host (`delete payload.seatBlock`), so it cannot leak into terminal input. This is already tested (`seat-safeguards-fleet-prompt-path.test.js:514-519`, `:767-771`). No new security surface.

### Side Effects
- Suppressing the seat block removes the coder's `GIT POLICY:` block too — not just SKIP TESTS / dontCommit. The `GIT_SAFETY_DIRECTIVE` in standing orders covers the destructive-commands guardrail. The `GIT POLICY:` block from `buildSeatDirectiveBlock` also carries branch/push strategy directives; if a coder role has a non-default `gitBranchStrategy` or `gitPushStrategy` configured, those directives are also suppressed. This is acceptable: in delegation mode the reviewer drives the coder's workflow, and the reviewer's fixStep + standing orders are the authoritative instructions. The coder is a team member whose commit authority is already gated by the team-commit gate in standing orders delivery, not the seat block.

### Dependencies & Conflicts
- The three mirror copies (`agentPromptBuilder.ts:1824`, `teamWiring.ts:419`, `kanban.html:4766`) must stay in sync. The `standing-orders-marker-contract.test.js` test already pins byte-identity between `teamWiring.ts` and `kanban.html` for the Review team headPrompt (`:410-417`). The new test assertions (Verification Plan items 3-4) pin the `seatBlock:false` literal in all three locations.
- This feature is unreleased (delegation mode + Review team preset added this week). No migration needed for existing installs — clean break per project rules.

## Dependencies

None. This plan is self-contained.

## Adversarial Synthesis

Key risks: (1) suppressing the seat block also suppresses non-skip directives (branch/push strategy) — acceptable because standing orders + reviewer's fixStep are authoritative in delegation mode. (2) The three mirror copies could drift if one is missed — mitigated by the existing marker-contract test plus the new source-text assertions. No migration risk: feature is unreleased.

## Proposed Changes

### src/services/agentPromptBuilder.ts

**Context:** The `fixStep` template at line 1824 constructs the ptySendPrompt JSON payload that the reviewer sends to its coder. The payload currently includes `"clearBeforePrompt":false` but not `"seatBlock":false`.

**Change:** Add `"seatBlock":false` to the JSON payload in the `fixStep` template string. The payload changes from:

```
{"name":"${reviewerCoderTerminal}","data":"<fix instructions ...>","clearBeforePrompt":false}
```

to:

```
{"name":"${reviewerCoderTerminal}","data":"<fix instructions ...>","clearBeforePrompt":false,"seatBlock":false}
```

This is the only change in this file — a two-word addition inside an existing string literal.

### src/services/teamWiring.ts

**Context:** `NEW_REVIEW_TEAM_HEAD_PROMPT` (line 413-423) is the mirror constant that matches the Review team preset's `headPrompt`. It contains the same ptySendPrompt JSON payload with `"clearBeforePrompt":false` but no `"seatBlock":false`.

**Change:** Add `"seatBlock":false` to the JSON payload in the constant string, at the same position as the `agentPromptBuilder.ts` change. The payload at line 419 changes from:

```
...in their report.>","clearBeforePrompt":false} against the port...
```

to:

```
...in their report.>","clearBeforePrompt":false,"seatBlock":false} against the port...
```

### src/webview/kanban.html

**Context:** The Review team preset's `headPrompt` (lines 4761-4770) is the literal text in the gallery preset. It mirrors `NEW_REVIEW_TEAM_HEAD_PROMPT` and contains the same ptySendPrompt JSON payload.

**Change:** Add `"seatBlock":false` to the JSON payload at line 4766, identical to the `teamWiring.ts` change. The payload changes from:

```
...in their report.>","clearBeforePrompt":false} against the port...
```

to:

```
...in their report.>","clearBeforePrompt":false,"seatBlock":false} against the port...
```

## Verification Plan

### Automated Tests

1. **Render assertion — delegation fixStep includes `seatBlock: false`**: Extend the existing delegation render test in `src/test/team-scoped-role-routing.test.js` (line 775). After the existing assertions, add:
   ```javascript
   assert.ok(prompt.includes('"seatBlock":false'),
       'delegation fixStep payload must include seatBlock:false to suppress the coder seat block');
   ```
   This pins the opt-out in the rendered prompt output, not just the source text.

2. **Backward compatibility — non-delegation reviewer prompt does NOT contain `seatBlock: false`**: The existing backward-compat test (line 804) already asserts the non-delegation prompt contains "Apply code fixes" and not "Send fix instructions." Add:
   ```javascript
   assert.ok(!prompt.includes('"seatBlock":false'),
       'non-delegation reviewer prompt must not contain seatBlock:false (no ptySendPrompt payload)');
   ```

3. **Source-text assertion — `NEW_REVIEW_TEAM_HEAD_PROMPT` includes `seatBlock: false`**: Add a source-text grep in the existing `team-scoped-role-routing.test.js` file:
   ```javascript
   assert.ok(teamWiringTs.includes('"seatBlock":false'),
       'NEW_REVIEW_TEAM_HEAD_PROMPT must include seatBlock:false in its ptySendPrompt payload');
   ```

4. **Source-text assertion — Review team preset `headPrompt` in `kanban.html` includes `seatBlock: false`**: Add a source-text grep:
   ```javascript
   assert.ok(kanbanHtml.includes('"seatBlock":false'),
       'Review team preset headPrompt must include seatBlock:false in its ptySendPrompt payload');
   ```

### Manual Verification

5. **End-to-end (requires live extension)**: Start a Review team with a coder that has `skipTests` configured for the coder role. Dispatch a card to CODE REVIEWED. Verify the reviewer's fix instructions reach the coder without a `SKIP TESTS:` line and without a `Do NOT commit` line. Verify the coder runs verification and commits, as instructed by the reviewer's fixStep message body and the standing orders.
