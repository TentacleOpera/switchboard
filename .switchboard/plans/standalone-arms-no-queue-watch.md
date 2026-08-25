# Standalone Arms No Queue Watch

## Goal

The queue-level stall backstop does not exist in the standalone/npx host. Not
degraded — absent. No queue watch is ever armed there, so the sweep reads an
empty list every tick: seat pacing is unreachable, a seat that dies holding a
card is never re-staged, a lead that goes idle with staged cards is never
nudged, and the operator is never told the pipeline stalled.

This is a composition-root gap, not missing capability. Every object the four
seams need already exists in the standalone host — the shared `KanbanProvider`,
a `TaskViewerProvider` running under the vscode shim, and a `LocalApiServer`.
Wire them in `bootstrap.ts`, wire the arm path, and add the CI gate that compares
the two roots so the next seam cannot land in one host only.

### Root Cause Analysis

**Chronology — the seams postdate standalone by a month.**

| | Commit | Date |
|---|---|---|
| `src/standalone/bootstrap.ts` first exists | `97cb2ea3` "Standalone Headless Switchboard (npx)" | 2026-07-17 |
| `setQueueHeadResolver` added | `2ac93ee4` "Point schedule at queue pop" | 2026-08-18 |
| `setQueuePacingResolver`, `setQueueTeamMembersResolver`, `setQueueEscalationRecorder` added | `ab5100d7` (team-feature work) | 2026-08-20 |

Each seam was added to the extension composition root. The standalone root was
never touched.

**Layer 1 — the four queue seams are wired in exactly one host.**

`PlanIngestionEngine` exposes nine setters. `src/extension.ts:1089–1163` wires
seven. `src/standalone/bootstrap.ts` wires five. Only three overlap:

| Seam | `extension.ts` | `bootstrap.ts` |
|---|---|---|
| `setOnWorkingStateCleared` | ✅ | ✅ |
| `setTerminalLivenessProvider` | ✅ | ✅ |
| `setTurnEndNotifier` | ✅ | ✅ |
| `setFeatureColumnRecomputer` | — | ✅ |
| `setFeatureFileRegenerator` | — | ✅ |
| `setQueueHeadResolver` | ✅ | **❌** |
| `setQueuePacingResolver` | ✅ | **❌** |
| `setQueueTeamMembersResolver` | ✅ | **❌** |
| `setQueueEscalationRecorder` | ✅ | **❌** |

Note the drift runs both ways — standalone wires two the extension does not.
This is what an unguarded seam produces: not neglect of one host, but two roots
nobody has ever compared.

**Layer 2 — no watch is armed, so the sweep has nothing to read.**

Four call sites can arm a queue watch. All four are inert in standalone:

- `KanbanProvider.ts:2745` (`onArmQueueWatch`) and `:8508` (`stageForQueue`)
  both resolve the engine through `this._globalPlanWatcher?.getEngine?.()`.
  `bootstrap.ts` contains **zero** references to `globalPlanWatcher`. The
  optional chain yields `undefined`, the `if (engine)` guard is false, and
  nothing throws.
- `LocalApiServer.ts:2230` (dispatch) and `:3182` (release) are both behind
  `if (this._options.armQueueWatch)`. That option is supplied only by
  `TaskViewerProvider.ts:3781`. Standalone builds its own options object at
  `bootstrap.ts:2603` (passed to `new LocalApiServer(options)` at `:2910`) and
  never sets it.

So even if the four resolvers were wired, `kanban.queueWatches` would stay
empty. Both layers must be fixed; either alone is a no-op.

**Layer 3 — why every gate stayed green.**

`npm run standalone-parity:check` exists and is wired into CI. Its own header
states its scope: message-type coverage extracted from `kanban.html`'s listener,
BroadcastHub installation, and hardcoded view state in the board payload. It is
a guard on the **browser read-back path**. The engine composition root is a
different surface and nothing inspects it.

The header also names the exact reason verb audits cannot catch this:
`bootstrap.ts`'s `default:` arm delegates every unmatched verb to the provider,
so verb reachability "cannot fail." The seams are not verbs. No test, doc, or
plan anywhere in the repo mentions `setQueuePacingResolver` outside the engine
and `extension.ts`.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, reliability, test

## User Review Required

None. The behaviour is confirmed intended (the queue/lead-paced pipeline is
meant to work in standalone), every resolver has a host-neutral implementation
already in the tree, and the gate shape is decided below.

## Complexity Audit

### Routine

- All four seams are one-line delegations to methods that already exist and are
  already instantiated in `bootstrap.ts` (`kanbanProvider`, `taskViewerProvider`, `server`).
- Adding one field to the standalone `LocalApiServer` options object at
  `bootstrap.ts:2603`.

### Complex / Risky

- **`taskViewerProvider` exists in standalone but is nullable.** It is declared
  `TaskViewerProvider | null` at `bootstrap.ts:231` and assigned at `:989` — the
  real class, running under the vscode shim, same as every contract test loads
  it. So `taskViewerProvider.resolveTeamMembers` *is* reachable and the wiring
  can be byte-symmetric with the extension's. It must be null-guarded, and it
  must be wired after `:989`. (An earlier draft of this plan asserted the
  opposite — that the method was vscode-bound with no standalone instance and
  that `resolveTeamMembersForHead` had to be called directly. That was wrong.
  `resolveTeamMembersForHead` remains the correct fallback shape if the null
  guard ever needs a real branch, but it is not required.)
- **Behaviour change for the standalone install base.** Standalone users have
  never received a queue stall nudge or a queue operator notification. After
  this, they will. That is the point of the fix, but it is a new class of
  message on a shipped host and should be expected rather than diagnosed as a
  regression. Delivery already works — `setTurnEndNotifier` is wired to
  `handleTurnEndNotify` at `bootstrap.ts:2499`.
- **The new gate must not be a hard equality check.** Two seams are legitimately
  standalone-only. A strict diff is red on day one, gets baselined to silence,
  and the guard is then worthless.

## Edge-Case & Dependency Audit

**Migration.** None. No persisted schema or config key changes shape.
`kanban.queueWatches` records written by standalone are the same
`QueueWatchRecord` the extension writes, so a workspace opened in both hosts
reads a consistent list. A standalone-armed watch whose `headTerminal` is absent
from the extension's fleet is already handled by the existing gate-(4)
absent-head path.

**Resolver availability — each verified present.**

| Seam | Delegate | Where it lives | Standalone-safe? |
|---|---|---|---|
| `setQueueHeadResolver` | `kanbanProvider.resolveCodingHeadFromGroups` | `KanbanProvider.ts:5480`, public | ✅ shared provider, db-backed |
| `setQueuePacingResolver` | `kanbanProvider.resolveTeamPacing` | `KanbanProvider.ts:5501`, public | ✅ shared provider, db-backed |
| `setQueueTeamMembersResolver` | `taskViewerProvider.resolveTeamMembers` | `TaskViewerProvider.ts:10688` | ✅ instantiated at `bootstrap.ts:989` under the shim — nullable, guard it |
| `setQueueEscalationRecorder` | `LocalApiServer.reportQueueDone` | `LocalApiServer.ts:2752`, public | ✅ standalone constructs one at `:2910` |

**Ordering inside `bootstrap.ts`.** The escalation recorder closes over the
`LocalApiServer`, which is constructed at `:2910` — *after* the other engine
wiring at `:786–2499`. The recorder callback must resolve the server lazily at
call time (read a module-scoped `server` binding inside the async body), not
capture it at wiring time, or it captures `undefined` and silently no-ops —
reproducing the exact `Promise<void>` failure mode this plan exists to close.

**`armQueueWatch` wiring shape.** Point the standalone options field straight at
`ingestionEngine.armQueueWatch`. Do **not** replicate the extension's
`_globalPlanWatcher` indirection: `bootstrap.ts` owns the engine instance
directly, and adding a `_globalPlanWatcher` to the standalone `KanbanProvider`
purely to satisfy `KanbanProvider.ts:2745`/`:8508` would add a second arming path
that can disagree with the first. One arming route per host.

**Race conditions.** None new. `armQueueWatch` serialises on its own
`updateConfigJson`; the sweep is serialised by `_scanInProgress`
(`PlanIngestionEngine.ts:508`); `_runQueueDone` serialises on `_queueNextChain`.

**Interaction with `the-dead-pacer-alert-has-no-budget-of-its-own.md`.** That
plan fixes an unguarded operator alert in the seat-pacing branch. Seat pacing is
currently unreachable in standalone *because* of this plan's gap. Landing this
one first newly exposes that defect to a second host. **Sequence the dead-pacer
fix first, or land both together.** Neither depends on the other's code; the
ordering is purely about not shipping a known repeating-alert bug into a host
that was previously immune.

**Existing tests.** `queue-pipeline-contract.test.js` asserts against
`PlanIngestionEngine.ts` source text and is host-agnostic — unaffected.
`standalone-parity:check` is a ratchet on a different surface — unaffected, and
deliberately not extended (see below).

## Dependencies

- None blocking. `the-dead-pacer-alert-has-no-budget-of-its-own.md` should land
  first or in the same change for the reason above, but this plan does not
  depend on its code.

## Adversarial Synthesis

Key risks. (1) Wiring the four resolvers without the arm path produces a
completely green, completely inert change — the seams resolve and no watch ever
exists to use them; Layer 2 is the half most likely to be skipped because Layer 1
is the one the bug report names. (2) Copying the extension's
`TaskViewerProvider.resolveTeamMembers` call into `bootstrap.ts` fails at
runtime, or worse gets "fixed" by instantiating a vscode-bound provider in the
headless host. (3) The escalation recorder capturing `server` at wiring time
instead of call time recreates the silent-no-op seam. (4) A hard-equality parity
gate is red on arrival, gets baselined, and becomes decoration. Mitigations: the
verification plan asserts an armed watch in standalone, not just the presence of
the wiring; the resolver table names the correct `teamWiring` entry point; the
ordering hazard has its own audit entry; the gate is specified as an
allowlist-with-reasons rather than a diff.

## Proposed Changes

### 1. `src/standalone/bootstrap.ts` — wire the four queue seams

Alongside the existing engine wiring. Three are direct delegations to the shared
provider:

```ts
ingestionEngine.setQueueHeadResolver(async (wsRoot) => {
    try { return await kanbanProvider.resolveCodingHeadFromGroups(wsRoot); }
    catch { /* groups unavailable — null, sweep notifies the operator */ }
    return null;
});

ingestionEngine.setQueuePacingResolver(async (wsRoot, headTerminal) => {
    try { return await kanbanProvider.resolveTeamPacing(wsRoot, headTerminal); }
    catch { /* groups unavailable — head pacing is the compat default */ }
    return 'head' as const;
});

// Byte-symmetric with extension.ts:1125, plus the null guard standalone needs
// (`taskViewerProvider` is `TaskViewerProvider | null`, assigned at :989).
ingestionEngine.setQueueTeamMembersResolver(async (wsRoot, headTerminal) => {
    return taskViewerProvider
        ? taskViewerProvider.resolveTeamMembers(wsRoot, headTerminal)
        : null;
});
```

The fourth resolves the server lazily, because it is wired before
`new LocalApiServer(options)` runs at `:2910`. `server` is declared
`let server: LocalApiServer;` at `:513`, so the binding exists at wiring time
but is unassigned until `:2910` — the truthiness check is load-bearing, not
defensive noise:

```ts
ingestionEngine.setQueueEscalationRecorder(async (wsRoot, planId, fromSeat) => {
    try {
        // Resolved at CALL time, not wiring time. Capturing `server` in a local
        // here would bind undefined and silently no-op forever.
        if (server && typeof server.reportQueueDone === 'function') {
            await server.reportQueueDone({ workspaceRoot: wsRoot, from: fromSeat, outcome: 'failed', planId });
        }
    } catch { /* best-effort — the operator notice already fired */ }
});
```

Match the extension's error semantics exactly: swallow-and-default, never throw
into the sweep. Wire all four **after `bootstrap.ts:989`** so
`taskViewerProvider` is assigned — next to the existing
`setTurnEndNotifier` call at `:2499` is the natural home.

Note `log()` in this file is `log(opts, ...args)` (`:118`), not a bare `log()` —
pass the options object through if any of these need to log.

### 2. `src/standalone/bootstrap.ts:2603` — supply `armQueueWatch`

Add to the options object handed to `LocalApiServer`, so the dispatch (`:2230`)
and release (`:3182`) arm sites become live:

```ts
armQueueWatch: async (wsRoot: string, headTerminal: string | null, opts?: { onDispatch?: boolean }) => {
    try { await ingestionEngine.armQueueWatch(wsRoot, headTerminal, opts); }
    catch (e) { log(options, `armQueueWatch failed: ${e instanceof Error ? e.message : String(e)}`); }
},
```

Standalone is single-workspace — `db` is bound once at `bootstrap.ts:467`
(`KanbanDatabase.forWorkspace(workspaceRoot)`) and the options object exposes it
as `getKanbanDatabase: async () => db` (`:2616`), ignoring its argument. The
`wsRoot` parameter on every seam above is therefore pass-through in this host.
Do not build a per-workspace map to "match" the extension; there is one root.

Leave `KanbanProvider.ts:2745`/`:8508` alone — they stay extension-only paths.
One arming route per host is the invariant; two that can disagree is the thing
to avoid.

### 3. New CI gate — `scripts/check-host-seam-parity.js`

Extract every `set<Name>(` public setter declared on `PlanIngestionEngine`, then
extract which of them each composition root calls (`getEngine().setX(` in
`extension.ts`, `ingestionEngine.setX(` in `bootstrap.ts`). Any seam wired in one
root and not the other is a failure **unless** it appears in an in-file
`ASYMMETRIC_SEAMS` allowlist with a one-line reason.

Seed the allowlist with the two genuine asymmetries only:

```js
const ASYMMETRIC_SEAMS = {
    setFeatureColumnRecomputer: 'standalone-only: the extension recomputes feature columns through KanbanProvider directly.',
    setFeatureFileRegenerator: 'standalone-only: same path as above.',
};
```

Decided shape, and why: an allowlist rather than a ratcheted count or a hard
diff. A count lets a *new* divergence hide behind a *fixed* one. A hard diff is
red on arrival and gets baselined into decoration. An allowlist makes the
default for any new seam "must be wired in both" — the safe direction — and
forces a human sentence for each exception, which is the artifact that was
missing here.

Wire it as its own step in `.github/workflows/integration-tests.yml` next to the
other parity guards, and add `"host-seam-parity:check"` to `package.json`.
Defining the script without adding the workflow step is the green-while-
incomplete hole this plan exists to close — do not do the first without the
second.

Deliberately **not** folded into `check-standalone-push-parity.js`: that guard is
scoped to the browser read-back path, and merging two unrelated surfaces into one
ratchet is how its scope became invisible in the first place.

### 4. Tests

Extend `src/test/queue-pipeline-contract.test.js` (already CI-wired) with
source-text assertions that `bootstrap.ts` wires all four seams and supplies
`armQueueWatch`, plus a negative assertion that the team-members resolver does
**not** reference `TaskViewerProvider`.

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. `npm run host-seam-parity:check` — passes with the two-entry allowlist. Then
   temporarily comment out one queue seam in `bootstrap.ts` and confirm the gate
   goes **red**; a parity guard that cannot fail is the failure mode being fixed.
3. `npm run test:contract:queue-pipeline` — existing assertions stay green, plus
   the new wiring assertions.
4. `npm run standalone-parity:check`, `npm run parity:check`,
   `npm run standalone-fork:check` — unchanged, regression check.
5. Behavioural: boot the standalone host against a temp workspace, stage a card
   via the queue path, and assert `kanban.queueWatches` is non-empty. This is the
   assertion that distinguishes a real fix from wiring that resolves but arms
   nothing — Layer 2. Do not accept source-text assertions alone for this step.

**Gate wiring:** `test:contract:queue-pipeline` is invoked at
`.github/workflows/integration-tests.yml:920`. The new `host-seam-parity:check`
needs both a `package.json` script and a workflow step.

### Manual

6. Standalone host, lead-paced team: stage cards, let the lead go idle past
   `nudgeSilenceMs`. Confirm exactly one nudge reaches the lead — this has never
   fired in standalone.
7. Standalone host, seat-paced team: confirm `resolveTeamPacing` returns `'seat'`
   and the seat-pacing branch is entered (it is currently unreachable).
8. Standalone host: dispatch a card, kill the holding terminal. Confirm the
   operator notice fires and the card is re-staged — the escalation recorder path
   end to end, including the lazy `server` resolution.
9. Extension host: repeat 6–8 and confirm nothing changed.

## Recommendation

Send to Coder. The diff is modest but it spans two composition roots, a new CI
gate, and one lazy-capture hazard whose failure mode is silence — and the most
likely wrong outcome (seams wired, nothing armed) presents as a complete,
fully-green change.
