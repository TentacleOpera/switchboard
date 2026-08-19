# Tiered Review: Mechanical Gate + Phone-a-Friend Pre-Review Before Expensive Reviewer

## Metadata
**Complexity:** 7
**Tags:** backend, refactor, performance, reliability
**Project:** Browser Switchboard

## Goal

Add a two-stage pre-review gate before the expensive reviewer agent is dispatched, so cheap failures are caught at zero or low agent cost and the expensive reviewer only sees work that has passed mechanical and sanity checks. Stage 1 is a system-level mechanical gate (compile + diff coverage). Stage 2 is a phone-a-friend pre-review (if configured) that checks "did they actually implement it." Only work passing both gates reaches the expensive reviewer for deep analysis.

## Problem

The current pipeline sends completed coder work directly to the expensive reviewer with no pre-filtering. The reviewer's real value is deep analysis — call-path traces, architectural concerns, judgment calls about what's load-bearing. But the reviewer also catches cheap failures that don't need an expensive model: "did not implement at all," "doesn't compile," "diff doesn't touch the files the plan mentions."

In the session that motivated this plan, the reviewer's analysis pass found 4 CRITICAL and 4 MAJOR — all of which were deep findings worth every token. But the reviewer also demanded tests on a visual rail icon (wrong severity, wrong finding) and spent overhead on source-text assertions over CSS. The expensive model was doing cheap work alongside the expensive work.

Meanwhile, phone-a-friend exists as a side-channel: `POST /phone-a-friend` fires after the batch is done, not before the expensive reviewer. It's a manual toggle in the TEAMS tab, not an integrated pipeline stage. And idle coders sit unused between subtasks.

## Architecture

### Current flow

```
Coder finishes → Card moves to CODE REVIEWED column
  → Lead/orchestrator dispatches expensive reviewer
  → Reviewer does everything: compile check, "did they implement it", deep analysis
  → Reviewer delegates fixes back to coder (if delegation mode)
```

### Proposed flow

```
Coder finishes → Card moves to CODE REVIEWED column
  → STAGE 1: Mechanical gate (system, no agent)
    → Compile check (npm run compile)
    → Diff coverage check (does the diff touch files the plan mentions?)
    → FAIL → back to coder with mechanical findings (no agent involved)
    → PASS ↓
  → STAGE 2: Phone-a-friend pre-review (if configured, cheap agent)
    → "Did they actually implement it?" — read plan, read diff, sanity check
    → FAIL → back to coder with cheap findings
    → PASS ↓
    → NOT CONFIGURED → skip to Stage 3 ↓
  → STAGE 3: Expensive reviewer (deep analysis only)
    → Call-path traces, architectural concerns, judgment calls
    → Delegate fixes to coder (if delegation mode)
```

## Implementation

### Stage 1: Mechanical gate (system-level, no agent)

#### 1a. New endpoint: POST /review/pre-check

Add a new endpoint to `LocalApiServer.ts` that runs mechanical checks on a completed plan's worktree before any reviewer agent is dispatched. The endpoint is called by the lead/orchestrator (or automatically by the dispatch pipeline) when a card reaches CODE REVIEWED.

**Request:** `{ planId?: string, planFile?: string, workspaceRoot: string }`

**Checks:**
1. **Compile check:** Run `npm run compile` in the worktree CWD. Capture exit code and stderr.
2. **Diff coverage check:** Get the git diff (against the worktree's base branch). Parse the plan file to extract mentioned file paths (from code blocks, file references, `src/...` paths). Check whether the diff touches at least one file mentioned in the plan. If the diff is empty or touches zero plan-relevant files, flag as "diff does not match plan scope."

**Response:**
```json
{
  "passed": true|false,
  "checks": [
    { "name": "compile", "passed": true|false, "details": "..." },
    { "name": "diffCoverage", "passed": true|false, "details": "..." }
  ],
  "findings": [ { "severity": "CRITICAL", "message": "...", "file": "..." } ]
}
```

**On failure:** The caller (lead/orchestrator) sends the mechanical findings back to the coder via `ptySendPrompt` — same as a reviewer fix round, but no reviewer agent was involved. The card stays in the coded column.

**On pass:** The caller proceeds to Stage 2 (phone-a-friend) or Stage 3 (expensive reviewer).

#### 1b. Where the gate runs

The gate is called from the dispatch path in `TaskViewerProvider.ts` (the same code that resolves `reviewerDelegationMode` at lines 21488-21557). Before building the reviewer prompt and dispatching, call `POST /review/pre-check`. If it fails, dispatch the mechanical findings to the coder instead of dispatching the reviewer.

This is a sequential gate, not a parallel check. The reviewer dispatch is blocked until the gate passes.

#### 1c. Diff coverage parsing

The plan file mentions target files in several places: code blocks with file paths, inline `src/...` references, and the `## Scope` / `## Implementation` sections. A simple regex for `src/[a-zA-Z0-9/_.-]+\.(ts|js|tsx|jsx|css|html|json)` over the plan file content is sufficient — this is a sanity check, not a precise scope analysis. False positives (plan mentions a file that the diff doesn't touch but the change is still correct) are acceptable because the gate only blocks on zero plan-relevant files in the diff, not on missing files.

### Stage 2: Phone-a-friend pre-review (if configured)

#### 2a. Reposition phone-a-friend from side-channel to pre-review stage

Currently phone-a-friend is triggered by `POST /phone-a-friend` from the coder when it finishes a batch (a side-channel notification). The pre-review stage instead triggers phone-a-friend from the dispatch pipeline, after Stage 1 passes and before the expensive reviewer is dispatched.

The existing `POST /phone-a-friend` endpoint and `PHONE_A_FRIEND_DIRECTIVE` / `PHONE_A_FRIEND_DONE_DIRECTIVE` infrastructure is reused. The difference is the trigger source (pipeline, not coder) and the prompt content (pre-review sanity check, not post-batch second pass).

#### 2b. Pre-review prompt for phone-a-friend

The phone-a-friend agent receives a prompt like:

> "Pre-review check for plan {planFile}. Read the plan file and the coder's git diff (git diff HEAD~<commit count>). Answer two questions: (1) Does the diff implement what the plan describes, or is it a stub/empty/partial? (2) Are there any obvious gaps a plan reader would catch? Report PASS or FAIL with specific findings. Do NOT do deep analysis — that's the next stage. Focus on: did they implement it at all, and does it look like a real implementation?"

This is deliberately scoped to cheap judgment — "did they implement it" — not deep analysis. The phone-a-friend agent should be a cheaper/faster model than the expensive reviewer.

#### 2c. Phone-a-friend not configured → skip

If no phone-a-friend terminal is configured (the TEAMS tab toggle is off, or no target terminal is resolved), Stage 2 is skipped. The pipeline degrades gracefully: mechanical gate → expensive reviewer. This is the correct fallback — the mechanical gate still catches the cheapest failures.

#### 2d. Phone-a-friend completion → advance to Stage 3

The existing `POST /phone-a-friend/done` completion signal is used. When phone-a-friend reports PASS (or is skipped), the pipeline advances to Stage 3 (expensive reviewer dispatch). When phone-a-friend reports FAIL, the findings are sent back to the coder via `ptySendPrompt` and the card stays in the coded column.

### Stage 3: Expensive reviewer (unchanged, but scoped)

The expensive reviewer's prompt is updated to note that the work has passed a mechanical gate (compile + diff coverage) and a phone-a-friend pre-review. This tells the reviewer to skip mechanical checks and focus on deep analysis. The reviewer's existing steps (Stage 1 Grumpy, Stage 2 Balanced, fix delegation) remain — but the reviewer can assume compile passes and the diff is non-empty and plan-relevant.

This is a prompt addition to the reviewer base instructions in `agentPromptBuilder.ts`, not a structural change. One line: "This plan has passed a mechanical pre-check (compile + diff coverage) and a phone-a-friend sanity review. Focus your review on deep analysis: call paths, architectural concerns, judgment calls. Do not re-verify compilation."

## Edge cases

- **Worktree not available:** If the plan has no worktree (shared working tree), the mechanical gate runs in the workspace root. The diff is against the last commit, not a base branch. This is the existing `git diff HEAD~<commit count>` pattern the reviewer already uses.
- **Compile is already skipped (SKIP COMPILATION directive):** If the dispatch instructions contain "SKIP COMPILATION:", the mechanical gate skips the compile check and only runs diff coverage. The skip directive is authoritative — same rule as the existing anti-leakage step.
- **Phone-a-friend terminal is busy:** The existing per-target sequential queue (`POST /phone-a-friend/done` advances the queue) handles this. If the phone-a-friend terminal is reviewing another plan, the pre-review is queued. The expensive reviewer dispatch waits for the queue to drain. This is acceptable — the phone-a-friend is cheap, so the queue drains fast.
- **Mechanical gate false negative:** The gate passes but the code is broken in a way compile doesn't catch (e.g., runtime error, logic bug). This is expected — the gate catches mechanical failures, not logic errors. The expensive reviewer catches logic errors. The gate is a pre-filter, not a replacement for review.
- **Phone-a-friend false positive (passes bad work):** The phone-a-friend says PASS but the work has deep issues. This is expected — the phone-a-friend does cheap judgment, not deep analysis. The expensive reviewer catches deep issues. The phone-a-friend is a pre-filter, not a replacement for review.
- **Coder disputes mechanical gate findings:** The mechanical gate is objective (compile exit code, diff file list). There's nothing to dispute — if compile fails, it fails. If the diff doesn't touch plan-relevant files, the coder can explain why in their report and the lead can override.

## Scope

- `src/services/LocalApiServer.ts` — new `POST /review/pre-check` endpoint (Stage 1 mechanical gate)
- `src/services/TaskViewerProvider.ts` — dispatch pipeline change: call pre-check before reviewer dispatch, route phone-a-friend as pre-review stage, gate reviewer dispatch on both stages passing. **Error handling:** if the pre-check HTTP call fails (network error, server unreachable), the pipeline MUST fall through to the reviewer — graceful degradation, never block on a failed gate call.
- `src/services/agentPromptBuilder.ts` — reviewer prompt addition (note that pre-checks passed, focus on deep analysis)
- `src/services/KanbanProvider.ts` — phone-a-friend dispatch path may need adjustment to support pre-review mode (vs current post-batch mode). The existing `POST /phone-a-friend` endpoint needs a mode parameter (e.g. `mode: "pre-review" | "post-batch"`) or a separate endpoint path to distinguish the trigger source and prompt content.
- `protocol-catalog.json` — document the new endpoint in the HTTP endpoints section
- Test coverage: new tests for the pre-check endpoint, updated dispatch pipeline tests

> **Superseded:** `src/generated/verbAllowlist.ts` — add the new endpoint to the allowlist
> **Reason:** `verbAllowlist.ts` is AUTO-GENERATED from `protocol-catalog.json`'s `providers.<Name>.verbs[]` section, which contains webview command names (like `phoneAFriendSelected`), NOT HTTP endpoint paths. The HTTP endpoints (like `/phone-a-friend`) are listed in a separate section of `protocol-catalog.json` and routed directly in `LocalApiServer.ts`. The new `POST /review/pre-check` endpoint does not belong in the verb allowlist.
> **Replaced with:** Only `protocol-catalog.json` (HTTP endpoints section) and `LocalApiServer.ts` (request routing) need updating for the new endpoint.

## What does NOT change

- The reviewer's existing steps (Grumpy, Balanced, fix delegation, verification loop)
- The phone-a-friend endpoint and directive infrastructure (reused, not replaced)
- The coder's workflow (still codes, still commits, still reports completion)
- The lead's role (still dispatches, still receives completion reports)
- The kanban column model (still CODE REVIEWED → reviewer dispatch)
- The `POST /phone-a-friend/done` completion signal (reused for pre-review completion)

## User Review Required

No user review required. The plan extends the existing dispatch pipeline with a pre-filter gate. No user-facing UI changes, no configuration changes (phone-a-friend toggle already exists in TEAMS tab). The graceful degradation path (phone-a-friend not configured → mechanical gate only → reviewer) means no new mandatory setup.

## Complexity Audit

### Routine
- Adding a new HTTP endpoint to `LocalApiServer.ts` (follows existing endpoint patterns like `/phone-a-friend`)
- Adding the endpoint to `protocol-catalog.json` (one entry in the HTTP endpoints array)
- Adding a one-line prompt addition to the reviewer base instructions in `agentPromptBuilder.ts`
- The `POST /phone-a-friend/done` completion signal reuse (no new completion mechanism)

### Complex / Risky
- Dispatch pipeline change in `TaskViewerProvider.ts` — inserting a sequential gate before reviewer dispatch, with error handling (fall-through on gate failure)
- Phone-a-friend repositioning from post-batch side-channel to pre-review pipeline stage — needs mode distinction (parameter or separate endpoint) without breaking existing post-batch behavior
- Diff coverage parsing — regex-based plan file path extraction is inherently fuzzy; false positives could send correct work back to the coder
- Sequential gate timing — the reviewer dispatch is blocked until the gate passes; if the gate hangs, the pipeline stalls

## Edge-Case & Dependency Audit

- **Race Conditions:** The mechanical gate runs synchronously before reviewer dispatch. No race — the gate is a sequential blocking call. If phone-a-friend is queued (busy with another plan), the pipeline waits for the queue to drain. This is acceptable but could stall if phone-a-friend hangs.
- **Security:** The `POST /review/pre-check` endpoint runs `npm run compile` in a worktree CWD. No user input is passed to the shell — the worktree path comes from the plan's worktree config. No injection risk.
- **Side Effects:** Running `npm run compile` in the worktree may write build artifacts. This is the same side effect the reviewer currently has when it compiles. No new side effects.
- **Dependencies & Conflicts:** Independent of companion plans (diagnosis-only, self-fix threshold) at the code level. Different files. Composes conceptually: pre-checked work → diagnosis-only delegation → self-fix threshold. The `SKIP COMPILATION` directive must be honored by the mechanical gate (skip compile check, run diff coverage only) — same rule as the existing anti-leakage step.

## Dependencies

This plan is independent of the two companion plans (diagnosis-only for judgment calls, self-fix threshold). Those plans change the reviewer's fix delegation behavior. This plan changes what reaches the reviewer. They compose: the reviewer sees pre-checked work and then applies diagnosis-only delegation with a self-fix threshold on the findings it does find.

## Adversarial Synthesis

Key risks: (1) pre-check HTTP call failure could block the pipeline — mitigated by graceful degradation (fall through to reviewer on gate failure); (2) phone-a-friend mode switching needs a concrete mechanism (parameter or separate endpoint) to distinguish pre-review from post-batch without breaking existing behavior; (3) diff coverage regex is fuzzy but only blocks on zero plan-relevant files, so false positives are bounded. Mitigations: error handling specified, mode parameter identified, regex limitations acknowledged.

## Proposed Changes

### `src/services/LocalApiServer.ts`
- **Context:** New `POST /review/pre-check` endpoint for the mechanical gate (Stage 1).
- **Logic:** Endpoint receives `{ planId?, planFile?, workspaceRoot }`. Runs `npm run compile` in the worktree CWD (or workspace root if no worktree). Gets git diff and checks diff coverage against plan file paths (regex: `src/[a-zA-Z0-9/_.-]+\.(ts|js|tsx|jsx|css|html|json)`). Honors SKIP COMPILATION directive (skip compile, run diff coverage only). Returns `{ passed, checks, findings }`.
- **Implementation:** Follow existing endpoint patterns (like `/phone-a-friend`). Add route in the request handler switch. Add entry to `protocol-catalog.json` HTTP endpoints section.
- **Edge Cases:** Worktree not available → run in workspace root. Compile already skipped → diff coverage only. Pre-check call fails → caller falls through to reviewer.

### `src/services/TaskViewerProvider.ts`
- **Context:** Dispatch pipeline change — insert pre-check gate before reviewer dispatch.
- **Logic:** Before building the reviewer prompt and dispatching (around lines 21488-21557), call `POST /review/pre-check`. If it fails (passed=false), dispatch mechanical findings to coder via `ptySendPrompt` instead of dispatching the reviewer. If the HTTP call itself fails (network error), fall through to reviewer dispatch (graceful degradation). If pre-check passes, proceed to Stage 2 (phone-a-friend pre-review if configured) or Stage 3 (reviewer dispatch).
- **Implementation:** Add async pre-check call in the dispatch path, wrapped in try/catch with fall-through. The phone-a-friend pre-review trigger needs a mode parameter to distinguish from post-batch mode.
- **Edge Cases:** Gate call throws → fall through to reviewer. Phone-a-friend not configured → skip to reviewer. Phone-a-friend busy → queue waits.

### `src/services/agentPromptBuilder.ts`
- **Context:** Reviewer prompt addition — note that pre-checks passed.
- **Logic:** Add one line to the reviewer base instructions when pre-checks have passed: "This plan has passed a mechanical pre-check (compile + diff coverage) and a phone-a-friend sanity review. Focus your review on deep analysis: call paths, architectural concerns, judgment calls. Do not re-verify compilation."
- **Implementation:** Conditional prompt addition — only when pre-checks have passed. This could be a new option flag (`reviewerPreCheckPassed?: boolean`) in `PromptBuilderOptions`, or a simpler approach: always include the note when the mechanical gate is active (since the reviewer only reaches this point if the gate passed).
- **Edge Cases:** If pre-check was skipped (graceful degradation), the note should not be added. The option flag approach handles this.

### `src/services/KanbanProvider.ts`
- **Context:** Phone-a-friend dispatch path adjustment for pre-review mode.
- **Logic:** The existing `POST /phone-a-friend` endpoint and `PHONE_A_FRIEND_DIRECTIVE` are triggered by the coder post-batch. The pre-review stage triggers from the dispatch pipeline with different prompt content. Add a mode parameter (`mode: "pre-review" | "post-batch"`) to the endpoint, or use a separate endpoint path (`POST /phone-a-friend/pre-review`).
- **Implementation:** Extend the existing handler to accept a mode parameter. When mode is "pre-review", use the pre-review prompt (sanity check, not deep analysis). When mode is "post-batch" (default), use the existing behavior.
- **Edge Cases:** Mode parameter absent → default to "post-batch" (backward compat).

## Verification Plan

1. `npm run compile` — exit 0, 0 errors
2. New unit tests for `POST /review/pre-check`: compile pass, compile fail, diff coverage pass, diff coverage fail, SKIP COMPILATION directive honored
3. Updated dispatch pipeline tests: confirm reviewer is not dispatched when pre-check fails, confirm coder receives mechanical findings instead
4. Updated dispatch pipeline tests: confirm phone-a-friend is dispatched as pre-review when configured, confirm reviewer is dispatched after phone-a-friend passes
5. Updated dispatch pipeline tests: confirm reviewer is dispatched directly when phone-a-friend is not configured (graceful degradation)
6. Manual: dispatch a coder on a plan, introduce a compile error, confirm the mechanical gate catches it and sends it back to the coder without dispatching the reviewer
7. Manual: confirm the reviewer prompt contains the "pre-checks passed, focus on deep analysis" note

## Completion Summary

Implemented the two-stage pre-review gate (Stage 1 mechanical gate + Stage 2 phone-a-friend pre-review) across 5 files. **LocalApiServer.ts**: new `POST /review/pre-check` endpoint running compile (via `execSync`, honors `skipCompilation`) + diff coverage (checks uncommitted, last commit, and unstaged diffs against plan-mentioned file paths via regex); added `mode` parameter to `onPhoneAFriend` callback and `_handlePhoneAFriend` handler. **agentPromptBuilder.ts**: added `reviewerPreCheckPassed` option to `PromptBuilderOptions`; appends one-line note to reviewer base instructions (not fixStep/verifyStep) when pre-checks passed. **TaskViewerProvider.ts**: inserted pre-check HTTP call before reviewer dispatch — on gate failure sends mechanical findings to coder via `_dispatchExecuteMessage` and returns false; on HTTP error falls through to reviewer (graceful degradation); on pass triggers phone-a-friend pre-review as fire-and-forget via `dispatchPhoneAFriend` with `mode: 'pre-review'`; passes `reviewerPreCheckPassed` to `generateUnifiedPrompt`; threaded `mode` through `dispatchPhoneAFriend`, `_dispatchPhoneAFriendInternal`, `enqueuePhoneAFriend`, and the queue structure. **KanbanProvider.ts**: `phoneAFriendSelected` handler reads `msg.mode` and passes to `enqueuePhoneAFriend` (defaults to post-batch when absent). **protocol-catalog.json**: added `/review/pre-check` endpoint entry. No issues encountered. SKIP COMPILATION and SKIP TESTS directives honored — verification plan not executed this run.

### Defect Fix — Sequential Gate (Stage 2)

Fixed the fire-and-forget defect in `src/services/TaskViewerProvider.ts` where Stage 2 phone-a-friend pre-review was dispatched concurrently with the reviewer instead of as a sequential gate. The fix replaces `void this.dispatchPhoneAFriend(...)` (fire-and-forget, `queueOriginated=false`, no completion signal) with `enqueuePhoneAFriend(...)` (queue path, `queueOriginated=true`, done directive appended). A new `_preReviewWaiters` Map registers a promise per plan that resolves when `handlePhoneAFriendDone` fires for that plan. The dispatch pipeline awaits this promise before proceeding to reviewer dispatch. The phone-a-friend agent is instructed (via the pre-review prompt) to write a verdict JSON file (`{"result":"PASS"|"FAIL","findings":"..."}`) before calling the completion curl. On FAIL, findings are sent to the coder and the reviewer is NOT dispatched (return false). On PASS, the reviewer proceeds. If phone-a-friend is not configured or falls back to batch mode (no completion callback), Stage 2 is skipped — graceful degradation to reviewer. Stale verdict files are cleared before each run to prevent false FAILs from prior crashes. No timeout fallback added — if phone-a-friend hangs, the pipeline stalls (acceptable per plan). Only `TaskViewerProvider.ts` was modified.
