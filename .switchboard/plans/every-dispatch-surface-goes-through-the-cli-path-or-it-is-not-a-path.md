# Every Dispatch Surface Goes Through the CLI Path, or It Is Not a Path

## Goal

One dispatch path: `POST /kanban/dispatch`, the endpoint the CLI already uses.
The board, the command view and drag-and-drop all call it. The parallel
column-resolvers and the parallel column-writers are deleted, not guarded.

A rule added to dispatch — "a feature never enters a seat column", "this team
declines automated work" — then lands once and is true everywhere. Today it lands
in one of three implementations and is silently absent from the other two.

## Problem analysis

**Three implementations decide which column a complexity routes to.**

| where | input | notes |
| :--- | :--- | :--- |
| `KanbanProvider._resolveComplexityRoutedRole` | a **sessionId** | private; reads the DB record, falls back to the run sheet, then the plan file |
| `KanbanProvider.resolveAutoDispatchColumn` | a complexity **string** | written for the HTTP endpoint, which had no sessionId to hand |
| `kanban.html` (~:6630) | `routingMapConfig` inlined in the webview | its own comment: *"Inlined from the deleted `resolveCodedAutoTarget`"* |

The second exists because the first is private and keyed on something the API does
not have. Rather than change the first, a second was written beside it. The third
exists because the webview wanted an optimistic move and inlined a copy of the rule
rather than asking the host.

**At least three writers put the column on the row**, each with its own
`if (isFeature) cascade…` branch: `moveCardToColumnWithReason` (sessionId-keyed),
its plan-file-keyed twin, and a `TaskViewerProvider` cascade fallback.

**This is not theoretical — it cost a full evening on 2026-09-19.** A feature kept
reaching a coder seat. Four separate fixes were written, each correct, each in a
path the operator's dispatch never took:

- a guard in `_resolveComplexityRoutedRole` — only runs for a `CODED_AUTO` target,
  which is the **board Advance** path, not the command view's;
- a guard in `resolveAutoDispatchColumn` — correct, and never reached (below);
- a guard at `moveCardToColumnWithReason` — verified working against the live board
  via `POST /kanban/move`, which proved the **wrong path** worked;
- guards at the two other cascade writers.

**The actual defect was a dropped parameter in the composition root.**
`bootstrap.ts:5145`:

```ts
resolveAutoDispatchColumn: async (_wsRoot: string, complexity: string | null) => {
    return kanbanProvider.resolveAutoDispatchColumn(_wsRoot, complexity);
}
```

`LocalApiServer` passes `isFeature` as a third argument. This lambda takes two and
drops it. The resolver was fixed, the caller was fixed, and the wrapper between them
silently discarded the flag — the exact composition-root trap CLAUDE.md names, where
"never wired" and "working" are the same value.

**`/kanban/dispatch` is already the good path.** It resolves the plan by **planId
first, then plan-file path** — no sessionId lookup — then resolves the target column,
moves the card, dispatches and acks, per card. The command view already loops it one
plan at a time and reports "dispatched 3/5; 2 refused" instead of one hollow success.

## Metadata

**Complexity:** 6
**Tags:** dispatch, routing, architecture, standalone, clean-break
**Scope:** `LocalApiServer`, `KanbanProvider`, `TaskViewerProvider`, `kanban.html`,
`bootstrap.ts`. **Standalone only.** The VS Code extension is being reduced to a
sidebar that launches the standalone host, so nothing here is wired into
`extension.ts` and no extension path is preserved.

## Constraints

**No sessionId.** It was deprecated months ago and must not be carried forward.
Every new or moved signature keys on `planId`. The codebase is already part-way:
`cascadeFeatureByPlanId` is plan_id-keyed precisely because "the session_id-keyed
cascade silently no-ops for file-based plans", and `performKanbanDispatch` resolves
by planId. `performKanbanDispatch` still derives `const sessionId = record.sessionId
|| record.planId` for the downstream verb — that carry goes with this work.

**No extension host.** Out of scope, deliberately, and the plan does not name it as
a verification target.

## Proposed changes

### 1. One resolver, taking the plan RECORD

Replace all three with a single function that takes the record — not a sessionId,
not a bare complexity string. A record carries `planId`, `complexity` **and**
`isFeature`, so the feature rule is expressible at all, which the complexity-string
signature made impossible.

Returns `{ targetColumn, source }` — `'feature'`, `'routing-map'`, `'band-default'`,
`'degraded'` — so "why this column?" is answerable after the fact.

### 2. Every surface calls `POST /kanban/dispatch`

- **Command view** — already does. Unchanged.
- **Board Advance** (`moveAll` / `moveSelected`) — stops calling `_advanceCards`
  with `CODED_AUTO` and loops the endpoint per planId, as the command view does.
- **Drag-and-drop** — posts an explicit target column, which stays legitimate: a
  drag is the operator naming the column. It goes through the same endpoint with
  `targetColumn` set, so the feature rule and the team rules still apply to it.

`_advanceCards`' `CODED_AUTO` branch, `_partitionByComplexityRoute` and
`_resolveComplexityRoutedRole` are then dead and are deleted.

### 3. The webview stops predicting the column

The inlined `roleMap` block goes. If an optimistic move is still wanted, the host
returns the resolved column in the dispatch ack and the webview animates to it —
predicting a rule it does not own is how the client and host came to disagree.

### 4. One writer

The three cascade sites collapse into one plan-id-keyed write that every path uses.
The feature rule lives there, once, as a property of writing a column rather than a
thing each caller remembers.

### 5. A gate on seam forwarding

The bug was a wrapper that dropped an argument. A contract test asserts that every
`LocalApiServer` option lambda wired in `bootstrap.ts` forwards **all** parameters of
the interface it implements — arity and order. Cheap, static, and it would have
caught this in one run.

## Verification plan

### Automated

- **One resolver:** `_resolveComplexityRoutedRole`, `_partitionByComplexityRoute` and
  the webview's inlined `roleMap` appear nowhere in `src/`.
- **One writer:** exactly one function cascades a feature; the other two are gone.
- **Every surface hits the endpoint:** the board's Advance posts `/kanban/dispatch`
  per planId and no longer calls `_advanceCards` with `CODED_AUTO`.
- **The feature rule holds on EVERY surface** — asserted per surface, not once:
  command view, board Advance, and a drag that explicitly names `CODER CODED`. All
  three land the feature in `LEAD CODED`. This is the assertion that would have
  failed on 2026-09-19 while three separate guards passed.
- **No sessionId** in any signature this plan touches; `performKanbanDispatch`'s
  `record.sessionId || record.planId` carry is gone.
- **Seam forwarding:** every `bootstrap.ts` lambda implementing a `LocalApiServer`
  option accepts and forwards the full parameter list. Proven by adding a parameter
  to one option and watching the gate go red.
- The resolver's `source` is present on every dispatch result.

### Goal invariants

- There is one path. A dispatch rule added once is true on every surface.
- A dispatch can answer "which column, and which rule chose it?"
- No surface re-implements a routing rule the host owns.
- No signature introduced here takes a sessionId.

### Manual

From each of the three surfaces in turn, dispatch the same feature and confirm it
lands on the lead. Then switch a team off and repeat: all three refuse identically.

## Outstanding questions

- **Does the board Advance stay a batch gesture?** `/kanban/dispatch` is single-card
  by contract and the command view loops it. Looping N cards is more round trips but
  gives per-card acks. Confirm that is wanted before changing the board's UX, since
  a partial batch result is a visible behaviour change.
