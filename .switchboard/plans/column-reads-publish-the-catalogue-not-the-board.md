# GET /kanban/columns publishes the built-in catalogue instead of this board's columns, so clients offer Researcher and Ticket Updater to a board that has neither

## Goal

Make `GET /kanban/columns` report which columns **this board actually has**, tagged with where
that answer came from, and make the command console offer only those. A column whose agent is
switched off must never appear as a destination.

### Problem analysis

This board has Researcher, Ticket Updater and Completion Tested **switched off** — the DB says
so plainly (`config` key `agents.visibleAgents`):

```json
{"planner":true,"lead":true,"coder":true,"intern":true,"reviewer":true,
 "tester":false,"analyst":true,"jules":false,"gatherer":false,
 "team-lead":false,"ticket_updater":false,"researcher":false, …}
```

`GET /kanban/columns` returns all of them anyway:

```
builtIn  RESEARCHER         label=Researcher        role=researcher      drop=prompt
builtIn  TICKET UPDATER     label=Ticket Updater    role=ticket_updater  drop=prompt
builtIn  ACCEPTANCE TESTED  label=Completion Tested role=tester          drop=cli
```

The command console builds **all three** of its column dropdowns from that response
(`src/webview/command.js:399-422` → `:424-476`): the dispatch source filter, the Move source,
and the **Move target**. So the surface currently offers, as a move destination, three columns
that are not on the board and have no agent behind them. Moving a card to Ticket Updater
parks it in a column the operator cannot see and nothing will ever pick up.

Every agent-facing skill is also pointed at this endpoint as the authority —
`.agents/skills/query-kanban/SKILL.md:100` ("The authoritative live mapping is
`GET /kanban/columns`"), plus `switchboard-orchestration` and `kanban_operations` — so agents
are told the live column set includes stages this workspace does not run.

### Root cause

`_handleGetColumns` (`src/services/LocalApiServer.ts`) serves the **compile-time constant**:

```ts
const builtIn = DEFAULT_KANBAN_COLUMNS;
…
return { builtIn, custom, displayOnly };
```

It opens the DB only to derive *custom* columns from distinct `kanbanColumn` values on board
rows. It never reads `agents.visibleAgents`, so nothing in the response distinguishes a column
this board runs from one that merely exists in the product.

The join is trivial and already fully available:

- every built-in column carries its `role` (`src/services/agentConfig.ts:183-191`),
- `agents.visibleAgents` maps role → bool in the DB `config` table,
- and `getVisibleAgents(workspaceRoot)` is reachable on **both** hosts —
  `setTaskViewerProvider` is wired at `src/extension.ts:1191` and
  `src/standalone/bootstrap.ts:1242`, so the `state.json` fallback in
  `KanbanProvider._getVisibleAgents` is not reached on either. There is no host divergence
  here; the endpoint simply never asks.

This is the `CLAUDE.md` fallback rule on a **configuration/membership** read: a static default
served in place of configured state, behaving exactly like a real answer. A client cannot tell
"this board runs 5 stages" from "the product ships 8", because the response carries no marker
either way.

## Metadata

- **Complexity:** 3
- **Tags:** backend, api, ui, bugfix

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** One config read joined onto a constant the handler already returns, one filter in
the console, and a docs correction.

**The one decision that matters: tag, do not drop.** A hidden column can still hold historical
cards, and the skills depend on this endpoint to translate storage ids to board labels — a hard
filter would make those cards unlabelable and break the very lookup the docs point at. So every
column stays in the response and gains an `enabled` flag; the console filters on it. This also
satisfies the "which store answered?" half of the fallback rule.

## Edge-Case & Dependency Audit

- **Cards parked in a disabled column must still read correctly.** `/kanban/board`,
  `/kanban/plan` and label resolution are untouched; a card in `TICKET UPDATER` keeps its label
  and renders on reads. Only *destination* lists filter.
- **Toggling an agent in Setup must take effect without a restart.** The flag is computed per
  request from config, never cached at startup.
- **Role-less structural columns** (`CREATED`, `STAGING`, `COMPLETED`, and the `BACKLOG`
  display mode) have no agent to switch off. They are `enabled: true` with source `structural`
  — never accidentally filtered out by a client checking `enabled`.
- **`enabledSource` must distinguish config from default.** A workspace that has never written
  `agents.visibleAgents` gets the built-in defaults; that answer must be labelled `default`, not
  presented as a choice the user made.
- **Custom columns** keep their current derivation (distinct board values) and gain an explicit
  `enabled: true` rather than being enabled by omission.
- **Display-mode and legacy-alias relationships stay intact** — `displayModeOf` /
  `legacyAliasOf` already exist precisely so a caller does not read `BACKLOG` as a peer column,
  and `enabled` must not override that signal.
- **Both mirrors of every skill move together.** `.claude/skills/` is generated from
  `.agents/`; a doc edit in one and not the other is a silent drift
  (`skill-discovery-host-split-manifest-vs-fs`).
- **Related:** `command-console-dispatch-reads-as-an-advance.md` — that plan's advance path
  derives its destination server-side and so is not affected, but its Move-view dropdowns are
  fed by this endpoint. This plan is what makes those lists correct.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts:7386-7431` — `_handleGetColumns`: join visibility, tag the source

**Prerequisite:** `DEFAULT_VISIBLE_AGENTS` is currently `private static` in
`GlobalIntegrationConfigService.ts:367-381` and NOT exported. Move it to `agentConfig.ts`
(alongside `DEFAULT_KANBAN_COLUMNS`) and export it, so `LocalApiServer.ts` can import it.
The object is:

```ts
export const DEFAULT_VISIBLE_AGENTS: Record<string, boolean> = {
    lead: true, coder: true, intern: true, reviewer: true, tester: false,
    planner: true, analyst: true, jules: false, ticket_updater: false,
    researcher: false, claude_designer: false, phone_a_friend: false,
    project_manager: true
};
```

`GlobalIntegrationConfigService.ts` then imports it from `agentConfig.ts` instead of
declaring it privately. This is a pure relocation — no behavioural change.

```ts
// Which stages does THIS board run? Every built-in column carries its role and
// agents.visibleAgents maps role → bool, so publish the join rather than the
// catalogue. Tagged, not filtered: a disabled column can still hold historical
// cards, and callers use this endpoint to translate storage ids to labels.
const visible = await this._resolveVisibleAgents(db);
const builtIn = DEFAULT_KANBAN_COLUMNS.map(c => {
    if (!c.role) return { ...c, enabled: true, enabledSource: 'structural' as const };
    const configured = Object.prototype.hasOwnProperty.call(visible.agents, c.role);
    if (visible.source === 'unknown') {
        // Neither config nor defaults reachable — treat as enabled (visible-failure
        // choice: an extra column is recoverable; a silently missing stage is not).
        return { ...c, enabled: true, enabledSource: 'unknown' as const };
    }
    return {
        ...c,
        enabled: configured ? visible.agents[c.role] !== false : DEFAULT_VISIBLE_AGENTS[c.role] !== false,
        enabledSource: configured ? visible.source : 'default' as const
    };
});
```

`_resolveVisibleAgents` is a new helper on `LocalApiServer`. It reads
`agents.visibleAgents` directly from the DB config table via
`db.getConfigJsonSync('agents.visibleAgents', undefined)` (the same read path as
`TaskViewerProvider.ts:2909`). It returns:

```ts
{ agents: Record<string, boolean>, source: 'config' | 'default' | 'unknown' }
```

- `source: 'config'` when `agents.visibleAgents` was present in the DB.
- `source: 'default'` when the key was absent (the board has never written agent visibility).
- `source: 'unknown'` when the DB itself is unreachable (the handler already guards `if (db)`
  at L7393; this branch covers the `else` path where `db` is null).

When `source` is `'unknown'`, every role column gets `enabled: true` — the console shows all
stages rather than hiding ones it cannot verify.

### 2. `src/webview/command.js:410-414` — offer only what the board runs

```js
allColumns = raw.filter(c => {
    if (!c || typeof c.id !== 'string' || seen.has(c.id)) return false;
    seen.add(c.id);
    // A column whose agent is switched off is not a destination. `enabled`
    // absent (older host) ⇒ keep it: never hide a stage on a stale field.
    return c.enabled !== false;
});
```

### 3. Skills — document the flag, in both mirrors

- `.agents/skills/switchboard-orchestration/SKILL.md:69` — extend the documented shape with
  `enabled` / `enabledSource`.
- `.agents/skills/query-kanban/SKILL.md:100` and
  `.agents/skills/kanban_operations/SKILL.md:73` — state that the response is the full
  catalogue tagged with `enabled`, that destinations must be filtered to `enabled !== false`,
  and that a disabled column may still hold cards.
- Regenerate `.claude/skills/` so both mirrors match.

## Verification Plan

1. `GET /kanban/columns` on this board: `RESEARCHER`, `TICKET UPDATER` and `ACCEPTANCE TESTED`
   come back with `enabled: false, enabledSource: 'config'`; `PLAN REVIEWED`, `LEAD CODED`,
   `CODER CODED`, `INTERN CODED`, `CODE REVIEWED` with `enabled: true`.
2. `CREATED`, `STAGING`, `COMPLETED` come back `enabled: true, enabledSource: 'structural'`.
3. Console: all three dropdowns list the structural columns plus the five enabled role columns —
   Researcher, Ticket Updater and Completion Tested appear in none of them.
4. Enable Researcher in Setup, reload the console (no restart): `RESEARCHER` flips to
   `enabled: true` and appears. Disable it: it disappears from the lists.
5. A workspace with no `agents.visibleAgents` key reports `enabledSource: 'default'` for every
   role column — the answer is labelled as a default, not as a configured choice.
6. Park a card in `TICKET UPDATER` by direct DB write, then confirm `/kanban/board` still
   returns it and the board renders its label — disabled ≠ invisible on read paths.
7. An older client that ignores `enabled` behaves exactly as today (nothing filters
   server-side).
8. Both hosts: steps 1–4 pass on the standalone host and the installed VSIX.
9. `.agents/skills/**` and `.claude/skills/**` describe the same response shape (diff the
   two mirrors).
10. `DEFAULT_VISIBLE_AGENTS` is exported from `agentConfig.ts` and imported by both
    `LocalApiServer.ts` and `GlobalIntegrationConfigService.ts` — `grep` confirms no private
    static copy remains.

### Goal Invariants

- **Negative:** `GET /kanban/columns` on this board does NOT include `RESEARCHER`,
  `TICKET UPDATER`, or `ACCEPTANCE TESTED` with `enabled: true` — disabled columns are
  tagged `enabled: false`.
- **Positive:** `GET /kanban/columns` response includes `enabled` and `enabledSource` fields
  on every built-in column entry — the join is live.
- **Negative:** The console's three dropdowns (`dispatchSourceColSelect`,
  `moveSourceColSelect`, `moveTargetColSelect`) do NOT contain `RESEARCHER`, `TICKET
  UPDATER`, or `ACCEPTANCE TESTED` as options — `c.enabled !== false` filters them out.
- **Positive:** A card parked in `TICKET UPDATER` (by direct DB write) still appears in
  `GET /kanban/board` with its label — disabled ≠ invisible on read paths.

## User Review Required

None.

## Dependencies

- `command-console-dispatch-reads-as-an-advance.md` (this feature) — that plan's Move-view
  dropdowns are fed by this endpoint. This plan is what makes those lists correct. No hard
  ordering: the advance subtask is immune (it never sends a destination), but the Move view
  is only fully correct once both land.

## Adversarial Synthesis

Key risks: `DEFAULT_VISIBLE_AGENTS` was private and unimportable (fixed — relocated to
`agentConfig.ts` as exported const), `_resolveVisibleAgents` was undefined (fixed — concrete
implementation reading `db.getConfigJsonSync`), `visible.map` naming collided with built-in
(fixed — renamed to `visible.agents`), `'unknown'` branch was promised but missing (fixed —
added with `enabled: true` fallback). Mitigations: export relocation, helper definition,
naming fix, missing branch added.

## Implementation Summary

Exported `DEFAULT_VISIBLE_AGENTS` from `agentConfig.ts` and consumed it across `GlobalIntegrationConfigService.ts` and `LocalApiServer.ts`. Implemented `_resolveVisibleAgents` helper on `LocalApiServer` to query `agents.visibleAgents` directly from the database and determine `enabled` and `enabledSource` (`'config'`, `'default'`, `'structural'`, `'unknown'`) for every column in `GET /kanban/columns`. Updated `src/webview/command.js` to filter column dropdown options with `c.enabled !== false`, preventing disabled columns from appearing as move destinations. Updated all skill documentation in both `.agents/` and `.claude/` mirrors to reflect the new response shape and filtering rules.

