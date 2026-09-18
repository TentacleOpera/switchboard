# `next` Is Dispatch With a Priority Filter

## Goal

`switchboard next` dispatches the highest-priority card an operator could have dispatched by hand.
It chooses the card; everything after that choice is `dispatch`, unchanged. It is an operator
command — no seat, no team, no queue.

### Problem analysis

**What `next` is meant to be.** One sentence: **`next` is `dispatch` with a priority filter.**

- The candidate set is what is ready to dispatch, optionally narrowed by `--project` or
  `--complexity`.
- Selection is the board's own priority order: **starred first, then urgency (the `priority` field),
  then most recent**. That is `compareByPrecedence` in `'priority'` mode, unchanged — `next` adds no
  ordering of its own.
- A star means *in the current sprint*. Starring **is** the queue; there is no second queue concept.
- Once a card is chosen, the behaviour is `dispatch`'s, byte for byte.

**What is built instead.** `cmdNext` (`cli.ts:2358`) and `_runQueuePop`
(`LocalApiServer.ts:3938`) implement something else entirely:

| | intended | built |
| --- | --- | --- |
| candidate set | ready cards (`PLAN REVIEWED`, `CREATED`) | cards in the `STAGING` column |
| selection | starred → priority → most recent | `column_order` / `queue_position`, manual |
| stars | **are** the queue | **explicitly ignored** |
| caller | an operator | a seat, popping its own next work |
| scope | the board | a team, with `pacing` resolution |

**1. It refuses to run without a seat identity.** `cmdNext` requires `SWITCHBOARD_TERMINAL` or
`--from <seat>`, and exits 5 with *"`next` is run from inside a seat"* when neither is present. An
operator at a terminal is not a seat, so the command an operator most wants is the one they cannot
run. The `--from` flag should not exist on this command at all.

The refusal itself is correct for what the command currently does — *"a pop attributed to the wrong
seat hands that seat's card to someone else"* — but that hazard is created by the seat-scoping this
plan removes. A dispatch chooses its own target the way `dispatch` already does; nothing is
attributed to a requester.

**2. It pops from `STAGING`, which is being deprecated.** `_runQueuePop` filters
`p.kanbanColumn !== 'STAGING'`. When the column goes, `next` has no candidates and silently returns
nothing.

**3. Stars are suppressed, by a rule that expires with the column.** `kanbanOrdering.ts` states the
precedence plainly:

```
 * 1. starred first (priority_starred: 1 before 0) — OUTSIDE STAGING ONLY.
 * 2. manual order (column_order …)
 * 3. column_entered_at DESC (most recently moved to column first)
```

```js
if (!isStaging) { /* star comparison */ }
```

The stated reason is that *"letting the star jump a mission's queue would let board-level urgency
reorder a sequence the mission already committed to."* That is an argument about **missions**, and
it is a good one — it is not an argument against stars ordering the board. `next` is not a mission
runner and must not inherit a mission's rule.

**The pieces already exist; nothing assembles them.**

- `compareByPrecedence(a, b, column, mode)` in `kanbanOrdering.ts` **is** the intended ordering:
  starred first, then priority in `'priority'` mode, then `column_entered_at DESC`.
- `READY_COLUMNS = ['PLAN REVIEWED', 'CREATED']` (`cli.ts:690`) with subtasks excluded
  (`featureId === ''`) **is** the intended candidate set — the same set `switchboard ready` lists and
  the Mission Control protocol calls "What Is Ready To Go".
- `cmdDispatch` **is** the intended action.

So this is assembly, not invention: take the `ready` set, sort it with the function that already
encodes the precedence, dispatch the top one. The only genuinely new surface is `--complexity`.

**One caller class the problem analysis missed: prompt-injected seats.** `switchboard next` is not
only typed by operators and called by in-process queue machinery — three prompt sites instruct
*agents* to run it at a shell:

- `teamWiring.ts:666` (team head prompt): *"run node \"<cliPath>\" next (or switchboard next); if it
  returns a dispatched card, work it; if it returns dispatched: null, report that the queue is
  empty and stop."*
- `teamWiring.ts:684` (review team head prompt): same pattern after a passed review.
- `PlanIngestionEngine.ts:2056` (queue-stall nudge): *"Make the call: run `node "<cliPath>" next`"*
  — injected into a stalled head's terminal by the queue watch.

These callers rely on `SWITCHBOARD_TERMINAL` (host-injected per seat) and on `next` popping that
team's STAGING queue. Re-pointing the bare word `next` at board-priority dispatch without giving
these prompts a new word makes every prompted head dispatch the board's top card — unseat-attributed,
team-agnostic — the moment this lands.

### What already works and must not be disturbed

- **`dispatch`.** `next` selects a card and then behaves exactly as `dispatch` does. No second
  dispatch path, no divergent copy of its column/seat resolution.
- **`ready`'s definition of the candidate set.** One definition of "dispatchable", shared.
- **`compareByPrecedence`.** One ordering implementation. `board-collapse-03` already records two
  hand-rolled copies of ordering rules in `moveCardElements` that know nothing of the shipped
  priority order-by; a third copy inside `next` would be the same defect again.
- **Missions.** Untouched. A mission's committed sequence is not reordered by stars, and this plan
  does not change that — it only stops `next` behaving as though the board were one.
- **The seat pop itself.** `_runQueuePop`, `dispatchNextFromQueue`, the `_queueNextChain`
  serialisation, the queue/done handler, the schedule timer, the Run-queue button and the handoff
  all keep their exact behaviour. Only the *name* seats type to reach it changes (see Proposed
  Changes §3).

### Non-goals

- **Deprecating `STAGING`.** Tracked elsewhere (the `staging-column-*` and
  `feature_plan_…triage-staging-column…` plans). This plan stops `next` depending on it; it does not
  remove the column.
- **Changing what `dispatch` does** once it has a card.
- **Changing mission queue ordering.**
- **A queue.** Starring is the queue. No staging concept, no positions, no second ordering.

## Metadata

**Feature:** (unassigned)
- **Complexity:** 6
- **Tags:** cli, backend, kanban

## User Review Required

- **[RESOLVED 2026-09-17] No random tiebreak — most recent wins.** Operator: *"no need for fancy
  tiebreak, just choose the most recent."* That is step 3+ of `compareByPrecedence`
  (`column_entered_at DESC`, then `createdAt DESC`), so there is **no tiebreak code to write**.
  `next` is deterministic: the same board dispatches the same card.
- **[RESOLVED 2026-09-17] `priority` is the urgency field.** So `compareByPrecedence(..., 'priority')`
  implements the intended order end to end — starred, then priority, then the existing fallbacks.
  `next` writes no ordering of its own.
- **[RESOLVED 2026-09-17] `--complexity` is a general match** against the complexity bands the
  product already has. Dispatch routes on them today: *"default bands 1–4 intern / 5–6 coder / 7+
  lead; honors custom routing maps"* (`LocalApiServer.ts:3440`). `--complexity` resolves through that
  same map rather than a second, hardcoded band list — a custom routing map must narrow `next` the
  way it routes dispatch.

## Complexity Audit

### Routine

- Filtering the ready set and sorting it with an existing comparator.
- Handing the chosen card to the existing dispatch path (`performKanbanDispatch` — the in-process
  method behind `POST /kanban/dispatch`, `LocalApiServer.ts:3312`).
- Re-pointing three prompt strings from `next` to the renamed seat command.

### Complex / Risky

- **`next` currently has callers that are not operators — and one class was invisible to a code
  audit.** `_runQueuePop` is called in-process by the schedule timer, the `Run queue` button, the
  handoff, and the seat-paced `queue/done` handler, all through one serialisation point. Those
  callers want the *existing* seat-and-team behaviour. This plan changes the **CLI command**, and
  must not silently re-point those callers at board-priority selection — that would reorder work
  for every team on the board.

  On top of the in-process callers, **agent prompts instruct seats to type `switchboard next`**
  (teamWiring ×2, PlanIngestionEngine ×1 — cited in Problem analysis). No amount of endpoint care
  helps if the word a head was taught now means something else. The honest shape is a **rename**:
  the seat-pop CLI surface keeps its code and gets a new name (`pop`), the prompts are updated to
  it, and `next` is freed to be the operator command.

- **`--complexity` must resolve through the board's routing map, not a copy of the bands — and not
  the live-pool-degraded copy either.** The bands are configurable; a hardcoded `1-4 / 5-6 / 7+` in
  `next` would filter differently from the way the same board routes a dispatch, on the same card,
  in the same command. The subtler trap: the wired `resolveRoutedRole` seam
  (`bootstrap.ts:5101`, `LocalApiServer.ts:672`) calls `KanbanProvider.resolveRoutedRole(score)`
  with `degradeLivePool` defaulting to **true** (`KanbanProvider.ts:1940`) — it answers "where would
  this card go *right now*", which silently depends on which seats happen to be live. A band filter
  is a card property, not a dispatch outcome; it must resolve the **preferred** role
  (`resolveRoutedRole(score, project, false)` — custom map + pair-mode bypass, no live-pool
  degradation), or `--complexity intern` returns an empty set whenever no intern seat is up, on a
  board full of intern-band cards.

- **The dependency gate cannot live in the CLI.** `isDependencyReady` resolves predecessors through
  `_dependencyReadinessSource` (`LocalApiServer.ts:6459`), which unions the hot board with the cold
  archive (`getPlanByPlanIdUnion`). The CLI has no archive access — `GET /kanban/plans` is windowed.
  Selection therefore belongs server-side, in a new endpoint, not in `cmdNext`.

## Edge-Case & Dependency Audit

### Race Conditions

- **Two operators run `next` at once.** Both select before either dispatches, and the same card goes
  twice. The board already tolerates this — *"V81: the board never refuses a dispatch… a duplicate
  dispatch is valid; it overwrites the advisory owner"* — so this is not a correctness failure, but
  `next` should report the card it dispatched so the second operator sees what happened. The new
  endpoint does NOT need `_queueNextChain` serialisation for correctness (that chain exists to
  protect the pop's owner-stamp ordering, not the board); enqueuing on it anyway is harmless and
  keeps "one dispatch at a time" true if a pop is in flight — cheap insurance, recommended.

### Side Effects

- **An empty candidate set must be ordinary.** No ready cards, or none matching the filters, is a
  normal outcome, not an error: the endpoint returns `200` `{success:true, dispatched:null,
  reason}` — the same shape `queue/next` already returns for an empty queue — and the CLI prints a
  plain message and exits 0. Treating it as a failure makes an idle board look broken. (Note:
  `ready` exits 2 on empty; `next` deliberately follows the `queue/next` 200-null contract instead —
  the command *did* run, there was simply nothing to dispatch.)
- **A seat that still types `switchboard next` after this lands** gets an operator dispatch, not a
  queue pop. That is the intended semantics of the command — but it is exactly why the prompt
  migration in §3 is load-bearing, and why `pop` must ship in the same change.
- **Removing `--from` from `next` is a breaking change** for anyone driving it by hand today. It is
  also the point of the plan. Passing `--from` must be a usage error that names `pop`, not a silent
  ignore.
- **`isDependencyReady` lookup faults hold the card, per the pop's rule** (`LocalApiServer.ts:4105`):
  a fault BLOCKS the card it happened on — the gate exists to refuse, so its failure mode is
  refusal. A fault on one card must not empty the whole candidate set.

### Dependencies & Conflicts

- Sequences with the `STAGING` deprecation (`staging-column-2-frontend-dispatch-cleanup`,
  `staging-column-3-skills-docs-tests`, `feature_plan_20260827161635_triage-staging-column-…`) but
  does not block on it — `next` stops reading STAGING either way. What happens to `queue/next` when
  STAGING goes is deliberately left to those plans; its in-process callers keep a working source
  until then.
- **Composition-root scope:** the new endpoint lives in `LocalApiServer` (shared service — it lands
  in both hosts automatically). The new `resolveRoutingBand` seam is wired in `bootstrap.ts`
  (standalone) only, per the cutover rule: the CLI that consumes it is standalone-only, and on a
  host without the seam a `--complexity` request must fail loudly (400), never silently widen to
  "no filter". `cmdNext`/`cmdPop` are `cli.ts` — standalone only.
- **The orchestration protocol** (`bundledProtocols.ts` HTTP-surface skill) documents
  `POST /kanban/queue/next` — unchanged by this plan. The new endpoint should be added to that
  endpoint table so external agents can find it (the authoritative `GET /catalog` picks it up
  automatically; the hand-written table does not).

## Dependencies

- None blocking. Sequences with the STAGING-deprecation plans listed under Dependencies & Conflicts.

## Adversarial Synthesis

Key risks: (1) the seat-pop surface is name-coupled — `switchboard next` is baked into agent prompts
(teamWiring ×2, the queue-stall nudge), so repurposing the bare word without shipping `pop` and
migrating the prompts makes every prompted head dispatch the board's top card unseat-attributed;
(2) `--complexity` resolved through the *wired* `resolveRoutedRole` seam silently degrades against
the live seat pool — a band filter must use the non-degraded preferred role or it returns different
answers minute to minute; (3) a third copy of the ordering rules. Mitigations: `pop` ships in the
same diff with the prompts repointed; a new non-degrading `resolveRoutingBand` seam; selection calls
`compareByPrecedence` and `isDependencyReady` or it is wrong.

## Proposed Changes

### 1. `POST /kanban/dispatch/next` — select by board priority, then dispatch

New route in `LocalApiServer.ts` (register beside `/kanban/queue/next` at ~`:14456`; handler beside
`_handleKanbanQueueNext` at ~`:4325`). Body: `{ workspaceRoot?, project?, complexity? }`. Auth:
`_checkAuth(req, true)`, same as the queue/next handler.

Selection, in order:

1. Board rows via `this._resolveBoard(db)` (the same windowed read `GET /kanban/plans` uses,
   `:10489`) after `const db = await this._options.getKanbanDatabase?.(workspaceRoot)` → 503 when
   absent, mirroring `_runQueuePop`'s guard.
2. Candidates: `kanbanColumn ∈ READY_COLUMNS`, `featureId` empty, and `!completedAt`.
   *(Clarification — the completed-card exclusion mirrors the pop's `isQueueable` at `:4123`; a
   completed card stranded in a ready column is not dispatchable work. `ready` does not filter it
   because `ready` only lists; `next` acts.)*
3. `project` filter: exact match on `p.project`, same semantics as `filterPlans` (`cli.ts:698`).
4. `complexity` filter (when given): the flag value is a **band name** — `intern`, `coder`, or
   `lead` (case-insensitive; anything else → 400). A card matches when its **preferred routing
   role** equals the band: `resolveRoutingBand(parseComplexityScore(String(p.complexity)),
   p.project)`, where the new seam is `resolveRoutedRole(score, project, /*degradeLivePool*/ false)`
   — custom routing map + pair-mode bypass applied, live-pool degradation NOT applied (see Complex /
   Risky: the filter is a card property, not a dispatch outcome). An unparseable/unknown complexity
   resolves to `lead`, matching `resolveAutoDispatchColumn`'s `isUnknown → lead` rule
   (`KanbanProvider.ts:10413`) so `--complexity lead` sees the same set dispatch would route to
   lead. **If `complexity` is given and the seam is absent → 400** — a routing read must never
   silently widen to "no filter" (fallback rule).
5. Dependency gate — a **filter, not a refusal**, exactly as the pop does (`:4079-4116`): build
   `_dependencyReadinessSource(db, board)` once; per candidate, `isDependencyReady(planId,
   { ...base, onBlocked })`; blocked cards are collected with their `blockedBy` name; a lookup fault
   holds that card only. A card with no rows in `plan_dependencies` is always a candidate
   (NULL-inert — one empty query per card, nothing else changes).
6. Order survivors with `compareByPrecedence(a, b, 'PLAN REVIEWED', 'priority')` and take `[0]`.
   The column argument is a constant — both candidate columns are non-STAGING, so the STAGING
   branches never fire and the constant only documents "this is board order, not mission order".

   *(Clarification — the full chain in `'priority'` mode is starred → priority → `column_order`
   (NULL first = "just arrived") → `column_entered_at` DESC → `createdAt` DESC
   (`kanbanOrdering.ts:84-182`). "Then most recent" in the Goal is shorthand: a manually-arranged
   card outranks a same-star same-priority rival regardless of recency. That IS the board's own
   precedence — the operator sees it on screen — so the comparator is used unchanged and nothing is
   special-cased.)*
7. Dispatch the winner in-process: `performKanbanDispatch(workspaceRoot, planId, /*rawColumn*/
   undefined)` → omitted column = `'auto'` = complexity routing, byte-for-byte `dispatch`'s default.
   No `originTerminal`, no `targetTerminalOverride` — team-scoped resolution falls back to
   workspace-wide with the miss named in `teamRouting`, exactly as an operator `dispatch` does.
8. Response: on dispatch, pass through `performKanbanDispatch`'s status and payload, plus a
   `selection` field naming *why* — `{ planId, topic, starred, priority, columnEnteredAt,
   considered, skippedBlocked: [{planId, blockedBy}] }` — so a second racing operator sees what
   happened. On empty: `200` `{success:true, dispatched:null, reason:'nothing ready'}`; when every
   candidate was dependency-blocked, `reason:'dependency-blocked'` + `dependencyBlocked:{planId,
   blockedBy}` naming the highest-precedence blocker (the pop's contract at `:4160`, verbatim).

### 2. `resolveRoutingBand` — a non-degrading score→role seam

- `LocalApiServer.ts` options interface (~`:672`, beside `resolveRoutedRole`):
  `resolveRoutingBand?: (score: number, project?: string | null) => 'lead' | 'coder' | 'intern'`
  with a comment that it is the **preferred** role — custom map + pair bypass, never live-pool
  degradation — and that the sibling `resolveRoutedRole` option must not be reused for this filter
  because it degrades by default.
- `bootstrap.ts` (~`:5101`, beside `resolveRoutedRole`):
  `resolveRoutingBand: (score, project) => kanbanProvider.resolveRoutedRole(score, project ?? undefined, false)`.
  Standalone only — documented at the options site as intentionally absent from the legacy host
  (the CLI consumer is standalone-only; an absent seam + `--complexity` fails loudly at the
  endpoint).
- `READY_COLUMNS` is currently a `cli.ts` local (`:690`). Hoist it to `kanbanOrdering.ts` as an
  exported const (the module whose header already documents board-vs-mission precedence) and import
  it in both `cli.ts` and `LocalApiServer.ts` — one definition of "ready to dispatch" shared by
  `ready`, `next`, and the endpoint, per "no second definition" in What already works.

### 3. `pop` — the seat surface keeps its code and gets a new name

> **Superseded:** "Remove `--from` and the `SWITCHBOARD_TERMINAL` requirement from the CLI command."
> **Reason:** Deleting the seat-identity logic outright strands the prompt-injected callers
> (teamWiring ×2, PlanIngestionEngine nudge): heads are *taught* to run `switchboard next`, and a
> `next` that ignores seat identity would have them dispatch the board's top card mid-feature,
> unseat-attributed. The identity requirement is still correct — for the *pop* it protects.
> **Replaced with:** the seat-identity block, the `--from` flag and the `POST /kanban/queue/next`
> call move **unchanged** into a new `cmdPop` (`switchboard pop [--from <seat>] [--json]`). `cmdNext`
> keeps none of it.

- `cli.ts`: rename the existing `cmdNext` body (identity resolution `:2362-2394`, the
  `queue/next` POST `:2404-2408`, the seat-flavoured reporting `:2419-2432`) to `cmdPop`; wire
  `process.argv[2] === 'pop'` beside `:4687`.
- New `cmdNext`: parse `--project`, `--complexity <band>`, `--json`; reject `--from`/`--from=` and
  any unknown flag with a usage error (exit 5) that names `pop` for the seat case; ignore
  `SWITCHBOARD_TERMINAL` entirely (a seat env var must not flip the command's meaning — the command
  is deterministic). `POST /kanban/dispatch/next` with `{workspaceRoot, project?, complexity?}`;
  status → `dispatchExitCode` (unchanged — it already maps every status `performKanbanDispatch`
  emits); on `dispatched: null` print the `reason` plainly and exit 0; on success print the card
  and the `selection` rationale (star, priority, entered-at, skipped-blocked count).
- Subcommand registries to update: `KNOWN_SUBCOMMANDS` (~`:3709`), `HEAP_REEXEC_EXEMPT_SUBCOMMANDS`
  (~`:3663` — `pop` is a client command, exempt like `next`/`done`), the `subcommandTargetsCwd`
  guard (`:3814` — add `pop`), `usage()` (`:35` — `next [--project <name>] [--complexity <band>]
  [--json]` and a new `pop [--from <seat>] [--json]` line; the help text should say in one line
  that `pop` is what `next` used to be).
- **Prompt migration (same diff):** `teamWiring.ts:666`, `teamWiring.ts:684`,
  `PlanIngestionEngine.ts:2056` — `next` → `pop` in all three. The
  `switchboard-orchestration`/HTTP-surface skill's `POST /kanban/queue/next` row is unchanged; add
  a `POST /kanban/dispatch/next` row to its board-mutations table.
- Contract tests asserting `next` requires `SWITCHBOARD_TERMINAL` or calls `queue/next` are
  repointed at `pop`; new `next` tests cover the selection contract below.

### 4. Filter order is fixed: narrow first, then order

`--project` and `--complexity` filter the candidate set **before** the dependency gate and the sort,
so narrowing never changes the precedence among what survives — and a narrowed-out card's broken
dependency lookup can never hold back an unrelated run.

## Verification Plan

### Automated Tests

- **A starred card outranks an unstarred one** with higher priority and a newer date.
- **Among starred cards, higher urgency wins**; among equals, the comparator's own fallbacks decide
  (manual `column_order`, then `column_entered_at` DESC) — assert against the comparator, not a
  re-implementation of it.
- **Ties go to the most recent**, and `next` is deterministic: repeated runs against an unchanged
  board choose the same card.
- **No seat identity is required.** `next` with no `SWITCHBOARD_TERMINAL` and no `--from` dispatches.
- **`SWITCHBOARD_TERMINAL` set changes nothing** — `next` run inside a seat env dispatches the
  board's top ready card, not that seat's queue.
- **`--from` is gone from `next`**, and passing it is a usage error naming `pop`.
- **`pop` keeps the old contract**: requires `SWITCHBOARD_TERMINAL`/`--from` (exit 5 otherwise),
  POSTs `/kanban/queue/next`, and the three prompt sites (teamWiring ×2, PlanIngestionEngine nudge)
  name `pop`, not `next`.
- **STAGING is not consulted by `next`.** A board whose only cards are in STAGING yields "nothing to
  dispatch" (exit 0) — and `pop` still pops them.
- **Filters apply before ordering**: `--project` narrowing does not change the relative order of
  what remains.
- **`--complexity <band>` uses the configured map, not the live pool**: with a custom routing map,
  band membership follows the map; with an intern-band card on the board and no live intern seat,
  `--complexity intern` still selects it (non-degraded preferred role). Unknown complexity counts as
  `lead`. An invalid band value is a usage error.
- **A blocked dependency skips, it does not fail**: a board whose top-precedence card has an
  incomplete predecessor dispatches the next eligible card and the response names the skipped card
  and its blocker; when ALL candidates are blocked, `200` + `dependencyBlocked` names the
  highest-precedence blocker.
- **No dependency rows is business as usual**: an empty `plan_dependencies` table changes nothing
  about which card is chosen.
- **Empty is not an error**: no candidates → `dispatched: null`, exit 0, plain message.
- **One ordering implementation**: the selection path calls `compareByPrecedence` and does not
  re-implement precedence; `READY_COLUMNS` has exactly one definition, imported by both `cli.ts` and
  `LocalApiServer.ts`.
- **`queue/next` is unchanged**: its in-process callers (schedule timer, Run-queue button, handoff,
  `queue/done`) still get seat-and-team behaviour through `_runQueuePop`.
- **Dispatch is dispatch**: the endpoint's dispatch leg is `performKanbanDispatch` — complexity
  routing, gate pre-flight, and the verify-against-DB response all come from the one path.

### Goal Invariants

- `next` dispatches the card an operator applying the board's own priority order would have picked.
- A card whose declared dependency is unmet is skipped; a card with no declared dependency is never
  skipped.
- `next` never requires a seat, a team or a queue — and never reads `SWITCHBOARD_TERMINAL`.
- A seat's pop surface still exists (as `pop`), still requires seat identity, and every shipped
  prompt that teaches it names `pop`.
- Everything after card selection is `dispatch`'s behaviour (`performKanbanDispatch`).
- Stars order the board; missions are unaffected.
- No second ordering implementation exists; "ready" has one column-set definition.
- An empty board is an ordinary outcome.

## Recommendation

**Send to Coder** — complexity 6: assembly of existing machinery across CLI + server + prompts, with
two well-named traps (the live-pool-degrading role resolver; the prompt-injected seat callers) that
the plan now pins down explicitly.
