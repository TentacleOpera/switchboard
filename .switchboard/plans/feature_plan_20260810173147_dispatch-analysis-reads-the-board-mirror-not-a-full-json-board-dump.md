# Dispatch-Analysis Reads the Per-Column Board Mirror Instead of Pulling the Whole Board as JSON

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** The stated prerequisite `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md` was **retired and its file deleted** — `DISPATCH` was replaced by a real `STAGING` column in commit `52404992`, so migration V60 and the `plans.staged_at` stamp were never built. Remove the "serialises behind" dependency and the `staged_at` references; anchor on the live STAGING column.


## Goal

Make the dispatch-analysis pass read the board from `.switchboard/kanban-state-<column>.md` — the per-column markdown mirror the extension already writes — instead of `GET /kanban/board`, which returns the entire workspace board as one JSON document. Keep the HTTP endpoint as an explicit, documented fallback for the one case where the mirror is genuinely not there.

### The problem

`.agents/skills/dispatch-analysis/SKILL.md` step 1 opens with:

```
GET http://localhost:{API_PORT}/kanban/board?workspaceRoot={WORKSPACE_ROOT}
```
> Filter for cards where `kanbanColumn === 'PLAN REVIEWED'`.

That endpoint (`LocalApiServer._handleGetBoard` → `_resolveBoard` → `db.getBoard(wsId)`) returns **every active plan record in the workspace**, unfiltered, with all 33 columns of the plan row. Measured against this workspace's live server on 2026-08-10:

| Source | Bytes | Records | Records the pass actually uses |
| :--- | ---: | ---: | ---: |
| `GET /kanban/board` | **1,643,235** | 1,709 | 55 |
| `GET /kanban/plans?column=PLAN%20REVIEWED` | 57,237 | 55 | 55 |
| `.switchboard/kanban-state-plan-reviewed.md` | **27,950** | 55 | 55 |

1,599 of the 1,709 records (94%) are in `CODE REVIEWED` — closed work that the parallel-safety analysis never looks at. The skill asks the agent to pull 1.6 MB to reach 28 KB of signal, and the skill text gives no `jq` filter, so an agent that follows it literally (`curl` the URL, read the response) drops the whole document into its context before it has read a single plan file. The skill then spends a paragraph and a three-row table teaching the agent how to resolve the `planFile` field into a readable path — work the mirror has already done.

### Root cause

The per-column mirror shipped on 2026-06-28 (`b7f999ac`, "Split Kanban Board Export into Per-Column Markdown Files"). The dispatch-analysis skill was authored on 2026-08-07 (`842e4187`) against the `switchboard-orchestration` HTTP catalog — the generic "here is the board endpoint" surface — rather than against the mirror. Nothing forced the two into agreement, so the skill reached for the endpoint that was documented next to `POST /kanban/move` (which it genuinely does need) and used it for the read as well.

This also puts the skill in direct conflict with contract #7 in `.agents/skills/switchboard-contracts/SKILL.md`:

> **Every API call carries `workspaceRoot`; reads prefer local `kanban-state-*.md` files; the extension is the sole `kanban.db` writer.**

The `switchboard` workflow (`.agents/workflows/switchboard.md:57-62`) already parses the mirror with an `awk` pass at entry, so the pattern is established and blessed everywhere except here.

### Why the mirror is sufficient — field by field

`KanbanDatabase._writeLocalBoardMirror` (src/services/KanbanDatabase.ts:9066-9105) emits one file per column. Every card line looks like:

```
- [<planFile>](<absolute path>) — <topic> <!-- planId:<uuid> [feature] [subtask-of:"<parent topic>"] [project:"<name>"] -->
```

| Step of the skill | Needs | Mirror supplies |
| :--- | :--- | :--- |
| 1 — find the Planned column | `kanbanColumn === 'PLAN REVIEWED'` | the **filename** is the column (`_columnSlug('PLAN REVIEWED')` → `plan-reviewed`); no filtering required |
| 1 — project scoping | `project` | `project:"<name>"` marker, absent when unpinned |
| 1a — feature vs subtask | `isFeature`, `featureId` | ` feature` marker; `subtask-of:"<parent topic>"` marker |
| 1a — parent feature's column | parent's `kanbanColumn` | **implicit**: if the parent's `feature`-marked line is not in this file, the parent is in another column |
| 2 — read the plan file | `planFile` in one of 3 forms | the link **href** is already an absolute, resolved path |
| 2 — complexity | `complexity` | read from the plan file itself, exactly as today |

The parent-column check in step 1a is the one that gets strictly *simpler*: today it needs a second lookup to discover where the parent lives; against the mirror it is a same-file membership test.

### Freshness — the skill's stated reason for the API call — holds

The skill justifies the query as "the plan list in the prompt may be stale by the time analysis runs — always re-query for freshness". The mirror satisfies that:

- `_scheduleLocalMirror()` fires on every successful `_persist()` (src/services/KanbanDatabase.ts:9285) with a 500 ms debounce (`LOCAL_MIRROR_DEBOUNCE_MS`), and re-runs immediately if a write landed while one was in flight.
- The write is atomic (`tmp` + `rename`), so a reader never sees a torn file.
- Dispatch-analysis is only ever reached with the extension running — it is dispatched by the board's **Analyze** button or copied from the **Copy dispatch prompt** button, both of which build the prompt in-process and stamp `API_PORT`. The debounce window closes long before the agent boots, reads the skill, and gets to step 1.

The mirror's content hash (`_localMirrorLastHash`) covers `planId`, `kanbanColumn`, `topic`, `planFile`, `isFeature`, `featureId`, and `project` — every field the mirror renders — so a skipped rewrite means nothing the skill reads has changed.

## Metadata

- **Complexity:** 3
- **Tags:** docs, performance, reliability
- **Project:** Browser Switchboard

## User Review Required

**None.** Four decisions made here:

* **The mirror is the primary read; `/kanban/plans?column=` is the fallback; `/kanban/board` is neither.** The board endpoint stays in the codebase untouched for its other callers, but it stops being an instruction in this skill.
* **The fallback is detected by file absence, not by reading the `boardStateExport` setting.** The agent cannot read VS Code settings, and a missing file is the exact and only symptom of every reason the mirror might not be where the prompt says.
* **The `subtask-of:` quote strip is in scope.** It is a two-line change in `KanbanDatabase.ts`, and this plan is what makes the marker load-bearing. Shipping the parser without the strip means a feature titled with a `"` silently drops its subtasks from the analysis.
* **No prompt-body change.** See "Deliberately out of scope" below.

## Complexity Audit

* **Score:** 3 / 10

### Routine

* The bulk of the change is rewriting one section of one skill file that no code parses. The extension does not read step 1; it only injects `WORKSPACE_ROOT`, `API_PORT`, `PROJECT=` and the plan list, and it hands the agent the skill path to read.
* The `subtask-of:` quote strip is a one-line `.replace(/"/g, '')` mirroring the `project` handling three lines away.

### Complex / Risky

* **Step 1a's parent-lookup and step 2's path resolution get their semantics changed, not just their transport.** The rewrite has to preserve both guarantees exactly (a subtask whose parent is elsewhere is skipped; an unreadable plan stays in Planned) or the pass gets *less* safe, which is the failure mode that matters — a wrongly-promoted card means two agents editing the same file in parallel.
* **No CI gate watches this file.** `.agents/skills/dispatch-analysis/SKILL.md` has no `.claude/skills` mirror and `npm run mirror:check` never sees it, so a regression in the skill's prose is caught only by the assertions this plan adds to `dispatch-analysis-scope-contract.test.js`. Those assertions are the gate, not a nicety.
* **Three plans edit this file** (see Dependencies). This one is authored **second**, against the staging plan's already-rewritten step 5.

**Deliberately out of scope:**
- **No prompt-body change.** `KanbanProvider.generateUnifiedPrompt`'s dispatch-analysis arm already passes `WORKSPACE_ROOT`; the skill derives the mirror path from it. `src/test/dispatch-analysis-scope-contract.test.js` asserts the exact byte layout `API_PORT=…\nPROJECT=…\n\nPLANS TO PROCESS:` (the `the extension arm emits PROJECT= between API_PORT and PLANS TO PROCESS` case) — adding a line there would break assertions for no benefit. Note the sibling worktree plan *does* add a `FEATURE_WORKTREE_MODE=` line and owns updating those assertions; this plan must not.
- **`API_PORT` stays in the prompt.** Step 5 still writes via the API. Only the *read* changes.
- **No change to `/kanban/board` itself.** Other callers use it; this plan does not touch the endpoint, its handler, or its shape.
- **No sweep of other skills.** `switchboard-orchestration` documents the endpoint catalog, which is correct — it is a catalog. Only dispatch-analysis is re-pointed here.

## Edge-Case & Dependency Audit

1. **`boardStateExport: 'control-plane'` moves the mirror.** `_resolveExportRoot()` (src/services/KanbanDatabase.ts:8834-8847) returns the mapped *effective* workspace root when the setting is `control-plane`, so the mirror is written under a different root than the `WORKSPACE_ROOT` in the prompt. **Handling:** the skill treats a missing file at `$WORKSPACE_ROOT/.switchboard/kanban-state-plan-reviewed.md` as the trigger for the HTTP fallback. This is the primary reason the fallback must survive the rewrite rather than being deleted.

2. **A double quote in a feature topic corrupts the `subtask-of:` marker.** The writer strips quotes from the project name (`plan.project.replace(/"/g, '')`) but not from the feature topic (`KanbanDatabase.ts:9102`):
   ```ts
   parts.push(featureTopic ? `subtask-of:"${featureTopic}"` : `subtask-of:${plan.featureId}`);
   ```
   A feature titled `Fix the "Analyze" button` emits `subtask-of:"Fix the "Analyze" button"`, which no marker parser reads correctly. Today nothing load-bearing parses it; after this change dispatch-analysis does. Fixed in Change 2 below, mirroring the project handling exactly.

3. **Empty column.** An empty column's file reads `_No plans_` with no `- [` lines. The grep returns nothing, and the skill's existing "report *No Planned plans to analyze* and stop" branch fires unchanged.

4. **The mirror is gitignored and untracked.** `.gitignore:52` (`.switchboard/*`) covers it; `git ls-files` confirms no `kanban-state-*.md` is tracked. There is no stale-committed-copy hazard, and no risk of the rewrite making the pass read a checked-in snapshot from months ago. The corollary: inside a git worktree the file does not exist at all — but dispatch-analysis is always given the main workspace root, and if it ever is not, edge case 1's fallback covers it.

5. **Topic collisions between a subtask's `subtask-of:` value and a feature's rendered topic.** Both come from the same `plan.topic` string in the same pass, so the comparison is exact string equality, not fuzzy matching. Two distinct features with byte-identical topics would be ambiguous — but they are already ambiguous to the user reading the board, and the failure mode is "analyse the feature as one unit", which is the conservative direction.

6. **Custom columns.** `_columnSlug` lowercases and hyphenates whitespace only. A custom column named `My Column` writes `kanban-state-my-column.md`. Dispatch-analysis only ever reads the fixed `PLAN REVIEWED` column, so custom columns do not affect it — but the skill should state the derivation rather than hardcode the filename with no explanation, so a reader can tell it is derived and not magic.

7. **Dependency: none on unshipped work.** The mirror shipped 2026-06-28 and is written unconditionally whenever the DB persists — `_writeLocalBoardMirror` (`KanbanDatabase.ts:8975`) is not gated by `boardStateExport` (that setting only gates the *orphan-branch snapshot* publisher and, separately, redirects the export root). No migration is involved: the skill file is control-plane content, not user state.

8. **The per-column file has a preamble, not just card lines.** `kanban-state-plan-reviewed.md` opens with `## PLAN REVIEWED`, `**Label:** Planned`, `**Agent:** …` before the first `- [` line. The `grep -E '^- \['` in step 1 is what makes that irrelevant — a naive full-file read would hand the agent header noise and, on `CODE REVIEWED`, 698 KB of it. Keep the anchored grep; do not soften it to a plain `cat`.

## Dependencies

* No blocking plan dependencies; every surface this plan touches exists at HEAD (mirror writer shipped 2026-06-28; the skill file and the contract test both present).
* **Serialises behind `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md`** on `.agents/skills/dispatch-analysis/SKILL.md`. That plan rewrites step 5 from a card move to a `staged_at` stamp and retires the `DISPATCH` column; this plan rewrites step 1, 1a, 2 and the Rules. Author this one against that plan's finished step 5 — see "Reconciliation with the staging plan" below.
* **Serialises ahead of `feature_plan_20260811094600_cache-plan-write-sets-for-dispatch-analysis.md`**, which rewrites step 2 again into a fetch-then-fill and should be authored against this plan's final path-resolution text.
* The sibling worktree plan (`feature_plan_20260811143000_…worktree-recommendation.md`) adds steps 4a/6a/6b and a new prompt line. It touches disjoint sections of the skill and disjoint assertions in the contract test, so it can land in any order relative to this plan — but it, not this plan, owns the `FEATURE_WORKTREE_MODE=` prompt-layout assertions.
* No migration, no schema, no persisted state.

### Reconciliation with the staging plan

The staging plan lands first and changes what step 5 *is*. Three places in this plan's text must be written against that end-state rather than against HEAD:

1. **The Rules bullet** — "Use the API only for the card moves in step 5" becomes "Use the API only for the staging writes in step 5".
2. **Step 1's candidate set** — after staging, staged plans are still in `PLAN REVIEWED` and therefore still in the mirror file. That is *correct and required*: it is what lets the pass see the cards it staged. The step-1 text must say so, and must tell the pass to skip re-staging a plan already carrying a stamp.
3. **Verification step 5** below — "moved cards land in DISPATCH" becomes "staged cards stay in Planned and appear under the Staging filter".

The `planId:<uuid>` marker, the mirror's format, the `project:"…"` scoping table and the `subtask-of:` parsing are all unaffected by staging.

## Adversarial Synthesis

Key risks: (1) **losing a safety guarantee while changing transport** — step 1a's "a subtask whose parent is elsewhere is skipped" and step 2's "an unreadable plan stays in Planned" are the two rules standing between this pass and two coders in one file, and both are being re-expressed against a different data source in the same edit; (2) **deleting the fallback** — `boardStateExport: control-plane` genuinely relocates the mirror, so a rewrite that assumes the file is always there strands those workspaces with no read path at all; (3) **parsing a marker that was never built to be parsed** — an unescaped `"` in a feature topic truncates `subtask-of:` and silently orphans that feature's subtasks, which reads as "no candidates" rather than as an error; (4) **no CI gate on the file** — with no `.claude` mirror and no `mirror:check` coverage, prose drift is invisible unless the contract test asserts it; (5) **authoring against HEAD instead of against the staging plan's step 5**, producing a skill that tells the agent to move cards to a retired column. Mitigations: re-express both guarantees explicitly in the rewritten bullets and pin them with the feature-unit regression check; keep the fallback and detect it by file absence; strip quotes at the writer and pin the marker contract with a test; add the skill-spelling assertions to `dispatch-analysis-scope-contract.test.js`; and land this plan second, against the staging plan's finished text.

## Proposed Changes

### 1. `.agents/skills/dispatch-analysis/SKILL.md` — re-point step 1, 1a, 2 and the Rules

**Step 1** — replace the API query with the mirror read, keeping the scoping table intact.

Replace:

```markdown
Query the API for the latest board state (the plan list in the prompt may be stale by the
time analysis runs — always re-query for freshness):

```
GET http://localhost:{API_PORT}/kanban/board?workspaceRoot={WORKSPACE_ROOT}
```

Filter for cards where `kanbanColumn === 'PLAN REVIEWED'`.
```

with:

```markdown
Read the board's own per-column mirror. Switchboard rewrites it after every board change
(atomically, ~500 ms debounced), so it is as fresh as the database and it contains **only**
the column you need — the plan list in the prompt may be stale by the time analysis runs, so
always re-read rather than trusting the prompt's snapshot.

```bash
grep -E '^- \[' "{WORKSPACE_ROOT}/.switchboard/kanban-state-plan-reviewed.md"
```

The filename is the column: `PLAN REVIEWED` lowercased with spaces hyphenated. There is no
`kanbanColumn` field to filter on — being in that file *is* being in that column.

Each line carries everything this pass needs:

```
- [<plan file>](<absolute path>) — <topic> <!-- planId:<uuid> [feature] [subtask-of:"<parent topic>"] [project:"<name>"] -->
```

- `planId:<uuid>` — the ID you pass to `POST /kanban/move` in step 5.
- ` feature` — present only on feature cards.
- `subtask-of:"<parent topic>"` — present only on subtasks; the value is the parent feature's
  exact topic string.
- `project:"<name>"` — present only when the plan is pinned to a project. **Absent means
  unpinned**, which is what `PROJECT=<unassigned>` selects.
- The link **href** (the `(...)` part) is an already-resolved absolute path. Use it in step 2
  verbatim.

**If that file does not exist**, the workspace exports its board mirror somewhere else
(`boardStateExport: control-plane` redirects the export root). Fall back to the API — it is
the same data in a heavier form:

```
GET http://localhost:{API_PORT}/kanban/plans?workspaceRoot={WORKSPACE_ROOT}&column=PLAN%20REVIEWED
```

Prefer this over `GET /kanban/board`: the board endpoint returns every card in every column
(on a mature board that is well over a megabyte of closed work) and leaves you to filter it.
```

The scoping table that follows stays, with its left column re-expressed against the marker:

```markdown
| Prompt carries | Keep the lines where |
| :--- | :--- |
| `PROJECT=<name>` | the marker reads `project:"<name>"` |
| `PROJECT=<unassigned>` | there is **no** `project:"…"` marker |
| `PROJECT=<all>` | every line — the user is viewing the unfiltered board |
| no `PROJECT` line | the `planId` appears in `PLANS TO PROCESS` — do not widen |
```

**Step 1a** — replace the final bullet (the subtask-with-absent-parent rule) with the same-file test:

```markdown
- **A subtask is never a standalone candidate.** A line carrying `subtask-of:"<topic>"` is
  only a candidate when a line in **this same file** carries ` feature` and the topic
  `<topic>` — that is what "the parent feature is also in Planned" means. If the parent's
  line is not in this file, the parent is in another column, the user sees the subtask
  rolled up under it rather than in Planned, and you skip it. Name it in the report.
```

**Step 2** — the path resolution collapses on the mirror path:

```markdown
**Take the absolute path straight from the mirror line's link href. Never synthesize a
filename from the planId** — a made-up `<planId>.md` will miss, and a miss silently drops
the plan out of the analysis.

Only if you fell back to the API in step 1 does `planFile` arrive in three forms
(absolute / workspace-relative / `file://` URI) — resolve it against `WORKSPACE_ROOT`,
stripping and URL-decoding the `file://` scheme when present.
```

The "leave unreadable plans in Planned" paragraph below it is unchanged.

**Rules** — rewrite the two bullets that name the endpoint:

```markdown
- **Read the mirror, not the whole board.** `{WORKSPACE_ROOT}/.switchboard/kanban-state-plan-reviewed.md`
  is one column; `GET /kanban/board` is every card in every column. Use the API only for the
  staging writes in step 5, or as step 1's documented fallback when the mirror file is absent.
- **Stay inside the board's scope.** The mirror carries every project's cards in that column;
  the column the user pressed Analyze on does not. Scope per step 1 before analysing
  anything, and name the scope in the report.
- **Re-read the mirror, but only within scope.** The plan list in the prompt is a snapshot;
  late additions must be included — late additions *to the same project*, not to the
  workspace at large.
```

and the `planFile` rule:

```markdown
- **Take `planFile` from the mirror's href, never synthesize it.** See step 2 — a made-up
  `<planId>.md` path turns every plan into an "unreadable" one and empties the dispatch set.
```

### 2. `src/services/KanbanDatabase.ts` — strip quotes from the `subtask-of:` topic

The skill now parses this marker, so a quote in a feature title must not break it. At `_writeLocalBoardMirror` (~line 9092):

```ts
                        if (plan.featureId) {
                            const featureTopic = featureTopicById.get(plan.featureId);
                            parts.push(featureTopic ? `subtask-of:"${featureTopic}"` : `subtask-of:${plan.featureId}`);
                        }
```

becomes:

```ts
                        if (plan.featureId) {
                            const featureTopic = featureTopicById.get(plan.featureId);
                            // Quotes are stripped for the same reason as `project:"…"` below:
                            // an embedded `"` closes the marker early and dispatch-analysis
                            // (which matches a subtask's parent by this exact topic string)
                            // reads a truncated name that matches no feature line.
                            const safeTopic = featureTopic?.replace(/"/g, '');
                            parts.push(safeTopic ? `subtask-of:"${safeTopic}"` : `subtask-of:${plan.featureId}`);
                        }
```

Note the feature card's own rendered topic (`— ${plan.topic}`) is not quoted and needs no change — but the two must agree for step 1a's match, so the comparison in the skill is against the **stripped** form. Given topics with quotes are rare and the strip is applied to the marker only, state it plainly in the skill's step 1a bullet: *the marker's topic has any `"` removed; compare against the feature line's topic with the same removal applied.*

### 3. `src/test/kanban-auto-export.test.ts` — pin the marker contract

Add a test alongside the existing per-column assertions:

```ts
test('subtask-of marker survives a double quote in the parent feature topic', async function() {
    this.timeout(5000);
    // A feature title containing `"` must not close the marker early — dispatch-analysis
    // matches a subtask to its parent by this exact string.
    const featureTopic = 'Fix the "Analyze" button';
    // …upsert a feature with `featureTopic` and one subtask in PLAN REVIEWED, then:
    await db.flushLocalBoardMirror();
    const content = readPerColumnFile(tempDir, 'PLAN REVIEWED');
    assert.ok(content.includes('subtask-of:"Fix the Analyze button"'),
        'quotes must be stripped exactly as they are for project:"…"');
    assert.ok(!/subtask-of:"[^"]*"[^ ]/.test(content),
        'no marker may contain an unbalanced quote run');
});
```

### 4. `src/test/dispatch-analysis-scope-contract.test.js` — assert the skill points at the mirror

The suite already reads source files to enforce cross-file contracts (`readSrc` on `KanbanProvider.ts` / `bootstrap.ts`). Add a section that reads the skill:

```js
console.log('\n── 6. the skill reads the per-column mirror, not the whole board ──');

await test('dispatch-analysis step 1 names the mirror and demotes /kanban/board', () => {
    const skill = readSrc('.agents/skills/dispatch-analysis/SKILL.md');
    assert.ok(/kanban-state-plan-reviewed\.md/.test(skill),
        'step 1 must name the per-column mirror as the primary read');
    // /kanban/board may still appear as the discouraged form, but never as an instruction.
    const boardAsInstruction = /GET\s+http:\/\/localhost:\{API_PORT\}\/kanban\/board/.test(skill);
    assert.ok(!boardAsInstruction,
        'a bare GET /kanban/board pulls every column; the pass needs one');
    assert.ok(/POST[\s\S]{0,120}\/kanban\/(move|verb\/setStaged)/.test(skill),
        'the write endpoint must survive — only the READ moved off HTTP');
});
```

The write-endpoint assertion is deliberately loose on *which* endpoint: the staging plan lands first and replaces `POST /kanban/move` with the staging verb, and an assertion pinned to `/kanban/move` alone would go red on that plan's change rather than on a regression in this one. What it must pin is that **some** write endpoint survives step 5 — the failure this guards is a rewrite that moves the whole pass off HTTP, read *and* write.

`readSrc` resolves relative to the repo root, so the skill path needs no helper change.

## Verification Plan

### Automated Tests

* **`subtask-of` survives a quoted feature topic** — the `kanban-auto-export.test.ts` case in change 3.
* **The skill names the mirror and no longer instructs `GET /kanban/board`** — the `dispatch-analysis-scope-contract.test.js` case in change 4.
* **A write endpoint survives step 5** — same case, loose match per the note above.
* **The existing prompt-layout assertions still pass unchanged** (`API_PORT=…\nPROJECT=…\n\nPLANS TO PROCESS:`), proving the prompt body was not disturbed.

### Manual Verification

1. **Byte comparison, before and after.** With the extension running, capture the three sources the plan measured and confirm the ratio holds on the reader's board:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   curl -s "http://127.0.0.1:$PORT/kanban/board?workspaceRoot=$PWD" -o /dev/null -w "board      %{size_download}\n"
   curl -s "http://127.0.0.1:$PORT/kanban/plans?workspaceRoot=$PWD&column=PLAN%20REVIEWED" -o /dev/null -w "plans?col  %{size_download}\n"
   wc -c .switchboard/kanban-state-plan-reviewed.md
   ```
   Expect the mirror to be the smallest of the three and the board endpoint an order of magnitude larger.

2. **Parity check — the mirror and the API agree on the candidate set.** The rewrite is only correct if both paths select the same cards:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   grep -oE 'planId:[0-9a-f-]{36}' .switchboard/kanban-state-plan-reviewed.md | cut -d: -f2 | sort > /tmp/from-mirror
   curl -s "http://127.0.0.1:$PORT/kanban/plans?workspaceRoot=$PWD&column=PLAN%20REVIEWED" \
     | python3 -c 'import json,sys; [print(r["planId"]) for r in json.load(sys.stdin)["data"]]' | sort > /tmp/from-api
   diff /tmp/from-mirror /tmp/from-api && echo "PARITY OK"
   ```
   An empty diff is the gate. A non-empty diff means the mirror is stale or scoped differently and the rewrite must not land.

3. **Freshness under a live move.** Move a card into Planned on the board, wait one second, re-run the grep from step 1 of the skill, and confirm the new card is present. Then move it out and confirm it disappears. This is the claim the API re-query existed to guarantee.

4. **End-to-end, the real button.** Press **Analyze** on the Planned column with a project filter active. Watch the planner terminal: it must `grep` the mirror rather than `curl` the board, must report the scope it analysed, must print the intended set before the first write (step 5a), and must write one card at a time with an outcome line each (step 5b). Confirm on the board that the selected cards are **staged in place** — still in Planned, visible under the Staging filter — and that no subtask was staged independently of its feature. (Before the staging plan lands, this reads as "the moved cards land in DISPATCH"; after it lands, staging is the correct expectation and a card that *moves* is the regression.)

5. **Fallback path.** Temporarily rename `.switchboard/kanban-state-plan-reviewed.md`, press Analyze again, and confirm the agent detects the missing file and falls back to `GET /kanban/plans?column=PLAN%20REVIEWED` — not to `GET /kanban/board` — then restore the file.

6. **Feature-unit regression.** With a feature whose subtasks sit in Planned while the feature card itself sits in another column, confirm the pass skips those subtasks and names them in the report. This is the guarantee step 1a's rewrite is most at risk of losing.

7. **Quoted-topic end-to-end.** Rename a feature to include a `"`, let the mirror rewrite, and confirm its subtasks still resolve to it in the report rather than being reported as parentless. The unit test pins the writer; this pins the reader.

## Recommendation

Complexity 3 → **Send to Intern.** One skill-file section rewritten, a one-line quote strip, and two tests. The whole risk is concentrated in two sentences — step 1a's parent test and step 2's path resolution — so the reviewer's attention belongs there and almost nowhere else.

Land it **after** the staging plan, and write step 5's surrounding language against the stamp rather than the retired `DISPATCH` column.
