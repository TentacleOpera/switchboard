# The Orchestrator Becomes an Advisor — Silent Ready Checks, Bounded Answers, Advice on Request

## Goal

The orchestrator's job is judgement, not narration: help a user who does not know what to do, verify that teams are set up correctly, decide what is in scope, and say what it recommends. Checks that pass are silent. Every answer has a stated shape and a ceiling. It never writes an essay about a board the user is looking at.

### Problem & background

**The reported failure is that everything gets overcomplicated: a plan in CREATED produces an essay where a one-line entry and a silent ready check were wanted.**

Three causes, all diagnosed.

**Cause 1 — the pre-flight reports everything it checks, including what passed.** `### The six checks` in the persona (`.agents/skills/switchboard-orchestrator/SKILL.md:59-84`) instructs the agent to "report what you find in plain terms" across six checks. Nothing distinguishes a finding from a non-finding, so an agent doing exactly as told narrates six passes as six paragraphs. Check 1 alone (`:64-73`) asks it to "say so plainly and **strongly recommend** starting a coding team… naming the features you are worried about so the recommendation is concrete rather than generic" — correct guidance for the failure case, and a licence to write at length when nothing is wrong.

**Cause 2 — "ready to go" is never defined as a query, so the agent reads the whole board.** This is fully root-caused in a sibling plan (`feature_plan_20260817193500_orchestrator-cannot-answer-what-plans-are-ready.md`) and the measurement is decisive: `CODE REVIEWED` holds 1732 of the ~1943 active rows on this workspace's board — **89% of everything active**. The persona names CREATED and PLAN REVIEWED as the lanes (check 5 at `:80-82`, `## The Tick` at `:121-138`) but never states what to *exclude*, what source to read, or what shape the answer takes. `GET /kanban/board` returns every active row including subtasks (`LocalApiServer._handleGetPlans` → `_resolveBoard`, `:2753`), and the file read path the agent is steered toward (`switchboard-contracts` #7, "reads prefer local `kanban-state-*.md` files") points at a 735 KB / 3,471-line export that contains **zero** `featureId` markers — so subtask exclusion is not merely unstated, it is impossible from the data the agent was told to prefer. An agent that reads all of that and summarises produces a board tour. That is the reported behaviour, and it is a specification defect rather than a stylistic lapse.

**Cause 3 — the injected project filter is dead context.** The kickoff prompt injects `ACTIVE_PROJECT_FILTER` (`TaskViewerProvider.ts:10631`) and the word "project" appears **zero** times in the persona (verified by grep). The board the user is looking at is project-filtered and exclusive; `GET /kanban/plans?column=` is not filtered at all. So the agent answers about a different board than the one on screen.

### Root cause — the persona was written for the resident-manager role it no longer has

Every instruction above makes sense for an agent that owns the board all night and must justify its autonomous decisions. Once pacing belongs to the lead (subtasks 1–3), the orchestrator's remaining work is advisory and episodic: setup verification, scope, decomposition, and multi-team coordination. Advice is short by nature. The persona is verbose because it was specified for a job it is being relieved of.

### What the orchestrator is actually for

Three entry intents, all advisory:

1. **"I don't know what to do."** The user runs `/switchboard` with no plan. The orchestrator advises: how to set up a team, how to organise a project, what to work on first.
2. **Driving Switchboard from a non-IDE coding app.** The user activates the orchestrator and it brings the board up. The launcher already does this — `.agents/workflows/switchboard.md` step 1 health-checks `.switchboard/api-server-port.txt` and runs `npx switchboard` on a non-200 (`bin.switchboard` → `dist/standalone/cli.js`). This needs documenting in the persona, not building.
3. **Genuine coordination** — multiple teams across worktrees or separate repos, and decomposing work that is not yet shaped into plans.

What it is *not* for: pacing a one-at-a-time pipeline. That is a manager watching a manager.

---

## Metadata

- **Complexity:** 3
- **Tags:** docs, refactor, reliability
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Five decisions made here:

* **Silence is the default for a passing check.** Only failures and recommendations are spoken.
* **"Ready to go" gets one deterministic definition** — the query, its exclusions, its source and its answer shape — and the existing consumers point at that one definition so it cannot drift.
* **HTTP, not the markdown exports, for readiness questions.** The exports cannot express subtask exclusion, so preferring them is wrong for this specific question and the persona must say so.
* **Answers have stated ceilings.** A cap the agent can read is the only thing that reliably prevents a board tour.
* **The project filter is honoured.** An answer about an unfiltered board when the user is looking at a filtered one is wrong, not merely verbose.

---

## Complexity Audit

### Routine

- Editing one markdown persona file. No compile, no schema, no state, no migration.
- Adding assertions to `src/test/orchestrator-tick-and-reports-contract.test.js`, which already reads this file (`PERSONA` constant at `:55`) and already asserts `## The Tick` exists (`:93`).
- The query itself is two calls to endpoints that already exist and already return `featureId`, `isFeature` and `project` — no API change.

### Complex / Risky

- **Persona rules can contradict each other, and nothing compiles them.** The existing gate exists precisely because a previous rewrite left a Hard Rule contradicting a section three headings below it. A new section must not restate the lanes in different words from `## The Tick`; it must be the single definition both refer to.
- **Two live plans currently specify this same section under different names** — see the reconciliation callout below. Landing both produces two competing ready-set definitions in one file and two gate assertions keyed on different headings.
- **`CODE REVIEWED` already appears in the persona for a legitimate reason** — `## What You Never Do` forbids advancing a card to it. A gate that simply forbids the string fails on that mention; the assertion must be shaped around it.
- **Silence is hard to gate.** "Contains no instruction to report a passing check" is a negative assertion over prose. It has to be pinned to specific phrasing the rewrite removes, or it passes vacuously.

---

## Edge-Case & Dependency Audit

### Race Conditions

- None — this is a documentation change with no runtime state.

### Security

- None. The copy-pasteable command reads localhost endpoints the persona already uses.

### Side Effects

- **The persona is launched by path and has no `.claude` mirror.** `switchboard-orchestrator` is deliberately absent from `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:46`: "the engine launches it by path"). There is no second copy to update and no mirror check to satisfy — but also no mirror drift to catch a bad edit, which is why the contract test is the whole gate.
- **Empty `ACTIVE_PROJECT_FILTER` means no filter, not "match empty".** The kickoff injects the line unconditionally with an empty value when no project is active (`ACTIVE_PROJECT_FILTER=${projectFilter || ''}`, `TaskViewerProvider.ts:10631`). Filtering on `project == ""` would return only unassigned cards — the inverse of the intent.
- **`BACKLOG` is not `CREATED` and `DISPATCH` is not `PLAN REVIEWED`.** Both are stored columns rendered inside another column's slot (`DISPLAY_MODE_COLUMNS`, `agentConfig.ts:165`). The query must match the exact column string, never "the CREATED slot".
- **A ready `PLAN REVIEWED` card is either a feature or a standalone plan.** Both are dispatchable under the default `none` worktree topology. Label which is which via `isFeature`; do not filter one out.
- **`CREATED` holding zero subtasks today does not make the exclusion optional.** A subtask nested under a `BACKLOG` feature can carry `kanban_column='CREATED'` (`switchboard-contracts` #6).
- **The exports stay the preferred bulk read for everything else.** This carves out one question; it does not overturn `switchboard-contracts` #7.

### Dependencies & Conflicts

- **Reconciliation — this plan and `feature_plan_20260817193500_orchestrator-cannot-answer-what-plans-are-ready.md` write the same section of the same file.** That plan is live in `CREATED` and specifies `## What Is Ready To Go` with exact text, a copy-pasteable `jq` command, an answer shape, a truncation rule and gate assertions. This plan specified the same definition as `## The ready set`. Two headings, one meaning, one file, one gate file. Resolved below by adopting the sibling's heading and gate wholesale — see the Superseded callout in Proposed Changes.
- **Subtasks 4, 6 and 7 also edit this persona.** Per the project's orchestration discipline (one agent stream per file), persona edits serialise. This plan lands first because it shrinks the file the other three go on to edit.
- **Subtask 6 adds `## Handoff, or arm?` and `## The handoff sequence`**, which depend on this plan's `## What Is Ready To Go` for their scoping step.

---

## Dependencies

- `feature_plan_20260817193500_orchestrator-cannot-answer-what-plans-are-ready.md` (planId `b32d3e1a-de81-4c08-b654-e4ba4659748b`, column `CREATED`) — **superseded by this plan**; its content is absorbed here. Recommend deleting the card rather than coding both.
- `3d112587-…` is this plan; nothing in this feature blocks it.

---

## Adversarial Synthesis

**Risk summary.** The only real risk is duplicate authorship of one persona section: a live sibling plan specifies the same ready-set definition under a different heading, and coding both leaves the persona with two competing definitions and a gate that passes on either. Mitigation is to adopt the sibling's exact heading, query and gate assertions here and retire that card. Secondary risk is a vacuous silence gate — a negative assertion over prose that passes because the phrasing it forbids was never present; mitigation is to pin the assertion to the specific instruction being removed and mutation-test it.

---

## Proposed Changes

### 1. `.agents/skills/switchboard-orchestrator/SKILL.md` — one ready-set definition

> **Superseded:** "Add `## The ready set` — one deterministic definition."
> **Reason:** A live sibling plan (`feature_plan_20260817193500_orchestrator-cannot-answer-what-plans-are-ready.md`, in `CREATED`) already specifies this exact definition in this exact file under the heading `## What Is Ready To Go`, with the query, the exclusions, the copy-pasteable command, the answer shape, a 25-row truncation rule and the gate assertions. Two plans writing the same section under two names into one file is the reconciliation failure this feature's review exists to catch: whichever lands second either duplicates the definition or silently drops the other's gate.
> **Replaced with:** this plan owns the section and uses the sibling's heading **`## What Is Ready To Go`** and its assertions verbatim, so there is exactly one definition, one heading and one gate. The sibling card is redundant and should be deleted rather than coded.

Insert after `## Hard Rules` (ends `:27`) and before `## Pre-flight` (`:29`), so both consumers below it point up at one definition. The section states:

- **Ready = dispatchable right now by one of the two lanes** — `CREATED` (planning) and `PLAN REVIEWED` (coding).
- **Exclude every subtask** — a row with a non-empty `featureId` is rolled up under its feature on the board and is not a card the user sees (`switchboard-contracts` #6, cited by name).
- **Exclude every other column** — `LEAD/CODER/INTERN CODED` is in progress; `CODE REVIEWED`, `ACCEPTANCE TESTED`, `COMPLETED` are finished; `BACKLOG` is parked; `DISPATCH` is the staged queue.
- **Honour `ACTIVE_PROJECT_FILTER`** — when non-empty keep only rows whose `project` equals it exactly; when empty, filter nothing.
- **Do not read `.switchboard/kanban-state-*.md` for this question** — those exports carry no `featureId` marker, so the subtask exclusion cannot be applied to them at all. Bulk reads still prefer the exports; this one question uses the API.
- **A copy-pasteable command** producing exactly this, over `GET /kanban/plans?column=…&workspaceRoot=…` with `jq`.
- **The answer shape** — lead with the two counts, then one line per card (type, title, planId). Nothing else: no columns that were not asked about, no subtask breakdown, no summary of finished work, no advice. Over 25 rows in a lane, list 25 and print `+N more`; never truncate silently.

### 2. `.agents/skills/switchboard-orchestrator/SKILL.md` — silent checks

**Context.** `### The six checks` (`:59-84`) opens with "Report what you find in plain terms" and never distinguishes a pass from a finding.

**Implementation.** Rewrite each check to state its pass condition and that **a pass produces no output**. The report becomes: findings only, or the single line `Pre-flight clear.` Check 1's team recommendation stays — it is genuinely valuable — but fires only when features are in scope and no coding team is seated. Check 5 is replaced by a reference to `## What Is Ready To Go` (run the query, report the two counts) rather than restating the lanes in different words.

### 3. `.agents/skills/switchboard-orchestrator/SKILL.md` — point `## The Tick` at the definition

The lane list (`:127-135`) stays exactly as written — it is the dispatch rule and must not be reworded. Add one line beneath it: both lanes read the same set, resolved the same way, by the query in `## What Is Ready To Go`.

### 4. `.agents/skills/switchboard-orchestrator/SKILL.md` — the two advisory entries and the project filter

**Implementation.**

- Document the **no-idea-what-to-do** entry: what to advise and in what order (seat a team, organise a project, pick the first card).
- Document the **non-IDE** entry: the launcher (`.agents/workflows/switchboard.md` step 1) brings the board up via `npx switchboard`; the orchestrator does not reimplement it.
- Explain `ACTIVE_PROJECT_FILTER` where it is used — the same value the `## What Is Ready To Go` query consumes — so the injected line stops being dead context.

### 5. `src/test/orchestrator-tick-and-reports-contract.test.js` — gate it

**Context.** The persona is executable specification with no compiler; this file is the only thing in CI that reads it (`PERSONA` at `:55`).

**Implementation.** Add beside the existing persona checks:

```js
await check('persona defines the ready-to-go query, its exclusions, and its source', () => {
    assert.ok(/\n## What Is Ready To Go\n/.test(persona), 'persona has no ## What Is Ready To Go section');
    assert.ok(/featureId/.test(persona), 'persona does not state the subtask exclusion (featureId)');
    assert.ok(/ACTIVE_PROJECT_FILTER/.test(persona), 'persona ignores the injected project filter — the answer would not match the board');
    assert.ok(/kanban-state-\*\.md/.test(persona), 'persona does not route this question off the per-column exports (they carry no featureId)');
    assert.ok(/kanban\/plans/.test(persona), 'persona names no endpoint for the ready query');
    // CODE REVIEWED also appears legitimately in ## What You Never Do, so assert
    // the exclusion sentence exists rather than forbidding the string.
    assert.ok(
        /Exclude every other column[\s\S]{0,400}CODE REVIEWED/.test(persona),
        'persona does not exclude the finished columns from the ready set'
    );
    assert.ok(/BACKLOG/.test(persona) && /DISPATCH/.test(persona), 'persona does not exclude the two display-mode columns');
});

await check('pre-flight check 5 and the tick both defer to the one ready definition', () => {
    const refs = persona.match(/## What Is Ready To Go/g) || [];
    assert.ok(refs.length >= 3, `the ready definition is referenced ${refs.length} times — check 5 and ## The Tick must both point at it instead of restating the columns`);
});

await check('a passing pre-flight check produces no output', () => {
    assert.ok(/Pre-flight clear\./.test(persona), 'persona names no silent-pass report line');
    assert.ok(!/Report what you find in plain terms/.test(persona), 'the six checks still instruct the agent to narrate every check');
});
```

**Edge Cases.** The last assertion is a negative over prose — mutation-test it (restore the old sentence, confirm red) or it is decoration.

---

## Verification Plan

### Automated Tests

- `npm run test:contract:orchestrator-tick` — passes, including the three new checks.
- **Mutation-test the gate:** delete the `## What Is Ready To Go` heading and confirm red; delete only the `ACTIVE_PROJECT_FILTER` line and confirm red; restore the "Report what you find in plain terms" sentence and confirm red. A gate that cannot go red is not a gate.
- **Consistency check:** no surviving reference in the persona to mechanisms subtask 4 deletes.

### Manual UAT

- **The reported failure:** with one plan in CREATED, ask "what plans are ready to go?" The answer must be one line for that plan and nothing else. No subtasks, no CODE REVIEWED, no commentary on finished work.
- Pre-flight on a correctly-configured workspace emits `Pre-flight clear.` and nothing more.
- Pre-flight with features in scope and no coding team still produces the team recommendation, naming the features.
- With a project filter active, the ready set matches the filtered board on screen; with no project active, nothing is filtered.

---

**Recommendation:** Complexity 3 → **Send to Intern.** (Documentation and a contract test — but it is the persona, so the gate assertions are the deliverable, not the prose.)

---

## Completion Report

Implemented the orchestrator advisor transition in `.agents/skills/switchboard-orchestrator/SKILL.md` by defining `## What Is Ready To Go` with deterministic HTTP queries and subtask exclusions, converting pre-flight checks into silent checks with `Pre-flight clear.`, and documenting advisory entries and `ACTIVE_PROJECT_FILTER`. Updated `src/test/orchestrator-tick-and-reports-contract.test.js` with contract checks asserting the query definitions, cross-references, and silent pre-flight behavior. All modifications were restricted to the target skill and contract test without encountering any blocking issues.

---

## Review Findings

Clean. `## What Is Ready To Go` is present under the sibling plan's heading with the subtask exclusion (`featureId`), the column exclusions, `ACTIVE_PROJECT_FILTER`, the routing-off-the-exports rule and the HTTP query; the pre-flight checks are silent-on-pass with `Pre-flight clear.`; the redundant card `feature_plan_20260817193500_orchestrator-cannot-answer-what-plans-are-ready.md` was deleted rather than coded, as the reconciliation required. The gate assertions in `src/test/orchestrator-tick-and-reports-contract.test.js` are wired into CI (`integration-tests.yml:730`) and pass. The one issue found belongs to subtask 6, not here: the persona's handoff sequence pointed at `POST /taskViewer/verb/stageForQueue` — wrong router, and not allowlisted on either — which is fixed under that plan.

**Verification:** `npm run test:contract:orchestrator-tick` passes; `npm run mirror:check` green (this persona is deliberately absent from `MIRROR_MANIFEST`, so there is no `.claude` copy to drift). **Remaining risk:** the plan's mutation-test step for the negative silence assertion was not evidenced; a gate over prose that has never been observed red is not yet proven to be a gate.

---

## Completion Report (review pass)

Reviewed against this plan and found no defects requiring a fix in the persona or its contract test — the ready-set definition, the silent pre-flight, the advisory entries and the project-filter explanation all landed as specified, and the absorbed sibling card was deleted. The only related repair (the handoff sequence's wrong verb router) was applied under subtask 6, which owns that section. No files changed for this subtask.
