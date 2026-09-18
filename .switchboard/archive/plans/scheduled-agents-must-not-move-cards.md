# A Scheduled Agent Never Moves A Card

## Goal

Make scheduling safe to leave running overnight without thought. A scheduled run must never be
able to strand, double-advance or reverse a card. The way to get that is not to instruct agents
carefully — it is to ensure no scheduled agent has any reason or route to move a card, and that
everything which does move cards is deterministic host code going through dispatch.

### The problem, and the root cause

Today a team automation can be given board authority by a checkbox — *"Allow automation to move
board cards (includes board driving contract)"* (`terminals.html:2755-2756`) — which renders as a
violet `MOVES CARDS` badge. What that checkbox actually does, in full
(`schedulerPresets.ts:115`):

```
if (job.teamTarget?.canMoveCards) {
    return `${basePrompt}\n\n${BOARD_DRIVING_CONTRACT}`;
}
```

`BOARD_DRIVING_CONTRACT` is a paragraph of prose telling the agent to use `move-card.js` /
`POST /kanban/move` rather than raw SQL, and where to find the API port. So:

- **It grants nothing and restricts nothing.** Unticked, the agent is not prevented from moving
  cards — it is merely not told the sanctioned route, which makes a raw-SQL move *more* likely,
  not less. The checkbox is inverted relative to its label.
- **It bypasses every guard.** A real dispatch goes through `dispatchNextFromQueue` →
  `_queueNextChain` → the team in-flight check → a 409. A prompted move goes through none of it,
  so an automation can move a card while its team is holding other work and nothing refuses.
- **It leaves no holder.** Dispatch writes `dispatched_terminal` / `dispatched_at`, which
  `completed_at` later releases. A prompted move writes neither, so the card advances with no
  holder — invisible to the in-flight predicate, to mission `runState`, and to the rail.

**And prose restrictions on card movement are already known not to hold.**
`team-heads-must-not-move-cards.md` exists because a hand-tuned standing-orders prompt failed
twice in observed use: a lead moved a card backwards from CODER CODED to PLAN REVIEWED, and
another read the word "advance" as "move the card". If that fails for a lead being watched, it
fails for a job running at 03:00.

The root cause is that card movement was modelled as a *permission granted by prompt* rather
than as an operation with an owner. `reconcile` has the same shape and its own source comment
concedes the exposure: *"A wrong prompt silently moves cards backward or double-advances, so
the wording is load-bearing."*

**Existing coverage for dispatched agents.** `CARD_MOVE_RULE` in `agentPromptBuilder.ts:1633`
already prohibits card movement for the five dispatched execution seats (planner, coder, intern,
reviewer, tester) — it is appended by `assembleSuffix` on every dispatch prompt. The gap this
plan closes is the *scheduled* prompt path (`buildTeamAutomationPrompt` in `schedulerPresets.ts`),
which is delivered via `_dispatchExecuteMessage` (a direct terminal push) and does NOT pass
through `assembleSuffix`. A scheduled team-automation prompt bypasses the dispatched-agent
prohibition entirely; `canMoveCards` is the only gate, and it is inverted.

## Metadata
- **Complexity:** 4
- **Tags:** backend, reliability, security, refactor

## User Review Required

This plan deletes a user-facing checkbox and its badge from the team automations form. No
migration is needed (the feature has never been used), but the deletion is visible: an operator
who previously saw the `MOVES CARDS` badge will no longer see it. Since no one has used the
feature, no notice is needed — but confirm nothing else keys on the badge's presence before
deleting it.

## Why this is not enforced at the endpoint

The obvious fix — refuse `/kanban/move` from a scheduled agent — is not available.
`_handleKanbanMove` (`LocalApiServer.ts:3258`) takes `sessionId | planId`, `targetColumn`,
`workspaceRoot`, `planFile` and **no caller identity**, unlike `/kanban/dispatch`
(`LocalApiServer.ts:1560`, reads `body.from`) and `/kanban/task/complete` (carries `from` in the
composed instruction at `LocalApiServer.ts:680`) which both carry `from`. Adding `from` only
half-closes it: the panel's own drags arrive unattributed and must keep working, so an agent
that omits `from` walks through the gate. That fails open, which is the wrong failure mode for
the feature whose entire promise is that it is unattended.

Hence the design below: remove the reason, not the route.

## The rule

**In a scheduled context, the host may move cards; an agent may not.**

- **Host-executed actions** — anything that advances the board — run as deterministic code
  through the dispatch path, with a recorded holder and the in-flight guard. No judgement, no
  prompt.
- **Agent actions** — recurring prompt delivery — have no board reach at all. A mistake costs a
  wasted run, never a stranded card.

## No migration

Clean break. `canMoveCards` is deleted, not migrated or defaulted. It has never been used, so
no persisted job carries it — but write the reader to ignore an unknown key rather than throw,
since jobs are stored in a shared config blob. CLAUDE.md's migration rule is waived otherwise.

## Complexity Audit

### Routine
- Deleting a boolean field from an interface (`GlobalIntegrationConfigService.ts:55`)
- Removing a checkbox from an HTML form (`terminals.html:2755-2756`)
- Removing a conditional badge from a JS renderer (`terminals.js:12157-12163`)
- Removing a conditional branch from a prompt builder (`schedulerPresets.ts:115-117`)
- Removing the `canMoveCards` write from the save path (`terminals.js:12327, 12347, 12359`)
- Adding a code comment to `buildTeamAutomationPrompt` and the scheduled-job runner

### Complex / Risky
- **The test assertion must be scoped carefully.** `buildReconcilePrompt` still emits
  `BOARD_DRIVING_CONTRACT` (`schedulerPresets.ts:92`) and will continue to until
  `reconcile-becomes-host-code.md` lands. A blanket "no scheduled prompt builder may emit
  `BOARD_DRIVING_CONTRACT`" assertion would fail today against reconcile. The test must cover
  `buildTeamAutomationPrompt` and `buildFetchPlansPrompt` only, with a comment noting reconcile
  is excluded until its dependency lands.
- **The external automation prompt consumer.** `_buildExternalAutomationPrompt`
  (`KanbanProvider.ts:6963-6983`) also appends `BOARD_DRIVING_CONTRACT`. This is OUT OF SCOPE:
  it is a human-launched copyable prompt (the operator copies it into an external tool), not a
  scheduled job. The operator decides whether to use it. Do NOT remove `BOARD_DRIVING_CONTRACT`
  from this consumer — it is the correct instruction for an interactive agent that legitimately
  moves cards.

## Edge-Case & Dependency Audit

### Race Conditions
- None. The deletion is static — no concurrent access patterns change. The config reader
  ignoring unknown keys is a read-time concern, not a write-time race.

### Security
- Positive: removing `BOARD_DRIVING_CONTRACT` from scheduled prompts reduces the attack surface
  of unattended jobs. A compromised or hallucinating scheduled agent is no longer told the
  sanctioned card-move route.
- Honest limit: an agent with shell access can still run `move-card.js` regardless of what its
  prompt says. This plan reduces the reason, not the capability — state that limit honestly in
  the code comment rather than implying the route is closed.

### Side Effects
- **`BOARD_DRIVING_CONTRACT` constant stays.** It is still exported from `schedulerPresets.ts:18`
  and aliased by `KanbanProvider.BOARD_DRIVING_CONTRACT` (`KanbanProvider.ts:6937`). It is still
  used by `buildReconcilePrompt` (until the dependency lands) and by
  `_buildExternalAutomationPrompt` (permanently — out of scope). Do NOT delete the constant.
- **Existing test `autoban-state-regression.test.js:798-804`** asserts that
  `KanbanProvider.BOARD_DRIVING_CONTRACT` references the shared constant and that the literal
  text exists as exactly one copy across the providers and presets module. This test is
  unaffected — the constant and its alias remain.
- **The badge's absence is the only signal an operator gets** that behaviour changed. Since no
  one has used it, no notice is needed — but confirm nothing else keys on the badge's presence.

### Dependencies & Conflicts
- **`reconcile-becomes-host-code.md`** — NOT YET IMPLEMENTED (no Completion Report). This plan
  depends on it: until reconcile becomes host code, `buildReconcilePrompt` is the one scheduled
  job that still moves cards by prose. This plan is not complete while it does. The test
  assertion in this plan must exclude reconcile until that dependency lands.
- **`team-heads-must-not-move-cards.md`** — ALREADY IMPLEMENTED (has Completion Report and
  Review Findings). Precedent, not a dependency. It proved that prose restrictions on card
  movement don't hold for watched leads; this plan extends the same conclusion to unattended
  jobs.
- **`agentPromptBuilder.ts:1633` (`CARD_MOVE_RULE`)** — Already prohibits card movement for
  dispatched execution roles. No conflict — this plan targets the scheduled path, which bypasses
  `assembleSuffix` entirely.

## Dependencies

- `reconcile-becomes-host-code.md` — Reimplement reconcile as deterministic host code so it
  stops moving cards by prose. NOT YET IMPLEMENTED. Until it lands, `buildReconcilePrompt`
  remains the one scheduled prompt that carries `BOARD_DRIVING_CONTRACT`, and this plan's test
  assertion must exclude it.

## Adversarial Synthesis

Key risks: (1) The test assertion as originally written ("no scheduled prompt builder may emit
`BOARD_DRIVING_CONTRACT`") would fail against `buildReconcilePrompt`, which still carries the
contract until `reconcile-becomes-host-code.md` lands — scope it to `buildTeamAutomationPrompt`
and `buildFetchPlansPrompt` only. (2) The external automation prompt
(`_buildExternalAutomationPrompt`) also uses `BOARD_DRIVING_CONTRACT` — it is out of scope
(human-launched, not scheduled) and must not be touched. (3) Line numbers in the original plan
were wrong (`terminals.html:2637` vs actual `2755-2756`) — a coder trusting them would stare at
the wrong code. Mitigations: scope the test, document the external prompt as out-of-scope,
correct all line numbers.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`
- **Context:** The `ScheduledJob` interface at line 55 declares `teamTarget` with
  `canMoveCards?: boolean`.
- **Logic:** Remove `canMoveCards?: boolean` from the `teamTarget` type. The field is
  optional, so old configs carrying it will still type-check at runtime — but the reader should
  ignore unknown keys rather than throw, since jobs are stored in a shared config blob.
- **Implementation:** Delete `canMoveCards?: boolean` from line 55. No other change to this
  file.
- **Edge Cases:** A persisted job with `teamTarget.canMoveCards: true` must load and run
  minus the appended contract. Since `buildTeamAutomationPrompt` will no longer read the field,
  the contract is simply not appended — the job runs with its base prompt.

### `src/services/schedulerPresets.ts`
- **Context:** `buildTeamAutomationPrompt` (lines 108-118) checks `job.teamTarget?.canMoveCards`
  and appends `BOARD_DRIVING_CONTRACT` when true. `BOARD_DRIVING_CONTRACT` is defined at line 18
  and aliased by `KanbanProvider`.
- **Logic:** Remove the `canMoveCards` conditional (lines 115-117). The function returns
  `basePrompt` unconditionally. Add a comment on `buildTeamAutomationPrompt` stating that
  scheduled prompts carry no board authority and that board actions are host-executed — the
  next `canMoveCards` gets added because nothing says otherwise.
- **Implementation:**
  ```ts
  export function buildTeamAutomationPrompt(job: {
      promptOverride?: string;
      teamTarget?: { groupId?: string; role?: string };
      sourceConfig?: Record<string, unknown>;
  }): string {
      // Scheduled prompts carry NO board authority. Board actions are host-executed
      // (dispatch, advance-plan, advance-feature) — never agent-prompted. An agent with
      // shell access can still run move-card.js, but the scheduling system gives it no
      // reason and no instruction to. Do not re-add a canMoveCards gate here.
      const customPrompt = typeof job.sourceConfig?.prompt === 'string' ? job.sourceConfig.prompt.trim() : '';
      const basePrompt = (job.promptOverride || '').trim() || customPrompt || 'Execute scheduled team automation tasks.';
      return basePrompt;
  }
  ```
- **Edge Cases:** `BOARD_DRIVING_CONTRACT` (line 18) is NOT deleted — it is still used by
  `buildReconcilePrompt` (line 92, until the dependency lands) and aliased by
  `KanbanProvider.BOARD_DRIVING_CONTRACT` for the external prompt. Remove the JSDoc line on
  `buildTeamAutomationPrompt` that says "Includes `BOARD_DRIVING_CONTRACT` when `canMoveCards`
  is true" (line 106).

### `src/webview/terminals.html`
- **Context:** The checkbox is at lines 2753-2758, inside the team automations form.
- **Logic:** Remove the checkbox and its label. The form still creates, edits, enables and
  runs automations — only the card-move authority toggle is gone.
- **Implementation:** Delete lines 2753-2758 (the `<div>` containing the checkbox and label).
  No layout breakage — the div is a standalone row.

### `src/webview/terminals.js`
- **Context:** Three sites reference `canMoveCards`:
  - Line 12157-12163: the `MOVES CARDS` badge in the job card renderer
  - Line 12281, 12293: the checkbox read in the edit form (`canMoveCb`)
  - Line 12320, 12327, 12347, 12359: the checkbox read and write in the save path
- **Logic:** Remove all references. The badge block (12157-12163) is deleted. The checkbox
  element (`team-auto-can-move-cards`) no longer exists in the HTML, so the JS references to it
  must also go — `canMoveCb`, its `.checked` reads, and the `canMoveCards` field in the
  `teamTarget` object written on save.
- **Implementation:**
  - Delete the badge block at lines 12157-12163.
  - Remove `const canMoveCb = document.getElementById('team-auto-can-move-cards');` from both
    the edit-form populate function (line 12281) and the save function (line 12320).
  - Remove `if (canMoveCb) canMoveCb.checked = !!job.teamTarget?.canMoveCards;` (line 12293).
  - Remove `if (canMoveCb) canMoveCb.checked = false;` (line 12303).
  - Remove `const canMoveCards = !!canMoveCb?.checked;` (line 12327).
  - Remove `canMoveCards` from the `teamTarget` object in both the existing-job update
    (line 12347: `existingJob.teamTarget = { groupId: teamId, role };`) and the new-job
    creation (line 12359: `teamTarget: { groupId: teamId, role }`).
- **Edge Cases:** Confirm no other JS code keys on the badge's presence or on
  `canMoveCards` in the cached config.

### `src/test/autoban-state-regression.test.js` (or a new test file)
- **Context:** The existing test at lines 727-732 asserts that `runSchedulerJob` builds both
  surviving prompts. No test currently asserts on the absence of `BOARD_DRIVING_CONTRACT` from
  scheduled prompts.
- **Logic:** Add a string assertion: `buildTeamAutomationPrompt` and `buildFetchPlansPrompt`
  output must NOT contain `BOARD_DRIVING_CONTRACT`, `move-card.js`, or `/kanban/move`.
  `buildReconcilePrompt` is EXCLUDED from this assertion until `reconcile-becomes-host-code.md`
  lands — add a comment stating this.
- **Implementation:**
  ```js
  // Scheduled prompts carry no board authority. Reconcile is excluded until
  // reconcile-becomes-host-code.md lands (it still moves cards by prose).
  const teamPrompt = buildTeamAutomationPrompt({
      promptOverride: 'Do the work.',
      teamTarget: { groupId: 'g1', role: 'lead', canMoveCards: true }
  });
  assert.ok(!teamPrompt.includes('BOARD_DRIVING_CONTRACT'),
      'buildTeamAutomationPrompt must not emit BOARD_DRIVING_CONTRACT even if canMoveCards is set');
  assert.ok(!teamPrompt.includes('move-card.js'),
      'buildTeamAutomationPrompt must not reference move-card.js');
  assert.ok(!teamPrompt.includes('/kanban/move'),
      'buildTeamAutomationPrompt must not reference /kanban/move');

  const fetchPrompt = buildFetchPlansPrompt({ id: 'job_1', sourceConfig: {} });
  assert.ok(!fetchPrompt.includes('BOARD_DRIVING_CONTRACT'),
      'buildFetchPlansPrompt must not emit BOARD_DRIVING_CONTRACT');
  ```
  Note: passing `canMoveCards: true` in the test input verifies the field is ignored even if
  a stale config carries it — the function's type no longer declares it, but runtime objects
  from old configs may still have it.
- **Edge Cases:** The test must import `buildTeamAutomationPrompt` and `buildFetchPlansPrompt`
  from `schedulerPresets.ts`. If the existing test file does not import them, add the imports.

## Verification Plan

### Automated Tests

1. `npm run compile` clean. *(SKIPPED this run per session directive — remains written.)*
2. Grep `canMoveCards`: zero live references outside historical plan files.
3. Test: `buildTeamAutomationPrompt` and `buildFetchPlansPrompt` output contains no
   `BOARD_DRIVING_CONTRACT`, no `move-card.js`, no `/kanban/move`. `buildReconcilePrompt` is
   excluded until `reconcile-becomes-host-code.md` lands.
4. Load a config whose stored job has `teamTarget.canMoveCards: true`; confirm it loads, runs,
   and delivers a prompt with no contract appended.
5. Team automations still create, edit, enable and `RUN NOW` with the checkbox gone and no
   layout breakage in the form.
6. Confirm interactive (non-scheduled) agents that legitimately move cards still receive
   `BOARD_DRIVING_CONTRACT` wherever they did before — specifically
   `_buildExternalAutomationPrompt` (`KanbanProvider.ts:6983`) and `buildReconcilePrompt`
   (`schedulerPresets.ts:92`).
7. Both hosts.

### Goal Invariants

- **Negative:** `canMoveCards` is absent from the `ScheduledJob.teamTarget` type in
  `src/services/GlobalIntegrationConfigService.ts` (grep the file: zero matches).
- **Negative:** The string `MOVES CARDS` is absent from `src/webview/terminals.js` (grep the
  file: zero matches).
- **Negative:** The string `BOARD_DRIVING_CONTRACT` is absent from the output of
  `buildTeamAutomationPrompt` for any input (assert in test).
- **Positive:** `BOARD_DRIVING_CONTRACT` is still present as an export in
  `src/services/schedulerPresets.ts` (the constant is not deleted — it has remaining consumers).
- **Positive:** `BOARD_DRIVING_CONTRACT` is still present in the output of
  `buildReconcilePrompt` (until the dependency lands) and in `_buildExternalAutomationPrompt`
  (permanently).

## Outstanding Questions

- **[user]** The dependency `reconcile-becomes-host-code.md` is not yet implemented. This plan
  is not complete while `buildReconcilePrompt` still moves cards by prose. Should this plan
  proceed now (deleting `canMoveCards` and scoping the test to exclude reconcile), or wait for
  the dependency to land first? — proceeding on the assumption that it proceeds now and the
  reconcile exclusion is documented in the test.

## Recommendation

Complexity 4 → **Send to Coder**.

## Review Findings

The deletion is complete and correctly scoped: `canMoveCards` is gone from the `ScheduledJob`
type, the `terminals.html` checkbox, the `MOVES CARDS` badge and every read/write in
`terminals.js`, and `buildTeamAutomationPrompt` now returns `basePrompt` unconditionally with
the "do not re-add" comment the plan asked for — the only surviving mention of the field in
`src/` is that comment. The two out-of-scope consumers were correctly left intact:
`BOARD_DRIVING_CONTRACT` is still exported, still emitted by `buildReconcilePrompt` (pending
`reconcile-becomes-host-code.md`), and still carried by `_buildExternalAutomationPrompt`, the
human-launched copyable prompt. The one real gap was that the plan's central guard was never
written: both this plan's Goal Invariants and `mission-control-schedules-backend.md`'s
verification step 3 required a test asserting no scheduled prompt builder emits board
authority, and no such assertion existed anywhere — so deleting an inverted gate left nothing
stopping the next person re-adding it, with every other gate staying green. I wrote
`src/test/scheduled-prompts-carry-no-board-authority.test.js` (8 assertions), wired it as
`test:contract:scheduled-no-board-authority` in `package.json` and as a CI step in
`.github/workflows/integration-tests.yml`, and mutation-tested it by re-adding the exact
deleted `canMoveCards` branch — two assertions go red, one on the runtime output and one on the
source. It asserts the contract's *text*, not its identifier, which never appears in output and
so could never fail; and it pins reconcile as a positive so the documented exclusion fails
loudly when its dependency lands rather than outliving its reason. `compile-tests` exit 0.

## Deferred Findings

- NIT — the plan's honest limit still holds and is recorded only in a code comment, not enforced: an agent with shell access can run `move-card.js` whatever its prompt says. This change removes the reason and the instruction, not the capability. `src/services/schedulerPresets.ts:112`
- NIT — `buildReconcilePrompt` remains the one scheduled prompt carrying board authority, as designed, until `reconcile-becomes-host-code.md` lands. The new contract pins this as a positive assertion so it cannot be silently forgotten. `src/services/schedulerPresets.ts:92`
