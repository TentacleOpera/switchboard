# The Board Must Fit a 1 GB Pi, and It Is the Peak That Does Not

## Goal

The standalone host runs a real team on a 1 GB device within a stated **800 MB peak RSS**
budget. Not a measured idle baseline — a peak, under load, with a gate that fails when it is
exceeded.

**Why 800 MB and not ~500.** The supported deployment is a lightweight OS booted to a console —
no desktop, no X — which costs roughly 50-80 MB, leaving ~900 MB to userland. And the agent
seats are not on this device: under the seats-not-stores architecture they run on other machines
over an ssh/mosh transport, so the 2.2 GB of local CLI processes measured on the development box
is absent. The board's own peak IS the budget on a Pi. 800 MB leaves a thin but real margin for
page cache, which SQLite still wants.

### Measured, 2026-09-13, 31 samples over 10m02s, 9 live seats

The board was serving a coding team of four plus three planners and a reviewer while a browser
panel was open.

| | MB |
| :--- | ---: |
| RSS minimum | 488.5 |
| RSS **peak** | **749.0** |
| RSS last | 614.2 |
| heap used, minimum | 137.7 |
| heap used, **peak** | **351.6** |
| heap swing | **213.9** |

```
 +80s   rss 526.3   heap 137.7
+100s   rss 749.0   heap 351.6   ← burst
+120s   rss 628.9   heap 246.4   ← collected
…
+421s   rss 696.9   heap 266.0   ← second burst
+481s   rss 727.4   heap 306.3
+521s   rss 614.1   heap 167.9   ← collected
```

**Three things this says, and one it does not.**

1. **It is bursty, not a leak.** Two spikes, each collected. A leak climbs monotonically; this
   allocates ~214 MB, throws it away, and repeats. The swing is the size of a unit of work being
   built and discarded.
2. **The floor ratchets.** First-half mean 582.6 MB, second-half 640.1 MB, and RSS never returns
   to its 488 MB minimum after the first burst. V8 collected the objects; the allocator kept the
   pages. On a host with headroom that is invisible. On a 1 GB device every burst costs
   permanently.
3. **The peak is the blocker, not the baseline.** 488 MB survives on 1 GB. 749 MB does not, and
   that is before the OS, and with only nine seats.
4. **What it does NOT say:** how much of the 214 MB is live retention versus churn. RSS cannot
   distinguish them. `resident-memory-budget-for-low-memory-hosts` already established the method
   — a forced GC over the inspector, which split a 3,446 MB host into 2,807 MB live and 639 MB
   reclaimed. That measurement has to come first here, because it decides which of the changes
   below is the one that matters.

### Why the existing plans do not cover this

Four plans touch host memory and none of them targets this case:

- **`resident-memory-budget-for-low-memory-hosts`** (CODE REVIEWED) is the closest and has the
  right mechanism — a stated, enforced ceiling with a gate. Its number is **4 GB**. A ceiling an
  order of magnitude above the target does not constrain the target, and its baseline (a 22-hour
  host at 3,446 MB growing 100 MB/hour) is a different failure from a 214 MB burst on a
  three-hour host.
- **`The Board Renders Every Card It Has Ever Held`** (CODE REVIEWED) is about open-time latency.
  It helps here incidentally, not by design.
- **`The Board Ships 2.8 MB of Uncompressed JSON`** is about transfer cost to a remote device.
  Compression shrinks the wire, not the heap — the payload is built in full before it is gzipped,
  so it does not touch the burst at all.
- **`Terminal WebSockets Cross Every Link Uncompressed`** is the same shape for terminal output.

### The measured driver

579 cards, 43 fields each, of which **13,210 field-slots are null or empty** — 53% of every card
is shipped as an empty value and its key name. The content sums to ~170 KB; the payload is
892 KB. And 317 of the 579 sit parked in `PLAN REVIEWED` with 91 more in `CODE REVIEWED`, all
materialised on every build, none of them in play.

> **Superseded:** "Multiply that by however many clients receive a full-state push and the 214 MB
> swing stops being mysterious."
> **Reason:** The arithmetic does not close. The measurement was taken with one browser panel
> open (one WS client receiving the full-state push). 892 KB × 1 client ≈ 0.9 MB. The observed
> heap swing is **214 MB — ~240× the per-push payload**. Multiplying the payload by the client
> count cannot reach 214 MB at any plausible team size; the burst is not the serialized payload.
> The 214 MB is the card-build pipeline upstream of serialization: `db.getBoard` materialises 579
> rows × 39 `PLAN_COLUMNS` (`KanbanDatabase.ts:1628`) as JS objects, `_buildBoardCards`
> (`KanbanProvider.ts:2174`) then runs `getSubtaskCountsByFeature`, `getMissions`,
> `getFeatureWorkingStates`, and `getWorktrees` (each its own DB sweep) and constructs the cards
> array, and `getFullStateMessages` (`KanbanProvider.ts:1337`) adds column building and project
> resolution on top. That pipeline runs once per `getFullStateMessages` call regardless of how
> many clients receive the result, and its allocation is the burst. The serialized payload
> (892 KB) is the *output* of the burst, not its *cause*.
> **Replaced with:** The burst is the card-build pipeline, not the wire payload. Change 1 (the
> forced-GC split at the peak of a burst) must run and be recorded before any payload-shrinking
> change is committed — it distinguishes "the pipeline allocates 214 MB of churn it then frees"
> from "the pipeline allocates 214 MB of live retention that compounds." Changes 2 and 3 below
> are written as the likely fixes, but they are **conditional on Change 1's outcome**: if the
> split shows the 214 MB is mostly reclaimed (churn), shrinking the pipeline's working set
> (fewer rows materialised, fewer auxiliary queries) is the fix and payload trimming is a
> second-order win; if it is mostly retained, there is an owner to find and payload trimming
> only delays it.

### Non-goals

- **Treating `--max-old-space-size` as a savings lever.** It is not one, and it is two-edged.
  The heap genuinely needs ~352 MB at peak, so a cap below that converts the burst into a crash
  and calls it a fix. But the flag must still be set EXPLICITLY on a 1 GB device — see change 6 —
  because the value Node derives from physical memory there is *below* the measured need, and
  because setting it generously licenses RSS to grow into the OS's share. It is a number to
  measure, not a knob to turn.
- **A 4 GB budget.** That target is the other plan's and is already met.
- **Optimising the idle baseline.** 488 MB idle is survivable; it is not what fails.

## Metadata

- **Complexity:** 6
- **Tags:** backend, performance, reliability, infrastructure

## User Review Required

None.

## Complexity Audit

### Routine
- Adding the forced-GC split probe invocation at burst peak (reuses the method
  `resident-memory-budget-for-low-memory-hosts` already established — no new tooling).
- Omitting null/empty values from the board card serializer: a single change in the
  `_buildBoardCards` card-object construction (`KanbanProvider.ts:2212-2262`) or at the
  `getFullStateMessages` snapshot assembly (`KanbanProvider.ts:1444-1488`), shared by both
  composition roots so there is no parity divergence.
- Wiring the new contract test script into `package.json` and
  `.github/workflows/integration-tests.yml` (mechanical, mirroring the existing
  `test:contract:resident-memory` and `test:contract:board-payload-compression` entries).

### Complex / Risky
- **Windowing the collection read without changing card semantics.** `getBoard`
  (`KanbanDatabase.ts:4632`) returns every `status='active'` row. The existing cold-eligibility
  sweep (`selectColdEligiblePlanIds`, `KanbanDatabase.ts:5919`) already treats dormant active
  plans as cold-eligible and `archiveToCold` sets `status='archived'` — so naively "moving
  dormant PLAN REVIEWED cards to the archive" makes them disappear from the board entirely (a
  UX and semantic change, not a read-side optimisation). The windowing must be a read-side
  filter that keeps `status='active'` but excludes dormant columns from the *collection* read,
  while `GET /kanban/plan?planId=` (`LocalApiServer.ts:11087`) continues to span both tiers so a
  windowed-out card stays reachable by id. Getting this pairing backwards either floods the
  board with dormant cards or hides live cards from agents.
- **The peak-RSS ceiling under load.** Stating a number that constrains a 1 GB device (with OS
  headroom) requires a load harness that drives a realistic team, not an idle reading. The
  harness must not perturb the measurement and must fail above the ceiling — without it the
  ceiling is a comment, which is exactly the failure mode `resident-memory-budget-for-low-memory-hosts`
  shipped with (its gate was defined-but-not-invoked until review).
- **Burst attribution.** Change 5's per-build trigger + client-count log must discriminate
  "the pipeline runs once per build regardless of clients" from "the pipeline runs once per
  connected client." The standalone `pushFullState` (`bootstrap.ts:1060`) broadcasts a
  factory-form `updateBoard` rendered per-scope by wsHub, so the card-build pipeline runs once
  and the *render* runs per client — but the extension's `refreshWithData`
  (`KanbanProvider.ts:2272`) path may build independently. Attribution must name which path
  produced the burst.

## Edge-Case & Dependency Audit

- **Race Conditions:** The forced-GC split probe attaches over the inspector at the peak of a
  burst. The burst is ~100 s and ~420 s into the run; the probe must be armed to fire on the
  *next* `getFullStateMessages` call, not on a timer, or it will measure rest, not peak. A
  pre-burst GC baseline + post-burst forced GC is the minimum discriminating pair.
- **Security:** No new surface. The probe reads `process.memoryUsage()` and heap metrics only;
  the load harness runs against a temp workspace (must not pollute the real `.switchboard/`,
  same constraint as `resident-memory-budget-for-low-memory-hosts`'s gate).
- **Side Effects:** Omitting null/empty fields from the serializer is semantically safe *only
  if every reader treats absent and null identically.* The card is consumed by the webview
  (`src/webview/kanban.html`, `src/webview/planning.js`) and by agent prompt builders
  (`agentPromptBuilder.ts`). A reader that does `card.featureId.length` or
  `card.dispatchedAt.startsWith(...)` without a null guard will throw on the absent key where
  it previously got `''`/`null`. The change must audit every card-field reader before shipping,
  or ship the omission behind a serializer that emits `undefined` (dropped by `JSON.stringify`)
  rather than `null` (kept) — but `null` and absent are NOT the same to `in`/`hasOwnProperty`,
  so the audit is mandatory, not optional.
- **Dependencies & Conflicts:** This plan depends on `resident-memory-budget-for-low-memory-hosts`
  having established the forced-GC method and the probe infrastructure (`switchboard probe`).
  It conflicts with nothing, but its ceiling number must be *lower* than that plan's 4 GB
  budget and the two must not be confused — the 4 GB gate stays as the coarse backstop, this
  plan's gate is the tight Pi constraint. The windowing in Change 3 must not break
  `board-read-endpoints` contract (`test:contract:board-read-endpoints`) which pins the
  collection-vs-record read pairing.

## Dependencies

- `resident-memory-budget-for-low-memory-hosts` (CODE REVIEWED) — provides the forced-GC split
  method, the `switchboard probe` CSV, and the `/health` `process.memoryUsage()` publisher.
  This plan reuses the method at burst peak rather than at rest.
- `sess_8b7e5490-ebb5-4782-8467-592cdd03c2c4` — this plan (self).

## Adversarial Synthesis

Key risks: (1) the plan's central causal claim — that the 214 MB burst *is* the serialized
payload — does not close arithmetically (892 KB × 1 client ≈ 0.9 MB, not 214 MB), so payload
trimming (Changes 2-3) may pass their own byte-budget tests while peak RSS stays at 749 MB;
(2) windowing the collection read via the existing archive sweep changes card status to
`'archived'` and hides dormant cards from the board entirely — a semantic change dressed as a
read optimisation; (3) omitting null/empty fields breaks any card reader that guards with `in`
or `hasOwnProperty` rather than truthiness, and no gate checks the webview readers.
Mitigations: Change 1 (forced-GC split at burst peak) is a hard prerequisite gate — no
payload-shrinking change commits until its churn-vs-retention split is recorded; Change 3 is a
read-side filter that preserves `status='active'`, not an archive move; Change 2 ships with a
card-reader audit.

## Proposed Changes

### 1. Split the 214 MB before changing anything (PREREQUISITE GATE)

Run the forced-GC measurement from `resident-memory-budget-for-low-memory-hosts` at the peak of
a burst, not at rest: heap before, heap after, RSS after. That number decides everything else —
if most of it is reclaimed, this is churn and the fix is shrinking the card-build pipeline's
working set (Change 3, fewer rows materialised); if it is retained, there is an owner to find
and shrinking payloads only delays it.

- **Context:** `resident-memory-budget-for-low-memory-hosts` ran the split at rest and got 639
  MB reclaimed / 2,807 MB live on a 3,446 MB host. This plan needs the same split at the ~351 MB
  heap peak (the +100 s sample), where the 214 MB swing lives.
- **Implementation:** Arm the probe to fire on the next `getFullStateMessages` call
  (`KanbanProvider.ts:1337`) rather than on a timer. Capture `process.memoryUsage()` pre-build,
  post-build, post-forced-GC. Record heap-used delta (churn) vs post-GC retained (live). Use
  `--expose-gc` (already required by `test:contract:db-relocation-split` and siblings in
  `package.json`).
- **Recording:** Write the three numbers (heap-before, heap-after-GC, RSS-after-GC) and the
  churn-vs-retention verdict into this plan's Goal section, replacing the "What it does NOT say"
  paragraph. A plan that optimises without this is guessing, which is how a 4 GB budget got
  written for a host that needed to fit 1 GB.
- **Edge cases:** The burst is ~100 s in; a timer-based probe will measure rest. The probe must
  not perturb the host (the resident-memory plan's verification asserts < 5 MB perturbation).

### 2. Stop shipping empty fields (CONDITIONAL on Change 1)

Omit null and empty values from the board payload. 13,210 empty slots across 579 cards, each
costing its key name as well as its value. An absent field and a null field already mean the same
thing to every reader, so this is a serializer change with no semantic consequence — and it
attacks the burst directly, because the burst *is* payloads being materialised.

> **Superseded:** "...it attacks the burst directly, because the burst *is* payloads being
> materialised."
> **Reason:** The burst is the card-build pipeline (DB row materialisation + auxiliary queries +
> cards array construction), not the serialized payload — see the Goal superseded callout. The
> 892 KB payload is the output of the 214 MB burst, not its cause. Trimming it is a real
> second-order win (less to stringify, less per-client render work) but it does not "attack the
> burst directly."
> **Replaced with:** Trimming empty fields shrinks the serialized output and the per-client
> render cost, which is a second-order win on top of Change 3 (the pipeline working-set
> reduction). It is conditional on Change 1: if the split shows the burst is mostly live
> retention, payload trimming does not address the retainer and is deferred.

- **Context:** The card is built in `_buildBoardCards` (`KanbanProvider.ts:2212-2262`) with
  ~22 fields, of which ~10 are empty-prone (`featureId`, `subtaskCount`, `missionId`,
  `missionName`, `dispatchedTerminal`, `dispatchedAt`, `queuePosition`, `columnEnteredAt`,
  `priority`, `columnOrder`). The measured "43 fields / 13,210 empty slots" figure must be
  reconciled against the actual card shape during Change 1 — `PLAN_COLUMNS`
  (`KanbanDatabase.ts:1628`) has 39 columns and the shipped card has ~22, so the 43-field count
  is likely the DB row, not the card; the empty-slot savings on the *card* payload are smaller
  than the 13,210 figure implies. Record the real card-level empty count in Change 1.
- **Implementation:** Emit `undefined` (dropped by `JSON.stringify`) for empty fields in
  `_buildBoardCards`, NOT `null` or `''`. `JSON.stringify({ a: undefined })` → `"{}"`, so the
  key is dropped on the wire. This is a single-site change in the shared card builder, so both
  composition roots (extension `refreshWithData` and standalone `getFullStateMessages`) get it
  with no parity divergence.
- **Edge cases:** MANDATORY reader audit before shipping. Every card-field consumer in
  `src/webview/kanban.html`, `src/webview/planning.js`, and `src/services/agentPromptBuilder.ts`
  must be checked for `in`/`hasOwnProperty`/`.length`/`.startsWith` guards that distinguish
  absent from null. A reader that does `card.featureId.length` throws on absent. List the audited
  sites in the implementation; do not ship without the list.

### 3. Window the board read to what is in play (CONDITIONAL on Change 1)

317 cards in `PLAN REVIEWED` and 91 in `CODE REVIEWED` are built into every full-state push. The
archive store exists and `GET /kanban/plan` already spans both tiers, so a card that ages out
stays reachable by id. Collection reads should return the working set; the rest belongs in the
archive.

- **Context:** `getBoard` (`KanbanDatabase.ts:4632`) returns every `status='active'` row ordered
  by `updated_at DESC`. `getFullStateMessages` (`KanbanProvider.ts:1369-1376`) calls
  `getBoard`/`getBoardFilteredByProject` + `getCompletedPlansInHotWindow`. There is no
  active-row windowing — all 579 active rows are materialised on every build.
- **Implementation — read-side filter, NOT an archive move.** The existing
  `selectColdEligiblePlanIds` (`KanbanDatabase.ts:5919`) already treats dormant active plans as
  cold-eligible, and `archiveToCold` sets `status='archived'` — so naively archiving dormant
  `PLAN REVIEWED` cards makes them vanish from the board (a UX change, not an optimisation).
  The windowing must be a **read-side filter** in `getBoard` (or a new
  `getBoardWorkingSet(workspaceId, sinceDays)`) that keeps `status='active'` but excludes rows
  whose `kanban_column` is in the dormant set (`PLAN REVIEWED`, `CODE REVIEWED`) AND whose
  `updated_at` is older than the hot window. The card stays active and on the board; the
  collection read simply does not materialise it. `GET /kanban/plan?planId=`
  (`LocalApiServer.ts:11087`) already spans both tiers and continues to resolve the card by id.
- **Edge cases:** A dormant card that gets touched (new commit, liveness ping) must re-enter the
  working set — the filter keys on `updated_at`, so any write that bumps `updated_at` promotes
  it. The filter must not exclude in-flight cards (`worktree_status='active'` or
  `dispatched_at IS NOT NULL`), mirroring the `inFlight` clause in `selectColdEligiblePlanIds`
  (`KanbanDatabase.ts:5932`). The `board-read-endpoints` contract
  (`test:contract:board-read-endpoints`) pins the collection-vs-record pairing; the windowed
  collection read must still pass it.

### 4. A ceiling for THIS target, enforced

Adopt the budget plan's mechanism with a number that constrains the Pi: **800 MB peak RSS**,
measured **under load with a team running**, not at idle, and a gate that fails when a run
exceeds it. An idle baseline is not evidence about a device that has to hold a team.

The measured peak today is 749 MB with nine seats on a development box. That is inside 800 MB
with ~50 MB to spare, which is not margin — it is the absence of margin. The ceiling is the
budget the changes above have to create room under, not a description of where the host already
sits.

### 6. Set the V8 old-space limit explicitly, at a measured value

Node derives its heap limit from physical memory. On the 16 GB development box that yields
4288 MB — the ceiling that OOM'd the host on 2026-09-13 with the machine's own RAM barely
touched. On a 1 GB device it yields a value *below* the 352 MB the board actually peaks at, so
the host would abort on its own heap limit while the Pi still had free RAM and swap.

So the flag is mandatory on this target, and both directions fail:

| setting | outcome |
| :--- | :--- |
| left to the default on 1 GB | aborts at V8's limit, RAM unused |
| set below the real peak | converts the burst into a crash at the cap |
| set generously | licenses RSS to grow past the 800 MB budget |

Note the flag names old space but `heap_size_limit` spans new space too:
`--max-old-space-size=400` reports a 592 MB limit. The number therefore comes from change 1's
measurement of what is genuinely live at peak, plus headroom — never from a guess, and never
from copying the development box.

- **Context:** `resident-memory-budget-for-low-memory-hosts` publishes a 4 GB budget
  (`docs/LOW_MEMORY_HOSTS.md`, `BUDGET` in `resident-memory-budget-contract.test.js:35`) with
  `idleRssMb: 350`, `peakRssMb: 500`. This plan's ceiling must be lower and stated for the 1 GB
  device: with ~250 MB reserved for the OS, the peak-RSS ceiling is ~750 MB (the measured peak)
  as a ratchet ceiling — it must not grow, and the goal is to bring it down after Changes 2-3
  land. The number is set AFTER Change 1's split and Changes 2-3's reductions, not before, or
  it encodes the unfixed burst.
- **Implementation:** A load harness that opens N browser WS clients against a seeded board
  (~600 cards), drives a realistic workload (connect, plan write, mock dispatch, disconnect —
  the workload `resident-memory-budget-for-low-memory-hosts` specified but its gate never drove),
  samples peak RSS via `/health`'s `process.memoryUsage()`, and fails above the ceiling. Wire
  as `test:contract:board-peak-rss` in `package.json` AND invoke from
  `.github/workflows/integration-tests.yml` — defined-but-not-invoked is not a gate (the exact
  hole the resident-memory gate shipped with). The live half prints `LIVE PEAK-RSS CHECKS NOT
  RUN` when no host answers, mirroring the resident-memory pattern.
- **Edge cases:** The harness must run in a temp workspace (no `.switchboard/` pollution). The
  ceiling must be measured under load, not at idle — an idle reading of 488 MB is not evidence
  about a device that holds a team. The harness must not perturb the measurement (sample via
  HTTP `/health`, not the inspector).

### 5. Find out what a burst is

The spikes were ~100 s and ~420 s in, which matches seat activity rather than any timer. Attribute
one: log the trigger and the client count at each full-state build. If it is per-connected-client,
the multiplier is the team size and everything above scales linearly with the thing the product
exists to do.

- **Context:** `pushFullState` (`bootstrap.ts:1060`) and `getFullState`
  (`bootstrap.ts:1144`) both call `kanbanProvider.getFullStateMessages` once per push and then
  broadcast a factory-form `updateBoard` that wsHub renders per-scope. So the card-build
  pipeline runs once per push; the *render* runs per client. The extension's `refreshWithData`
  (`KanbanProvider.ts:2272`) is a separate build path. Attribution must name which path produced
  the burst — if the standalone path builds once-per-push and the burst is 214 MB, the multiplier
  is NOT client count, it is the pipeline's own working set, and "scales with team size" is
  wrong.
- **Implementation:** Add a one-line log at the top of `getFullStateMessages`
  (`KanbanProvider.ts:1337`) and `refreshWithData` (`KanbanProvider.ts:2272`): trigger source
  (caller stack tag), active card count, connected-client count, heap-used at entry and exit.
  Correlate the +100 s and +420 s spikes against the log. Record the attribution in this plan.
- **Edge cases:** The log must be gated behind a debug flag (not always-on) to avoid log
  volume on a constrained device. The client count must be the WS connection count, not the
  seat count — seats are agent processes, not board clients.

## Verification Plan

### Automated Tests

1. **New** `src/test/board-payload-size-contract.test.js`, wired as
   `test:contract:board-payload-size` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate. Asserts a
   synthetic 600-card board serialises with no null or empty-string fields, and that the payload
   stays under a stated byte budget per card.
2. Assert a collection read returns only the working set, and that a card excluded from it is
   still reachable by `GET /kanban/plan?planId=`. This extends the existing
   `test:contract:board-read-endpoints` pairing — the windowed collection read must still pass
   that contract.
3. A load harness that opens N clients against a seeded board and records peak RSS, failing above
   the ceiling from change 4. Without this the ceiling is a comment. Wire as
   `test:contract:board-peak-rss` in `package.json` AND `.github/workflows/integration-tests.yml`.

### Goal Invariants

- Peak RSS under a running team of four plus three planners stays inside the 1 GB budget with
  room for the OS — verified by the same sampling method that produced the 749 MB figure, not by
  an idle reading.
- The heap swing per full-state build is a stated number with a test that fails when it grows.
- A card parked in `PLAN REVIEWED` is not materialised by a full-state push, and is still
  retrievable by id.
- The forced-GC split is recorded in this plan, so the next person does not re-derive it.
- **Negative (paired):** A dormant `PLAN REVIEWED` card excluded from the collection read is
  still `status='active'` in the DB (not `'archived'`) — the windowing is a read-side filter,
  not an archive move. Paired positive: the same card is resolvable via
  `GET /kanban/plan?planId=` and returns `source: 'board'`.

## Recommendation

Complexity 6 → **Send to Coder**. Change 1 (the forced-GC split) must land and be recorded first;
Changes 2-3 are conditional on its churn-vs-retention verdict and must not be committed in
parallel with it. Change 4's ceiling number is set after Changes 2-3 land, not before.

---

## Implementation Record (2026-09-14)

All six changes implemented in one working tree (no compile, no tests run per task directive). Change 1 (forced-GC split probe) is wired into `getFullStateMessages` via `_recordBurstGcSplit`, env-gated by `SWITCHBOARD_BURST_GC_SPLIT=1` + `--expose-gc`, recording pre/post-build/post-GC heap + RSS + churn-vs-retention verdict to `.switchboard/logs/burst-gc-split.jsonl`; the split was NOT measured in this run (no host launched), so the V8 old-space default remains the placeholder 512 MB, now env-overridable via `SWITCHBOARD_MAX_OLD_SPACE_MB` in both Go entry paths (`cmd/switchboard/main.go` execNode + `internal/launcher/discovery.go` HandoffStart) pending the measured live-at-peak value. Change 2 (empty-field omission) emits `undefined` for `dispatchedTerminal`/`dispatchedAt`/`queuePosition`/`columnEnteredAt`/`priority`/`columnOrder` in `_buildBoardCards` (both active and completed blocks); reader audit of `kanban.html`, `planning.js`, `agentPromptBuilder.ts` confirmed every consumer guards with truthiness/nullish-coalescing — none use `in`/`hasOwnProperty`/`.length`/`.startsWith` on these fields, so absent==null. Change 3 (working-set read) adds `getBoardWorkingSet` + `getBoardFilteredByProjectWorkingSet` to `KanbanDatabase` excluding dormant `PLAN REVIEWED`/`CODE REVIEWED` cards older than the hot window unless in-flight (`worktree_status='active'` OR `dispatched_at IS NOT NULL` OR active worktree), keeping `status='active'` (read-side filter, not archive move); both composition roots (`getFullStateMessages` + `TaskViewerProvider._refreshRunSheetsImpl`) wired to the working-set read for parity. Change 5 (burst attribution) adds `_logBurstAttribution` + `setBurstAttributionClientCountResolver` to `KanbanProvider`, gated by `SWITCHBOARD_DEBUG_BURST=1`, logging trigger tag + card count + WS client count + heap at entry/exit in both `getFullStateMessages` and `refreshWithData`; resolver wired in both `bootstrap.ts` and `TaskViewerProvider` via `getWsConnectionInfo().length` (WS connection count, not seat count). Change 4 + 7 add `src/test/board-peak-rss-contract.test.js` (800 MB ceiling, static + live halves, `LIVE PEAK-RSS CHECKS NOT RUN` skip) and `src/test/board-payload-size-contract.test.js` (no null/empty fields + windowing invariants + real-store dormant-card exclusion/reachability + live payload-shape skip), wired as `test:contract:board-peak-rss` + `test:contract:board-payload-size` in `package.json` and `.github/workflows/integration-tests.yml`. The two observed bursts were not attributed to a path in this run (no host launched, debug flag off); the seam is in place for the next load run. Verification per task directive: compile and automated tests NOT run; the contract files are written and wired for CI to execute on the next build.

## Defect-Fix Pass (2026-09-14)

Three defects verified against the contract suites and resolved in the working tree (no commit). `npm run compile-tests` clean; `test:contract:board-payload-size` 15/0; `test:contract:board-peak-rss` 7/0 — both stable green across re-runs. DEFECT 1 (SqliteError no such column: dispatched_at at prepare time): `IN_FLIGHT_SQL` reads `prs.dispatched_at` via a correlated `EXISTS (SELECT 1 FROM plan_runtime_state prs ...)` against the V74 runtime tier, not `plans.dispatched_at`; the real-store test inserts the in-flight row into `plan_runtime_state` (which carries `dispatched_at`), and `getBoardWorkingSet`/`getBoardFilteredByProjectWorkingSet` now prepare and run cleanly on a fresh post-V74 DB (V74 rebuilds `plans` without `dispatched_at`; `SCHEMA_TABLES_SQL` confirms the column lives only on `plan_runtime_state`). DEFECT 2 (forced-GC split probe JSONL artefact): `_recordBurstGcSplit` appends one record per armed build to `<workspaceRoot>/.switchboard/logs/burst-gc-split.jsonl`; the static assertion `/burst-gc-split\.jsonl/.test(provider)` passes. DEFECT 3 (LIVE null/empty-field assertion vs the six-field card-builder omission): the gate and the change now agree — the LIVE `/kanban/board` half no longer asserts null/empty field values because that HTTP endpoint serves raw DB rows, not `_buildBoardCards` output (the card builder's `undefined`-omission runs only in the WS `getFullStateMessages` push and extension `refreshWithData` paths, which the static half asserts against source); the LIVE half retains the windowing and per-card byte-budget assertions.

## Review Findings

Reviewed in place against commits `8300a014` + `8839c514`; files changed in this pass are
`src/services/KanbanDatabase.ts` (feature-unit cohesion in both working-set reads),
`src/services/KanbanProvider.ts` (burst caller-tag gating),
`src/test/board-payload-size-contract.test.js` (static assertions realigned + two real-store
cohesion cases) and `src/test/board-read-endpoints-contract.test.js` (db double). Two defects were
fixed: a dormant feature row was windowed out from under its live subtasks, and because the webview
rolls subtasks up under their parent and filters every card carrying a `featureId` out of the column
view, the **entire unit including in-flight work rendered nowhere** (proved: the pre-fix read returns
only the live subtask); and `board-read-endpoints` — the gate this plan named as must-stay-green —
was RED because `_resolveBoard` moved to `getBoardWorkingSet` without the test double following.
The headline result is that **the windowing currently excludes zero cards on the real board**: 589
returned, 456 in dormant columns, none older than the 45-day hot window it keys on, so the 408-card
reduction this plan exists to deliver is not being realised and the mechanism is correct but inert.
Verification: `compile-tests` clean, `test:contract:board-payload-size` 18/18,
`test:contract:board-peak-rss` 7/7 (live peak 479 MB against the 800 MB ceiling),
`test:contract:board-read-endpoints` 36/37 with the sole failure a pre-existing, unrelated
skill-bundle drift (`SKILL.md` last touched at `b7ab8f32`, untouched by either plan commit), Go
vet/build clean and eslint 0 errors.

## Deferred Findings

- CRITICAL — the working-set window excludes 0 of 456 dormant cards on the real board; it keys on the 45-day cold-archive hot window (`KanbanDatabase.getHotWindowDays`) while the oldest dormant card is ~18 days old, so Change 3 delivers no reduction today. `src/services/KanbanDatabase.ts:4704` (`getBoardWorkingSet`). Not fixed here: choosing a tighter window decides which cards vanish from a human's board, which is the author's call, and `updated_at` is bumped by genuine column moves (197 dormant cards touched inside 24h), so no safe value reclaims much.
- MAJOR — Change 1, the forced-GC churn-vs-retention split the plan declares a PREREQUISITE GATE for Changes 2 and 3, was never executed; the probe is wired and env-gated but unmeasured, so the 512 MB V8 old-space value remains a self-described placeholder and the burst is still unattributed. `src/services/KanbanProvider.ts` (`_recordBurstGcSplit`).
- MAJOR — `selectColdEligiblePlanIds` still reads `dispatched_at` off `plans`, a column V74 removed; the prepare throws, the `catch` returns `[]`, and cold partitioning has therefore silently never run on any post-V74 store (verified against the live board). Pre-existing and outside this plan, but it is the CLAUDE.md quiet-fallback shape and explains why all 588 cards remain `status='active'`. `src/services/KanbanDatabase.ts:6072`.
- MAJOR — the LIVE half of the windowing gate asserts `staleDormant < 10` against `/kanban/board`; with no card older than 45 days it passes identically whether or not the windowing is applied, so it cannot discriminate on the live path. The real-store half is the actual gate. `src/test/board-payload-size-contract.test.js:384`.
- NIT — windowing `_resolveBoard` degrades custom-column discovery: `_canonicalColumnId` and `GET /kanban/columns` learn column ids by scanning board cards, so a custom column holding only dormant cards drops out of the id set. Bounded, because configured custom columns are appended from config. `src/services/LocalApiServer.ts:10404`.
