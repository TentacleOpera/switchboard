# A Drag onto the Collapsed Coder Column Is Refused in the Browser, and the Card Bounces Back

## Goal

Make a drag onto the collapsed coder bucket move the card in the standalone host, the way it already
does in the extension. Today the standalone `triggerAction` arm refuses the whole verb when CLI
triggers are off, so the card moves in the DOM, never persists, and snaps back on the next repaint.
The gate belongs on the **dispatch**, not on the **move**.

### Problem analysis

**Reproduced against the live standalone host, 2026-09-08**, on a card the operator reported as
"stubbornly refuses to move out of Created" (`9c5ecd3c`, *Three Clear-Path Defects…*):

```
POST /kanban/verb/triggerAction  {sessionId: 9c5ecd3c…, targetColumn: "CODED_AUTO"}
→ {"success":false,"error":"CLI triggers are disabled"}
→ kanban_column = CREATED at t=1s, 3s, 8s. column_entered_at unchanged.
```

**Nothing on the server ever moves the card back.** An earlier control test on the same card —
`moveCardForward` to `PLAN REVIEWED` — persisted and held across five polls over 47s, and the DB, the
single-plan read and the 508-card board payload all agreed on the new column. The bounce is not a
clobber, not the plan-file watcher, and not project scoping (the card carries `projectId 11`, matching
the active filter). It is a write that never happens.

#### Why this path and not the ordinary one

`kanban.collapseCodersEnabled` is `true`, so the coder columns render as the synthetic `CODED_AUTO`
bucket. `handleDrop` branches on that **before** anything else:

- `kanban.html:10849` — `if (targetColumn === 'CODED_AUTO') { … }`
- `kanban.html:10917` — `const forwardIds = []` (never reached for this target)

Inside the branch, a single-card drop posts `triggerAction` and a multi-card drop
`triggerBatchAction`, both with `targetColumn: 'CODED_AUTO'`. So this drag never becomes
`moveCardForward`/`moveCardBackwards` — a completely different verb from every other column's drop.

**The branch is direction-blind by construction.** It runs before `forwardIds`/`backwardIds` exist, and
its only filter is `!CODED_IDS.includes(card.column)` where
`CODED_IDS = ['LEAD CODED','CODER CODED','INTERN CODED']` (`kanban.html:6394`). A `CODE REVIEWED` card
is not in that list, so a **backward** drag from `CODE REVIEWED` into the collapsed bucket is posted
as `triggerAction` exactly like a forward one — and refused identically. Reported independently by the
operator and explained by the same two lines.

#### Root cause — the gate is in the wrong place, in one host only

**Extension (correct).** A `CODED_AUTO` target takes an early branch to `_advanceCards` and **returns
before the CLI-triggers gate** (`KanbanProvider.ts:10604` and `:10872`; the gate sits after, at
`:10612` / `:10874`, reached only for other targets). `_advanceCards` classifies direction, moves, and
dispatches only when enabled.

**Standalone (broken).** `bootstrap.ts:2830` is a hand-written `triggerAction` case that tests the gate
**first, unconditionally**:

```ts
const cliTriggersEnabled = kanbanProvider._getScopedSetting<boolean>('kanban.cliTriggersEnabled', true);
if (!cliTriggersEnabled && !payload?.bypassTriggerGate) {
    return { success: false, error: 'CLI triggers are disabled' };
}
```

Counts that make the divergence unambiguous:

| | `_advanceCards` refs | `CODED_AUTO` in the `triggerAction` arm |
| :--- | :--- | :--- |
| `KanbanProvider.ts` | 8 | early branch, before the gate |
| `bootstrap.ts` | **0** | **none** |

This is one of the 18 hand-written explicit cases `standalone-kanban-column-parity-audit` named on its
Axis 1 — *"each hand-written case is a partial reimplementation of a much larger provider arm"*. That
audit is COMPLETED and its fix set did land; this arm was not in it.

#### The false comment that hid it

The drop site carries this, immediately above the `postKanbanMessage` calls:

> `// _advanceCards handles the CLI-triggers gate internally (moves always, dispatches only when enabled).`

True of the extension. False of the standalone host, which is the host the browser board talks to.
A reader checking "is a plain move possible here?" reads that comment and stops. **Correct or delete
it as part of this fix** — a comment that is accurate for one composition root and wrong for the other
is how this survived.

#### There is currently no way to get a plain move here

Worth stating because it is not a rounding error in the bug:

- CLI triggers **off** → the card cannot move to a coder column at all (this bug).
- CLI triggers **on** → the same drag moves *and dispatches*.

Neither is "move a card into Coded without advancing it", which is the operator's stated intent and
what the extension's `_advanceCards` already provides.

## Metadata

**Complexity:** 4
**Tags:** standalone-parity, kanban, dispatch, bugfix
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. Route standalone's `CODED_AUTO` through the shared advance path (`src/standalone/bootstrap.ts:2830`)

- **Logic:** Before the CLI-triggers gate, branch on `targetColumn === 'CODED_AUTO'` and delegate to
  the provider's advance path, passing `bypassTriggerGate` through unchanged — mirroring
  `KanbanProvider.ts:10604`. The gate then applies to the dispatch, not to the move.
- **Implementation:** Prefer deleting the hand-written arm and letting the `default:` fallthrough reach
  `kanbanProvider.handleServiceVerb('triggerAction', …)` over adding a second branch. A second
  reimplementation that can disagree with the first is what produced this defect. If the arm must stay
  (it carries standalone-only PTY concerns), move the gate below the `CODED_AUTO` branch and add a
  comment naming `KanbanProvider.ts:10604` as the shape it mirrors.
- **Edge cases:** `bypassTriggerGate: true` (from `POST /kanban/dispatch`) must keep dispatching — the
  gate exists to stop *accidental drags*, not manager commands. A card already in a coder column is
  filtered client-side; the server must not assume that filter ran.

### 2. Same treatment for `triggerBatchAction` (multi-card drop)

- **Logic:** The multi-select drop posts `triggerBatchAction` with the same `CODED_AUTO` target and is
  refused by the same gate — confirmed live: `{"success":false,"error":"CLI triggers are disabled"}`.
  Whatever change lands for `triggerAction` must land here, or a single-card drag works and a two-card
  drag silently does not.

### 3. Correct or delete the false drop-site comment (`src/webview/kanban.html`, above `:10909`)

- **Logic:** It asserts host behaviour that is only true of one host. Either state the invariant the
  fix establishes (both hosts move, both gate the dispatch) or remove the claim.

### 4. A backward drag must not be a dispatch

- **Logic:** The `CODED_AUTO` branch runs before direction is known, so `CODE REVIEWED → CODED` is sent
  as `triggerAction`. Confirm the server-side advance path classifies direction and does **not**
  dispatch on a backward move; if it dispatches on direction-unknown, classify client-side before
  posting, or pass the source column so the server can.
- **Edge cases:** A backward move out of `CODE REVIEWED` must not re-fire a coder prompt or re-stamp
  `dispatched_at`.

### 5. A test that fails on this exact drag

- **Logic:** With `cliTriggersEnabled: false`, `triggerAction`/`triggerBatchAction` at `CODED_AUTO`
  **moves** the card and does **not** dispatch, in *both* hosts. The existing suites pass today with
  the card refused, because nothing asserts the move half.
- **Rationale:** Verb-reachability gates go green here — the verb is reachable, answers, and returns a
  plausible `{success:false}` error. Only an assertion on the persisted column catches it.

## Verification Plan

### Automated Tests
- `cliTriggersEnabled: false` + `CODED_AUTO` → column changes, no dispatch. Both hosts.
- `cliTriggersEnabled: true` + `CODED_AUTO` → column changes **and** dispatches. Both hosts.
- `bypassTriggerGate: true` dispatches regardless of the setting.
- Backward `CODE REVIEWED → CODED_AUTO` moves without dispatching.
- A composition-root diff test asserting the two `triggerAction` implementations agree on gate
  placement.

### Goal Invariants
- A drag onto the collapsed coder bucket persists, with CLI triggers on or off.
- The CLI-triggers setting gates dispatch only — never a column move.
- The two hosts answer `triggerAction` identically for the same payload.

### Manual
- Collapse coders, CLI triggers off, drag a `CREATED` card onto Coded → it stays there after a refresh.
- Drag a `CODE REVIEWED` card back into Coded → it stays, and no coder prompt fires.
- Repeat both in the extension host and confirm no behaviour changed there.

## Outstanding Questions

- None.
