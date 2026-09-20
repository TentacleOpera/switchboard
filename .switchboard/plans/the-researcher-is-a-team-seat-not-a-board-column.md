# The Researcher Is a Team Seat, Not a Board Column

## Goal

Remove `RESEARCHER` from the board's column catalogue. The researcher **role**
stays exactly as it is — it is a team seat. What goes is the claim that research
is a delivery stage a card passes through.

## Problem analysis

### A column asserts a delivery stage, and research is not one

`src/services/agentConfig.ts:216`:

```ts
{ id: 'RESEARCHER', label: 'Researcher', role: 'researcher', order: 110,
  kind: 'review', source: 'built-in', dragDropMode: 'prompt' },
```

`kind: 'review'` and `dragDropMode: 'prompt'` declare a place a card **lands**:
you drag a card in, an agent takes delivery of it, the card waits there. Every
other role column means exactly that — `LEAD CODED`, `CODER CODED`,
`CODE REVIEWED` are custody handoffs.

Research is not custody. A research need is a **question raised about a card
that somebody else is still holding**, and the card does not move while the
question is answered — the planner keeps planning. Modelling it as a column
forces a card to leave the planner's hands to get an answer, which is backwards.

The companion feature `cf5537c5` (*A Research Request Is Queued Inside the Team,
and Answered Back to the Planner That Asked*) puts the research request against
the plan and returns the answer to the seat that asked, with the card never
moving. This plan removes the surface that contradicts it.

### The live host published it as enabled — corrected account

Asked directly (`GET /kanban/columns`, 2026-09-20):

```json
{"id":"RESEARCHER", ..., "enabled":true, "enabledSource":"config"}
```

while the board DB's `agents.visibleAgents` said `"researcher": false`.

**An earlier draft of this plan called that a lie. It was not, and the real
cause is worse.** `enabledSource: "config"` was truthful — it named the
machine-global file `~/.switchboard/integration-config.json`, which says
`researcher: true` and is the *correct, documented* home for this key
(`AGENT_GLOBAL_FILE_KEYS` in `stateConfigBridge.ts`). The DB row is a leftover:
`STATE_KEY_TO_CONFIG` maps `visibleAgents → agents.visibleAgents`, so the
state.json migration wrote the key to the DB while the integration-config
migration wrote it to the file. Two migrations, one key, two homes.

The tag's genuine weakness is narrower than "it lies": two different stores can
both truthfully answer `'config'`, so it cannot identify which one won.

**What actually stalled the board** is the simplest available explanation, and
it is the one the operator gave before any of this was investigated: *a
researcher is a team seat, not a delivery stage.*

The machine-global file — the authoritative store — said `researcher: true`, so
the role was genuinely in play. `RESEARCHER` therefore sat in the pipeline at
order 110, between `PLAN REVIEWED` (100) and the coded lane, and advancing a card
out of a 359-card `PLAN REVIEWED` routed it there. Nothing takes delivery in a
researcher column, so the cards stopped.

Both the host and the browser agreed on that route: `_getVisibleAgents`
delegates to `TaskViewerProvider.getVisibleAgents` (standalone sets the provider
at `bootstrap.ts:1825`), which reads the same file. **No resolver divergence was
involved** — two earlier drafts of this section claimed one, and both were wrong.
Removing the column (commit `5f519e9c`) was the entire fix.

### That endpoint does not filter at all

The payload carries `builtIn` (11 entries — every member of
`DEFAULT_KANBAN_COLUMNS`), `custom` and `displayOnly`, and **no** `visibleAgents`
anywhere. `KanbanProvider._filterDynamicColumns` is applied on the provider's own
refresh paths (`KanbanProvider.ts:1739, 2769, 4613, 4859`) and not on this one.

`bootstrap.ts` already predicts this in its own words, as the reason
`boardStructure` is declared false:

> pushFullState publishes `updateColumns` from the CONSTANT
> DEFAULT_KANBAN_COLUMNS … so a saved custom column is written to the DB and
> never rendered.

Same divergence, opposite direction: the constant also publishes columns the
config had switched off.

### Hiding it by flag cannot work anyway

```ts
if (visibleAgents[col.role] !== false) return true;
return occupiedColumns.has(col.id);
```

A role-hidden column **reappears the moment one card sits in it**. That is
correct behaviour for a column that still exists — stranding cards in an
invisible column would be worse — but it means `researcher: false` is not a way
to remove the column. Only removing it is.

### It exists in more than one catalogue

- `src/webview/terminals.js:10913` — `KANBAN_ROLE_ORDER_FALLBACK` carries
  `researcher: 110`, a static mirror used for the sidebar's **first paint**, with
  a contract test enforcing lockstep against `agentConfig.ts`.
- `src/webview/project.js:2461` — `if (plan.column === 'RESEARCHER') return 'Copy Researcher Prompt';`

A second hard-coded catalogue that paints before the host answers is the same
shape as the TEAMS gallery regression: whatever it contains is what the user sees
when the live structure is missed.

## Metadata

**Complexity:** 3
**Tags:** kanban, columns, roles, teams, standalone, cleanup
**Scope:** `src/services/agentConfig.ts`, `src/services/KanbanProvider.ts`,
`src/services/LocalApiServer.ts` (the `/kanban/columns` arm),
`src/webview/terminals.js`, `src/webview/project.js`, and the column-lockstep
contract test. **Standalone only.**

## Constraints

**The ROLE stays.** `researcher` remains in `BuiltInAgentRole`, in `VALID_ROLES`,
in the Planning team's seat list, and in `agentPromptBuilder`'s researcher branch.
Nothing about spawning, prompting or pairing a researcher seat changes. This plan
removes a **stage**, not a seat — and a diff that touches the role is out of scope.

**`RESEARCHER` shipped, so migrate.** Cards may be sitting in it on installs that
are not this one (this board has zero). Import before deleting: move them,
stamped with a reason naming the retired column, and surface the count. Never
unlink a card from a column that is disappearing.

**A reported source must be the thing that decided.** Whatever replaces
`enabledSource: 'config'` has to name what actually answered. Fixing the column
list while leaving the source string guessing reproduces the defect one field over.

**No confirmation dialogs.**

## Proposed changes

### 1. Delete the column definition

Remove the `RESEARCHER` entry from `DEFAULT_KANBAN_COLUMNS`. With no definition,
no path can publish it — provider refresh, HTTP catalogue or webview mirror —
which is why this is a deletion rather than a default flipped to `false`.

### 2. Migrate any card out of it

A one-time, guarded, idempotent pass (the `_backfillComplexityColumn` shape):
any plan whose `kanban_column` is `RESEARCHER` moves to **`PLAN REVIEWED`**, with
the move reason recording that it came from the retired column. The count is
logged once at startup. A board with none does nothing and says nothing.

**Why `PLAN REVIEWED` and not `CREATED`** (operator decision, 2026-09-20): a card
parked in `RESEARCHER` had already been planned — `RESEARCHER` is a `review`-kind
column at order 110, sitting immediately after `PLAN REVIEWED` at order 100.
Dropping it to `CREATED` would re-enter it as an unplanned card and discard the
planning work that got it there, which is a silent loss of exactly the kind this
migration exists to prevent. `PLAN REVIEWED` returns it to the state it was in
before someone parked it.

### 3. Drop the webview mirrors

Remove `researcher: 110` from `KANBAN_ROLE_ORDER_FALLBACK` and the
`'Copy Researcher Prompt'` branch in `project.js`. **Update the lockstep contract
test to match the new catalogue — do not weaken it**; the test is what keeps the
mirror honest and it is the right gate, it simply has one entry too many.

### 4. Make `/kanban/columns` agree with the board

The HTTP catalogue applies the same `_filterDynamicColumns` the provider's
refresh paths apply, so one rule decides what a column list contains regardless
of which host or transport asked. `enabled`/`enabledSource` then report what
genuinely decided — the filter, the config row, or the built-in definition — by
name.

### 5. Settle what `visibleAgents.researcher` means afterwards

With no researcher column, the flag no longer gates one. It may still gate the
terminals grid or the agent picker. Either keep it with its remaining meaning
stated at the definition, or retire it with the same migration discipline as the
column. **Do not leave it in place meaning nothing** — a flag that gates nothing
is the next person's false lead.

## Verification plan

### Automated

- `RESEARCHER` appears in no column catalogue in `src/` — not `agentConfig.ts`,
  not the `terminals.js` mirror, not `project.js`.
- **Asked of a running host**, `GET /kanban/columns` returns 10 built-ins and no
  `RESEARCHER`. This is the assertion that would have failed today while every
  source-level check passed.
- Every column the endpoint reports as `enabled` names a source that, when read,
  agrees. A column reported `enabled: true` with `enabledSource: 'config'` while
  the config says `false` fails the gate — the exact live state on 2026-09-20.
- A card seeded in `RESEARCHER` lands in **`PLAN REVIEWED`** after migration, with
  a reason naming the retired column; running the migration twice changes nothing.
- No migrated card lands in `CREATED` — asserted directly, because that is the
  outcome that would silently discard its planning.
- **The role survives:** a Planning team spawns its researcher seat, the seat
  receives the researcher prompt, and `researcher` is still a valid role. Asserted
  explicitly, because "removed the column" and "removed the researcher" are one
  careless grep apart.
- The column-lockstep contract test still runs and now matches the reduced set.

### Goal invariants

- The board has no column for a role that never takes custody of a card.
- One rule decides the column list, whichever host or transport asks.
- A researcher is spawned, prompted and paired exactly as before.
- No card is stranded in a column that no longer exists.

### Manual

Open the board and confirm the Researcher column is gone from the kanban, the
column picker and the sidebar's first paint — including on a hard reload, which
is when the static mirror is what renders.

## Outstanding questions

- **Does `visibleAgents.researcher` retire or stay?** Change 5 depends on whether
  anything else reads it. Answer it by grep before implementing, not after.
