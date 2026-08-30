# A deferred seat is curtained for a clear that never runs, and the head is never excluded from the roster clear

## Goal

Stop the "Preparing for dispatch…" curtain covering a seat that is not being cleared, and stop the team head being a candidate for the roster clear at all. Today a busy lead is curtained for an operation it was explicitly excluded from, and an idle lead is genuinely cleared mid-feature — its context reset while it is managing a run.

### The problem, as observed

The operator reports the curtain appearing on the team lead's pane during a feature run, and — decisively — **no devin startup text when it lifts**. A curtain exists to cover a context reset; if no reset happened, the curtain covered nothing.

That observation is exactly right, and it identifies which branch fired.

### Root cause 1 — deferred seats are curtained, and told the wrong phase

`computeRosterClearTargets` (`workContextResolver.ts:231`) splits the roster three ways: skip, `toClear`, and `deferred` for a busy seat. A lead mid-feature is busy, so it lands in **`deferred` — it is never cleared.**

The deferred branch (`TaskViewerProvider.ts:851-878`) then arms a curtain for it anyway:

```js
const prepMsg = { type: 'terminalDispatchPreparing', operationId: deferOpId,
                  terminalName: name, phase: 'clearing', … };
```

and immediately follows with `terminalDispatchFinished` carrying `reason: 'deferred'`. So the pane is covered and uncovered back-to-back for an operation that did nothing — which is precisely "the curtain appears, then lifts with no startup text".

The arming message also hardcodes `phase: 'clearing'` for the one case that is definitionally *not* clearing. The block's own comment states the intent — *"so the pane shows 'deferred' rather than a silent success"* — but the phase it sends says the opposite.

### Root cause 2 — the head is not excluded from the clear set

`computeRosterClearTargets` excludes exactly three things:

```js
if (!liveActive.has(name)) continue;
if (name === destination) continue;
if (originName && name === originName) continue;
```

The destination, the origin, and (via `busySet`) busy seats. **There is no head exclusion.** A lead avoids being cleared only by happening to be busy.

The origin guard is not a substitute. `originName` comes from `payload.origin`, a caller-supplied field, and the function's own docblock notes it is used "only to REMOVE a name from the target set". A machine dispatch that omits it leaves the guard inert. So an **idle** lead — between subtasks, waiting on a callback — is live, not the destination, not busy, and its origin may be unset: it lands in `toClear` and is genuinely cleared, losing the context it needs to manage the feature.

This is the more serious half. The curtain is cosmetic; a cleared lead mid-run is lost state.

### Root cause 3 — the retry re-fires on every dispatch

Immediately below (`:885`):

```js
if (toClear.length > 0 || deferred.length === 0) {
    this._lastWorkContextByTeam.set(teamId, workContextKey);
}
```

When every active member is busy — `toClear` empty, `deferred` non-empty — the work-context key is deliberately left unrecorded so the next dispatch can try again. That is reasonable in isolation. With a lead that is *permanently* busy managing a feature, the barrier never records, so **every subsequent dispatch re-runs the whole preparation and re-arms the deferred curtain**. The flicker the operator sees as "random" is this retry firing per dispatch.

## Metadata

- **Tags:** bugfix, frontend, backend, reliability, ux
- **Complexity:** 4

## User Review Required

None. Three decisions are made here:

1. **A deferred seat gets no curtain.** The curtain's whole purpose is to hide a context reset. No reset, no curtain. This is simpler and more honest than sending a `deferred` phase and teaching the pane a third look. Note: this removes BOTH the `terminalDispatchPreparing` and the `terminalDispatchFinished` messages for deferred seats — the pane receives no terminal-level signal at all. The deferred set is still recorded internally (`_deferredClearsByTeam` / `deferredClearsByTeam`) so the same-feature intercept continues to work. An operator who previously could see a "deferred" flash on a pane loses that visual signal; this is a deliberate trade-off — a misleading curtain for nothing is worse than no signal.
2. **The head is excluded structurally, not incidentally.** `computeRosterClearTargets` gains an explicit head exclusion, so a lead is safe whether or not it is busy and whether or not the caller supplied an origin. This means the head is NEVER automatically cleared by the roster barrier — including when a new feature starts (new work-context key). The head's context persists across feature boundaries. This is deliberate: the head is the orchestration thread, and clearing it means a re-auth toll (per `devin-clear-reauth-toll-visibility`) and lost orchestration state. An operator who needs a clean head between features must clear it explicitly.
3. **The retry keeps its semantics.** Root cause 3 stops being visible once deferred seats are not curtained, so the barrier logic is left alone rather than changed to suppress a symptom. The retry still re-runs preparation on every dispatch when all members are busy — this is wasted work (a `ptyListTerminals` + set rebuild per dispatch), but fixing it would require recording the work-context key when no clear happened, which changes the barrier's re-fire semantics. The cost of the fix exceeds the cost of the waste.

## Complexity Audit

### Routine

- Removing the arm/finish pair from the deferred branch (deleting a self-contained `if` block in each root).
- Adding a `head?: string` field to `RosterClearTargetInput` and a `headName` guard in `computeRosterClearTargets` — one interface field, one `continue` line.
- Passing `head: teamInfo.head` at the two call sites (one line each).

### Complex / Risky

- **`computeRosterClearTargets` is a shared pure helper** — its docblock states both hosts must "produce byte-identical target sets for identical inputs". The signature change must land in both roots together, and its existing tests pin the current behaviour.
- **Identifying the head.** The roster comes from `resolveTeamGroupForTerminal`, described as "the sole roster source"; the head must be read from the same group record rather than inferred from role, since a team can seat several leads and only one is the head. `ResolvedTeamGroup.head` is `head?: string` — it is `undefined` for legacy rows written before `head` was stamped. The helper must treat absent `head` as a no-op exclusion (today's behaviour), not as "clear nothing".
- **Source-level test coverage for the new seam.** The `head:` parameter is optional. If a future refactor drops the `head: teamInfo.head` line from one root, the head exclusion silently vanishes and the bug returns. Source-level tests must pin `head:` being passed in both roots, the same way `origin: payload.origin` is pinned. Without this, one merge conflict re-introduces the exact bug being fixed.

## Edge-Case & Dependency Audit

- **A head that is also the destination** is already excluded by the destination check; the new exclusion is additive, not a replacement.
- **A head that is also the origin** is already excluded by the origin check; additive exclusion is harmless.
- **A team with no head** (or an unresolvable one — `teamInfo.head === undefined`) must fall through to today's behaviour rather than clearing nothing. The helper guards on `headName && name === headName`, so an absent head is a no-op.
- **An operator-initiated clear of a lead** must still work. This plan removes the head from the *automatic roster* clear only — never from an explicit request.
- **`roster-clear-mid-turn-deferral.test.js`** exists untracked in the working tree (`git status` confirms `??`), which suggests active work on this exact deferral path. Check it before editing, and reconcile rather than duplicating. The existing behavioural tests use `'head'` as a roster member name WITHOUT passing `head: 'head'` — after the fix, those tests still pass because `head` is optional and absent head means no exclusion. New tests are needed (see Verification Plan).
- **Both hosts.** The curtain broadcast has sites in `bootstrap.ts` (`:419`, `:1984`, `:2028`) and `TaskViewerProvider.ts` (`:802`, `:859`, `:3598`). The deferred curtain blocks to delete are `TaskViewerProvider.ts:851-879` and `bootstrap.ts:2018-2042`. The `toClear` curtain blocks (`TaskViewerProvider.ts:788-847`, `bootstrap.ts:1974-2014`) and the delivery-path curtain sites stay.
- **Deferred set recording survives.** The `_deferredClearsByTeam` / `deferredClearsByTeam` recording (`TaskViewerProvider.ts:783-787`, `bootstrap.ts:1969-1973`) happens BEFORE the deferred curtain block and is NOT deleted. The same-feature branch intercept depends on it.

## Dependencies

- **Related:** `one-coder-callback-delivers-four-prompts-to-the-lead…`. That plan cuts the dispatch rate at the lead, which reduces how often this curtain re-arms. Neither blocks the other; both are worth landing.
- **Related:** `devin-clear-reauth-toll-visibility` (CREATED). It documents that clearing a seat restarts its CLI session and re-triggers MCP OAuth. That is the concrete cost of root cause 2 — an accidentally cleared lead does not merely lose context, it pays a re-auth. It is also the cost of deliberately NOT clearing the head between features (decision 2) — the head avoids the re-auth toll at the price of carrying stale context.

## Adversarial Synthesis

Key risks: (1) Excluding the head from all automatic clears leaves stale context across feature boundaries — mitigated by keeping explicit operator clears and by the head's role as the persistent orchestration thread (re-auth toll makes automatic clearing worse). (2) The optional `head` parameter can silently disappear from one root in a future refactor — mitigated by source-level tests pinning `head:` in both roots. (3) Removing the deferred finish message loses the operator's visual "deferred" signal — mitigated by the internal deferred set recording surviving for the same-feature intercept, and by the misleading curtain being worse than no signal.

## Proposed Changes

### `src/services/workContextResolver.ts`

**Interface change** — `RosterClearTargetInput` (lines 188-194): add `head?: string` field.

```ts
export interface RosterClearTargetInput {
    roster: string[];
    liveActive: Set<string>;
    destination: string;
    origin?: string;
    head?: string;       // NEW — team head, excluded from both toClear and deferred
    busySet: Set<string>;
}
```

**Exclusion logic** — `computeRosterClearTargets` (lines 231-249): add head exclusion after the origin guard (line 240) and before the busySet check (line 241).

```ts
export function computeRosterClearTargets(input: RosterClearTargetInput): RosterClearTargetResult {
    const { roster, liveActive, destination, origin, head, busySet } = input;
    const toClear: string[] = [];
    const deferred: string[] = [];
    const originName = (typeof origin === 'string' && origin.trim()) ? origin.trim() : '';
    const headName = (typeof head === 'string' && head.trim()) ? head.trim() : '';

    for (const name of roster) {
        if (!liveActive.has(name)) continue;
        if (name === destination) continue;
        if (originName && name === originName) continue;
        if (headName && name === headName) continue;   // NEW — head is never cleared or deferred
        if (busySet.has(name)) {
            deferred.push(name);
        } else {
            toClear.push(name);
        }
    }

    return { toClear, deferred };
}
```

**Docblock update** — the exclusion rules list (lines 218-229): add rule 4 (head exclusion), renumber busy to 5, clear to 6. Document that `head` is host-supplied from `resolveTeamGroupForTerminal`'s `ResolvedTeamGroup.head`, that it is optional (absent head = no exclusion = today's behaviour), and that the origin guard is not a substitute because `origin` is caller-supplied and routinely absent on machine dispatches.

### `src/services/TaskViewerProvider.ts`

**Pass head to the helper** — the `computeRosterClearTargets` call (lines 775-781): add `head: teamInfo.head` to the input object.

```ts
const { toClear, deferred } = computeRosterClearTargets({
    roster,
    liveActive: liveActiveNames,
    destination: payload.name,
    origin: payload.origin,
    head: teamInfo.head,           // NEW
    busySet,
});
```

**Delete the deferred curtain block** — lines 851-879: remove the entire `if (deferred.length > 0)` block that sends `terminalDispatchPreparing` and `terminalDispatchFinished` for deferred seats. This removes BOTH messages — the pane receives no terminal-level signal for deferred seats.

**Keep the deferred set recording** — lines 783-787: this block (`if (deferred.length > 0) { … deferredSet.add(name) … }`) stays. The same-feature branch intercept depends on it.

**Keep the toClear curtain block** — lines 788-847: the normal clear path with its curtain stays unchanged.

**Keep the work-context key guard** — lines 885-887: the `if (toClear.length > 0 || deferred.length === 0)` guard stays (decision 3).

### `src/standalone/bootstrap.ts`

**Pass head to the helper** — the `computeRosterClearTargets` call (lines 1961-1967): add `head: teamInfo.head` to the input object.

```ts
const { toClear, deferred } = computeRosterClearTargets({
    roster,
    liveActive: activeNames,
    destination: payload.name,
    origin: payload.origin,
    head: teamInfo.head,           // NEW
    busySet,
});
```

**Delete the deferred curtain block** — lines 2018-2042: remove the entire `if (deferred.length > 0)` block that broadcasts `terminalDispatchPreparing` and `terminalDispatchFinished` for deferred seats.

**Keep the deferred set recording** — lines 1969-1973: stays for the same-feature intercept.

**Keep the toClear curtain block** — lines 1974-2014: the normal clear path stays unchanged.

**Keep the work-context key guard** — lines 2048-2050: stays (decision 3).

### `src/test/roster-clear-mid-turn-deferral.test.js`

**New behavioural tests** (add to section 1):
- `head exclusion: head passed → head absent from toClear and deferred` — roster includes head, `head: 'head'` passed, assert head not in either set.
- `head is busy and head passed → head absent from deferred (not deferred)` — head in busySet AND `head: 'head'` passed, assert head not in deferred (exclusion takes priority over busy).
- `head absent → no head exclusion (today's behaviour)` — no `head` field passed, assert head still appears in toClear when at rest (existing tests already cover this; add an explicit named test).
- `head is also the destination → already excluded, no issue` — `head` equals `destination`, assert no error, head absent from both sets.

**New source-level tests** (add to section 3 or a new section):
- `TaskViewerProvider.ts passes teamInfo.head to the helper` — assert `/head:\s*teamInfo\.head/.test(barrierSrc)`.
- `bootstrap.ts passes teamInfo.head to the helper` — same assertion against the bootstrap barrier slice.
- `workContextResolver.ts RosterClearTargetInput has head field` — assert `/head\?:\s*string/.test(WCR_SRC)`.
- `workContextResolver.ts excludes head in computeRosterClearTargets` — assert the head guard exists in the function body.

**Existing tests**: the behavioural tests that use `'head'` as a roster member without passing `head: 'head'` (lines 71-231) still pass — `head` is optional, absent head means no exclusion. No changes needed to those tests.

## Files Changed

- `src/services/workContextResolver.ts` — `head?: string` field on `RosterClearTargetInput`, head exclusion in `computeRosterClearTargets`, docblock update
- `src/services/TaskViewerProvider.ts` — pass `head: teamInfo.head` to helper, delete deferred curtain block (lines 851-879)
- `src/standalone/bootstrap.ts` — pass `head: teamInfo.head` to helper, delete deferred curtain block (lines 2018-2042)
- `src/test/roster-clear-mid-turn-deferral.test.js` — new behavioural tests for head exclusion, new source-level tests for `head:` threading in both roots

## Verification Plan

### Automated Tests

1. **A busy lead gets no curtain.** Dispatch to a coder while the lead is mid-turn; assert no `terminalDispatchPreparing` names the lead.
2. **An idle lead is never cleared.** Dispatch to a coder with the lead idle and no `origin` supplied; assert the lead is absent from `toClear` and its context survives.
3. **Coders still clear and still curtain.** The normal path is unchanged — assert a cleared coder gets both the clear and the curtain.
4. **Host parity.** Assert `computeRosterClearTargets` returns byte-identical sets for identical inputs across both roots, with the head present.
5. **An explicit operator clear of the lead still works.**
6. **Reproduce the original.** Run a full feature and assert the lead's pane is never covered, and that no devin banner appears in its log mid-run.
7. **Deferred set recording survives.** Assert `_deferredClearsByTeam` / `deferredClearsByTeam` is still populated for deferred seats after the curtain block is deleted (the same-feature intercept depends on it).
8. **Head exclusion behavioural tests.** Assert head passed → excluded from both `toClear` and `deferred`; head busy → excluded from `deferred`; head absent → no exclusion.
9. **Source-level: `head:` threaded in both roots.** Assert `head: teamInfo.head` appears in the barrier block of both `TaskViewerProvider.ts` and `bootstrap.ts`.

### Goal Invariants

- **Assert `head` is absent from `toClear`** when `computeRosterClearTargets` is called with `head: 'lead'` and `'lead'` is in the roster, live, not the destination, not the origin, and not busy.
- **Assert `head` is absent from `deferred`** when `computeRosterClearTargets` is called with `head: 'lead'` and `'lead'` is in the roster, live, not the destination, not the origin, and IN the busySet.
- **Assert no `terminalDispatchPreparing` message is sent for a deferred seat** in the `TaskViewerProvider.ts` barrier block (source-level: the deferred `terminalDispatchPreparing` block is absent from the barrier slice).
- **Assert no `terminalDispatchPreparing` message is sent for a deferred seat** in the `bootstrap.ts` barrier block (source-level: same).
- **Assert `terminalDispatchPreparing` IS still sent for `toClear` seats** in both roots (the normal clear path is preserved — paired positive).
- **Assert non-head roster members still appear in `toClear`** when at rest, not the destination, not the origin (paired positive — the exclusion is scoped to the head only).
- **Assert `RosterClearTargetInput` has a `head?: string` field** in `src/services/workContextResolver.ts`.
- **Assert `head: teamInfo.head` is passed** in the `computeRosterClearTargets` call inside the barrier block of both `TaskViewerProvider.ts` and `bootstrap.ts`.

---

## Implementation Summary

Implemented in full across both composition roots. `workContextResolver.ts` gained an optional `head?: string` field on `RosterClearTargetInput` and a `headName` exclusion guard in `computeRosterClearTargets` (after the origin guard, before the busySet check), with the docblock's exclusion rules renumbered to six and a security note that `head` is host-supplied from `ResolvedTeamGroup.head`. Both `TaskViewerProvider.ts` and `bootstrap.ts` now pass `head: teamInfo.head` to the helper and have their deferred-seat curtain blocks deleted entirely (both the `terminalDispatchPreparing` arm and the `terminalDispatchFinished` finish) — a deferred seat now receives no terminal-level signal at all. The deferred-set recording, the toClear curtain, and the work-context key guard all stay in both roots. The existing source-level tests that asserted `reason: 'deferred'` was present in the barrier were reconciled into absence assertions (the deferred-set recording loop reuses `for (const name of deferred)` but carries no `reason:` literal, so the `reason: 'deferred'` absence pin is precise and unique), and new behavioural head-exclusion tests plus source-level `head:`-threading tests were added for both roots. Per dispatch directives, compilation and automated tests were not executed this run.

## Review Findings

Second independent review pass over the committed change (5bd5c70f); the goal is achieved and there are no CRITICAL findings. The inbound field-existence check was re-run from the writer: `head` is present in the persisted `terminals.groups` object literal on both the create and the merge branch (`teamWiring.ts:1571`, `:1602`) and on rename (`:2478`), and `teamHeadName` is strict with no `order[0]` fallback, so `teamInfo.head` is a real persisted value rather than a type-level claim. One MAJOR was found and fixed: the `RosterClearTargetInput has head field` gate tested `/head\?:\s*string/` against the WHOLE of `workContextResolver.ts`, and `ResolvedTeamGroup` declares the identical `head?: string` at line 22 — a negative control confirmed the gate stayed green after deleting the field from `RosterClearTargetInput`, so it now slices the interface body and fails on that deletion. Files changed by this pass: `src/test/roster-clear-mid-turn-deferral.test.js`. Verification: `test:contract:roster-clear-mid-turn` 56/56 (gate wired into CI at `.github/workflows/integration-tests.yml:1304`, after the `Compile test outputs` step at `:28`, so the behavioural half really runs), plus `dispatch-curtain`, `host-auto-clear`, `terminal-rest-clear`, `standalone-parity:check` and `host-seam-parity:check` (9/9 seams, 0 asymmetries) all pass; `compile-tests` reports 7 errors, all pre-existing and none in the changed regions.

## Deferred Findings

- MAJOR — Decision 2's claim that "the head's context persists across feature boundaries" is false on the most common path. The head exclusion is scoped to the roster barrier only; when a dispatch *targets* the head on a new work-context key, the delivery path still sets `clearBeforePrompt: true` unconditionally (`src/services/TaskViewerProvider.ts:884`, `src/standalone/bootstrap.ts:2216`), so a new feature dispatched to the lead clears the lead and pays the re-auth toll. The implementation matches the plan's Proposed Changes exactly — this is the plan's stated decision overreaching its own scope, not a coding defect. Not fixed: suppressing the destination clear is a destination change the plan reserves to the author, and the delivery-path clear is deliberately load-bearing ("the destination clears itself through the delivery path, WITH readiness").
- MAJOR — A stale deferred-set entry can cause a redundant clear in a configuration the fix makes more reachable. `src/services/TaskViewerProvider.ts:798` / `src/standalone/bootstrap.ts:2148`. With the head no longer filling `toClear`, a three-seat team (idle lead + one busy coder) leaves `toClear` empty and `deferred` non-empty, so the work-context key is not recorded and the barrier re-fires on the next dispatch; a seat cleared by that re-run is never removed from the deferred set, so the same-feature intercept clears it a second time at its next delivery. Pre-existing hazard of the retry semantics, but decision 3's rationale ("root cause 3 stops being visible") holds only for the two-seat case. Not fixed: the plan explicitly reserved the barrier's re-fire semantics to the author.
- NIT — Legacy `terminals.groups` rows resolve `teamInfo.head === undefined`, so the head exclusion is inert and root cause 2 persists for them. Two writers stamp `teamGroup: true` onto pre-existing rows without adding `head` (`src/services/teamWiring.ts:397`, `src/webview/terminals.js:2140`/`:2263`), so such rows are reachable. The plan explicitly chose absent-head = no-op; the `team_<encoded name>` id derivation `resolveTeamGroupForTerminal` already performs at `src/services/workContextResolver.ts:132` would close it, but that changes the shared roster source beyond the plan's Proposed Changes.
- NIT — `headName` is trimmed before comparison while roster names are not (`src/services/workContextResolver.ts:256`), so a head persisted with surrounding whitespace would fail to match. Consistent with the existing `originName` handling and not introduced by this change.
