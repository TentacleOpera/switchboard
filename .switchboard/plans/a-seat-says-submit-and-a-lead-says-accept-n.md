# A Seat Says `submit` and a Lead Says `accept 3`

## Goal

Two verbs, no identity arguments, no UUIDs.

```
submit        # a coder: handing this back for review (any round)
accept 3      # a lead: subtask 3 is accepted
```

The board already knows which terminal is working on which subtask at which
moment. Making an agent restate that creates a second copy of the truth, and
reconciling the two is where the bugs live.

## Problem analysis

### Today the agent is asked to restate what the board already holds

The orders tell a coder to run:

```
switchboard done --from "Feature-coder-2"
```

and a lead to run:

```
switchboard accept --plan "eaba9825-3fcd-4623-8452-2232e6dd92f5"
```

Both arguments describe state the host owns: which seat this terminal is, and
which subtask that seat was dispatched.

### `--from` is ALREADY redundant — the CLI resolves it

`cmdAccept`'s own docblock:

> `from` resolves from the host-injected `SWITCHBOARD_TERMINAL` (set for every
> seat, leads included), `--from` still wins for the human-CLI path

`cmdDone` does the same. So the identity half of this design is **already
implemented**; the standing orders simply tell agents to type an argument the
CLI does not need. It is a field an agent can get wrong about itself, offered
for no reason.

### `--plan` is the real defect, and it carries its own warning

> The one field the lead supplies is `--plan` (the SUBTASK's planId)

A 36-character UUID, copied by an agent out of prose, into a shell command. The
orders then need a defensive line that exists *only* because the argument
exists:

> accept with the SUBTASK's planId, **never the feature's**

That warning is the tell. An interface that has to caution you against the
adjacent valid value is asking for the wrong thing.

### The ordinal already exists, in the place the lead reads

The feature file's auto-generated block is an ordered list, and it is what a
lead works from:

```
    ## Subtasks
    - [ ] [Mission 01 — A Launch Touches Only Its Own Members](../plans/…) — **PLAN REVIEWED** — ID: d45d58bb-…
    - [ ] [Mission 02 — One Derived Gate for "Is This a Team Head"](../plans/…) — ID: 614269ec-…
    - [ ] [Mission 03 — A Batch Move to a Team Creates a Mission …](../plans/…) — ID: eaba9825-…
```

Position in that list is stable for the life of the feature. `accept 3` needs no
new bookkeeping — it is the third line. The UUID on the end is there purely so
the lead can copy it back, which is the step this plan removes.

### `done` is the wrong word, and coders act on the word

The verb is named for the wrong event. **`done` means finished** — so a coder
posts it once, at the end of its round, and does not post it again when it comes
back through a fix round. It has already said it was done; saying it twice reads
like a contradiction.

But the board does not need to know the work is *finished*. It needs to know the
seat is **handing work back for review**, which happens every round, fix rounds
included. `submit` is that event. A coder can submit three times against the same
subtask without ever saying something it believes to be false.

This is why the rename is not cosmetic: the old name suppresses the report the
board is waiting for, on exactly the rounds where a card has already been round-
tripped once and is most likely to stall.

### What it cost on 2026-09-20

The whole run carried UUIDs through prose: relays quoting
`eaba9825-3fcd-4623-8452-2232e6dd92f5`, status checks quoting
`f6d3e138-828f-442c-8f1f-2c6de58c116d`, the lead re-emitting them into shell
commands. Every one of those is a copy that can be wrong, and a wrong-but-valid
UUID accepts the wrong subtask, clears the wrong seat and closes the wrong
round — silently, because it succeeds.

## Metadata

**Project:** Orchestration
**Complexity:** 6
**Tags:** cli, api, feature, refactor

> **Superseded:** `**Tags:** cli, teams, prompts, orchestration, standalone` and `**Complexity:** 3`
> **Reason:** `teams`, `prompts`, `orchestration`, `standalone` are not in the
> allowed tag list. Complexity 3 underscored the change: the improve pass found
> the plan touches ~11 source surfaces plus a server-endpoint resolver and six
> contract tests — medium multi-file work, not a routine single-file edit.
> **Replaced with:** the values above.

> **Superseded:** `**Scope:** src/standalone/cli.ts (cmdAccept, cmdDone),
> src/services/standingOrderFragments.ts, the team head prompts, and the feature
> subtask block renderer. Standalone only.`
> **Reason:** The surface audit found the real scope is wider. `accept --plan`
> and `done` are instructed from eleven source surfaces, not four — including
> two places inside `LocalApiServer.ts` itself (an error message at ~5429 that
> teaches the lead to retry with `accept --plan`, and
> `composeAcceptanceInstruction` at ~1194). The ordinal also cannot resolve
> without server-side work in `POST /kanban/task/complete`, and
> `POST /kanban/round/register` must take ordinals or the lead's loop breaks
> (see Proposed Changes). "Standalone only" is accurate for `cli.ts`, but the
> prompt fragments and renderers are shared code — they land in both
> composition roots automatically, which is how the non-divergence rule is
> satisfied here.
> **Replaced with:** the Scope section below.

### Scope

- `src/standalone/cli.ts` — `cmdDone`→`cmdSubmit` rename + loud `done` alias,
  `cmdAccept` positional-ordinal parsing, usage header (~line 34) and `cmdHelp`.
- `src/services/LocalApiServer.ts` — ordinal/bare resolution inside
  `_handleKanbanTaskComplete` (~5359), ordinal form for
  `_handleKanbanRoundRegister` (~6110), `composeAcceptanceInstruction` (~1194),
  and the feature-planId rejection strings (~5429).
- `src/services/KanbanDatabase.ts` — explicit `ORDER BY` on
  `getSubtasksByFeatureId` (~9447).
- `src/services/KanbanProvider.ts` — `_regenerateFeatureFile` subtask-block
  renderer (~18280) plus the lead drive prompts at ~6753, ~6808, ~6819.
- `src/services/standingOrderFragments.ts` — member completion (~95-126),
  `HEAD_COMPLETION_FRAGMENT_BODY` (~150-171), `buildHeadNextFragment` (~177),
  `CODING_HEAD_WORK_WITH_ROUNDS` (~201), `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY`
  (~234).
- `src/services/teamWiring.ts` — ~75, ~485, ~1072, ~1144, ~1196.
- `src/services/agentPromptBuilder.ts` — `STAGGERED_IMPLEMENTATION_DIRECTIVE`
  (~1297), `CODING_COMPLETION_REPORT_DIRECTIVE` (~1309).
- `src/services/standingOrders.ts` — `COMPLETION_DIRECTIVE_ORDER_INSTRUCTION`
  (~725).
- `src/services/PlanIngestionEngine.ts` — dispatch prompt lines ~1834, ~2389.
- Contract tests asserting the old strings (named under Verification).

## User Review Required

- **`done` becomes a loud alias, not a hard failure.** It performs the submit
  and prints "the verb is now `submit`" on stderr, succeeding loudly. Chosen
  over dropping it because on-disk `member-orders.md` artifacts and any cached
  prompt still say `done`; a seat that hard-fails reports nothing and stalls
  silently — the exact failure this plan exists to remove. Veto here if a hard
  failure is preferred.
- **`accept` generalises beyond the feature-lead case.** `accept --plan` is
  today also the self-acceptance verb for seat-authority planners and single-
  plan heads; see Proposed Changes §1 for the generalised candidate rule.
- **`round/register` moves to ordinals** (`rounds: [[1,2],[3]]`, feature derived
  from the poster) — required for internal consistency once the subtasks block
  stops printing UUIDs. PlanId strings stay accepted as a tolerance read.

## Constraints

**The board is the authority; the agent asserts nothing about identity.** The
seat comes from `SWITCHBOARD_TERMINAL`. No prompt may reintroduce `--from`.

**Fail loudly on ambiguity — never pick quietly.** If a bare or ordinal accept
cannot resolve to exactly one subtask, it must say so and name the candidates.
A guess here accepts the wrong work.

**Keep the escape hatch off the happy path.** `--plan` may survive for the human
CLI, exactly as `--from` does. It must not appear in any agent-facing prompt.

**The ordinal is the FEATURE's subtask order**, not the round's, so it does not
shift as rounds open and close. A lead that reads "3" in the feature file and
types `accept 3` an hour later must hit the same subtask.

**Teams are unreleased dev work** — clean break, no compatibility shim for the
argument forms.

## Complexity Audit

### Routine

- Verb rename `cmdDone` → `cmdSubmit` and dispatch-table entry
  (`cli.ts:2642`, `:5258`); `submit` has no existing verb collision (verified —
  the only `submit` matches are webview form attributes).
- Mechanical prompt-string sweep across the surfaces listed in Scope; each is
  a literal replacement of `done`→`submit` or `accept --plan "<…>"`→`accept <n>`.
- Subtask-block renderer line format change (`KanbanProvider.ts:18280-18287`).
- Contract-test updates: several suites assert on the old literals and must be
  updated in the same diff, or the rename fails its own gates.

### Complex / Risky

- **Ordinal resolution must be atomic and authoritative.** Resolving
  `accept <n>` server-side inside `_handleKanbanTaskComplete` (rather than
  CLI-side over a GET) avoids a read-then-write race and keeps "fail loudly,
  name the candidates" in one place. The resolver must answer "which feature
  does this lead head" from host evidence (see Proposed Changes §1).
- **Non-feature `accept` callers exist.** Planning-team seats self-accept
  (`teamWiring.ts:1196`, `completionAuthority: 'seat'`), the Coding-team head
  accepts a single plan (`:1144`), and the batch lead accepts per plan
  (`KanbanProvider.ts:6753`). Bare/ordinal `accept` must have defined semantics
  when no feature exists, or those prompts keep `--plan` and the no-UUID
  invariant leaks.
- **`round/register` coupling.** Removing `— ID:` from the subtasks block while
  `round/register` still demands `featureId` + subtask planIds would leave the
  lead unable to form the call that starts its feature. Register must accept
  ordinals in the same diff.
- **Ordering is currently incidental.** `getSubtasksByFeatureId`
  (`KanbanDatabase.ts:9447`) has no `ORDER BY`; today's order is de-facto rowid
  order. Renderer and resolver share the function so they always agree, but an
  explicit sort makes the ordinal a defined order rather than an accident —
  accepting a subtask does not shift ordinals either way (`setCompletedAt`
  writes `completed_at` only; `status` stays `'active'`, so accepted subtasks
  remain in the result set).

## Edge-Case & Dependency Audit

### Race Conditions

- Concurrent accepts are already covered: `completeCardInternal` is idempotent
  and the round-advance path reports `roundAlreadyClosed`. Ordinal resolution
  adds a read before the write; the resolution and completion run inside one
  request, so the window is the same one `planId` callers already have.
- A subtask deleted/re-added by feature Rearrange between the lead reading the
  file and typing `accept <n>` can land on a different row — that is an
  operator action mid-run, and the error path (name the resolved title in the
  success output) makes the mismatch visible. The accept success line must
  print the resolved subtask's title, not just the ordinal.

### Security

- `planId`/`ordinal` are resolved to a plan row server-side before any write;
  keep the existing path-separator rejection on `planId` (`LocalApiServer.ts:
  5391`) and apply the same validation posture to ordinal input (integer, in
  range, no interpolation into paths or SQL).
- A non-lead poster calling `accept <n>` must not resolve another team's
  feature: the candidate set is derived from the poster's own seat/team, and a
  poster with no team and no held card gets a named 400, same as
  `round/register`'s null-roster path.

### Side Effects

- `submit` is one verb over one endpoint (`POST /kanban/queue/done`) for both
  the team path and the global queue pop — the rename is total. The endpoint
  path itself is NOT renamed: it is internal (CLI↔server), and churning it buys
  nothing. Same for `/kanban/task/complete` and `/kanban/round/register`.
- `submit` keeps `--outcome failed` (failure reporting is a real, instructed
  path: `standingOrderFragments.ts:111`, `:236`), `--plan` and `--from` for the
  human-CLI path, and `--json`. Agent-facing prompts name none of them except
  `submit --outcome failed` where failure reporting is taught.
- Existing on-disk `.switchboard/teams/*/member-orders.md` files still say
  `done` until the next delivery; the loud alias covers that gap — this is the
  concrete argument for alias-over-drop.
- `accept` success output must echo the resolved subtask title + ordinal so a
  shifted ordinal is visible in the seat's transcript.

### Dependencies & Conflicts

- The `switchboard-orchestration` skill (`.agents/skills/switchboard-
  orchestration/SKILL.md`) documents the HTTP endpoints, whose paths do not
  change; verify it names no CLI verb text and update if it does. The compiled
  copy inside `bundledProtocols.ts` regenerates from the skill source.
- `POST /terminals/teams/<id>/queue/done` (member-fragment step 2,
  `standingOrderFragments.ts:114`) is a different endpoint — a relay route,
  not the verb being renamed. Leave it.
- Contract tests asserting the old literals must change in the same diff (list
  under Verification). `team-state-endpoint-access-contract` asserts on the
  endpoint paths `POST /kanban/round/register` and `POST /kanban/round/complete`,
  which survive — check but likely no change needed.
- `getSubtasksByFeatureId` is called from ~10 sites; adding `ORDER BY` is safe
  (all callers consume it as an unordered set or want this same order), but the
  change is a shared-function edit — run the callers' tests.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: an ordinal resolver that guesses instead of failing (mitigated by
server-side resolution with named-candidate errors and title echoing in the
success line); the `round/register` coupling silently breaking the lead's loop
if `— ID:` is removed without ordinalising register (mitigated by shipping both
in one diff); and non-feature `accept` callers (planners, single-plan heads,
batch leads) being left on `--plan` (mitigated by the generalised candidate
rule — every caller resolves against its own ordered candidate list). The
`done` loud alias is deliberately chosen over a hard failure so stale on-disk
orders cannot strand a seat.

## Proposed Changes

### 1. `accept <n>` resolves the ordinal against the feature's subtask order — server-side

> **Superseded:** "The lead's team and open feature come from its seat
> identity; `<n>` indexes the feature's ordered subtask list. `accept` with no
> argument and exactly one subtask awaiting acceptance resolves to that one."
> (mechanism unspecified)
> **Reason:** The plan never said where resolution happens. CLI-side
> resolution needs a new read endpoint and creates a read-then-write window;
> it also duplicates the candidate-naming logic the loud-ambiguity constraint
> requires. And the bare-accept spec only covered feature subtasks, while
> `accept` is also the self-acceptance verb for non-feature callers.
> **Replaced with:** server-side resolution inside `POST /kanban/task/complete`
> via a generalised ordered-candidate rule (below).

**`POST /kanban/task/complete`** (`LocalApiServer.ts:5359`) gains an optional
`ordinal` field: `{from, planId?} ` XOR `{from, ordinal?}`. `planId` keeps
working unchanged (the human escape hatch). When `planId` is absent, the
handler resolves the poster's ordered **acceptance candidates**:

- **Feature case** — the poster holds a feature card (a row with
  `isFeature`, `ownerSeat === from`, `completedAt IS NULL`; corroborate with
  `feature_id` on the team's `coding_rounds` rows via
  `getCodingRoundsByTeam('team_' + encodeURIComponent(from)…)` — the same
  derivation `round/complete` uses at `:5892`). Candidates =
  `getSubtasksByFeatureId(featureId)`, in that order. `accept <n>` → nth row;
  out of range → 400 naming the valid range; already-accepted → the existing
  idempotent path.
- **Non-feature case** — candidates = incomplete, non-feature cards whose
  `ownerSeat` is the poster's seat or (when the poster heads a team) its
  roster's coding seats, ordered `owner_since ASC`, `planId` tiebreak. Covers
  the planning-seat self-accept, the coding-team head, and the batch lead.
- **Bare `accept`** → exactly one *incomplete* candidate resolves it; zero →
  400 naming what was checked; more than one → 400 listing candidates with
  their ordinals and titles — the error IS the menu the caller retries from.
- **Resolution provenance:** success output names the resolved subtask title +
  ordinal (and the feature title in the feature case), so a shifted ordinal is
  auditable after the fact — the repo rule that "which store answered" must be
  answerable applies to "which card did `3` mean".
- Zero candidates and a poster with no team → a named 400 ("no open feature
  held by '<seat>'" / "no cards awaiting acceptance for '<seat>'"), never a
  silent pick.

**`POST /kanban/round/register`** (`LocalApiServer.ts:6110`): `featureId`
becomes optional — when absent it is derived from the poster's held feature
card exactly as above (absence + no feature = the existing 400 shape). Each
`rounds` entry accepts **ordinals or planIds** — integers or numeric strings
map through `getSubtasksByFeatureId`'s order; UUID strings validate against
the subtask set as today. Out-of-range/unknown entries → 400 naming the
offending entry and the valid range. Stored rows keep planIds (`subtask_seats`
shape unchanged — no migration).

**`KanbanDatabase.getSubtasksByFeatureId`** (`:9447`): add
`ORDER BY rowid ASC` — codifies the de-facto order the renderer already emits,
so "the number the lead reads" and "the number the server resolves" are the
same defined order, not an accident of SQLite's mood.

### 2. `done` is renamed to `submit`

`cmdDone` dispatches on `process.argv[2] === 'done'` and posts to
`POST /kanban/queue/done`. The team path and the queue pop are the same verb,
so the rename is total — there is no second `done` to leave behind.

> **Superseded:** "`submit` … takes nothing" and "the seat is resolved from
> the environment. No `--from`, no plan id".
> **Reason:** `cmdDone` also carries `--outcome failed` (`cli.ts:2657`) — the
> failure-reporting path two fragments instruct — and `--plan` as a
> server-side guard (planId mismatch → 400). "Takes nothing" would delete the
> failure signal. What dies is the *agent-facing requirement* for arguments,
> not the flags.
> **Replaced with:** `submit` takes no required argument; `--outcome`,
> `--plan`, `--from`, `--json` survive unchanged for the human-CLI path, and
> `submit --outcome failed` remains the instructed failure form.

The seat is resolved from `SWITCHBOARD_TERMINAL` exactly as today — the loud
named-variable failure at `cli.ts:2684` is kept, reworded to `submit`.

**`done` must not survive as a silent alias.** An alias that quietly works keeps
the old word in circulation, and the old word is the defect: an agent that
reaches for `switchboard done` out of habit gets the same once-per-round
behaviour this change exists to remove. Resolution: **`done` becomes a loud
alias** — it runs `cmdSubmit`, prints `[switchboard] 'done' is now 'submit' —
same behaviour, new name.` on stderr, and exits with submit's code. Chosen
over dropping the verb because on-disk `member-orders.md` files and cached
prompts still say `done`; a hard failure there strands the seat's report —
the stall this plan exists to kill. Never a silent success.

Also rename the `cmdDone` function to `cmdSubmit` — contract tests key on the
function name (`cli-api-target-contract.test.js:623`,
`bare-completion-contract.test.js`, `cli-board-commands-contract.test.js:699`,
`mission-stage-and-claim-contract.test.js:476`).

### 3. The subtask block prints the ordinal, and stops printing the UUID

`_regenerateFeatureFile` (`KanbanProvider.ts:18280-18287`) emits numbered
lines:

```
1. [Mission 01 — …](../plans/….md) — **PLAN REVIEWED**
2. [Mission 02 — …](../plans/….md) — **CODER CODED**
3. [Mission 03 — …](../plans/….md) — **CREATED**
```

`1.`, `2.`, `3.` so the number the lead types is the number it reads.

> **Superseded:** "The UUID comes out of the agent-facing rendering entirely;
> it has no remaining purpose there."
> **Reason:** The UUID has a remaining purpose the original text missed:
> `POST /kanban/round/register` requires `featureId` and subtask planIds, and
> the subtasks block is the only place the lead reads them. Removing the ID
> while register still demands UUIDs leaves the lead unable to form the call
> that starts its feature.
> **Replaced with:** the UUID still comes out — but only because §1 moves
> `round/register` to ordinals in the same diff. The two changes are
> inseparable; landing the renderer change alone breaks registration.

### 4. Every agent-facing surface loses the arguments

> **Superseded:** "Every agent-facing instruction becomes `submit` or
> `accept <n>`." (scope: standing orders + team head prompts)
> **Reason:** Incomplete enumeration — the sweep is eleven source surfaces,
> including server-side prompt composers and error strings.
> **Replaced with:** the enumerated sweep below.

- `standingOrderFragments.ts` — member fragment (`done`→`submit`,
  `done --outcome failed`→`submit --outcome failed`, the `accept --plan`
  mention at :124→`accept <n>`); `HEAD_COMPLETION_FRAGMENT_BODY` (register→
  ordinal form, `accept --plan`→`accept <n>`, and the "never the feature's"
  warning is deleted with the argument that made it necessary);
  `buildHeadNextFragment` (`done`→`submit`);
  `CODING_HEAD_WORK_WITH_ROUNDS` (register wording → ordinal form — note this
  body still tells the lead to post `round/complete`, contradicting the
  completion fragment's "you post nothing"; harmonise to "the system advances
  the round when its last subtask is accepted");
  `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY` (`done`→`submit`).
- `teamWiring.ts` — :75 (member route card), :485 (`switchboard done`→
  `switchboard submit`), :1072 and :1144 (`accept --plan "<…planId>"`→ bare
  `accept` — a single held card resolves without argument), :1196 (planning-
  seat self-accept → bare `accept`).
- `KanbanProvider.ts` — :6753 (batch lead: `accept <n>` over the ordered
  outstanding list; the prompt prints the numbered list), :6808
  (round/register → `{"from":<seat>,"rounds":[[1,2],[3]]}` — no `featureId`),
  :6819 (`accept <n>` — "the number in the feature file's Subtasks list"),
  :6787 ("its Subtasks section has plan IDs" → "numbered subtasks").
- `LocalApiServer.ts` — :1194 `composeAcceptanceInstruction` (`accept <n>`);
  :5429-5430 feature-planId rejection strings rewritten to `accept <n>` — as
  shipped they teach the deprecated form on the retry path.
- `agentPromptBuilder.ts` — :1297, :1309 (`switchboard done`→
  `switchboard submit`).
- `standingOrders.ts` — :725 `COMPLETION_DIRECTIVE_ORDER_INSTRUCTION`
  (`done`→`submit`).
- `PlanIngestionEngine.ts` — :1834, :2389 (`done`→`submit`).
- `cli.ts` — usage header (:34-35) and `cmdHelp` entries for `submit`/`accept`.

The defensive "never the feature's" line is deleted along with the argument
that made it necessary — `accept` can no longer name a feature at all.

## Verification Plan

### Automated Tests

New coverage:

- A coder running bare `submit` completes exactly the subtask its seat holds,
  with no arguments and no identity passed.
- `accept 3` accepts the third subtask of the lead's feature — asserted against
  a feature whose third subtask is NOT the one most recently submitted, so an
  implementation that quietly picks "the latest" fails.
- A bare `accept` with two subtasks awaiting acceptance **fails and names both
  with their ordinals**; with exactly one, it resolves.
- An out-of-range ordinal fails naming the range, and accepts nothing.
- The ordinal is stable across an accept — `accept 1` then `accept 3` hits the
  same third subtask (accepted subtasks stay `status='active'`, so the list
  does not shrink; this is also the regression test for the `ORDER BY`).
- Ordinal stability across a round closing — `accept 3` means the same subtask
  before and after.
- `round/register` with ordinal rounds `[[1,2],[3]]` and no `featureId`
  registers against the poster's held feature and stores planIds; a bad
  ordinal 400s naming the entry.
- Non-feature `accept`: a planning seat's bare `accept` resolves its own held
  card; a bare `accept` from a seat holding nothing 400s with the named
  reason.
- **No agent-facing prompt contains `--from` or `--plan`** — a grep gate over
  every surface listed in Scope (not just the fragments).
- A seat cannot accept, and a lead cannot submit, on another seat's behalf.
- **A coder can `submit` the same subtask more than once** — the fix-round
  case. The second submit is accepted and re-reports the seat; it is not
  swallowed as a duplicate of the first.
- `switchboard done` succeeds, performs the submit, and prints the rename
  notice on stderr — never a silent success.

Existing suites to update in the same diff (they assert the old literals):
`standing-orders-marker-contract.test.js` (:402-415),
`coding-head-prompt-contract.test.js` (:144),
`batch-move-team-prompt-contract.test.js` (:469-481),
`stage-marker-commit-contract.test.js` (:395),
`agentPromptBuilder.test.ts` (:362, :371), `cli-api-target-contract.test.js`
(:623 — function-name list), `bare-completion-contract.test.js` (:157-176),
`mission-stage-and-claim-contract.test.js` (:476),
`cli-board-commands-contract.test.js` (:699),
`queue-pipeline-contract.test.js` (:642-643),
`member-completion-reminder-contract.test.js` (:400, :413),
`team-state-endpoint-access-contract.test.js` (:281-283 — endpoint paths
survive; verify only), plus the `task/complete` suites
(`task-complete-endpoint`, `lead-accept-advances`,
`atomic-team-feature-run-context-lifecycle`).

### Goal Invariants

- `grep` over every agent-facing surface in Scope finds no `--from`, no
  `--plan`, and no 36-hex UUID placeholder an agent is told to type — while
  `switchboard submit` and `switchboard accept <n>` ARE present in the coder
  and lead fragments respectively (the paired positive assertion).
- `switchboard submit` exists in the CLI dispatch table and
  `cmdSubmit` exists in `cli.ts`; `cmdDone` is absent (or exists only as the
  loud-alias shim that forwards to it).
- `getSubtasksByFeatureId` in `KanbanDatabase.ts` carries an `ORDER BY`.
- The generated `## Subtasks` block emits `1.`/`2.`/`3.` numbered lines and
  contains no `ID:` field.
- A bare or ambiguous `accept` never writes `completed_at` — it 400s naming
  candidates.
- An agent never states its own identity to the system.

### Manual

Run a two-round feature. Coders type `submit`; the lead registers
`rounds: [[1,2],[3]]` with no UUIDs in sight, then types `accept 1`,
`accept 2`, `accept 3`. Nothing is copied. Then run `switchboard done` by hand
and confirm the rename notice prints and the submit still lands.

## Outstanding Questions

- **[user]** `done` is specified as a loud alias (performs `submit`, prints
  the rename on stderr). If a hard failure is preferred — cleaner break, but
  stale on-disk `member-orders.md` files then silently strand seats — say so
  before dispatch — proceeding on the assumption that the loud alias is
  wanted, for the reason stated in §2.
- **[user]** Non-feature `accept` candidates are ordered `owner_since ASC`
  (oldest held card first). If the operator wants a different order for the
  batch-lead case, adjust the comparator — proceeding on the assumption that
  oldest-first is the natural reading of "next".

---

*Improve-pass summary (2026-09-21):* verified every load-bearing claim against
source — `--from` env resolution, the single `done`→`queue/done` verb, the
renderer, and the `task/complete`/`round/register` handlers. Three corrections
landed as superseded callouts: ordinal resolution is now specified server-side
in `task/complete` (the plan named no mechanism); `round/register` moves to
ordinals because removing `— ID:` otherwise breaks registration; and "submit
takes nothing" was narrowed to "no required argument" since `--outcome failed`
is an instructed path. The prompt sweep was enumerated at eleven source
surfaces plus named contract tests, and `getSubtasksByFeatureId` gained a
required `ORDER BY`. Recommendation: complexity 6 — **Send to Coder**.
