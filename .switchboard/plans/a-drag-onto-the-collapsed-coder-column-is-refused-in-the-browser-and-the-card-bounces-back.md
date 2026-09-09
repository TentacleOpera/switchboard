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

- `kanban.html:10955` — `if (targetColumn === 'CODED_AUTO') { … }`
- `kanban.html:11023` — `const forwardIds = []` (never reached for this target)

Inside the branch, a single-card drop posts `triggerAction` and a multi-card drop
`triggerBatchAction`, both with `targetColumn: 'CODED_AUTO'`. So this drag never becomes
`moveCardForward`/`moveCardBackwards` — a completely different verb from every other column's drop.

**The branch is direction-blind by construction.** It runs before `forwardIds`/`backwardIds` exist, and
its only filter is `!CODED_IDS.includes(card.column)` where
`CODED_IDS = ['LEAD CODED','CODER CODED','INTERN CODED']` (`kanban.html:6449`). A `CODE REVIEWED` card
is not in that list, so a **backward** drag from `CODE REVIEWED` into the collapsed bucket is posted
as `triggerAction` exactly like a forward one — and refused identically. Reported independently by the
operator and explained by the same two lines.

#### Root cause — the gate is in the wrong place, in one host only

**Extension (correct).** A `CODED_AUTO` target takes an early branch to `_advanceCards` and **returns
before the CLI-triggers gate** (`KanbanProvider.ts:10727` and `:11007`; the gate sits after, at
`:10743` / `:11018`, reached only for other targets). `_advanceCards` classifies direction, moves, and
dispatches only when enabled.

**Standalone (broken).** `bootstrap.ts:2915` is a hand-written `triggerAction` case that tests the gate
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
**Tags:** bugfix, backend, ui

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a single `CODED_AUTO` early-branch delegation before an existing gate — mirrors a structure already present in the provider (`KanbanProvider.ts:10727`).
- Correcting a stale comment in the webview.
- Both hosts already share `_advanceCards` and the `switchboard.triggerAgentFromKanban` command registration; no new abstraction.

### Complex / Risky
- The hand-written `triggerAction` arm (`bootstrap.ts:2915`) treats `CODED_AUTO` as a **literal target column** (`const targetColumn = explicitTarget || null` at `:2958`). Moving the card to the synthetic `'CODED_AUTO'` string would persist a non-column into the DB and the card would vanish from the board. The fix MUST delegate to the provider's `_advanceCards` (which complexity-routes `CODED_AUTO` to a real coder column), not merely relocate the gate.
- Re-entrancy: the delegation flows `handlePtyVerb('triggerAction')` → `kanbanProvider.handleServiceVerb('triggerAction')` → `_advanceCards` → `switchboard.triggerAgentFromKanban` → `handlePtyVerb('triggerAction')`. The second call carries a resolved real coder column (not `CODED_AUTO`), so it does not re-enter the delegation branch. Verified by tracing the args: `_advanceCards` dispatches via `executeCommand('switchboard.triggerAgentFromKanban', dispatchRole, forwardSids[0], undefined, workspaceRoot, undefined)` — no `targetColumn` field, so `explicitTarget` is `undefined` on re-entry.

## Edge-Case & Dependency Audit

- **Race Conditions:** A concurrent board refresh scheduled during the dispatch await can update `_lastCards` with the new column. `_advanceCards` captures `card?.column` at move time (`KanbanProvider.ts:9407`) for direction classification; the provider's `triggerAction` arm captures `sourceColumnForPrompt` before `moveCardToColumn` mutates the DB (`:10759`). The delegation path inherits these guards.
- **Security:** `bypassTriggerGate: true` (from `POST /kanban/dispatch`) must keep dispatching — the gate exists to stop *accidental drags*, not manager commands. The delegation passes `bypassTriggerGate` through to `_advanceCards` (`KanbanProvider.ts:10732`), which honors it at `:9439`.
- **Side Effects:** A card already in a coder column is filtered client-side (`!CODED_IDS.includes(card.column)` at `kanban.html:11008`); the server must not assume that filter ran. `_advanceCards` re-checks via `moveCardToColumnWithReason` per card.
- **Dependencies & Conflicts:** `triggerBatchAction` (multi-card drop) is NOT broken — it has no explicit case in `handlePtyVerb` and falls through to `default:` → `kanbanProvider.handleServiceVerb('triggerBatchAction')` → the provider's `:10995` arm, which delegates `CODED_AUTO` to `_advanceCards` before its gate at `:11018`. No change needed there (see Superseded callout in Proposed Change 2).

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the hand-written arm treats `CODED_AUTO` as a literal column — a fix that only relocates the gate would persist a synthetic column and vanish the card; (2) re-entrancy through `switchboard.triggerAgentFromKanban` → `handlePtyVerb('triggerAction')` must not loop (verified: re-entry carries a real column, not `CODED_AUTO`); (3) Proposed Change 2's premise that `triggerBatchAction` is broken was false — it already routes through the provider. Mitigations: delegate `CODED_AUTO` to the provider's `_advanceCards` (complexity-routes to a real column), not a gate relocation; the batch path needs no change.

## Proposed Changes

### 1. Route standalone's `CODED_AUTO` through the shared advance path (`src/standalone/bootstrap.ts:2915`)

- **Logic:** Before the CLI-triggers gate, branch on `targetColumn === 'CODED_AUTO'` and delegate to
  the provider's advance path, passing `bypassTriggerGate` through unchanged — mirroring
  `KanbanProvider.ts:10727`. The gate then applies to the dispatch, not to the move.
- **Implementation:** Prefer deleting the hand-written arm and letting the `default:` fallthrough reach
  `kanbanProvider.handleServiceVerb('triggerAction', …)` over adding a second branch. A second
  reimplementation that can disagree with the first is what produced this defect. If the arm must stay
  (it carries standalone-only PTY concerns — terminal resolution, tmux delivery, roster barrier, batch
  capping), add a `CODED_AUTO` early-branch that delegates to `kanbanProvider.handleServiceVerb('triggerAction', { ...payload, workspaceRoot: root })` and returns its result, BEFORE the gate at `:2922`. Do NOT move the gate below a `CODED_AUTO` branch that continues in the hand-written arm — the arm has no complexity routing and treats `CODED_AUTO` as a literal column (`:2958`), which would persist a synthetic column into the DB. Add a comment naming `KanbanProvider.ts:10727` as the shape it mirrors.
- **Edge cases:** `bypassTriggerGate: true` (from `POST /kanban/dispatch`) must keep dispatching — the
  gate exists to stop *accidental drags*, not manager commands. A card already in a coder column is
  filtered client-side; the server must not assume that filter ran.

### 2. ~~Same treatment for `triggerBatchAction` (multi-card drop)~~

> **Superseded:** The multi-select drop posts `triggerBatchAction` with the same `CODED_AUTO` target and is refused by the same gate — confirmed live: `{"success":false,"error":"CLI triggers are disabled"}`.
> **Reason:** Verified against the current code: `triggerBatchAction` has NO explicit case in the standalone `handlePtyVerb` switch (`bootstrap.ts:2076`). It falls through to the `default:` case at `:2006` → `kanbanProvider.handleServiceVerb('triggerBatchAction', …)` → `KanbanProvider.ts:10995`, whose `CODED_AUTO` branch at `:11007` delegates to `_advanceCards` BEFORE the gate at `:11018`. Git history (`git log -S "case 'triggerBatchAction'" -- src/standalone/bootstrap.ts`) confirms `triggerBatchAction` was never present in `handlePtyVerb`. The live "confirmation" was a misattribution — a multi-card `CODED_AUTO` drop already moves the cards and skips dispatch when triggers are off. Applying the `triggerAction` fix here would risk breaking a working path.
> **Replaced with:** No change to `triggerBatchAction`. It already routes correctly. The implementer should verify this with a live two-card `CODED_AUTO` drop (triggers off) and confirm the cards persist — but no code change is expected.

### 3. Correct or delete the false drop-site comment (`src/webview/kanban.html`, above `:11001`)

- **Logic:** It asserts host behaviour that is only true of one host. Either state the invariant the
  fix establishes (both hosts move, both gate the dispatch) or remove the claim. The comment at `:11001-11002` currently reads: `// _advanceCards handles the CLI-triggers gate internally (moves always, dispatches only when enabled).` After the fix this is true for `triggerAction` in both hosts AND for `triggerBatchAction` (which was already true); state it as a confirmed invariant or delete it.

### 4. A backward drag must not be a dispatch

- **Logic:** The `CODED_AUTO` branch runs before direction is known, so `CODE REVIEWED → CODED` is sent
  as `triggerAction`. **Confirmed: the server-side advance path already classifies direction and does not dispatch on a backward move.** `_advanceCards` (`KanbanProvider.ts:9410`) classifies via `_isColumnBefore(targetCol, card?.column)` — `CODE REVIEWED` (index 8) → `CODER CODED` (index 6) yields `backward`. The dispatch filter at `:9430-9433` keeps only `forwardSids` (`!_isColumnBefore(...)`), so backward cards are moved but never dispatched. No additional client-side classification or source-column threading is required, PROVIDED Proposed Change 1 delegates `CODED_AUTO` to `_advanceCards` (the hand-written arm itself has no direction classification).
- **Edge cases:** A backward move out of `CODE REVIEWED` must not re-fire a coder prompt or re-stamp
  `dispatched_at`. `_advanceCards` does not stamp dispatch info for non-dispatched (backward) cards — the stamping lives in the dispatch command path (`switchboard.triggerAgentFromKanban` → `handlePtyVerb` → `updateDispatchInfoByPlanFile`), which is only reached for forward cards.

### 5. A test that fails on this exact drag

- **Logic:** With `cliTriggersEnabled: false`, `triggerAction` at `CODED_AUTO`
  **moves** the card and does **not** dispatch, in *both* hosts. The existing suites pass today with
  the card refused, because nothing asserts the move half.
- **Rationale:** Verb-reachability gates go green here — the verb is reachable, answers, and returns a
  plausible `{success:false}` error. Only an assertion on the persisted column catches it.
- **Scope note:** `triggerBatchAction` already passes this scenario (it routes through the provider); a test asserting the multi-card `CODED_AUTO` move is a regression guard, not a bug-repro. No existing test file covers the standalone `handlePtyVerb('triggerAction')` arm or `_advanceCards` with `CODED_AUTO` + `cliTriggersEnabled: false` — both are uncovered today.

## Verification Plan

### Automated Tests
- `cliTriggersEnabled: false` + `triggerAction` at `CODED_AUTO` → column changes, no dispatch. Standalone host (the broken one).
- `cliTriggersEnabled: true` + `triggerAction` at `CODED_AUTO` → column changes **and** dispatches. Both hosts.
- `bypassTriggerGate: true` dispatches regardless of the setting.
- Backward `CODE REVIEWED → CODED_AUTO` moves without dispatching.
- `triggerBatchAction` + `CODED_AUTO` + `cliTriggersEnabled: false` → column changes, no dispatch (regression guard; already passes).
- A composition-root diff test asserting the two `triggerAction` implementations agree on gate
  placement for `CODED_AUTO`.

### Goal Invariants
- A single-card drag onto the collapsed coder bucket persists in the standalone host, with CLI triggers on or off (`kanban_column` in the DB equals a real coder column after the drop, not `'CODED_AUTO'`).
- The CLI-triggers setting gates dispatch only — never a column move (`_advanceCards` is reached for `CODED_AUTO` before the gate in both hosts).
- The two hosts answer `triggerAction` identically for the same `CODED_AUTO` payload (both delegate to `_advanceCards`; the persisted column is a real coder column, not the synthetic `CODED_AUTO` string).
- Negative: the synthetic string `'CODED_AUTO'` never appears as a `kanban_column` value in the DB after any drag.

### Manual
- Collapse coders, CLI triggers off, drag a `CREATED` card onto Coded → it stays there after a refresh.
- Drag a `CODE REVIEWED` card back into Coded → it stays, and no coder prompt fires.
- Repeat both in the extension host and confirm no behaviour changed there.
- Drag TWO cards onto Coded (triggers off) → both persist (regression check for the `triggerBatchAction` path).

---

## Completion Summary

Implemented Proposed Changes 1, 3, and 5 (2 superseded, 4 needs no code change). In `src/standalone/bootstrap.ts` the hand-written `triggerAction` arm now branches on `targetColumn === 'CODED_AUTO'` BEFORE the CLI-triggers gate and delegates to `kanbanProvider.handleServiceVerb('triggerAction', …)`, mirroring `KanbanProvider.ts:10727`; the provider's arm complexity-routes to a real coder column via `_advanceCards` and gates only the dispatch, so a one-card drag onto the collapsed coder bucket now persists with triggers off instead of refusing and bouncing back. Re-entrancy is safe because the dispatch re-entry path carries no `targetColumn`. The stale drop-site comment in `src/webview/kanban.html` was rewritten as a confirmed both-hosts invariant. Added a regression suite in `src/services/__tests__/KanbanProvider.test.ts` pinning the move-vs-dispatch invariant for `_advanceCards` CODED_AUTO (triggers off → move only; triggers on → move + dispatch; bypass → dispatch; backward CODE REVIEWED → move only). Compilation and automated tests were skipped per explicit instruction.
