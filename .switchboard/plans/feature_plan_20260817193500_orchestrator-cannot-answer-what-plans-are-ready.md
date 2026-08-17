# The Orchestrator Cannot Answer "What Plans Are Ready To Go" — It Reads the Whole Board and Leads With Finished Work

## Goal

When the operator asks the orchestrator agent "what plans are ready to go?", the answer is a short list of the cards it could dispatch right now — nothing else. No subtasks, no CODE REVIEWED archive, no commentary about work that is already finished.

Today the same question produces a tour of the board: subtasks the operator never sees as cards, and plans sitting in CODE REVIEWED. The operator's complaint is that this is meant to be a simple feature, and it keeps behaving like a board dump.

### Problem analysis

The orchestrator persona (`.agents/skills/switchboard-orchestrator/SKILL.md`, launched by path from `TaskViewerProvider.startOrchestratorFromKanban`, `TaskViewerProvider.ts:10540`) never defines the dispatchable set as a query. It states the two lanes in prose — pre-flight check 5 ("Plans in CREATED, features in PLAN REVIEWED", line 80) and `## The Tick` (lines 127–135) — and nowhere states what to *exclude*, what source to read, or what shape the answer takes. An agent handed a question with no query definition reads the whole board and summarises what it read.

**What "the whole board" actually is here.** Measured against this workspace's `kanban.db` (`workspace_id = 038bffef-9842-4574-96a1-69a43a280b3c`, `status='active'`):

| Column | Rows | of which subtasks | of which features |
| :--- | ---: | ---: | ---: |
| CODE REVIEWED | 1732 | 526 | 167 |
| PLAN REVIEWED | 153 | 106 | 37 |
| BACKLOG | 38 | 3 | 1 |
| CREATED | 12 | 0 | 0 |
| INTERN CODED | 4 | 0 | 0 |
| CODER CODED | 2 | 0 | 0 |
| LEAD CODED | 1 | 0 | 0 |
| DISPATCH | 1 | 0 | 0 |

CODE REVIEWED is **89% of every active row on the board**. Any agent that reads the board wholesale and then summarises will spend most of its answer there — which is exactly the reported behaviour, not a stylistic lapse.

The genuinely ready set is small and easy to state: **CREATED = 12 top-level cards** (0 subtasks) and **PLAN REVIEWED = 47 top-level cards** (153 rows minus 106 subtasks; 37 features + 10 standalone plans). 56 lines of answer, available from two HTTP calls.

### Root cause 1 — no subtask exclusion rule anywhere in the persona

`GET /kanban/board` and `GET /kanban/plans?column=…` return **every** active row, subtasks included (`LocalApiServer._handleGetPlans` → `_resolveBoard` → `db.getBoard`, `LocalApiServer.ts:2753-2771`). Each row carries `featureId` and `isFeature` (verified live: a `PLAN REVIEWED` fetch returns 153 rows, 47 with an empty `featureId`, 37 of those with `isFeature: 1`), so the exclusion is trivially expressible — but the persona never asks for it. The rule exists in `switchboard-contracts` #6 ("Column sweeps **must exclude** subtasks"), and the orchestrator persona never tells the agent to read that file.

### Root cause 2 — the persona names no upper bound on the columns

`## The Tick` names CREATED and PLAN REVIEWED as the two lanes' inputs, but nothing states that the remaining columns are *not* an answer to a readiness question. `LEAD/CODER/INTERN CODED` is in progress, `CODE REVIEWED` / `ACCEPTANCE TESTED` / `COMPLETED` is finished, `BACKLOG` is deliberately parked (a stored column rendered inside CREATED's slot — `DISPLAY_MODE_COLUMNS`, `agentConfig.ts:165-168`), and `DISPATCH` is a manual staging view. A persona that says "these two are the lanes" without saying "and nothing else is ready" leaves the agent free to be helpful about all eight.

### Root cause 3 — the file-based read path steers straight into the archive

`switchboard-contracts` #7 tells agents that "reads prefer local `kanban-state-*.md` files". `.switchboard/kanban-board.md` is an index that links one export per column, CODE REVIEWED included. That export is **735 KB / 3,471 lines** in this workspace, and — measured — contains **zero** `featureId` markers, so subtask exclusion is *impossible* from the exports. An agent that follows the general read preference for this specific question cannot produce a correct answer from the data it read.

### Root cause 4 — the injected project filter is dead context

The kickoff prompt injects `ACTIVE_PROJECT_FILTER=<project>` (`TaskViewerProvider.ts:10557`). The word "project" does not appear **once** in the persona (grep count: 0). The board the operator is looking at is project-filtered and exclusive — `getBoardFilteredByProject` matches `pr.name = ?` and drops unassigned rows (`KanbanDatabase.ts:4108-4111`) — while `GET /kanban/plans?column=` is not filtered at all. So the agent answers about a board the operator is not looking at. (Live check: of the 47 ready PLAN REVIEWED cards, 43 are `Browser Switchboard` and 4 are unassigned.)

### What this plan does

Adds one section to the persona that defines "ready to go" as a deterministic query with explicit exclusions, a copy-pasteable command, and a bounded answer shape — then points the two existing consumers (pre-flight check 5, `## The Tick`) at that one definition so it cannot drift. Wires the new section into the existing persona gate so a future rewrite cannot silently delete it.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, docs, reliability
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Adding a section to a markdown persona file. No compile, no schema, no state.
- Adding three assertions to an existing contract test that already reads this file.
- The query itself is two calls to endpoints that already exist and already return the needed fields (`featureId`, `isFeature`, `project`) — no API change.

### Complex / Risky

- **Persona rules can contradict each other, and nothing compiles them.** The existing gate (`src/test/orchestrator-tick-and-reports-contract.test.js`) exists precisely because a previous rewrite left a Hard Rule contradicting a section three headings below it. The new section must not restate the lanes in different words from `## The Tick`; it must be the single definition both refer to.
- **`CODE REVIEWED` already appears in the persona for a different reason** — `## What You Never Do` forbids advancing a card to it. A grep-based gate that simply forbids the string would fail on the legitimate mention; the assertion has to be shaped around that.
- **No migration, no state, no user data.** The only risk is prose that reads well and instructs badly.

## Edge-Case & Dependency Audit

- **`BACKLOG` is not `CREATED`.** It is a stored column ID rendered inside CREATED's slot by a header toggle. 38 rows live there in this workspace. Parked ≠ ready — the query must match on the exact column string, never on "the CREATED slot".
- **`DISPATCH` is not `PLAN REVIEWED`.** Same shape: a display mode of PLAN REVIEWED (`DISPLAY_MODE_COLUMNS`), and the Dispatch view is manual buttons, not automation. Excluded.
- **A ready PLAN REVIEWED card is either a feature or a standalone plan.** Both are dispatchable: under the default `none` worktree topology "a standalone plan dispatches straight to a team with no feature required" (persona, `## Obey the worktree setting`). The answer must label which is which (`isFeature`), not filter one out.
- **CREATED currently holds zero subtasks — the exclusion is still mandatory.** A subtask nested under a BACKLOG feature can carry `kanban_column='CREATED'` (`switchboard-contracts` #6). A rule that happens to be a no-op today is not optional.
- **Empty `ACTIVE_PROJECT_FILTER` means no filter, not "match empty".** The kickoff injects the line unconditionally with an empty value when no project is active (`ACTIVE_PROJECT_FILTER=${projectFilter || ''}`). Filtering on `project == ""` would return only unassigned cards — the inverse of the intent.
- **The exports stay the preferred bulk read for everything else.** This plan carves out one question; it does not overturn `switchboard-contracts` #7. The persona states the exception and why (no `featureId` marker in the exports).
- **Explicitly out of scope: stamping `featureId` into the `kanban-state-*.md` exports.** That would fix the root cause for every file-reading agent, but it changes an export format with other consumers and belongs on its own card. This plan routes the orchestrator to the API instead, which already carries the field.
- **Dependency: `jq` and the port file.** Both are already assumed by the `switchboard-orchestration` skill's examples (`curl -s "$BASE/kanban/board" | jq '.data'`) and by the persona's own confirm snippet. No new dependency.
- **Resume mode reads `session.md`, not the board.** The new section is a query the agent runs when asked or when running check 5 — it must not imply that a resumed tick re-derives readiness from a cached list. `## Re-derive every wake` already governs that; the section adds no competing claim.

## Proposed Changes

### 1. `.agents/skills/switchboard-orchestrator/SKILL.md` — one section defining the ready set

Insert after `## Hard Rules` (ends line 27) and before `## Pre-flight` (line 29), so both consumers below it can point up at one definition:

```markdown
## What Is Ready To Go

"What plans are ready?" is a query, not a judgement and not a board summary.
Ready = **dispatchable right now by one of your two lanes**:

| Lane | Column | What is in it |
| :--- | :--- | :--- |
| Planning | `CREATED` | plans waiting for a planner |
| Coding | `PLAN REVIEWED` | features and standalone plans waiting for a coding team |

Nothing else answers this question:

- **Exclude every subtask.** A row with a non-empty `featureId` is rolled up under
  its feature on the board — the operator does not see it as a card, and naming it
  is noise (`switchboard-contracts` #6: subtasks carry their own column).
- **Exclude every other column.** `LEAD CODED` / `CODER CODED` / `INTERN CODED` is
  in progress; `CODE REVIEWED`, `ACCEPTANCE TESTED` and `COMPLETED` are finished
  work; `BACKLOG` is parked; `DISPATCH` is a manual staging view. On a mature board
  the finished columns are the overwhelming majority of all rows, so a summary that
  starts there buries the answer instead of giving it.
- **Honour the project filter.** Your prompt carries `ACTIVE_PROJECT_FILTER`. When
  it is non-empty, keep only rows whose `project` equals it exactly — that is the
  board the operator is looking at. When it is empty, filter nothing.
- **Do not read `.switchboard/kanban-state-*.md` for this question.** Those exports
  carry no `featureId` marker, so the subtask exclusion cannot be applied to them at
  all, and the CODE REVIEWED export alone runs to hundreds of kilobytes. Bulk reads
  still prefer the exports; this one question uses the API.

Ask the API. Substitute `WS` and `PROJ` from the `WORKSPACE_ROOT` and
`ACTIVE_PROJECT_FILTER` lines in your prompt:

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"
WS="<WORKSPACE_ROOT>"; PROJ="<ACTIVE_PROJECT_FILTER, empty if none>"
ready () {
  curl -s --get "$BASE/kanban/plans" \
    --data-urlencode "column=$1" --data-urlencode "workspaceRoot=$WS" \
  | jq -r --arg proj "$PROJ" '
      .data
      | map(select((.featureId // "") == ""))
      | map(select($proj == "" or .project == $proj))
      | .[] | "\(if .isFeature == 1 then "feature" else "plan  " end)\t\(.topic)\t\(.planId)"'
}
ready "PLAN REVIEWED"   # coding lane
ready CREATED           # planning lane
```

### The shape of the answer

Lead with the two counts, then one line per card: type, title, planId. Nothing
else — no columns that were not asked about, no subtask breakdown, no summary of
what is already coded, no advice.

```
Ready to go — 43 to code, 13 to plan.

To code (PLAN REVIEWED):
  feature  Teams You Can See, Start and Trust                 7c52086e
  plan     Clear the CLI input line before every slash command a1b2c3d4
To plan (CREATED):
  plan     A Phone-a-Friend Seat Has No Brand Identity         5eac4e60
```

If a lane holds more than 25 cards, list the 25 most recently updated — the API
already orders newest first — and end that lane with `+N more`. Never truncate
without printing the remainder.
```

### 2. `.agents/skills/switchboard-orchestrator/SKILL.md` — point check 5 at the definition

Replace pre-flight check 5 (lines 80–82) so it runs the query instead of restating it in different words:

```markdown
5. **Is there anything to do at all?** Run the query in
   `## What Is Ready To Go` and report the two counts. An empty board gets
   "there is nothing to do" rather than a session that will idle all night.
```

### 3. `.agents/skills/switchboard-orchestrator/SKILL.md` — one cross-reference in `## The Tick`

The lane list (lines 127–135) stays exactly as written — it is the dispatch rule and must not be reworded. Add one line directly beneath it:

```markdown
Both lanes read the same set, resolved the same way, by the query in
`## What Is Ready To Go`.
```

### 4. `src/test/orchestrator-tick-and-reports-contract.test.js` — gate the section

The persona is executable specification with no compiler; this file is the only thing in CI that reads it. Add beside the existing persona checks (after the `persona describes both lanes and their capacity guards` check, ~line 98):

```js
await check('persona defines the ready-to-go query, its exclusions, and its source', () => {
    assert.ok(/\n## What Is Ready To Go\n/.test(persona), 'persona has no ## What Is Ready To Go section');
    assert.ok(/featureId/.test(persona), 'persona does not state the subtask exclusion (featureId)');
    assert.ok(/ACTIVE_PROJECT_FILTER/.test(persona), 'persona ignores the injected project filter — the answer would not match the board');
    assert.ok(/kanban-state-\*\.md/.test(persona), 'persona does not route this question off the per-column exports (they carry no featureId)');
    assert.ok(/kanban\/plans/.test(persona), 'persona names no endpoint for the ready query');
    // The finished columns must appear ONLY as exclusions. CODE REVIEWED also
    // appears legitimately in ## What You Never Do (the forbidden advance), so
    // assert the exclusion sentence exists rather than forbidding the string.
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
```

## Verification Plan

### Automated

1. `npm run test:contract:orchestrator-tick` — passes, including the two new checks.
2. Mutation-test the gate, so it is not decoration: delete the `## What Is Ready To Go` heading from the persona and confirm the run goes red; delete only the `ACTIVE_PROJECT_FILTER` line and confirm it goes red; restore.
3. `npm run mirror:check` — confirms the `.claude` mirror is unaffected. (`switchboard-orchestrator` is deliberately absent from `MIRROR_MANIFEST` — `ClaudeCodeMirrorService.ts:46` — so there is no second copy of this persona to update. Verify no `.claude/skills/switchboard-orchestrator/` directory appears.)

### Manual

4. Run the query by hand against the live board and confirm the numbers are the small ones, not the board's:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   curl -s --get "http://127.0.0.1:$PORT/kanban/plans" \
     --data-urlencode "column=PLAN REVIEWED" \
     --data-urlencode "workspaceRoot=$PWD" \
   | jq '[.data[] | select((.featureId // "") == "")] | length'
   ```
   Expect a count in the tens (47 at the time of writing), not 153, and not ~1900.
5. AUTOMATION tab → Start orchestrator with no `session.md` present. The pre-flight report's check 5 states two counts and lists no CODE REVIEWED card and no subtask.
6. In that same terminal, ask "what plans are ready to go?" The reply is the two counts plus one line per card. Nothing about CODE REVIEWED, nothing about subtasks, no advice.
7. Set the board's project filter to a project with no ready cards, restart the orchestrator, and ask again: the answer is "nothing to do" for that project — not a list from other projects.
