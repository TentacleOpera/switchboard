# A Lead-Dispatched Coder's Commits Carry No Stage Trailers, So Coded Work Reads as Unmarked

## Goal

Make a commit produced by a seat driven through `ptySendPrompt` carry the same `Switchboard-Stage:` / `Switchboard-Plan:` trailers a board-dispatched commit carries, so the orchestrator's stage-marker query sees work that was genuinely coded. Today the entire lead-driven path — the documented `terminal-coder-dispatch` pattern — emits no markers at all.

### Problem analysis and root cause

**Observed, not inferred.** On 2026-08-17 the four subtasks of *Teams You Can See, Start and Trust* were driven through `lead-1-coder-1` / `lead-1-coder-2` via `POST /terminals/verb/ptySendPrompt`. Four commits landed — `226b7f09`, `a7941d32`, `ceb9f551`, `2a89238d`. Every one carries only `Co-Authored-By:`. Not one carries a `Switchboard-Stage` or `Switchboard-Plan` trailer:

```
$ git log -1 --format='%(trailers)' 226b7f09
Co-Authored-By: Devin <...>
```

The orchestrator's own check — `git log --format='%(trailers:key=Switchboard-Stage,valueonly)'`, made the *preferred* verification path by `stage-markers-in-commit-trailers.md` — returns nothing for all four. A whole feature's coding stage is invisible to the mechanism built to observe it.

**Second measurement — the board path is dark too.**

```
$ git log -200 --format='%(trailers:key=Switchboard-Stage,valueonly)' | grep -c .
0
```

Not one commit in the last two hundred carries a stage trailer, board-dispatched ones included. The reason is in this workspace's own config:

```
$ sqlite3 .switchboard/kanban.db \
    "select value from config where key='switchboard.prompts.roleConfig_coder';"
… "addons": { …, "gitProhibition": true, … }   # no gitCommitStrategy key at all
```

`resolveSeatPromptOptions` (`KanbanProvider.ts:5296`) reads `gitCommitStrategyByRole?.[role] ?? 'notSpecified'`, so the coder role resolves to `notSpecified`. `buildGitPolicyBlock` emits a Commit clause only when `commit && commit !== 'notSpecified' && GIT_COMMIT_CLAUSES[commit]` (`:673`), and the stage-trailer instruction lives **inside** that clause. No commit clause → no trailer instruction, on **either** path.

**Root cause.**

> **Superseded:** *"the trailer instruction is gated on `stage`, and only the board path supplies one."*
> **Reason:** True but incomplete, and the omission inverted the plan's own success test. Two gates compose. Gate A: the seat path passes no `stage`. Gate B: the trailer instruction sits inside the Commit clause, suppressed for `notSpecified` — the shipped default and this workspace's actual config. Opening gate A alone yields zero trailers, and the plan would have passed every one of its automated tests (all of which pass `gitCommitStrategy: 'whenDone'` explicitly) while the observed defect persisted.
> **Replaced with:** This plan owns **gate A** — supplying `stage` and `planIds` on the seat path. Gate B is **not** opened here and no contract test is touched: `stage-marker-commit-contract.test.js:141` pins `notSpecified + stage → ''` and `:215` pins the shipped default emitting no marker, on the stated grounds that a new capability ships OFF (PRD contract #2, ~4,000 installs). Gate B is opened *from the other side*, by `a-team-commits-once-as-its-head.md`, which forces a team head to `whenDone` because a team whose head does not commit has no path to a completed body of work. Once that lands, the committer always has a commit clause and the trailer fires — without changing a single default for anyone not running a team.

**Why the trailers are now load-bearing.** The original framing treated them as observability — nice to have, safe to leave dark. That is no longer true. Under the team commit model the reviewer's input is *the head's commit*, and `Switchboard-Stage: coded` + `Switchboard-Plan: <id>` is precisely the query that finds it (`the-reviewer-is-never-told-what-to-review.md`). A missing trailer is no longer a missing metric; it is a review that falls back to guessing at a shared working tree.

**The gate-A hole, audited.** `buildGitPolicyBlock` (`src/services/agentPromptBuilder.ts:629`) takes optional `stage?: string` (`:642`) and `planIds?: string[]` (`:644`). Its own doc: *"Absent → no trailer instruction."* Every call site in the repo:

| Line | Path | Passes `stage`? |
| :--- | :--- | :--- |
| `agentPromptBuilder.ts:1061` | **`buildSeatDirectiveBlock`** — the fleet/`ptySendPrompt` path | **no** |
| `agentPromptBuilder.ts:1540`, `1672`, `1729`, `1788`, `1841`, `1894`, `1936`, `1970`, `2032`, `2083` | `buildKanbanBatchPrompt` — board dispatch | yes |
| `agentPromptBuilder.ts:2244` | `buildCustomAgentPrompt` | no |
| `AgentSkillExporter.ts:193` | exported agent skill — no dispatch, no plan, correctly excluded | no |

Ten of thirteen sites are instrumented; the seat path is not.

**This exclusion was deliberate, and its rationale did not survive contact with the lead-driven pattern.** `stage-markers-in-commit-trailers.md` (`5f3e165f`, CODE REVIEWED) lists the seat path and `buildCustomAgentPrompt` as traps #2 and #3 — *"not batch dispatch sites and were left untouched"*. Correct about batch dispatch, wrong about coverage: `terminal-coder-dispatch` is a documented, first-class way features get built, and it routes entirely through the seat path.

**Why the obvious fix is barred.** `buildSeatDirectiveBlock` is a **pure composer** by design and by test. `SeatDirectiveOptions` (`:1010-1024`) carries no plan input, the function's doc states *"No `vscode` import, no plan input, no new prose"*, and `src/test/seat-safeguards-fleet-prompt-path.test.js` asserts it must **not** emit `FOCUS_DIRECTIVE` or `BATCH_EXECUTION_RULES` because those are *"dispatch-scoped and reference plan files"*. Teaching the composer to look up a dispatch record would break that contract and those tests. The split below keeps it intact.

**Blast radius.** Prompt text only. No verb, schema, DB write or board behaviour changes.

## Metadata

**Complexity:** 6
**Tags:** bugfix, reliability, backend, test

## User Review Required

None. The purity split, the resolver placement for `stage`, the caller-side resolution of `planIds`, the team-scoped resolution for a head, and the decision to leave gate B to its sibling plan are all decided below.

## Complexity Audit

### Routine

- One optional field on an existing options interface, set by the resolver that already produces that interface.
- One extra field forwarded through a builder that already accepts it.

### Complex / Risky

- **`stage` and `planIds` are not the same kind of value and must not be plumbed the same way.** `stage` derives from the seat's role via `STAGE_BY_ROLE` (`:587-594`) and needs no IO. `planIds` is dispatch state in the DB. If the composer resolves it, the composer stops being pure and the seat test suite's stated rationale collapses.

  > **Superseded:** *"Two call sites resolving values they can already reach"* — `_ptyHostVerb` and `deliverPrompt` each computing `STAGE_BY_ROLE[role]` themselves.
  > **Reason:** Internally contradictory (the same plan said `stage` *"belongs in the pure composer"*) and it duplicates a pure map lookup into two hosts that already share a resolver for exactly this class of value. `STAGE_BY_ROLE`'s own doc warns that *"a second hand-maintained copy is how the vocabularies drift"*; the plan proposed a third.
  > **Replaced with:** `stage` is set **once**, in `resolveSeatPromptOptions`, as `STAGE_BY_ROLE[role]`. Both hosts get it free. Only `planIds` is resolved at the call sites, because only they hold the terminal name and the correctly-rooted DB handle.

- **`planIds` cannot move into the resolver, and the reason is workspace scoping.** `resolveSeatPromptOptions` roots on `this.getCurrentWorkspaceRoot()` — the board's *active* selection. `_ptyHostVerb` deliberately does not use that root for its DB handle; its in-code comment states `_getWorkspaceRoot()` *"follows the board's active workspace selection and would read a different DB after a workspace switch."* Moving the lookup in reintroduces that bug.

- **A head's own dispatch record is empty — its plan ids belong to its team.** `getActiveDispatchedByTerminal(wsId, headName)` (`KanbanDatabase.ts:9821`) returns nothing, because nobody dispatches plans *to* a head. Under the team commit model the head is the committer, so a terminal-scoped lookup would produce `Switchboard-Stage: coded` with **no** `Switchboard-Plan` line on every team commit — a stage with nothing to join it to, and the reviewer's query would match nothing. The head's plan ids are the union of its **members'** live dispatch records. Take the roster from `resolveTeamStanding(...).members` (owned by `a-team-commits-once-as-its-head.md`) and query the set.

  > **Superseded:** *"Resolve the roster with `resolveTeamStanding`"*, with an implementation reading a bare `roster` identifier.
  > **Reason:** `resolveTeamStanding`'s declared return was `{ inTeam, isHead, teamId?, headName? }` — no roster of any name. The code below referenced a value the sibling plan never produced, so this plan as written did not compile against its own stated prerequisite. Left unreconciled, an implementer would have hand-rolled `groups.find(g => g.id === standing.teamId)?.members` in **both** hosts — the second and third membership tests that the sibling plan's extract-the-predicate rule exists to prevent, and the drift this codebase repeatedly pays for.
  > **Replaced with:** `a-team-commits-once-as-its-head.md` now returns `members: string[]` (the group's roster verbatim, head included, `[]` when not in a team). This plan reads `standing.members` and drops the head itself. One resolution, one roster, two consumers.

- **Query the set in one statement, not N.** A per-member loop is N round-trips on the delivery path. `KanbanDatabase` already has the shape — `dispatched_terminal IN (${placeholders})` at `:9970` and `:10004`. Add a batch reader in that style rather than looping `getActiveDispatchedByTerminal`.

- **`planIds` resolution inherits the reliability of dispatch registration.** `dispatched_terminal` is written only by `attributePasteDispatch` and `updateDispatchInfoByPlanFile`; `ptySendPrompt` writes nothing today, which is why `terminal-coder-dispatch` §3.5 makes registration a mandatory manual step *before* the send. `a-lead-dispatched-plan-is-never-registered.md` moves that to the delivery layer. Until it lands, an unregistered dispatch yields stage-only trailers — degraded, never wrong.

- **The seat block rides *every* `ptySendPrompt`, including a coder's report back to its lead.** So a lead also receives a trailer instruction. Under the team model that is now correct rather than merely harmless: the lead *is* the committer, and `STAGE_BY_ROLE` maps `lead → coded`, which is the stage of the body it is closing.

  > This is deliberately **weaker** than the sibling rule in `a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md`, which warns that the *completion-report* directive must never ride a coder→lead message because the lead would append to a plan file, advance its mtime and fire a false `completed`. That danger is specific to a directive causing a **file write**. A trailer instruction causes no write and no signal unless the recipient commits. Do not copy that rule across by analogy.

- **A stale `planIds` can ride an ordinary message — bounded, accepted.** A follow-up message to a seat carries whatever the dispatch record currently says. Bounded by the query itself: `status = 'active' AND dispatched_at IS NOT NULL`, and `clearWorkingState` NULLs `dispatched_at` when the completion marker is parsed, with `clearStaleWorkingState` as the timeout backstop. `Switchboard-Plan` is a membership test, not equality; an extra id is a weaker claim than a missing one.

- **`STAGE_BY_ROLE` has no default and no `'unknown'` sentinel, on purpose** — *"a wrong stage is worse than a missing one."* An unmapped role must yield `undefined` and therefore no trailer instruction. `stage-marker-commit-contract.test.js:82` pins this.

- **This plan makes the seat block dispatch-varying, and the delivery layer caches it on the assumption that it is not.** Both hosts memoise the composed block per `agentInstanceId` and suppress an unchanged one: `shouldDeliver = !instanceId || isClearingSend || cachedEntry?.block !== seatBlock` (`TaskViewerProvider.ts:600-608`; `bootstrap.ts:286-295`). `SeatDirectiveOptions`' own doc calls its contents *"the subset of addon config that is true of a seat regardless of what it is asked to do"* and lists dispatch-scoped inputs as *"deliberately absent"*. `planIds` is dispatch-scoped. Two consequences, both real:

  1. **A non-deterministic id order re-sends the whole block on every message.** The cache key is the block *string*. `[...new Set(ids)]` preserves insertion order, which is the batch reader's row order — and `getActiveDispatchedByTerminals` returns rows ordered by the DB, not by the caller's `names` array. Two sends resolving the same two plans in a different row order produce two different strings, so the seat block — subagent policy, git policy, skip directives, output shaping, in full — is re-appended to every single message to that seat. **Sort the ids before rendering** (`[...new Set(ids)].sort()`). This is a correctness requirement for the cache, not a tidiness preference.
  2. **Re-delivery when the ids genuinely change is correct and must not be suppressed.** A head whose team picks up a third subtask needs the new `Switchboard-Plan` line. The content-keyed cache already produces this — do not "optimise" it by excluding `planIds` from the cache key, which would pin the head to a stale trailer set for the life of the seat.

  Amend the `SeatDirectiveOptions` doc comment in the same change: the two new fields are dispatch-varying by design and the cache is content-keyed to absorb that. An unamended doc leaves the next reader enforcing an invariant this plan deliberately broke.

- **Trailer formatting is already solved and must not be re-derived.** `agentPromptBuilder.ts:664-671` documents, against git 2.50.1, that trailer lines following the subject with **no blank line** make `%(trailers:...)` return EMPTY — a silent total loss of signal. This plan changes no prose; it supplies inputs.

## Edge-Case & Dependency Audit

**Race Conditions** — `getActiveDispatchedByTerminal` is `ORDER BY dispatched_at DESC LIMIT 1`, so a seat holding two unresolved dispatches yields only the newest. Acceptable: `Switchboard-Plan` is a membership test and a missing id means "no information". The batch reader for a head must **not** collapse to one row — it returns the newest per terminal, which is the whole point.

**Security** — none. No new input from any wire; outbound prompt text only.

**Performance** — one extra `SELECT … LIMIT 1` (member) or one `IN (…)` query (head) per `ptySendPrompt`. Proportionate: the same path already performs a `ptyListTerminals` round-trip and two `getConfigJson` reads per send. Wrap it so a slow or failed read degrades to stage-only rather than delaying delivery.

**Side Effects** — a seat with a committing strategy gains the trailer instruction inside its existing commit clause. Seats with `dontCommit` or `notSpecified` are unaffected — the instruction sits inside the commit clause and `COMMITTING_STRATEGIES` excludes `dontCommit`.

**Migration** — none. Commits already made stay unmarked; a missing marker means "no information", and the orchestrator skill's fallback checks (`rev-list --count`, card column, stall counter) remain.

**Dependencies & Conflicts** — edits `src/services/agentPromptBuilder.ts` (`:1007-1034`, `:1061-1068`), `src/services/KanbanProvider.ts` (`:5277-5303`), `src/services/KanbanDatabase.ts` (batch reader, beside `:9821`), `src/services/TaskViewerProvider.ts` (`:594-597`), `src/standalone/bootstrap.ts` (`:281-284`), and extends `src/test/seat-safeguards-fleet-prompt-path.test.js`. **Same two function bodies as `a-team-commits-once-as-its-head.md` and `a-lead-dispatched-plan-is-never-registered.md`** — serialise all three, and land this one **third** of the three (it reads `standing.members`, which the team plan introduces, and its parse site must sit below the registration plan's). Also conflicts with `a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md` (`d91d7daf`), same seam.

**Not touched, deliberately:** the reviewer branch of `buildKanbanBatchPrompt` (`:1672`) already passes `stage: STAGE_BY_ROLE['reviewer']` and the batch's `planIds`, so a reviewer dispatched from the board already marks its own commit `reviewed` when it has a committing strategy. That is the board path and it is already correct — this plan adds nothing there.

## Dependencies

- `stage-markers-in-commit-trailers.md` (`5f3e165f`, CODE REVIEWED) — landed `buildGitPolicyBlock`'s `stage`/`planIds` inputs, `STAGE_BY_ROLE`, `COMMITTING_STRATEGIES` and the orchestrator's trailer queries. **Hard prerequisite, already met.**
- `a-team-commits-once-as-its-head.md` — **hard prerequisite, not merely an ordering preference.** It supplies `resolveTeamStanding` *including its `members: string[]` field*, which this plan's `planIds` resolution consumes directly, and it forces the head to `whenDone`, which is what makes this plan fire in production. Land it first; without the `members` field this plan does not compile.
- `a-lead-dispatched-plan-is-never-registered.md` — makes the dispatch records this plan reads reliable. Land it first, or accept stage-only trailers until it does.
- `src/test/stage-marker-commit-contract.test.js` — must stay green **unchanged**. A red result there means the implementation opened gate B, which belongs to the sibling plan and by a different mechanism.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a terminal-scoped `planIds` lookup applied to a head — its own dispatch record is empty, so every team commit would carry a stage and no plan id, and the reviewer's lookup would match nothing. Second is widening the pure composer: a DB lookup inside `buildSeatDirectiveBlock` breaks the purity its test suite asserts and turns a two-field change into a seam rewrite. Third is unsorted plan ids: the seat block is memoised per seat and keyed on its own text, so an id order that varies with DB row order re-sends the entire block — git policy, skip directives, output shaping — on every message to that seat, a prompt-bloat regression that looks like nothing in any single-call test. Fourth is opening gate B here to make the plan "work" standalone, which turns two contract tests red and flips a default-OFF capability on for every install. Mitigations: the head's ids come from `resolveTeamStanding(...).members` through one batch query; the ids are deduplicated **and sorted**, pinned by both a source-text and a reversed-row-order test; `stage` is set once in the shared resolver and `planIds` at the caller that owns the right DB root, with a contract test asserting the composer performs no lookup; gate B is left to the sibling plan that opens it for a stated reason.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — two fields, forwarded

- **Context:** `SeatDirectiveOptions` (`:1019-1034`, doc comment `:1007-1018`); the `buildGitPolicyBlock` call inside `buildSeatDirectiveBlock` (`:1061-1068`).
- **Logic:** add to the interface, mirroring the `worktreeActive` comment style:

```ts
    /** Stage marker for the commit trailer, resolved from the seat's role via
     *  STAGE_BY_ROLE by `KanbanProvider.resolveSeatPromptOptions` — the one
     *  shared resolver both hosts call. Absent → no trailer instruction, which
     *  is the correct outcome for an unmapped role. */
    stage?: string;
    /** planIds this seat is currently accountable for, resolved by the CALLER.
     *  For a member that is its own dispatch record; for a team head it is the
     *  union of its members' records, because nobody dispatches plans TO a head.
     *  Kept as a plain value so this composer stays pure — it must never perform
     *  the lookup itself, and it cannot move into resolveSeatPromptOptions,
     *  which roots on the board's ACTIVE workspace. */
    planIds?: string[];
```

  and forward both at `:1061-1068`: `stage: opts.stage, planIds: opts.planIds`.

- **Edge Cases:** both optional; `buildSeatDirectiveBlock({})` must still return `''`, which the existing test asserts. Amend the interface's doc comment (`:1007-1018`) — it currently states that dispatch-scoped inputs are *"deliberately absent"*, which these two are not. Say instead that `stage` is seat-scoped, `planIds` is dispatch-varying by design, and the delivery layer's content-keyed block cache absorbs the variation.

### `src/services/KanbanProvider.ts` — resolve `stage` once, in the shared resolver

- **Context:** `resolveSeatPromptOptions` (`:5277`), returning at `:5291-5303`; called by both hosts.
- **Logic:** import `STAGE_BY_ROLE` and add one field beside the git strategies at `:5297`: `stage: STAGE_BY_ROLE[role],`
- **Edge Cases:** an unmapped role (`tester`, `analyst`, `''`) yields `undefined` — no fallback, no sentinel. Do **not** also touch `generateUnifiedPrompt`'s `resolvedOptions` block (`:5062-5089`), which reads the same config maps for the board path — the board sites already pass `stage: STAGE_BY_ROLE[role]` inline at each `buildGitPolicyBlock` call and need nothing.

### `src/services/KanbanDatabase.ts` — batch reader for a head's team

- **Context:** the `dispatched_terminal IN (${placeholders})` shape already used at `:9970` and `:10004`; the single-terminal reader `getActiveDispatchedByTerminal` at `:9821` is the row-shape and filter reference (`status = 'active' AND is_feature = 0 AND dispatched_at IS NOT NULL`).
- **Logic:** add `getActiveDispatchedByTerminals(workspaceId, names: string[]): Promise<KanbanPlanRecord[]>` — the newest live dispatched row **per** terminal in the set. Empty `names` returns `[]` without touching the DB.
- **Edge Cases:** must not collapse to a single row the way the singular reader does — one row per terminal is the whole point. Row order is unspecified; the caller sorts (see below).

### `src/services/TaskViewerProvider.ts` — resolve `planIds` at the caller

- **Context:** `_ptyHostVerb` resolves seat options at `:594-596` and composes the block at `:597`; `db` is resolved at `:542` from `this._apiServerWorkspaceRoot`, and `payload.name` is the target seat. `standing` is resolved just above by `a-team-commits-once-as-its-head.md`.
- **Logic:** after the seat options resolve, consuming that plan's `standing.members`:

```ts
let planIds: string[] | undefined;
try {
    const wsId = db ? await db.getWorkspaceId() : null;
    if (wsId) {
        const names = standing.inTeam && standing.isHead
            ? standing.members.filter(n => n !== payload.name)  // the head commits its members' work
            : [payload.name];
        const recs = await db!.getActiveDispatchedByTerminals(wsId, names);
        const ids = recs.map(r => r.planId).filter(Boolean) as string[];
        if (ids.length) { planIds = [...new Set(ids)].sort(); }
    }
} catch { /* stage-only beats a lost dispatch */ }
const seatBlock = buildSeatDirectiveBlock({ ...effectiveOpts, planIds });
```

- **Edge Cases:**
  - The lookup must not throw into the delivery path. A head with no live member dispatches passes `undefined` and emits the stage trailer alone.
  - `.sort()` is load-bearing, not cosmetic — see the seat-block cache bullet in the Complexity Audit. Without it the whole seat block re-sends on every message whenever the DB returns the same rows in a different order.
  - `standing.members` includes the head, hence the `filter`. It is `[]` for a seat in no team, so the `isHead` branch is unreachable in that case and the `[payload.name]` branch is taken.

### `src/standalone/bootstrap.ts` — same resolution on the standalone host

- **Context:** `deliverPrompt` resolves seat options at `:281-283` and composes at `:284`, keyed on `handle.friendlyName`. Single-root, so `getWorkspaceId()` is unambiguous.
- **Logic:** identical shape, identical `.sort()`.

### `src/test/seat-safeguards-fleet-prompt-path.test.js` — extend, do not fork

- **Logic:** add —
  1. `{ gitCommitStrategy: 'whenDone', stage: 'coded', planIds: ['p1'] }` contains `Switchboard-Stage: coded` and `Switchboard-Plan: p1`.
  2. The same call with `stage` omitted contains neither — pinning gate A.
  3. `stage` with empty `planIds` emits the stage trailer only.
  4. `dontCommit` + `stage` emits no trailer.
  5. **Gate-B pin from the seat side:** `{ gitCommitStrategy: 'notSpecified', gitProhibitionEnabled: true, stage: 'coded', planIds: ['p1'] }` is byte-identical to the same call with `stage`/`planIds` omitted.
  6. **Purity contract:** `buildSeatDirectiveBlock`'s body contains no `getActiveDispatchedByTerminal`, no `getActiveDispatchedByTerminals` and no `await`.
  7. Source-text: `resolveSeatPromptOptions` sets `stage: STAGE_BY_ROLE[role]`, and neither host contains a second `STAGE_BY_ROLE` read.
  8. Source-text: both hosts pass `standing.members` **minus the head** for a head, and `[targetName]` otherwise — the head-resolves-its-members rule, pinned. Also assert neither host contains a `groups.find(` or `.members.includes(` of its own: the roster comes from `resolveTeamStanding`, never a second lookup.
  9. Source-text: both hosts `.sort()` the deduplicated ids. Pinned as source text because no functional test can see it — the assertion is about determinism across calls, and a single call is always self-consistent.
  10. Two calls with the same plan set delivered in **reversed** DB row order produce a byte-identical block, so the delivery-layer cache suppresses the second. This is the behavioural half of #9.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. The extended `seat-safeguards-fleet-prompt-path.test.js` — all existing cases pass unchanged; the ten new ones pass, alongside the eight added by `a-team-commits-once-as-its-head.md` (same file; land that plan first and extend, never fork).
3. `stage-marker-commit-contract.test.js` passes **unmodified**.
4. Grep the exclusions still hold: `buildCustomAgentPrompt` (`:2240`) and `AgentSkillExporter.ts:193` still pass no `stage`.

### Manual

5. Start a team, dispatch two subtasks to two coder seats, let both report. Read the prompt the **head** receives: the git policy block carries `Switchboard-Stage: coded` and **two** `Switchboard-Plan:` lines, one per subtask.
6. Let the head commit, then run the orchestrator's own query — `git log -1 --format='%(trailers:key=Switchboard-Stage,valueonly)'` — and confirm it returns `coded`, not empty. This is the gate: the trailers must survive git's own parser, not merely appear in the message.
7. `git log -1 --format='%(trailers:key=Switchboard-Plan,valueonly)'` returns both plan ids.
8. Reviewer seat with a committing strategy → `reviewed`.
9. A seat with commit strategy `dontCommit` receives a prompt byte-identical to today.
10. An ungrouped seat left at the shipped `notSpecified` default receives a prompt byte-identical to today.
11. Send three consecutive ordinary messages to the head while its team's dispatch set is unchanged. The seat block appears **once** (on the first), not three times — the cache still suppresses an unchanged block, which is the check that the ids are ordered deterministically.
12. Dispatch a third subtask to a third member, then message the head: the seat block reappears, now carrying three `Switchboard-Plan:` lines.
13. Repeat 5–7 on the standalone host.

---

**Recommendation:** Complexity 6 → **Send to Lead Coder.**

*Raised from 5 during the feature reconciliation pass: the plan now also owns the delivery-layer cache interaction (ordering determinism plus a doc-comment amendment on `SeatDirectiveOptions`), and its roster input is a contract shared with a sibling plan rather than a local lookup.*

---

## Completion Report

Implemented gate A: the seat path now forwards `stage` and `planIds` into `buildGitPolicyBlock` so a lead-driven coder's commit carries `Switchboard-Stage` / `Switchboard-Plan` trailers. `stage` is resolved once in `resolveSeatPromptOptions` as `STAGE_BY_ROLE[role]` (no second read in either host, no sentinel); `planIds` is resolved at the caller — `standing.members` minus the head for a head, `[targetName]` otherwise — deduplicated AND `.sort()`ed for cache-key determinism. `buildSeatDirectiveBlock` stays pure (no await, no DB call). Gate B left closed; `stage-marker-commit-contract.test.js` untouched. Files changed: `src/services/agentPromptBuilder.ts` (SeatDirectiveOptions + doc comment + forwarding), `src/services/KanbanProvider.ts` (STAGE_BY_ROLE import + stage field), `src/services/KanbanDatabase.ts` (new `getActiveDispatchedByTerminals` batch reader, one newest live row per terminal via ROW_NUMBER), `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts` (caller-side planIds resolution), and `src/test/seat-safeguards-fleet-prompt-path.test.js` (10 new cases, file now 93 tests). `node --check` passes on the test file; source-text assertions verified against live source. No issues encountered.
