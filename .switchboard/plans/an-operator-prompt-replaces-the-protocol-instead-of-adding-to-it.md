# An Operator's Team Prompt Replaces the Protocol Instead of Adding to It

## Goal

An operator can add text to what a team's seats are told. An operator can never remove,
replace, or stale the orders that make a team function. System orders are composed from
code at delivery, never persisted, and always present; `terminals.standingOrders` holds
only what a human authored.

### Problem analysis

**Measured on this host, 2026-09-13, against the live board DB.** Six rows at
`terminals.standingOrders`, every one carrying an `instruction` body and a `definitionId`:

| id | scope | teamId | names `api-server-port.txt` |
| :--- | :--- | :--- | :--- |
| `66935310…` | `team` | `team_Coding` | yes |
| `4126e05a…` | `team-head` | `team_Coding` | yes |
| `4476af31…` | `team` | `team_Feature_20Implementation` | yes |
| `context-aware-completion:…` | `team-head` | `team_Coding` | yes |
| `context-aware-completion:…` | `team` | `team_lead_1` | no |
| `composed-head:team_lead_1` | `team-head` | `team_lead_1` | yes |

Two of the three teams no longer exist. The live team, `team_Coding`, has **no
`context-aware-completion` member row at all** — the completion protocol shipped by
*Context-Aware Completion Reporting for Teams* was never installed on it. Five of six rows
instruct an agent to reach the API "against the port in `.switchboard/api-server-port.txt`",
a bare relative path with no scheme and no host, which `team-state-endpoint-access-contract`
forbids reaching an agent at all.

**Why the live team has no protocol.** `teamWiring.ts:1837`:

```ts
const teamOrder = teamPromptInstruction
    ? makeStandingOrder(headName, '', teamPromptInstruction, 'team', groupId)
    : makeFragmentStandingOrder(headName, '', teamFragments, 'team', groupId);
```

and identically for the head at `:1864`. A team definition carrying a `prompt` gets the
operator's body **instead of** `team.member.completion`, `team.member.work`,
`team.external-member.callback`, `team.git-safety` and `seat.subagent-policy`. Not
appended — replaced. Filling in the prompt box in the team gallery silently uninstalls the
protocol for that team, and nothing reports it.

The same substitution happens again at render. `standingOrders.ts:530`:

```ts
export function resolveStandingOrderInstruction(o, ctx) {
    if (typeof o.instruction === 'string') { return o.instruction; }
    if (!Array.isArray(o.fragments) || o.fragments.length === 0) { return ''; }
    return composeStandingOrderFragments(o.fragments, ctx).text;
}
```

A body short-circuits the fragments. So even a row carrying both would deliver only the body.

**The evidence the loss was noticed and worked around.** `66935310`'s body contains the
git-safety rule as prose — a hand-pasted copy of `GIT_SAFETY_DIRECTIVE`. Someone hit the
missing protocol and patched it by retyping it into the definition. That copy is now
frozen text on disk that no code change can reach.

**Why frozen text cannot be repaired in place.** The library (`standing-orders-library-definitions-and-sync.md`)
made the definition the top of the chain:

```
code constant ──once, at creation──▶ definition ──re-synced every read──▶ assignment ──▶ agent
              ▲ never repeated
```

`reSyncAssignmentsToDefinitions` (`teamWiring.ts:2444`) keeps assignments equal to their
definition on every read. Nothing syncs a definition from the source constant, so a
definition minted on 2026-08-28 outranks `src/` forever. The plan chose the denormalized
copy over a join at delivery for one stated reason: *"Old builds that don't know about
`definitionId` see the `instruction` copy and work as before."* That is backward
compatibility for a feature that has never shipped to a user.

**The apparatus built to compensate.** `migrateCodingTeamOrders` (`teamWiring.ts:2068`),
`PRE_REWRITE_CALLBACK_INSTRUCTION` (`:114`), `OLD_HEADPROMPT_V2_FRAGMENT` (`:611`),
`CONTEXT_AWARE_COMPLETION_ORDER_VERSION` (`:393`), `describeStandingOrderMigrations`
(`:2287`), `reconcileSystemFragmentRows` (`:471`), and the hand-maintained client mirror
`migrateCodingTeamOrdersClient` (`terminals.js:11720`). None of it solves a user problem.
All of it keeps a cache coherent with a function that was always cheaper to call.

`migrateSystemOrdersToFragments` (`:2203`) would convert these rows to fragments and end
the problem. It has **zero call sites**, and `teamWiring.ts:460` records why:

> *"It rewrites ANY team-scoped row to the canonical member list and strips `instruction`,
> which would destroy an operator-authored team prompt (`teamPromptInstruction` from a team
> definition is stored exactly that way)."*

System-authored text and operator-authored text are the same field on the same row, so the
one transform that would fix this cannot be run.

**Nothing prunes.** There is no `releaseTeam`/`stopTeam`/`disbandTeam` in `src/`. The only
removal path for any order is `removeReviewerCallbackOrder`, one narrow pair row.
`agentGroupInstantiation.ts:130` says it plainly: *"nothing ever pruned orders."*

### Root cause

Derived state was persisted. A team's system orders are a pure function of code plus the
team's shape — recomputable at delivery, worth nothing in storage. Storing them created a
cache that can disagree with its source, and every layer above exists to close that gap.
Storing them in the same field as operator text then made the gap unclosable, because
nothing can rewrite one without risking the other. And giving the operator's text the same
slot made it a replacement rather than an addition, so the protocol became optional.

### Non-goals

- **Another recogniser, stamp, or migration.** Teams have never shipped to a user. The
  persisted rows are dropped, not converted. Adding a seventh way to recognise stale text
  is the failure this plan ends.
- **Removing the library.** Definitions remain the shared store for authored text, which is
  what they are good at. Only system orders leave the store.
- **Changing any fragment's wording.** `standingOrderFragments.ts` bodies are out of scope;
  this plan changes how they reach a seat, not what they say.
- **A UI for the change.** No banner, no notice, no migration report.

## Metadata

- **Complexity:** 7
- **Tags:** teams, standing-orders, both-hosts, refactor

## User Review Required

None.

## Proposed Changes

### 1. System orders compose at delivery and are never persisted

`selectOrders` (`standingOrders.ts:446`) gains the system orders itself: for any seat whose
`standing.inTeam` resolves, emit a synthetic order built from the canonical member list
(`team.member.completion`, `team.member.work`, `team.external-member.callback`,
`team.git-safety`, `seat.subagent-policy`), or the head list for `standing.isHead`. Built
per delivery from `STANDING_ORDER_FRAGMENT_IDS` and the live composition context, with no
row on disk and no `teamId` lookup — a team has its protocol because it is a team, not
because a row was once written for its head's name.

A code edit to a fragment is then live on the next prompt for every team, including teams
started months ago.

### 2. A body adds to the fragments; it never replaces them

Delete the short-circuit at `standingOrders.ts:530`. `resolveStandingOrderInstruction`
composes fragments when present and appends `instruction` after them. A row carrying only a
body renders only that body — which is correct, because after change 1 the system half no
longer lives on rows at all.

### 3. `wireSpawnedTeam` writes only what the operator authored

Delete both ternaries (`teamWiring.ts:1837`, `:1864`). When a team definition carries a
`prompt` or `headPrompt`, persist it as an ordinary authored row. When it does not, persist
nothing. The `teamExists` / head-exists checks on `(scope, teamId)` go with them: no system
row occupies a slot, so "this head name was wired before" stops deciding what a team is
told. `reconcileSystemFragmentRows` is deleted — there are no system fragment rows left to
reconcile.

### 4. Delete the staleness apparatus

Remove `migrateCodingTeamOrders`, `PRE_REWRITE_CALLBACK_INSTRUCTION`,
`OLD_HEADPROMPT_V2_FRAGMENT`, `CONTEXT_AWARE_COMPLETION_ORDER_VERSION` and the `version`
field, `describeStandingOrderMigrations`, `migrateSystemOrdersToFragments`, and the client
mirror `migrateCodingTeamOrdersClient` (`terminals.js:11720`) with its
`PRE_REWRITE_CALLBACK_INSTRUCTION` / `NEW_CODING_HEAD_PROMPT_CLIENT` constants. Drop the
contract-test pins that assert those constants exist in exactly N files. `AGENT_GROUP_CALLBACK_INSTRUCTION`
and `EXTERNAL_HEAD_CALLBACK_INSTRUCTION` survive only if a live caller remains after change
3; otherwise they go too.

`loadEffectiveStandingOrders` keeps `migrateTeamPairOrders` (pair rows are operator-visible
Link-up state) and `reSyncAssignmentsToDefinitions` (authored text still tracks its
definition).

### 5. Drop the persisted system rows

One-time delete of the six rows measured above, and of the `standingOrderDefinitions`
entries they reference that were system-authored. Teams have never shipped, so this is a
clean break with no migration and no archival. Operator-authored definitions in the library
are untouched.

### 6. A team's seats cannot be left without the protocol

The operator-facing team editor keeps its prompt box. Its text is additive by construction
after changes 1–3, so there is no suppression path to guard and no setting to add. Assert
it instead: a contract test starts a team whose definition carries a `prompt` and checks
every required fragment is still in the delivered block.

## Verification Plan

### Automated Tests

1. **New** `src/test/standing-orders-additive-contract.test.js`, wired as
   `test:contract:standing-orders-additive` **and invoked from
   `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not a gate.
   Asserts: a team started with a definition `prompt` delivers every required member
   fragment **and** the operator text; the operator text appears after the fragments; no
   `scope: 'team'` or `'team-head'` row is persisted for a team with no authored prompt.
2. A fragment-body edit in `standingOrderFragments.ts` changes the block delivered to a
   team whose rows were written before the edit — the regression that motivates change 1.
   Fixture: a persisted authored row plus a pre-existing `teamId`, asserting the composed
   output tracks the constant.
3. Assert the persisted store contains **no** system-authored rows after a team start: the
   only rows with `scope` `team`/`team-head` carry an `instruction` and no `fragments`.
4. Regression: `test:contract:standing-orders-definitions`,
   `test:contract:team-wiring-roster-seats`, `test:contract:team-state-endpoint-access`,
   `test:contract:team-scoped-routing`, `test:contract:coding-head-prompt`,
   `test:contract:terminal-groups-headrole`.
5. Extend `team-state-endpoint-access-contract.test.js` to assert against the **persisted
   store**, not only the constants. Its current grep gate passed at HEAD while five of six
   live rows named `api-server-port.txt`.

### Both composition roots

`teamWiring.ts` and `standingOrders.ts` are shared services, so changes 1–5 reach both
roots through the service. The audit is the wiring, not the verbs: confirm
`src/standalone/bootstrap.ts` and `src/extension.ts` each still resolve the same
composition context into `selectOrders` (`pacing`, `orchestratorPresent`, `attended`,
`externalHead`, `subagentPolicy`, `hasRegisteredRounds`) — a root that drops one of these
silently composes a different block, and a `Promise<void>` seam makes "never wired" and
"working" the same value. The client mirror in `src/webview/terminals.js` is deleted by
change 4; verify no remaining webview path renders an order body of its own.

### Goal Invariants

- Filling in a team definition's prompt box **adds** to what seats are told. There is no
  input to that box that removes a required fragment.
- Editing a fragment body in `src/` changes what an already-started team is told, on the
  next prompt, with no migration and no restart.
- No standing-order row on disk carries system-authored text. Every persisted row is
  something a human wrote.
- A team that no longer exists leaves nothing behind that can reach a live agent.
- `grep -rn "api-server-port.txt" src/` matches only comments, and the persisted store
  matches nothing.
