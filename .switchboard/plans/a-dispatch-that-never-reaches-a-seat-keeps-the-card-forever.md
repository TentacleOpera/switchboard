# A Dispatch That Never Reaches a Seat Keeps the Card Forever

## Goal

Every path that TAKES the owner stamp gives it back. A dispatch whose delivery fails
releases the card it claimed, and a backward move releases it too — so the only cards
carrying an owner are cards a seat is actually holding.

## Problem analysis

**The release system already exists and is correct.** `clearOwnerStamp(planFile,
workspaceId)` (`KanbanDatabase.ts:15107`) wipes `owner_seat` **and** `owner_since`,
bumps `updated_at` — deliberately, because `getBoardWorkingSet`'s hot-set window and
`dbMerge`'s last-writer-wins both key on it — and is called from the turn-end paths:

- `PlanIngestionEngine.ts:2884`
- `LocalApiServer.ts:6823`
- `KanbanProvider.ts:11727`

Card is dispatched, seat works it, seat stops, stamp clears. On the normal path the
stamp is gone long before anything can read it stale. **This plan does not change
that design, the field, or hop pacing.**

**The gap is the abort side.** The stamp is taken when the dispatch is recorded
(`KanbanDatabase.ts:14817`, `:14928`). When delivery then fails,
`recordDeliveryFailure` (`LocalApiServer.ts:3669`) appends a `plan_events` row and
**returns without releasing**. Every release is driven by a seat FINISHING, so a
dispatch that never reached a seat has nothing coming that will ever clear it.

Two callers hit it:

```ts
await recordDeliveryFailure(String(result.error || 'delivery failed'));                   // :3695
await recordDeliveryFailure('delivery completed but no dispatch was recorded — the
    prompt may have been copied to the clipboard instead of a live seat');               // :3705
```

The second is the common one: no live seat, so the prompt went to the clipboard. The
card is stamped as held by a seat that never received it.

**A backward move leaves it too.** `_columnMoveDispatchClearSql` nulls `owner_since`
on every move and leaves `owner_seat` **on purpose** — hop pacing needs it to survive
a forward advance, so a seat still mid-turn on a just-advanced card is not read as
free. That reasoning does not extend to a card sent BACKWARD: a card returned to
Planned is not "handed to" anyone.

**Observed 2026-09-19.** A feature failed to dispatch and was moved back to Planned.
Its `owner_seat` still read `Feature-coder-1` from the failed attempt, and the next
dispatch used that stale seat as the team-scoped origin:

```
teamRouting: "team-scoped: no lead on Feature-coder-1's team — fell back to
              workspace-wide"
```

It recovered, because one team was live and the workspace-wide fallback found the
same lead. **With two implementation teams live it would not** — the stamp names a
team the card no longer belongs to, a real lead resolves on the wrong team, and
nothing reports it, because `teamRouting` only speaks when resolution MISSES.

## Metadata

**Complexity:** 3
**Tags:** dispatch, routing, lifecycle, standalone
**Scope:** `LocalApiServer.recordDeliveryFailure`, the backward-move arm, and the
`teamRouting` report. **Standalone only** — the VS Code extension is being reduced to
a launcher sidebar and is not a target.

## Constraints

**No sessionId.** Deprecated months ago; `clearOwnerStamp` is already keyed on
`planFile` + `workspaceId` and nothing here introduces a session key.

**Hop pacing is untouched.** Its reader, and its deliberate non-gating on
`owner_since`, are correct and stay exactly as they are. A card a seat is genuinely
mid-turn on must still read as busy after a forward advance.

## Proposed changes

### 1. A failed delivery releases the stamp it took

`recordDeliveryFailure` calls `clearOwnerStamp` before it returns. The dispatch
claimed the card; delivery failed; the claim goes back. Both call sites get it because
it lives in the shared helper, not at either one.

Guard it on the stamp this dispatch took — if a seat legitimately picked the card up
in between, do not strip that.

### 2. A backward move releases it

Extend the clear to `owner_seat` when the move is backward. The forward case is
unchanged, which is what hop pacing depends on.

`_advanceCards` already classifies direction per card ("a straggler from a later
column no longer records 'forward'"), so the signal exists and does not need
inventing.

### 3. `teamRouting` reports the origin it USED

Today it speaks only on a miss. It must also name the origin on a successful
team-scoped resolution, so a dispatch that resolved against a stale premise is
visible instead of silent. That is "which store answered?" applied to routing, and it
is what would have made this diagnosable in one read rather than four hours.

## Verification plan

### Automated

- A dispatch whose delivery fails leaves `owner_seat` empty — asserted on both call
  sites, including the no-live-seat/clipboard path, which is the common one.
- A card moved BACKWARD has no owner stamp afterwards.
- A card moved FORWARD keeps `owner_seat` and loses `owner_since` — unchanged, and
  asserted so this plan cannot quietly break pacing.
- **Hop pacing still pauses for a seat mid-turn on a just-advanced card** (stamp
  present, `owner_since` NULL, no completion). This is the predicate a previous fix
  established and it must survive.
- `teamRouting` names the origin on a SUCCESSFUL team-scoped resolution, not only on
  a miss.
- With two implementation teams live and a card carrying no stale stamp, a dispatch
  reaches the right team.

### Goal invariants

- Every path that takes the stamp gives it back — completion, failure, or reversal.
- A card carries an owner only while a seat is holding it.
- A routing decision can say which origin it used and how it knew.
- Hop pacing's concurrent-write protection is unchanged.

### Manual

Dispatch a plan with no live seat (it goes to the clipboard), then check the card
carries no owner. Dispatch a feature, let it fail, move it back to Planned, start a
second implementation team, dispatch again — it reaches the right team, and
`teamRouting` says which origin it used.

## Outstanding questions

None. An earlier draft of this card proposed splitting `owner_seat` into two fields
and rewriting both readers. That was an over-diagnosis: the lifecycle is implemented
and correct, and the defect is a missing release on the abort path. Recorded here so
the larger change is not revived by someone reading only the symptom.
